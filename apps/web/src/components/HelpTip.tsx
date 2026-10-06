import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { GLOSSARY, type GlossaryKey } from '../lib/glossary';

type Props =
  | { term: GlossaryKey; label?: string; children?: undefined }
  | { term?: undefined; label: string; children: ReactNode };

/**
 * A small "?" button that shows a short explanation (a toggletip). It opens on click, Enter or
 * Space, and closes on Escape (focus back on the button), on a second click, or on a click or
 * focus outside. The text sits in a polite live region, so screen readers read it when it opens.
 *
 * Put it next to a heading, never inside one, so the heading's accessible name stays the same.
 */
export function HelpTip(props: Props) {
  const entry = props.term ? GLOSSARY[props.term] : null;
  const label = props.label ?? entry?.term ?? '';
  const text: ReactNode = entry ? entry.help : props.children;

  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    const outside = (event: Event) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      buttonRef.current?.focus();
    };
    document.addEventListener('mousedown', outside);
    document.addEventListener('focusin', outside);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', outside);
      document.removeEventListener('focusin', outside);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <span ref={rootRef} className="relative inline-flex align-middle">
      <button
        ref={buttonRef}
        type="button"
        aria-label={`Explain “${label}”`}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((value) => !value)}
        className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-line-strong bg-surface text-xs font-semibold text-fg-soft hover:bg-muted focus-visible:ring-2 focus-visible:ring-accent-ring focus-visible:outline-none"
      >
        ?
      </button>
      {/* A live region without the status role, so pages keep a single "status" to find. */}
      <span id={id} aria-live="polite" className="contents">
        {open && (
          <span
            data-testid="help-tip"
            className="absolute top-6 left-0 z-30 block w-[min(18rem,calc(100vw-2rem))] rounded-lg border border-line bg-surface p-3 text-left text-sm font-normal text-fg shadow-pop"
          >
            {text}
          </span>
        )}
      </span>
    </span>
  );
}
