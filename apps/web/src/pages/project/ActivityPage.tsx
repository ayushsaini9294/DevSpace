import type { ActivityEntry } from '@devspace/shared';
import { FocusHeading, LoadError, Loading, cardStyle } from '../../components/ui';
import { describeActivity } from '../../lib/labels';
import { useActivity } from '../../lib/projects';
import { formatWhen, fullDate } from '../../lib/time';
import { useProjectContext } from './ProjectLayout';

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
          <p className="text-gray-700">
            Nothing has happened in this project yet. Invites, submitted work, reviews and merges
            will be listed here.
          </p>
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
