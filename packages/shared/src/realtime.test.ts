import { describe, expect, it } from 'vitest';
import {
  MarkNotificationsReadRequestSchema,
  NOTIFICATION_TYPES,
  NotificationDataSchemas,
  NotificationViewSchema,
} from './notifications.ts';
import { PresenceReportSchema, PresenceViewSchema } from './presence.ts';
import { InvalidateEventSchema, InvalidateKeySchema } from './realtime.ts';

const base = {
  id: 'n1',
  project: { id: 'p1', name: 'P' },
  readAt: null,
  createdAt: '2026-09-28T12:00:00.000Z',
};

describe('NotificationViewSchema', () => {
  it('has a data schema for every type', () => {
    expect(Object.keys(NotificationDataSchemas).sort()).toEqual([...NOTIFICATION_TYPES].sort());
  });

  it('checks data per type', () => {
    const ok = {
      ...base,
      type: 'submission.reviewed',
      data: { submissionId: 's', title: 'T', actorName: 'A', decision: 'approved' },
    };
    expect(NotificationViewSchema.parse(ok)).toEqual(ok);
    expect(
      NotificationViewSchema.safeParse({ ...ok, data: { ...ok.data, decision: 'maybe' } }).success,
    ).toBe(false);
    expect(NotificationViewSchema.safeParse({ ...ok, type: 'task.assigned' }).success).toBe(false);
    expect(NotificationViewSchema.safeParse({ ...ok, type: 'nope' }).success).toBe(false);
  });
});

describe('MarkNotificationsReadRequestSchema', () => {
  it('takes ids or all, not both', () => {
    expect(MarkNotificationsReadRequestSchema.safeParse({ ids: ['a'] }).success).toBe(true);
    expect(MarkNotificationsReadRequestSchema.safeParse({ all: true }).success).toBe(true);
    for (const bad of [{}, { ids: [] }, { all: false }, { all: true, ids: ['a'] }]) {
      expect(MarkNotificationsReadRequestSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(
        false,
      );
    }
  });
});

describe('presence schemas', () => {
  it('stores an unsafe file as null instead of refusing the report', () => {
    expect(PresenceReportSchema.parse({ file: '../x', active: true })).toEqual({
      file: null,
      active: true,
    });
    expect(PresenceReportSchema.parse({ file: 'src/a.ts', active: false }).file).toBe('src/a.ts');
    expect(PresenceReportSchema.safeParse({ file: 'a', active: 'yes' }).success).toBe(false);
  });

  it('describes a member', () => {
    const view = {
      user: { id: 'u', name: 'U' },
      state: 'active',
      file: 'a.ts',
      copyOwner: null,
      lastSeenAt: null,
    };
    expect(PresenceViewSchema.parse(view)).toEqual(view);
    expect(PresenceViewSchema.safeParse({ ...view, state: 'away' }).success).toBe(false);
  });
});

describe('invalidate keys', () => {
  it('accepts only the listed keys', () => {
    for (const key of ['submissions', 'submission:abc', 'tasks', 'copy', 'copy:u1', 'presence']) {
      expect(InvalidateKeySchema.safeParse(key).success, key).toBe(true);
    }
    for (const key of ['files', 'submission:', 'copy:', 'secret data']) {
      expect(InvalidateKeySchema.safeParse(key).success, key).toBe(false);
    }
    expect(InvalidateEventSchema.safeParse({ projectId: 'p', keys: [] }).success).toBe(false);
  });
});
