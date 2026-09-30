import { useId, useState, type FormEvent, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ImportUrlSchema, type RepositoryStatus, type TemplateId } from '@devspace/shared';
import { FormAlert } from '../../../components/AuthPageShell';
import { HelpTip } from '../../../components/HelpTip';
import { TextField } from '../../../components/TextField';
import {
  FocusHeading,
  LoadError,
  Loading,
  buttonStyles,
  cardStyle,
  linkStyle,
} from '../../../components/ui';
import { describeServerError, errorCode } from '../../../lib/formErrors';
import { repositoryKeys, useRepository, useSetUpRepository } from '../../../lib/repository';
import { useTemplates } from '../../../lib/templates';
import { useProjectContext } from '../ProjectLayout';
import { Spinner } from './parts';

export const NOT_SET_UP_MESSAGE =
  "The repository hasn't been set up yet. A leader or co-leader can set it up.";

/** What the leader picked: a template (`empty` = start empty) or an import. */
type Choice = TemplateId | 'import';

/** The template beginners are pointed at first. */
const RECOMMENDED: TemplateId = 'html';

/** Empty's description when the template list can't be loaded. */
const EMPTY_DESCRIPTION = 'Only a README file. Start from nothing and add your own files.';

/** One choice as a card: a radio named by `name` alone, with the details as its description. */
function ChoiceCard({
  value,
  name,
  description,
  runHint,
  recommended = false,
  checked,
  onChoose,
}: {
  value: Choice;
  name: string;
  description: string;
  runHint: string | null;
  recommended?: boolean;
  checked: boolean;
  onChoose: () => void;
}) {
  const id = useId();
  return (
    <label
      htmlFor={id}
      data-testid="template-card"
      data-template={value}
      className={`flex cursor-pointer gap-3 rounded-lg border p-3 hover:border-blue-400 ${
        checked ? 'border-blue-600 bg-blue-50 ring-1 ring-blue-600' : 'border-gray-200 bg-white'
      }`}
    >
      <input
        id={id}
        type="radio"
        name="source"
        value={value}
        checked={checked}
        onChange={onChoose}
        aria-labelledby={`${id}-name`}
        aria-describedby={`${id}-details`}
        className="mt-1 h-4 w-4 shrink-0"
      />
      <span className="min-w-0 space-y-1">
        <span className="flex flex-wrap items-center gap-2">
          <span id={`${id}-name`} className="font-medium text-gray-900">
            {name}
          </span>
          {recommended && (
            <span className="rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-800">
              Good first choice
            </span>
          )}
        </span>
        <span id={`${id}-details`} className="block space-y-1 text-sm text-gray-700">
          <span className="block">{description}</span>{' '}
          {runHint && (
            <span className="block text-gray-600">
              <span className="font-medium text-gray-800">How to run:</span> {runHint}
            </span>
          )}
        </span>
      </span>
    </label>
  );
}

function SetUpForm({ projectId, repository }: { projectId: string; repository: RepositoryStatus }) {
  const queryClient = useQueryClient();
  const setUp = useSetUpRepository(projectId);
  const templates = useTemplates();
  const failed = repository.status === 'failed';
  const [picked, setPicked] = useState<Choice>(
    failed && repository.source === 'import' ? 'import' : RECOMMENDED,
  );
  const [url, setUrl] = useState(repository.importUrl ?? '');
  const [urlError, setUrlError] = useState<string | undefined>();

  const list = templates.data ?? [];
  // A template that isn't offered (the list failed, or doesn't have it) falls back to Empty.
  const choice: Choice =
    picked === 'import' || picked === 'empty' || list.some((t) => t.id === picked)
      ? picked
      : 'empty';
  const emptyTemplate = list.find((t) => t.id === 'empty');
  const starters = list.filter((t) => t.id !== 'empty');

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
    if (choice === 'empty') {
      setUp.mutate({ source: 'empty' }, { onError });
      return;
    }
    if (choice !== 'import') {
      setUp.mutate({ source: 'template', template: choice }, { onError });
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

  return (
    <form noValidate onSubmit={onSubmit} className={`${cardStyle} space-y-4`}>
      {failed && (
        <FormAlert>
          The import didn’t finish: {repository.error ?? 'the server gave no reason.'} You can try
          again.
        </FormAlert>
      )}
      <fieldset className="space-y-3">
        <legend className="mb-1 text-sm font-medium text-gray-800">
          How do you want to start?
        </legend>
        {templates.isPending && <Loading>Loading the starter templates…</Loading>}
        {templates.isError && (
          <p className="text-sm text-gray-700">
            The starter templates couldn’t be loaded. You can still start empty or import, or{' '}
            <button type="button" className={linkStyle} onClick={() => void templates.refetch()}>
              try loading them again
            </button>
            .
          </p>
        )}
        {starters.length > 0 && (
          <div className="grid gap-3 sm:grid-cols-2">
            {starters.map((template) => (
              <ChoiceCard
                key={template.id}
                value={template.id}
                name={template.name}
                description={template.description}
                runHint={template.runHint}
                recommended={template.id === RECOMMENDED}
                checked={choice === template.id}
                onChoose={() => setPicked(template.id)}
              />
            ))}
          </div>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <ChoiceCard
            value="empty"
            name="Start empty"
            description={emptyTemplate?.description ?? EMPTY_DESCRIPTION}
            runHint={null}
            checked={choice === 'empty'}
            onChoose={() => setPicked('empty')}
          />
          <ChoiceCard
            value="import"
            name="Import from a Git link"
            description="Bring in an existing project from GitHub, GitLab or Bitbucket, with its history."
            runHint={null}
            checked={choice === 'import'}
            onChoose={() => setPicked('import')}
          />
        </div>
      </fieldset>
      {choice === 'import' && (
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
        This can take a few minutes for large projects. The files appear here when it’s done.
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
        Pick what the project starts with. A starter template gives you a small working app with a
        README that explains how to run it. What you pick becomes the project’s main (the team’s
        shared version) <HelpTip term="main" />
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
