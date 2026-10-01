import { Router, type Request } from 'express';
import {
  GithubConnectFinishRequestSchema,
  GithubConnectStartResponseSchema,
  PublishGithubRequestSchema,
} from '@devspace/shared';
import { hashSessionToken, readSessionToken, type AuthUser } from '../auth/session.ts';
import { HttpError } from '../lib/http-error.ts';
import { parseBody } from '../lib/validate.ts';
import { requireProjectAction } from '../projects/access.ts';
import {
  disconnectGithub,
  finishGithubConnect,
  githubAccountView,
  startGithubConnect,
} from './account.ts';
import { requireGithubConfig } from './config.ts';
import { projectGithubView, publishProject, tryGithubSyncAgain, unlinkProject } from './link.ts';
import { listGithubRepos } from './repos.ts';

/** /api/github (after requireAuth): the member's GitHub connection and reachable repositories. */
export const githubRouter = Router();

function sessionIdOf(req: Request): string {
  const token = readSessionToken(req.cookies);
  if (!token) throw new HttpError(401, 'unauthenticated', 'Not logged in');
  return hashSessionToken(token);
}

githubRouter.get('/account', async (req, res) => {
  const user = req.user as AuthUser;
  res.json(await githubAccountView(user.id));
});

githubRouter.delete('/account', async (req, res) => {
  const user = req.user as AuthUser;
  await disconnectGithub(user.id);
  res.status(204).end();
});

githubRouter.post('/connect/start', async (req, res) => {
  const user = req.user as AuthUser;
  const url = await startGithubConnect(user.id, sessionIdOf(req));
  res.json(GithubConnectStartResponseSchema.parse({ url }));
});

githubRouter.post('/connect/finish', async (req, res) => {
  const user = req.user as AuthUser;
  requireGithubConfig();
  const { code, state } = parseBody(GithubConnectFinishRequestSchema, req.body);
  await finishGithubConnect(user.id, sessionIdOf(req), code, state);
  res.json(await githubAccountView(user.id));
});

githubRouter.get('/repos', async (req, res) => {
  const user = req.user as AuthUser;
  res.json(await listGithubRepos(user.id));
});

/** Mounted at /api/projects/:projectId (after requireAuth). */
export const projectGithubRouter = Router({ mergeParams: true });

projectGithubRouter.get('/github', async (req, res) => {
  const access = await requireProjectAction(req);
  res.json(await projectGithubView(access));
});

projectGithubRouter.post('/github/publish', async (req, res) => {
  const access = await requireProjectAction(req);
  requireGithubConfig();
  const request = parseBody(PublishGithubRequestSchema, req.body);
  await publishProject(access, request);
  res.status(202).json(await projectGithubView(access));
});

projectGithubRouter.post('/github/sync', async (req, res) => {
  const access = await requireProjectAction(req);
  await tryGithubSyncAgain(access);
  res.status(202).json(await projectGithubView(access));
});

projectGithubRouter.delete('/github', async (req, res) => {
  const access = await requireProjectAction(req);
  await unlinkProject(access);
  res.status(204).end();
});
