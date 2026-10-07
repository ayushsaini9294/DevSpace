import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  ActivityListResponseSchema,
  CopyResponseSchema,
  CopyUpdatePreviewSchema,
  CopyUpdateResponseSchema,
  IdeLaunchResponseSchema,
} from '@devspace/shared';
import { CopyChangedError, removeEntry, writeEntry } from '../src/copies/safe-fs.ts';
import { applyPlan, planUpdate, updateProjectCopies } from '../src/copies/update.ts';
import { runHousekeeping } from '../src/housekeeping/index.ts';
import { createIdeServer } from '../src/ide/proxy.ts';
import { ideRequest } from './ide-host.ts';
import { prisma } from '../src/lib/prisma.ts';
import { addMember, as, cleanUp, expectError, signUp } from './helpers.ts';
import {
  approve,
  changes,
  getCopy,
  mainSha,
  merge,
  read,
  revert,
  setSettings,
  showFile,
  submit,
  url,
  world,
  write,
  type World,
} from './phase7.ts';

vi.setConfig({ testTimeout: 60_000 });

let ideServer: Server;
beforeAll(async () => {
  ideServer = createIdeServer();
  await new Promise<void>((resolve) => ideServer.listen(0, '127.0.0.1', resolve));
});
afterAll(async () => {
  ideServer.closeAllConnections();
  await new Promise((resolve) => ideServer.close(resolve));
  await cleanUp();
});

const A_BASE = 'export const a = 1;\nexport const b = 2;\nexport const c = 3;\n';
const A_ANN = 'export const a = 100;\nexport const b = 2;\nexport const c = 3;\n';
const A_BOB = 'export const a = 200;\nexport const b = 2;\nexport const c = 3;\n';

/** Ann's change to src/a.ts (and a new file), approved and merged. */
async function mergeAnn(w: World) {
  write(w.annCopy, 'src/a.ts', A_ANN);
  write(w.annCopy, 'src/new.ts', 'export const fresh = true;\n');
  const sub = await submit(w, w.ann, ['src/a.ts', 'src/new.ts'], 'Raise a');
  await approve(w, sub.id);
  const res = await merge(w, sub.id);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return sub;
}

async function preview(w: World, user = w.bob) {
  const res = await as(user).get(url(w, '/copy/update'));
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return CopyUpdatePreviewSchema.parse(res.body);
}

async function updateNow(w: World, user = w.bob) {
  const res = await as(user).post(url(w, '/copy/update'));
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return CopyUpdateResponseSchema.parse(res.body);
}

async function copyRow(id: string) {
  return prisma.copy.findUniqueOrThrow({ where: { id } });
}

/** Every file under a folder with its bytes' hash (to prove nothing in it changed). */
function snapshotDir(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (rel: string) => {
    for (const name of readdirSync(join(dir, rel))) {
      const path = rel ? `${rel}/${name}` : name;
      const st = lstatSync(join(dir, path));
      if (st.isDirectory()) walk(path);
      else if (st.isSymbolicLink()) out[path] = `link:${readlinkSync(join(dir, path))}`;
      else {
        out[path] = createHash('sha1')
          .update(readFileSync(join(dir, path)))
          .digest('hex');
      }
    }
  };
  walk('');
  return out;
}

