import { Link } from 'react-router';
import type { MergeBlocker, SubmissionDetail } from '@devspace/shared';
import { HelpTip } from '../../../components/HelpTip';
import { buttonStyles, linkStyle } from '../../../components/ui';
import { idePageUrl, useMyCopy } from '../../../lib/copies';
import { errorCode } from '../../../lib/formErrors';
import {
  can,
  errorDetails,
  submissionErrorMessage,
  useMergeSubmission,
  useRevertSubmission,
} from '../../../lib/submissions';
import { formatWhen, fullDate } from '../../../lib/time';
import { CopyUpdates } from '../CopyUpdates';
import { Dialog } from './parts';

function When({ iso }: { iso: string }) {
  return (
    <time dateTime={iso} title={fullDate.format(new Date(iso))}>
      {formatWhen(iso)}
    </time>
  );
}

const shortSha = (sha: string) => sha.slice(0, 7);

const BLOCKER_TEXT: Record<Exclude<MergeBlocker, 'not_active'>, string> = {
  needs_update:
    'Can’t merge yet: this submission clashes with main. Its author needs to update their copy and the submission.',
  approval_required:
    'Can’t merge yet: this project needs an approval first, with no open request for changes.',
};

/** For leads who can't merge an active submission right now: why, in words. */
export function MergeBlockerNote({
  projectId,
  submission,
  isLead,
}: {
  projectId: string;
  submission: SubmissionDetail;
  isLead: boolean;
}) {
  const blocker = submission.mergeBlocker;
  if (!isLead || blocker === null || blocker === 'not_active') return null;
  if (blocker === 'approval_required') {
    const base = `/projects/${projectId}`;
    return (
      <div className="space-y-1 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950">
        <p>{BLOCKER_TEXT[blocker]}</p>
        <p>
          Someone other than the author must approve it, because nobody can approve their own work.
          Ask a teammate who has the Approve permission (
          <Link to={`${base}/members`} className={linkStyle}>
            Members
          </Link>
          ), or switch off “Require approval before merge” in{' '}
          <Link to={`${base}/settings`} className={linkStyle}>
            Settings
          </Link>{' '}
          if you work alone.
        </p>
      </div>
    );
  }
  return (
    <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950">
      {BLOCKER_TEXT[blocker]}
    </p>
  );
}

export function MergeDialog({
  projectId,
  submission,
  onClose,
}: {
  projectId: string;
  submission: SubmissionDetail;
  onClose: () => void;
}) {
  const merge = useMergeSubmission(projectId, submission.id);
  return (
    <Dialog
      title="Merge into main"
      confirmLabel="Merge into main"
      pending={merge.isPending}
      error={merge.isError ? submissionErrorMessage(merge.error) : null}
      onClose={onClose}
      onSubmit={() => merge.mutate(undefined, { onSuccess: onClose })}
    >
      <p className="text-sm text-gray-700">
        Version {submission.version} is added to main (the team’s shared version) as one change,
        credited to {submission.author.name}. Everyone’s copies then get it, either automatically or
        when they click Update my copy. You can undo it later with Undo merge.
      </p>
    </Dialog>
  );
}

