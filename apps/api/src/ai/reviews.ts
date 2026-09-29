import { randomUUID } from 'node:crypto';
import {
  AiFindingSchema,
  AiReviewErrorCodeSchema,
  AiReviewListResponseSchema,
  can,
  groupAiFindings,
  type AiFinding,
  type AiReviewListResponse,
  type AiReviewView,
  type CreateAiReviewRequest,
} from '@devspace/shared';
import { z } from 'zod';
import { env } from '../config/env.ts';
import type { Prisma } from '../generated/prisma/client.ts';
import { runGit, GitError } from '../git/run.ts';
import { HttpError } from '../lib/http-error.ts';
import { prisma } from '../lib/prisma.ts';
import { transaction } from '../lib/transaction.ts';
import { forbidden, type Db, type ProjectAccess } from '../projects/access.ts';
import { invalidateAfterCommit } from '../realtime/emitter.ts';
import { queueAiReviews } from '../jobs/ai-reviews.ts';
import { listModels } from './connection.ts';
import { isFreeModelId } from './openrouter.ts';

/**
 * AI reviews of a submission (Phase 10): the checks every AI route shares, reading reviews,
 * requesting a cross-review, and the submission's diff as the models (and the IDE) see it.
 */

const notFound = () => new HttpError(404, 'not_found', 'Submission not found');

/** Every project AI route: the project's switch must be on (409 `ai_disabled`). */
export function assertAiEnabled(access: ProjectAccess): void {
  if (!access.project.settings.aiReviewEnabled) {
    throw new HttpError(409, 'ai_disabled', 'AI review is switched off for this project');
  }
}

/** Requesting a review: the switch, `ai.crossReview`, and the accepted notice. */
export async function assertCanRequest(access: ProjectAccess, db: Db = prisma): Promise<void> {
  assertAiEnabled(access);
  if (!can(access.role, access.permissions, 'ai.crossReview')) {
    throw forbidden('You are not allowed to ask for AI reviews in this project');
  }
  const user = await db.user.findUnique({
    where: { id: access.userId },
    select: { aiNoticeAcceptedAt: true },
  });
  if (!user?.aiNoticeAcceptedAt) {
    throw new HttpError(409, 'notice_required', 'Read and accept the AI review notice first');
  }
}

/** The submission, if it can be reviewed (not closed or rejected). */
export async function reviewableSubmission(access: ProjectAccess, id: string, db: Db = prisma) {
  const row = await db.submission.findFirst({
    where: { id, projectId: access.project.id },
    select: {
      id: true,
      title: true,
      description: true,
      status: true,
      version: true,
      baseSha: true,
      headSha: true,
    },
  });
  if (!row) throw notFound();
  if (row.status === 'closed' || row.status === 'rejected') {
    throw new HttpError(
      409,
      'submission_not_reviewable',
      'This submission was closed or rejected, so it can’t be reviewed',
    );
  }
  return row;
}

// ---------- The diff ----------

const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

export class DiffTooLargeError extends Error {
  constructor() {
    super('The changes are too large');
    this.name = 'DiffTooLargeError';
  }
}

/**
 * The submission's changes as a unified diff (base → head: exactly its files; binary files
 * show as "Binary files … differ"). Built in the project's bare repository, never in a copy.
 * Throws DiffTooLargeError above `maxBytes`.
 */
export async function submissionDiff(
  gitDir: string,
  baseSha: string,
  headSha: string,
  maxBytes: number,
): Promise<string> {
  if (!SHA.test(baseSha) || !SHA.test(headSha)) throw new Error('bad commit id');
  try {
    const { stdout } = await runGit(
      [
        'diff',
        '--no-color',
        '--no-ext-diff',
        '--no-textconv',
        '--no-renames',
        '--src-prefix=a/',
        '--dst-prefix=b/',
        '-U3',
        baseSha,
        headSha,
      ],
      { gitDir, maxBuffer: maxBytes, timeoutMs: 60_000 },
    );
    return stdout.toString('utf8');
  } catch (err) {
    if (err instanceof GitError && err.kind === 'output_too_large') throw new DiffTooLargeError();
    throw err;
  }
}

// ---------- Views ----------

const reviewSelect = {
  id: true,
  submissionId: true,
  version: true,
  source: true,
  model: true,
  requestedModel: true,
  isFree: true,
  status: true,
  findings: true,
  parseError: true,
  raw: true,
  error: true,
  errorCode: true,
  createdAt: true,
  finishedAt: true,
  requestedBy: { select: { id: true, name: true } },
} as const;

type ReviewRow = Prisma.AiReviewGetPayload<{ select: typeof reviewSelect }>;

/** Stored findings, dropping anything that doesn't match the schema. */
export function readFindings(stored: unknown): AiFinding[] {
  if (!Array.isArray(stored)) return [];
  return stored.flatMap((item) => {
    const parsed = AiFindingSchema.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  });
}

