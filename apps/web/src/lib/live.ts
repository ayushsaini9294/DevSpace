import type { QueryClient, QueryKey } from '@tanstack/react-query';
import { io, type Socket } from 'socket.io-client';
import {
  InvalidateEventSchema,
  NotificationEventSchema,
  PresenceEventSchema,
  ProjectRemovedEventSchema,
  SOCKET_EVENTS,
  SOCKET_PATH,
  type ClientToServerEvents,
  type InvalidateKey,
  type PresenceView,
  type ServerToClientEvents,
} from '@devspace/shared';
import { copyKeys } from './copies';
import { setLiveConnected, useLiveStore, wantedRooms } from './liveStore';
import { addNotification, notificationKeys } from './notifications';
import { presenceKeys, replacePresence } from './presence';
import { queryKeys } from './projects';
import { repositoryKeys } from './repository';
import { submissionKeys } from './submissions';

type LiveSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

/** A query key to refresh, as a prefix (everything under it) or exactly that query. */
type Target = { queryKey: QueryKey; exact?: boolean };

/** The queries an `invalidate` key stands for, as seen by the user `myId`. */
export function targetsFor(projectId: string, key: InvalidateKey, myId: string): Target[] {
  if (key.startsWith('submission:')) {
    return [{ queryKey: submissionKeys.detail(projectId, key.slice('submission:'.length)) }];
  }
  if (key.startsWith('copy:')) {
    const userId = key.slice('copy:'.length);
    return [
      { queryKey: userId === myId ? copyKeys.mine(projectId) : copyKeys.member(projectId, userId) },
    ];
  }
  switch (key) {
    case 'submissions':
      return [{ queryKey: [...submissionKeys.all(projectId), 'list'] }];
    case 'tasks':
      return [{ queryKey: submissionKeys.tasks(projectId) }];
    case 'copy':
      // Main moved: my copy (and its changed files and update preview) and any member's copy.
      return [
        { queryKey: copyKeys.mine(projectId) },
        { queryKey: [...queryKeys.project(projectId), 'member-copy'] },
      ];
    case 'activity':
      return [{ queryKey: queryKeys.activity(projectId) }];
    case 'repository':
      return [{ queryKey: repositoryKeys.status(projectId) }];
    case 'members':
      // Members, roles and permissions, and the project itself (my role, allowed actions).
      return [
        { queryKey: queryKeys.project(projectId), exact: true },
        { queryKey: queryKeys.members(projectId) },
        { queryKey: queryKeys.invitations(projectId) },
        { queryKey: presenceKeys.list(projectId) },
      ];
    case 'presence':
      return [{ queryKey: presenceKeys.list(projectId) }];
    default:
      return [];
  }
}

function invalidate(queryClient: QueryClient, targets: Target[]) {
  for (const target of targets) void queryClient.invalidateQueries(target);
}

/**
 * Open this tab's live connection for the logged-in user `myId`: join the rooms of the projects
 * on screen (again after every reconnect), turn events into query refreshes, and record whether
 * it is connected (pages poll slowly while it is). Returns a function that closes it.
 */
export function connectLive(queryClient: QueryClient, myId: string): () => void {
  // Same origin as the app (Vite proxies /socket.io in dev), with the session cookie.
  // WebSocket only: browsers send no Origin header on same-origin polling requests, and the
  // API accepts a socket only with Origin = APP_ORIGIN (a WebSocket handshake always has one).
  const socket: LiveSocket = io({
    path: SOCKET_PATH,
    transports: ['websocket'],
    withCredentials: true,
  });
  let joined = new Set<string>();
  let everConnected = false;

  const syncRooms = () => {
    if (!socket.connected) return;
    const wanted = new Set(wantedRooms());
    for (const projectId of joined) {
      if (wanted.has(projectId)) continue;
      joined.delete(projectId);
      socket.emit(SOCKET_EVENTS.leave, { projectId });
    }
    for (const projectId of wanted) {
      if (joined.has(projectId)) continue;
      joined.add(projectId);
      // A refusal (not a member) needs no handling: the page shows that on its own.
      socket.emit(SOCKET_EVENTS.join, { projectId });
    }
  };

  socket.on('connect', () => {
    joined = new Set();
    setLiveConnected(true);
    syncRooms();
    if (everConnected) {
      // Events sent while we were away are lost: re-read what is on screen.
      void queryClient.invalidateQueries({ queryKey: notificationKeys.list });
      for (const projectId of joined) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.project(projectId) });
      }
    }
    everConnected = true;
  });

  socket.on('disconnect', () => {
    joined = new Set();
    setLiveConnected(false);
  });

  socket.on(SOCKET_EVENTS.invalidate, (payload: unknown) => {
    const parsed = InvalidateEventSchema.safeParse(payload);
    if (!parsed.success) return;
    const { projectId, keys } = parsed.data;
    for (const key of keys) invalidate(queryClient, targetsFor(projectId, key, myId));
  });

  socket.on(SOCKET_EVENTS.presence, (payload: unknown) => {
    const parsed = PresenceEventSchema.safeParse(payload);
    if (!parsed.success) return;
    const { projectId, member } = parsed.data;
    queryClient.setQueryData<PresenceView[]>(presenceKeys.list(projectId), (list) =>
      replacePresence(list, member),
    );
  });

  socket.on(SOCKET_EVENTS.notification, (payload: unknown) => {
    const parsed = NotificationEventSchema.safeParse(payload);
    if (!parsed.success) {
      // A shape this app doesn't know yet: just re-read the list.
      void queryClient.invalidateQueries({ queryKey: notificationKeys.list });
      return;
    }
    addNotification(queryClient, parsed.data.notification, parsed.data.unreadCount);
  });

  socket.on(SOCKET_EVENTS.projectRemoved, (payload: unknown) => {
    const parsed = ProjectRemovedEventSchema.safeParse(payload);
    if (!parsed.success) return;
    // Re-reading the project shows "not found"; the dashboard and team lists drop it.
    void queryClient.invalidateQueries({ queryKey: queryKeys.project(parsed.data.projectId) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.projects, exact: true });
    void queryClient.invalidateQueries({ queryKey: queryKeys.teams });
  });

  const unsubscribe = useLiveStore.subscribe((state, previous) => {
    if (state.rooms !== previous.rooms) syncRooms();
  });

  return () => {
    unsubscribe();
    socket.removeAllListeners();
    socket.disconnect();
    setLiveConnected(false);
  };
}
