import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MEMBER_PERMISSIONS,
  PROJECT_ACTIONS,
  allowedActions,
  can,
  canChangeRole,
  canLeave,
  canRemoveMember,
  canSetPermissions,
  type MemberPermissions,
  type PermissionKey,
  type ProjectAction,
  type ProjectRole,
} from './permissions.ts';

const ALL_ON: MemberPermissions = {
  approve: true,
  comment: true,
  createTasks: true,
  aiReview: true,
  publishGithub: true,
};

const LEADS_ONLY: ProjectAction[] = [
  'project.rename',
  'project.updateSettings',
  'members.invite',
  'members.manage',
  'repository.setup',
  'submission.merge',
  'submission.reject',
  'submission.revert',
  'copy.helpFixConflict',
];
const LEADER_ONLY: ProjectAction[] = [
  'project.delete',
  'project.transferOwnership',
  'members.manageCoLeaders',
];
const BY_PERMISSION: Record<PermissionKey, ProjectAction> = {
  approve: 'submission.approve',
  comment: 'submission.comment',
  createTasks: 'task.create',
  aiReview: 'ai.crossReview',
  publishGithub: 'github.publish',
};

describe('can', () => {
  it('covers every action in exactly one group', () => {
    const grouped = [
      'project.view',
      ...LEADS_ONLY,
      ...LEADER_ONLY,
      ...Object.values(BY_PERMISSION),
    ];
    expect([...grouped].sort()).toEqual([...PROJECT_ACTIONS].sort());
  });

  it('lets every role view the project', () => {
    for (const role of ['leader', 'co_leader', 'member'] as ProjectRole[]) {
      expect(can(role, DEFAULT_MEMBER_PERMISSIONS, 'project.view')).toBe(true);
    }
  });

  it.each(LEADS_ONLY)('%s: leader and co-leader yes, member never', (action) => {
    expect(can('leader', DEFAULT_MEMBER_PERMISSIONS, action)).toBe(true);
    expect(can('co_leader', DEFAULT_MEMBER_PERMISSIONS, action)).toBe(true);
    expect(can('member', ALL_ON, action)).toBe(false);
  });

  it.each(LEADER_ONLY)('%s: leader only', (action) => {
    expect(can('leader', DEFAULT_MEMBER_PERMISSIONS, action)).toBe(true);
    expect(can('co_leader', ALL_ON, action)).toBe(false);
    expect(can('member', ALL_ON, action)).toBe(false);
  });

  it.each(Object.entries(BY_PERMISSION) as [PermissionKey, ProjectAction][])(
    '%s permission controls %s for members; leads always have it',
    (key, action) => {
      expect(can('leader', DEFAULT_MEMBER_PERMISSIONS, action)).toBe(true);
      expect(can('co_leader', DEFAULT_MEMBER_PERMISSIONS, action)).toBe(true);
      expect(can('member', DEFAULT_MEMBER_PERMISSIONS, action)).toBe(false);
      expect(can('member', { ...DEFAULT_MEMBER_PERMISSIONS, [key]: true }, action)).toBe(true);
      // Switching on a different permission doesn't grant this one.
      expect(can('member', { ...ALL_ON, [key]: false }, action)).toBe(false);
    },
  );

  it('gives a new member only view', () => {
    expect(allowedActions('member', DEFAULT_MEMBER_PERMISSIONS)).toEqual(['project.view']);
  });

  it('gives the leader every action', () => {
    expect(allowedActions('leader', DEFAULT_MEMBER_PERMISSIONS)).toEqual([...PROJECT_ACTIONS]);
  });
});

describe('member management', () => {
  it('removing: leader removes anyone but the leader; co-leaders remove members only', () => {
    expect(canRemoveMember('leader', 'co_leader')).toBe(true);
    expect(canRemoveMember('leader', 'member')).toBe(true);
    expect(canRemoveMember('leader', 'leader')).toBe(false);
    expect(canRemoveMember('co_leader', 'member')).toBe(true);
    expect(canRemoveMember('co_leader', 'co_leader')).toBe(false);
    expect(canRemoveMember('co_leader', 'leader')).toBe(false);
    expect(canRemoveMember('member', 'member')).toBe(false);
  });

  it('leaving: everyone except the leader', () => {
    expect(canLeave('leader')).toBe(false);
    expect(canLeave('co_leader')).toBe(true);
    expect(canLeave('member')).toBe(true);
  });

  it('changing roles: leader only, never the leader role', () => {
    expect(canChangeRole('leader', 'member')).toBe(true);
    expect(canChangeRole('leader', 'co_leader')).toBe(true);
    expect(canChangeRole('leader', 'leader')).toBe(false);
    expect(canChangeRole('co_leader', 'member')).toBe(false);
    expect(canChangeRole('member', 'member')).toBe(false);
  });

  it('setting permissions: leads, for members only', () => {
    expect(canSetPermissions('leader', 'member')).toBe(true);
    expect(canSetPermissions('co_leader', 'member')).toBe(true);
    expect(canSetPermissions('leader', 'co_leader')).toBe(false);
    expect(canSetPermissions('member', 'member')).toBe(false);
  });
});
