import { Link } from 'react-router';
import { LoadError, Loading, cardStyle, linkStyle } from '../../components/ui';
import { filesUrl, useRepository } from '../../lib/repository';
import { useProjectContext } from './ProjectLayout';
import { NOT_SET_UP_MESSAGE } from './repository/RepositoryGate';
import { LastCommit, Spinner } from './repository/parts';

/** The repository's state on the overview page, with a way into the files. */
export function OverviewRepository() {
  const { project } = useProjectContext();
  const repository = useRepository(project.id);
  const files = filesUrl(project.id, '');
  const canSetUp = project.allowedActions.includes('repository.setup');

  let body;
  if (repository.isPending) {
    body = <Loading>Loading the repository…</Loading>;
  } else if (repository.isError) {
    body = (
      <LoadError
        what="the repository"
        error={repository.error}
        onRetry={() => repository.refetch()}
      />
    );
  } else {
    const { status, importUrl } = repository.data;
    if (status === 'ready') {
      body = (
        <>
          <LastCommit commit={repository.data.lastCommit} />
          <Link to={files} className={linkStyle}>
            Browse files
          </Link>
        </>
      );
    } else if (status === 'importing') {
      body = (
        <p role="status" className="flex items-center gap-2 break-all text-gray-700">
          <Spinner />
          Importing from {importUrl ?? 'the Git link'}…
        </p>
      );
    } else if (!canSetUp) {
      body = <p className="text-gray-700">{NOT_SET_UP_MESSAGE}</p>;
    } else {
      body = (
        <>
          <p className="text-gray-700">
            {status === 'failed'
              ? 'The last import didn’t finish.'
              : 'The repository hasn’t been set up yet.'}
          </p>
          <Link to={files} className={linkStyle}>
            Set up the repository
          </Link>
        </>
      );
    }
  }

  return (
    <div className={`${cardStyle} space-y-2`}>
      <h3 className="font-medium">Repository</h3>
      {body}
    </div>
  );
}
