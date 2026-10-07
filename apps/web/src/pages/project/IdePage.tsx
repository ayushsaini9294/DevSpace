import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router';
import type { CopyView } from '@devspace/shared';
import { FormAlert } from '../../components/AuthPageShell';
import { FocusHeading, buttonStyles, linkStyle } from '../../components/ui';
import { HelpTip } from '../../components/HelpTip';
import {
  httpOrigin,
  safeLaunchUrl,
  useCopy,
  useLaunchIde,
  useStartIde,
  type CopyOwner,
} from '../../lib/copies';
import { errorCode, errorMessage, isNotFound } from '../../lib/formErrors';
import { usePollInterval, useProjectRoom } from '../../lib/liveStore';
import { useMembers, useProject } from '../../lib/projects';
import { useRepository } from '../../lib/repository';
import { newSubmissionUrl } from '../../lib/submissions';
import { findTemplate, useTemplates } from '../../lib/templates';
import { AiAssistantHint } from './AiAssistantHint';
import { CopyUpdates } from './CopyUpdates';
import { PreviewControl } from './PreviewControl';
import { Spinner } from './repository/parts';

const NO_PROJECT = 'There is no project you can open at this address.';
const NO_MEMBER_COPY =
  'This member has no copy yet (they haven’t opened the project’s IDE), or isn’t in the project any more.';
const NOT_A_LEAD = 'Only leaders and co-leaders can open a member’s copy.';

/**
 * While my own IDE is open, re-read my copy this often, so main's changes and fixed conflicts
 * show (60 s while the live connection is up).
 */
const OWN_COPY_REFRESH_MS = 15_000;

/** Words that differ between my own IDE and a member's copy opened by a lead. */
type Words = { ide: string; Ide: string; notFound: string };

const OWN_WORDS: Words = { ide: 'your IDE', Ide: 'Your IDE', notFound: NO_PROJECT };
const MEMBER_WORDS: Words = { ide: 'the IDE', Ide: 'The IDE', notFound: NO_MEMBER_COPY };

/** Why a request failed, in words for this page. */
function failureMessage(error: unknown, words: Words, action: string): string {
  const code = errorCode(error);
  if (code === 'repository_not_ready') {
    return 'The project’s repository isn’t ready yet. Once a leader or co-leader has set it up, you can open the IDE.';
  }
  if (code === 'forbidden') return NOT_A_LEAD;
  if (isNotFound(error)) return words.notFound;
  return `Could not ${action} ${words.ide}. ${errorMessage(error)}`;
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
      <p role="status" className="flex items-center gap-2 text-fg">
        <Spinner />
        {children}
      </p>
      <p className="text-sm text-fg-muted">This usually takes a few seconds.</p>
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
  owner,
  copyId,
  words,
  title,
  onRelaunch,
  onRestart,
  onLaunched,
}: {
  projectId: string;
  owner: CopyOwner;
  /** The copy whose IDE this is: its launch URL must be on this copy's own address. */
  copyId: string;
  words: Words;
  title: string;
  /** Remount this frame, which asks for a new launch URL. */
  onRelaunch: () => void;
  /** Start the container again (it stopped before the IDE opened). */
  onRestart: () => void;
  /** The IDE's launch URL arrived (its origin is this copy's IDE address, for Preview). */
  onLaunched: (url: string) => void;
}) {
  const { mutate, data, error, isError, isSuccess } = useLaunchIde(projectId, owner);
  const src = data ? safeLaunchUrl(data, copyId) : null;

  // Once per mount (the ref keeps StrictMode's second effect from using up another ticket).
  const launched = useRef(false);
  useEffect(() => {
    if (launched.current) return;
    launched.current = true;
    mutate();
  }, [mutate]);

  useEffect(() => {
    if (src) onLaunched(src);
  }, [src, onLaunched]);

  if (isError) {
    if (errorCode(error) === 'ide_not_running') {
      return (
        <Problem
          message={`${words.Ide} stopped before it could open. The files are kept.`}
          retryLabel="Start the IDE"
          onRetry={onRestart}
        />
      );
    }
    return <Problem message={failureMessage(error, words, 'open')} onRetry={onRelaunch} />;
  }
  if (!isSuccess) return <Waiting>Opening {words.ide}…</Waiting>;
  if (src === null) {
    return (
      <Problem
        message={`Could not open ${words.ide}: the server sent an address that isn’t this copy’s IDE address.`}
        onRetry={onRelaunch}
      />
    );
  }

  return (
    <iframe
      src={src}
      title={title}
      // VS Code needs the clipboard. No sandbox: it would break VS Code, and the IDE is already
      // isolated on its own site.
      allow="clipboard-read; clipboard-write"
      className="block min-h-0 w-full flex-1 border-0 bg-surface"
    />
  );
}

/** My copy's updates, as a strip under the IDE toolbar (nothing when all is quiet). */
function OwnCopyStrip({ projectId, copy }: { projectId: string; copy: CopyView }) {
  return (
    <div className="max-h-[40vh] shrink-0 overflow-y-auto border-b border-line bg-surface px-4 py-2 empty:hidden">
      <CopyUpdates projectId={projectId} copy={copy} />
    </div>
  );
}

