import { Router } from 'express';
import { z } from 'zod';
import {
  RepoPathSchema,
  SetUpRepositoryRequestSchema,
  TemplateListSchema,
  TEMPLATES,
} from '@devspace/shared';
import type { AuthUser } from '../auth/session.ts';
import { parseBody } from '../lib/validate.ts';
import { requireProjectAction } from '../projects/access.ts';
import { startImport } from './import.ts';
import { startGithubImport } from '../github/repos.ts';
import {
  claimImport,
  fileResponse,
  repositoryResponse,
  setUpEmpty,
  setUpFromTemplate,
  treeResponse,
} from './service.ts';

/** GET /api/templates (mounted after requireAuth): the starter templates, in order. */
export const templatesRouter = Router();

templatesRouter.get('/', (_req, res) => {
  res.json(TemplateListSchema.parse(TEMPLATES));
});

/** Mounted at /api/projects/:projectId (after requireAuth). */
export const repositoryRouter = Router({ mergeParams: true });

const TreeQuerySchema = z.object({ path: RepoPathSchema.default('') });
const FileQuerySchema = z.object({ path: RepoPathSchema });

repositoryRouter.post('/repository', async (req, res) => {
  const access = await requireProjectAction(req, 'repository.setup');
  const request = parseBody(SetUpRepositoryRequestSchema, req.body);
  const user = req.user as AuthUser;
  const projectId = access.project.id;
  if (request.source === 'empty') {
    await setUpEmpty(access.project, user);
  } else if (request.source === 'template') {
    await setUpFromTemplate(projectId, user, request.template);
  } else if (request.source === 'github') {
    await startGithubImport(projectId, user.id, request.repoFullName);
  } else {
    await claimImport(projectId, request.url);
    startImport(projectId, request.url, user.id);
  }
  res.status(202).json(await repositoryResponse(projectId));
});

repositoryRouter.get('/repository', async (req, res) => {
  const access = await requireProjectAction(req);
  res.json(await repositoryResponse(access.project.id));
});

repositoryRouter.get('/tree', async (req, res) => {
  const access = await requireProjectAction(req);
  const { path } = parseBody(TreeQuerySchema, req.query);
  res.json(await treeResponse(access.project.id, path));
});

repositoryRouter.get('/file', async (req, res) => {
  const access = await requireProjectAction(req);
  const { path } = parseBody(FileQuerySchema, req.query);
  res.json(await fileResponse(access.project.id, path));
});
