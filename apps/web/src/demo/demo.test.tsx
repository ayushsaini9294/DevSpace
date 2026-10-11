/// <reference types="node" />
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ZodType } from 'zod';
import {
  ActivityListResponseSchema,
  AiConnectionViewSchema,
  AiModelListResponseSchema,
  AiPreferencesSchema,
  AiReviewListResponseSchema,
  AuthResponseSchema,
  CommentResponseSchema,
  CopyChangesResponseSchema,
  CopyResponseSchema,
  CopyUpdatePreviewSchema,
  ErrorResponseSchema,
  FileResponseSchema,
  GettingStartedViewSchema,
  GithubAccountViewSchema,
  HealthResponseSchema,
  InvitationListResponseSchema,
  MemberListResponseSchema,
  NotificationListResponseSchema,
  PreferencesSchema,
  PresenceListResponseSchema,
  ProjectGithubViewSchema,
  ProjectListResponseSchema,
  ProjectResponseSchema,
  RepositoryResponseSchema,
  SubmissionFileResponseSchema,
  SubmissionListResponseSchema,
  SubmissionResponseSchema,
  TaskListResponseSchema,
  TaskResponseSchema,
  TeamDetailResponseSchema,
  TeamListResponseSchema,
  TemplateListSchema,
  TreeResponseSchema,
} from '@devspace/shared';
import { routes } from '../app/routes';
import { renderApp } from '../test/utils';
import { demoRoutes } from './routes';
import { NOT_IN_DEMO, UNKNOWN_ROUTE } from './server';
import { demoFetch, installDemoApi, resetDemoState } from './standIn';
import { SAMPLE_PROJECT_ID as P, SAMPLE_TEAM_ID } from './state';

beforeAll(() => {
  installDemoApi();
});

beforeEach(() => {
  sessionStorage.clear();
  resetDemoState();
});

async function call(method: string, path: string, body?: unknown) {
  const res = await demoFetch(path, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as unknown) : null };
}

const base = `/api/projects/${P}`;

/** Every read the pages make, with the shared schema its answer must match. */
const READS: [string, ZodType][] = [
  ['/api/health', HealthResponseSchema],
  ['/api/auth/me', AuthResponseSchema],
  ['/api/templates', TemplateListSchema],
  ['/api/teams', TeamListResponseSchema],
  [`/api/teams/${SAMPLE_TEAM_ID}`, TeamDetailResponseSchema],
  ['/api/projects', ProjectListResponseSchema],
  [base, ProjectResponseSchema],
  [`${base}/members`, MemberListResponseSchema],
  [`${base}/invitations`, InvitationListResponseSchema],
  [`${base}/activity`, ActivityListResponseSchema],
  [`${base}/repository`, RepositoryResponseSchema],
  [`${base}/tree?path=`, TreeResponseSchema],
  [`${base}/tree?path=src`, TreeResponseSchema],
  [`${base}/file?path=index.html`, FileResponseSchema],
  [`${base}/copy`, CopyResponseSchema],
  [`${base}/members/maya-chen/copy`, CopyResponseSchema],
  [`${base}/copy/update`, CopyUpdatePreviewSchema],
  [`${base}/copy/changes`, CopyChangesResponseSchema],
  [`${base}/submissions?status=active`, SubmissionListResponseSchema],
  [`${base}/submissions?status=all`, SubmissionListResponseSchema],
  [`${base}/submissions/sub-gallery`, SubmissionResponseSchema],
  [`${base}/submissions/sub-gallery/file?path=script.js`, SubmissionFileResponseSchema],
  [`${base}/submissions/sub-gallery/file?path=gallery.html`, SubmissionFileResponseSchema],
  [`${base}/submissions/sub-gallery/ai-reviews`, AiReviewListResponseSchema],
  [`${base}/tasks`, TaskListResponseSchema],
  [`${base}/presence`, PresenceListResponseSchema],
  [`${base}/getting-started`, GettingStartedViewSchema],
  [`${base}/github`, ProjectGithubViewSchema],
  ['/api/notifications', NotificationListResponseSchema],
  ['/api/me/preferences', PreferencesSchema],
  ['/api/ai/connection', AiConnectionViewSchema],
  ['/api/ai/preferences', AiPreferencesSchema],
  ['/api/ai/models', AiModelListResponseSchema],
  ['/api/github/account', GithubAccountViewSchema],
];

