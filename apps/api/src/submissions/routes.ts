import { Router, type Request } from 'express';
import {
  CommentResponseSchema,
  CreateCommentRequestSchema,
  CreateReviewRequestSchema,
  CreateSubmissionRequestSchema,
  RejectSubmissionRequestSchema,
  SubmissionFileQuerySchema,
  SubmissionListQuerySchema,
  SubmissionListResponseSchema,
  SubmissionResponseSchema,
  SuggestionDecisionRequestSchema,
  UpdateSubmissionRequestSchema,
} from '@devspace/shared';
import type { AuthUser } from '../auth/session.ts';
import { parseBody } from '../lib/validate.ts';
import { requireProjectAction } from '../projects/access.ts';
import {
  addComment,
  addReview,
  closeSubmission,
  copyChanges,
  createSubmission,
  listSubmissions,
  rejectSubmission,
  respondToSuggestion,
  submissionDetail,
  submissionFile,
  updateSubmission,
  type Author,
} from './service.ts';

/**
 * Mounted at /api/projects/:projectId (after requireAuth). Every route needs project
 * membership (404 otherwise); the finer rules are checked in the service.
 */
export const submissionsRouter = Router({ mergeParams: true });

function author(req: Request): Author {
  const user = req.user as AuthUser;
  return { id: user.id, name: user.name, email: user.email };
}

function param(req: Request, name: string): string {
  const value = req.params[name];
  return typeof value === 'string' ? value : '';
}

async function respond(access: Awaited<ReturnType<typeof requireProjectAction>>, id: string) {
  return SubmissionResponseSchema.parse({ submission: await submissionDetail(access, id) });
}

submissionsRouter.get('/copy/changes', async (req, res) => {
  const access = await requireProjectAction(req);
  res.json(await copyChanges(access));
});

submissionsRouter.post('/submissions', async (req, res) => {
  const access = await requireProjectAction(req);
  const input = parseBody(CreateSubmissionRequestSchema, req.body);
  const id = await createSubmission(access, author(req), input);
  res.status(201).json(await respond(access, id));
});

submissionsRouter.get('/submissions', async (req, res) => {
  const access = await requireProjectAction(req);
  const { status } = parseBody(SubmissionListQuerySchema, req.query);
  res.json(SubmissionListResponseSchema.parse(await listSubmissions(access, status)));
});

submissionsRouter.get('/submissions/:submissionId', async (req, res) => {
  const access = await requireProjectAction(req);
  res.json(await respond(access, param(req, 'submissionId')));
});

submissionsRouter.get('/submissions/:submissionId/file', async (req, res) => {
  const access = await requireProjectAction(req);
  const { path } = parseBody(SubmissionFileQuerySchema, req.query);
  res.json(await submissionFile(access, param(req, 'submissionId'), path));
});

submissionsRouter.post('/submissions/:submissionId/update', async (req, res) => {
  const access = await requireProjectAction(req);
  const input = parseBody(UpdateSubmissionRequestSchema, req.body ?? {});
  const id = param(req, 'submissionId');
  await updateSubmission(access, author(req), id, input);
  res.json(await respond(access, id));
});

submissionsRouter.post('/submissions/:submissionId/comments', async (req, res) => {
  const access = await requireProjectAction(req);
  const input = parseBody(CreateCommentRequestSchema, req.body);
  const comment = await addComment(access, param(req, 'submissionId'), input);
  res.status(201).json(CommentResponseSchema.parse({ comment }));
});

submissionsRouter.post(
  '/submissions/:submissionId/comments/:commentId/suggestion',
  async (req, res) => {
    const access = await requireProjectAction(req);
    const { decision } = parseBody(SuggestionDecisionRequestSchema, req.body);
    const id = param(req, 'submissionId');
    await respondToSuggestion(access, author(req), id, param(req, 'commentId'), decision);
    res.json(await respond(access, id));
  },
);

submissionsRouter.post('/submissions/:submissionId/reviews', async (req, res) => {
  const access = await requireProjectAction(req);
  const input = parseBody(CreateReviewRequestSchema, req.body);
  const id = param(req, 'submissionId');
  await addReview(access, id, input);
  res.json(await respond(access, id));
});

submissionsRouter.post('/submissions/:submissionId/reject', async (req, res) => {
  const access = await requireProjectAction(req);
  const { reason } = parseBody(RejectSubmissionRequestSchema, req.body);
  const id = param(req, 'submissionId');
  await rejectSubmission(access, id, reason);
  res.json(await respond(access, id));
});

submissionsRouter.post('/submissions/:submissionId/close', async (req, res) => {
  const access = await requireProjectAction(req);
  const id = param(req, 'submissionId');
  await closeSubmission(access, id);
  res.json(await respond(access, id));
});
