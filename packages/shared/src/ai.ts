import { z } from 'zod';
import { UserRefSchema } from './submissions.ts';

/**
 * AI review (Phase 10). Members connect their own OpenRouter account (OAuth PKCE); the key is
 * stored encrypted on the server and never reaches the browser. Errors use ErrorResponseSchema.
 *
 * Error codes (409 unless noted):
 * - `ai_disabled`: the project's "Allow AI review" switch is off (every project AI route)
 * - `not_connected`: you haven't connected OpenRouter
 * - `notice_required`: accept the one-time notice first (POST /api/ai/notice/accept)
 * - `paid_confirmation_required`: a picked model isn't free; send `confirmPaid: true`
 * - `unknown_model` (400): a picked model isn't in OpenRouter's model list (`details.models`)
 * - `ai_review_running`: you already have a cross-review queued or running on this submission
 * - `submission_not_reviewable`: the submission is closed or rejected
 * - `too_large`: the diff is over the limit (IDE review; cross-reviews fail with `errorCode`)
 * - `no_copy`: IDE review needs your copy, and the project's repository isn't ready
 * - `invalid_state` (400): the OAuth state is unknown, used, expired or someone else's
 * - `openrouter_error` (502): OpenRouter refused the code or didn't answer (`message` says why)
 * - 403 `forbidden` without `ai.crossReview`; 404 `not_found` for non-members/unknown submissions
 */

// ---------- Limits and defaults ----------

/** Most models in one cross-review. */
export const MAX_AI_MODELS_PER_REVIEW = 3;
/** Largest diff (UTF-8 bytes) sent to a model; bigger → the review fails with `too_large`. */
export const MAX_AI_DIFF_BYTES = 150 * 1024;
/** Largest diff written for "Review with my IDE AI" (409 `too_large` above it). */
export const MAX_IDE_REVIEW_DIFF_BYTES = 2 * 1024 * 1024;
/** Largest model answer kept (`raw`), in characters. */
export const MAX_AI_RAW_CHARS = 100 * 1024;
/** Largest findings text the IDE command may send (UTF-8 bytes). */
export const MAX_IDE_FINDINGS_BYTES = 50 * 1024;
/** Most findings kept from one answer. */
export const MAX_AI_FINDINGS = 100;
/** Findings on the same path within this many lines of each other are grouped. */
export const AI_AGREEMENT_LINES = 3;
/** The folder "Review with my IDE AI" writes in the reviewer's copy (never submitted). */
export const DEVSPACE_FOLDER = '.devspace';

/** OpenRouter model id, e.g. `qwen/qwen3.8-27b:free` or `openrouter/free`. */
export const AiModelIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9._~:/-]+$/, 'Invalid model id');

// ---------- Connection (/api/ai, logged in) ----------

/** Free-model requests today (UTC), from OpenRouter's GET /api/v1/key (cached 60 s). */
export const FreeRequestsSchema = z.object({
  used: z.number().int().nonnegative(),
  limit: z.number().int().nonnegative(),
  remaining: z.number().int().nonnegative(),
});

/**
 * GET /api/ai/connection → AiConnectionView. `freeRequestsToday` is null when not connected or
 * when OpenRouter couldn't be asked. `noticeAcceptedAt` is when you accepted the one-time AI
 * notice (null: show it before your first AI review).
 */
export const AiConnectionViewSchema = z.object({
  connected: z.boolean(),
  provider: z.literal('openrouter'),
  /** Last 4 characters of the key, or null. */
  keyHint: z.string().nullable(),
  connectedAt: z.iso.datetime().nullable(),
  freeRequestsToday: FreeRequestsSchema.nullable(),
  noticeAcceptedAt: z.iso.datetime().nullable(),
});

/**
 * POST /api/ai/openrouter/start (body `{}`) → { url }: send the browser there (a full-page
 * navigation). OpenRouter comes back to APP_ORIGIN/settings/ai/callback?state=…&code=….
 */
export const AiConnectStartResponseSchema = z.object({ url: z.url() });

/**
 * POST /api/ai/openrouter/finish { code, state } → AiConnectionView (connected). The state is
 * single use, 10 minutes, and bound to your session (400 `invalid_state` otherwise); 502
 * `openrouter_error` if OpenRouter refuses the code. Connecting again replaces the old key.
 */
export const AiConnectFinishRequestSchema = z.object({
  code: z.string().trim().min(1).max(2000),
  state: z.string().trim().min(1).max(200),
});

