import { Router, type Request } from 'express';
import {
  AiConnectFinishRequestSchema,
  AiConnectStartResponseSchema,
  AiModelListResponseSchema,
  AiNoticeAcceptResponseSchema,
  CreateAiReviewRequestSchema,
} from '@devspace/shared';
import { env } from '../config/env.ts';
import { hashSessionToken, readSessionToken, type AuthUser } from '../auth/session.ts';
import { HttpError } from '../lib/http-error.ts';
import { parseBody } from '../lib/validate.ts';
import { requireProjectAction } from '../projects/access.ts';
import {
  acceptNotice,
  connectionView,
  disconnect,
  finishConnect,
  listModels,
  startConnect,
} from './connection.ts';
import { writeIdeReview } from './ide-review.ts';
import { listAiReviews, requestCrossReview } from './reviews.ts';

/** /api/ai (after requireAuth): the member's OpenRouter connection, notice and model list. */
export const aiRouter = Router();

function sessionIdOf(req: Request): string {
  const token = readSessionToken(req.cookies);
  if (!token) throw new HttpError(401, 'unauthenticated', 'Not logged in');
  return hashSessionToken(token);
}

aiRouter.post('/openrouter/start', async (req, res) => {
  const user = req.user as AuthUser;
  const url = await startConnect(user.id, sessionIdOf(req));
  res.json(AiConnectStartResponseSchema.parse({ url }));
});

aiRouter.post('/openrouter/finish', async (req, res) => {
  const user = req.user as AuthUser;
  const { code, state } = parseBody(AiConnectFinishRequestSchema, req.body);
  await finishConnect(user.id, sessionIdOf(req), code, state);
  res.json(await connectionView(user.id));
});

aiRouter.get('/connection', async (req, res) => {
  res.json(await connectionView((req.user as AuthUser).id));
});

aiRouter.delete('/connection', async (req, res) => {
  await disconnect((req.user as AuthUser).id);
  res.status(204).end();
});

aiRouter.post('/notice/accept', async (req, res) => {
  const at = await acceptNotice((req.user as AuthUser).id);
  res.json(AiNoticeAcceptResponseSchema.parse({ noticeAcceptedAt: at.toISOString() }));
});

aiRouter.get('/models', async (_req, res) => {
  res.json(
    AiModelListResponseSchema.parse({
      models: await listModels(),
      defaults: env.AI_DEFAULT_MODELS,
      fallbacks: env.AI_FALLBACK_MODELS,
    }),
  );
});

/** Mounted at /api/projects/:projectId (after requireAuth). Membership is checked first (404). */
export const aiSubmissionRouter = Router({ mergeParams: true });

function param(req: Request, name: string): string {
  const value = req.params[name];
  return typeof value === 'string' ? value : '';
}

aiSubmissionRouter.get('/submissions/:id/ai-reviews', async (req, res) => {
  const access = await requireProjectAction(req);
  res.json(await listAiReviews(access, param(req, 'id')));
});

aiSubmissionRouter.post('/submissions/:id/ai-reviews', async (req, res) => {
  const access = await requireProjectAction(req);
  const body = parseBody(CreateAiReviewRequestSchema, req.body ?? {});
  res.status(201).json(await requestCrossReview(access, param(req, 'id'), body));
});

aiSubmissionRouter.post('/submissions/:id/ide-review', async (req, res) => {
  const access = await requireProjectAction(req);
  const user = req.user as AuthUser;
  const result = await writeIdeReview(
    access,
    { id: user.id, name: user.name, email: user.email },
    param(req, 'id'),
  );
  res.status(201).json(result);
});
