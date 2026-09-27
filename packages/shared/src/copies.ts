import { z } from 'zod';

/** The state of a copy's IDE container (containers arrive in Phase 5.2; until then `none`). */
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
  /**
   * Where the browser opens the IDE (`/ide/<copyId>/`, through the API), set only while
   * `containerStatus` is `running`; null otherwise (always null until Phase 5.2).
   */
  ideUrl: z.string().nullable(),
});

/**
 * GET /api/projects/:projectId/copy — any member; the caller's own copy, or null if they have
 * none yet. 404 `not_found` for non-members.
 *
 * POST /api/projects/:projectId/copy (no body) — any member; makes the caller's copy on the
 * first call (201) and returns the same copy on every later call (200).
 * 409 `repository_not_ready` unless the project's repository is ready.
 */
export const CopyResponseSchema = z.object({ copy: CopyViewSchema.nullable() });

export type CopyContainerStatus = z.infer<typeof CopyContainerStatusSchema>;
export type CopyView = z.infer<typeof CopyViewSchema>;
export type CopyResponse = z.infer<typeof CopyResponseSchema>;