// DELETE /api/ai/connection (no body) → 204. Deletes the stored key (tell the member they can
// also delete it in their OpenRouter settings).

/** POST /api/ai/notice/accept (body `{}`) → { noticeAcceptedAt } (kept from the first time). */
export const AiNoticeAcceptResponseSchema = z.object({ noticeAcceptedAt: z.iso.datetime() });

/** One OpenRouter model. `isFree`: an id ending `:free`, or zero prompt and completion price. */
export const AiModelSchema = z.object({
  id: z.string(),
  name: z.string(),
  isFree: z.boolean(),
  contextLength: z.number().int().nullable(),
});

/**
 * GET /api/ai/models → every OpenRouter model (sorted: free first, then by name; cached 10 min),
 * plus the default and fallback lists (config `AI_DEFAULT_MODELS` / `AI_FALLBACK_MODELS`).
 * 502 `openrouter_error` if OpenRouter can't be reached.
 */
export const AiModelListResponseSchema = z.object({
  models: z.array(AiModelSchema),
  defaults: z.array(z.string()),
  fallbacks: z.array(z.string()),
});

// ---------- Reviews (/api/projects/:projectId/submissions/:id/…) ----------

export const AiReviewStatusSchema = z.enum(['queued', 'running', 'done', 'failed']);
export const AiReviewSourceSchema = z.enum(['auto', 'ide']);
export const AiSeveritySchema = z.enum(['high', 'medium', 'low']);

/**
 * Why a review failed (`status: 'failed'`), for a clear message; `error` has the words.
 * - `too_large`: the diff is over MAX_AI_DIFF_BYTES
 * - `daily_limit`: OpenRouter's free daily limit was reached (e.g. 50/day)
 * - `rate_limited`: every model was rate limited / busy (429) for other reasons
 * - `key_invalid`: OpenRouter refused the key (reconnect)
 * - `no_credits`: a paid model needs credits (402)
 * - `not_connected`: the key was disconnected before the review ran
 * - `models_failed`: every model and fallback failed (5xx, timeout, empty answer)
 * - `internal`: something went wrong in DevSpace
 */
export const AiReviewErrorCodeSchema = z.enum([
  'too_large',
  'daily_limit',
  'rate_limited',
  'key_invalid',
  'no_credits',
  'not_connected',
  'models_failed',
  'internal',
]);

/** One finding. All text is untrusted AI output: render as plain text only. */
export const AiFindingSchema = z.object({
  path: z.string(),
  /** 1-based line in the new version, or null when the model gave none. */
  line: z.number().int().positive().nullable(),
  severity: AiSeveritySchema,
  title: z.string(),
  detail: z.string(),
});

export const AiReviewViewSchema = z.object({
  id: z.string(),
  submissionId: z.string(),
  /** The submission version reviewed. */
  version: z.number().int(),
  requestedBy: UserRefSchema,
  source: AiReviewSourceSchema,
  /** The model that answered (a fallback if the requested one failed); for `ide`, "IDE AI (reported by <name>)". */
  model: z.string(),
  /** The model first asked (equals `model` unless a fallback answered). */
  requestedModel: z.string(),
  /** null for `ide` reviews. */
  isFree: z.boolean().nullable(),
  status: AiReviewStatusSchema,
  findings: z.array(AiFindingSchema),
  /** The answer had no readable JSON array: `findings` is empty and `raw` holds the answer. */
  parseError: z.boolean(),
  /** The model's answer as text (≤ MAX_AI_RAW_CHARS), or null. Plain text only. */
  raw: z.string().nullable(),
  error: z.string().nullable(),
  errorCode: AiReviewErrorCodeSchema.nullable(),
  createdAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
});

/**
 * Findings from `done` reviews of the submission's current version, grouped: same path, lines
 * within ±AI_AGREEMENT_LINES of the group's first line (findings without a line group per path).
 * `agreedBy` = the distinct models in the group; highlight groups with 2 or more.
 */
export const AiFindingGroupSchema = z.object({
  path: z.string(),
  /** Lowest and highest line in the group (null when the findings have no line). */
  startLine: z.number().int().nullable(),
  endLine: z.number().int().nullable(),
  /** The highest severity in the group. */
  severity: AiSeveritySchema,
  agreedBy: z.array(z.string()),
  findings: z.array(AiFindingSchema.extend({ reviewId: z.string(), model: z.string() })),
});

/**
 * GET …/submissions/:id/ai-reviews → every AI review of the submission (newest first), the
 * groups for the current `version`, and `running`: you have a cross-review queued or running
 * here (then the Cross-review button is busy). Any project member. 409 `ai_disabled` while off.
 */