/** Everything that needs a real server: answered with "Not available in the demo". */
const NEEDS_A_SERVER: [string, string][] = [
  ['POST', `${base}/copy/ide`],
  ['POST', `${base}/copy/ide/launch`],
  ['POST', `${base}/members/leo-martins/copy/ide`],
  ['POST', `${base}/members/leo-martins/copy/ide/launch`],
  ['POST', `${base}/copy/preview/launch`],
  ['POST', `${base}/members/leo-martins/copy/preview/launch`],
  ['POST', `${base}/submissions/sub-gallery/ai-reviews`],
  ['POST', `${base}/submissions/sub-gallery/ide-review`],
  ['POST', '/api/ai/openrouter/start'],
  ['POST', '/api/ai/openrouter/finish'],
  ['DELETE', '/api/ai/connection'],
  ['POST', '/api/github/connect/start'],
  ['POST', '/api/github/connect/finish'],
  ['DELETE', '/api/github/account'],
  ['GET', '/api/github/repos'],
  ['POST', `${base}/github/publish`],
  ['POST', `${base}/github/sync`],
  ['DELETE', `${base}/github`],
  ['GET', '/api/invitations/some-token'],
  ['POST', '/api/invitations/some-token/accept'],
];

describe('the demo stand-in API', () => {
  it.each(READS)('answers GET %s with the shared shape', async (path, schema) => {
    const { status, body } = await call('GET', path);
    expect(status).toBe(200);
    expect(schema.safeParse(body).success).toBe(true);
  });

  it.each(NEEDS_A_SERVER)(
    'answers %s %s with “Not available in the demo”',
    async (method, path) => {
      const { status, body } = await call(method, path, {});
      expect(status).toBe(409);
      const error = ErrorResponseSchema.parse(body);
      expect(error.error).toBe(NOT_IN_DEMO);
      expect(error.message).toMatch(/^Not available in the demo:/);
    },
  );

  // Merge, undo and their refusals have their own tests below.
  it('answers every write the pages make (none is unknown to it)', async () => {
    const writes: [string, string, unknown][] = [
      ['POST', '/api/auth/login', { email: 'a@example.com', password: 'x' }],
      ['POST', '/api/auth/signup', { name: 'A', email: 'a@example.com', password: 'xxxxxxxx' }],
      ['POST', '/api/teams', { name: 'Another team' }],
      ['POST', `/api/teams/${SAMPLE_TEAM_ID}/projects`, { name: 'Science fair' }],
      ['PATCH', base, { name: 'Class Website 2' }],
      ['PATCH', `${base}/settings`, { requireApproval: true }],
      ['PATCH', `${base}/members/sara-okafor`, { permissions: { approve: true } }],
      ['POST', `${base}/invitations`, { email: 'new.friend@example.com' }],
      ['POST', `${base}/repository`, { source: 'empty' }],
      ['POST', `${base}/copy`, {}],
      ['POST', `${base}/copy/update`, {}],
      ['POST', `${base}/copy/packages-dismiss`, {}],
      ['POST', `${base}/submissions`, { title: 'About us page', paths: ['about.html'] }],
      ['POST', `${base}/submissions/sub-gallery/reviews`, { decision: 'approved' }],
      ['POST', `${base}/submissions/sub-gallery/comments`, { body: 'Nice work!' }],
      ['POST', `${base}/submissions/sub-dark/reject`, { reason: 'Not this term' }],
      ['POST', `${base}/submissions/sub-gallery/close`, {}],
      ['POST', `${base}/submissions/sub-contact/merge`, {}],
      ['POST', `${base}/tasks`, { title: 'Plan the trip', assigneeIds: ['leo-martins'] }],
      ['PATCH', `${base}/tasks/task-photo`, { title: 'Add the class photo' }],
      ['POST', `${base}/tasks/task-photo/move`, { status: 'in_progress', position: 5 }],
      ['DELETE', `${base}/tasks/task-footer`, {}],
      ['POST', `${base}/getting-started/hide`, {}],
      ['POST', `${base}/getting-started/show`, {}],
      ['POST', '/api/notifications/read', { all: true }],
      ['PATCH', '/api/me/preferences', { shareOpenFile: false }],
      ['POST', '/api/ai/notice/accept', {}],
      ['PATCH', '/api/ai/preferences', { allowPaid: true }],
      ['POST', '/api/auth/logout', {}],
    ];
    for (const [method, path, body] of writes) {
      const { status, body: reply } = await call(method, path, body);
      const code = (reply as { error?: string } | null)?.error;
      expect({ method, path, code }).not.toMatchObject({ code: UNKNOWN_ROUTE });
      // Only the repository (already set up) refuses here, as the real API would.
      if (!(method === 'POST' && path === `${base}/repository`)) {
        expect({ method, path, status }).toMatchObject({ status: expect.any(Number) });
        expect(status, `${method} ${path}: ${JSON.stringify(reply)}`).toBeLessThan(400);
      }
    }
  });

  it('merges into main: main’s files and history change, and the task can be marked Done', async () => {
    const before = await call('GET', `${base}/tree?path=`);
    expect(JSON.stringify(before.body)).not.toContain('contact.html');

    const merged = SubmissionResponseSchema.parse(
      (await call('POST', `${base}/submissions/sub-contact/merge`)).body,
    ).submission;
    expect(merged.status).toBe('merged');
    expect(merged.mergedBy?.name).toBe('Demo Leader');
    expect(merged.viewerActions).toContain('revert');
    expect(merged.viewerActions).toContain('confirmTaskDone');

    const file = FileResponseSchema.parse(
      (await call('GET', `${base}/file?path=contact.html`)).body,
    );
    expect(file.content).toContain('<form class="contact-form"');
    const index = FileResponseSchema.parse(
      (await call('GET', `${base}/file?path=index.html`)).body,
    );
    expect(index.content).toContain('contact.html');
    const repository = RepositoryResponseSchema.parse(
      (await call('GET', `${base}/repository`)).body,
    ).repository;
    expect(repository.lastCommit?.message).toBe('Add a contact form');
    expect(repository.lastCommit?.authorName).toBe('Sara Okafor');

    const done = TaskResponseSchema.parse(
      (await call('POST', `${base}/tasks/task-contact/confirm-done`, { done: true })).body,
    ).task;
    expect(done.status).toBe('done');
  });

  it('refuses to merge work that clashes with main, like the real API', async () => {
    // Without the approval rule, both can be merged straight away.
    await call('PATCH', `${base}/settings`, { requireApproval: false });
    expect((await call('POST', `${base}/submissions/sub-gallery/merge`)).status).toBe(200);
    const clash = await call('POST', `${base}/submissions/sub-dark/merge`);
    expect(clash.status).toBe(409);
    expect(ErrorResponseSchema.parse(clash.body)).toMatchObject({
      error: 'merge_conflict',
      details: { paths: ['script.js', 'style.css'] },
    });
  });

  it('undoes a merge: main goes back', async () => {
    const reverted = SubmissionResponseSchema.parse(
      (await call('POST', `${base}/submissions/sub-nav/revert`)).body,
    ).submission;
    expect(reverted.status).toBe('reverted');
    const index = FileResponseSchema.parse(
      (await call('GET', `${base}/file?path=index.html`)).body,
    );
    expect(index.content).not.toContain('class="menu"');
  });

  it('keeps comments as line comments and suggestions', async () => {
    const reply = await call('POST', `${base}/submissions/sub-gallery/comments`, {
      body: 'Maybe a caption under each photo?',
      path: 'gallery.html',
      side: 'head',
      line: 3,
    });
    expect(reply.status).toBe(201);
    expect(CommentResponseSchema.parse(reply.body).comment).toMatchObject({
      line: 3,
      startLine: 3,
    });
  });

  it('remembers changes for the visit and forgets them on Reset demo', async () => {
    await call('POST', `${base}/tasks`, { title: 'Plan the trip', assigneeIds: ['leo-martins'] });
    expect(sessionStorage.getItem('devspace-demo-state')).toContain('Plan the trip');
    resetDemoState();
    const tasks = TaskListResponseSchema.parse((await call('GET', `${base}/tasks`)).body).tasks;
    expect(tasks.map((t) => t.title)).not.toContain('Plan the trip');
    expect(sessionStorage.getItem('devspace-demo-state')).toBeNull();
  });

  it('has the task board in every column', async () => {
    const tasks = TaskListResponseSchema.parse((await call('GET', `${base}/tasks`)).body).tasks;
    expect(new Set(tasks.map((t) => t.status))).toEqual(
      new Set(['todo', 'in_progress', 'in_review', 'done']),
    );
  });

  it('only answers requests for this site’s /api', async () => {
    // A request elsewhere is left to the network; `/api` here never reaches it.
    const res = await fetch('/api/health');
    expect(HealthResponseSchema.parse(await res.json())).toEqual({
      ok: true,
      db: true,
      redis: true,
    });
  });
});

