import { z } from 'zod';

/**
 * The getting-started checklist (Phase 11). Every step is computed from real data; nothing is
 * ticked by hand.
 * - `setup` (leaders and co-leaders): the repository is ready.
 * - `invite` (leaders and co-leaders): at least one other member, or a pending invitation.
 * - `openIde`: your copy's IDE has been started at least once.
 * - `change`: your copy has changes, or you have any submission.
 * - `preview`: you launched a preview at least once.
 * - `submit`: you have a submission.
 * - `reviewed`: one of your submissions got a review or comment from someone else, or was merged.
 */
export const GETTING_STARTED_STEPS = [
  'setup',
  'invite',
  'openIde',
  'change',
  'preview',
  'submit',
  'reviewed',
] as const;

export const GettingStartedStepIdSchema = z.enum(GETTING_STARTED_STEPS);

export const GettingStartedStepSchema = z.object({
  id: GettingStartedStepIdSchema,
  done: z.boolean(),
});

/**
 * GET /api/projects/:projectId/getting-started — any member (404 `not_found` otherwise).
 * `steps` are in the order above; leaders and co-leaders get all seven, everyone else the last
 * five. `hidden` = the member hid the card.
 *
 * POST /api/projects/:projectId/getting-started/hide and …/show (no body) → the same view with
 * `hidden` true or false. The web app shows "You're all set!" once when every step is done,
 * then calls hide.
 */
export const GettingStartedViewSchema = z.object({
  hidden: z.boolean(),
  steps: z.array(GettingStartedStepSchema),
});

export type GettingStartedStepId = z.infer<typeof GettingStartedStepIdSchema>;
export type GettingStartedStep = z.infer<typeof GettingStartedStepSchema>;
export type GettingStartedView = z.infer<typeof GettingStartedViewSchema>;
