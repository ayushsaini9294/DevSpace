import { z } from 'zod';
import { RepoPathSchema } from './repository.ts';

/**
 * Submissions and review (Phase 6). All routes are under /api/projects/:projectId and answer
 * 404 `not_found` for non-members and unknown submissions. Errors use ErrorResponseSchema.
 */

// ---------- Limits ----------

/** Files scanned in a copy (after ignores) before the scan gives up (409 `submission_too_large`). */
export const MAX_SCANNED_FILES = 20_000;
/** Largest single file that can be submitted. */
export const MAX_SUBMISSION_FILE_BYTES = 10 * 1024 * 1024;
/** Largest total size of the submitted files. */
export const MAX_SUBMISSION_BYTES = 100 * 1024 * 1024;
/** Most files in one submission. */
export const MAX_SUBMISSION_FILES = 1_000;
/** Longest text in a comment body, review body or submission description. */
export const MAX_REVIEW_TEXT = 10_000;
/** Longest suggested replacement text. */
export const MAX_SUGGESTION_TEXT = 100_000;

// ---------- Enums ----------

/**
 * Phase 6 uses `open`, `changes_requested`, `approved`, `rejected` and `closed`; the others
 * arrive with Phase 7 (merge, needs update, revert).
 */
export const SubmissionStatusSchema = z.enum([
  'open',
  'changes_requested',
  'approved',
  'needs_update',
  'merged',
  'rejected',
  'closed',
  'reverted',
]);

/** Statuses in which a submission can still be updated, reviewed, commented on with suggestions or closed. */
export const ACTIVE_SUBMISSION_STATUSES = [
  'open',
  'changes_requested',
  'approved',
  'needs_update',
] as const satisfies readonly z.infer<typeof SubmissionStatusSchema>[];

export function isActiveSubmissionStatus(status: SubmissionStatus): boolean {
  return (ACTIVE_SUBMISSION_STATUSES as readonly string[]).includes(status);
}

/** How a file differs from the copy's base commit (`baseSha`). */
export const FileChangeSchema = z.enum(['added', 'modified', 'deleted']);

export const ReviewDecisionSchema = z.enum(['approved', 'changes_requested']);

/** `base` = the file at `baseSha`, `head` = the file in the submission's current version. */
export const DiffSideSchema = z.enum(['base', 'head']);

export const SuggestionStatusSchema = z.enum(['pending', 'accepted', 'rejected']);

/**
 * What the viewer may do on a submission right now. The web app shows buttons from this only.
 * - `update`: author, while active (re-pick files, edit title and description)
 * - `comment`: `submission.comment` or the author (general and line comments, replies)
 * - `suggest`: `submission.comment`, while active (suggested changes on the head side)
 * - `respondSuggestion`: author, while active (accept or reject pending suggestions)
 * - `approve` / `requestChanges`: `submission.approve`, not the author, while active
 * - `reject`: `submission.reject` (leaders and co-leaders), while active
 * - `close`: author or leader/co-leader, while active
 */
export const SubmissionViewerActionSchema = z.enum([
  'update',
  'comment',
  'suggest',
  'respondSuggestion',
  'approve',
  'requestChanges',
  'reject',
  'close',
]);

// ---------- Shared pieces ----------

export const SubmissionTitleSchema = z
  .string()
  .trim()
  .min(1, 'Enter a title')
  .max(200, 'Use at most 200 characters');

export const SubmissionDescriptionSchema = z
  .string()
  .max(MAX_REVIEW_TEXT, `Use at most ${MAX_REVIEW_TEXT} characters`);

/** The paths picked for a submission: 1–1,000 distinct repository paths. */
export const SubmissionPathsSchema = z
  .array(RepoPathSchema.refine((p) => p !== '', 'Invalid path'))
  .min(1, 'Pick at least one file')
  .max(MAX_SUBMISSION_FILES, `Pick at most ${MAX_SUBMISSION_FILES} files`)
  .refine((paths) => new Set(paths).size === paths.length, 'Each file may be picked once');

export const UserRefSchema = z.object({ id: z.string(), name: z.string() });

// ---------- GET /copy/changes ----------

export const ChangedFileSchema = z.object({
  path: z.string(),
  change: FileChangeSchema,
  /** The id of one of my active submissions that already holds this path (the file is locked), or null. */
  openSubmissionId: z.string().nullable(),
});

/**
 * GET /api/projects/:projectId/copy/changes — any member; the files in my copy that differ
 * from the main commit my copy was made from, sorted by path. 409 `no_copy` if I have no copy
 * yet; 409 `submission_too_large` if the copy has more than MAX_SCANNED_FILES files.
 */
export const CopyChangesResponseSchema = z.object({
  baseSha: z.string(),
  files: z.array(ChangedFileSchema),
});

// ---------- Submissions ----------

/**
 * POST /api/projects/:projectId/submissions — any member, from their own copy. 201
 * SubmissionResponse. Errors: 409 `no_copy`; 409 `no_changes` (a path isn't changed; `details.paths`);
 * 409 `file_in_open_submission` (`details.paths`, `details.submissionId`); 409 `submission_too_large`.
 */
