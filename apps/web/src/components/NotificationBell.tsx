import { useId } from 'react';
import { Link } from 'react-router';
import type { NotificationView } from '@devspace/shared';
import { errorMessage } from '../lib/formErrors';
import {
  allNotifications,
  describeNotification,
  formatCount,
  notificationUrl,
  unreadCountOf,
  useMarkNotificationsRead,
  useNotifications,
} from '../lib/notifications';
import { formatWhen, fullDate } from '../lib/time';
import { FormAlert } from './AuthPageShell';
import { buttonStyles, linkStyle } from './ui';
import { popoverPanel, usePopover } from './usePopover';

function BellIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" fill="currentColor" className="h-5 w-5">
      <path d="M10 2a5 5 0 0 0-5 5v2.6c0 .5-.2 1-.5 1.4L3.3 12.6A1 1 0 0 0 4.1 14h11.8a1 1 0 0 0 .8-1.4L15.5 11a2.3 2.3 0 0 1-.5-1.4V7a5 5 0 0 0-5-5Zm0 16a2.5 2.5 0 0 0 2.4-2h-4.8A2.5 2.5 0 0 0 10 18Z" />
    </svg>
  );
}

function Item({ n, onOpen }: { n: NotificationView; onOpen: (n: NotificationView) => void }) {
  const url = notificationUrl(n);
  const text = describeNotification(n);
  const unread = n.readAt === null;
  return (
    <li
      data-unread={unread ? 'true' : 'false'}
      className={`space-y-0.5 px-4 py-2.5 text-sm ${unread ? 'bg-blue-50' : ''}`}
    >
      <p className="break-words text-gray-900">
        {unread && <span className="sr-only">Unread: </span>}
        {url ? (
          <Link to={url} className="hover:underline" onClick={() => onOpen(n)}>
            {text}
          </Link>
        ) : (
          text
        )}
      </p>
      <p className="text-xs text-gray-600">
        {n.project ? <span className="break-words">{n.project.name} · </span> : null}
        <time dateTime={n.createdAt} title={fullDate.format(new Date(n.createdAt))}>
          {formatWhen(n.createdAt)}
        </time>
      </p>
    </li>
  );
}

/** The bell in the top bar: unread count, and my latest notifications in a dropdown. */
export function NotificationBell() {
  const { buttonRef, close, open, rootRef, toggle } = usePopover();
  const notifications = useNotifications(true);
  const markRead = useMarkNotificationsRead();
  const panelId = useId();
  const countId = useId();
  const headingId = useId();

  const unread = unreadCountOf(notifications.data);
  const list = allNotifications(notifications.data);

  const openNotification = (n: NotificationView) => {
    close();
    if (n.readAt === null) markRead.mutate({ ids: [n.id] });
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        aria-label="Notifications"
        aria-describedby={unread > 0 ? countId : undefined}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={toggle}
        className="relative rounded-md p-1.5 text-gray-700 hover:bg-gray-100 hover:text-gray-900 focus-visible:ring-2 focus-visible:ring-blue-300 focus-visible:outline-none"
      >
        <BellIcon />
        {unread > 0 && (
          <span
            data-testid="notification-count"
            aria-hidden="true"
            className="absolute -top-1 -right-1 min-w-[1.25rem] rounded-full bg-red-700 px-1 text-center text-xs leading-5 font-semibold text-white"
          >
            {formatCount(unread)}
          </span>
        )}
      </button>
      <span id={countId} className="sr-only">
        {unread === 1 ? '1 unread' : `${unread} unread`}
      </span>
      {open && (
        <div
          id={panelId}
          role="region"
          aria-labelledby={headingId}
          className={`${popoverPanel} flex max-h-[70vh] flex-col`}
        >
          <div className="flex items-center justify-between gap-2 border-b border-gray-200 px-4 py-2">
            <h2 id={headingId} className="font-semibold">
              Notifications
            </h2>
            <button
              type="button"
              disabled={unread === 0 || markRead.isPending}
              onClick={() => markRead.mutate({ all: true })}
              className={`${buttonStyles.secondary} px-2 py-1 text-xs`}
            >
              Mark all read
            </button>
          </div>
          {markRead.isError && (
            <div className="px-4 pt-2">
              <FormAlert>Could not mark as read. {errorMessage(markRead.error)}</FormAlert>
            </div>
          )}
          <div className="min-h-0 overflow-y-auto">
            {notifications.isPending ? (
              <p role="status" className="px-4 py-3 text-sm text-gray-600">
                Loading notifications…
              </p>
            ) : notifications.isError && list.length === 0 ? (
              <div className="space-y-2 px-4 py-3">
                <FormAlert>
                  Could not load notifications. {errorMessage(notifications.error)}
                </FormAlert>
                <button
                  type="button"
                  className={buttonStyles.secondary}
                  onClick={() => notifications.refetch()}
                >
                  Try again
                </button>
              </div>
            ) : list.length === 0 ? (
              <p className="px-4 py-3 text-sm text-gray-700">No notifications yet.</p>
            ) : (
              <ul aria-label="Notifications" className="divide-y divide-gray-100">
                {list.map((n) => (
                  <Item key={n.id} n={n} onOpen={openNotification} />
                ))}
              </ul>
            )}
            {notifications.hasNextPage && (
              <div className="border-t border-gray-100 px-4 py-2">
                <button
                  type="button"
                  disabled={notifications.isFetchingNextPage}
                  onClick={() => notifications.fetchNextPage()}
                  className={`${linkStyle} text-sm disabled:opacity-60`}
                >
                  {notifications.isFetchingNextPage ? 'Loading…' : 'Show older'}
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
