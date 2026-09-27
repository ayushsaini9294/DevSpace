import { useState, type FormEvent, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ImportUrlSchema, type RepositoryStatus } from '@devspace/shared';
import { FormAlert } from '../../../components/AuthPageShell';
import { TextField } from '../../../components/TextField';
import { FocusHeading, LoadError, Loading, buttonStyles, cardStyle } from '../../../components/ui';
import { describeServerError, errorCode } from '../../../lib/formErrors';
import { repositoryKeys, useRepository, useSetUpRepository } from '../../../lib/repository';
import { useProjectContext } from '../ProjectLayout';
import { Spinner } from './parts';

export const NOT_SET_UP_MESSAGE =
  "The repository hasn't been set up yet. A leader or co-leader can set it up.";

type Source = 'empty' | 'import';

function SetUpForm({ projectId, repository }: { projectId: string; repository: RepositoryStatus }) {
  const queryClient = useQueryClient();
  const setUp = useSetUpRepository(projectId);
  const failed = repository.status === 'failed';
  const [source, setSource] = useState<Source>(
    failed && repository.source === 'import' ? 'import' : 'empty',
  );
  const [url, setUrl] = useState(repository.importUrl ?? '');
  const [urlError, setUrlError] = useState<string | undefined>();

  const server = describeServerError(setUp.error, ['url'] as const);

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (setUp.isPending) return;
    // Someone else set it up meanwhile: show the real state.
    const onError = (error: unknown) => {
      if (errorCode(error) === 'repository_exists') {
        void queryClient.invalidateQueries({
          queryKey: repositoryKeys.status(projectId),
          exact: true,
        });
      }
    };
    if (source === 'empty') {
      setUp.mutate({ source: 'empty' }, { onError });
      return;
    }
    const parsed = ImportUrlSchema.safeParse(url);
    if (!parsed.success) {
      setUrlError(parsed.error.issues[0]?.message ?? 'Enter a Git link');
      const input = event.currentTarget.elements.namedItem('url');
      if (input instanceof HTMLInputElement) input.focus();
      return;
    }
    setUrlError(undefined);
    setUp.mutate({ source: 'import', url: parsed.data }, { onError });
  }

  const radio = (value: Source, label: string) => (
    <label className="flex items-center gap-2">
      <input
        type="radio"
        name="source"
        value={value}
        checked={source === value}
        onChange={() => setSource(value)}
        className="h-4 w-4"
      />
      <span>{label}</span>
    </label>
  );

  return (
    <form noValidate onSubmit={onSubmit} className={`${cardStyle} space-y-4`}>
      {failed && (
        <FormAlert>
          The import didn’t finish: {repository.error ?? 'the server gave no reason.'} You can try
          again.
        </FormAlert>
      )}
      <fieldset className="space-y-2">
        <legend className="mb-1 text-sm font-medium text-gray-800">
          How do you want to start?
        </legend>
        {radio('empty', 'Start empty')}
        {radio('import', 'Import from a Git link')}
      </fieldset>
      {source === 'import' && (
        <TextField
          label="Git link"
          name="url"
          type="url"
          autoComplete="off"
          value={url}
          onChange={(event) => {
            setUrl(event.target.value);
            setUrlError(undefined);
          }}
          hint="Public repositories on GitHub, GitLab and Bitbucket are supported, up to 200 MB."
          error={urlError ?? server.fieldErrors.url}
          errorIsAlert={!urlError && Boolean(server.fieldErrors.url)}
        />
      )}
      {server.formError && <FormAlert>{server.formError}</FormAlert>}
      <button type="submit" className={buttonStyles.primary} disabled={setUp.isPending}>
        {setUp.isPending ? 'Setting up…' : 'Set up repository'}
      </button>
    </form>
  );
}

function Importing({ importUrl }: { importUrl: string | null }) {
  return (
    <div className={cardStyle}>
      <p role="status" className="flex items-center gap-2 break-all text-gray-800">
        <Spinner />
        Importing from {importUrl ?? 'the Git link'}…
      </p>
      <p className="mt-2 text-sm text-gray-600">
        This can take a few minutes for large repositories. The files appear here when it’s done.
      </p>
    </div>
  );
}

/** Repository states other than `ready`: set it up, wait for the import, or explain. */
export function RepositoryNotReady({ repository }: { repository: RepositoryStatus }) {
  const { project } = useProjectContext();

  if (repository.status === 'importing') {
    return (
      <section aria-labelledby="files-heading" className="space-y-4">
        <FocusHeading level={2}>
          <span id="files-heading">Files</span>
        </FocusHeading>
        <Importing importUrl={repository.importUrl} />
      </section>
    );
  }

  if (!project.allowedActions.includes('repository.setup')) {
    return (
      <section aria-labelledby="files-heading" className="space-y-4">
        <FocusHeading level={2}>
          <span id="files-heading">Files</span>
        </FocusHeading>
        <p className={`${cardStyle} text-gray-700`}>{NOT_SET_UP_MESSAGE}</p>
      </section>
    );
  }

  return (
    <section aria-labelledby="setup-heading" className="space-y-4">
      <FocusHeading level={2}>
        <span id="setup-heading">Set up the repository</span>
      </FocusHeading>
      <p className="text-gray-700">
        Start with an empty repository, or bring in an existing project’s files and history. This
        becomes the project’s main.
      </p>
      <SetUpForm projectId={project.id} repository={repository} />
    </section>
  );
}

/**
 * Loads the repository status and shows the setup or import state until it's ready, then
 * renders `children` with the ready repository. Polls while an import runs.
 */
export function RepositoryGate({
  children,
}: {
  children: (repository: RepositoryStatus) => ReactNode;
}) {
  const { project } = useProjectContext();
  const repository = useRepository(project.id);

  if (repository.isPending) return <Loading>Loading the repository…</Loading>;
  if (repository.isError) {
    return (
      <LoadError
        what="the repository"
        error={repository.error}
        onRetry={() => repository.refetch()}
      />
    );
  }
  if (repository.data.status !== 'ready') {
    return <RepositoryNotReady repository={repository.data} />;
  }
  return <>{children(repository.data)}</>;
}