export const AiReviewListResponseSchema = z.object({
  version: z.number().int(),
  reviews: z.array(AiReviewViewSchema),
  groups: z.array(AiFindingGroupSchema),
  running: z.boolean(),
});

/**
 * POST …/submissions/:id/ai-reviews { models?, confirmPaid? } → 201 AiReviewListResponse (with
 * the new `queued` reviews). Needs `ai.crossReview` (allowedActions), a connected key, the
 * project switch on, the notice accepted, and a submission that isn't closed or rejected.
 * Without `models`, the configured defaults. Each review falls back through the fallback list.
 * Live: socket `invalidate` key `ai-reviews:<submissionId>`; notification `ai_review.finished`
 * to you when all of them have finished.
 */
export const CreateAiReviewRequestSchema = z.object({
  models: z
    .array(AiModelIdSchema)
    .min(1, 'Pick at least one model')
    .max(MAX_AI_MODELS_PER_REVIEW, `Pick at most ${MAX_AI_MODELS_PER_REVIEW} models`)
    .refine((m) => new Set(m).size === m.length, 'Each model may be picked once')
    .optional(),
  /** Required (true) when any picked model isn't free: it uses your OpenRouter credits. */
  confirmPaid: z.boolean().optional(),
});

/**
 * POST …/submissions/:id/ide-review (body `{}`) → 201. Same permission and switches as a
 * cross-review. Writes `.devspace/reviews/<submissionId>/` (REVIEW.md, changes.diff,
 * findings.md) into YOUR copy (made if you have none), then the web app opens your IDE at
 * `idePath` (the normal IDE page: it starts the container and launches as usual).
 */
export const IdeReviewResponseSchema = z.object({
  /** Folder in the copy, relative to the workspace: `.devspace/reviews/<submissionId>`. */
  folder: z.string(),
  files: z.array(z.string()),
  /** Web app route to open, `/projects/<projectId>/ide`. */
  idePath: z.string(),
});

/**
 * POST <IDE_ORIGIN>/ide/<copyId>/__devspace/review-findings — the tracker's "DevSpace: Send
 * review findings" command, with the `devspace_ide` cookie, `Content-Type: application/json`
 * and Origin = IDE_ORIGIN. The IDE session's user must own the copy. `findings` is the text of
 * findings.md (a JSON array, parsed tolerantly). → 201 IdeFindingsResponse, or an error
 * `{ error, message }` (400 validation_error / 403 forbidden / 404 not_found / 409 as above /
 * 413 payload_too_large / 415 unsupported_media_type).
 */
export const IdeFindingsRequestSchema = z.object({
  submissionId: z.string().min(1).max(100),
  findings: z
    .string()
    .refine(
      (s) => new TextEncoder().encode(s).length <= MAX_IDE_FINDINGS_BYTES,
      'Findings are larger than 50 KB',
    ),
});

export const IdeFindingsResponseSchema = z.object({
  reviewId: z.string(),
  findingCount: z.number().int().nonnegative(),
  parseError: z.boolean(),
});

export type FreeRequests = z.infer<typeof FreeRequestsSchema>;
export type AiConnectionView = z.infer<typeof AiConnectionViewSchema>;
export type AiConnectStartResponse = z.infer<typeof AiConnectStartResponseSchema>;
export type AiConnectFinishRequest = z.infer<typeof AiConnectFinishRequestSchema>;
export type AiNoticeAcceptResponse = z.infer<typeof AiNoticeAcceptResponseSchema>;
export type AiModel = z.infer<typeof AiModelSchema>;
export type AiModelListResponse = z.infer<typeof AiModelListResponseSchema>;
export type AiReviewStatus = z.infer<typeof AiReviewStatusSchema>;
export type AiReviewSource = z.infer<typeof AiReviewSourceSchema>;
export type AiSeverity = z.infer<typeof AiSeveritySchema>;
export type AiReviewErrorCode = z.infer<typeof AiReviewErrorCodeSchema>;
export type AiFinding = z.infer<typeof AiFindingSchema>;
export type AiReviewView = z.infer<typeof AiReviewViewSchema>;
export type AiFindingGroup = z.infer<typeof AiFindingGroupSchema>;
export type AiReviewListResponse = z.infer<typeof AiReviewListResponseSchema>;
export type CreateAiReviewRequest = z.infer<typeof CreateAiReviewRequestSchema>;
export type IdeReviewResponse = z.infer<typeof IdeReviewResponseSchema>;
export type IdeFindingsRequest = z.infer<typeof IdeFindingsRequestSchema>;
export type IdeFindingsResponse = z.infer<typeof IdeFindingsResponseSchema>;

