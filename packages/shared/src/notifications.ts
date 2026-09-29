import { z } from 'zod';
import { ProjectRoleSchema } from './permissions.ts';

/**
 * In-app notifications (Phase 9). Created in the same transaction as the change, pushed after
 * it commits (socket event `notification` to `user:<id>`), never sent to the person who did it.
 * Kept 30 days. Every `data` carries only what the bell needs to show and link; names are
 * captured when the notification is made.
 *
 * Types and recipients:
 * - `submission.opened` → leaders, co-leaders and members with Approve, except the author
 * - `submission.reviewed` → the author
 * - `submission.commented` (also suggestions) → the author, plus the parent comment's author
 *   for a reply
 * - `submission.merged`, `submission.rejected`, `submission.reverted`, `submission.needs_update`
 *   → the author
 * - `task.assigned` → newly added assignees
 * - `task.confirm_done` → leaders and co-leaders
 * - `task.reopened` → the task's assignees
 * - `copy.helped`, `copy.update_conflicts`, `copy.packages_changed` → the copy's owner
 * - `member.role_changed`, `member.permissions_changed` → that member
 * - `invitation.accepted` → leaders and co-leaders
 * - `ai_review.finished` → whoever asked for the cross-review, once all its models finished
 *   (Phase 10; link: the submission)
 *
 * Links (web): submission types → /projects/:projectId/submissions/:submissionId; task types →
 * /projects/:projectId/tasks; copy types → /projects/:projectId/ide (or the overview); member
 * and invitation types → /projects/:projectId/members.
 */

export const NOTIFICATIONS_PAGE_SIZE = 30;
export const NOTIFICATION_RETENTION_DAYS = 30;

/** Paths listed in a notification's data are capped at this many (the rest is `morePaths`). */
export const MAX_NOTIFICATION_PATHS = 20;

export const NOTIFICATION_TYPES = [
  'submission.opened',
  'submission.reviewed',
  'submission.commented',
  'submission.merged',
  'submission.rejected',
  'submission.reverted',
  'submission.needs_update',
  'task.assigned',
  'task.confirm_done',
  'task.reopened',
  'copy.helped',
  'copy.update_conflicts',
  'copy.packages_changed',
  'member.role_changed',
  'member.permissions_changed',
  'invitation.accepted',
  'ai_review.finished',
] as const;

export const NotificationTypeSchema = z.enum(NOTIFICATION_TYPES);

/** Who did it, as a name captured at the time (null for automatic changes). */
const ActorName = z.string().nullable();

const SubmissionRef = { submissionId: z.string(), title: z.string() };
const TaskRef = { taskId: z.string(), title: z.string() };
const Paths = { paths: z.array(z.string()), morePaths: z.number().int().nonnegative() };

/** `data` for each type. */
export const NotificationDataSchemas = {
  'submission.opened': z.object({ ...SubmissionRef, actorName: ActorName }),
  'submission.reviewed': z.object({
    ...SubmissionRef,
    actorName: ActorName,
    decision: z.enum(['approved', 'changes_requested']),
  }),
  'submission.commented': z.object({
    ...SubmissionRef,
    actorName: ActorName,
    commentId: z.string(),
    /** A reply to one of your comments (rather than a comment on your submission). */
    reply: z.boolean(),
    suggestion: z.boolean(),
  }),
  'submission.merged': z.object({ ...SubmissionRef, actorName: ActorName }),
  'submission.rejected': z.object({ ...SubmissionRef, actorName: ActorName, reason: z.string() }),
  'submission.reverted': z.object({ ...SubmissionRef, actorName: ActorName }),
  'submission.needs_update': z.object({ ...SubmissionRef, ...Paths }),
  'task.assigned': z.object({ ...TaskRef, actorName: ActorName }),
  'task.confirm_done': z.object({ ...TaskRef, submissionId: z.string() }),
  'task.reopened': z.object({ ...TaskRef, submissionId: z.string(), note: z.string() }),
  'copy.helped': z.object({ actorName: ActorName }),
  'copy.update_conflicts': z.object({ ...Paths }),
  'copy.packages_changed': z.object({ ...Paths }),
  'member.role_changed': z.object({ actorName: ActorName, role: ProjectRoleSchema }),
  'member.permissions_changed': z.object({ actorName: ActorName }),
  'invitation.accepted': z.object({ userId: z.string(), userName: z.string() }),
  'ai_review.finished': z.object({
    ...SubmissionRef,
    /** Reviews of this request that finished with findings, and that failed. */
    done: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    /** Findings across the done reviews. */
    findingCount: z.number().int().nonnegative(),
  }),
} as const satisfies Record<NotificationType, z.ZodType>;

const Base = {
  id: z.string(),
  /** The project it is about (null only if the project was deleted since). */
  project: z.object({ id: z.string(), name: z.string() }).nullable(),
  readAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
};

function variant<T extends NotificationType>(type: T) {
  return z.object({ ...Base, type: z.literal(type), data: NotificationDataSchemas[type] });
}

/** One notification. Switch on `type` to read `data`. */
export const NotificationViewSchema = z.discriminatedUnion('type', [
  variant('submission.opened'),
  variant('submission.reviewed'),
  variant('submission.commented'),
  variant('submission.merged'),
  variant('submission.rejected'),
  variant('submission.reverted'),
  variant('submission.needs_update'),
  variant('task.assigned'),
  variant('task.confirm_done'),
  variant('task.reopened'),
  variant('copy.helped'),
  variant('copy.update_conflicts'),
  variant('copy.packages_changed'),
  variant('member.role_changed'),
  variant('member.permissions_changed'),
  variant('invitation.accepted'),
  variant('ai_review.finished'),
]);

/** GET /api/notifications?cursor= — query. `cursor` is the previous page's `nextCursor`. */
export const NotificationListQuerySchema = z.object({
  cursor: z.string().min(1).max(200).optional(),
});

/**
 * GET /api/notifications → your own notifications, newest first, 30 per page. `nextCursor` is
 * null on the last page. `unreadCount` counts all your unread ones. 400 `validation_error` for
 * a malformed cursor.
 */
export const NotificationListResponseSchema = z.object({
  notifications: z.array(NotificationViewSchema),
  unreadCount: z.number().int().nonnegative(),
  nextCursor: z.string().nullable(),
});

/**
 * POST /api/notifications/read — `{ ids }` (1–100 of your own; unknown or others' ids are
 * ignored) or `{ all: true }` → { unreadCount }.
 */
export const MarkNotificationsReadRequestSchema = z.union([
  z.object({ ids: z.array(z.string().min(1).max(100)).min(1).max(100) }).strict(),
  z.object({ all: z.literal(true) }).strict(),
]);

export const MarkNotificationsReadResponseSchema = z.object({
  unreadCount: z.number().int().nonnegative(),
});

export type NotificationType = (typeof NOTIFICATION_TYPES)[number];
export type NotificationData<T extends NotificationType = NotificationType> = z.infer<
  (typeof NotificationDataSchemas)[T]
>;
export type NotificationView = z.infer<typeof NotificationViewSchema>;
export type NotificationListQuery = z.infer<typeof NotificationListQuerySchema>;
export type NotificationListResponse = z.infer<typeof NotificationListResponseSchema>;
export type MarkNotificationsReadRequest = z.infer<typeof MarkNotificationsReadRequestSchema>;
export type MarkNotificationsReadResponse = z.infer<typeof MarkNotificationsReadResponseSchema>;