export const CreateSubmissionRequestSchema = z.object({
  title: SubmissionTitleSchema,
  description: SubmissionDescriptionSchema.default(''),
  paths: SubmissionPathsSchema,
});

/** GET /api/projects/:projectId/submissions?status=active|all (default active). */
export const SubmissionListQuerySchema = z.object({
  status: z.enum(['active', 'all']).default('active'),
});

export const SubmissionSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  status: SubmissionStatusSchema,
  author: UserRefSchema,
  version: z.number().int().min(1),
  fileCount: z.number().int(),
  commentCount: z.number().int(),
  /** Reviewers whose latest non-stale review is an approval. */
  approvals: z.number().int(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const SubmissionFileSchema = z.object({ path: z.string(), change: FileChangeSchema });

export const ReviewSchema = z.object({
  id: z.string(),
  reviewer: UserRefSchema,
  decision: ReviewDecisionSchema,
  body: z.string().nullable(),
  /** The submission version this review was given on. */
  version: z.number().int(),
  /** True once the submission was updated after this review (it no longer counts). */
  stale: z.boolean(),
  createdAt: z.iso.datetime(),
});

export const CommentSchema = z.object({
  id: z.string(),
  author: UserRefSchema,
  /** The comment this one replies to (replies are one level deep), or null. */
  parentId: z.string().nullable(),
  /** All four are null for a general comment and for replies (a reply belongs to its parent's line). */
  path: z.string().nullable(),
  side: DiffSideSchema.nullable(),
  /** 1-based line the comment is on (the last line of a range). */
  line: z.number().int().nullable(),
  /** 1-based first line of a range (equals `line` for one line). */
  startLine: z.number().int().nullable(),
  /** The submission version the comment was written on. */
  version: z.number().int(),
  body: z.string(),
  /** Replacement text for lines `startLine..line` on the head side, or null. */
  suggestion: z.string().nullable(),
  suggestionStatus: SuggestionStatusSchema.nullable(),
  /** The file left the submission, or the text at `line` on `side` changed since the comment. */
  outdated: z.boolean(),
  createdAt: z.iso.datetime(),
});

export const SubmissionDetailSchema = SubmissionSummarySchema.extend({
  description: z.string(),
  baseSha: z.string(),
  headSha: z.string(),
  rejectReason: z.string().nullable(),
  closedAt: z.iso.datetime().nullable(),
  files: z.array(SubmissionFileSchema),
  /** Oldest first. */
  reviews: z.array(ReviewSchema),
  /** Oldest first; replies follow the same order (group them by `parentId`). */
  comments: z.array(CommentSchema),
  viewerActions: z.array(SubmissionViewerActionSchema),
});

/** GET /api/projects/:projectId/submissions — newest first. */
export const SubmissionListResponseSchema = z.object({
  submissions: z.array(SubmissionSummarySchema),
});

/** GET /submissions/:id and the result of every action on a submission. */
export const SubmissionResponseSchema = z.object({ submission: SubmissionDetailSchema });

// ---------- File diff ----------

/** One side of a file's diff. `none` = the file doesn't exist on that side. Limit: MAX_FILE_VIEW_BYTES. */
export const FileSideSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), content: z.string() }),
  z.object({ kind: z.literal('binary') }),
  z.object({ kind: z.literal('too_large') }),
  z.object({ kind: z.literal('none') }),
]);

/** GET /submissions/:id/file?path=<RepoPath> — the file must be in the current version (else 404). */
export const SubmissionFileQuerySchema = z.object({
  path: RepoPathSchema.refine((p) => p !== '', 'Invalid path'),
});

export const SubmissionFileResponseSchema = z.object({
  path: z.string(),
  change: FileChangeSchema,
  base: FileSideSchema,
  head: FileSideSchema,
});

// ---------- Actions ----------

/**
 * POST /submissions/:id/update — author only, while active (409 `submission_not_active`).
 * Re-reads the files from my copy (`paths` defaults to the current list), bumps `version`,
 * marks every earlier review stale and sets the status back to `open`. Same 409s as create.
 */
export const UpdateSubmissionRequestSchema = z.object({
  title: SubmissionTitleSchema.optional(),
  description: SubmissionDescriptionSchema.optional(),
  paths: SubmissionPathsSchema.optional(),
});

const LineSchema = z.number().int().min(1).max(10_000_000);

/**
 * POST /submissions/:id/comments — 201 CommentResponse. `submission.comment` or the author
 * (403 otherwise). A line comment needs `path`, `side` and `line` (path must be in the current
 * version); `startLine` (≤ line) makes it a range. A reply sends only `parentId` and `body`.
 * A suggestion needs `submission.comment`, `side: 'head'`, and an active submission; `suggestion`
 * replaces lines `startLine..line` (an empty string removes them).
 */
