import { z } from 'zod';

/** GET /api/health — 200 when the API and database are up, 503 otherwise. */
export const HealthResponseSchema = z.object({
  status: z.enum(['ok', 'error']),
  database: z.enum(['ok', 'error']),
});

export type HealthResponse = z.infer<typeof HealthResponseSchema>;