describe('updating a copy (manual)', () => {
  it('brings main into the copy and keeps the member’s own changes', async () => {
    const w = await world();
    await setSettings(w, { copyUpdateMode: 'manual' });
    write(w.bobCopy, 'src/b.ts', 'export const b = 3;\n');
    write(w.bobCopy, 'notes.txt', 'mine\n');
    expect((await getCopy(w, w.bob)).behind).toBe(false);
    expect(await preview(w)).toEqual({ behind: false, conflictPaths: [] });
    await mergeAnn(w);

    expect((await getCopy(w, w.bob)).behind).toBe(true);
    expect(await preview(w)).toEqual({ behind: true, conflictPaths: [] });
    // Previewing writes nothing.
    expect(read(w.bobCopy, 'src/a.ts')).toBe(A_BASE);

    const result = await updateNow(w);
    expect(result.conflictPaths).toEqual([]);
    expect(result.copy.behind).toBe(false);
    expect(result.copy.unresolvedPaths).toEqual([]);
    expect(read(w.bobCopy, 'src/a.ts')).toBe(A_ANN);
    expect(read(w.bobCopy, 'src/new.ts')).toBe('export const fresh = true;\n');
    expect(read(w.bobCopy, 'src/b.ts')).toBe('export const b = 3;\n');
    expect(read(w.bobCopy, 'notes.txt')).toBe('mine\n');
    const main = await mainSha(w.gitDir);
    expect((await copyRow(w.bobCopyId)).baseSha).toBe(main);
    // Only his own work shows as changed now.
    const listed = await changes(w, w.bob);
    expect(listed.baseSha).toBe(main);
    expect(listed.files.map((f) => [f.path, f.change])).toEqual([
      ['notes.txt', 'added'],
      ['src/b.ts', 'modified'],
    ]);
    const log = ActivityListResponseSchema.parse((await as(w.bob).get(url(w, '/activity'))).body);
    expect(log.entries.find((e) => e.action === 'copy.updated')).toMatchObject({
      actorId: w.bob.id,
      target: w.bob.id,
      data: { mainSha: main, conflictPaths: [], automatic: false },
    });
    // Up to date: the same answer, nothing changes.
    expect((await updateNow(w)).conflictPaths).toEqual([]);
  });

  it('writes conflict markers labelled "your copy" and "main", tracked until resolved', async () => {
    const w = await world();
    await setSettings(w, { copyUpdateMode: 'manual' });
    write(w.bobCopy, 'src/a.ts', A_BOB);
    await mergeAnn(w);
    expect(await preview(w)).toEqual({ behind: true, conflictPaths: ['src/a.ts'] });

    const result = await updateNow(w);
    expect(result.conflictPaths).toEqual(['src/a.ts']);
    expect(read(w.bobCopy, 'src/a.ts')).toBe(
      '<<<<<<< your copy\nexport const a = 200;\n=======\nexport const a = 100;\n>>>>>>> main\n' +
        'export const b = 2;\nexport const c = 3;\n',
    );
    expect(read(w.bobCopy, 'src/new.ts')).toBe('export const fresh = true;\n');
    expect(result.copy.unresolvedPaths).toEqual(['src/a.ts']);
    expect(result.copy.behind).toBe(false);

    write(
      w.bobCopy,
      'src/a.ts',
      'export const a = 300;\nexport const b = 2;\nexport const c = 3;\n',
    );
    expect((await getCopy(w, w.bob)).unresolvedPaths).toEqual([]);
    expect((await copyRow(w.bobCopyId)).markerPaths).toEqual([]);
  });

  it('keeps the member’s version of binary and modify/delete conflicts', async () => {
    const w = await world({ ...BASE_WITH_BINARY });
    await setSettings(w, { copyUpdateMode: 'manual', requireApproval: false });
    write(w.annCopy, 'logo.bin', Buffer.from([0, 1, 2, 9]));
    rmSync(join(w.annCopy, 'docs/c.md'));
    const sub = await submit(w, w.ann, ['logo.bin', 'docs/c.md']);
    expect((await merge(w, sub.id)).status).toBe(200);

    write(w.bobCopy, 'logo.bin', Buffer.from([0, 1, 2, 7]));
    write(w.bobCopy, 'docs/c.md', 'Bob’s docs\n');
    const result = await updateNow(w);
    expect(result.conflictPaths).toEqual(['docs/c.md', 'logo.bin']);
    expect([...readFileSync(join(w.bobCopy, 'logo.bin'))]).toEqual([0, 1, 2, 7]);
    expect(read(w.bobCopy, 'docs/c.md')).toBe('Bob’s docs\n');
    expect(result.copy.unresolvedPaths).toEqual([]);
  });

  it('only the owner updates their own copy; no copy → 409', async () => {
    const w = await world();
    const outsider = await signUp('Olly Outsider');
    expectError(await as(outsider).get(url(w, '/copy/update')), 404, 'not_found');
    expectError(await as(outsider).post(url(w, '/copy/update')), 404, 'not_found');
    // The leader has no copy yet.
    expectError(await as(w.leader).get(url(w, '/copy/update')), 409, 'no_copy');
    expectError(await as(w.leader).post(url(w, '/copy/update')), 409, 'no_copy');
  });
});

