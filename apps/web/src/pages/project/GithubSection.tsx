import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Link, useLocation } from 'react-router';
import {
  GithubRepoNameSchema,
  suggestGithubRepoName,
  type GithubLinkView,
  type GithubMode,
  type ProjectDetail,
  type ProjectGithubView,
} from '@devspace/shared';
import { FormAlert } from '../../components/AuthPageShell';
import { HelpTip } from '../../components/HelpTip';
import { TextField } from '../../components/TextField';
import {
  LoadError,
  Loading,
  SuccessNote,
  buttonStyles,
  cardStyle,
  linkStyle,
} from '../../components/ui';
import { errorCode } from '../../lib/formErrors';
import {
  GITHUB_SETTINGS_URL,
  NOT_CONFIGURED_MESSAGE,
  githubErrorMessage,
  installUrlOf,
  usePublishGithub,
  useProjectGithub,
  useSyncGithub,
  useUnlinkGithub,
} from '../../lib/github';
import { useUpdateSettings } from '../../lib/projects';
import { fullDate, formatWhen } from '../../lib/time';

export const MODE_LABELS: Record<GithubMode, string> = {
  publish_once: 'Publish once',
  keep_updated: 'Keep updated',
};

const MODE_HINTS: Record<GithubMode, string> = {
  publish_once: 'Send main to GitHub now. Later changes stay in DevSpace until you send them.',
  keep_updated: 'Also send main to GitHub again after every merge or undo.',
};

/** A failed GitHub request; `app_not_installed` comes with the link that installs the app. */
function GithubErrorAlert({ error, installUrl }: { error: unknown; installUrl: string | null }) {
  const link =
    errorCode(error) === 'app_not_installed' ? (installUrlOf(error) ?? installUrl) : null;
  return (
    <FormAlert>
      {githubErrorMessage(error)}
      {link && (
        <>
          {' '}
          <a
            href={link}
            target="_blank"
            rel="noreferrer"
            data-testid="github-install-link"
            className={linkStyle}
          >
            Install the DevSpace app on GitHub
          </a>
        </>
      )}
    </FormAlert>
  );
}

function ModeChoices({
  name,
  value,
  onChange,
}: {
  name: string;
  value: GithubMode;
  onChange: (mode: GithubMode) => void;
}) {
  return (
    <fieldset className="space-y-1">
      <legend className="flex items-center gap-2 font-medium text-gray-800">
        <span>After publishing</span>
        <HelpTip term="keepUpdated" />
      </legend>
      {(Object.keys(MODE_LABELS) as GithubMode[]).map((mode) => (
        <ModeChoice
          key={mode}
          name={name}
          mode={mode}
          checked={value === mode}
          onChange={() => onChange(mode)}
        />
      ))}
    </fieldset>
  );
}

function ModeChoice({
  name,
  mode,
  checked,
  onChange,
}: {
  name: string;
  mode: GithubMode;
  checked: boolean;
  onChange: () => void;
}) {
  const hintId = useId();
  return (
    <div>
      <label className="flex items-start gap-2 text-gray-800">
        <input
          type="radio"
          name={name}
          value={mode}
          checked={checked}
          onChange={onChange}
          aria-describedby={hintId}
          className="mt-1 h-4 w-4 shrink-0 border-gray-300"
        />
        <span>{MODE_LABELS[mode]}</span>
      </label>
      <p id={hintId} className="ml-6 text-sm text-gray-600">
        {MODE_HINTS[mode]}
      </p>
    </div>
  );
}

// ---------- Not published yet ----------

