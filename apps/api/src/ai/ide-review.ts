import {
  DEVSPACE_FOLDER,
  IdeFindingsRequestSchema,
  IdeFindingsResponseSchema,
  IdeReviewResponseSchema,
  MAX_AI_RAW_CHARS,
  MAX_IDE_REVIEW_DIFF_BYTES,
  parseAiFindings,
  type IdeFindingsResponse,
  type IdeReviewResponse,
} from '@devspace/shared';
import { copyDir, ensureCopy } from '../copies/service.ts';
import { CopyChangedError, readRegular, writeEntry } from '../copies/safe-fs.ts';
import type { Identity } from '../git/repo.ts';
import { HttpError } from '../lib/http-error.ts';
import { prisma } from '../lib/prisma.ts';
import { transaction } from '../lib/transaction.ts';
import { getProjectAccess, type ProjectAccess } from '../projects/access.ts';
import { invalidateAfterCommit } from '../realtime/emitter.ts';
import {
  assertCanRequest,
  DiffTooLargeError,
  findingsJson,
  reviewableSubmission,
  submissionDiff,
} from './reviews.ts';

/**
 * "Review with my IDE AI" (Phase 10): the changes and an instruction are written into the
 * reviewer's OWN copy, under `.devspace/reviews/<submissionId>/` (the scanner and copy updates
 * always skip `.devspace/`, so it is never submitted), using safe-fs (no links followed). The
 * tracker's "DevSpace: Send review findings" command sends findings.md back.
 */

export const reviewFolder = (submissionId: string) => `${DEVSPACE_FOLDER}/reviews/${submissionId}`;

function reviewInstructions(
  submission: { id: string; title: string; description: string; version: number },
  files: { path: string; change: string }[],
): string {
  const list = files.map((f) => `- ${f.path} (${f.change})`).join('\n');
  return `# Review: ${submission.title}

You are reviewing a teammate's submission in DevSpace (version ${submission.version}). Use the AI
assistant in this editor to review it, then send the findings back.

## Steps

1. Ask your AI assistant to review \`changes.diff\` in this folder. Give it this whole file as the
   instruction.
2. Put the findings in \`findings.md\`: replace the empty list \`[]\` with a JSON list of findings.
3. Open \`findings.md\` and run **DevSpace: Send review findings** from the Command Palette
   (Ctrl+Shift+P). The findings appear on the submission's review page.

## Instruction for the AI

Review the unified diff in \`changes.diff\`. Look for real problems in the changed lines: bugs,
security issues, broken edge cases and clear maintainability problems. Skip style nitpicks.
Answer with a JSON list only, each item shaped like this:

\`\`\`json
[
  {
    "path": "src/app.ts",
    "line": 12,
    "severity": "high",
    "title": "Short summary",
    "detail": "What is wrong and how to fix it"
  }
]
\`\`\`

\`path\` is the file as in the diff (without \`a/\` or \`b/\`), \`line\` is the line in the new
version, and \`severity\` is \`high\`, \`medium\` or \`low\`. Use \`[]\` if there is nothing to report.

## The submission

Title: ${submission.title}

Description:

${submission.description.trim() || '(none)'}

Files:

${list || '(none)'}

This folder is only in your copy. DevSpace never submits anything under \`.devspace/\`.
`;
}

function findingsTemplate(title: string): string {
  return `# Findings for "${title}"
#
# Replace the empty list at the bottom with your findings: a JSON list of objects with the
# fields path, line, severity (high, medium or low), title and detail. Only that list is read.
# Then run "DevSpace: Send review findings" from the Command Palette.

[]
`;
}