// ---------- Pure helpers (API and tests) ----------

const SEVERITY_RANK: Record<AiSeverity, number> = { high: 3, medium: 2, low: 1 };

function text(value: unknown, max: number): string {
  if (typeof value === 'string') return value.trim().slice(0, max);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function severityOf(value: unknown): AiSeverity {
  const s = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (s === 'high' || s === 'critical' || s === 'error') return 'high';
  if (s === 'low' || s === 'info' || s === 'minor' || s === 'nit') return 'low';
  return 'medium';
}

/** The first balanced JSON array in `answer` that parses, or null. */
function firstJsonArray(answer: string): unknown[] | null {
  for (let start = answer.indexOf('['); start !== -1; start = answer.indexOf('[', start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < answer.length; i++) {
      const c = answer[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (c === '\\') escaped = true;
        else if (c === '"') inString = false;
        continue;
      }
      if (c === '"') inString = true;
      else if (c === '[') depth++;
      else if (c === ']') {
        depth--;
        if (depth === 0) {
          try {
            const value: unknown = JSON.parse(answer.slice(start, i + 1));
            if (Array.isArray(value)) return value;
          } catch {
            // not JSON: try the next '['
          }
          break;
        }
      }
    }
  }
  return null;
}

/**
 * Tolerant parse of a model's answer: the first JSON array in it; each object item becomes a
 * finding (missing text → empty, unknown severity → medium, bad line → null, path without a
 * leading `./` or `/`). Items without a path are dropped. At most MAX_AI_FINDINGS.
 */
export function parseAiFindings(answer: string): { findings: AiFinding[]; parseError: boolean } {
  const items = firstJsonArray(answer);
  if (!items) return { findings: [], parseError: true };
  const findings: AiFinding[] = [];
  for (const item of items) {
    if (findings.length >= MAX_AI_FINDINGS) break;
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue;
    const o = item as Record<string, unknown>;
    const path = text(o.path ?? o.file, 500).replace(/^(\.\/|\/)+/, '');
    if (!path) continue;
    const lineNumber = typeof o.line === 'string' ? Number.parseInt(o.line, 10) : o.line;
    const line =
      typeof lineNumber === 'number' && Number.isInteger(lineNumber) && lineNumber > 0
        ? lineNumber
        : null;
    findings.push({
      path,
      line,
      severity: severityOf(o.severity),
      title: text(o.title, 300),
      detail: text(o.detail ?? o.description ?? o.message, 5000),
    });
  }
  return { findings, parseError: false };
}

/** Groups findings (see AiFindingGroupSchema). Deterministic: by path, then line. */
export function groupAiFindings(
  reviews: { id: string; model: string; findings: AiFinding[] }[],
): AiFindingGroup[] {
  type Item = AiFinding & { reviewId: string; model: string };
  const byPath = new Map<string, Item[]>();
  for (const review of reviews) {
    for (const f of review.findings) {
      const list = byPath.get(f.path) ?? [];
      list.push({ ...f, reviewId: review.id, model: review.model });
      byPath.set(f.path, list);
    }
  }
  const groups: AiFindingGroup[] = [];
  for (const path of [...byPath.keys()].sort()) {
    const items = byPath.get(path)!;
    const noLine = items.filter((f) => f.line === null);
    const withLine = items
      .filter((f) => f.line !== null)
      .sort((a, b) => (a.line as number) - (b.line as number));
    const clusters: Item[][] = [];
    for (const f of withLine) {
      const last = clusters.at(-1);
      if (last && (f.line as number) - (last[0]!.line as number) <= AI_AGREEMENT_LINES) {
        last.push(f);
      } else clusters.push([f]);
    }
    if (noLine.length > 0) clusters.push(noLine);
    for (const cluster of clusters) {
      const lines = cluster.map((f) => f.line).filter((l): l is number => l !== null);
      const severity = cluster.reduce<AiSeverity>(
        (best, f) => (SEVERITY_RANK[f.severity] > SEVERITY_RANK[best] ? f.severity : best),
        'low',
      );
      groups.push({
        path,
        startLine: lines.length > 0 ? Math.min(...lines) : null,
        endLine: lines.length > 0 ? Math.max(...lines) : null,
        severity,
        agreedBy: [...new Set(cluster.map((f) => f.model))],
        findings: cluster,
      });
    }
  }
  return groups;
}