function toView(row: ReviewRow): AiReviewView {
  const code = AiReviewErrorCodeSchema.safeParse(row.errorCode);
  return {
    id: row.id,
    submissionId: row.submissionId,
    version: row.version,
    requestedBy: row.requestedBy,
    source: row.source,
    model: row.model,
    requestedModel: row.requestedModel,
    isFree: row.isFree,
    status: row.status,
    findings: readFindings(row.findings),
    parseError: row.parseError,
    raw: row.raw,
    error: row.error,
    errorCode: code.success ? code.data : null,
    createdAt: row.createdAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
  };
}

/** GET …/submissions/:id/ai-reviews */
export async function listAiReviews(
  access: ProjectAccess,
  submissionId: string,
): Promise<AiReviewListResponse> {
  assertAiEnabled(access);
  const submission = await prisma.submission.findFirst({
    where: { id: submissionId, projectId: access.project.id },
    select: { id: true, version: true },
  });
  if (!submission) throw notFound();
  const rows = await prisma.aiReview.findMany({
    where: { submissionId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: reviewSelect,
  });
  const reviews = rows.map(toView);
  const current = reviews.filter((r) => r.status === 'done' && r.version === submission.version);
  return AiReviewListResponseSchema.parse({
    version: submission.version,
    reviews,
    groups: groupAiFindings(current),
    running: reviews.some(
      (r) =>
        r.source === 'auto' &&
        r.requestedBy.id === access.userId &&
        (r.status === 'queued' || r.status === 'running'),
    ),
  });
}

// ---------- Requesting a cross-review ----------

interface PickedModel {
  id: string;
  isFree: boolean;
}

/** The models for a request: the defaults, or the picked ones checked against OpenRouter's list. */
async function pickModels(body: CreateAiReviewRequest): Promise<PickedModel[]> {
  if (!body.models) {
    return env.AI_DEFAULT_MODELS.slice(0, 3).map((id) => ({ id, isFree: isFreeModelId(id) }));
  }
  const known = new Map((await listModels()).map((m) => [m.id, m]));
  const unknown = body.models.filter((id) => !known.has(id));
  if (unknown.length > 0) {
    throw new HttpError(
      400,
      'unknown_model',
      `OpenRouter has no model called ${unknown.join(', ')}`,
      undefined,
      { models: unknown },
    );
  }
  const picked = body.models.map((id) => ({ id, isFree: known.get(id)!.isFree }));
  const paid = picked.filter((m) => !m.isFree).map((m) => m.id);
  if (paid.length > 0 && body.confirmPaid !== true) {
    throw new HttpError(
      409,
      'paid_confirmation_required',
      'These models use your OpenRouter credits; confirm to go on',
      undefined,
      { models: paid },
    );
  }
  return picked;
}

/** POST …/submissions/:id/ai-reviews: one queued review per model, then the jobs. */
export async function requestCrossReview(
  access: ProjectAccess,
  submissionId: string,
  body: CreateAiReviewRequest,
): Promise<AiReviewListResponse> {
  await assertCanRequest(access);
  await reviewableSubmission(access, submissionId);
  const connected = await prisma.aiConnection.count({ where: { userId: access.userId } });
  if (connected === 0) {
    throw new HttpError(409, 'not_connected', 'Connect your OpenRouter account first');
  }
  const models = await pickModels(body);
  const batchId = randomUUID();

  const ids = await transaction(async (tx) => {
    // One cross-review at a time per member per submission.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`ai-review:${submissionId}:${access.userId}`}))`;
    const submission = await reviewableSubmission(access, submissionId, tx);
    const busy = await tx.aiReview.count({
      where: {
        submissionId,
        requestedById: access.userId,
        source: 'auto',
        status: { in: ['queued', 'running'] },
      },
    });
    if (busy > 0) {
      throw new HttpError(
        409,
        'ai_review_running',
        'Your AI review of this submission is still running',
      );
    }
    const created = [];
    for (const model of models) {
      const row = await tx.aiReview.create({
        data: {
          submissionId,
          version: submission.version,
          requestedById: access.userId,
          batchId,
          source: 'auto',
          model: model.id,
          requestedModel: model.id,
          isFree: model.isFree,
        },
        select: { id: true },
      });
      created.push(row.id);
    }
    await invalidateAfterCommit(tx, access.project.id, [`ai-reviews:${submissionId}`]);
    return created;
  });

  try {
    await queueAiReviews(ids);
  } catch (err) {
    console.error('Could not queue AI reviews:', err instanceof Error ? err.message : err);
    await transaction(async (tx) => {
      await tx.aiReview.updateMany({
        where: { id: { in: ids }, status: 'queued' },
        data: {
          status: 'failed',
          errorCode: 'internal',
          error: 'DevSpace could not start the review; try again in a moment',
          finishedAt: new Date(),
        },
      });
      await invalidateAfterCommit(tx, access.project.id, [`ai-reviews:${submissionId}`]);
    });
  }
  return listAiReviews(access, submissionId);
}

/** Findings stored in a row (the schema's shape, as JSON). */
export function findingsJson(findings: AiFinding[]): Prisma.InputJsonValue {
  return z.array(AiFindingSchema).parse(findings) as Prisma.InputJsonValue;
}
