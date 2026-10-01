import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  ActivityListResponseSchema,
  ConflictDetailsSchema,
  ErrorResponseSchema,
} from '@devspace/shared';
import { casRef, MAIN_REF, treeOf, writeCommit } from '../src/git/repo.ts';
import { takeQueuedCopyUpdates } from '../src/jobs/copy-updates.ts';
import { prisma } from '../src/lib/prisma.ts';
import { updateProjectCopies } from '../src/copies/update.ts';
import { as, cleanUp, expectError } from './helpers.ts';
import {
  approve,
  detail,
  git,
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

afterAll(cleanUp);
vi.setConfig({ testTimeout: 60_000 });

const A_EDITED = 'export const a = 100;\nexport const b = 2;\nexport const c = 3;\n';

async function activity(w: World) {
  const res = await as(w.leader).get(url(w, '/activity'));
  return ActivityListResponseSchema.parse(res.body).entries;
}

/** Ann edits src/a.ts and adds a file, submits both, Rex approves. */
async function approvedWork(w: World) {
  write(w.annCopy, 'src/a.ts', A_EDITED);
  write(w.annCopy, 'src/new.ts', 'export const fresh = true;\n');
  const sub = await submit(w, w.ann, ['src/a.ts', 'src/new.ts'], 'Raise a', 'Because a was low');
  await approve(w, sub.id);
  return sub;
}

describe('merge', () => {
  it('adds exactly one commit to main: the author is the member, the committer the lead', async () => {
    const w = await world();
    const sub = await approvedWork(w);
    const before = await mainSha(w.gitDir);
    takeQueuedCopyUpdates();

    const leadView = await detail(w, sub.id, w.leader);
    expect(leadView.viewerActions).toContain('merge');
    expect(leadView.mergeBlocker).toBeNull();

    const res = await merge(w, sub.id);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const merged = res.body.submission;
    expect(merged.status).toBe('merged');
    expect(merged.mergedBy).toEqual({ id: w.leader.id, name: w.leader.name });
    expect(merged.mergedAt).not.toBeNull();
    expect(merged.mergeBlocker).toBe('not_active');
    expect(merged.viewerActions).toContain('revert');
    expect(merged.viewerActions).not.toContain('merge');

    // The real result: main's files changed, by exactly one commit on top of the old main.
    const after = await mainSha(w.gitDir);
    expect(merged.mergedSha).toBe(after);
    expect(await showFile(w.gitDir, 'src/a.ts')).toBe(A_EDITED);
    expect(await showFile(w.gitDir, 'src/new.ts')).toBe('export const fresh = true;\n');
    expect(await showFile(w.gitDir, 'src/b.ts')).toBe('export const b = 2;\n');
    expect((await git(w.gitDir, ['rev-list', `${before}..${after}`])).trim().split('\n')).toEqual([
      after,
    ]);
    const meta = await git(w.gitDir, ['log', '-1', '--format=%P%n%an%n%ae%n%cn%n%ce', after]);
    expect(meta.trim().split('\n')).toEqual([
      before,
      w.ann.name,
      `${w.ann.id}@users.noreply.devspace.invalid`,
      w.leader.name,
      `${w.leader.id}@users.noreply.devspace.invalid`,
    ]);
    expect(await git(w.gitDir, ['log', '-1', '--format=%B', after])).toBe(
      `Raise a\n\nBecause a was low\n\nSubmission: ${sub.id}\n\n`,
    );

    const row = await prisma.submission.findUniqueOrThrow({ where: { id: sub.id } });
    expect(row.mergedById).toBe(w.leader.id);
    const entry = (await activity(w)).find((e) => e.action === 'submission.merged');
    expect(entry).toMatchObject({ actorId: w.leader.id, target: sub.id });
    expect(entry?.data).toMatchObject({ title: 'Raise a', sha: after });
    // Automatic mode (the default): the copy updates were queued for the worker.
    expect(takeQueuedCopyUpdates()).toEqual([w.projectId]);

    // Merging again: no longer active.
    expectError(await merge(w, sub.id), 409, 'submission_not_active');
    expect(await mainSha(w.gitDir)).toBe(after);
  });

  it('only leaders and co-leaders merge; the message has no empty description', async () => {
    const w = await world();
    write(w.annCopy, 'src/b.ts', 'export const b = 22;\n');
    const sub = await submit(w, w.ann, ['src/b.ts'], 'Only b', '');
    await approve(w, sub.id);
    for (const user of [w.ann, w.rev, w.bob]) {
      expect((await detail(w, sub.id, user)).viewerActions).not.toContain('merge');
      expectError(await merge(w, sub.id, user), 403, 'forbidden');
    }
    expect(await showFile(w.gitDir, 'src/b.ts')).toBe('export const b = 2;\n');
    const res = await merge(w, sub.id);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await git(w.gitDir, ['log', '-1', '--format=%B', 'main'])).toBe(
      `Only b\n\nSubmission: ${sub.id}\n\n`,
    );
    // Unknown submission, and outsiders: 404.
    expectError(await merge(w, crypto.randomUUID()), 404, 'not_found');
  });

  it('with approval required, only an approved submission merges', async () => {
    const w = await world();
    write(w.annCopy, 'src/b.ts', 'export const b = 5;\n');
    const sub = await submit(w, w.ann, ['src/b.ts']);
    const view = await detail(w, sub.id, w.leader);
    expect(view.mergeBlocker).toBe('approval_required');
    expect(view.viewerActions).not.toContain('merge');
    expectError(await merge(w, sub.id), 409, 'approval_required');

    // A change request blocks too, even after an approval from someone else.
    await approve(w, sub.id);
    const res = await as(w.leader).post(url(w, `/submissions/${sub.id}/reviews`), {
      decision: 'changes_requested',
    });
    expect(res.body.submission.status).toBe('changes_requested');
    expectError(await merge(w, sub.id), 409, 'approval_required');
    expect(await showFile(w.gitDir, 'src/b.ts')).toBe('export const b = 2;\n');
  });

  it('with approval not required, any active status except needs_update merges', async () => {
    const w = await world();
    await setSettings(w, { requireApproval: false });
    write(w.annCopy, 'src/b.ts', 'export const b = 7;\n');
    const sub = await submit(w, w.ann, ['src/b.ts']);
    await as(w.leader).post(url(w, `/submissions/${sub.id}/reviews`), {
      decision: 'changes_requested',
    });
    const view = await detail(w, sub.id, w.leader);
    expect(view.status).toBe('changes_requested');
    expect(view.mergeBlocker).toBeNull();
    expect(view.viewerActions).toContain('merge');
    const res = await merge(w, sub.id);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await showFile(w.gitDir, 'src/b.ts')).toBe('export const b = 7;\n');
  });

  it('refuses a submission whose changes are already in main', async () => {
    const w = await world();
    await setSettings(w, { requireApproval: false });
    write(w.annCopy, 'src/b.ts', 'export const b = 9;\n');
    write(w.bobCopy, 'src/b.ts', 'export const b = 9;\n');
    const first = await submit(w, w.ann, ['src/b.ts']);
    const second = await submit(w, w.bob, ['src/b.ts']);
    expect((await merge(w, first.id)).status).toBe(200);
    const main = await mainSha(w.gitDir);
    // Same change: no conflict, but nothing to add.
    expect((await detail(w, second.id, w.leader)).status).toBe('open');
    expectError(await merge(w, second.id), 409, 'already_in_main');
    expect(await mainSha(w.gitDir)).toBe(main);
  });

  it('moves main only by compare-and-swap', async () => {
    const w = await world();
    const main = await mainSha(w.gitDir);
    const other = await writeCommit(w.gitDir, await treeOf(w.gitDir, main), [main], 'x\n', {
      name: 'T',
      email: 't@example.test',
    });
    // Wrong expected old value: refused, main unchanged.
    await expect(casRef(w.gitDir, MAIN_REF, other, other)).rejects.toThrow();
    expect(await mainSha(w.gitDir)).toBe(main);
    await casRef(w.gitDir, MAIN_REF, other, main);
    expect(await mainSha(w.gitDir)).toBe(other);
  });
});