const BASE_WITH_BINARY = {
  'README.md': '# Project\n',
  'src/a.ts': A_BASE,
  'src/b.ts': 'export const b = 2;\n',
  'docs/c.md': 'Docs\n',
  'logo.bin': '\0\u0001\u0002\u0003',
};

describe('copy_changed', () => {
  it('aborts the whole update when a file changed after the plan, and writes nothing', async () => {
    const w = await world();
    await setSettings(w, { copyUpdateMode: 'manual' });
    write(w.bobCopy, 'README.md', '# Bob\n');
    await mergeAnn(w);
    const row = await copyRow(w.bobCopyId);
    const plan = await planUpdate(w.gitDir, row);
    expect(plan.writes.map((x) => x.path)).toEqual(['src/a.ts', 'src/new.ts']);

    // The member edits a file the update would write (after the plan was made).
    write(w.bobCopy, 'src/new.ts', 'typed meanwhile\n');
    await expect(applyPlan(w.gitDir, w.bobCopy, plan)).rejects.toMatchObject({
      status: 409,
      body: { error: 'copy_changed' },
    });
    expect(read(w.bobCopy, 'src/a.ts')).toBe(A_BASE);
    expect(read(w.bobCopy, 'src/new.ts')).toBe('typed meanwhile\n');

    // A failure after the first file was written: what was written is put back.
    rmSync(join(w.bobCopy, 'src/new.ts'));
    const again = await planUpdate(w.gitDir, row);
    // Sabotage the second write so it fails mid-way (its blob doesn't exist).
    again.writes[1]!.to = { mode: '100644', sha: 'f'.repeat(40), size: 3 };
    await expect(applyPlan(w.gitDir, w.bobCopy, again)).rejects.toThrow();
    expect(read(w.bobCopy, 'src/a.ts')).toBe(A_BASE);
    expect(existsSync(join(w.bobCopy, 'src/new.ts'))).toBe(false);
    expect((await copyRow(w.bobCopyId)).baseSha).toBe(w.base);
  });
});

