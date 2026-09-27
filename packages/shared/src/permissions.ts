import { z } from 'zod';

/** Roles in a project (blueprint v3, "Roles, permissions and settings"). */
export const ProjectRoleSchema = z.enum(['leader', 'co_leader', 'member']);
export type ProjectRole = z.infer<typeof ProjectRoleSchema>;

/** Extra powers a leader switches on per member. Leaders and co-leaders always have all of them. */
export const MemberPermissionsSchema = z.object({
  approve: z.boolean(),
  comment: z.boolean(),
  createTasks: z.boolean(),
  aiReview: z.boolean(),
  publishGithub: z.boolean(),
});
export type MemberPermissions = z.infer<typeof MemberPermissionsSchema>;
export type PermissionKey = keyof MemberPermissions;

/** New members start with every extra permission off. */
export const DEFAULT_MEMBER_PERMISSIONS: MemberPermissions = {
  approve: false,
  comment: false,
  createTasks: false,
  aiReview: false,
  publishGithub: false,
};

export const PROJECT_ACTIONS = [
  // Everyone in the project
  'project.view',
  // Leader and co-leaders
  'project.rename',
  'project.updateSettings',
  'members.invite',
  'members.manage',
  'submission.merge',
  'submission.reject',
  'submission.revert',
  'copy.helpFixConflict',
  // Leader only
  'project.delete',
  'project.transferOwnership',
  'members.manageCoLeaders',
  // Leaders, or members with the matching permission
  'submission.approve',
  'submission.comment',
  'task.create',
  'ai.crossReview',
  'github.publish',
] as const;
export type ProjectAction = (typeof PROJECT_ACTIONS)[number];

const LEADS: readonly ProjectRole[] = ['leader', 'co_leader'];

const RULES: Record<ProjectAction, readonly ProjectRole[] | PermissionKey> = {
  'project.view': ['leader', 'co_leader', 'member'],
  'project.rename': LEADS,
  'project.updateSettings': LEADS,
  'members.invite': LEADS,
  'members.manage': LEADS,
  'submission.merge': LEADS,
  'submission.reject': LEADS,
  'submission.revert': LEADS,
  'copy.helpFixConflict': LEADS,
  'project.delete': ['leader'],
  'project.transferOwnership': ['leader'],
  'members.manageCoLeaders': ['leader'],
  'submission.approve': 'approve',
  'submission.comment': 'comment',
  'task.create': 'createTasks',
  'ai.crossReview': 'aiReview',
  'github.publish': 'publishGithub',
};

/**
 * The single permission check for project actions. The API enforces it; the web app uses it
 * only to show or hide controls.
 */
export function can(
  role: ProjectRole,
  permissions: MemberPermissions,
  action: ProjectAction,
): boolean {
  const rule = RULES[action];
  if (typeof rule !== 'string') return rule.includes(role);
  return LEADS.includes(role) || permissions[rule];
}

/** Every action this role and permission set allows, for API responses. */
export function allowedActions(role: ProjectRole, permissions: MemberPermissions): ProjectAction[] {
  return PROJECT_ACTIONS.filter((action) => can(role, permissions, action));
}

/** Removing someone else: the leader removes anyone but themselves; co-leaders remove members only. */
export function canRemoveMember(actor: ProjectRole, target: ProjectRole): boolean {
  if (actor === 'leader') return target !== 'leader';
  if (actor === 'co_leader') return target === 'member';
  return false;
}

/** Leaving: anyone except the leader, who must transfer ownership first. */
export function canLeave(role: ProjectRole): boolean {
  return role !== 'leader';
}

/** Promoting a member to co-leader or demoting a co-leader: leader only, never the leader's own role. */
export function canChangeRole(actor: ProjectRole, target: ProjectRole): boolean {
  return actor === 'leader' && target !== 'leader';
}

/** Switching a member's permissions: leader or co-leader, and only for members (leads have them all). */
export function canSetPermissions(actor: ProjectRole, target: ProjectRole): boolean {
  return LEADS.includes(actor) && target === 'member';
}
