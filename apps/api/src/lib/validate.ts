import { z } from 'zod';
import { HttpError } from './http-error.ts';

/**
 * Parses `input` with `schema`, or throws a 400 `validation_error` whose `fields` maps each
 * top-level request field to its messages.
 */
export function parseBody<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (result.success) return result.data;

  const fields: Record<string, string[]> = {};
  for (const issue of result.error.issues) {
    const key = issue.path[0];
    if (key === undefined) continue;
    (fields[String(key)] ??= []).push(issue.message);
  }
  const hasFields = Object.keys(fields).length > 0;
  throw new HttpError(
    400,
    'validation_error',
    hasFields ? 'Some fields are invalid' : 'Request body is invalid',
    hasFields ? fields : undefined,
  );
}