const appRoutes = demoRoutes(routes);

/** One URL per page of the app, with the sample data's ids. */
const PAGES = [
  '/',
  '/login',
  '/signup',
  `/teams/${SAMPLE_TEAM_ID}`,
  '/settings/ai',
  '/settings/github',
  `/projects/${P}`,
  `/projects/${P}/files`,
  `/projects/${P}/files/src`,
  `/projects/${P}/blob/README.md`,
  `/projects/${P}/submissions`,
  `/projects/${P}/submissions/new`,
  `/projects/${P}/submissions/sub-gallery`,
  `/projects/${P}/tasks`,
  `/projects/${P}/members`,
  `/projects/${P}/activity`,
  `/projects/${P}/settings`,
  `/projects/${P}/ide`,
  `/projects/${P}/members/leo-martins/ide`,
  '/invite/demo-token',
  '/no/such/page',
];

describe('the demo pages', () => {
  it.each(PAGES)('shows the demo banner on %s', async (path) => {
    renderApp(path, appRoutes);
    const banner = await screen.findByTestId('demo-banner');
    expect(banner).toHaveTextContent('Demo with sample data. Nothing you do is saved.');
    expect(within(banner).getByRole('button', { name: 'Reset demo' })).toBeInTheDocument();
  });

  it('starts logged in as Demo Leader on the home page with the sample project', async () => {
    renderApp('/', appRoutes);
    expect(await screen.findByRole('link', { name: /Class Website/ })).toBeInTheDocument();
    expect(await screen.findByTestId('current-user')).toHaveTextContent('Demo Leader');
  });

  it('lets the visitor straight in from the log-in page after logging out', async () => {
    await call('POST', '/api/auth/logout', {});
    renderApp('/login', appRoutes);
    expect(await screen.findByText(/you don’t need an account/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Go in as Demo Leader' }));
    expect(await screen.findByTestId('current-user')).toHaveTextContent('Demo Leader');
  });

  it('explains the IDE instead of opening it', async () => {
    renderApp(`/projects/${P}/ide`, appRoutes);
    expect(
      await screen.findByRole('heading', {
        name: 'In the real DevSpace, your own VS Code opens here',
      }),
    ).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'IDE: Class Website' })).toBeInTheDocument();
  });

  it('merges an approved submission from the review page', async () => {
    renderApp(`/projects/${P}/submissions/sub-contact`, appRoutes);
    await userEvent.click(await screen.findByRole('button', { name: 'Merge' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Merge into main' }));
    expect(await screen.findByText('Merged by Demo Leader into main')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Undo merge' })).toBeInTheDocument();
  });

  it('shows “Not available in the demo” with the normal error message', async () => {
    renderApp(`/projects/${P}/members`, appRoutes);
    await userEvent.type(await screen.findByLabelText('Email'), 'someone@gmail.com');
    await userEvent.click(screen.getByRole('button', { name: 'Create invite link' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /Not available in the demo: invitations to real email addresses/,
    );
  });

  it('shows an invitation link’s page as not available', async () => {
    renderApp('/invite/demo-token', appRoutes);
    expect(await screen.findByText(/Not available in the demo/)).toBeInTheDocument();
  });
});

describe('the normal build', () => {
  // Tests run from apps/web.
  const src = join(process.cwd(), 'src');

  function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory())
        return name === 'demo' || name === 'test' ? [] : sourceFiles(path);
      return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
    });
  }

  it('loads the demo only from main.tsx, behind the flag, with a dynamic import', () => {
    const importers = sourceFiles(src).filter((file) =>
      /from ['"][./]+demo|import\(['"][./]+demo/.test(readFileSync(file, 'utf8')),
    );
    expect(importers.map((file) => relative(src, file).replaceAll('\\', '/'))).toEqual([
      'main.tsx',
    ]);
    const main = readFileSync(join(src, 'main.tsx'), 'utf8');
    expect(main).not.toMatch(/from ['"]\.\/demo/);
    expect(main).toMatch(
      /if \(import\.meta\.env\.VITE_DEMO === '1'\) \{\s+const demo = await import\('\.\/demo'\)/,
    );
  });
});
