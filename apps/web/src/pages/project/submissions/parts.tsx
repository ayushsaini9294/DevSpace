import { useEffect, useId, useRef, type FormEvent, type ReactNode } from 'react';
import type { FileChange, SubmissionStatus } from '@devspace/shared';
import { FormAlert } from '../../../components/AuthPageShell';
import { buttonStyles } from '../../../components/ui';
import { CHANGE_LABELS, STATUS_LABELS, STATUS_STYLES } from '../../../lib/submissions';

export function StatusBadge({ status, testId }: { status: SubmissionStatus; testId?: string }) {
  return (
    <span
      data-testid={testId}
      className={`inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-xs font-semibold ${STATUS_STYLES[status]}`}
    >
      {STATUS_LABELS[status]}
    </span>
  );
}

const CHANGE_STYLES: Record<FileChange, string> = {
  added: 'text-green-800',
  modified: 'text-amber-800',
  deleted: 'text-red-800',
};

export function ChangeLabel({ change }: { change: FileChange }) {
  return (
    <span className={`shrink-0 text-xs font-semibold uppercase ${CHANGE_STYLES[change]}`}>
      {CHANGE_LABELS[change]}
    </span>
  );
}

/** A small grey tag, e.g. "Outdated" or "Stale". */
export function Tag({ children, tone = 'gray' }: { children: ReactNode; tone?: 'gray' | 'amber' }) {
  const style =
    tone === 'amber'
      ? 'border-amber-300 bg-amber-50 text-amber-900'
      : 'border-gray-300 bg-gray-100 text-gray-700';
  return (
    <span className={`inline-flex items-center rounded border px-1.5 text-xs font-medium ${style}`}>
      {children}
    </span>
  );
}

export const textAreaStyle =
  'block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-base shadow-sm focus:border-blue-600 focus:ring-2 focus:ring-blue-200 focus:outline-none';

/** A labelled multi-line field. */
export function TextArea({
  label,
  value,
  onChange,
  rows = 4,
  error,
  autoFocus,
  mono = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  rows?: number;
  error?: string | undefined;
  autoFocus?: boolean;
  mono?: boolean;
}) {
  const id = useId();
  const errorId = `${id}-error`;
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block text-sm font-medium text-gray-800">
        {label}
      </label>
      <textarea
        id={id}
        rows={rows}
        value={value}
        autoFocus={autoFocus}
        onChange={(event) => onChange(event.currentTarget.value)}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        className={`${textAreaStyle} ${mono ? 'font-mono text-sm' : ''}`}
      />
      {error && (
        <p id={errorId} className="text-sm text-red-700">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * A modal dialog with a form: Escape or Cancel closes it, focus moves into it when it opens
 * and back to what had focus when it closes.
 */
export function Dialog({
  title,
  onClose,
  onSubmit,
  confirmLabel,
  confirmStyle = buttonStyles.primary,
  pending,
  error,
  children,
}: {
  title: string;
  onClose: () => void;
  onSubmit: () => void;
  confirmLabel: string;
  confirmStyle?: string;
  pending: boolean;
  error: string | null;
  children?: ReactNode;
}) {
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const first = panel.current?.querySelector<HTMLElement>('textarea, input, button[type=submit]');
    first?.focus();
    return () => opener?.focus?.();
  }, []);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!pending) onSubmit();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={(event) => {
          if (event.key === 'Escape') onClose();
        }}
        className="w-full max-w-lg rounded-lg bg-white p-4 shadow-lg sm:p-6"
      >
        <form onSubmit={handleSubmit} className="space-y-4">
          <h2 id={titleId} className="text-lg font-semibold">
            {title}
          </h2>
          {children}
          {error && <FormAlert>{error}</FormAlert>}
          <div className="flex flex-wrap justify-end gap-2">
            <button type="button" className={buttonStyles.secondary} onClick={onClose}>
              Cancel
            </button>
            <button
              type="submit"
              disabled={pending}
              aria-busy={pending || undefined}
              className={confirmStyle}
            >
              {confirmLabel}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
