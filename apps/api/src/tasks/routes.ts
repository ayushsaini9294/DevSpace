import { Router, type Request } from 'express';
import {
  ConfirmTaskDoneRequestSchema,
  CreateTaskRequestSchema,
  MoveTaskRequestSchema,
  TaskListResponseSchema,
  TaskResponseSchema,
  UpdateTaskRequestSchema,
} from '@devspace/shared';
import { parseBody } from '../lib/validate.ts';
import { requireProjectAction, type ProjectAccess } from '../projects/access.ts';
import {
  confirmTaskDone,
  createTask,
  deleteTask,
  listTasks,
  moveTask,
  taskDetail,
  updateTask,
} from './service.ts';

/**
 * Mounted at /api/projects/:projectId (after requireAuth). Every route needs project
 * membership (404 otherwise); the finer rules are checked in the service.
 */
export const tasksRouter = Router({ mergeParams: true });

function param(req: Request, name: string): string {
  const value = req.params[name];
  return typeof value === 'string' ? value : '';
}

async function respond(access: ProjectAccess, id: string) {
  return TaskResponseSchema.parse({ task: await taskDetail(access, id) });
}

tasksRouter.get('/tasks', async (req, res) => {
  const access = await requireProjectAction(req);
  res.json(TaskListResponseSchema.parse({ tasks: await listTasks(access) }));
});

tasksRouter.post('/tasks', async (req, res) => {
  const access = await requireProjectAction(req);
  const input = parseBody(CreateTaskRequestSchema, req.body);
  const id = await createTask(access, input);
  res.status(201).json(await respond(access, id));
});

tasksRouter.get('/tasks/:taskId', async (req, res) => {
  const access = await requireProjectAction(req);
  res.json(await respond(access, param(req, 'taskId')));
});

tasksRouter.patch('/tasks/:taskId', async (req, res) => {
  const access = await requireProjectAction(req);
  const input = parseBody(UpdateTaskRequestSchema, req.body ?? {});
  const id = param(req, 'taskId');
  await updateTask(access, id, input);
  res.json(await respond(access, id));
});

tasksRouter.post('/tasks/:taskId/move', async (req, res) => {
  const access = await requireProjectAction(req);
  const input = parseBody(MoveTaskRequestSchema, req.body);
  const id = param(req, 'taskId');
  await moveTask(access, id, input);
  res.json(await respond(access, id));
});

tasksRouter.post('/tasks/:taskId/confirm-done', async (req, res) => {
  const access = await requireProjectAction(req);
  const { done } = parseBody(ConfirmTaskDoneRequestSchema, req.body);
  const id = param(req, 'taskId');
  await confirmTaskDone(access, id, done);
  res.json(await respond(access, id));
});

tasksRouter.delete('/tasks/:taskId', async (req, res) => {
  const access = await requireProjectAction(req);
  await deleteTask(access, param(req, 'taskId'));
  res.status(204).end();
});