describe('automatic mode', () => {
  it('updates clean copies, leaves conflicting ones untouched, and housekeeping retries', async () => {
    const w = await world();
    write(w.bobCopy, 'src/a.ts', A_BOB);
    await mergeAnn(w);

    const result = await updateProjectCopies(w.projectId);
    // Ann's copy already holds the merged work; Bob's conflicts.
    expect(result.updated).toContain(w.annCopyId);
    expect(result.pending).toEqual([w.bobCopyId]);
    expect(read(w.bobCopy, 'src/a.ts')).toBe(A_BOB);
    expect(existsSync(join(w.bobCopy, 'src/new.ts'))).toBe(false);
    const bob = await getCopy(w, w.bob);
    expect(bob.behind).toBe(true);
    expect(bob.pendingConflictPaths).toEqual(['src/a.ts']);
    const log = ActivityListResponseSchema.parse((await as(w.ann).get(url(w, '/activity'))).body);
    expect(log.entries.find((e) => e.action === 'copy.updated')).toMatchObject({
      actorId: null,
      target: w.ann.id,
      data: { automatic: true },
    });

    // Bob gives up his edit; the minute-by-minute housekeeping brings his copy up to date.
    write(w.bobCopy, 'src/a.ts', A_BASE);
    const run = await runHousekeeping({ copyIds: [w.bobCopyId] });
    expect(run.updates.updated).toEqual([w.bobCopyId]);
    expect(read(w.bobCopy, 'src/a.ts')).toBe(A_ANN);
    const after = await getCopy(w, w.bob);
    expect(after).toMatchObject({ behind: false, pendingConflictPaths: [] });
  });

  it('does nothing in manual mode', async () => {
    const w = await world();
    await setSettings(w, { copyUpdateMode: 'manual' });
    await mergeAnn(w);
    const result = await updateProjectCopies(w.projectId);
    expect(result).toEqual({ updated: [], pending: [], upToDate: [], failed: [] });
    expect(read(w.bobCopy, 'src/a.ts')).toBe(A_BASE);
    expect((await runHousekeeping({ copyIds: [w.bobCopyId] })).updates.updated).toEqual([]);
  });

  it('after a revert the author keeps the work as changes; everyone else loses it', async () => {
    const w = await world();
    const sub = await mergeAnn(w);
    await updateProjectCopies(w.projectId);
    expect(read(w.bobCopy, 'src/a.ts')).toBe(A_ANN);
    expect((await changes(w, w.ann)).files).toEqual([]);

    expect((await revert(w, sub.id)).status).toBe(200);
    await updateProjectCopies(w.projectId);
    const main = await mainSha(w.gitDir);
    // Bob: back to the original.
    expect(read(w.bobCopy, 'src/a.ts')).toBe(A_BASE);
    expect(existsSync(join(w.bobCopy, 'src/new.ts'))).toBe(false);
    // Ann: files untouched, and they show up again as her changes against the new main.
    expect(read(w.annCopy, 'src/a.ts')).toBe(A_ANN);
    expect(read(w.annCopy, 'src/new.ts')).toBe('export const fresh = true;\n');
    const listed = await changes(w, w.ann);
    expect(listed.baseSha).toBe(main);
    expect(listed.files.map((f) => [f.path, f.change])).toEqual([
      ['src/a.ts', 'modified'],
      ['src/new.ts', 'added'],
    ]);
    expect(await showFile(w.gitDir, 'src/a.ts')).toBe(A_BASE);
  });
});