/** POST …/submissions/:id/ide-review */
export async function writeIdeReview(
  access: ProjectAccess,
  user: Identity & { id: string },
  submissionId: string,
): Promise<IdeReviewResponse> {
  await assertCanRequest(access);
  const submission = await reviewableSubmission(access, submissionId);
  if (!access.project.repoPath) {
    throw new HttpError(409, 'no_copy', "The project's repository isn't ready yet");
  }
  let diff: string;
  try {
    diff = await submissionDiff(
      access.project.repoPath,
      submission.baseSha,
      submission.headSha,
      MAX_IDE_REVIEW_DIFF_BYTES,
    );
  } catch (err) {
    if (err instanceof DiffTooLargeError) {
      throw new HttpError(
        409,
        'too_large',
        'The changes are too large to review this way (over 2 MB)',
      );
    }
    throw err;
  }
  const files = await prisma.submissionFile.findMany({
    where: { submissionId },
    orderBy: { path: 'asc' },
    select: { path: true, change: true },
  });
  const { copy } = await ensureCopy(access.project.id, user);
  const root = copyDir(access.project.id, copy.id);
  const folder = reviewFolder(submissionId);
  try {
    // So the copy's own Git (VS Code's Source Control panel) ignores the folder too.
    await writeEntry(root, `${DEVSPACE_FOLDER}/.gitignore`, '100644', Buffer.from('*\n'));
    await writeEntry(
      root,
      `${folder}/REVIEW.md`,
      '100644',
      Buffer.from(reviewInstructions(submission, files)),
    );
    await writeEntry(root, `${folder}/changes.diff`, '100644', Buffer.from(diff));
    // Never overwrite findings the reviewer already wrote.
    const existing = await readRegular(root, `${folder}/findings.md`, 10 * 1024 * 1024);
    if (existing === null) {
      await writeEntry(
        root,
        `${folder}/findings.md`,
        '100644',
        Buffer.from(findingsTemplate(submission.title)),
      );
    }
  } catch (err) {
    if (err instanceof CopyChangedError) {
      throw new HttpError(
        409,
        'copy_changed',
        'The .devspace folder in your copy is not a normal folder; remove it and try again',
      );
    }
    throw err;
  }
  return IdeReviewResponseSchema.parse({
    folder,
    files: ['REVIEW.md', 'changes.diff', 'findings.md'],
    idePath: `/projects/${access.project.id}/ide`,
  });
}

/** Who sent findings: the IDE session's user and the copy it is for. */
export interface IdeFindingsSender {
  userId: string;
  copy: { id: string; projectId: string; ownerId: string };
}

/**
 * POST <IDE_ORIGIN>/ide/<copyId>/__devspace/review-findings (after the proxy checked Origin,
 * Content-Type, size and the IDE session). Returns the status and JSON body to send.
 */
export async function receiveIdeFindings(
  who: IdeFindingsSender,
  input: unknown,
): Promise<{ status: number; body: IdeFindingsResponse | { error: string; message: string } }> {
  const bad = (status: number, error: string, message: string) => ({
    status,
    body: { error, message },
  });
  const parsed = IdeFindingsRequestSchema.safeParse(input);
  if (!parsed.success) {
    return bad(
      400,
      'validation_error',
      'Send { submissionId, findings } with findings up to 50 KB',
    );
  }
  if (who.userId !== who.copy.ownerId) {
    return bad(403, 'forbidden', 'Only the owner of this copy can send review findings from it');
  }
  try {
    const access = await getProjectAccess(who.copy.projectId, who.userId);
    await assertCanRequest(access);
    const submission = await reviewableSubmission(access, parsed.data.submissionId);
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: who.userId },
      select: { name: true },
    });
    const text = parsed.data.findings;
    const result = parseAiFindings(text);
    const model = `IDE AI (reported by ${user.name})`;
    const row = await transaction(async (tx) => {
      const created = await tx.aiReview.create({
        data: {
          submissionId: submission.id,
          version: submission.version,
          requestedById: who.userId,
          source: 'ide',
          model,
          requestedModel: model,
          isFree: null,
          status: 'done',
          findings: findingsJson(result.findings),
          parseError: result.parseError,
          raw: text.slice(0, MAX_AI_RAW_CHARS),
          startedAt: new Date(),
          finishedAt: new Date(),
        },
        select: { id: true },
      });
      await invalidateAfterCommit(tx, access.project.id, [`ai-reviews:${submission.id}`]);
      return created;
    });
    return {
      status: 201,
      body: IdeFindingsResponseSchema.parse({
        reviewId: row.id,
        findingCount: result.findings.length,
        parseError: result.parseError,
      }),
    };
  } catch (err) {
    if (err instanceof HttpError) return bad(err.status, err.body.error, err.body.message);
    throw err;
  }
}
