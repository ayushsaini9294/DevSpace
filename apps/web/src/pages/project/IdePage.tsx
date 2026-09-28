import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router';
import { FormAlert } from '../../components/AuthPageShell';
import { FocusHeading, buttonStyles, linkStyle } from '../../components/ui';
import { useLaunchIde, useMyCopy, useStartIde } from '../../lib/copies';
import { errorCode, errorMessage, isNotFound } from '../../lib/formErrors';
import { useProject } from '../../lib/projects';
import { newSubmissionUrl } from '../../lib/submissions';
import { Spinner } from './repository/parts';

const NO_PROJECT = 'There is no project you can open at this address.';

/** Why the start request failed, in words for this page. */
function startErrorMessage(error: unknown): string {
  if (errorCode(error) === 'repository_not_ready') {
    return 'The project’s repository isn’t ready yet. Once a leader or co-leader has set it up, you can open the IDE.';
  }
  if (isNotFound(error)) return NO_PROJECT;
  return `Could not start your IDE. ${errorMessage(error)}`;
}

function Centered({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-1 items-center justify-center p-4">
      <div className="w-full max-w-md space-y-3">{children}</div>
    </div>
  );
}

function Waiting({ children }: { children: ReactNode }) {
  return (
    <Centered>
      <p role="status" className="flex items-center gap-2 text-gray-800">
        <Spinner />
        {children}
      </p>
      <p className="text-sm text-gray-600">This usually takes a few seconds.</p>
    </Centered>
  );
}

function Problem({
  message,
  retryLabel = 'Try again',
  onRetry,
}: {
  message: string;
  retryLabel?: string;
  onRetry: () => void;
}) {
  return (
    <Centered>
      <FormAlert>{message}</FormAlert>
      <button type="button" className={buttonStyles.primary} onClick={onRetry}>
        {retryLabel}
      </button>
    </Centered>
  );
}

/**
 * The running IDE: asks for a one-time launch URL when it mounts and frames it. Launch tickets
 * are single-use, so every mount (open, retry, reload) asks for a fresh one.
 */
function IdeFrame({
  projectId,
  title,
  onRelaunch,
  onRestart,
}: {
  projectId: string;
  title: string;
  /** Remount this frame, which asks for a new launch URL. */
  onRelaunch: () => void;
  /** Start the container again (it stopped before the IDE opened). */
  onRestart: () => void;
}) {
  const { mutate, data, error, isError, isSuccess } = useLaunchIde(projectId);

  // Once per mount (the ref keeps StrictMode's second effect from using up another ticket).
  const launched = useRef(false);
  useEffect(() => {
    if (launched.current) return;
    launched.current = true;
    mutate();
  }, [mutate]);

  if (isError) {
    if (errorCode(error) === 'ide_not_running') {
      return (
        <Problem
          message="Your IDE stopped before it could open. Your files are kept."
          retryLabel="Start the IDE"
          onRetry={onRestart}
        />
      );
    }
    const message = isNotFound(error)
      ? NO_PROJECT
      : `Could not open your IDE. ${errorMessage(error)}`;
    return <Problem message={message} onRetry={onRelaunch} />;
  }
  if (!isSuccess) return <Waiting>Opening your IDE…</Waiting>;

  return (
    <iframe
      src={data}
      title={title}
      // VS Code needs the clipboard. No sandbox: it would break VS Code, and the IDE is already
      // isolated on its own site.
      allow="clipboard-read; clipboard-write"
      className="block min-h-0 w-full flex-1 border-0 bg-white"
    />
  );
}

/**
 * `/projects/:projectId/ide`: starts (or reuses) my copy's IDE, waits while it starts, then
 * shows VS Code full size. Outside the normal page layout so the editor gets the whole window.
 */
export function IdePage() {
  const projectId = useParams().projectId ?? '';
  const project = useProject(projectId);
  const startIde = useStartIde(projectId);
  const myCopy = useMyCopy(projectId, startIde.isSuccess);
  const { mutate } = startIde;
  // Changing this remounts the frame, which asks for a fresh launch URL.
  const [launchKey, setLaunchKey] = useState(0);
  const relaunch = () => setLaunchKey((key) => key + 1);
  // Every successful (re)start gets a fresh frame, even if the frame never unmounted meanwhile.
  const start = () => mutate(undefined, { onSuccess: relaunch });

  // Start once when the page opens (the ref keeps StrictMode's second effect from posting again).
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    mutate();
  }, [mutate]);

  const projectName = project.data?.name;
  const back = `/projects/${projectId}`;
  let running = false;

  let body: ReactNode;
  if (startIde.isError) {
    body = <Problem message={startErrorMessage(startIde.error)} onRetry={start} />;
  } else if (!startIde.isSuccess || myCopy.isPending) {
    body = <Waiting>Starting your IDE…</Waiting>;
  } else if (myCopy.isError) {
    body = (
      <Problem
        message={`Could not check on your IDE. ${errorMessage(myCopy.error)}`}
        onRetry={start}
      />
    );
  } else {
    const status = myCopy.data?.containerStatus ?? 'none';
    if (status === 'starting') {
      body = <Waiting>Starting your IDE…</Waiting>;
    } else if (status === 'failed') {
      body = <Problem message="Your IDE couldn’t start." onRetry={start} />;
    } else if (status === 'running') {
      running = true;
      body = (
        <IdeFrame
          key={launchKey}
          projectId={projectId}
          title={projectName ? `VS Code for ${projectName}` : 'VS Code'}
          onRelaunch={relaunch}
          onRestart={start}
        />
      );
    } else {
      // Stopped (for example after 30 idle minutes) or not started: the files are kept.
      body = (
        <Problem
          message="Your IDE isn’t running. Your files are kept."
          retryLabel="Start the IDE"
          onRetry={start}
        />
      );
    }
  }

  return (
    <div className="flex h-dvh flex-col bg-gray-50 text-gray-900">
      <header className="flex shrink-0 items-center gap-3 border-b border-gray-200 bg-white px-4 py-2">
        <Link to={back} className={`${linkStyle} shrink-0 text-sm`}>
          ← Back to the project
        </Link>
        <FocusHeading className="min-w-0 flex-1 truncate text-sm font-semibold">
          {projectName ? `IDE: ${projectName}` : 'IDE'}
        </FocusHeading>
        <Link to={newSubmissionUrl(projectId)} className={`${buttonStyles.primary} shrink-0 py-1`}>
          Submit work
        </Link>
        {running && (
          <button
            type="button"
            className={`${buttonStyles.secondary} shrink-0 py-1`}
            onClick={relaunch}
          >
            Reload IDE
          </button>
        )}
      </header>
      <main className="flex min-h-0 flex-1 flex-col">{body}</main>
    </div>
  );
}