function PublishForm({ project, view }: { project: ProjectDetail; view: ProjectGithubView }) {
  const publish = usePublishGithub(project.id);
  const [name, setName] = useState(() => suggestGithubRepoName(project.name));
  const [nameError, setNameError] = useState<string | undefined>();
  const [makePublic, setMakePublic] = useState(false);
  const [mode, setMode] = useState<GithubMode>(project.settings.githubMode);
  const [accepted, setAccepted] = useState(false);
  const [acceptError, setAcceptError] = useState<string | undefined>();
  const publicHintId = useId();
  const acceptErrorId = useId();
  const names = view.emailWarning.names;

  const repoExists = errorCode(publish.error) === 'repo_exists';
  const shownNameError = nameError ?? (repoExists ? githubErrorMessage(publish.error) : undefined);

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (publish.isPending) return;
    const form = event.currentTarget;
    const parsed = GithubRepoNameSchema.safeParse(name);
    if (!parsed.success) {
      setNameError(parsed.error.issues[0]?.message ?? 'Enter a repository name');
      const input = form.elements.namedItem('repoName');
      if (input instanceof HTMLInputElement) input.focus();
      return;
    }
    if (names.length > 0 && !accepted) {
      setAcceptError('Tick this box to go ahead.');
      const box = form.elements.namedItem('acceptEmailWarning');
      if (box instanceof HTMLInputElement) box.focus();
      return;
    }
    publish.mutate({
      name: parsed.data,
      private: !makePublic,
      mode,
      acceptEmailWarning: names.length > 0 && accepted,
    });
  }

  return (
    <form noValidate onSubmit={onSubmit} className="space-y-4" data-testid="github-publish-form">
      <p className="text-sm text-gray-700">
        DevSpace creates a new repository on your GitHub account and sends main there, with its
        whole history.
      </p>
      <TextField
        label="Repository name"
        name="repoName"
        autoComplete="off"
        value={name}
        onChange={(event) => {
          setName(event.target.value);
          setNameError(undefined);
          if (repoExists) publish.reset();
        }}
        hint="Letters, numbers, dots, dashes and underscores."
        error={shownNameError}
        errorIsAlert={!nameError && repoExists}
      />
      <div>
        <label className="flex items-start gap-2 text-gray-800">
          <input
            type="checkbox"
            name="makePublic"
            checked={makePublic}
            onChange={(event) => setMakePublic(event.target.checked)}
            aria-describedby={publicHintId}
            className="mt-1 h-4 w-4 shrink-0 border-gray-300"
          />
          <span>Make it public</span>
        </label>
        <p id={publicHintId} className="ml-6 text-sm text-gray-600">
          {makePublic
            ? 'Anyone on the internet will be able to see the code and its history.'
            : 'Left unticked, the repository is private: only you, and people you invite on GitHub, can see it.'}
        </p>
      </div>
      <ModeChoices name="githubPublishMode" value={mode} onChange={setMode} />
      {names.length > 0 && (
        <div
          data-testid="github-email-warning"
          className="space-y-2 rounded-md border border-amber-300 bg-amber-50 p-3"
        >
          <p className="text-sm text-gray-900">
            Older commits in main show the real email address of{' '}
            {names.length === 1 ? 'this person' : 'these people'}:
          </p>
          <ul className="list-disc pl-5 text-sm text-gray-900">
            {names.map((person) => (
              <li key={person}>{person}</li>
            ))}
          </ul>
          <p className="text-sm text-gray-700">
            Commits can’t be changed after they are made, so these addresses will be visible on
            GitHub. New commits use private addresses.
          </p>
          <label className="flex items-start gap-2 text-sm font-medium text-gray-900">
            <input
              type="checkbox"
              name="acceptEmailWarning"
              checked={accepted}
              onChange={(event) => {
                setAccepted(event.target.checked);
                setAcceptError(undefined);
              }}
              aria-invalid={acceptError ? true : undefined}
              aria-describedby={acceptError ? acceptErrorId : undefined}
              className="mt-0.5 h-4 w-4 shrink-0 border-gray-300"
            />
            <span>I understand these addresses will be public on GitHub</span>
          </label>
          {acceptError && (
            <p id={acceptErrorId} className="text-sm text-red-700">
              {acceptError}
            </p>
          )}
        </div>
      )}
      {publish.isError && !repoExists && (
        <GithubErrorAlert error={publish.error} installUrl={view.installUrl} />
      )}
      <button
        type="submit"
        disabled={publish.isPending}
        aria-busy={publish.isPending || undefined}
        className={buttonStyles.primary}
      >
        {publish.isPending ? 'Publishing…' : 'Publish to GitHub'}
      </button>
    </form>
  );
}

