import { z } from 'zod';

/**
 * GET /api/health — whether the API's database and Redis answer (Phase 14, for Docker
 * healthchecks). 200 when both do (`ok: true`), 503 otherwise; the body is always this shape
 * and never shows versions or secrets.
 */
export const HealthResponseSchema = z.object({
  ok: z.boolean(),
  db: z.boolean(),
  redis: z.boolean(),
});

export type HealthResponse = z.infer<typeof HealthResponseSchema>;
