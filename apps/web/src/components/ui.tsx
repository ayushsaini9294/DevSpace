import { useEffect, useRef, type ReactNode } from 'react';
import { errorMessage } from '../lib/formErrors';
import { FormAlert } from './AuthPageShell';

const buttonBase =
  'inline-flex items-center justify-center gap-1.5 rounded-lg px-3.5 py-2 text-sm font-semibold shadow-card focus-visible:ring-4 focus-visible:outline-none active:translate-y-px disabled:cursor-not-allowed disabled:opacity-60 disabled:active:translate-y-0';

export const buttonStyles = {
  primary: `${buttonBase} bg-accent text-on-accent hover:bg-accent-hover focus-visible:ring-accent-ring/50`,
  secondary: `${buttonBase} border border-line-strong bg-surface text-fg hover:bg-muted focus-visible:ring-accent-ring/50`,
  danger: `${buttonBase} bg-danger-solid text-on-accent hover:bg-danger-solid-hover focus-visible:ring-danger-ring/50`,
  dangerOutline: `${buttonBase} border border-danger-line bg-surface text-danger-fg hover:bg-danger-soft focus-visible:ring-danger-ring/50`,
};

export const linkStyle =
  'font-medium text-accent-fg underline decoration-accent-line underline-offset-2 hover:text-accent-strong hover:decoration-current';

export const cardStyle = 'rounded-xl border border-line bg-surface p-4 shadow-card sm:p-6';

/**
 * A heading that takes focus when it appears, so screen-reader and keyboard users land on the
 * new page's title after a client-side navigation.
 */
export function FocusHeading({
  level = 1,
  className,
  children,
}: {
  level?: 1 | 2;
  className?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
  }, []);
  const Tag = level === 1 ? 'h1' : 'h2';
  const defaultClass =
    level === 1 ? 'text-2xl font-bold tracking-tight break-words' : 'text-xl font-semibold';
  return (
    <Tag ref={ref} tabIndex={-1} className={`${className ?? defaultClass} focus:outline-none`}>
      {children}
    </Tag>
  );
}

export function Loading({ children }: { children: ReactNode }) {
  return (
    <p role="status" className="text-sm text-fg-muted">
      {children}
    </p>
  );
}

/** A failed query: the real error, and a way to try again. */
export function LoadError({
  what,
  error,
  onRetry,
}: {
  what: string;
  error: unknown;
  onRetry: () => void;
}) {
  return (
    <div className="space-y-2">
      <FormAlert>
        Could not load {what}. {errorMessage(error)}
      </FormAlert>
      <button type="button" className={buttonStyles.secondary} onClick={onRetry}>
        Try again
      </button>
    </div>
  );
}

/** A small success note, announced politely. */
export function SuccessNote({ children }: { children: ReactNode }) {
  return (
    <p role="status" className="text-sm font-medium text-success-fg">
      {children}
    </p>
  );
}
