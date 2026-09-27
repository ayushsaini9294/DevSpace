import { useState, type FormEvent } from 'react';
import type { ZodType } from 'zod';
import { describeServerError } from '../lib/formErrors';
import { FormAlert } from './AuthPageShell';
import { TextField } from './TextField';
import { buttonStyles } from './ui';

const FIELDS = ['name'] as const;

/**
 * A one-field form for a team or project name (create or rename). Validates with the shared
 * schema, then calls `onValid`; server errors from the mutation are shown on the field or above
 * the button.
 */
export function NameForm({
  label,
  submitLabel,
  schema,
  pending,
  error,
  onValid,
  onEdit,
  defaultValue,
}: {
  label: string;
  submitLabel: string;
  schema: ZodType<{ name: string }>;
  pending: boolean;
  /** The last failed request, if any. */
  error: unknown;
  onValid: (name: string) => void;
  /** Called when the value fails local validation, e.g. to clear an old server error. */
  onEdit?: () => void;
  defaultValue?: string;
}) {
  const [clientError, setClientError] = useState<string | undefined>();
  const server = describeServerError(error, FIELDS);
  const fieldError = clientError ?? server.fieldErrors.name;

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const result = schema.safeParse({ name: String(new FormData(form).get('name') ?? '') });
    if (!result.success) {
      onEdit?.();
      setClientError(result.error.issues[0]?.message ?? 'Enter a name');
      const input = form.elements.namedItem('name');
      if (input instanceof HTMLInputElement) input.focus();
      return;
    }
    setClientError(undefined);
    onValid(result.data.name);
  }

  return (
    <form noValidate onSubmit={handleSubmit} className="space-y-3">
      <TextField
        label={label}
        name="name"
        required
        autoComplete="off"
        defaultValue={defaultValue}
        error={fieldError}
        errorIsAlert={!clientError && Boolean(server.fieldErrors.name)}
      />
      {server.formError && !server.fieldErrors.name && <FormAlert>{server.formError}</FormAlert>}
      <button
        type="submit"
        disabled={pending}
        aria-busy={pending || undefined}
        className={buttonStyles.primary}
      >
        {submitLabel}
      </button>
    </form>
  );
}
