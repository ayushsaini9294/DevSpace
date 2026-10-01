import { randomUUID } from 'node:crypto';
import {
  can,
  ProjectGithubViewSchema,
  type GithubLinkView,
  type GithubMode,
  type ProjectGithubView,
  type PublishGithubRequest,
} from '@devspace/shared';
import { recordActivity } from '../activity/log.ts';
import type { Prisma } from '../generated/prisma/client.ts';
import { MAIN_REF, resolveCommit } from '../git/repo.ts';
import { queueGithubSync } from '../jobs/github-sync.ts';
import { HttpError } from '../lib/http-error.ts';
import { prisma } from '../lib/prisma.ts';
import { transaction } from '../lib/transaction.ts';
import { notify, projectLeads } from '../notifications/service.ts';
import { forbidden, readSettings, type Db, type ProjectAccess } from '../projects/access.ts';
import { invalidateAfterCommit, sendInvalidate } from '../realtime/emitter.ts';
import { GithubApiError, isRepo, rest, type GhRepo } from './api.ts';
import {
  notConnected,
  githubError,
  ownInstallation,
  userInstallations,
  withUserToken,
} from './account.ts';
import { githubConfig, htmlUrlOf, installUrlOf, requireGithubConfig } from './config.ts';
import { emailWarningNames } from './identity.ts';
import { pushMain } from './push.ts';

/**
 * A project's GitHub link (Phase 13): publish, keep updated, Try again and unlink. Pushes run
 * in the worker (`github-sync` job), one at a time per project (a claim on the link row), and
 * never force: when GitHub has commits DevSpace doesn't, the link is paused.
 */

/** A push claim older than this is taken over (its worker died). */
export const PUSH_CLAIM_STALE_MS = 15 * 60 * 1000;
/** Housekeeping picks up links waiting this long for a push that never started. */
export const SYNC_WAIT_RETRY_MS = 2 * 60 * 1000;

export const PAUSED_REASON = 'GitHub has changes made outside DevSpace';

const notPublished = () =>
  new HttpError(409, 'not_published', "This project isn't published to GitHub");
const notReady = () =>
  new HttpError(409, 'repository_not_ready', "The project's repository isn't ready yet");

const linkInclude = { setUpBy: { select: { id: true, name: true } } } as const;

type LinkRow = Prisma.GithubLinkGetPayload<{ include: typeof linkInclude }>;

