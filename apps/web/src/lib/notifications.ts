import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
  type InfiniteData,
  type QueryClient,
} from '@tanstack/react-query';
import {
  MarkNotificationsReadResponseSchema,
  NotificationListResponseSchema,
  type MarkNotificationsReadRequest,
  type NotificationListResponse,
  type NotificationView,
} from '@devspace/shared';
import { apiFetch, apiPost } from './api';
import { ROLE_LABELS } from './labels';
import { usePollInterval } from './liveStore';
import { taskUrl } from './tasks';

const enc = encodeURIComponent;

/** Without a live connection, the bell re-reads this often (60 s with one). */
export const NOTIFICATIONS_REFRESH_MS = 30_000;

export const notificationKeys = { list: ['notifications'] as const };

type Pages = InfiniteData<NotificationListResponse>;

/** My notifications, newest first, 30 per page; the first page carries the unread count. */
export function useNotifications(enabled: boolean) {
  const interval = usePollInterval(NOTIFICATIONS_REFRESH_MS);
  return useInfiniteQuery({
    queryKey: notificationKeys.list,
    queryFn: async ({ pageParam }) =>
      NotificationListResponseSchema.parse(
        await apiFetch(
          pageParam === null ? '/api/notifications' : `/api/notifications?cursor=${enc(pageParam)}`,
        ),
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    enabled,
    refetchInterval: (query) => (query.state.status === 'error' ? false : interval),
  });
}

/** Every loaded notification, once each (a new one may shift into the next page). */
export function allNotifications(data: Pages | undefined): NotificationView[] {
  const seen = new Set<string>();
  const out: NotificationView[] = [];
  for (const page of data?.pages ?? []) {
    for (const n of page.notifications) {
      if (seen.has(n.id)) continue;
      seen.add(n.id);
      out.push(n);
    }
  }
  return out;
}

export function unreadCountOf(data: Pages | undefined): number {
  return data?.pages[0]?.unreadCount ?? 0;
}

/** A `notification` event: put it first and take the new unread count. */
export function addNotification(
  queryClient: QueryClient,
  notification: NotificationView,
  unreadCount: number,
) {
  queryClient.setQueryData<Pages>(notificationKeys.list, (data) => {
    if (!data?.pages[0]) return data;
    const [first, ...rest] = data.pages;
    const others = first.notifications.filter((n) => n.id !== notification.id);
    return {
      ...data,
      pages: [{ ...first, notifications: [notification, ...others], unreadCount }, ...rest],
    };
  });
}

/** Mark notifications read (some ids, or all), then keep the list in step with the answer. */
export function useMarkNotificationsRead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (request: MarkNotificationsReadRequest) =>
      MarkNotificationsReadResponseSchema.parse(await apiPost('/api/notifications/read', request))
        .unreadCount,
    onSuccess: (unreadCount, request) => {
      const now = new Date().toISOString();
      const ids = 'ids' in request ? new Set(request.ids) : null;
      queryClient.setQueryData<Pages>(notificationKeys.list, (data) => {
        if (!data) return data;
        return {
          ...data,
          pages: data.pages.map((page, i) => ({
            ...page,
            unreadCount: i === 0 ? unreadCount : page.unreadCount,
            notifications: page.notifications.map((n) =>
              n.readAt === null && (ids === null || ids.has(n.id)) ? { ...n, readAt: now } : n,
            ),
          })),
        };
      });
    },
  });
}

// ---------- Display ----------

function quoted(title: string): string {
  return `“${title}”`;
}

function moreFiles(paths: string[], morePaths: number): string {
  const n = paths.length + morePaths;
  return n === 1 ? '1 file' : `${n} files`;
}

