import { useId, type InputHTMLAttributes } from 'react';

type TextFieldProps = {
  label: string;
  name: string;
  /** Problem with the current value, shown under the input. */
  error?: string | undefined;
  /** Announce the error immediately (used for errors that arrive from the server). */
  errorIsAlert?: boolean;
} & Pick<
  InputHTMLAttributes<HTMLInputElement>,
  'type' | 'autoComplete' | 'required' | 'defaultValue' | 'value' | 'onChange' | 'readOnly'
>;

export function TextField({
  label,
  name,
  error,
  errorIsAlert = false,
  type = 'text',
  ...inputProps
}: TextFieldProps) {
  const inputId = useId();
  const errorId = `${inputId}-error`;
  return (
    <div className="space-y-1">
      <label htmlFor={inputId} className="block text-sm font-medium text-gray-800">
        {label}
      </label>
      <input
        id={inputId}
        name={name}
        type={type}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        className={`block w-full rounded-md border bg-white px-3 py-2 text-base shadow-sm focus:ring-2 focus:outline-none ${
          error
            ? 'border-red-600 focus:border-red-600 focus:ring-red-200'
            : 'border-gray-300 focus:border-blue-600 focus:ring-blue-200'
        }`}
        {...inputProps}
      />
      {error && (
        <p id={errorId} role={errorIsAlert ? 'alert' : undefined} className="text-sm text-red-700">
          {error}
        </p>
      )}
    </div>
  );
}
