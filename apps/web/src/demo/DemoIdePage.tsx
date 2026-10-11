import { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import { FocusHeading, buttonStyles, cardStyle, linkStyle } from '../components/ui';
import { apiPost } from '../lib/api';
import { errorMessage } from '../lib/formErrors';
import { useMembers, useProject } from '../lib/projects';
import { newSubmissionUrl } from '../lib/submissions';
import { DEMO_VIDEO_URL } from './DemoBanner';
import {
  PREVIEW_FRAME_URL,
  PREVIEW_OPEN,
  PREVIEW_READY,
  PREVIEW_SHOW,
  buildPreviewHtml,
  resolveCopyPath,
} from './preview';
import type { DemoCopyFile } from './server';
import {
  demoResetCount,
  markDemoPreviewSeen,
  readDemoCopy,
  saveDemoCopyFile,
  undoDemoCopyEdits,
} from './standIn';

// Monaco is large: the editor is its own chunk, loaded when the page opens.
const DemoEditor = lazy(() => import('./DemoEditor'));

/** Media of the real IDE, captured from the real system into `public/demo/`. */
const base = `${import.meta.env.BASE_URL}demo/`;
export const IDE_CLIP = { src: `${base}ide-clip.mp4`, poster: `${base}ide-poster.png` };
export const IDE_SCREENSHOTS = [
  {
    src: `${base}ide-editor.png`,
    caption: 'Your own VS Code in the browser, with the project’s files.',
  },
  { src: `${base}ide-terminal.png`, caption: 'A terminal to run the app, for example npm start.' },
  { src: `${base}ide-preview.png`, caption: 'Preview shows your app while you change it.' },
];

/** Saved this long after the last key press, like the real IDE's auto-save. */
export const AUTO_SAVE_MS = 700;

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
    : false;
}

/** A screenshot that hides itself if its file is missing. */
function Screenshot({ src, caption }: { src: string; caption: string }) {
  const [missing, setMissing] = useState(false);
  if (missing) return null;
  return (
    <figure className="space-y-1.5">
      <img
        src={src}
        alt={caption}
        loading="lazy"
        onError={() => setMissing(true)}
        className="w-full rounded-lg border border-line bg-subtle"
      />
      <figcaption className="text-sm text-fg-muted">{caption}</figcaption>
    </figure>
  );
}

/** The real IDE in a short clip and screenshots. */
function RealIdeMedia() {
  const [clipMissing, setClipMissing] = useState(false);
  return (
    <section className="space-y-4" aria-labelledby="real-ide-heading">
      <h2 id="real-ide-heading" className="text-xl font-semibold">
        What the real IDE looks like
      </h2>
      {!clipMissing && (
        <video
          src={IDE_CLIP.src}
          poster={IDE_CLIP.poster}
          autoPlay={!prefersReducedMotion()}
          muted
          loop
          playsInline
          controls
          onError={() => setClipMissing(true)}
          aria-label="A short clip of the real IDE"
          className="w-full rounded-xl border border-line bg-subtle shadow-card"
        />
      )}
      <div className="grid gap-6 sm:grid-cols-2">
        {IDE_SCREENSHOTS.map((shot) => (
          <Screenshot key={shot.src} src={shot.src} caption={shot.caption} />
        ))}
      </div>
    </section>
  );
}

function VideoLink() {
  if (!DEMO_VIDEO_URL) return null;
  return (
    <p>
      <a href={DEMO_VIDEO_URL} target="_blank" rel="noopener noreferrer" className={linkStyle}>
        Watch the video of the real system
      </a>
    </p>
  );
}

const isPage = (path: string) => /\.html?$/i.test(path);

/**
 * The visitor's page in a sandboxed frame: scripts run, but in an origin of their own
 * (no allow-same-origin), so they can't reach the app's state, storage or cookies.
 */