describe('conflict re-check and needs update', () => {
  it('sets needs_update when main moves under a submission, and a revert clears it', async () => {
    const w = await world();
    write(w.annCopy, 'src/a.ts', A_EDITED);
    write(
      w.bobCopy,
      'src/a.ts',
      'export const a = 200;\nexport const b = 2;\nexport const c = 3;\n',
    );
    write(w.bobCopy, 'src/b.ts', 'export const b = 3;\n');
    const ann = await submit(w, w.ann, ['src/a.ts']);
    const bob = await submit(w, w.bob, ['src/a.ts', 'src/b.ts']);
    await approve(w, ann.id);
    await approve(w, bob.id);
    expect((await merge(w, ann.id)).status).toBe(200);

    const blocked = await detail(w, bob.id, w.leader);
    expect(blocked.status).toBe('needs_update');
    expect(blocked.conflictPaths).toEqual(['src/a.ts']);
    expect(blocked.mergeBlocker).toBe('needs_update');
    expect(blocked.viewerActions).not.toContain('merge');
    const main = await mainSha(w.gitDir);
    const res = await merge(w, bob.id);
    expectError(res, 409, 'merge_conflict');
    expect(ConflictDetailsSchema.parse(ErrorResponseSchema.parse(res.body).details)).toEqual({
      paths: ['src/a.ts'],
    });
    expect(await mainSha(w.gitDir)).toBe(main);

    // Undo Ann's merge: Bob's submission no longer conflicts and is approved again.
    expect((await revert(w, ann.id)).status).toBe(200);
    const cleared = await detail(w, bob.id, w.leader);
    expect(cleared.status).toBe('approved');
    expect(cleared.conflictPaths).toEqual([]);
    expect(cleared.mergeBlocker).toBeNull();
  });

  it('checks on submit too, and the author clears it by updating their copy and submission', async () => {
    const w = await world();
    write(w.annCopy, 'src/a.ts', A_EDITED);
    const ann = await submit(w, w.ann, ['src/a.ts']);
    await approve(w, ann.id);
    expect((await merge(w, ann.id)).status).toBe(200);

    // Bob's copy is still on the old main: his new submission conflicts straight away.
    write(w.bobCopy, 'src/a.ts', 'export const a = 3;\nexport const b = 2;\nexport const c = 3;\n');
    const bob = await submit(w, w.bob, ['src/a.ts']);
    expect((await detail(w, bob.id, w.bob)).status).toBe('needs_update');

    // Update my copy → markers; resolve; update the submission → open, no conflicts.
    const up = await as(w.bob).post(url(w, '/copy/update'));
    expect(up.status, JSON.stringify(up.body)).toBe(200);
    expect(up.body.conflictPaths).toEqual(['src/a.ts']);
    expect(read(w.bobCopy, 'src/a.ts')).toContain('<<<<<<< your copy');
    const resolved = 'export const a = 300;\nexport const b = 2;\nexport const c = 3;\n';
    write(w.bobCopy, 'src/a.ts', resolved);
    const upd = await as(w.bob).post(url(w, `/submissions/${bob.id}/update`), {});
    expect(upd.status, JSON.stringify(upd.body)).toBe(200);
    expect(upd.body.submission.status).toBe('open');
    expect(upd.body.submission.conflictPaths).toEqual([]);
    expect(upd.body.submission.baseSha).toBe(await mainSha(w.gitDir));
    await approve(w, bob.id);
    expect((await merge(w, bob.id)).status).toBe(200);
    expect(await showFile(w.gitDir, 'src/a.ts')).toBe(resolved);
  });
});

