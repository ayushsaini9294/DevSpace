import { z } from 'zod';

export const INVITATION_TTL_DAYS = 7;

/**
 * POST /api/projects/:projectId/invitations — `members.invite`. 201 CreateInvitationResponse.
 * Re-inviting an email with a pending invitation replaces it (the old link stops working).
 * 409 `already_member` if that email already belongs to a project member.
 */
export const CreateInvitationRequestSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email().max(254)),
});

export const InvitationSchema = z.object({
  id: z.string(),
  email: z.string(),
  invitedByName: z.string(),
  expiresAt: z.iso.datetime(),
  createdAt: z.iso.datetime(),
});

/**
 * `path` is `/invite/<token>`; the web app turns it into a full link to copy. The token is
 * returned only here, once; the database stores only its hash.
 */
export const CreateInvitationResponseSchema = z.object({
  invitation: InvitationSchema,
  path: z.string(),
});

/** GET /api/projects/:projectId/invitations — `members.invite`; pending and unexpired only. */
export const InvitationListResponseSchema = z.object({ invitations: z.array(InvitationSchema) });

// DELETE /api/projects/:projectId/invitations/:invitationId — `members.invite`. 204.

/**
 * GET /api/invitations/:token — logged in. 200 preview, or 404 `not_found` (unknown or
 * cancelled), 410 `invitation_expired`, 409 `invitation_used`.
 * `matchesYou` is false when you're logged in with a different email than the invited one.
 */
export const InvitationPreviewResponseSchema = z.object({
  projectName: z.string(),
  teamName: z.string(),
  invitedByName: z.string(),
  email: z.string(),
  expiresAt: z.iso.datetime(),
  matchesYou: z.boolean(),
});

/**
 * POST /api/invitations/:token/accept — logged in with the invited email. 200 { projectId }.
 * Joins as a member (every extra permission off) and adds you to the team.
 * Errors as for the preview, plus 403 `wrong_account` and 409 `already_member`.
 */
export const AcceptInvitationResponseSchema = z.object({ projectId: z.string() });

export type CreateInvitationRequest = z.infer<typeof CreateInvitationRequestSchema>;
export type Invitation = z.infer<typeof InvitationSchema>;
export type InvitationPreviewResponse = z.infer<typeof InvitationPreviewResponseSchema>;
