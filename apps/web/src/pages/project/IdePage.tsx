import { useEffect, useRef, type ReactNode } from 'react';
import { Link, useParams } from 'react-router';
import { FormAlert } from '../../components/AuthPageShell';
import { FocusHeading, buttonStyles, linkStyle } from '../../components/ui';
import { ideFrameSrc, useMyCopy, useStartIde } from '../../lib/copies';
import { errorCode, errorMessage, isNotFound } from '../../lib/formErrors';
import { useProject } from '../../lib/projects';
import { Spinner } from './repository/parts';

/** Why the start request failed, in words for this page. */
function startErrorMessage(error: unknown): string {
  if (errorCode(error) === 'repository_not_ready') {
    return 'The project’s repository isn’t ready yet. Once a leader or co-leader has set it up, you can open the IDE.';
  }
  if (isNotFound(error)) return 'There is no project you can open at this address.';
  return `Could not start your IDE. ${errorMessage(error)}`;
}

function Centered({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-1 items-center justify-center p-4">
      <div className="w-full max-w-md space-y-3">{children}</div>
    </div>
  );
}

function Starting() {
  return (
    <Centered>
      <p role="status" className="flex items-center gap-2 text-gray-800">
        <Spinner />
        Starting your IDE…
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
 * `/projects/:projectId/ide`: starts (or reuses) my copy's IDE, waits while it starts, then
 * shows VS Code full size. Outside the normal page layout so the editor gets the whole window.
 */
export function IdePage() {
  const projectId = useParams().projectId ?? '';
  const project = useProject(projectId);
  const startIde = useStartIde(projectId);
  const myCopy = useMyCopy(projectId, startIde.isSuccess);
  const { mutate } = startIde;
  const start = () => mutate();

  // Start once when the page opens (the ref keeps StrictMode's second effect from posting again).
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    mutate();
  }, [mutate]);

  const projectName = project.data?.name;
  const back = `/projects/${projectId}`;

  let body: ReactNode;
  if (startIde.isError) {
    body = <Problem message={startErrorMessage(startIde.error)} onRetry={start} />;
  } else if (!startIde.isSuccess || myCopy.isPending) {
    body = <Starting />;
  } else if (myCopy.isError) {
    body = (
      <Problem
        message={`Could not check on your IDE. ${errorMessage(myCopy.error)}`}
        onRetry={start}
      />
    );
  } else {
    const copy = myCopy.data;
    const status = copy?.containerStatus ?? 'none';
    if (status === 'starting') {
      body = <Starting />;
    } else if (status === 'failed') {
      body = <Problem message="Your IDE couldn’t start." onRetry={start} />;
    } else if (status === 'running' && copy) {
      const src = ideFrameSrc(copy);
      body = src ? (
        <iframe
          src={src}
          title={projectName ? `VS Code for ${projectName}` : 'VS Code'}
          allow="clipboard-read; clipboard-write"
          className="block min-h-0 w-full flex-1 border-0 bg-white"
        />
      ) : (
        <Problem message="The server sent an unexpected address for your IDE." onRetry={start} />
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
        <FocusHeading className="min-w-0 truncate text-sm font-semibold">
          {projectName ? `IDE: ${projectName}` : 'IDE'}
        </FocusHeading>
      </header>
      <main className="flex min-h-0 flex-1 flex-col">{body}</main>
    </div>
  );
}
