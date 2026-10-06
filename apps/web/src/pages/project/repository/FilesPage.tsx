import { useEffect } from 'react';
import { Link } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import type { RepositoryStatus, TreeEntry } from '@devspace/shared';
import { FormAlert } from '../../../components/AuthPageShell';
import { HelpTip } from '../../../components/HelpTip';
import { FocusHeading, LoadError, Loading, cardStyle, linkStyle } from '../../../components/ui';
import { ApiError } from '../../../lib/api';
import { errorCode } from '../../../lib/formErrors';
import {
  blobUrl,
  filesUrl,
  formatBytes,
  repositoryKeys,
  useFile,
  useTree,
} from '../../../lib/repository';
import { useProjectContext } from '../ProjectLayout';
import { RepositoryGate } from './RepositoryGate';
import {
  Breadcrumb,
  FileIcon,
  FolderIcon,
  InvalidPath,
  LastCommit,
  useRepoPathFromUrl,
} from './parts';

/** When the tree or a file says the repository isn't ready, re-read its status. */
export function useNotReadyRefresh(projectId: string, error: unknown) {
  const queryClient = useQueryClient();
  const notReady = errorCode(error) === 'repository_not_ready';
  useEffect(() => {
    if (notReady) {
      void queryClient.invalidateQueries({
        queryKey: repositoryKeys.status(projectId),
        exact: true,
      });
    }
  }, [notReady, projectId, queryClient]);
}

export function isBadPath(error: unknown): boolean {
  return error instanceof ApiError && error.status === 400;
}

const KIND_LABELS: Partial<Record<TreeEntry['type'], string>> = {
  symlink: 'symlink',
  submodule: 'submodule',
};

function EntryRow({ projectId, entry }: { projectId: string; entry: TreeEntry }) {
  const label = KIND_LABELS[entry.type];
  return (
    <tr>
      <td className="py-2 pr-4">
        <span className="flex min-w-0 items-center gap-2">
          {entry.type === 'dir' ? <FolderIcon /> : <FileIcon />}
          {entry.type === 'dir' ? (
            <Link to={filesUrl(projectId, entry.path)} className={`${linkStyle} break-all`}>
              {entry.name}
            </Link>
          ) : entry.type === 'file' ? (
            <Link to={blobUrl(projectId, entry.path)} className={`${linkStyle} break-all`}>
              {entry.name}
            </Link>
          ) : (
            <span className="break-all text-fg">{entry.name}</span>
          )}
          {label && (
            <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-fg-soft">{label}</span>
          )}
        </span>
      </td>
      <td className="py-2 text-right text-sm whitespace-nowrap text-fg-muted">
        {entry.type === 'file' && entry.size !== null ? formatBytes(entry.size) : ''}
      </td>
    </tr>
  );
}

function Readme({ projectId, entry }: { projectId: string; entry: TreeEntry }) {
  const file = useFile(projectId, entry.path, true);
  if (file.isPending) return <Loading>Loading {entry.name}…</Loading>;
  if (file.isError || file.data.content === null) return null;
  return (
    <section aria-labelledby="readme-heading" className={`${cardStyle} space-y-2`}>
      <h3 id="readme-heading" className="font-medium break-all">
        {entry.name}
      </h3>
      <pre className="overflow-x-auto font-mono text-sm break-words whitespace-pre-wrap text-fg">
        {file.data.content}
      </pre>
    </section>
  );
}

function Folder({ repository, path }: { repository: RepositoryStatus; path: string }) {
  const { project } = useProjectContext();
  const tree = useTree(project.id, path, true);
  useNotReadyRefresh(project.id, tree.error);

  let body;
  if (tree.isPending) {
    body = <Loading>Loading files…</Loading>;
  } else if (tree.isError) {
    if (tree.error instanceof ApiError && tree.error.status === 404) {
      body = <FormAlert>This folder doesn't exist on main</FormAlert>;
    } else if (isBadPath(tree.error)) {
      body = <InvalidPath />;
    } else if (errorCode(tree.error) === 'repository_not_ready') {
      body = <Loading>Checking the repository…</Loading>;
    } else {
      body = <LoadError what="the files" error={tree.error} onRetry={() => tree.refetch()} />;
    }
  } else {
    const readme = tree.data.entries.find(
      (entry) => entry.type === 'file' && entry.name.toLowerCase() === 'readme.md',
    );
    body = (
      <>
        <div className={cardStyle}>
          {tree.data.entries.length === 0 ? (
            <p className="text-fg-soft">This folder is empty.</p>
          ) : (
            <table className="w-full table-fixed border-collapse text-left">
              <caption className="sr-only">
                {path === '' ? 'Files in the top folder' : `Files in ${path}`}
              </caption>
              <thead className="sr-only">
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Size</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {tree.data.entries.map((entry) => (
                  <EntryRow key={entry.path} projectId={project.id} entry={entry} />
                ))}
              </tbody>
            </table>
          )}
        </div>
        {readme && <Readme projectId={project.id} entry={readme} />}
      </>
    );
  }

  return (
    <>
      <LastCommit commit={repository.lastCommit} />
      <Breadcrumb projectId={project.id} projectName={project.name} path={path} />
      {body}
    </>
  );
}

/** `/projects/:projectId/files/*` — one folder of main. */
export function FilesPage() {
  const path = useRepoPathFromUrl();

  return (
    <RepositoryGate>
      {(repository) => (
        <section aria-labelledby="files-heading" className="space-y-4">
          <FocusHeading level={2}>
            <span id="files-heading">Files</span>
          </FocusHeading>
          <p className="text-sm text-fg-soft">
            These are the files in main (the team’s shared version) <HelpTip term="main" />. You can
            read them here. To change them, open your copy in the IDE from the Overview.
          </p>
          {path === null ? (
            <InvalidPath />
          ) : (
            <Folder key={path} repository={repository} path={path} />
          )}
        </section>
      )}
    </RepositoryGate>
  );
}
