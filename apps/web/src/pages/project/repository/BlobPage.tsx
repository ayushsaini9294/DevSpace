import { FormAlert } from '../../../components/AuthPageShell';
import { LazyCodeViewer } from '../../../components/code/LazyCodeViewer';
import { FocusHeading, LoadError, Loading, cardStyle } from '../../../components/ui';
import { ApiError } from '../../../lib/api';
import { errorCode } from '../../../lib/formErrors';
import { baseName, formatBytes, useFile } from '../../../lib/repository';
import { useProjectContext } from '../ProjectLayout';
import { isBadPath, useNotReadyRefresh } from './FilesPage';
import { RepositoryGate } from './RepositoryGate';
import { Breadcrumb, InvalidPath, useRepoPathFromUrl } from './parts';

function FileView({ path }: { path: string }) {
  const { project } = useProjectContext();
  const file = useFile(project.id, path, true);
  useNotReadyRefresh(project.id, file.error);

  let body;
  if (file.isPending) {
    body = <Loading>Loading the file…</Loading>;
  } else if (file.isError) {
    if (file.error instanceof ApiError && file.error.status === 404) {
      body = <FormAlert>This file doesn't exist on main</FormAlert>;
    } else if (isBadPath(file.error)) {
      body = <InvalidPath />;
    } else if (errorCode(file.error) === 'repository_not_ready') {
      body = <Loading>Checking the repository…</Loading>;
    } else {
      body = <LoadError what="the file" error={file.error} onRetry={() => file.refetch()} />;
    }
  } else {
    const { size, isBinary, tooLarge, content } = file.data;
    body = (
      <>
        <p className="text-sm text-gray-600">{formatBytes(size)}</p>
        {isBinary ? (
          <p className={`${cardStyle} text-gray-700`}>
            This file is binary and can't be shown here.
          </p>
        ) : tooLarge || content === null ? (
          <p className={`${cardStyle} text-gray-700`}>
            This file is too large to show here ({formatBytes(size)}).
          </p>
        ) : (
          <LazyCodeViewer path={path} value={content} />
        )}
      </>
    );
  }

  return (
    <>
      <Breadcrumb projectId={project.id} projectName={project.name} path={path} isFile />
      {body}
    </>
  );
}

/** `/projects/:projectId/blob/*` — one file of main, read-only. */
export function BlobPage() {
  const path = useRepoPathFromUrl();
  const valid = path !== null && path !== '';

  return (
    <RepositoryGate>
      {() => (
        <section aria-labelledby="file-heading" className="space-y-4">
          <FocusHeading level={2} className="text-xl font-semibold break-all">
            <span id="file-heading">{valid ? baseName(path) : 'File'}</span>
          </FocusHeading>
          {valid ? <FileView key={path} path={path} /> : <InvalidPath />}
        </section>
      )}
    </RepositoryGate>
  );
}
