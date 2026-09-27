import type { ActivityEntry } from '@devspace/shared';
import { FocusHeading, LoadError, Loading, cardStyle } from '../../components/ui';
import { describeActivity } from '../../lib/labels';
import { useActivity } from '../../lib/projects';
import { useProjectContext } from './ProjectLayout';

const fullDate = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const relative = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

/** "5 minutes ago", "yesterday"; the full date after a week. */
export function formatWhen(iso: string, now: number = Date.now()): string {
  const date = new Date(iso);
  const seconds = Math.round((date.getTime() - now) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 60) return 'just now';
  if (abs < 3600) return relative.format(Math.round(seconds / 60), 'minute');
  if (abs < 86400) return relative.format(Math.round(seconds / 3600), 'hour');
  if (abs < 7 * 86400) return relative.format(Math.round(seconds / 86400), 'day');
  return fullDate.format(date);
}

function newestFirst(entries: ActivityEntry[]): ActivityEntry[] {
  return [...entries].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

export function ActivityPage() {
  const { project } = useProjectContext();
  const activity = useActivity(project.id);

  return (
    <section aria-labelledby="activity-heading" className="space-y-4">
      <FocusHeading level={2}>
        <span id="activity-heading">Activity</span>
      </FocusHeading>
      <div className={cardStyle}>
        {activity.isPending ? (
          <Loading>Loading activity…</Loading>
        ) : activity.isError ? (
          <LoadError
            what="the activity"
            error={activity.error}
            onRetry={() => activity.refetch()}
          />
        ) : activity.data.length === 0 ? (
          <p className="text-gray-700">Nothing has happened in this project yet.</p>
        ) : (
          <ol className="divide-y divide-gray-200">
            {newestFirst(activity.data).map((entry) => (
              <li
                key={entry.id}
                className="flex flex-col gap-0.5 py-2 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4"
              >
                <span className="break-words text-gray-900">{describeActivity(entry)}</span>
                <time
                  dateTime={entry.createdAt}
                  title={fullDate.format(new Date(entry.createdAt))}
                  className="shrink-0 text-sm text-gray-600"
                >
                  {formatWhen(entry.createdAt)}
                </time>
              </li>
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}