function NotPublished({ project, view }: { project: ProjectDetail; view: ProjectGithubView }) {
  if (!view.canPublish) {
    return (
      <p className="text-sm text-gray-700">
        This project isn’t on GitHub yet. A leader, or a member allowed to publish, can put it
        there.
      </p>
    );
  }
  if (!view.connected) {
    return (
      <p data-testid="github-connect-first" className="text-sm text-gray-700">
        To publish, first connect your GitHub account on the{' '}
        <Link to={GITHUB_SETTINGS_URL} className={linkStyle}>
          GitHub settings
        </Link>{' '}
        page.
      </p>
    );
  }
  return <PublishForm project={project} view={view} />;
}

// ---------- Published ----------

function StatusLine({ link }: { link: GithubLinkView }) {
  let label: string;
  let detail: string | null = null;
  let tone: string;
  switch (link.status) {
    case 'ok':
      tone = 'text-green-800';
      label = link.behind ? 'Main has newer changes' : 'Up to date';
      detail = link.behind
        ? 'Main has changes that aren’t on GitHub yet.'
        : link.lastPushedAt
          ? `Last sent ${formatWhen(link.lastPushedAt)}.`
          : null;
      break;
    case 'pushing':
      tone = 'text-blue-800';
      label = 'Sending to GitHub…';
      break;
    case 'paused':
      tone = 'text-amber-800';
      label = 'Paused';
      detail =
        'DevSpace never overwrites changes made directly on GitHub. Undo those changes on GitHub, then choose Try again.';
      break;
    case 'failed':
      tone = 'text-red-800';
      label = 'Failed';
      detail = 'DevSpace tries again by itself from time to time, or you can try again now.';
      break;
  }
  return (
    <div className="space-y-1">
      <p className="text-sm text-gray-800" role={link.status === 'pushing' ? 'status' : undefined}>
        Status:{' '}
        <strong data-testid="github-status" data-status={link.status} className={tone}>
          {label}
        </strong>
      </p>
      {link.statusReason && (link.status === 'paused' || link.status === 'failed') && (
        <p data-testid="github-status-reason" className="text-sm text-gray-900">
          Why: {link.statusReason}
        </p>
      )}
      {detail && <p className="text-sm text-gray-700">{detail}</p>}
    </div>
  );
}

/** Leaders change the mode of a linked project through the project's settings. */
function ChangeMode({ project, link }: { project: ProjectDetail; link: GithubLinkView }) {
  const update = useUpdateSettings(project.id);
  const [mode, setMode] = useState<GithubMode>(link.mode);

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (mode === link.mode) return;
    update.mutate({ githubMode: mode });
  }

  return (
    <form onSubmit={onSubmit} className="space-y-3">
      <ModeChoices name="githubMode" value={mode} onChange={setMode} />
      {update.isError && <GithubErrorAlert error={update.error} installUrl={null} />}
      <button
        type="submit"
        disabled={update.isPending || mode === link.mode}
        aria-busy={update.isPending || undefined}
        className={buttonStyles.secondary}
      >
        Save
      </button>
      {update.isSuccess && mode === link.mode && <SuccessNote>Saved.</SuccessNote>}
    </form>
  );
}