/**
 * `/projects/:projectId/ide`: starts (or reuses) my copy's IDE, waits while it starts, then
 * shows VS Code full size. `/projects/:projectId/members/:userId/ide` does the same for a
 * member's copy, opened by a leader or co-leader. Outside the normal page layout so the editor
 * gets the whole window.
 */
export function IdePage() {
  const params = useParams();
  const projectId = params.projectId ?? '';
  const owner: CopyOwner = params.userId ?? null;
  const own = owner === null;
  const words = own ? OWN_WORDS : MEMBER_WORDS;

  const project = useProject(projectId);
  useProjectRoom(projectId);
  const members = useMembers(projectId, !own);
  const startIde = useStartIde(projectId, owner);
  const repository = useRepository(projectId);
  const templates = useTemplates(Boolean(repository.data?.template));
  const previewPort =
    findTemplate(templates.data, repository.data?.template ?? null)?.previewPort ?? null;
  const ownRefresh = usePollInterval(OWN_COPY_REFRESH_MS);
  const copy = useCopy(projectId, owner, startIde.isSuccess, own ? ownRefresh : false);
  const copyId = copy.data?.id ?? null;
  // This copy's IDE address, taken from its launch URL: Preview URLs must be on it. Each copy has
  // its own address, so one learnt for another copy (before a route change) is never used.
  const [launched, setLaunched] = useState<{ copyId: string; origin: string | null } | null>(null);
  const onLaunched = useCallback(
    (url: string) => {
      if (copyId) setLaunched({ copyId, origin: httpOrigin(url) });
    },
    [copyId],
  );
  const ideOrigin = launched && launched.copyId === copyId ? launched.origin : null;
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
  const memberName = own
    ? null
    : (members.data?.find((member) => member.userId === owner)?.name ?? null);
  const back = own ? `/projects/${projectId}` : `/projects/${projectId}/members`;
  let running = false;

  let body: ReactNode;
  if (startIde.isError) {
    body = <Problem message={failureMessage(startIde.error, words, 'start')} onRetry={start} />;
  } else if (!startIde.isSuccess || copy.isPending) {
    body = <Waiting>Starting {words.ide}…</Waiting>;
  } else if (copy.isError) {
    body = (
      <Problem
        message={`Could not check on ${words.ide}. ${errorMessage(copy.error)}`}
        onRetry={start}
      />
    );
  } else {
    const status = copy.data?.containerStatus ?? 'none';
    if (status === 'starting') {
      body = <Waiting>Starting {words.ide}…</Waiting>;
    } else if (status === 'failed') {
      body = <Problem message={`${words.Ide} couldn’t start.`} onRetry={start} />;
    } else if (status === 'running') {
      running = true;
      const target = own ? projectName : memberName ? `${memberName}’s copy` : 'a member’s copy';
      body = (
        <IdeFrame
          key={launchKey}
          projectId={projectId}
          owner={owner}
          copyId={copyId ?? ''}
          words={words}
          title={target ? `VS Code for ${target}` : 'VS Code'}
          onRelaunch={relaunch}
          onRestart={start}
          onLaunched={onLaunched}
        />
      );
    } else {
      // Stopped (for example after 30 idle minutes) or not started: the files are kept.
      body = (
        <Problem
          message={`${words.Ide} isn’t running. The files are kept.`}
          retryLabel="Start the IDE"
          onRetry={start}
        />
      );
    }
  }

  let heading: string;
  if (own) heading = projectName ? `IDE: ${projectName}` : 'IDE';
  else heading = memberName ? `${memberName}’s copy` : 'Member’s copy';

  return (
    <div className="flex h-dvh flex-col bg-subtle text-fg">
      <header className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-line bg-surface px-4 py-2">
        <Link to={back} className={`${linkStyle} shrink-0 text-sm`}>
          {own ? '← Back to the project' : '← Back to members'}
        </Link>
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <FocusHeading className="min-w-0 truncate text-sm font-semibold">{heading}</FocusHeading>
          {own && <HelpTip term="copy" />}
        </div>
        {running && (
          <PreviewControl
            // A template with a different port (after the repository loads) starts afresh.
            key={previewPort ?? 'none'}
            projectId={projectId}
            owner={owner}
            defaultPort={previewPort}
            ideOrigin={ideOrigin}
          />
        )}
        {own && (
          <Link
            to={newSubmissionUrl(projectId)}
            className={`${buttonStyles.primary} shrink-0 py-1`}
          >
            Submit work
          </Link>
        )}
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
      {!own && (
        <p className="shrink-0 border-b border-warning-line bg-warning-soft px-4 py-2 text-sm text-warning-strong">
          You’re working in {memberName ?? 'this member'}’s copy (their own space to work in) to
          help them. Changes you make here are theirs, and they are told you opened it.
        </p>
      )}
      {running && copy.data && (
        <AiAssistantHint
          projectId={projectId}
          status={copy.data.aiAssistant}
          memberName={own ? null : (memberName ?? 'This member')}
          canChangeSettings={
            project.data?.allowedActions.includes('project.updateSettings') ?? false
          }
        />
      )}
      {own && copy.data && <OwnCopyStrip projectId={projectId} copy={copy.data} />}
      <main className="flex min-h-0 flex-1 flex-col">{body}</main>
    </div>
  );
}
