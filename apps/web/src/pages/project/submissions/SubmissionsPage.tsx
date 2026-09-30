import { Link, useSearchParams } from 'react-router';
import { HelpTip } from '../../../components/HelpTip';
import {
  FocusHeading,
  LoadError,
  Loading,
  buttonStyles,
  cardStyle,
  linkStyle,
} from '../../../components/ui';
import {
  newSubmissionUrl,
  submissionUrl,
  useSubmissions,
  type SubmissionFilter,
} from '../../../lib/submissions';
import { TASK_STATUS_LABELS, taskUrl } from '../../../lib/tasks';
import { formatWhen, fullDate } from '../../../lib/time';
import { useProjectContext } from '../ProjectLayout';
import { StatusBadge } from './parts';

function plural(n: number, one: string, many: string) {
  return `${n} ${n === 1 ? one : many}`;
}

/** `/projects/:projectId/submissions`: every submission in the project, active ones by default. */
export function SubmissionsPage() {
  const { project } = useProjectContext();
  const [params, setParams] = useSearchParams();
  const filter: SubmissionFilter = params.get('status') === 'all' ? 'all' : 'active';
  const submissions = useSubmissions(project.id, filter);

  const filterButton = (value: SubmissionFilter, label: string) => (
    <button
      type="button"
      aria-pressed={filter === value}
      onClick={() => setParams(value === 'active' ? {} : { status: value }, { replace: true })}
      className={`rounded-md px-3 py-1.5 text-sm font-medium ${
        filter === value
          ? 'bg-gray-900 text-white'
          : 'border border-gray-300 bg-white text-gray-800 hover:bg-gray-100'
      }`}
    >
      {label}
    </button>
  );

  let body;
  if (submissions.isPending) {
    body = <Loading>Loading submissions…</Loading>;
  } else if (submissions.isError) {
    body = (
      <LoadError
        what="the submissions"
        error={submissions.error}
        onRetry={() => submissions.refetch()}
      />
    );
  } else if (submissions.data.length === 0) {
    body = (
      <p className={`${cardStyle} text-gray-700`}>
        {filter === 'active'
          ? 'Nothing is waiting for review. To send your own work: open the IDE from the Overview, change some files in your copy, then click Submit work.'
          : 'No submissions yet. When someone clicks Submit work, their changes show up here for review.'}
      </p>
    );
  } else {
    body = (
      <ul className="divide-y divide-gray-200 rounded-lg border border-gray-200 bg-white shadow-sm">
        {submissions.data.map((s) => (
          <li key={s.id} className="space-y-1 p-4">
            <div className="flex flex-wrap items-center gap-2">
              <Link to={submissionUrl(project.id, s.id)} className={`${linkStyle} break-words`}>
                {s.title}
              </Link>
              <StatusBadge status={s.status} />
            </div>
            <p className="text-sm text-gray-600">
              {s.author.name} · version {s.version} · {plural(s.fileCount, 'file', 'files')} ·{' '}
              {plural(s.commentCount, 'comment', 'comments')} ·{' '}
              {plural(s.approvals, 'approval', 'approvals')} · updated{' '}
              <time dateTime={s.updatedAt} title={fullDate.format(new Date(s.updatedAt))}>
                {formatWhen(s.updatedAt)}
              </time>
            </p>
            {s.task && (
              <p className="text-sm text-gray-600">
                Task:{' '}
                <Link to={taskUrl(project.id, s.task.id)} className={`${linkStyle} break-words`}>
                  {s.task.title}
                </Link>{' '}
                <span className="text-gray-500">({TASK_STATUS_LABELS[s.task.status]})</span>
              </p>
            )}
          </li>
        ))}
      </ul>
    );
  }

  return (
    <section aria-labelledby="submissions-heading" className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <FocusHeading level={2}>
            <span id="submissions-heading">Submissions</span>
          </FocusHeading>
          <HelpTip term="submit" />
        </div>
        <Link to={newSubmissionUrl(project.id)} className={buttonStyles.primary}>
          Submit work
        </Link>
      </div>
      <div role="group" aria-label="Show" className="flex gap-2">
        {filterButton('active', 'Active')}
        {filterButton('all', 'All')}
      </div>
      {body}
    </section>
  );
}
