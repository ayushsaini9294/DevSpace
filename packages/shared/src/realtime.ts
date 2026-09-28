import { z } from 'zod';
import { NotificationViewSchema } from './notifications.ts';
import { PresenceViewSchema } from './presence.ts';

/**
 * Live updates (Phase 9): Socket.io on the main API origin, path `/socket.io` (proxied by Vite
 * in dev like /api). The handshake needs the app's session cookie and `Origin` = APP_ORIGIN;
 * otherwise it fails with a connect_error whose message is `unauthenticated` or
 * `forbidden_origin`. Every socket is in `user:<id>` (its own notifications).
 *
 * Events carry no private data, only what changed: the app reloads that data through the
 * normal API (and its permission checks).
 */

export const SOCKET_PATH = '/socket.io';

// ---------- Client → server ----------

/**
 * `project:join` { projectId } with an ack callback → { ok: true } or { ok: false, error }
 * (`not_found` when you aren't a member, `validation_error` for a bad body). Join the open
 * project's room; join again after a reconnect. `project:leave` { projectId } (ack optional,
 * always { ok: true }). Removing a member or deleting the project removes their sockets from
 * the room at once.
 */
export const ProjectRoomRequestSchema = z.object({ projectId: z.string().min(1).max(100) });

export const ProjectJoinAckSchema = z.union([
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);

// ---------- Server → client ----------

/**
 * What to reload:
 * - `submissions`: the submission list; `submission:<id>`: that submission
 * - `tasks`: the task board
 * - `copy`: every member's own copy (main moved, so `behind` may change: refetch GET /copy);
 *   `copy:<userId>`: that member's copy (refetch GET /copy if it's you, or the lead's view of it)
 * - `activity`, `repository`, `members` (members, roles, permissions, and the project itself),
 *   `presence` (refetch the whole presence list)
 */
export const InvalidateKeySchema = z.union([
  z.enum(['submissions', 'tasks', 'copy', 'activity', 'repository', 'members', 'presence']),
  z.templateLiteral(['submission:', z.string().min(1)]),
  z.templateLiteral(['copy:', z.string().min(1)]),
]);

/** Event `invalidate`, to `project:<id>`. */
export const InvalidateEventSchema = z.object({
  projectId: z.string(),
  keys: z.array(InvalidateKeySchema).min(1),
});

/** Event `presence`, to `project:<id>`: one member's presence changed (replace it in place). */
export const PresenceEventSchema = z.object({
  projectId: z.string(),
  member: PresenceViewSchema,
});

/** Event `notification`, to `user:<id>` only: a new notification and your new unread count. */
export const NotificationEventSchema = z.object({
  notification: NotificationViewSchema,
  unreadCount: z.number().int().nonnegative(),
});

/** Event `project:removed`, to the removed member's `user:<id>`: you left or lost this project. */
export const ProjectRemovedEventSchema = z.object({ projectId: z.string() });

export const SOCKET_EVENTS = {
  join: 'project:join',
  leave: 'project:leave',
  invalidate: 'invalidate',
  presence: 'presence',
  notification: 'notification',
  projectRemoved: 'project:removed',
} as const;

export type InvalidateKey = z.infer<typeof InvalidateKeySchema>;
export type InvalidateEvent = z.infer<typeof InvalidateEventSchema>;
export type PresenceEvent = z.infer<typeof PresenceEventSchema>;
export type NotificationEvent = z.infer<typeof NotificationEventSchema>;
export type ProjectRemovedEvent = z.infer<typeof ProjectRemovedEventSchema>;
export type ProjectRoomRequest = z.infer<typeof ProjectRoomRequestSchema>;
export type ProjectJoinAck = z.infer<typeof ProjectJoinAckSchema>;

/** Typed Socket.io event maps (usable with `Socket<ServerToClientEvents, ClientToServerEvents>`). */
export interface ServerToClientEvents {
  invalidate: (event: InvalidateEvent) => void;
  presence: (event: PresenceEvent) => void;
  notification: (event: NotificationEvent) => void;
  'project:removed': (event: ProjectRemovedEvent) => void;
}

export interface ClientToServerEvents {
  'project:join': (request: ProjectRoomRequest, ack?: (answer: ProjectJoinAck) => void) => void;
  'project:leave': (request: ProjectRoomRequest, ack?: (answer: ProjectJoinAck) => void) => void;
}
