import { z } from 'zod';

/**
 * The state of a copy's IDE container: `none` (never started), `starting` (poll GET /copy about
 * once a second), `running` (ask for a launch URL), `stopped` (idle, or the API restarted without it;
 * files are kept), `failed` (the start failed; POST /copy/ide again to retry).
 */
export const CopyContainerStatusSchema = z.enum([
  'none',
  'starting',
  'running',
  'stopped',
  'failed',
]);

/**
 * A member's own working copy of a project: their files on their own branch (`copy/<userId>`),
 * made from main the first time they open the project. Never includes paths on the server.
 */
/** A leader or co-leader who opened this copy in the IDE (Phase 7), with the latest time. */
export const CopyHelperSchema = z.object({
  user: z.object({ id: z.string(), name: z.string() }),
  at: z.iso.datetime(),
});

export const CopyViewSchema = z.object({
  id: z.uuid(),
  branchName: z.string(),
  containerStatus: CopyContainerStatusSchema,
  createdAt: z.iso.datetime(),
  lastActiveAt: z.iso.datetime().nullable(),
  /** Main has moved since this copy was last updated (Phase 7). Show "Update my copy". */
  behind: z.boolean(),
  /**
   * Automatic mode found conflicts and left the copy untouched: these files would conflict.
   * Cleared when the copy is updated. Sorted.
   */
  pendingConflictPaths: z.array(z.string()),
  /** Files an update wrote conflict markers into that still hold a marker line. Sorted. */
  unresolvedPaths: z.array(z.string()),
  /** Leaders and co-leaders (not the owner) who opened this copy in the last 24 h, newest first. */
  helpers: z.array(CopyHelperSchema),
});

/**
 * GET /api/projects/:projectId/copy — any member; the caller's own copy, or null if they have
 * none yet. 404 `not_found` for non-members.
 *
 * POST /api/projects/:projectId/copy (no body) — any member; makes the caller's copy on the
 * first call (201) and returns the same copy on every later call (200).
 * 409 `repository_not_ready` unless the project's repository is ready.
 *
 * POST /api/projects/:projectId/copy/ide (no body) — any member; makes the caller's copy if
 * needed, then starts its IDE container (or reuses the running one) and answers right away
 * with `starting` or `running` (200, `copy` never null). Calling again while `starting` returns
 * the same start; after `failed` or `stopped` it starts again. Same 404 and 409 as above.
 */
export const CopyResponseSchema = z.object({ copy: CopyViewSchema.nullable() });

/**
 * POST /api/projects/:projectId/copy/ide/launch (no body) — the copy's owner, while its IDE is
 * `running` (else 409 `ide_not_running`; 404 `not_found` for non-members, and when the caller
 * has no copy). `url` is an absolute link on the IDE's own site,
 * `<IDE_ORIGIN>/ide-launch?ticket=<ticket>`, for the iframe. The ticket works once, within 60 s,
 * so ask for a fresh URL on every load or retry.
 */
export const IdeLaunchResponseSchema = z.object({ url: z.url({ protocol: /^https?$/ }) });

// ---------- Updating a copy to the new main (Phase 7) ----------

/**
 * GET /api/projects/:projectId/copy/update — the copy's owner; computed live. `behind` = main
 * moved since the copy's base; `conflictPaths` = files that would get conflict markers (or keep
 * your version, for binary and modify/delete clashes) if you update now. 404 `not_found` for
 * non-members; 409 `no_copy` when you have no copy yet; 409 `submission_too_large` when the copy
 * is too big to scan.
 */
export const CopyUpdatePreviewSchema = z.object({
  behind: z.boolean(),
  conflictPaths: z.array(z.string()),
});

/**
 * POST /api/projects/:projectId/copy/update (no body) — the copy's owner. Brings main's changes
 * into the copy's files (never touching its `.git`), even with conflicts: conflicting text files
 * get markers `<<<<<<< your copy` … `>>>>>>> main`, which then show in `copy.unresolvedPaths`.
 * Returns the updated copy and the conflicted files. Already up to date → same answer, nothing
 * changes. 409 `copy_changed` when a file changed on disk while updating (nothing was written;
 * try again); 409 `no_copy`; 409 `submission_too_large`.
 */
export const CopyUpdateResponseSchema = z.object({
  copy: CopyViewSchema,
  conflictPaths: z.array(z.string()),
});

// ---------- A lead opens a member's copy (Phase 7) ----------

/**
 * `copy.helpFixConflict` (leaders and co-leaders) may open any member's copy. `:userId` is the
 * copy's owner; they must be a current project member with a copy (else 404 `not_found`).
 * Everyone else gets 403 `forbidden`.
 *
 * GET /api/projects/:projectId/members/:userId/copy → CopyResponse (poll while `starting`).
 * POST /api/projects/:projectId/members/:userId/copy/ide (no body) → CopyResponse (copy never
 *   null): starts or reuses that member's IDE container, like POST /copy/ide.
 * POST /api/projects/:projectId/members/:userId/copy/ide/launch (no body) → IdeLaunchResponse:
 *   a one-time link for the calling lead into that copy (409 `ide_not_running` unless running).
 *   Each launch is logged as activity `copy.helped` and shows in the copy's `helpers`.
 */

/**
 * Activity actions added in Phase 7 (entries in GET /api/projects/:projectId/activity):
 * `submission.merged` (target: submission id; data: title, sha), `submission.reverted`
 * (target: submission id; data: title, sha), `copy.updated` (actor: the owner, or null when
 * automatic; target: owner's user id; data: mainSha, conflictPaths, automatic), `copy.helped`
 * (actor: the lead; target: the copy owner's user id; data: ownerName).
 */
export const PHASE7_ACTIVITY_ACTIONS = [
  'submission.merged',
  'submission.reverted',
  'copy.updated',
  'copy.helped',
] as const;

export type CopyHelper = z.infer<typeof CopyHelperSchema>;
export type CopyUpdatePreview = z.infer<typeof CopyUpdatePreviewSchema>;
export type CopyUpdateResponse = z.infer<typeof CopyUpdateResponseSchema>;
export type IdeLaunchResponse = z.infer<typeof IdeLaunchResponseSchema>;
export type CopyContainerStatus = z.infer<typeof CopyContainerStatusSchema>;
export type CopyView = z.infer<typeof CopyViewSchema>;
export type CopyResponse = z.infer<typeof CopyResponseSchema>;