async function linkView(row: LinkRow, gitDir: string | null): Promise<GithubLinkView> {
  const main = gitDir ? await resolveCommit(gitDir, MAIN_REF).catch(() => null) : null;
  return {
    repoFullName: row.repoFullName,
    htmlUrl: row.htmlUrl,
    private: row.private,
    mode: row.mode,
    status: row.status,
    statusReason: row.statusReason,
    lastPushedSha: row.lastPushedSha,
    lastPushedAt: row.lastPushedAt?.toISOString() ?? null,
    behind: main !== null && main !== row.lastPushedSha,
    setUpBy: row.setUpBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** GET /api/projects/:projectId/github. */
export async function projectGithubView(access: ProjectAccess): Promise<ProjectGithubView> {
  const c = githubConfig();
  const [row, account, project] = await Promise.all([
    prisma.githubLink.findUnique({ where: { projectId: access.project.id }, include: linkInclude }),
    prisma.githubAccount.findUnique({ where: { userId: access.userId }, select: { id: true } }),
    prisma.project.findUniqueOrThrow({
      where: { id: access.project.id },
      select: { repoStatus: true, repoPath: true },
    }),
  ]);
  const gitDir = project.repoStatus === 'ready' ? project.repoPath : null;
  const mayPublish = can(access.role, access.permissions, 'github.publish');
  const isLead = access.role === 'leader' || access.role === 'co_leader';
  const canPublish = c !== null && mayPublish && row === null;
  let names: string[] = [];
  if (canPublish && gitDir) {
    try {
      names = await emailWarningNames(gitDir);
    } catch (err) {
      console.error(
        'Could not read main’s history for the email warning:',
        err instanceof Error ? err.message : err,
      );
    }
  }
  return ProjectGithubViewSchema.parse({
    configured: c !== null,
    connected: c !== null && account !== null,
    installUrl: c ? installUrlOf(c) : null,
    link: row ? await linkView(row, gitDir) : null,
    canPublish,
    canManage: c !== null && row !== null && mayPublish,
    canUnlink: row !== null && isLead,
    emailWarning: { names },
  });
}

function repoExists() {
  return new HttpError(
    409,
    'repo_exists',
    'You already have a repository with this name on GitHub; pick another name',
  );
}

/**
 * POST /api/projects/:projectId/github/publish. Creates the repository on the publisher's
 * account with their user token, makes sure the app's installation covers it, saves the link
 * and queues the first push (the full history of main).
 */
export async function publishProject(
  access: ProjectAccess,
  request: PublishGithubRequest,
): Promise<void> {
  const c = requireGithubConfig();
  if (!can(access.role, access.permissions, 'github.publish')) throw forbidden();
  const projectId = access.project.id;
  const project = await prisma.project.findUniqueOrThrow({
    where: { id: projectId },
    select: { repoStatus: true, repoPath: true },
  });
  if (project.repoStatus !== 'ready' || !project.repoPath) throw notReady();
  if (!(await resolveCommit(project.repoPath, MAIN_REF))) throw notReady();
  if (await prisma.githubLink.findUnique({ where: { projectId }, select: { id: true } })) {
    throw new HttpError(409, 'already_published', 'This project is already published to GitHub');
  }
  const names = await emailWarningNames(project.repoPath);
  if (names.length > 0 && !request.acceptEmailWarning) {
    throw new HttpError(
      409,
      'email_warning_not_accepted',
      'Some people’s email addresses in older changes will be public on GitHub; tick the box to confirm',
      undefined,
      { names },
    );
  }
  const account = await prisma.githubAccount.findUnique({
    where: { userId: access.userId },
    select: { githubUserId: true },
  });
  if (!account) throw notConnected();

  let repo: GhRepo;
  let installationId: number;
  try {
    ({ repo, installationId } = await withUserToken(c, access.userId, async (token) => {
      const installation = ownInstallation(await userInstallations(c, token), account.githubUserId);
      if (!installation) {
        throw new HttpError(
          409,
          'app_not_installed',
          'Install the DevSpace app on your GitHub account first',
          undefined,
          { installUrl: installUrlOf(c) },
        );
      }
      let created: GhRepo;
      try {
        const { data } = await rest(c, 'POST', '/user/repos', token, {
          name: request.name,
          private: request.private,
          auto_init: false,
          description: `${access.project.name} (published from DevSpace)`.slice(0, 350),
        });
        if (!isRepo(data)) throw new GithubApiError('bad_response', null, '');
        created = data;
      } catch (err) {
        if (
          err instanceof GithubApiError &&
          err.kind === 'http' &&
          err.status === 422 &&
          [err.providerMessage, ...err.details].some((m) => /already exists/i.test(m))
        ) {
          throw repoExists();
        }
        throw err;
      }
      if (installation.repository_selection !== 'all') {
        await rest(
          c,
          'PUT',
          `/user/installations/${installation.id}/repositories/${created.id}`,
          token,
        );
      }
      return { repo: created, installationId: installation.id };
    }));
  } catch (err) {
    throw githubError(err, 'Publishing to GitHub failed');
  }

  try {
    await transaction(async (tx) => {
      await tx.githubLink.create({
        data: {
          projectId,
          installationId: BigInt(installationId),
          repoId: BigInt(repo.id),
          repoFullName: repo.full_name,
          htmlUrl: htmlUrlOf(c, repo.full_name),
          private: repo.private,
          mode: request.mode,
          setUpById: access.userId,
          status: 'pushing',
          syncRequestedAt: new Date(),
        },
      });
      const stored = await tx.project.findUniqueOrThrow({
        where: { id: projectId },
        select: { settings: true },
      });
      const settings = readSettings(stored.settings);
      if (settings.githubMode !== request.mode) {
        await tx.project.update({
          where: { id: projectId },
          data: { settings: { ...settings, githubMode: request.mode } },
        });
      }
      await recordActivity(tx, {
        projectId,
        actorId: access.userId,
        action: 'github.published',
        data: {
          repoFullName: repo.full_name,
          htmlUrl: htmlUrlOf(c, repo.full_name),
          private: repo.private,
          mode: request.mode,
        },
      });
      await invalidateAfterCommit(tx, projectId, ['github', 'members']);
    });
  } catch (err) {
    if ((err as { code?: string }).code === 'P2002') {
      throw new HttpError(409, 'already_published', 'This project is already published to GitHub');
    }
    throw err;
  }
  await queueGithubSync(projectId);
}

/**
 * Asks for a push: marks the link `pushing` and queues the job. `automatic` (after a merge or
 * revert) does nothing unless the mode is keep updated, and leaves a paused link paused.
 * Returns whether a push was asked for.
 */
export async function requestGithubSync(
  projectId: string,
  options: { automatic: boolean },
): Promise<boolean> {
  const where = options.automatic
    ? { projectId, mode: 'keep_updated' as const, status: { not: 'paused' as const } }
    : { projectId };
  const { count } = await prisma.githubLink.updateMany({
    where,
    data: { status: 'pushing', statusReason: null, syncRequestedAt: new Date() },
  });
  if (count === 0) return false;
  sendInvalidate(projectId, ['github']);
  await queueGithubSync(projectId);
  return true;
}

/** POST …/github/sync (Try again). */
export async function tryGithubSyncAgain(access: ProjectAccess): Promise<void> {
  requireGithubConfig();
  if (!can(access.role, access.permissions, 'github.publish')) throw forbidden();
  const link = await prisma.githubLink.findUnique({
    where: { projectId: access.project.id },
    select: { status: true, pushClaim: true },
  });
  if (!link) throw notPublished();
  if (link.status === 'pushing') {
    throw new HttpError(409, 'sync_running', 'DevSpace is already sending main to GitHub');
  }
  await requestGithubSync(access.project.id, { automatic: false });
}

/** DELETE …/github: leaders and co-leaders. The GitHub repository stays. */
export async function unlinkProject(access: ProjectAccess): Promise<void> {
  if (access.role !== 'leader' && access.role !== 'co_leader') throw forbidden();
  await transaction(async (tx) => {
    const link = await tx.githubLink.findUnique({
      where: { projectId: access.project.id },
      select: { repoFullName: true },
    });
    if (!link) throw notPublished();
    await tx.githubLink.delete({ where: { projectId: access.project.id } });
    await recordActivity(tx, {
      projectId: access.project.id,
      actorId: access.userId,
      action: 'github.unlinked',
      data: { repoFullName: link.repoFullName },
    });
    await invalidateAfterCommit(tx, access.project.id, ['github']);
  });
}

/** Settings changed `githubMode`: the link follows it; keep updated pushes at once. */
export async function onGithubModeChanged(
  db: Db,
  projectId: string,
  mode: GithubMode,
): Promise<boolean> {
  const { count } = await db.githubLink.updateMany({ where: { projectId }, data: { mode } });
  if (count > 0) await invalidateAfterCommit(db, projectId, ['github']);
  return count > 0 && mode === 'keep_updated';
}

// ---------- The push itself (worker) ----------

export type SyncResult = 'ok' | 'paused' | 'failed' | 'busy' | 'none';

async function settle(
  projectId: string,
  claim: string,
  outcome: { kind: 'ok'; sha: string } | { kind: 'paused' } | { kind: 'failed'; reason: string },
): Promise<'again' | SyncResult> {
  return transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM github_links WHERE project_id = ${projectId} FOR UPDATE`;
    const link = await tx.githubLink.findUnique({ where: { projectId } });
    if (!link || link.pushClaim !== claim) return 'none';
    const now = new Date();
    if (outcome.kind === 'ok') {
      if (link.syncRequestedAt) {
        // Main moved (or someone asked) while pushing: go again.
        await tx.githubLink.update({
          where: { projectId },
          data: {
            lastPushedSha: outcome.sha,
            lastPushedAt: now,
            syncRequestedAt: null,
            pushStartedAt: now,
          },
        });
        await invalidateAfterCommit(tx, projectId, ['github']);
        return 'again';
      }
      await tx.githubLink.update({
        where: { projectId },
        data: {
          lastPushedSha: outcome.sha,
          lastPushedAt: now,
          status: 'ok',
          statusReason: null,
          pushClaim: null,
          pushStartedAt: null,
        },
      });
      await invalidateAfterCommit(tx, projectId, ['github']);
      return 'ok';
    }
    const status = outcome.kind === 'paused' ? 'paused' : 'failed';
    const reason = outcome.kind === 'paused' ? PAUSED_REASON : outcome.reason;
    const already = link.status === status && link.statusReason === reason;
    await tx.githubLink.update({
      where: { projectId },
      data: {
        status,
        statusReason: reason,
        pushClaim: null,
        pushStartedAt: null,
        syncRequestedAt: null,
      },
    });
    if (!already) {
      await recordActivity(tx, {
        projectId,
        actorId: null,
        action: status === 'paused' ? 'github.sync_paused' : 'github.sync_failed',
        data: { repoFullName: link.repoFullName, reason },
      });
      await notify(tx, {
        type: status === 'paused' ? 'github.sync_paused' : 'github.sync_failed',
        projectId,
        userIds: await projectLeads(tx, projectId),
        actorId: null,
        data: { repoFullName: link.repoFullName, reason },
      });
    }
    await invalidateAfterCommit(tx, projectId, ['github']);
    return status;
  });
}

/**
 * Pushes the project's main to its linked repository (the `github-sync` job). One push per
 * project at a time: if another is running, this returns `busy` and that one takes on the
 * request when it finishes. Never throws for GitHub problems: they become `failed`/`paused`.
 */
export async function runGithubSync(projectId: string): Promise<SyncResult> {
  const claim = randomUUID();
  const now = new Date();
  const { count } = await prisma.githubLink.updateMany({
    where: {
      projectId,
      OR: [
        { pushClaim: null },
        { pushStartedAt: { lt: new Date(now.getTime() - PUSH_CLAIM_STALE_MS) } },
      ],
    },
    data: { pushClaim: claim, pushStartedAt: now, syncRequestedAt: null },
  });
  if (count === 0) {
    const exists = await prisma.githubLink.count({ where: { projectId } });
    return exists ? 'busy' : 'none';
  }
  try {
    for (let round = 0; round < 20; round++) {
      const c = githubConfig();
      const [link, project] = await Promise.all([
        prisma.githubLink.findUnique({ where: { projectId } }),
        prisma.project.findUnique({
          where: { id: projectId },
          select: { repoPath: true, repoStatus: true },
        }),
      ]);
      if (!link || link.pushClaim !== claim) return 'none';
      let outcome: Parameters<typeof settle>[2];
      const main =
        project?.repoPath && project.repoStatus === 'ready'
          ? await resolveCommit(project.repoPath, MAIN_REF)
          : null;
      if (!c) {
        outcome = { kind: 'failed', reason: "GitHub isn't set up on this DevSpace any more" };
      } else if (!main || !project?.repoPath) {
        outcome = { kind: 'failed', reason: "The project's repository isn't ready" };
      } else {
        const pushed = await pushMain(c, project.repoPath, link, main);
        outcome =
          pushed.kind === 'ok'
            ? { kind: 'ok', sha: main }
            : pushed.kind === 'non_fast_forward'
              ? { kind: 'paused' }
              : pushed;
      }
      const result = await settle(projectId, claim, outcome);
      if (result !== 'again') return result;
    }
    return 'busy';
  } catch (err) {
    console.error(
      `GitHub push of project ${projectId} failed:`,
      err instanceof Error ? err.message : err,
    );
    await settle(projectId, claim, {
      kind: 'failed',
      reason: 'Pushing to GitHub failed because of a server error; DevSpace will try again',
    }).catch(() => undefined);
    return 'failed';
  } finally {
    // Never leave our claim behind (settle releases it on every normal path).
    await prisma.githubLink
      .updateMany({
        where: { projectId, pushClaim: claim },
        data: { pushClaim: null, pushStartedAt: null },
      })
      .catch(() => undefined);
  }
}

/**
 * Housekeeping (every minute): retries `failed` links, and pushes links that have waited too
 * long for a push that never started (a lost job) or whose pusher died. Never touches `paused`.
 */
export async function retryGithubSyncs(
  options: { now?: Date; projectIds?: string[] } = {},
): Promise<{ retried: string[] }> {
  if (!githubConfig()) return { retried: [] };
  const now = options.now ?? new Date();
  const rows = await prisma.githubLink.findMany({
    where: {
      ...(options.projectIds ? { projectId: { in: options.projectIds } } : {}),
      OR: [
        { status: 'failed', pushClaim: null },
        {
          status: 'pushing',
          pushClaim: null,
          OR: [
            { syncRequestedAt: null },
            { syncRequestedAt: { lt: new Date(now.getTime() - SYNC_WAIT_RETRY_MS) } },
          ],
        },
        {
          pushClaim: { not: null },
          pushStartedAt: { lt: new Date(now.getTime() - PUSH_CLAIM_STALE_MS) },
        },
      ],
    },
    select: { projectId: true },
  });
  const retried: string[] = [];
  for (const { projectId } of rows) {
    try {
      await runGithubSync(projectId);
      retried.push(projectId);
    } catch (err) {
      console.error(
        `GitHub retry of project ${projectId} failed:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  return { retried };
}

/** After a merge or revert: push main if the project keeps GitHub updated. */
export async function afterMainMovedGithub(projectId: string): Promise<void> {
  try {
    await requestGithubSync(projectId, { automatic: true });
  } catch (err) {
    console.error(
      `Could not ask for a GitHub push of ${projectId}:`,
      err instanceof Error ? err.message : err,
    );
  }
}
