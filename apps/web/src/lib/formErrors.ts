import { ZodError, type ZodType } from 'zod';
import { ApiError, RATE_LIMITED_MESSAGE } from './api';

export type FieldErrors<F extends string> = Partial<Record<F, string>>;

type ClientResult<T, F extends string> =
  { ok: true; data: T } | { ok: false; errors: FieldErrors<F>; firstField: F };

/** Validate form values with a shared schema, keeping the first message for each field. */
export function validateForm<T, F extends string>(
  schema: ZodType<T>,
  values: Record<F, string>,
  fields: readonly F[],
  messages: Partial<Record<F, (value: string) => string>> = {},
): ClientResult<T, F> {
  const result = schema.safeParse(values);
  if (result.success) return { ok: true, data: result.data };

  const errors: FieldErrors<F> = {};
  for (const issue of result.error.issues) {
    const field = fields.find((f) => f === issue.path[0]);
    if (!field || errors[field]) continue;
    const custom = messages[field];
    errors[field] = custom ? custom(values[field]) : issue.message;
  }
  const firstField = fields.find((f) => errors[f]) ?? fields[0]!;
  return { ok: false, errors, firstField };
}

export type ServerErrors<F extends string> = {
  fieldErrors: FieldErrors<F>;
  /** A field whose error should be announced as an alert (e.g. email_taken). */
  alertField: F | null;
  /** Form-level message, shown in an alert above the button. */
  formError: string | null;
};

const noErrors = { fieldErrors: {}, alertField: null, formError: null };

/** Map a failed auth request onto the form's fields and a form-level message. */
export function describeServerError<F extends string>(
  error: unknown,
  fields: readonly F[],
): ServerErrors<F> {
  if (!error) return noErrors;

  if (error instanceof ApiError) {
    const body = error.errorResponse;
    // Too many tries (`rate_limited`): the API's own message (never per-field), or the same words
    // if the 429 came without its usual body.
    if (error.status === 429) {
      return { ...noErrors, formError: body?.message ?? RATE_LIMITED_MESSAGE };
    }
    if (!body) {
      return {
        ...noErrors,
        formError: `Something went wrong (status ${error.status}). Please try again.`,
      };
    }
    const fieldErrors: FieldErrors<F> = {};
    const emailField = fields.find((f) => f === 'email');
    if (body.error === 'email_taken' && emailField) {
      fieldErrors[emailField] = body.message;
      return { fieldErrors, alertField: emailField, formError: null };
    }
    for (const [key, problems] of Object.entries(body.fields ?? {})) {
      const field = fields.find((f) => f === key);
      if (field && problems[0]) fieldErrors[field] = problems[0];
    }
    return { fieldErrors, alertField: null, formError: body.message };
  }

  if (error instanceof ZodError) {
    return { ...noErrors, formError: 'The server sent an unexpected response. Please try again.' };
  }
  return {
    ...noErrors,
    formError: 'Could not reach the server. Check your connection and try again.',
  };
}

/** One sentence for any failed request, for a form-level or action alert. */
export function errorMessage(error: unknown): string {
  return (
    describeServerError(error, [] as const).formError ?? 'Something went wrong. Please try again.'
  );
}

/** The server's error code (e.g. `invitation_expired`), if the failure was an API error. */
export function errorCode(error: unknown): string | null {
  return error instanceof ApiError ? (error.errorResponse?.error ?? null) : null;
}

export function isNotFound(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404;
}
