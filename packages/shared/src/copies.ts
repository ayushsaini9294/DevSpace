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
export const CopyViewSchema = z.object({
  id: z.uuid(),
  branchName: z.string(),
  containerStatus: CopyContainerStatusSchema,
  createdAt: z.iso.datetime(),
  lastActiveAt: z.iso.datetime().nullable(),
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

export type IdeLaunchResponse = z.infer<typeof IdeLaunchResponseSchema>;
export type CopyContainerStatus = z.infer<typeof CopyContainerStatusSchema>;
export type CopyView = z.infer<typeof CopyViewSchema>;
export type CopyResponse = z.infer<typeof CopyResponseSchema>;