describe('security: updates never write through links and never touch .git', () => {
  it('never writes through a symlinked folder or file, and leaves .git alone', async () => {
    const w = await world();
    await setSettings(w, { copyUpdateMode: 'manual', requireApproval: false });
    write(w.annCopy, 'docs/c.md', 'New docs\n');
    write(w.annCopy, 'src/b.ts', 'export const b = 20;\n');
    const sub = await submit(w, w.ann, ['docs/c.md', 'src/b.ts']);
    expect((await merge(w, sub.id)).status).toBe(200);

    const outside = mkdtempSync(join(tmpdir(), 'devspace-outside-'));
    try {
      mkdirSync(join(outside, 'docs'));
      writeFileSync(join(outside, 'docs', 'c.md'), 'Docs\n');
      writeFileSync(join(outside, 'b.ts'), 'export const b = 2;\n');
      // Bob swaps the docs folder for a link outside, and src/b.ts for a link to a file outside.
      rmSync(join(w.bobCopy, 'docs'), { recursive: true });
      symlinkSync(join(outside, 'docs'), join(w.bobCopy, 'docs'));
      rmSync(join(w.bobCopy, 'src/b.ts'));
      symlinkSync(join(outside, 'b.ts'), join(w.bobCopy, 'src/b.ts'));
      const gitBefore = snapshotDir(join(w.bobCopy, '.git'));

      const result = await updateNow(w);
      expect(result.conflictPaths).toEqual(expect.arrayContaining(['src/b.ts']));
      // Nothing outside the copy changed, and the links are still links.
      expect(readFileSync(join(outside, 'docs', 'c.md'), 'utf8')).toBe('Docs\n');
      expect(readFileSync(join(outside, 'b.ts'), 'utf8')).toBe('export const b = 2;\n');
      expect(readdirSync(outside).sort()).toEqual(['b.ts', 'docs']);
      expect(lstatSync(join(w.bobCopy, 'docs')).isSymbolicLink()).toBe(true);
      expect(lstatSync(join(w.bobCopy, 'src/b.ts')).isSymbolicLink()).toBe(true);
      expect(snapshotDir(join(w.bobCopy, '.git'))).toEqual(gitBefore);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('the file helpers refuse links on the way, .git and paths that leave the copy', async () => {
    const root = mkdtempSync(join(tmpdir(), 'devspace-safe-'));
    const outside = mkdtempSync(join(tmpdir(), 'devspace-outside-'));
    try {
      mkdirSync(join(root, '.git'));
      symlinkSync(outside, join(root, 'linked'));
      writeFileSync(join(outside, 'target.txt'), 'outside\n');
      symlinkSync(join(outside, 'target.txt'), join(root, 'file-link'));

      for (const path of [
        'linked/x.txt',
        'linked/deeper/x.txt',
        '.git/config',
        '.GIT/hooks/x',
        '../x',
        'a/../../x',
      ]) {
        await expect(writeEntry(root, path, '100644', Buffer.from('evil'))).rejects.toBeInstanceOf(
          CopyChangedError,
        );
      }
      await expect(removeEntry(root, 'linked/target.txt')).rejects.toBeInstanceOf(CopyChangedError);
      expect(readdirSync(outside)).toEqual(['target.txt']);
      expect(readdirSync(join(root, '.git'))).toEqual([]);

      // A link at the file itself is replaced, never written through.
      await writeEntry(root, 'file-link', '100755', Buffer.from('mine\n'));
      expect(lstatSync(join(root, 'file-link')).isFile()).toBe(true);
      expect(statSync(join(root, 'file-link')).mode & 0o777).toBe(0o755);
      expect(readFileSync(join(outside, 'target.txt'), 'utf8')).toBe('outside\n');
      // New folders are made as real folders.
      await writeEntry(root, 'new/deep/file.txt', '100644', Buffer.from('ok\n'));
      expect(readFileSync(join(root, 'new/deep/file.txt'), 'utf8')).toBe('ok\n');
      await writeEntry(root, 'new/link', '120000', Buffer.from('../elsewhere'));
      expect(readlinkSync(join(root, 'new/link'))).toBe('../elsewhere');
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe('a lead opens a member’s copy', () => {
  const memberUrl = (w: World, userId: string, rest = '') =>
    url(w, `/members/${userId}/copy${rest}`);
  const ide = () => ideRequest(ideServer);

  async function markRunning(copyId: string) {
    await prisma.copy.update({ where: { id: copyId }, data: { containerStatus: 'running' } });
  }

  async function redeem(launchUrl: string): Promise<string> {
    const parsed = new URL(launchUrl);
    const res = await ide().get(parsed.href);
    expect(res.status, res.text).toBe(303);
    const raw = res.headers['set-cookie'] as unknown as string[];
    return raw.find((c) => c.startsWith('devspace_ide='))!.split(';')[0]!;
  }

  it('a lead may, is logged and shown to the member; members and ex-leads may not', async () => {
    const w = await world();
    const coLead = await signUp('Cora CoLead');
    await addMember(w.leader, w.projectId, coLead);
    const promote = await as(w.leader).patch(url(w, `/members/${coLead.id}`), {
      role: 'co_leader',
    });
    expect(promote.status).toBe(200);

    // Reading and launching.
    const view = await as(coLead).get(memberUrl(w, w.bob.id));
    expect(view.status, JSON.stringify(view.body)).toBe(200);
    expect(CopyResponseSchema.parse(view.body).copy?.id).toBe(w.bobCopyId);
    expectError(
      await as(coLead).post(memberUrl(w, w.bob.id, '/ide/launch')),
      409,
      'ide_not_running',
    );
    await markRunning(w.bobCopyId);
    const launch = await as(coLead).post(memberUrl(w, w.bob.id, '/ide/launch'));
    expect(launch.status, JSON.stringify(launch.body)).toBe(200);
    const cookie = await redeem(IdeLaunchResponseSchema.parse(launch.body).url);
    // Past every access check (503: no container behind this test copy).
    expect((await ide().get(`/ide/${w.bobCopyId}/`).set('Cookie', cookie)).status).toBe(503);
    // The cookie opens only that copy.
    await markRunning(w.annCopyId);
    expect((await ide().get(`/ide/${w.annCopyId}/`).set('Cookie', cookie)).status).toBe(404);

    // Logged, and the member sees who opened their copy.
    const bobView = await getCopy(w, w.bob);
    expect(bobView.helpers).toEqual([
      { user: { id: coLead.id, name: coLead.name }, at: expect.any(String) },
    ]);
    const log = ActivityListResponseSchema.parse((await as(w.bob).get(url(w, '/activity'))).body);
    expect(log.entries.find((e) => e.action === 'copy.helped')).toMatchObject({
      actorId: coLead.id,
      target: w.bob.id,
      data: { ownerName: w.bob.name },
    });
    expect((await getCopy(w, w.ann)).helpers).toEqual([]);

    // Plain members get 403; unknown users and members with no copy get 404.
    for (const user of [w.ann, w.rev]) {
      expectError(await as(user).get(memberUrl(w, w.bob.id)), 403, 'forbidden');
      expectError(await as(user).post(memberUrl(w, w.bob.id, '/ide')), 403, 'forbidden');
      expectError(await as(user).post(memberUrl(w, w.bob.id, '/ide/launch')), 403, 'forbidden');
    }
    expectError(await as(coLead).get(memberUrl(w, crypto.randomUUID())), 404, 'not_found');
    expectError(await as(coLead).get(memberUrl(w, w.rev.id)), 404, 'not_found');
    const outsider = await signUp('Olly Outsider');
    expectError(await as(outsider).get(memberUrl(w, w.bob.id)), 404, 'not_found');

    // A plain member's own ticket can't be used on someone else's copy either.
    const own = await as(w.ann).post(url(w, '/copy/ide/launch'));
    const annCookie = await redeem(IdeLaunchResponseSchema.parse(own.body).url);
    expect((await ide().get(`/ide/${w.bobCopyId}/`).set('Cookie', annCookie)).status).toBe(404);

    // Demoted: the co-lead's IDE cookie stops working at once, and so do the routes.
    const demote = await as(w.leader).patch(url(w, `/members/${coLead.id}`), { role: 'member' });
    expect(demote.status).toBe(200);
    expect((await ide().get(`/ide/${w.bobCopyId}/`).set('Cookie', cookie)).status).toBe(404);
    expectError(await as(coLead).post(memberUrl(w, w.bob.id, '/ide/launch')), 403, 'forbidden');
  });

  it('a ticket bound to a lead stops working once the member leaves', async () => {
    const w = await world();
    await markRunning(w.bobCopyId);
    const launch = await as(w.leader).post(memberUrl(w, w.bob.id, '/ide/launch'));
    expect(launch.status).toBe(200);
    const cookie = await redeem(IdeLaunchResponseSchema.parse(launch.body).url);
    expect((await ide().get(`/ide/${w.bobCopyId}/`).set('Cookie', cookie)).status).toBe(503);
    expect((await as(w.bob).delete(url(w, `/members/${w.bob.id}`))).status).toBe(204);
    expect((await ide().get(`/ide/${w.bobCopyId}/`).set('Cookie', cookie)).status).toBe(404);
  });
});