export const CreateCommentRequestSchema = z
  .object({
    body: z
      .string()
      .max(MAX_REVIEW_TEXT, `Use at most ${MAX_REVIEW_TEXT} characters`)
      .refine((b) => b.trim().length > 0, 'Write a comment'),
    parentId: z.string().min(1).optional(),
    path: RepoPathSchema.refine((p) => p !== '', 'Invalid path').optional(),
    side: DiffSideSchema.optional(),
    line: LineSchema.optional(),
    startLine: LineSchema.optional(),
    suggestion: z
      .string()
      .max(MAX_SUGGESTION_TEXT, `Use at most ${MAX_SUGGESTION_TEXT} characters`)
      .optional(),
  })
  .superRefine((value, ctx) => {
    const located = [value.path, value.side, value.line].filter((v) => v !== undefined).length;
    if (located !== 0 && located !== 3) {
      ctx.addIssue({
        code: 'custom',
        path: ['path'],
        message: 'A line comment needs path, side and line',
      });
    }
    if (value.parentId !== undefined && (located > 0 || value.suggestion !== undefined)) {
      ctx.addIssue({
        code: 'custom',
        path: ['parentId'],
        message: 'A reply takes only a body',
      });
    }
    if (value.startLine !== undefined) {
      if (value.line === undefined) {
        ctx.addIssue({ code: 'custom', path: ['startLine'], message: 'startLine needs line' });
      } else if (value.startLine > value.line) {
        ctx.addIssue({
          code: 'custom',
          path: ['startLine'],
          message: 'startLine must not be after line',
        });
      }
    }
    if (value.suggestion !== undefined && (located !== 3 || value.side !== 'head')) {
      ctx.addIssue({
        code: 'custom',
        path: ['suggestion'],
        message: 'A suggestion must be on lines of the new version',
      });
    }
  });

export const CommentResponseSchema = z.object({ comment: CommentSchema });

/**
 * POST /submissions/:id/comments/:commentId/suggestion — author only, while active, pending
 * suggestions only (409 `suggestion_not_pending`). `accept` writes the replacement into my copy's
 * file (409 `suggestion_stale` if those lines in my copy no longer match the current version),
 * then updates the submission with the same files (approvals reset). Returns SubmissionResponse.
 */
export const SuggestionDecisionRequestSchema = z.object({
  decision: z.enum(['accept', 'reject']),
});

/**
 * POST /submissions/:id/reviews — `submission.approve`, never the author (403 `own_submission`),
 * while active. Returns SubmissionResponse with the new status.
 */
export const CreateReviewRequestSchema = z.object({
  decision: ReviewDecisionSchema,
  body: z.string().max(MAX_REVIEW_TEXT, `Use at most ${MAX_REVIEW_TEXT} characters`).optional(),
});

/** POST /submissions/:id/reject — `submission.reject`, while active. Returns SubmissionResponse. */
export const RejectSubmissionRequestSchema = z.object({
  reason: z.string().trim().min(1, 'Give a reason').max(2_000, 'Use at most 2000 characters'),
});

// POST /submissions/:id/close (no body) — author or leader/co-leader, while active. SubmissionResponse.

export type SubmissionStatus = z.infer<typeof SubmissionStatusSchema>;
export type FileChange = z.infer<typeof FileChangeSchema>;
export type ReviewDecision = z.infer<typeof ReviewDecisionSchema>;
export type DiffSide = z.infer<typeof DiffSideSchema>;
export type SuggestionStatus = z.infer<typeof SuggestionStatusSchema>;
export type SubmissionViewerAction = z.infer<typeof SubmissionViewerActionSchema>;
export type UserRef = z.infer<typeof UserRefSchema>;
export type ChangedFile = z.infer<typeof ChangedFileSchema>;
export type CopyChangesResponse = z.infer<typeof CopyChangesResponseSchema>;
export type CreateSubmissionRequest = z.infer<typeof CreateSubmissionRequestSchema>;
export type SubmissionListQuery = z.infer<typeof SubmissionListQuerySchema>;
export type SubmissionSummary = z.infer<typeof SubmissionSummarySchema>;
export type SubmissionFile = z.infer<typeof SubmissionFileSchema>;
export type Review = z.infer<typeof ReviewSchema>;
export type Comment = z.infer<typeof CommentSchema>;
export type SubmissionDetail = z.infer<typeof SubmissionDetailSchema>;
export type SubmissionListResponse = z.infer<typeof SubmissionListResponseSchema>;
export type SubmissionResponse = z.infer<typeof SubmissionResponseSchema>;
export type FileSide = z.infer<typeof FileSideSchema>;
export type SubmissionFileResponse = z.infer<typeof SubmissionFileResponseSchema>;
export type UpdateSubmissionRequest = z.infer<typeof UpdateSubmissionRequestSchema>;
export type CreateCommentRequest = z.infer<typeof CreateCommentRequestSchema>;
export type CommentResponse = z.infer<typeof CommentResponseSchema>;
export type SuggestionDecisionRequest = z.infer<typeof SuggestionDecisionRequestSchema>;
export type CreateReviewRequest = z.infer<typeof CreateReviewRequestSchema>;
export type RejectSubmissionRequest = z.infer<typeof RejectSubmissionRequestSchema>;