describe('revert', () => {
  it('adds one commit that restores main, credited to the lead', async () => {
    const w = await world();
    const sub = await approvedWork(w);
    expect((await merge(w, sub.id)).status).toBe(200);
    const merged = await mainSha(w.gitDir);
    takeQueuedCopyUpdates();
    for (const user of [w.ann, w.rev]) expectError(await revert(w, sub.id, user), 403, 'forbidden');

    const res = await revert(w, sub.id);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.submission.status).toBe('reverted');
    expect(res.body.submission.revertedBy).toEqual({ id: w.leader.id, name: w.leader.name });
    expect(res.body.submission.viewerActions).not.toContain('revert');
    const after = await mainSha(w.gitDir);
    expect(res.body.submission.revertedSha).toBe(after);
    expect(res.body.submission.mergedSha).toBe(merged);

    // The real result: main's files are back as they were.
    expect(await showFile(w.gitDir, 'src/a.ts')).toBe(
      'export const a = 1;\nexport const b = 2;\nexport const c = 3;\n',
    );
    expect(await git(w.gitDir, ['ls-tree', 'main', '--', 'src/new.ts'])).toBe('');
    const meta = await git(w.gitDir, ['log', '-1', '--format=%P%n%an%n%cn', after]);
    expect(meta.trim().split('\n')).toEqual([merged, w.leader.name, w.leader.name]);
    expect(await git(w.gitDir, ['log', '-1', '--format=%B', after])).toBe(
      `Revert "Raise a"\n\nThis reverts submission ${sub.id} (commit ${merged}).\n\n`,
    );
    expect((await activity(w)).find((e) => e.action === 'submission.reverted')).toMatchObject({
      actorId: w.leader.id,
      target: sub.id,
    });
    expect(takeQueuedCopyUpdates()).toEqual([w.projectId]);
    expectError(await revert(w, sub.id), 409, 'submission_not_active');
  });

  it('refuses when later merges changed the same lines, leaving main untouched', async () => {
    const w = await world();
    await setSettings(w, { requireApproval: false });
    const first = await approvedWork(w);
    expect((await merge(w, first.id)).status).toBe(200);
    // Bob's copy catches up, then he changes the same line again.
    await updateProjectCopies(w.projectId);
    write(
      w.bobCopy,
      'src/a.ts',
      'export const a = 101;\nexport const b = 2;\nexport const c = 3;\n',
    );
    const second = await submit(w, w.bob, ['src/a.ts']);
    expect((await merge(w, second.id)).status).toBe(200);
    const main = await mainSha(w.gitDir);

    const res = await revert(w, first.id);
    expectError(res, 409, 'revert_conflict');
    expect(res.body.details).toEqual({ paths: ['src/a.ts'] });
    expect(await mainSha(w.gitDir)).toBe(main);
    expect((await detail(w, first.id, w.leader)).status).toBe('merged');

    // Not merged yet: can't revert.
    write(w.annCopy, 'README.md', '# Other\n');
    const open = await submit(w, w.ann, ['README.md']);
    expectError(await revert(w, open.id), 409, 'submission_not_active');
  });

  it('manual mode queues no copy updates', async () => {
    const w = await world();
    await setSettings(w, { copyUpdateMode: 'manual' });
    const sub = await approvedWork(w);
    takeQueuedCopyUpdates();
    expect((await merge(w, sub.id)).status).toBe(200);
    expect((await revert(w, sub.id)).status).toBe(200);
    expect(takeQueuedCopyUpdates()).toEqual([]);
  });
});