/** One plain-text sentence for a notification (names and titles are shown as text only). */
export function describeNotification(n: NotificationView): string {
  switch (n.type) {
    case 'submission.opened':
      return `${n.data.actorName ?? 'Someone'} submitted ${quoted(n.data.title)} for review`;
    case 'submission.reviewed': {
      const who = n.data.actorName ?? 'Someone';
      return n.data.decision === 'approved'
        ? `${who} approved your submission ${quoted(n.data.title)}`
        : `${who} requested changes on your submission ${quoted(n.data.title)}`;
    }
    case 'submission.commented': {
      const who = n.data.actorName ?? 'Someone';
      if (n.data.reply) return `${who} replied to your comment on ${quoted(n.data.title)}`;
      if (n.data.suggestion) {
        return `${who} suggested a change on your submission ${quoted(n.data.title)}`;
      }
      return `${who} commented on your submission ${quoted(n.data.title)}`;
    }
    case 'submission.merged':
      return `${n.data.actorName ?? 'Someone'} merged your submission ${quoted(n.data.title)} into main`;
    case 'submission.rejected':
      return `${n.data.actorName ?? 'Someone'} rejected your submission ${quoted(n.data.title)}: ${n.data.reason}`;
    case 'submission.reverted':
      return `${n.data.actorName ?? 'Someone'} undid the merge of your submission ${quoted(n.data.title)}`;
    case 'submission.needs_update':
      return `Your submission ${quoted(n.data.title)} needs an update: it now clashes with main in ${moreFiles(n.data.paths, n.data.morePaths)}`;
    case 'task.assigned':
      return `${n.data.actorName ?? 'Someone'} assigned you the task ${quoted(n.data.title)}`;
    case 'task.confirm_done':
      return `Work for the task ${quoted(n.data.title)} was merged. Is the task done?`;
    case 'task.reopened':
      return `The task ${quoted(n.data.title)} was reopened because its merge was undone`;
    case 'copy.helped':
      return `${n.data.actorName ?? 'A leader'} opened your copy to help you`;
    case 'copy.update_conflicts':
      return `Main has changed, but your copy wasn’t updated automatically: ${moreFiles(n.data.paths, n.data.morePaths)} would clash`;
    case 'copy.packages_changed':
      return 'Packages changed in main: run npm install in the terminal';
    case 'member.role_changed':
      return `${n.data.actorName ?? 'Someone'} changed your role to ${ROLE_LABELS[n.data.role]}`;
    case 'member.permissions_changed':
      return `${n.data.actorName ?? 'Someone'} changed your permissions`;
    case 'invitation.accepted':
      return `${n.data.userName} accepted an invitation and joined`;
    case 'ai_review.finished': {
      const { done, failed, findingCount } = n.data;
      if (done === 0) return `The AI review of ${quoted(n.data.title)} failed`;
      const found =
        findingCount === 0
          ? 'no findings'
          : findingCount === 1
            ? '1 finding'
            : `${findingCount} findings`;
      const failures =
        failed === 0 ? '' : failed === 1 ? ' (1 model failed)' : ` (${failed} models failed)`;
      return `The AI review of ${quoted(n.data.title)} finished: ${found}${failures}`;
    }
  }
}

/** Where a notification leads, or null when its project is gone. */
export function notificationUrl(n: NotificationView): string | null {
  if (!n.project) return null;
  const base = `/projects/${enc(n.project.id)}`;
  switch (n.type) {
    case 'submission.opened':
    case 'submission.reviewed':
    case 'submission.commented':
    case 'submission.merged':
    case 'submission.rejected':
    case 'submission.reverted':
    case 'submission.needs_update':
    case 'ai_review.finished':
      return `${base}/submissions/${enc(n.data.submissionId)}`;
    case 'task.assigned':
    case 'task.confirm_done':
    case 'task.reopened':
      return taskUrl(enc(n.project.id), n.data.taskId);
    case 'copy.helped':
    case 'copy.update_conflicts':
    case 'copy.packages_changed':
      // The overview shows who opened my copy, the update panel and the npm reminder.
      return base;
    case 'member.role_changed':
    case 'member.permissions_changed':
    case 'invitation.accepted':
      return `${base}/members`;
  }
}

/** "99+" above 99. */
export function formatCount(count: number): string {
  return count > 99 ? '99+' : String(count);
}