function Preview({
  files,
  page,
  version,
  onOpenPage,
  onShown,
}: {
  files: DemoCopyFile[];
  page: string;
  /** Changes after each save, to load the frame again. */
  version: number;
  onOpenPage: (href: string) => void;
  onShown: () => void;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const html = buildPreviewHtml(Object.fromEntries(files.map((f) => [f.path, f.content])), page);
  // The latest values, for the message listener set up once.
  const latest = useRef({ html, onOpenPage, onShown });
  useEffect(() => {
    latest.current = { html, onOpenPage, onShown };
  }, [html, onOpenPage, onShown]);

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      const source = frame.current?.contentWindow;
      if (!source || event.source !== source) return;
      const data = event.data as { type?: unknown; href?: unknown } | null;
      if (data?.type === PREVIEW_READY) {
        // The frame has an origin of its own ("null"), so the target can't be narrowed.
        source.postMessage({ type: PREVIEW_SHOW, html: latest.current.html }, '*');
        latest.current.onShown();
      } else if (data?.type === PREVIEW_OPEN && typeof data.href === 'string') {
        latest.current.onOpenPage(data.href);
      }
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  return (
    <iframe
      key={`${page}:${version}`}
      ref={frame}
      src={PREVIEW_FRAME_URL}
      title={`Preview of ${page}`}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      className="h-full w-full rounded-b-lg bg-surface"
    />
  );
}

/** The file to open first: index.html when there is one. */
function firstFile(files: DemoCopyFile[] | null): string {
  return files?.some((f) => f.path === 'index.html') ? 'index.html' : (files?.[0]?.path ?? '');
}

/** The editor, preview and file list for my own copy. */
function DemoWorkspace({ projectId }: { projectId: string }) {
  const [files, setFiles] = useState<DemoCopyFile[] | null>(() => readDemoCopy(projectId));
  const [copyError, setCopyError] = useState<string | null>(null);
  const [selected, setSelected] = useState(() => firstFile(files));
  const [page, setPage] = useState('index.html');
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [version, setVersion] = useState(0);
  // Goes up when a file changes from outside the editor (Undo my edits).
  const [revision, setRevision] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  // The edit waiting to be saved, so leaving the page or the file never loses it.
  const pending = useRef<{ path: string; content: string; resets: number } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const askedForCopy = useRef(false);

  // Like the real IDE, opening it makes my copy if I don't have one yet.
  useEffect(() => {
    if (files !== null || askedForCopy.current) return;
    askedForCopy.current = true;
    apiPost(`/api/projects/${encodeURIComponent(projectId)}/copy`)
      .then(() => {
        const made = readDemoCopy(projectId);
        setFiles(made);
        setSelected(firstFile(made));
      })
      .catch((error: unknown) => setCopyError(errorMessage(error)));
  }, [files, projectId]);

  const flush = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    const edit = pending.current;
    pending.current = null;
    // Nothing to save, or the demo was reset since (Reset demo throws edits away).
    if (edit === null || edit.resets !== demoResetCount()) return;
    if (!saveDemoCopyFile(projectId, edit.path, edit.content)) {
      setNotice('This file is too big to save in the demo.');
    }
    setFiles(readDemoCopy(projectId));
    setSaving(false);
    setVersion((v) => v + 1);
  }, [projectId]);

  // Save what's left when the page closes (for example on Submit work).
  useEffect(() => flush, [flush]);

  const onPreviewShown = useCallback(() => markDemoPreviewSeen(projectId), [projectId]);
  const onOpenPage = useCallback(
    (href: string) => {
      const path = resolveCopyPath(page, href);
      if (path !== null && isPage(path) && files?.some((f) => f.path === path)) {
        setPage(path);
        setNotice(null);
      } else {
        setNotice(
          path === null
            ? 'Links to other websites don’t open in the demo’s preview.'
            : `There is no ${path} in your copy yet.`,
        );
      }
    },
    [files, page],
  );

  if (files === null) {
    return (
      <p role="status" className="text-fg-soft">
        {copyError ?? 'Making your copy of the project…'}
      </p>
    );
  }

  const file = files.find((f) => f.path === selected) ?? null;
  const text = file ? (drafts[file.path] ?? file.content) : '';
  const hasEdits = file !== null && file.base !== null && text !== file.base;

  function open(path: string) {
    flush();
    setSelected(path);
    setNotice(null);
    if (isPage(path)) setPage(path);
  }

  function edit(path: string, content: string) {
    // Another file's edit still waiting is saved first.
    if (pending.current !== null && pending.current.path !== path) flush();
    setDrafts((d) => ({ ...d, [path]: content }));
    pending.current = { path, content, resets: demoResetCount() };
    setSaving(true);
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(flush, AUTO_SAVE_MS);
  }

  function undo() {
    if (!file || file.base === null) return;
    const mainVersion = file.base;
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    pending.current = null;
    undoDemoCopyEdits(projectId, file.path);
    setDrafts((d) => ({ ...d, [file.path]: mainVersion }));
    setFiles(readDemoCopy(projectId));
    setSaving(false);
    setVersion((v) => v + 1);
    setRevision((r) => r + 1);
  }

  const paneHeight = 'h-[26rem] lg:h-[34rem]';

  return (
    <div className="grid gap-4 lg:grid-cols-[12rem_minmax(0,1fr)_minmax(0,1fr)]">
      <nav aria-label="Files in your copy" className="min-w-0">
        <h2 className="mb-2 text-sm font-semibold text-fg-muted">Files in your copy</h2>
        <ul className="flex flex-wrap gap-1 lg:flex-col">
          {files.map((f) => {
            const current = f.path === selected;
            const changed = current ? hasEdits || (f.base === null && f.changed) : f.changed;
            return (
              <li key={f.path} className="min-w-0">
                <button
                  type="button"
                  onClick={() => open(f.path)}
                  aria-current={current ? 'true' : undefined}
                  className={`flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left font-mono text-sm focus-visible:ring-2 focus-visible:ring-accent-ring focus-visible:outline-none ${
                    current ? 'bg-accent-soft text-accent-strong' : 'hover:bg-muted'
                  }`}
                >
                  <span className="truncate">{f.path}</span>
                  {changed && (
                    <span className="ml-auto shrink-0 rounded-full border border-warning-line bg-warning-soft px-1.5 font-sans text-xs text-warning-strong">
                      changed
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      </nav>

      <section aria-label="Editor" className="min-w-0 rounded-lg border border-line bg-surface">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-3 py-2">
          <h2 className="min-w-0 truncate font-mono text-sm font-semibold">
            {file?.path ?? 'No file open'}
          </h2>
          <p role="status" className="text-xs text-fg-muted">
            {saving ? 'Saving…' : 'All changes saved'}
          </p>
          {hasEdits && (
            <button
              type="button"
              onClick={undo}
              className={`${buttonStyles.secondary} ml-auto px-2.5 py-1 text-xs`}
            >
              Undo my edits to this file
            </button>
          )}
        </div>
        <div className={paneHeight}>
          {file ? (
            <Suspense
              fallback={
                <p role="status" className="p-3 text-sm text-fg-muted">
                  Loading editor…
                </p>
              }
            >
              <DemoEditor path={file.path} value={text} revision={revision} onChange={edit} />
            </Suspense>
          ) : (
            <p className="p-3 text-sm text-fg-muted">Pick a file to change it.</p>
          )}
        </div>
      </section>

      <section aria-label="Preview" className="min-w-0 rounded-lg border border-line bg-surface">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-3 py-2">
          <h2 className="text-sm font-semibold">
            Preview: <span className="font-mono">{page}</span>
          </h2>
          <p className="text-xs text-fg-muted">Updates each time your work is saved.</p>
        </div>
        {notice && (
          <p role="status" className="border-b border-line px-3 py-1.5 text-xs text-fg-soft">
            {notice}
          </p>
        )}
        <div className={paneHeight}>
          <Preview
            files={files}
            page={page}
            version={version}
            onOpenPage={onOpenPage}
            onShown={onPreviewShown}
          />
        </div>
      </section>
    </div>
  );
}

/**
 * The IDE page in the demo. The real page starts a VS Code container on the server, which the
 * demo doesn't have. So it says so, offers a simple editor with a live preview of the visitor's
 * copy instead, and shows the real IDE in a short clip and screenshots.
 */
export function DemoIdePage() {
  const params = useParams();
  const projectId = params.projectId ?? '';
  const memberId = params.userId ?? null;
  const project = useProject(projectId);
  const members = useMembers(projectId, memberId !== null);

  const memberName = members.data?.find((m) => m.userId === memberId)?.name ?? null;
  const heading =
    memberId === null
      ? project.data
        ? `IDE: ${project.data.name}`
        : 'IDE'
      : memberName
        ? `${memberName}’s copy`
        : 'Member’s copy';
  const back = memberId === null ? `/projects/${projectId}` : `/projects/${projectId}/members`;

  return (
    <div className="min-h-screen bg-canvas text-fg">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line bg-surface px-4 py-2">
        <Link to={back} className={`${linkStyle} shrink-0 text-sm`}>
          {memberId === null ? '← Back to the project' : '← Back to members'}
        </Link>
        <FocusHeading className="min-w-0 flex-1 truncate text-sm font-semibold">
          {heading}
        </FocusHeading>
        {memberId === null && (
          <Link
            to={newSubmissionUrl(projectId)}
            className={`${buttonStyles.primary} shrink-0 py-1`}
          >
            Submit work
          </Link>
        )}
      </header>
      {memberId === null ? (
        <main className="mx-auto max-w-[100rem] space-y-6 px-4 py-6">
          <section className={`${cardStyle} space-y-2`} aria-labelledby="demo-ide-heading">
            <h2 id="demo-ide-heading" className="text-xl font-semibold">
              In the real DevSpace, your own VS Code opens here
            </h2>
            <p className="text-fg-soft">
              The demo has no server, so here is a simple editor instead. Change a file (try{' '}
              <span className="font-mono">index.html</span> or{' '}
              <span className="font-mono">style.css</span>), see it in Preview, then click{' '}
              <strong>Submit work</strong> to send your change for review. Your work is saved as you
              type, until you close this tab.
            </p>
            <VideoLink />
          </section>
          <DemoWorkspace projectId={projectId} />
          <RealIdeMedia />
        </main>
      ) : (
        <main className="mx-auto max-w-3xl space-y-6 px-4 py-8">
          <section className={`${cardStyle} space-y-3`} aria-labelledby="demo-ide-heading">
            <h2 id="demo-ide-heading" className="text-xl font-semibold">
              In the real DevSpace, your own VS Code opens here
            </h2>
            <p className="text-fg-soft">
              Everyone in a project gets their own copy of the files and a full VS Code in the
              browser, running on the server in its own private container. Leaders can open a
              member’s copy like this to help them, for example to fix a clash with main.
            </p>
            <p className="text-fg-soft">The demo has no server, so the IDE can’t open here.</p>
            <VideoLink />
          </section>
          <RealIdeMedia />
        </main>
      )}
    </div>
  );
}