function Unlink({ projectId }: { projectId: string }) {
  const unlink = useUnlinkGithub(projectId);
  const [confirming, setConfirming] = useState(false);
  return (
    <div className="space-y-2 border-t border-gray-200 pt-3">
      <p className="text-sm text-gray-700">
        Unlinking stops DevSpace from sending main to GitHub. The repository stays on GitHub.
      </p>
      {unlink.isError && <GithubErrorAlert error={unlink.error} installUrl={null} />}
      {confirming ? (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={unlink.isPending}
            aria-busy={unlink.isPending || undefined}
            className={buttonStyles.danger}
            onClick={() => unlink.mutate()}
          >
            Yes, unlink
          </button>
          <button
            type="button"
            className={buttonStyles.secondary}
            onClick={() => {
              setConfirming(false);
              unlink.reset();
            }}
          >
            Cancel
          </button>
        </div>
      ) : (
        <button
          type="button"
          className={buttonStyles.dangerOutline}
          onClick={() => setConfirming(true)}
        >
          Unlink
        </button>
      )}
    </div>
  );
}

function Published({
  project,
  view,
  link,
}: {
  project: ProjectDetail;
  view: ProjectGithubView;
  link: GithubLinkView;
}) {
  const sync = useSyncGithub(project.id);
  const canChangeMode = project.allowedActions.includes('project.updateSettings');
  const showRetry =
    view.canManage &&
    (link.status === 'paused' || link.status === 'failed' || (link.status === 'ok' && link.behind));

  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-800">
        On GitHub:{' '}
        <a
          href={link.htmlUrl}
          target="_blank"
          rel="noreferrer"
          data-testid="github-repo-link"
          className={`${linkStyle} break-all`}
        >
          {link.repoFullName}
        </a>{' '}
        ({link.private ? 'private' : 'public'})
      </p>
      {link.setUpBy && (
        <p className="text-sm text-gray-600">
          Published by {link.setUpBy.name} on {fullDate.format(new Date(link.createdAt))}.
        </p>
      )}
      <StatusLine link={link} />
      {showRetry && (
        <div className="space-y-2">
          {sync.isError && <GithubErrorAlert error={sync.error} installUrl={view.installUrl} />}
          <button
            type="button"
            disabled={sync.isPending}
            aria-busy={sync.isPending || undefined}
            className={buttonStyles.primary}
            onClick={() => sync.mutate(undefined)}
          >
            {link.status === 'ok' ? 'Send the latest main' : 'Try again'}
          </button>
        </div>
      )}
      {canChangeMode ? (
        <ChangeMode key={link.mode} project={project} link={link} />
      ) : (
        <p className="text-sm text-gray-800">
          Mode: <strong>{MODE_LABELS[link.mode]}</strong>
        </p>
      )}
      {view.canUnlink && <Unlink projectId={project.id} />}
    </div>
  );
}

// ---------- The section ----------

/** Project Settings → GitHub: publish the project, or see and manage its GitHub link. */
export function GithubSection({ project }: { project: ProjectDetail }) {
  const github = useProjectGithub(project.id);
  const ref = useRef<HTMLElement>(null);
  const { hash } = useLocation();
  const loaded = github.isSuccess;

  // A notification links here (…/settings#github): bring the section into view once loaded.
  useEffect(() => {
    if (hash === '#github' && loaded) ref.current?.scrollIntoView?.({ block: 'start' });
  }, [hash, loaded]);

  let body;
  if (github.isPending) {
    body = <Loading>Loading the GitHub status…</Loading>;
  } else if (github.isError) {
    body = (
      <LoadError what="the GitHub status" error={github.error} onRetry={() => github.refetch()} />
    );
  } else if (!github.data.configured) {
    body = (
      <p data-testid="github-not-configured" className="text-sm text-gray-700">
        {NOT_CONFIGURED_MESSAGE}
      </p>
    );
  } else if (github.data.link) {
    body = <Published project={project} view={github.data} link={github.data.link} />;
  } else {
    body = <NotPublished project={project} view={github.data} />;
  }

  return (
    <section
      ref={ref}
      id="github"
      aria-labelledby="github-heading"
      data-testid="github-section"
      className={`${cardStyle} scroll-mt-4 space-y-3`}
    >
      <div className="flex items-center gap-2">
        <h3 id="github-heading" className="text-lg font-semibold">
          GitHub
        </h3>
        <HelpTip term="github" />
      </div>
      {body}
    </section>
  );
}
