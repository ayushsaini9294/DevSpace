import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { FocusHeading, buttonStyles, cardStyle, linkStyle } from '../components/ui';
import { useMembers, useProject } from '../lib/projects';
import { newSubmissionUrl } from '../lib/submissions';
import { DEMO_VIDEO_URL } from './DemoBanner';

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

/**
 * The IDE page in the demo. The real page starts a VS Code container on the server, which the
 * demo doesn't have, so it says so and shows the real IDE in a short clip and screenshots.
 */
export function DemoIdePage() {
  const params = useParams();
  const projectId = params.projectId ?? '';
  const memberId = params.userId ?? null;
  const project = useProject(projectId);
  const members = useMembers(projectId, memberId !== null);
  const [clipMissing, setClipMissing] = useState(false);

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
      <main className="mx-auto max-w-3xl space-y-6 px-4 py-8">
        <section className={`${cardStyle} space-y-3`} aria-labelledby="demo-ide-heading">
          <h2 id="demo-ide-heading" className="text-xl font-semibold">
            In the real DevSpace, your own VS Code opens here
          </h2>
          <p className="text-fg-soft">
            Everyone in a project gets their own copy of the files and a full VS Code in the
            browser, running on the server in its own private container. You edit, run the app in
            the terminal and preview it, then click <strong>Submit work</strong> to send your
            changes for review.
          </p>
          <p className="text-fg-soft">
            The demo has no server, so the IDE can’t open here. This is what it looks like:
          </p>
          {DEMO_VIDEO_URL && (
            <p>
              <a
                href={DEMO_VIDEO_URL}
                target="_blank"
                rel="noopener noreferrer"
                className={linkStyle}
              >
                Watch the video of the real system
              </a>
            </p>
          )}
        </section>
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
      </main>
    </div>
  );
}
