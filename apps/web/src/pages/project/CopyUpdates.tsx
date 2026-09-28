import { useId, useState } from 'react';
import type { CopyView } from '@devspace/shared';
import { FormAlert } from '../../components/AuthPageShell';
import { Loading, SuccessNote, buttonStyles } from '../../components/ui';
import { useCopyUpdatePreview, useMyCopy, useUpdateMyCopy } from '../../lib/copies';
import { useRepository } from '../../lib/repository';
import { errorCode, errorMessage } from '../../lib/formErrors';
import { formatWhen, fullDate } from '../../lib/time';

/** Clear words for a failed copy update or preview. */
export function copyUpdateErrorMessage(error: unknown): string {
  switch (errorCode(error)) {
    case 'copy_changed':
      return 'A file in your copy changed while it was being updated, so nothing was written. Please try again.';
    case 'no_copy':
      return 'You don’t have a copy of this project yet. Open the IDE once to make one.';
    case 'submission_too_large':
      return 'Your copy is too large to update (at most 20,000 files, 10 MB per file).';
    default:
      return errorMessage(error);
  }
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? `1 ${one}` : `${n} ${many}`;
}

function PathList({ paths, label }: { paths: string[]; label: string }) {
  return (
    <ul aria-label={label} className="list-inside list-disc space-y-0.5 font-mono text-sm">
      {paths.map((path) => (
        <li key={path} className="break-all">
          {path}
        </li>
      ))}
    </ul>
  );
}

/** The live check of what an update would do, before the member clicks. */
function Preview({ projectId, copy }: { projectId: string; copy: CopyView }) {
  const preview = useCopyUpdatePreview(projectId, copy.behind);

  if (preview.isPending) return <Loading>Checking whether your changes clash with main…</Loading>;
  if (preview.isError) {
    return (
      <p className="text-sm text-gray-700">
        Couldn’t check for clashes: {copyUpdateErrorMessage(preview.error)}
      </p>
    );
  }
  const { conflictPaths } = preview.data;
  if (conflictPaths.length === 0) {
    return (
      <p className="text-sm text-gray-800">
        No clashes: your changes are kept and main’s changes are added.
      </p>
    );
  }
  return (
    <div className="space-y-1 text-sm text-gray-800">
      <p>
        {plural(conflictPaths.length, 'file clashes', 'files clash')} with main. Updating keeps your
        version of each and marks the clashing lines for you to fix:
      </p>
      <PathList paths={conflictPaths} label="Files that would clash" />
    </div>
  );
}

/** "Main has changed": the preview and the Update my copy button. */
function BehindPanel({
  projectId,
  copy,
  onUpdated,
}: {
  projectId: string;
  copy: CopyView;
  onUpdated: (conflictPaths: string[]) => void;
}) {
  const update = useUpdateMyCopy(projectId);
  const headingId = useId();

  return (
    <section
      aria-labelledby={headingId}
      className="space-y-2 rounded-md border border-blue-200 bg-blue-50 p-3"
    >
      <h3 id={headingId} className="font-medium text-blue-950">
        Main has changed
      </h3>
      <p className="text-sm text-gray-800">
        Work was merged into main (or undone) since your copy was last updated.
      </p>
      {copy.pendingConflictPaths.length > 0 && (
        <p className="text-sm text-gray-800">
          Your copy wasn’t updated automatically because your changes clash with main.
        </p>
      )}
      <Preview projectId={projectId} copy={copy} />
      {update.isError && <FormAlert>{copyUpdateErrorMessage(update.error)}</FormAlert>}
      <button
        type="button"
        disabled={update.isPending}
        aria-busy={update.isPending || undefined}
        className={buttonStyles.primary}
        onClick={() =>
          update.mutate(undefined, { onSuccess: (result) => onUpdated(result.conflictPaths) })
        }
      >
        Update my copy
      </button>
      <p className="text-xs text-gray-600">
        Updating writes main’s changes into your files but leaves your copy’s own Git history alone,
        so VS Code’s Source Control panel may list main’s changes as your own edits. That’s
        expected: DevSpace always compares your copy with main for you.
      </p>
    </section>
  );
}

/** Files an update left with conflict markers, until the member fixes them. */
function Unresolved({ paths }: { paths: string[] }) {
  const headingId = useId();
  return (
    <section
      aria-labelledby={headingId}
      className="space-y-2 rounded-md border border-amber-300 bg-amber-50 p-3"
    >
      <h3 id={headingId} className="font-medium text-amber-950">
        Conflicts to fix
      </h3>
      <p className="text-sm text-gray-800">
        These files still have conflict markers. In the IDE, keep the lines that should stay between{' '}
        <code>&lt;&lt;&lt;&lt;&lt;&lt;&lt; your copy</code> and{' '}
        <code>&gt;&gt;&gt;&gt;&gt;&gt;&gt; main</code>, and delete the marker lines.
      </p>
      <PathList paths={paths} label="Files with conflict markers" />
    </section>
  );
}

/** "<Leader> opened your copy <time>", one line per lead in the last 24 hours. */
function Helpers({ copy }: { copy: CopyView }) {
  return (
    <ul className="space-y-1 rounded-md border border-gray-200 bg-gray-50 p-3 text-sm text-gray-800">
      {copy.helpers.map((helper) => (
        <li key={helper.user.id}>
          <span className="font-medium">{helper.user.name}</span> opened your copy{' '}
          <time dateTime={helper.at} title={fullDate.format(new Date(helper.at))}>
            {formatWhen(helper.at)}
          </time>
        </li>
      ))}
    </ul>
  );
}

/**
 * My copy compared with main: the Update my copy banner (with a live preview of clashes), files
 * that still have conflict markers, and which leads opened my copy. Nothing when all is quiet.
 */
export function CopyUpdates({ projectId, copy }: { projectId: string; copy: CopyView }) {
  const [result, setResult] = useState<string[] | null>(null);

  const quiet =
    !copy.behind &&
    copy.unresolvedPaths.length === 0 &&
    copy.helpers.length === 0 &&
    result === null;
  if (quiet) return null;

  return (
    <div className="space-y-3">
      {copy.helpers.length > 0 && <Helpers copy={copy} />}
      {result !== null &&
        (result.length === 0 ? (
          <SuccessNote>Your copy is up to date with main.</SuccessNote>
        ) : (
          <p role="status" className="text-sm font-medium text-amber-900">
            Your copy is updated. {plural(result.length, 'file has', 'files have')} conflict markers
            to fix.
          </p>
        ))}
      {copy.behind && (
        <BehindPanel projectId={projectId} copy={copy} onUpdated={(paths) => setResult(paths)} />
      )}
      {copy.unresolvedPaths.length > 0 && <Unresolved paths={copy.unresolvedPaths} />}
    </div>
  );
}

/** The overview's view of my copy: shown once the repository is ready and I have a copy. */
export function OverviewCopyUpdates({ projectId }: { projectId: string }) {
  const repository = useRepository(projectId);
  const ready = repository.data?.status === 'ready';
  const copy = useMyCopy(projectId, ready);
  if (!ready || !copy.data) return null;
  return <CopyUpdates projectId={projectId} copy={copy.data} />;
}
