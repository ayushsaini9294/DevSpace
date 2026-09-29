import { z } from 'zod';
import { MemberPermissionsSchema, PROJECT_ACTIONS, ProjectRoleSchema } from './permissions.ts';

const NameSchema = z.string().trim().min(1, 'Enter a name').max(60, 'Use at most 60 characters');

// ---------- Teams ----------

/** POST /api/teams — 201 TeamResponse. Anyone logged in can create a team and becomes its owner. */
export const CreateTeamRequestSchema = z.object({ name: NameSchema });

export const TeamSchema = z.object({
  id: z.string(),
  name: z.string(),
  ownerId: z.string(),
  isOwner: z.boolean(),
  createdAt: z.iso.datetime(),
});

export const TeamResponseSchema = z.object({ team: TeamSchema });

/** GET /api/teams — the teams you belong to. */
export const TeamListResponseSchema = z.object({ teams: z.array(TeamSchema) });

// ---------- Projects ----------

/** Project settings chosen by the leader (blueprint v3). */
export const ProjectSettingsSchema = z.object({
  requireApproval: z.boolean(),
  membersCanBrowseCopies: z.boolean(),
  copyUpdateMode: z.enum(['automatic', 'manual']),
  githubMode: z.enum(['publish_once', 'keep_updated']),
  /** "Allow AI review (sends code to AI providers)" (Phase 10). Off by default; leaders switch it. */
  aiReviewEnabled: z.boolean(),
});
export type ProjectSettings = z.infer<typeof ProjectSettingsSchema>;

export const DEFAULT_PROJECT_SETTINGS: ProjectSettings = {
  requireApproval: true,
  membersCanBrowseCopies: false,
  copyUpdateMode: 'automatic',
  githubMode: 'publish_once',
  aiReviewEnabled: false,
};

/** A project as it appears in lists. Only projects you are a member of are ever returned. */
export const ProjectSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  teamId: z.string(),
  teamName: z.string(),
  myRole: ProjectRoleSchema,
  createdAt: z.iso.datetime(),
});

/** One project, with your role, your permissions and every action you're allowed to do. */
export const ProjectDetailSchema = ProjectSummarySchema.extend({
  settings: ProjectSettingsSchema,
  myPermissions: MemberPermissionsSchema,
  allowedActions: z.array(z.enum(PROJECT_ACTIONS)),
  memberCount: z.number().int(),
});

/** GET /api/teams/:teamId — 404 if you aren't in the team. Lists only the team's projects you're in. */
export const TeamDetailResponseSchema = z.object({
  team: TeamSchema,
  projects: z.array(ProjectSummarySchema),
});

/** POST /api/teams/:teamId/projects — 201 ProjectResponse; any team member; the creator becomes leader. */
export const CreateProjectRequestSchema = z.object({ name: NameSchema });

/** GET /api/projects — every project you're a member of, across teams. */
export const ProjectListResponseSchema = z.object({ projects: z.array(ProjectSummarySchema) });

/** GET /api/projects/:projectId (404 if not a member), and the result of create, rename, settings and transfer. */
export const ProjectResponseSchema = z.object({ project: ProjectDetailSchema });

/** PATCH /api/projects/:projectId — `project.rename`. */
export const RenameProjectRequestSchema = z.object({ name: NameSchema });

/** PATCH /api/projects/:projectId/settings — `project.updateSettings`; send only the settings that change. */
export const UpdateProjectSettingsRequestSchema = ProjectSettingsSchema.partial().refine(
  (value) => Object.keys(value).length > 0,
  'Change at least one setting',
);

/** DELETE /api/projects/:projectId — `project.delete`; the leader must type the project's exact name. 204. */
export const DeleteProjectRequestSchema = z.object({ confirmName: z.string() });

// ---------- Members ----------

export const ProjectMemberSchema = z.object({
  userId: z.string(),
  name: z.string(),
  email: z.string(),
  role: ProjectRoleSchema,
  permissions: MemberPermissionsSchema,
  joinedAt: z.iso.datetime(),
});

/** GET /api/projects/:projectId/members — any member. Leader first, then co-leaders, then members. */
export const MemberListResponseSchema = z.object({ members: z.array(ProjectMemberSchema) });

/**
 * PATCH /api/projects/:projectId/members/:userId — 200 MemberResponse.
 * `role` needs canChangeRole; `permissions` (partial) needs canSetPermissions.
 */
export const UpdateMemberRequestSchema = z
  .object({
    role: z.enum(['co_leader', 'member']).optional(),
    permissions: MemberPermissionsSchema.partial().optional(),
  })
  .refine(
    (value) => value.role !== undefined || value.permissions !== undefined,
    'Nothing to change',
  );

export const MemberResponseSchema = z.object({ member: ProjectMemberSchema });

// DELETE /api/projects/:projectId/members/:userId — 204. Your own id means leaving (canLeave);
// anyone else's needs canRemoveMember.

/** POST /api/projects/:projectId/transfer — `project.transferOwnership`; the old leader becomes a co-leader. */
export const TransferOwnershipRequestSchema = z.object({ userId: z.string() });

// ---------- Activity ----------

/** Append-only activity log entry. */
export const ActivityEntrySchema = z.object({
  id: z.string(),
  action: z.string(),
  actorId: z.string().nullable(),
  actorName: z.string().nullable(),
  target: z.string().nullable(),
  data: z.record(z.string(), z.unknown()),
  createdAt: z.iso.datetime(),
});

/** GET /api/projects/:projectId/activity — any member; newest first, at most 50. */
export const ActivityListResponseSchema = z.object({ entries: z.array(ActivityEntrySchema) });

export type Team = z.infer<typeof TeamSchema>;
export type CreateTeamRequest = z.infer<typeof CreateTeamRequestSchema>;
export type ProjectSummary = z.infer<typeof ProjectSummarySchema>;
export type ProjectDetail = z.infer<typeof ProjectDetailSchema>;
export type CreateProjectRequest = z.infer<typeof CreateProjectRequestSchema>;
export type UpdateProjectSettingsRequest = z.infer<typeof UpdateProjectSettingsRequestSchema>;
export type ProjectMember = z.infer<typeof ProjectMemberSchema>;
export type UpdateMemberRequest = z.infer<typeof UpdateMemberRequestSchema>;
export type ActivityEntry = z.infer<typeof ActivityEntrySchema>;
