import type { ZodError, ZodType } from 'zod';
import {
  ActivityListResponseSchema,
  AiConnectionViewSchema,
  AiModelListResponseSchema,
  AiNoticeAcceptResponseSchema,
  AiPreferencesSchema,
  AiReviewListResponseSchema,
  AuthResponseSchema,
  CommentResponseSchema,
  ConfirmTaskDoneRequestSchema,
  CopyChangesResponseSchema,
  CopyResponseSchema,
  CopyUpdatePreviewSchema,
  CopyUpdateResponseSchema,
  CreateCommentRequestSchema,
  CreateInvitationRequestSchema,
  CreateInvitationResponseSchema,
  CreateProjectRequestSchema,
  CreateReviewRequestSchema,
  CreateSubmissionRequestSchema,
  CreateTaskRequestSchema,
  CreateTeamRequestSchema,
  DEFAULT_PROJECT_SETTINGS,
  DeleteProjectRequestSchema,
  ErrorResponseSchema,
  FileResponseSchema,
  GettingStartedViewSchema,
  GithubAccountViewSchema,
  HealthResponseSchema,
  INVITATION_TTL_DAYS,
  InvitationListResponseSchema,
  MarkNotificationsReadRequestSchema,
  MarkNotificationsReadResponseSchema,
  MemberListResponseSchema,
  MemberResponseSchema,
  MoveTaskRequestSchema,
  NotificationListResponseSchema,
  PreferencesSchema,
  PresenceListResponseSchema,
  ProjectGithubViewSchema,
  ProjectListResponseSchema,
  ProjectResponseSchema,
  RejectSubmissionRequestSchema,
  RenameProjectRequestSchema,
  RepoPathSchema,
  RepositoryResponseSchema,
  SetUpRepositoryRequestSchema,
  SubmissionFileResponseSchema,
  SubmissionListResponseSchema,
  SubmissionResponseSchema,
  SuggestionDecisionRequestSchema,
  TEMPLATES,
  TaskListResponseSchema,
  TaskResponseSchema,
  TeamDetailResponseSchema,
  TeamListResponseSchema,
  TeamResponseSchema,
  TemplateListSchema,
  TransferOwnershipRequestSchema,
  TreeResponseSchema,
  UpdateAiPreferencesRequestSchema,
  UpdateMemberRequestSchema,
  UpdatePreferencesRequestSchema,
  UpdateProjectSettingsRequestSchema,
  UpdateSubmissionRequestSchema,
  UpdateTaskRequestSchema,
  allowedActions,
  allowedTaskMoves,
  can,
  canChangeRole,
  canLeave,
  canRemoveMember,
  canSetPermissions,
  groupAiFindings,
  isActiveSubmissionStatus,
  type ActivityEntry,
  type MergeBlocker,
  type ProjectAction,
  type ProjectRole,
  type SubmissionViewerAction,
  type TaskStatus,
  type TaskViewerAction,
} from '@devspace/shared';
import {
  fakeSha,
  type DemoCopy,
  type DemoProject,
  type DemoState,
  type DemoSubmission,
  type DemoSubmissionFile,
  type DemoTask,
} from './state';
import { htmlTemplateFiles } from './repoFiles';

/** What the stand-in API answers: a status and, except for 204, a JSON body. */
export type DemoReply = { status: number; body?: unknown };

/** The error code for anything that needs a real server. */
export const NOT_IN_DEMO = 'not_available_in_demo';
/** The error code for a request the stand-in doesn't know (a bug in the demo, never expected). */
export const UNKNOWN_ROUTE = 'demo_unknown_route';

const NOT_IN_DEMO_PREFIX = 'Not available in the demo:';

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extra: { fields?: Record<string, string[]>; details?: Record<string, unknown> } = {},
  ) {
    super(message);
  }
}

function notInDemo(reason: string): never {
  throw new HttpError(409, NOT_IN_DEMO, `${NOT_IN_DEMO_PREFIX} ${reason}`);
}

const FORBIDDEN = 'You don’t have permission to do that.';

function forbidden(message = FORBIDDEN): never {
  throw new HttpError(403, 'forbidden', message);
}

function notFound(message = 'Not found.'): never {
  throw new HttpError(404, 'not_found', message);
}

function conflict(code: string, message: string, details?: Record<string, unknown>): never {
  throw new HttpError(409, code, message, details ? { details } : {});
}

function fieldsOf(error: ZodError): Record<string, string[]> {
  const fields: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const key = typeof issue.path[0] === 'string' ? issue.path[0] : '_';
    (fields[key] ??= []).push(issue.message);
  }
  return fields;
}

/** Parse a request body with the shared schema, or answer 400 like the API. */
function parseBody<T>(schema: ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body ?? {});
  if (!result.success) {
    const fields = fieldsOf(result.error);
    const first = Object.values(fields).flat()[0] ?? 'Check the form and try again.';
    throw new HttpError(400, 'validation_error', first, { fields });
  }
  return result.data;
}

/** Every answer goes through the shared schema, so the sample data can't drift from the API. */
function ok<T>(schema: ZodType<T>, value: T, status = 200): DemoReply {
  return { status, body: schema.parse(value) };
}

const NO_CONTENT: DemoReply = { status: 204 };

type Ctx = {
  state: DemoState;
  params: string[];
  query: URLSearchParams;
  body: unknown;
  now: () => string;
};

// ---------- Small helpers ----------

function nextId(state: DemoState, prefix: string): string {
  state.seq += 1;
  return `${prefix}-${state.seq}`;
}

function userRef(state: DemoState, id: string) {
  const user = state.users.find((u) => u.id === id);
  return { id, name: user?.name ?? 'Someone' };
}

function nameOf(state: DemoState, id: string): string {
  return userRef(state, id).name;
}

const LEADS: readonly ProjectRole[] = ['leader', 'co_leader'];
const ROLE_ORDER: Record<ProjectRole, number> = { leader: 0, co_leader: 1, member: 2 };

function project(state: DemoState, projectId: string): DemoProject {
  const found = state.projects.find((p) => p.id === projectId);
  if (!found || !found.members.some((m) => m.userId === state.meId)) {
    notFound('There is no project you can open at this address.');
  }
  return found;
}

function me(state: DemoState, p: DemoProject) {
  return p.members.find((m) => m.userId === state.meId)!;
}

function allows(state: DemoState, p: DemoProject, action: ProjectAction): boolean {
  const member = me(state, p);
  return can(member.role, member.permissions, action);
}

function requireAction(state: DemoState, p: DemoProject, action: ProjectAction) {
  if (!allows(state, p, action)) forbidden();
}

function isLead(state: DemoState, p: DemoProject): boolean {
  return LEADS.includes(me(state, p).role);
}

function log(
  ctx: Ctx,
  p: DemoProject,
  action: string,
  target: string | null,
  data: Record<string, unknown> = {},
  actorId: string | null = ctx.state.meId,
) {
  const entry: ActivityEntry = {
    id: nextId(ctx.state, 'activity'),
    action,
    actorId,
    actorName: actorId ? nameOf(ctx.state, actorId) : null,
    target,
    data,
    createdAt: ctx.now(),
  };
  p.activity.unshift(entry);
  p.activity = p.activity.slice(0, 50);
}

function latestSha(p: DemoProject): string | null {
  return p.commits.at(-1)?.sha ?? null;
}

function addCommit(ctx: Ctx, p: DemoProject, message: string, authorName: string): string {
  const sha = fakeSha(nextId(ctx.state, 'commit'));
  p.commits.push({ sha, message, authorName, committedAt: ctx.now() });
  return sha;
}

// ---------- Views ----------

function teamView(state: DemoState, teamId: string) {
  const team = state.teams.find((t) => t.id === teamId);
  if (!team) notFound('There is no team you can open at this address.');
  return { ...team, isOwner: team.ownerId === state.meId };
}

function myProjects(state: DemoState): DemoProject[] {
  return state.projects.filter((p) => p.members.some((m) => m.userId === state.meId));
}

function projectSummary(state: DemoState, p: DemoProject) {
  return {
    id: p.id,
    name: p.name,
    teamId: p.teamId,
    teamName: state.teams.find((t) => t.id === p.teamId)?.name ?? 'Team',
    myRole: me(state, p).role,
    createdAt: p.createdAt,
  };
}

function projectDetail(state: DemoState, p: DemoProject) {
  const member = me(state, p);
  return {
    ...projectSummary(state, p),
    settings: p.settings,
    myPermissions: member.permissions,
    allowedActions: allowedActions(member.role, member.permissions),
    memberCount: p.members.length,
  };
}

function memberView(state: DemoState, member: DemoProject['members'][number]) {
  const user = state.users.find((u) => u.id === member.userId);
  return {
    userId: member.userId,
    name: user?.name ?? 'Someone',
    email: user?.email ?? 'someone@example.com',
    role: member.role,
    permissions: member.permissions,
    joinedAt: member.joinedAt,
  };
}

function membersView(state: DemoState, p: DemoProject) {
  return [...p.members]
    .sort(
      (a, b) =>
        ROLE_ORDER[a.role] - ROLE_ORDER[b.role] ||
        nameOf(state, a.userId).localeCompare(nameOf(state, b.userId)),
    )
    .map((m) => memberView(state, m));
}

