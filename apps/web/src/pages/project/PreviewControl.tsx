import { useId, useRef, useState } from 'react';
import { PreviewPortSchema } from '@devspace/shared';
import { HelpTip } from '../../components/HelpTip';
import { buttonStyles, linkStyle } from '../../components/ui';
import { safePreviewUrl, useLaunchPreview, type CopyOwner } from '../../lib/copies';
import { errorCode, errorMessage } from '../../lib/formErrors';

/** Clear words for a failed preview launch. */
function previewErrorMessage(error: unknown): string {
  switch (errorCode(error)) {
    case 'ide_not_running':
      return 'The IDE isn’t running any more. Start it again, then click Preview.';
    case 'validation_error':
      return 'Pick a port from 1024 to 65535 (3000 is used by the IDE).';
    default:
      return `Couldn’t open the preview. ${errorMessage(error)}`;
  }
}

/**
 * The IDE toolbar's Preview button (Phase 11): opens the app running in the copy's container on
 * the chosen port in a new tab. The port starts at the template's `previewPort`; with none, the
 * port field shows after the first click. The launch URL is opened only when it's an absolute
 * http(s) URL on the IDE's site (`ideOrigin`, known once the IDE has launched).
 */
export function PreviewControl({
  projectId,
  owner,
  defaultPort,
  ideOrigin,
}: {
  projectId: string;
  owner: CopyOwner;
  defaultPort: number | null;
  ideOrigin: string | null;
}) {
  const launch = useLaunchPreview(projectId, owner);
  const [port, setPort] = useState(defaultPort === null ? '' : String(defaultPort));
  const [showPort, setShowPort] = useState(defaultPort !== null);
  const [problem, setProblem] = useState<string | null>(null);
  // When the browser blocks the new tab, a link the member can click instead.
  const [fallbackUrl, setFallbackUrl] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const id = useId();

  function openPreview() {
    setProblem(null);
    setFallbackUrl(null);
    if (!showPort) {
      setShowPort(true);
      // Wait for the field to appear.
      setTimeout(() => inputRef.current?.focus(), 0);
      return;
    }
    const checked = PreviewPortSchema.safeParse(port.trim() === '' ? NaN : Number(port));
    if (!checked.success) {
      setProblem(
        port.trim() === ''
          ? 'Type the port your app uses (for example 8080), then click Preview.'
          : 'Pick a port from 1024 to 65535 (3000 is used by the IDE).',
      );
      inputRef.current?.focus();
      return;
    }
    // Open the tab now, while the click still counts, so the browser doesn't block it. It
    // can't reach back into this page.
    const tab = window.open('about:blank', '_blank');
    if (tab) tab.opener = null;
    launch.mutate(checked.data, {
      onSuccess: (url) => {
        const safe = safePreviewUrl(url, ideOrigin);
        if (!safe) {
          tab?.close();
          setProblem('DevSpace got an unexpected preview address, so it wasn’t opened.');
          return;
        }
        if (tab) tab.location.href = safe;
        else setFallbackUrl(safe);
      },
      onError: (error) => {
        tab?.close();
        setProblem(previewErrorMessage(error));
      },
    });
  }

  return (
    <div className="relative flex shrink-0 items-center gap-2">
      {showPort && (
        <label htmlFor={id} className="flex items-center gap-1 text-sm text-fg-soft">
          Port
          <input
            ref={inputRef}
            id={id}
            type="number"
            inputMode="numeric"
            min={1024}
            max={65535}
            value={port}
            onChange={(event) => setPort(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') openPreview();
            }}
            aria-invalid={problem ? true : undefined}
            className="w-20 rounded-lg border border-line-strong bg-surface px-2 py-1 text-sm focus:border-accent focus:ring-4 focus:ring-accent-ring/40 focus:outline-none"
          />
        </label>
      )}
      <button
        type="button"
        className={`${buttonStyles.secondary} py-1`}
        disabled={launch.isPending || ideOrigin === null}
        aria-busy={launch.isPending || undefined}
        onClick={openPreview}
      >
        Preview
      </button>
      <HelpTip label="Preview">
        Preview shows the app running in your copy in a new tab. First start it in the IDE’s
        terminal (the README says how, for example <code>npm start</code>), then click Preview. Apps
        that load files with paths starting with “/” (like <code>/style.css</code>) may not show
        correctly here; the starter templates are set up to work.
      </HelpTip>
      {(problem || fallbackUrl) && (
        <div className="absolute top-full right-0 z-20 mt-2 w-[min(20rem,calc(100vw-2rem))] rounded-lg border border-line bg-surface p-3 text-sm shadow-pop">
          {problem && (
            <p role="alert" className="text-danger-fg">
              {problem}
            </p>
          )}
          {fallbackUrl && (
            <p role="status" className="text-fg">
              Your browser blocked the new tab.{' '}
              <a
                href={fallbackUrl}
                target="_blank"
                rel="noopener noreferrer"
                className={linkStyle}
                onClick={() => setFallbackUrl(null)}
              >
                Open the preview
              </a>
            </p>
          )}
          <button
            type="button"
            className={`${buttonStyles.secondary} mt-2 py-1`}
            onClick={() => {
              setProblem(null);
              setFallbackUrl(null);
            }}
          >
            Dismiss
          </button>
        </div>
      )}
    </div>
  );
}
