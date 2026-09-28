import { z } from 'zod';

/** Body of every non-2xx API response. `fields` maps a request field to its problems. */
export const ErrorResponseSchema = z.object({
  error: z.string(),
  message: z.string(),
  fields: z.record(z.string(), z.array(z.string())).optional(),
  /** Extra facts about some errors, e.g. `file_in_open_submission`: `{ paths, submissionId }`. */
  details: z.record(z.string(), z.unknown()).optional(),
});

export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;