export function RevertDialog({
  projectId,
  submission,
  onClose,
}: {
  projectId: string;
  submission: SubmissionDetail;
  onClose: () => void;
}) {
  const revert = useRevertSubmission(projectId, submission.id);
  const conflict = revert.isError && errorCode(revert.error) === 'revert_conflict';
  const paths = conflict ? errorDetails(revert.error).paths : [];
  return (
    <Dialog
      title="Undo this merge"
      confirmLabel="Undo merge"
      confirmStyle={buttonStyles.danger}
      pending={revert.isPending}
      error={revert.isError && !conflict ? submissionErrorMessage(revert.error) : null}
      onClose={onClose}
      onSubmit={() => revert.mutate(undefined, { onSuccess: onClose })}
    >
      <p className="text-sm text-gray-700">
        This takes this merge’s changes back out of main. {submission.author.name}’s files stay as
        they are in their copy, so they can fix the work and submit it again.
      </p>
      {conflict && (
        <div
          role="alert"
          className="space-y-1 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800"
        >
          <p>
            This merge can’t be undone: later merges changed the same lines. Main was not changed.
            {paths.length > 0 && ' The files:'}
          </p>
          {paths.length > 0 && (
            <ul aria-label="Files changed again since the merge" className="list-inside list-disc">
              {paths.map((path) => (
                <li key={path} className="font-mono break-all">
                  {path}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Dialog>
  );
}

/** "Merged by X into main" and, after an undo, "Merge undone by Y". */
export function MergeInfo({ submission }: { submission: SubmissionDetail }) {
  const { mergedBy, mergedAt, mergedSha, revertedBy, revertedAt, revertedSha } = submission;
  if (!mergedBy || !mergedAt) return null;
  const reverted = submission.status === 'reverted';
  return (
    <div
      className={`space-y-1 rounded-md border px-3 py-2 text-sm ${
        reverted
          ? 'border-gray-300 bg-gray-50 text-gray-800'
          : 'border-purple-200 bg-purple-50 text-purple-950'
      }`}
    >
      <p>
        <span>Merged by {mergedBy.name} into main</span> <When iso={mergedAt} />
        {mergedSha && (
          <>
            {' '}
            <span className="text-xs text-gray-500">
              (id <code className="font-mono">{shortSha(mergedSha)}</code>)
            </span>
          </>
        )}
      </p>
      {reverted && (
        <>
          <p>
            <span>Merge undone by {revertedBy?.name ?? 'a leader'}</span>
            {revertedAt && (
              <>
                {' '}
                <When iso={revertedAt} />
              </>
            )}
            {revertedSha && (
              <>
                {' '}
                <span className="text-xs text-gray-500">
                  (id <code className="font-mono">{shortSha(revertedSha)}</code>)
                </span>
              </>
            )}
          </p>
          <p>
            Main no longer has these changes. They are back in {submission.author.name}’s copy as
            changed files, ready to be fixed and submitted again.
          </p>
        </>
      )}
    </div>
  );
}

/** The author's copy status, for the steps in the Needs update panel. */
function AuthorCopy({ projectId }: { projectId: string }) {
  const copy = useMyCopy(projectId, true);
  if (!copy.data) return null;
  return <CopyUpdates projectId={projectId} copy={copy.data} />;
}

/** The files that clash with main and, for the author, how to fix them. */
export function NeedsUpdatePanel({
  projectId,
  submission,
}: {
  projectId: string;
  submission: SubmissionDetail;
}) {
  if (submission.status !== 'needs_update') return null;
  const isAuthor = can(submission, 'update');
  return (
    <section
      aria-labelledby="needs-update-heading"
      className="space-y-3 rounded-md border border-amber-300 bg-amber-50 p-3"
    >
      <div className="flex items-center gap-2">
        <h3 id="needs-update-heading" className="font-semibold text-amber-950">
          Needs update
        </h3>
        <HelpTip term="clash" />
      </div>
      <p className="text-sm text-gray-800">
        Main (the team’s shared version) has changed since this was submitted, and these files now
        clash with it (a “conflict”): the same lines were changed in both.
      </p>
      <ul aria-label="Files that clash with main" className="list-inside list-disc text-sm">
        {submission.conflictPaths.map((path) => (
          <li key={path} className="font-mono break-all">
            {path}
          </li>
        ))}
      </ul>
      {isAuthor ? (
        <>
          <ol className="list-inside list-decimal space-y-1 text-sm text-gray-800">
            <li>
              <strong>Update my copy</strong> to bring main’s changes in. The clashing lines are
              marked in your files.
            </li>
            <li>
              Fix the marked files in the{' '}
              <Link to={idePageUrl(projectId)} className={linkStyle}>
                IDE
              </Link>
              .
            </li>
            <li>
              Use <strong>Update</strong> above to send the fixed files again. Earlier approvals
              stop counting.
            </li>
          </ol>
          <AuthorCopy projectId={projectId} />
        </>
      ) : (
        <p className="text-sm text-gray-800">
          Waiting for {submission.author.name} to update their copy and this submission.
        </p>
      )}
    </section>
  );
}
