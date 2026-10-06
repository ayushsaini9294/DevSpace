import { useId, type InputHTMLAttributes } from 'react';

type TextFieldProps = {
  label: string;
  name: string;
  /** Problem with the current value, shown under the input. */
  error?: string | undefined;
  /** Announce the error immediately (used for errors that arrive from the server). */
  errorIsAlert?: boolean;
  /** Extra guidance shown under the label. */
  hint?: string;
} & Pick<
  InputHTMLAttributes<HTMLInputElement>,
  'type' | 'autoComplete' | 'required' | 'defaultValue' | 'value' | 'onChange' | 'readOnly'
>;

export function TextField({
  label,
  name,
  error,
  errorIsAlert = false,
  hint,
  type = 'text',
  ...inputProps
}: TextFieldProps) {
  const inputId = useId();
  const errorId = `${inputId}-error`;
  const hintId = `${inputId}-hint`;
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ');
  return (
    <div className="space-y-1">
      <label htmlFor={inputId} className="block text-sm font-medium text-fg">
        {label}
      </label>
      {hint && (
        <p id={hintId} className="text-sm text-fg-muted">
          {hint}
        </p>
      )}
      <input
        id={inputId}
        name={name}
        type={type}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy || undefined}
        className={`block w-full rounded-lg border bg-surface px-3 py-2 text-base shadow-card focus:outline-none ${
          error
            ? 'border-danger-solid focus:border-danger-solid focus:ring-4 focus:ring-danger-ring/40'
            : 'border-line-strong focus:border-accent focus:ring-4 focus:ring-accent-ring/40'
        }`}
        {...inputProps}
      />
      {error && (
        <p
          id={errorId}
          role={errorIsAlert ? 'alert' : undefined}
          className="text-sm text-danger-fg"
        >
          {error}
        </p>
      )}
    </div>
  );
}
