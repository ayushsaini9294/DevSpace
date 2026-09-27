import { useEffect, useRef, type ReactNode } from 'react';
import { errorMessage } from '../lib/formErrors';
import { FormAlert } from './AuthPageShell';

const buttonBase =
  'inline-flex items-center justify-center rounded-md px-3 py-2 text-sm font-medium focus-visible:ring-2 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60';

export const buttonStyles = {
  primary: `${buttonBase} bg-blue-700 text-white hover:bg-blue-800 focus-visible:ring-blue-300`,
  secondary: `${buttonBase} border border-gray-300 bg-white text-gray-800 hover:bg-gray-100 focus-visible:ring-blue-300`,
  danger: `${buttonBase} bg-red-700 text-white hover:bg-red-800 focus-visible:ring-red-300`,
  dangerOutline: `${buttonBase} border border-red-300 bg-white text-red-800 hover:bg-red-50 focus-visible:ring-red-300`,
};

export const linkStyle = 'font-medium text-blue-700 underline hover:text-blue-900';

export const cardStyle = 'rounded-lg border border-gray-200 bg-white p-4 shadow-sm sm:p-6';

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
    <p role="status" className="text-sm text-gray-600">
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
    <p role="status" className="text-sm font-medium text-green-800">
      {children}
    </p>
  );
}