function repositoryView(p: DemoProject) {
  const last = p.commits.at(-1) ?? null;
  return {
    status: p.repository.status,
    source: p.repository.source,
    template: p.repository.template,
    importUrl: null,
    error: null,
    lastCommit: p.repository.status === 'ready' ? last : null,
  };
}

// ---------- Copies ----------

/** The paths my copy changed (compared with its base), with how. */
function copyChanges(copy: DemoCopy) {
  const out: { path: string; change: 'added' | 'modified' | 'deleted'; content: string | null }[] =
    [];
  for (const [path, content] of Object.entries(copy.changes)) {
    const base = copy.base[path];
    if (content === null) {
      if (base !== undefined) out.push({ path, change: 'deleted', content });
    } else if (base === undefined) out.push({ path, change: 'added', content });
    else if (base !== content) out.push({ path, change: 'modified', content });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

const MARKER = '<<<<<<< your copy';

function copyView(state: DemoState, p: DemoProject, copy: DemoCopy) {
  return {
    id: copy.id,
    branchName: `copy/${Object.keys(p.copies).find((k) => p.copies[k] === copy) ?? state.meId}`,
    // The real IDE needs a server: in the demo every copy's IDE is stopped.
    containerStatus: 'stopped' as const,
    createdAt: copy.createdAt,
    lastActiveAt: copy.lastActiveAt,
    behind: copy.baseSha !== latestSha(p),
    pendingConflictPaths: [...copy.pendingConflictPaths].sort(),
    unresolvedPaths: Object.entries(copy.changes)
      .filter(([, content]) => content?.includes(MARKER))
      .map(([path]) => path)
      .sort(),
    helpers: [],
    packagesChanged: false,
    aiAssistant: p.settings.aiReviewEnabled
      ? { ready: true, reason: null }
      : { ready: false, reason: 'ai_disabled' as const },
  };
}

/** Files that would clash if this copy took main now: changed in the copy and in main. */
function copyConflicts(p: DemoProject, copy: DemoCopy): string[] {
  return copyChanges(copy)
    .filter(({ path }) => (p.main[path] ?? null) !== (copy.base[path] ?? null))
    .filter(({ path, content }) => (p.main[path] ?? null) !== content)
    .map(({ path }) => path);
}

/** Bring main into a copy; clashing files get markers like the real update. */
function updateCopy(p: DemoProject, copy: DemoCopy): string[] {
  const conflicts = copyConflicts(p, copy);
  for (const path of conflicts) {
    const mine = copy.changes[path] ?? '';
    const theirs = p.main[path] ?? '';
    copy.changes[path] = `${MARKER}\n${mine}=======\n${theirs}>>>>>>> main\n`;
  }
  copy.base = { ...p.main };
  copy.baseSha = latestSha(p) ?? copy.baseSha;
  copy.pendingConflictPaths = [];
  return conflicts;
}

/** After main moves: in automatic mode, every copy without clashes takes main at once. */
function mainMoved(ctx: Ctx, p: DemoProject) {
  if (p.settings.copyUpdateMode !== 'automatic') return;
  for (const [ownerId, copy] of Object.entries(p.copies)) {
    const conflicts = copyConflicts(p, copy);
    if (conflicts.length > 0) {
      copy.pendingConflictPaths = conflicts;
      continue;
    }
    updateCopy(p, copy);
    log(
      ctx,
      p,
      'copy.updated',
      ownerId,
      { mainSha: latestSha(p), conflictPaths: [], automatic: true },
      null,
    );
  }
}

function myCopy(state: DemoState, p: DemoProject): DemoCopy | null {
  return p.copies[state.meId] ?? null;
}

function requireMyCopy(state: DemoState, p: DemoProject): DemoCopy {
  const copy = myCopy(state, p);
  if (!copy) conflict('no_copy', 'You don’t have a copy of this project yet.');
  return copy;
}

function makeCopy(ctx: Ctx, p: DemoProject): DemoCopy {
  const copy: DemoCopy = {
    id: `8f14e45f-ceea-467a-9575-${String(++ctx.state.seq).padStart(12, '0')}`,
    createdAt: ctx.now(),
    lastActiveAt: null,
    baseSha: latestSha(p) ?? fakeSha('empty'),
    base: { ...p.main },
    changes: {},
    pendingConflictPaths: [],
  };
  p.copies[ctx.state.meId] = copy;
  return copy;
}

// ---------- Submissions ----------

function linkedTask(p: DemoProject, s: DemoSubmission): DemoTask | null {
  return s.taskId ? (p.tasks.find((t) => t.id === s.taskId) ?? null) : null;
}

function currentReviews(s: DemoSubmission) {
  const latest = new Map<string, DemoSubmission['reviews'][number]>();
  for (const review of s.reviews) if (!review.stale) latest.set(review.reviewer.id, review);
  return [...latest.values()];
}

function approvals(s: DemoSubmission): number {
  return currentReviews(s).filter((r) => r.decision === 'approved').length;
}

function mergeBlocker(p: DemoProject, s: DemoSubmission): MergeBlocker | null {
  if (!isActiveSubmissionStatus(s.status)) return 'not_active';
  if (s.status === 'needs_update') return 'needs_update';
  if (p.settings.requireApproval && s.status !== 'approved') return 'approval_required';
  return null;
}

function submissionActions(
  state: DemoState,
  p: DemoProject,
  s: DemoSubmission,
): SubmissionViewerAction[] {
  const active = isActiveSubmissionStatus(s.status);
  const author = s.authorId === state.meId;
  const lead = isLead(state, p);
  const comment = allows(state, p, 'submission.comment');
  const actions: SubmissionViewerAction[] = [];
  if (author && active) actions.push('update');
  if (comment || author) actions.push('comment');
  if (comment && active) actions.push('suggest');
  if (author && active) actions.push('respondSuggestion');
  if (allows(state, p, 'submission.approve') && !author && active) {
    actions.push('approve', 'requestChanges');
  }
  if (allows(state, p, 'submission.reject') && active) actions.push('reject');
  if ((author || lead) && active) actions.push('close');
  if (allows(state, p, 'submission.merge') && mergeBlocker(p, s) === null) actions.push('merge');
  if (allows(state, p, 'submission.revert') && s.status === 'merged') actions.push('revert');
  if (lead && linkedTask(p, s)?.doneConfirmPending) actions.push('confirmTaskDone');
  return actions;
}

function submissionSummary(state: DemoState, p: DemoProject, s: DemoSubmission) {
  const task = linkedTask(p, s);
  return {
    id: s.id,
    title: s.title,
    status: s.status,
    author: userRef(state, s.authorId),
    version: s.version,
    fileCount: s.files.length,
    commentCount: s.comments.length,
    approvals: approvals(s),
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    task: task ? { id: task.id, title: task.title, status: task.status } : null,
  };
}

function submissionDetail(state: DemoState, p: DemoProject, s: DemoSubmission) {
  return {
    ...submissionSummary(state, p, s),
    description: s.description,
    baseSha: s.baseSha,
    headSha: s.headSha,
    rejectReason: s.rejectReason,
    closedAt: s.closedAt,
    files: s.files.map((f) => ({ path: f.path, change: f.change })),
    reviews: s.reviews,
    comments: s.comments,
    viewerActions: submissionActions(state, p, s),
    conflictPaths: s.conflictPaths,
    mergedSha: s.mergedSha,
    mergedBy: s.mergedById ? userRef(state, s.mergedById) : null,
    mergedAt: s.mergedAt,
    revertedSha: s.revertedSha,
    revertedBy: s.revertedById ? userRef(state, s.revertedById) : null,
    revertedAt: s.revertedAt,
    mergeBlocker: mergeBlocker(p, s),
  };
}

function submission(p: DemoProject, id: string): DemoSubmission {
  const found = p.submissions.find((s) => s.id === id);
  if (!found) notFound('This submission no longer exists.');
  return found;
}

function submissionReply(ctx: Ctx, p: DemoProject, s: DemoSubmission, status = 200): DemoReply {
  return ok(SubmissionResponseSchema, { submission: submissionDetail(ctx.state, p, s) }, status);
}

function requireActive(s: DemoSubmission) {
  if (!isActiveSubmissionStatus(s.status)) {
    conflict('submission_not_active', 'This submission’s status has changed.');
  }
}

/** Files for a submission, read from my copy (409s like the real API). */
function filesFromCopy(
  state: DemoState,
  p: DemoProject,
  copy: DemoCopy,
  paths: string[],
  except: string | null,
): DemoSubmissionFile[] {
  const changed = new Map(copyChanges(copy).map((c) => [c.path, c]));
  const missing = paths.filter((path) => !changed.has(path));
  if (missing.length > 0) {
    conflict('no_changes', 'Some files no longer differ from main.', { paths: missing });
  }
  const mine = p.submissions.filter(
    (s) => s.authorId === state.meId && s.id !== except && isActiveSubmissionStatus(s.status),
  );
  for (const other of mine) {
    const locked = other.files.map((f) => f.path).filter((path) => paths.includes(path));
    if (locked.length > 0) {
      conflict('file_in_open_submission', 'Some files are already in another submission.', {
        paths: locked,
        submissionId: other.id,
      });
    }
  }
  return [...paths].sort().map((path) => {
    const c = changed.get(path)!;
    return { path, change: c.change, base: copy.base[path] ?? null, head: c.content };
  });
}

function checkTaskLink(p: DemoProject, taskId: string): DemoTask {
  const task = p.tasks.find((t) => t.id === taskId);
  if (!task) {
    throw new HttpError(400, 'validation_error', 'Pick a task of this project', {
      fields: { taskId: ['Pick a task of this project'] },
    });
  }
  if (task.status === 'done') conflict('task_done', 'That task is already Done.');
  return task;
}

// ---------- Tasks ----------

function taskActions(state: DemoState, p: DemoProject, t: DemoTask): TaskViewerAction[] {
  if (isLead(state, p)) {
    return t.doneConfirmPending
      ? ['edit', 'move', 'delete', 'confirmDone']
      : ['edit', 'move', 'delete'];
  }
  const actions: TaskViewerAction[] = [];
  if (t.createdById === state.meId && allows(state, p, 'task.create')) actions.push('edit');
  if (
    allowedTaskMoves(t.status, { isLead: false, isAssignee: t.assigneeIds.includes(state.meId) })
      .length > 0
  ) {
    actions.push('move');
  }
  return actions;
}

function taskView(state: DemoState, p: DemoProject, t: DemoTask) {
  return {
    id: t.id,
    title: t.title,
    description: t.description,
    status: t.status,
    dueDate: t.dueDate,
    position: t.position,
    assignees: t.assigneeIds
      .map((id) => userRef(state, id))
      .sort((a, b) => a.name.localeCompare(b.name)),
    createdBy: userRef(state, t.createdById),
    doneConfirmPending: t.doneConfirmPending,
    reopenNote: t.reopenNote,
    linkedSubmissions: p.submissions
      .filter((s) => s.taskId === t.id)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((s) => ({ id: s.id, title: s.title, status: s.status })),
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    completedAt: t.completedAt,
    viewerActions: taskActions(state, p, t),
  };
}

const TASK_ORDER: Record<TaskStatus, number> = { todo: 0, in_progress: 1, in_review: 2, done: 3 };

function task(p: DemoProject, id: string): DemoTask {
  const found = p.tasks.find((t) => t.id === id);
  if (!found) notFound('This task no longer exists.');
  return found;
}

function taskReply(ctx: Ctx, p: DemoProject, t: DemoTask, status = 200): DemoReply {
  return ok(TaskResponseSchema, { task: taskView(ctx.state, p, t) }, status);
}

function endOfColumn(p: DemoProject, status: TaskStatus, except?: string): number {
  const positions = p.tasks
    .filter((t) => t.status === status && t.id !== except)
    .map((t) => t.position);
  return positions.length === 0 ? 1 : Math.max(...positions) + 1;
}

/** Move a task by a rule (not by hand), logged as automatic. */
function autoMove(ctx: Ctx, p: DemoProject, t: DemoTask, to: TaskStatus) {
  if (t.status === to) return;
  const from = t.status;
  t.position = endOfColumn(p, to, t.id);
  t.status = to;
  t.updatedAt = ctx.now();
  if (to !== 'done') t.completedAt = null;
  log(ctx, p, 'task.moved', t.id, { title: t.title, from, to, automatic: true }, null);
}

function hasOtherActiveLink(p: DemoProject, t: DemoTask, except: string): boolean {
  return p.submissions.some(
    (s) => s.taskId === t.id && s.id !== except && isActiveSubmissionStatus(s.status),
  );
}

/** A linked submission was rejected, closed or unlinked. */
function linkEnded(ctx: Ctx, p: DemoProject, t: DemoTask | null, submissionId: string) {
  if (!t || t.status === 'done' || t.doneConfirmPending) return;
  if (!hasOtherActiveLink(p, t, submissionId)) autoMove(ctx, p, t, 'in_progress');
}

// ---------- Getting started ----------

function gettingStarted(state: DemoState, p: DemoProject) {
  const copy = myCopy(state, p);
  const mine = p.submissions.filter((s) => s.authorId === state.meId);
  const done: Record<string, boolean> = {
    setup: p.repository.status === 'ready',
    invite: p.members.length > 1 || p.invitations.length > 0,
    openIde: copy !== null,
    change: (copy !== null && copyChanges(copy).length > 0) || mine.length > 0,
    preview: p.previewed,
    submit: mine.length > 0,
    reviewed: mine.some(
      (s) =>
        s.mergedAt !== null ||
        s.reviews.some((r) => r.reviewer.id !== state.meId) ||
        s.comments.some((c) => c.author.id !== state.meId),
    ),
  };
  const ids = isLead(state, p)
    ? (['setup', 'invite', 'openIde', 'change', 'preview', 'submit', 'reviewed'] as const)
    : (['openIde', 'change', 'preview', 'submit', 'reviewed'] as const);
  return { hidden: p.gettingStartedHidden, steps: ids.map((id) => ({ id, done: done[id]! })) };
}

// ---------- Sample AI and GitHub answers ----------

const AI_MODELS = [
  {
    id: 'meta-llama/llama-3.3-70b-instruct:free',
    name: 'Llama 3.3 70B (free)',
    isFree: true,
    contextLength: 131072,
  },
  {
    id: 'mistralai/mistral-small-3.2-24b-instruct:free',
    name: 'Mistral Small 3.2 (free)',
    isFree: true,
    contextLength: 131072,
  },
  { id: 'qwen/qwen3-coder:free', name: 'Qwen3 Coder (free)', isFree: true, contextLength: 262144 },
  { id: 'openai/gpt-4o-mini', name: 'GPT-4o mini', isFree: false, contextLength: 128000 },
];

function aiConnection(state: DemoState) {
  const user = state.users.find((u) => u.id === state.meId)!;
  return {
    connected: true,
    provider: 'openrouter' as const,
    keyHint: 'demo',
    connectedAt: user.createdAt,
    freeRequestsToday: { used: 3, limit: 50, remaining: 47 },
    noticeAcceptedAt: user.createdAt,
  };
}

const IDE_REASON =
  'your own VS Code runs on a real server, so it can’t open here. Watch the video to see it.';

// ---------- Routes ----------

type Handler = (ctx: Ctx) => DemoReply;
type Route = { method: string; pattern: RegExp; run: Handler; public?: boolean };

const P = '/api/projects/([^/]+)';

const routes: Route[] = [
  // ----- Health and auth -----
  {
    method: 'GET',
    pattern: /^\/api\/health$/,
    public: true,
    run: () => ok(HealthResponseSchema, { ok: true, db: true, redis: true }),
  },
  {
    method: 'GET',
    pattern: /^\/api\/auth\/me$/,
    public: true,
    run: ({ state }) => {
      if (!state.loggedIn) throw new HttpError(401, 'unauthenticated', 'Log in first');
      return ok(AuthResponseSchema, { user: state.users.find((u) => u.id === state.meId)! });
    },
  },
  ...['login', 'signup'].map((action): Route => ({
    method: 'POST',
    pattern: new RegExp(`^/api/auth/${action}$`),
    public: true,
    // The demo has one account: whatever is typed, you go in as Demo Leader.
    run: ({ state }) => {
      state.loggedIn = true;
      return ok(
        AuthResponseSchema,
        { user: state.users.find((u) => u.id === state.meId)! },
        action === 'signup' ? 201 : 200,
      );
    },
  })),
  {
    method: 'POST',
    pattern: /^\/api\/auth\/logout$/,
    public: true,
    run: ({ state }) => {
      state.loggedIn = false;
      return NO_CONTENT;
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/templates$/,
    run: () => ok(TemplateListSchema, [...TEMPLATES]),
  },

  // ----- Teams -----
  {
    method: 'GET',
    pattern: /^\/api\/teams$/,
    run: ({ state }) =>
      ok(TeamListResponseSchema, { teams: state.teams.map((t) => teamView(state, t.id)) }),
  },
  {
    method: 'POST',
    pattern: /^\/api\/teams$/,
    run: (ctx) => {
      const { name } = parseBody(CreateTeamRequestSchema, ctx.body);
      const team = {
        id: nextId(ctx.state, 'team'),
        name,
        ownerId: ctx.state.meId,
        createdAt: ctx.now(),
      };
      ctx.state.teams.push(team);
      return ok(TeamResponseSchema, { team: teamView(ctx.state, team.id) }, 201);
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/teams\/([^/]+)$/,
    run: ({ state, params }) => {
      const team = teamView(state, params[0]!);
      const projects = myProjects(state)
        .filter((p) => p.teamId === team.id)
        .map((p) => projectSummary(state, p));
      return ok(TeamDetailResponseSchema, { team, projects });
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/teams\/([^/]+)\/projects$/,
    run: (ctx) => {
      const team = teamView(ctx.state, ctx.params[0]!);
      const { name } = parseBody(CreateProjectRequestSchema, ctx.body);
      const p: DemoProject = {
        id: nextId(ctx.state, 'project'),
        name,
        teamId: team.id,
        createdAt: ctx.now(),
        settings: { ...DEFAULT_PROJECT_SETTINGS },
        members: [
          {
            userId: ctx.state.meId,
            role: 'leader',
            permissions: {
              approve: true,
              comment: true,
              createTasks: true,
              aiReview: true,
              publishGithub: true,
            },
            joinedAt: ctx.now(),
          },
        ],
        invitations: [],
        repository: { status: 'none', source: null, template: null },
        commits: [],
        main: {},
        copies: {},
        submissions: [],
        tasks: [],
        activity: [],
        presence: [],
        aiReviews: [],
        gettingStartedHidden: false,
        previewed: false,
      };
      ctx.state.projects.push(p);
      log(ctx, p, 'project.created', null);
      return ok(ProjectResponseSchema, { project: projectDetail(ctx.state, p) }, 201);
    },
  },

  // ----- Projects -----
  {
    method: 'GET',
    pattern: /^\/api\/projects$/,
    run: ({ state }) =>
      ok(ProjectListResponseSchema, {
        projects: myProjects(state).map((p) => projectSummary(state, p)),
      }),
  },
  {
    method: 'GET',
    pattern: new RegExp(`^${P}$`),
    run: ({ state, params }) =>
      ok(ProjectResponseSchema, { project: projectDetail(state, project(state, params[0]!)) }),
  },
  {
    method: 'PATCH',
    pattern: new RegExp(`^${P}$`),
    run: (ctx) => {
      const p = project(ctx.state, ctx.params[0]!);
      requireAction(ctx.state, p, 'project.rename');
      const { name } = parseBody(RenameProjectRequestSchema, ctx.body);
      log(ctx, p, 'project.renamed', null, { from: p.name, to: name });
      p.name = name;
      for (const n of ctx.state.notifications) {
        if (n.project?.id === p.id) n.project = { id: p.id, name };
      }
      return ok(ProjectResponseSchema, { project: projectDetail(ctx.state, p) });
    },
  },
  {
    method: 'DELETE',
    pattern: new RegExp(`^${P}$`),
    run: (ctx) => {
      const p = project(ctx.state, ctx.params[0]!);
      requireAction(ctx.state, p, 'project.delete');
      const { confirmName } = parseBody(DeleteProjectRequestSchema, ctx.body);
      if (confirmName !== p.name) {
        throw new HttpError(400, 'validation_error', 'Type the project’s name exactly', {
          fields: { confirmName: ['Type the project’s name exactly'] },
        });
      }
      ctx.state.projects = ctx.state.projects.filter((x) => x.id !== p.id);
      return NO_CONTENT;
    },
  },
  {
    method: 'PATCH',
    pattern: new RegExp(`^${P}/settings$`),
    run: (ctx) => {
      const p = project(ctx.state, ctx.params[0]!);
      const changes = parseBody(UpdateProjectSettingsRequestSchema, ctx.body);
      const githubOnly = Object.keys(changes).every((k) => k === 'githubMode');
      if (
        !allows(ctx.state, p, 'project.updateSettings') &&
        !(githubOnly && allows(ctx.state, p, 'github.publish'))
      ) {
        forbidden();
      }
      p.settings = { ...p.settings, ...changes };
      log(ctx, p, 'project.settings_changed', null, { changes });
      return ok(ProjectResponseSchema, { project: projectDetail(ctx.state, p) });
    },
  },
  {
    method: 'GET',
    pattern: new RegExp(`^${P}/activity$`),
    run: ({ state, params }) =>
      ok(ActivityListResponseSchema, { entries: project(state, params[0]!).activity.slice(0, 50) }),
  },

  // ----- Members -----
  {
    method: 'GET',
    pattern: new RegExp(`^${P}/members$`),
    run: ({ state, params }) =>
      ok(MemberListResponseSchema, { members: membersView(state, project(state, params[0]!)) }),
  },
  {
    method: 'PATCH',
    pattern: new RegExp(`^${P}/members/([^/]+)$`),
    run: (ctx) => {
      const p = project(ctx.state, ctx.params[0]!);
      const target = p.members.find((m) => m.userId === ctx.params[1]);
      if (!target) notFound('This person isn’t in the project.');
      const changes = parseBody(UpdateMemberRequestSchema, ctx.body);
      const myRole = me(ctx.state, p).role;
      const targetName = nameOf(ctx.state, target.userId);
      if (changes.role !== undefined) {
        if (!canChangeRole(myRole, target.role)) forbidden();
        target.role = changes.role;
        if (changes.role === 'co_leader') {
          target.permissions = {
            approve: true,
            comment: true,
            createTasks: true,
            aiReview: true,
            publishGithub: true,
          };
        }
        log(ctx, p, 'member.role_changed', target.userId, {
          memberName: targetName,
          to: changes.role,
        });
      }
      if (changes.permissions !== undefined) {
        if (!canSetPermissions(myRole, target.role)) forbidden();
        target.permissions = { ...target.permissions, ...changes.permissions };
        log(ctx, p, 'member.permissions_changed', target.userId, { memberName: targetName });
      }
      return ok(MemberResponseSchema, { member: memberView(ctx.state, target) });
    },
  },
  {
    method: 'DELETE',
    pattern: new RegExp(`^${P}/members/([^/]+)$`),
    run: (ctx) => {
      const p = project(ctx.state, ctx.params[0]!);
      const target = p.members.find((m) => m.userId === ctx.params[1]);
      if (!target) notFound('This person isn’t in the project.');
      const myRole = me(ctx.state, p).role;
      if (target.userId === ctx.state.meId) {
        if (!canLeave(myRole)) {
          forbidden('The leader can’t leave. Make someone else the leader first.');
        }
        log(ctx, p, 'member.left', null);
      } else {
        if (!canRemoveMember(myRole, target.role)) forbidden();
        log(ctx, p, 'member.removed', target.userId, {
          memberName: nameOf(ctx.state, target.userId),
        });
      }
      p.members = p.members.filter((m) => m.userId !== target.userId);
      p.presence = p.presence.filter((m) => m.user.id !== target.userId);
      return NO_CONTENT;
    },
  },
  {
    method: 'POST',
    pattern: new RegExp(`^${P}/transfer$`),
    run: (ctx) => {
      const p = project(ctx.state, ctx.params[0]!);
      requireAction(ctx.state, p, 'project.transferOwnership');
      const { userId } = parseBody(TransferOwnershipRequestSchema, ctx.body);
      const target = p.members.find((m) => m.userId === userId && m.userId !== ctx.state.meId);
      if (!target) notFound('This person isn’t in the project.');
      target.role = 'leader';
      target.permissions = {
        approve: true,
        comment: true,
        createTasks: true,
        aiReview: true,
        publishGithub: true,
      };
      me(ctx.state, p).role = 'co_leader';
      log(ctx, p, 'ownership.transferred', userId, { memberName: nameOf(ctx.state, userId) });
      return ok(ProjectResponseSchema, { project: projectDetail(ctx.state, p) });
    },
  },

  // ----- Invitations -----
  {
    method: 'GET',
    pattern: new RegExp(`^${P}/invitations$`),
    run: ({ state, params }) => {
      const p = project(state, params[0]!);
      requireAction(state, p, 'members.invite');
      return ok(InvitationListResponseSchema, { invitations: p.invitations });
    },
  },
  {
    method: 'POST',
    pattern: new RegExp(`^${P}/invitations$`),
    run: (ctx) => {
      const p = project(ctx.state, ctx.params[0]!);
      requireAction(ctx.state, p, 'members.invite');
      const { email } = parseBody(CreateInvitationRequestSchema, ctx.body);
      const memberEmails = p.members.map((m) => memberView(ctx.state, m).email);
      if (memberEmails.includes(email)) {
        conflict('already_member', 'That person is already in the project.');
      }
      if (!/@example\.(com|org|net)$/.test(email)) {
        notInDemo(
          'invitations to real email addresses can’t be made here. Try a made-up address ending in @example.com.',
        );
      }
      const invitation = {
        id: nextId(ctx.state, 'invitation'),
        email,
        invitedByName: nameOf(ctx.state, ctx.state.meId),
        expiresAt: new Date(Date.now() + INVITATION_TTL_DAYS * 86_400_000).toISOString(),
        createdAt: ctx.now(),
      };
      p.invitations = [...p.invitations.filter((i) => i.email !== email), invitation];
      log(ctx, p, 'member.invited', email, { email });
      return ok(
        CreateInvitationResponseSchema,
        { invitation, path: `/invite/demo-${invitation.id}` },
        201,
      );
    },
  },
  {
    method: 'DELETE',
    pattern: new RegExp(`^${P}/invitations/([^/]+)$`),
    run: (ctx) => {
      const p = project(ctx.state, ctx.params[0]!);
      requireAction(ctx.state, p, 'members.invite');
      const invitation = p.invitations.find((i) => i.id === ctx.params[1]);
      if (!invitation) notFound('This invitation no longer exists.');
      p.invitations = p.invitations.filter((i) => i.id !== invitation.id);
      log(ctx, p, 'invitation.cancelled', invitation.email, { email: invitation.email });
      return NO_CONTENT;
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/invitations\/([^/]+)$/,
    run: () =>
      notInDemo(
        'joining with an invitation link needs a real server. In the real DevSpace, the invited person opens this link to join the project.',
      ),
  },
  {
    method: 'POST',
    pattern: /^\/api\/invitations\/([^/]+)\/accept$/,
    run: () => notInDemo('joining with an invitation link needs a real server.'),
  },

  // ----- Repository -----
  {
    method: 'GET',
    pattern: new RegExp(`^${P}/repository$`),
    run: ({ state, params }) =>
      ok(RepositoryResponseSchema, { repository: repositoryView(project(state, params[0]!)) }),
  },
  {
    method: 'POST',
    pattern: new RegExp(`^${P}/repository$`),
    run: (ctx) => {
      const p = project(ctx.state, ctx.params[0]!);
      requireAction(ctx.state, p, 'repository.setup');
      const request = parseBody(SetUpRepositoryRequestSchema, ctx.body);
      if (p.repository.status === 'ready')
        conflict('repository_exists', 'This project already has a repository.');
      const template =
        request.source === 'empty'
          ? 'empty'
          : request.source === 'template'
            ? request.template
            : null;
      if (template !== 'empty' && template !== 'html') {
        notInDemo(
          'importing a project or using this template needs a real server. Pick the Empty or the HTML/CSS/JS website template.',
        );
      }
      p.main = template === 'html' ? htmlTemplateFiles(p.name) : { 'README.md': `# ${p.name}\n` };
      const message =
        request.source === 'empty'
          ? 'Add README.md'
          : `Start from the ${TEMPLATES.find((t) => t.id === template)!.name} template`;
      addCommit(ctx, p, message, nameOf(ctx.state, ctx.state.meId));
      p.repository = {
        status: 'ready',
        source: request.source === 'empty' ? 'empty' : 'template',
        template: request.source === 'empty' ? null : template,
      };
      log(ctx, p, 'repository.created', null, { template: p.repository.template ?? 'empty' });
      return ok(RepositoryResponseSchema, { repository: repositoryView(p) }, 202);
    },
  },
  {
    method: 'GET',
    pattern: new RegExp(`^${P}/tree$`),
    run: ({ state, params, query }) => {
      const p = project(state, params[0]!);
      const path = parseBody(RepoPathSchema, query.get('path') ?? '');
      if (p.repository.status !== 'ready')
        conflict('repository_not_ready', 'The repository isn’t ready yet.');
      const prefix = path === '' ? '' : `${path}/`;
      const inside = Object.keys(p.main).filter((f) => f.startsWith(prefix));
      if (path !== '' && inside.length === 0) notFound('There is no folder at this path on main.');
      const entries = new Map<
        string,
        { name: string; path: string; type: 'dir' | 'file'; size: number | null }
      >();
      for (const file of inside) {
        const [name, ...rest] = file.slice(prefix.length).split('/');
        const entryPath = prefix + name!;
        if (rest.length > 0)
          entries.set(entryPath, { name: name!, path: entryPath, type: 'dir', size: null });
        else {
          const size = new TextEncoder().encode(p.main[file]!).length;
          entries.set(entryPath, { name: name!, path: entryPath, type: 'file', size });
        }
      }
      const sorted = [...entries.values()].sort(
        (a, b) =>
          Number(b.type === 'dir') - Number(a.type === 'dir') ||
          a.name.toLowerCase().localeCompare(b.name.toLowerCase()),
      );
      return ok(TreeResponseSchema, { path, entries: sorted });
    },
  },
  {
    method: 'GET',
    pattern: new RegExp(`^${P}/file$`),
    run: ({ state, params, query }) => {
      const p = project(state, params[0]!);
      const path = parseBody(RepoPathSchema, query.get('path') ?? '');
      if (p.repository.status !== 'ready')
        conflict('repository_not_ready', 'The repository isn’t ready yet.');
      const content = p.main[path];
      if (content === undefined) notFound('There is no file at this path on main.');
      return ok(FileResponseSchema, {
        path,
        size: new TextEncoder().encode(content).length,
        isBinary: false,
        tooLarge: false,
        content,
      });
    },
  },

  // ----- Copies and the IDE -----
  {
    method: 'GET',
    pattern: new RegExp(`^${P}/copy$`),
    run: ({ state, params }) => {
      const p = project(state, params[0]!);
      const copy = myCopy(state, p);
      return ok(CopyResponseSchema, { copy: copy ? copyView(state, p, copy) : null });
    },
  },
  {
    method: 'POST',
    pattern: new RegExp(`^${P}/copy$`),
    run: (ctx) => {
      const p = project(ctx.state, ctx.params[0]!);
      if (p.repository.status !== 'ready')
        conflict('repository_not_ready', 'The repository isn’t ready yet.');
      const existing = myCopy(ctx.state, p);
      const copy = existing ?? makeCopy(ctx, p);
      return ok(CopyResponseSchema, { copy: copyView(ctx.state, p, copy) }, existing ? 200 : 201);
    },
  },
  {
    method: 'GET',
    pattern: new RegExp(`^${P}/members/([^/]+)/copy$`),
    run: ({ state, params }) => {
      const p = project(state, params[0]!);
      requireAction(state, p, 'copy.helpFixConflict');
      const copy = p.copies[params[1]!];
      if (!copy || !p.members.some((m) => m.userId === params[1]))
        notFound('This member has no copy yet.');
      return ok(CopyResponseSchema, { copy: copyView(state, p, copy) });
    },
  },
  ...[
    `^${P}/copy/ide$`,
    `^${P}/copy/ide/launch$`,
    `^${P}/members/([^/]+)/copy/ide$`,
    `^${P}/members/([^/]+)/copy/ide/launch$`,
  ].map((pattern): Route => ({
    method: 'POST',
    pattern: new RegExp(pattern),
    run: () => notInDemo(IDE_REASON),
  })),
  ...[`^${P}/copy/preview/launch$`, `^${P}/members/([^/]+)/copy/preview/launch$`].map(
    (pattern): Route => ({
      method: 'POST',
      pattern: new RegExp(pattern),
      run: () =>
        notInDemo('Preview shows the app running in your own IDE, which needs a real server.'),
    }),
  ),
  {
    method: 'GET',
    pattern: new RegExp(`^${P}/copy/update$`),
    run: ({ state, params }) => {
      const p = project(state, params[0]!);
      const copy = requireMyCopy(state, p);
      return ok(CopyUpdatePreviewSchema, {
        behind: copy.baseSha !== latestSha(p),
        conflictPaths: copyConflicts(p, copy).sort(),
      });
    },
  },
  {
    method: 'POST',
    pattern: new RegExp(`^${P}/copy/update$`),
    run: (ctx) => {
      const p = project(ctx.state, ctx.params[0]!);
      const copy = requireMyCopy(ctx.state, p);
      const behind = copy.baseSha !== latestSha(p);
      const conflictPaths = behind ? updateCopy(p, copy).sort() : [];
      if (behind) {
        log(ctx, p, 'copy.updated', ctx.state.meId, {
          mainSha: latestSha(p),
          conflictPaths,
          automatic: false,
        });
      }
      return ok(CopyUpdateResponseSchema, { copy: copyView(ctx.state, p, copy), conflictPaths });
    },
  },
  {
    method: 'POST',
    pattern: new RegExp(`^${P}/copy/packages-dismiss$`),
    run: ({ state, params }) => {
      const p = project(state, params[0]!);
      const copy = requireMyCopy(state, p);
      return ok(CopyResponseSchema, { copy: copyView(state, p, copy) });
    },
  },
  {
    method: 'GET',
    pattern: new RegExp(`^${P}/copy/changes$`),
    run: ({ state, params }) => {
      const p = project(state, params[0]!);
      const copy = requireMyCopy(state, p);
      const active = p.submissions.filter(
        (s) => s.authorId === state.meId && isActiveSubmissionStatus(s.status),
      );
      return ok(CopyChangesResponseSchema, {
        baseSha: copy.baseSha,
        files: copyChanges(copy).map(({ path, change }) => ({
          path,
          change,
          openSubmissionId: active.find((s) => s.files.some((f) => f.path === path))?.id ?? null,
        })),
      });
    },
  },

  // ----- Submissions -----
  {
    method: 'GET',
    pattern: new RegExp(`^${P}/submissions$`),
    run: ({ state, params, query }) => {
      const p = project(state, params[0]!);
      const all = query.get('status') === 'all';
      const list = p.submissions
        .filter((s) => all || isActiveSubmissionStatus(s.status))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map((s) => submissionSummary(state, p, s));
      return ok(SubmissionListResponseSchema, { submissions: list });
    },
  },
  {
    method: 'POST',
    pattern: new RegExp(`^${P}/submissions$`),
    run: (ctx) => {
      const p = project(ctx.state, ctx.params[0]!);
      const request = parseBody(CreateSubmissionRequestSchema, ctx.body);
      const copy = requireMyCopy(ctx.state, p);
      const files = filesFromCopy(ctx.state, p, copy, request.paths, null);
      const linked = request.taskId ? checkTaskLink(p, request.taskId) : null;
      const s: DemoSubmission = {
        id: nextId(ctx.state, 'sub'),
        title: request.title,
        description: request.description,
        status: 'open',
        authorId: ctx.state.meId,
        version: 1,
        createdAt: ctx.now(),
        updatedAt: ctx.now(),
        baseSha: copy.baseSha,
        headSha: fakeSha(nextId(ctx.state, 'head')),
        rejectReason: null,
        closedAt: null,
        files,
        reviews: [],
        comments: [],
        conflictPaths: [],
        mergedSha: null,
        mergedById: null,
        mergedAt: null,
        revertedSha: null,
        revertedById: null,
        revertedAt: null,
        taskId: linked?.id ?? null,
      };
      p.submissions.push(s);
      log(ctx, p, 'submission.created', s.id, { title: s.title });
      if (linked) autoMove(ctx, p, linked, 'in_review');
      return submissionReply(ctx, p, s, 201);
    },
  },
  {
    method: 'GET',
    pattern: new RegExp(`^${P}/submissions/([^/]+)$`),
    run: (ctx) => {
      const p = project(ctx.state, ctx.params[0]!);
      return submissionReply(ctx, p, submission(p, ctx.params[1]!));
    },
  },
  {
    method: 'GET',
    pattern: new RegExp(`^${P}/submissions/([^/]+)/file$`),
    run: ({ state, params, query }) => {
      const p = project(state, params[0]!);
      const s = submission(p, params[1]!);
      const file = s.files.find((f) => f.path === query.get('path'));
      if (!file) notFound('This file isn’t in the submission.');
      const side = (content: string | null) =>
        content === null ? { kind: 'none' as const } : { kind: 'text' as const, content };
      return ok(SubmissionFileResponseSchema, {
        path: file.path,
        change: file.change,
        base: side(file.base),
        head: side(file.head),
      });
    },
  },
  {
    method: 'POST',
    pattern: new RegExp(`^${P}/submissions/([^/]+)/update$`),
    run: (ctx) => {
      const p = project(ctx.state, ctx.params[0]!);
      const s = submission(p, ctx.params[1]!);
      if (s.authorId !== ctx.state.meId) forbidden('Only the author can update a submission.');
      requireActive(s);
      const request = parseBody(UpdateSubmissionRequestSchema, ctx.body);
      const copy = requireMyCopy(ctx.state, p);
      const paths = request.paths ?? s.files.map((f) => f.path);
      s.files = filesFromCopy(ctx.state, p, copy, paths, s.id);
      if (request.title !== undefined) s.title = request.title;
      if (request.description !== undefined) s.description = request.description;
      if (request.taskId !== undefined) {
        const old = linkedTask(p, s);
        const next = request.taskId === null ? null : checkTaskLink(p, request.taskId);
        s.taskId = next?.id ?? null;
        if (old && old.id !== next?.id) linkEnded(ctx, p, old, s.id);
        if (next) autoMove(ctx, p, next, 'in_review');
      }
      s.version += 1;
      s.reviews = s.reviews.map((r) => ({ ...r, stale: true }));
      s.status = 'open';
      s.conflictPaths = [];
      s.baseSha = copy.baseSha;
      s.headSha = fakeSha(nextId(ctx.state, 'head'));
      s.updatedAt = ctx.now();
      log(ctx, p, 'submission.updated', s.id, { title: s.title, version: s.version });
      return submissionReply(ctx, p, s);
    },
  },
  {
    method: 'POST',
    pattern: new RegExp(`^${P}/submissions/([^/]+)/reviews$`),
    run: (ctx) => {
      const p = project(ctx.state, ctx.params[0]!);
      const s = submission(p, ctx.params[1]!);
      if (!allows(ctx.state, p, 'submission.approve')) forbidden();
      if (s.authorId === ctx.state.meId) forbidden('You can’t review your own submission.');
      requireActive(s);
      const request = parseBody(CreateReviewRequestSchema, ctx.body);
      s.reviews.push({
        id: nextId(ctx.state, 'review'),
        reviewer: userRef(ctx.state, ctx.state.meId),
        decision: request.decision,
        body: request.body?.trim() ? request.body : null,
        version: s.version,
        stale: false,
        createdAt: ctx.now(),
      });
      if (s.status !== 'needs_update') {
        const current = currentReviews(s);
        s.status = current.some((r) => r.decision === 'changes_requested')
          ? 'changes_requested'
          : current.some((r) => r.decision === 'approved')
            ? 'approved'
            : 'open';
      }
      s.updatedAt = ctx.now();
      log(ctx, p, 'submission.reviewed', s.id, { decision: request.decision });
      return submissionReply(ctx, p, s);
    },
  },
  {
    method: 'POST',
    pattern: new RegExp(`^${P}/submissions/([^/]+)/reject$`),
    run: (ctx) => {
      const p = project(ctx.state, ctx.params[0]!);
      const s = submission(p, ctx.params[1]!);
      requireAction(ctx.state, p, 'submission.reject');
      requireActive(s);
      const { reason } = parseBody(RejectSubmissionRequestSchema, ctx.body);
      s.status = 'rejected';
      s.rejectReason = reason;
      s.closedAt = ctx.now();
      s.updatedAt = ctx.now();
      log(ctx, p, 'submission.rejected', s.id, { title: s.title, reason });
      linkEnded(ctx, p, linkedTask(p, s), s.id);
      return submissionReply(ctx, p, s);
    },
  },
  {
    method: 'POST',
    pattern: new RegExp(`^${P}/submissions/([^/]+)/close$`),
    run: (ctx) => {
      const p = project(ctx.state, ctx.params[0]!);
      const s = submission(p, ctx.params[1]!);
      if (s.authorId !== ctx.state.meId && !isLead(ctx.state, p)) forbidden();
      requireActive(s);
      s.status = 'closed';
      s.closedAt = ctx.now();
      s.updatedAt = ctx.now();
      log(ctx, p, 'submission.closed', s.id, { title: s.title });
      linkEnded(ctx, p, linkedTask(p, s), s.id);
      return submissionReply(ctx, p, s);
    },
  },
  {
    method: 'POST',
    pattern: new RegExp(`^${P}/submissions/([^/]+)/merge$`),
    run: (ctx) => {
      const p = project(ctx.state, ctx.params[0]!);
      const s = submission(p, ctx.params[1]!);
      requireAction(ctx.state, p, 'submission.merge');
      requireActive(s);
      const blocker = mergeBlocker(p, s);
      if (blocker === 'approval_required') {
        conflict('approval_required', 'This project needs an approval before merging.');
      }
      // Main changed under these files since they were submitted: the author must update.
      const clashes = s.files.filter((f) => (p.main[f.path] ?? null) !== f.base).map((f) => f.path);
      if (blocker === 'needs_update' || clashes.length > 0) {
        const paths = clashes.length > 0 ? clashes : s.conflictPaths;
        s.status = 'needs_update';
        s.conflictPaths = [...paths].sort();
        s.updatedAt = ctx.now();
        conflict('merge_conflict', 'This submission now clashes with main.', {
          paths: s.conflictPaths,
        });
      }
      if (s.files.every((f) => (p.main[f.path] ?? null) === f.head)) {
        conflict('already_in_main', 'Main already has these changes.');
      }
      for (const file of s.files) {
        if (file.head === null) delete p.main[file.path];
        else p.main[file.path] = file.head;
      }
      const sha = addCommit(ctx, p, s.title, nameOf(ctx.state, s.authorId));
      s.status = 'merged';
      s.mergedSha = sha;
      s.mergedById = ctx.state.meId;
      s.mergedAt = ctx.now();
      s.updatedAt = ctx.now();
      log(ctx, p, 'submission.merged', s.id, { title: s.title, sha });
      const t = linkedTask(p, s);
      if (t && t.status !== 'done') {
        autoMove(ctx, p, t, 'in_review');
        t.doneConfirmPending = true;
      }
      mainMoved(ctx, p);
      return submissionReply(ctx, p, s);
    },
  },
  {
    method: 'POST',
    pattern: new RegExp(`^${P}/submissions/([^/]+)/revert$`),
    run: (ctx) => {
      const p = project(ctx.state, ctx.params[0]!);
      const s = submission(p, ctx.params[1]!);
      requireAction(ctx.state, p, 'submission.revert');
      if (s.status !== 'merged')
        conflict('submission_not_active', 'Only a merged submission can be undone.');
      const changedSince = s.files
        .filter((f) => (p.main[f.path] ?? null) !== f.head)
        .map((f) => f.path);
      if (changedSince.length > 0) {
        conflict('revert_conflict', 'Later merges changed the same lines.', {
          paths: changedSince.sort(),
        });
      }
      for (const file of s.files) {
        if (file.base === null) delete p.main[file.path];
        else p.main[file.path] = file.base;
      }
      const sha = addCommit(ctx, p, `Undo “${s.title}”`, nameOf(ctx.state, ctx.state.meId));
      s.status = 'reverted';
      s.revertedSha = sha;
      s.revertedById = ctx.state.meId;
      s.revertedAt = ctx.now();
      s.updatedAt = ctx.now();
      log(ctx, p, 'submission.reverted', s.id, { title: s.title, sha });
      const t = linkedTask(p, s);
      if (t && (t.status === 'done' || t.doneConfirmPending)) {
        t.doneConfirmPending = false;
        autoMove(ctx, p, t, 'in_progress');
        t.reopenNote = `Merge of “${s.title}” was undone`;
      }
      mainMoved(ctx, p);
      return submissionReply(ctx, p, s);
    },
  },
  {
    method: 'POST',
    pattern: new RegExp(`^${P}/submissions/([^/]+)/comments$`),
    run: (ctx) => {
      const p = project(ctx.state, ctx.params[0]!);
      const s = submission(p, ctx.params[1]!);
      const actions = submissionActions(ctx.state, p, s);
      if (!actions.includes('comment')) forbidden();
      const request = parseBody(CreateCommentRequestSchema, ctx.body);
      if (request.suggestion !== undefined && !actions.includes('suggest')) forbidden();
      if (request.parentId !== undefined && !s.comments.some((c) => c.id === request.parentId)) {
        notFound('That comment no longer exists.');
      }
      if (request.path !== undefined && !s.files.some((f) => f.path === request.path)) {
        notFound('This file isn’t in the submission.');
      }
      const comment = {
        id: nextId(ctx.state, 'comment'),
        author: userRef(ctx.state, ctx.state.meId),
        parentId: request.parentId ?? null,
        path: request.path ?? null,
        side: request.side ?? null,
        line: request.line ?? null,
        startLine: request.line === undefined ? null : (request.startLine ?? request.line),
        version: s.version,
        body: request.body,
        suggestion: request.suggestion ?? null,
        suggestionStatus: request.suggestion === undefined ? null : ('pending' as const),
        outdated: false,
        createdAt: ctx.now(),
      };
      s.comments.push(comment);
      log(ctx, p, 'submission.commented', s.id, { title: s.title });
      return ok(CommentResponseSchema, { comment }, 201);
    },
  },
  {
    method: 'POST',
    pattern: new RegExp(`^${P}/submissions/([^/]+)/comments/([^/]+)/suggestion$`),
    run: (ctx) => {
      const p = project(ctx.state, ctx.params[0]!);
      const s = submission(p, ctx.params[1]!);
      if (s.authorId !== ctx.state.meId) forbidden('Only the author can answer a suggestion.');
      requireActive(s);
      const { decision } = parseBody(SuggestionDecisionRequestSchema, ctx.body);
      const comment = s.comments.find((c) => c.id === ctx.params[2]);
      if (!comment || comment.suggestion === null) notFound('That suggestion no longer exists.');
      if (comment.suggestionStatus !== 'pending') {
        conflict('suggestion_not_pending', 'This suggestion was already answered.');
      }
      if (decision === 'reject') {
        comment.suggestionStatus = 'rejected';
        log(ctx, p, 'submission.suggestion_rejected', s.id, { title: s.title });
        return submissionReply(ctx, p, s);
      }
      const file = s.files.find((f) => f.path === comment.path);
      if (!file || file.head === null || comment.line === null) {
        conflict('suggestion_stale', 'Those lines have changed since this suggestion was made.');
      }
      const lines = file.head.split('\n');
      const start = (comment.startLine ?? comment.line) - 1;
      const replacement = comment.suggestion === '' ? [] : comment.suggestion.split('\n');
      lines.splice(start, comment.line - start, ...replacement);
      file.head = lines.join('\n');
      const copy = myCopy(ctx.state, p);
      if (copy) copy.changes[file.path] = file.head;
      comment.suggestionStatus = 'accepted';
      s.version += 1;
      s.reviews = s.reviews.map((r) => ({ ...r, stale: true }));
      s.status = 'open';
      s.headSha = fakeSha(nextId(ctx.state, 'head'));
      s.updatedAt = ctx.now();
      log(ctx, p, 'submission.suggestion_accepted', s.id, { title: s.title });
      return submissionReply(ctx, p, s);
    },
  },

  // ----- AI review -----
  {
    method: 'GET',
    pattern: new RegExp(`^${P}/submissions/([^/]+)/ai-reviews$`),
    run: ({ state, params }) => {
      const p = project(state, params[0]!);
      const s = submission(p, params[1]!);
      if (!p.settings.aiReviewEnabled) {
        conflict(
          'ai_disabled',
          'AI review is off for this project. A leader can turn it on in Settings.',
        );
      }
      const reviews = p.aiReviews
        .filter((r) => r.submissionId === s.id)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      const current = reviews.filter((r) => r.version === s.version && r.status === 'done');
      return ok(AiReviewListResponseSchema, {
        version: s.version,
        reviews,
        groups: groupAiFindings(current),
        running: false,
      });
    },
  },
  {
    method: 'POST',
    pattern: new RegExp(`^${P}/submissions/([^/]+)/ai-reviews$`),
    run: () =>
      notInDemo(
        'asking AI models for a new review needs a real server and an OpenRouter account. The reviews shown are samples from the real system.',
      ),
  },
  {
    method: 'POST',
    pattern: new RegExp(`^${P}/submissions/([^/]+)/ide-review$`),
    run: () => notInDemo(IDE_REASON),
  },
  {
    method: 'GET',
    pattern: /^\/api\/ai\/connection$/,
    run: ({ state }) => ok(AiConnectionViewSchema, aiConnection(state)),
  },
  {
    method: 'DELETE',
    pattern: /^\/api\/ai\/connection$/,
    run: () =>
      notInDemo(
        'the sample OpenRouter connection stays on, because connecting again needs a real server.',
      ),
  },
  ...['start', 'finish'].map((step): Route => ({
    method: 'POST',
    pattern: new RegExp(`^/api/ai/openrouter/${step}$`),
    run: () => notInDemo('connecting an OpenRouter account needs a real server.'),
  })),
  {
    method: 'POST',
    pattern: /^\/api\/ai\/notice\/accept$/,
    run: ({ state }) =>
      ok(AiNoticeAcceptResponseSchema, { noticeAcceptedAt: aiConnection(state).noticeAcceptedAt }),
  },
  {
    method: 'GET',
    pattern: /^\/api\/ai\/preferences$/,
    run: ({ state }) =>
      ok(AiPreferencesSchema, {
        allowPaid: state.allowPaidModels,
        assistantUsageToday: {
          day: new Date().toISOString().slice(0, 10),
          requests: 4,
          models: [{ model: 'qwen/qwen3-coder:free', requests: 4 }],
        },
      }),
  },
  {
    method: 'PATCH',
    pattern: /^\/api\/ai\/preferences$/,
    run: (ctx) => {
      ctx.state.allowPaidModels = parseBody(UpdateAiPreferencesRequestSchema, ctx.body).allowPaid;
      return ok(AiPreferencesSchema, {
        allowPaid: ctx.state.allowPaidModels,
        assistantUsageToday: {
          day: new Date().toISOString().slice(0, 10),
          requests: 4,
          models: [{ model: 'qwen/qwen3-coder:free', requests: 4 }],
        },
      });
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/ai\/models$/,
    run: () =>
      ok(AiModelListResponseSchema, {
        models: AI_MODELS,
        defaults: AI_MODELS.filter((m) => m.isFree).map((m) => m.id),
        fallbacks: ['openrouter/free'],
      }),
  },

  // ----- Notifications, presence, preferences -----
  {
    method: 'GET',
    pattern: /^\/api\/notifications$/,
    run: ({ state, query }) => {
      const mine = state.notifications.filter(
        (n) => n.project === null || myProjects(state).some((p) => p.id === n.project?.id),
      );
      return ok(NotificationListResponseSchema, {
        notifications: query.has('cursor') ? [] : mine.slice(0, 30),
        unreadCount: mine.filter((n) => n.readAt === null).length,
        nextCursor: null,
      });
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/notifications\/read$/,
    run: (ctx) => {
      const request = parseBody(MarkNotificationsReadRequestSchema, ctx.body);
      const ids = 'ids' in request ? new Set(request.ids) : null;
      for (const n of ctx.state.notifications) {
        if (n.readAt === null && (ids === null || ids.has(n.id))) n.readAt = ctx.now();
      }
      return ok(MarkNotificationsReadResponseSchema, {
        unreadCount: ctx.state.notifications.filter((n) => n.readAt === null).length,
      });
    },
  },
  {
    method: 'GET',
    pattern: new RegExp(`^${P}/presence$`),
    run: ({ state, params }) => {
      const p = project(state, params[0]!);
      const members = p.members.map(
        (m) =>
          p.presence.find((x) => x.user.id === m.userId) ?? {
            user: userRef(state, m.userId),
            state: m.userId === state.meId ? ('online' as const) : ('offline' as const),
            file: null,
            copyOwner: null,
            lastSeenAt: m.userId === state.meId ? new Date().toISOString() : null,
          },
      );
      return ok(PresenceListResponseSchema, {
        members: members.map((m) =>
          m.user.id === state.meId ? { ...m, lastSeenAt: new Date().toISOString() } : m,
        ),
      });
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/me\/preferences$/,
    run: ({ state }) => ok(PreferencesSchema, { shareOpenFile: state.shareOpenFile }),
  },
  {
    method: 'PATCH',
    pattern: /^\/api\/me\/preferences$/,
    run: (ctx) => {
      ctx.state.shareOpenFile = parseBody(UpdatePreferencesRequestSchema, ctx.body).shareOpenFile;
      return ok(PreferencesSchema, { shareOpenFile: ctx.state.shareOpenFile });
    },
  },

  // ----- Getting started -----
  {
    method: 'GET',
    pattern: new RegExp(`^${P}/getting-started$`),
    run: ({ state, params }) =>
      ok(GettingStartedViewSchema, gettingStarted(state, project(state, params[0]!))),
  },
  ...(['hide', 'show'] as const).map((action): Route => ({
    method: 'POST',
    pattern: new RegExp(`^${P}/getting-started/${action}$`),
    run: ({ state, params }) => {
      const p = project(state, params[0]!);
      p.gettingStartedHidden = action === 'hide';
      return ok(GettingStartedViewSchema, gettingStarted(state, p));
    },
  })),

  // ----- Tasks -----
  {
    method: 'GET',
    pattern: new RegExp(`^${P}/tasks$`),
    run: ({ state, params }) => {
      const p = project(state, params[0]!);
      const tasks = [...p.tasks]
        .sort((a, b) => TASK_ORDER[a.status] - TASK_ORDER[b.status] || a.position - b.position)
        .map((t) => taskView(state, p, t));
      return ok(TaskListResponseSchema, { tasks });
    },
  },
  {
    method: 'POST',
    pattern: new RegExp(`^${P}/tasks$`),
    run: (ctx) => {
      const p = project(ctx.state, ctx.params[0]!);
      requireAction(ctx.state, p, 'task.create');
      const request = parseBody(CreateTaskRequestSchema, ctx.body);
      checkAssignees(p, request.assigneeIds);
      const t: DemoTask = {
        id: nextId(ctx.state, 'task'),
        title: request.title,
        description: request.description,
        status: 'todo',
        dueDate: request.dueDate ?? null,
        position: endOfColumn(p, 'todo'),
        assigneeIds: request.assigneeIds,
        createdById: ctx.state.meId,
        doneConfirmPending: false,
        reopenNote: null,
        createdAt: ctx.now(),
        updatedAt: ctx.now(),
        completedAt: null,
      };
      p.tasks.push(t);
      log(ctx, p, 'task.created', t.id, { title: t.title });
      return taskReply(ctx, p, t, 201);
    },
  },
  {
    method: 'PATCH',
    pattern: new RegExp(`^${P}/tasks/([^/]+)$`),
    run: (ctx) => {
      const p = project(ctx.state, ctx.params[0]!);
      const t = task(p, ctx.params[1]!);
      if (!taskActions(ctx.state, p, t).includes('edit')) forbidden();
      const changes = parseBody(UpdateTaskRequestSchema, ctx.body);
      if (changes.assigneeIds) checkAssignees(p, changes.assigneeIds);
      if (changes.title !== undefined) t.title = changes.title;
      if (changes.description !== undefined) t.description = changes.description;
      if (changes.assigneeIds !== undefined) t.assigneeIds = changes.assigneeIds;
      if (changes.dueDate !== undefined) t.dueDate = changes.dueDate;
      t.updatedAt = ctx.now();
      log(ctx, p, 'task.updated', t.id, { title: t.title });
      return taskReply(ctx, p, t);
    },
  },
  {
    method: 'DELETE',
    pattern: new RegExp(`^${P}/tasks/([^/]+)$`),
    run: (ctx) => {
      const p = project(ctx.state, ctx.params[0]!);
      const t = task(p, ctx.params[1]!);
      if (!isLead(ctx.state, p)) forbidden();
      p.tasks = p.tasks.filter((x) => x.id !== t.id);
      for (const s of p.submissions) if (s.taskId === t.id) s.taskId = null;
      log(ctx, p, 'task.deleted', t.id, { title: t.title });
      return NO_CONTENT;
    },
  },
  {
    method: 'POST',
    pattern: new RegExp(`^${P}/tasks/([^/]+)/move$`),
    run: (ctx) => {
      const p = project(ctx.state, ctx.params[0]!);
      const t = task(p, ctx.params[1]!);
      const { status, position } = parseBody(MoveTaskRequestSchema, ctx.body);
      const lead = isLead(ctx.state, p);
      const isAssignee = t.assigneeIds.includes(ctx.state.meId);
      if (!lead && !isAssignee) forbidden();
      if (!allowedTaskMoves(t.status, { isLead: lead, isAssignee }).includes(status)) {
        conflict('invalid_move', 'You can only move your tasks between To do and In progress.');
      }
      const from = t.status;
      t.status = status;
      t.position = position;
      t.reopenNote = null;
      t.updatedAt = ctx.now();
      if (status === 'done') {
        t.completedAt = ctx.now();
        t.doneConfirmPending = false;
      } else t.completedAt = null;
      if (from !== status)
        log(ctx, p, 'task.moved', t.id, { title: t.title, from, to: status, automatic: false });
      return taskReply(ctx, p, t);
    },
  },
  {
    method: 'POST',
    pattern: new RegExp(`^${P}/tasks/([^/]+)/confirm-done$`),
    run: (ctx) => {
      const p = project(ctx.state, ctx.params[0]!);
      const t = task(p, ctx.params[1]!);
      if (!isLead(ctx.state, p)) forbidden();
      const { done } = parseBody(ConfirmTaskDoneRequestSchema, ctx.body);
      if (!t.doneConfirmPending)
        conflict('not_pending', 'This task is no longer waiting for a decision.');
      t.doneConfirmPending = false;
      t.reopenNote = null;
      if (done) {
        t.status = 'done';
        t.position = endOfColumn(p, 'done', t.id);
        t.completedAt = ctx.now();
      } else {
        const active = p.submissions.some(
          (s) => s.taskId === t.id && isActiveSubmissionStatus(s.status),
        );
        t.status = active ? 'in_review' : 'in_progress';
      }
      t.updatedAt = ctx.now();
      log(ctx, p, 'task.done_confirmed', t.id, { title: t.title, done });
      return taskReply(ctx, p, t);
    },
  },

  // ----- GitHub -----
  {
    method: 'GET',
    pattern: /^\/api\/github\/account$/,
    run: () =>
      ok(GithubAccountViewSchema, {
        configured: true,
        connected: false,
        login: null,
        connectedAt: null,
        installUrl: null,
        appInstalled: null,
      }),
  },
  {
    method: 'DELETE',
    pattern: /^\/api\/github\/account$/,
    run: () => notInDemo('GitHub needs a real server.'),
  },
  ...['start', 'finish'].map((step): Route => ({
    method: 'POST',
    pattern: new RegExp(`^/api/github/connect/${step}$`),
    run: () => notInDemo('connecting a GitHub account needs a real server.'),
  })),
  {
    method: 'GET',
    pattern: /^\/api\/github\/repos$/,
    run: () => notInDemo('importing from GitHub needs a real server.'),
  },
  {
    method: 'GET',
    pattern: new RegExp(`^${P}/github$`),
    run: ({ state, params }) => {
      const p = project(state, params[0]!);
      return ok(ProjectGithubViewSchema, {
        configured: true,
        connected: false,
        installUrl: null,
        link: null,
        canPublish: allows(state, p, 'github.publish'),
        canManage: false,
        canUnlink: false,
        emailWarning: { names: [] },
      });
    },
  },
  ...[
    ['POST', `^${P}/github/publish$`],
    ['POST', `^${P}/github/sync$`],
    ['DELETE', `^${P}/github$`],
  ].map(([method, pattern]): Route => ({
    method: method!,
    pattern: new RegExp(pattern!),
    run: () => notInDemo('publishing to GitHub needs a real server and a GitHub account.'),
  })),
];

function checkAssignees(p: DemoProject, ids: string[]) {
  const unknown = ids.filter((id) => !p.members.some((m) => m.userId === id));
  if (unknown.length > 0) {
    throw new HttpError(400, 'validation_error', 'Pick people who are in the project', {
      fields: { assigneeIds: ['Pick people who are in the project'] },
    });
  }
}

/**
 * Answer one request to `/api/...` from the demo state (changed in place for writes).
 * Never throws: every failure is an error answer shaped like the API's.
 */
export function handleDemoRequest(
  state: DemoState,
  method: string,
  url: string,
  body: unknown,
): DemoReply {
  const parsed = new URL(url, 'http://demo.invalid');
  const path = parsed.pathname;
  const upper = method.toUpperCase();
  try {
    for (const route of routes) {
      if (route.method !== upper) continue;
      const match = route.pattern.exec(path);
      if (!match) continue;
      if (!route.public && !state.loggedIn) {
        throw new HttpError(401, 'unauthenticated', 'Log in first');
      }
      const params = match.slice(1).map((value) => decodeURIComponent(value));
      return route.run({
        state,
        params,
        query: parsed.searchParams,
        body,
        now: () => new Date().toISOString(),
      });
    }
    throw new HttpError(
      404,
      UNKNOWN_ROUTE,
      `${NOT_IN_DEMO_PREFIX} this part of DevSpace isn’t in the demo.`,
    );
  } catch (error) {
    if (error instanceof HttpError) {
      return {
        status: error.status,
        body: ErrorResponseSchema.parse({
          error: error.code,
          message: error.message,
          ...error.extra,
        }),
      };
    }
    // A bug in the stand-in: say so plainly, like a server error.
    console.error('Demo API error', error);
    return {
      status: 500,
      body: {
        error: 'internal_error',
        message: 'Something went wrong in the demo. Try Reset demo.',
      },
    };
  }
}
