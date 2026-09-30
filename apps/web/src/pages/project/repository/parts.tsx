import { Link, useLocation } from 'react-router';
import type { CommitSummary } from '@devspace/shared';
import { baseName, commitTitle, decodeRepoPath, filesUrl } from '../../../lib/repository';
import { formatWhen, fullDate } from '../../../lib/time';
import { linkStyle } from '../../../components/ui';

/**
 * The repository path in the current URL, after `/projects/:id/files` or `/blob`, or null
 * when it's invalid. Read from the raw (still encoded) pathname so `%2F`, `%23` and `%25`
 * in a name survive.
 */
export function useRepoPathFromUrl(): string | null {
  const { pathname } = useLocation();
  // ['', 'projects', ':projectId', 'files' | 'blob', ...path]
  const rest = pathname.split('/').slice(4).join('/');
  return decodeRepoPath(rest);
}

export function InvalidPath() {
  return (
    <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-red-800">
      This address doesn’t point to a file or folder. Check the link, or go back to Files.
    </p>
  );
}

export function Spinner() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className="h-4 w-4 shrink-0 animate-spin text-blue-700"
      fill="none"
    >
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" opacity="0.25" />
      <path d="M22 12a10 10 0 0 0-10-10" stroke="currentColor" strokeWidth="3" />
    </svg>
  );
}

export function FolderIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" className="h-4 w-4 shrink-0 text-blue-700">
      <path
        fill="currentColor"
        d="M2 5.5A1.5 1.5 0 0 1 3.5 4h4l2 2h7A1.5 1.5 0 0 1 18 7.5v7a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 2 14.5z"
      />
    </svg>
  );
}

export function FileIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" className="h-4 w-4 shrink-0 text-gray-500">
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        d="M5 2.75h6.5L15.25 6.5v10.75H5zM11.5 2.75V6.5h3.75"
      />
    </svg>
  );
}

/** "Add login page — Ada Lovelace, 5 minutes ago" */
export function LastCommit({ commit }: { commit: CommitSummary | null }) {
  if (!commit) return <p className="text-sm text-gray-600">Nothing has been added to main yet.</p>;
  return (
    <p className="text-sm break-words text-gray-700">
      <span className="font-medium text-gray-900">{commitTitle(commit.message)}</span>
      {' — '}
      {commit.authorName},{' '}
      <time dateTime={commit.committedAt} title={fullDate.format(new Date(commit.committedAt))}>
        {formatWhen(commit.committedAt)}
      </time>
    </p>
  );
}

/**
 * Project name, then each folder of `path`. For a file (`isFile`), its name ends the trail as
 * plain text.
 */
export function Breadcrumb({
  projectId,
  projectName,
  path,
  isFile = false,
}: {
  projectId: string;
  projectName: string;
  path: string;
  isFile?: boolean;
}) {
  const segments = path === '' ? [] : path.split('/');
  const folders = isFile ? segments.slice(0, -1) : segments;
  const current = (index: number) => !isFile && index === folders.length - 1;

  return (
    <nav aria-label="Breadcrumb">
      <ol className="flex flex-wrap items-center gap-x-1 text-sm break-all">
        <li>
          <Link
            to={filesUrl(projectId, '')}
            className={linkStyle}
            aria-current={segments.length === 0 ? 'page' : undefined}
          >
            {projectName}
          </Link>
        </li>
        {folders.map((name, index) => (
          <li key={index} className="flex items-center gap-x-1">
            <span aria-hidden="true" className="text-gray-400">
              /
            </span>
            <Link
              to={filesUrl(projectId, segments.slice(0, index + 1).join('/'))}
              className={linkStyle}
              aria-current={current(index) ? 'page' : undefined}
            >
              {name}
            </Link>
          </li>
        ))}
        {isFile && (
          <li className="flex items-center gap-x-1">
            <span aria-hidden="true" className="text-gray-400">
              /
            </span>
            <span aria-current="page" className="font-medium text-gray-900">
              {baseName(path)}
            </span>
          </li>
        )}
      </ol>
    </nav>
  );
}
