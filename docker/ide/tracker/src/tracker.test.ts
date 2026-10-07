import { describe, expect, it } from 'vitest';
import {
  ACTIVE_WINDOW_MS,
  HEARTBEAT_MS,
  MIN_INTERVAL_MS,
  presenceEndpoint,
  Reporter,
  workspaceRelativePath,
  type Clock,
  type Report,
  type Snapshot,
} from './tracker';

describe('workspaceRelativePath', () => {
  const remote = (path: string) => ({ scheme: 'vscode-remote', path });

  it('gives the path relative to /home/workspace', () => {
    expect(workspaceRelativePath(remote('/home/workspace/src/app.txt'))).toBe('src/app.txt');
    expect(workspaceRelativePath(remote('/home/workspace/README.md'))).toBe('README.md');
  });

  it('is null without an editor, outside the copy or for other schemes', () => {
    expect(workspaceRelativePath(undefined)).toBeNull();
    expect(workspaceRelativePath(remote('/home/workspace'))).toBeNull();
    expect(workspaceRelativePath(remote('/home/workspace/'))).toBeNull();
    expect(workspaceRelativePath(remote('/home/workspaces/x.txt'))).toBeNull();
    expect(workspaceRelativePath(remote('/tmp/devspace-home/.bashrc'))).toBeNull();
    expect(workspaceRelativePath({ scheme: 'untitled', path: 'Untitled-1' })).toBeNull();
    expect(workspaceRelativePath({ scheme: 'file', path: '/home/workspace/a.txt' })).toBeNull();
    expect(
      workspaceRelativePath({ scheme: 'vscode-userdata', path: '/home/workspace/a.txt' }),
    ).toBeNull();
  });

  it('refuses what the API would refuse', () => {
    expect(workspaceRelativePath(remote('/home/workspace/a/../../etc/passwd'))).toBeNull();
    expect(workspaceRelativePath(remote('/home/workspace/./a.txt'))).toBeNull();
    expect(workspaceRelativePath(remote('/home/workspace//a.txt'))).toBeNull();
    expect(workspaceRelativePath(remote('/home/workspace/a\nb.txt'))).toBeNull();
    expect(workspaceRelativePath(remote('/home/workspace/a\u0085b.txt'))).toBeNull();
    expect(workspaceRelativePath(remote(`/home/workspace/${'a'.repeat(301)}`))).toBeNull();
    expect(workspaceRelativePath(remote(`/home/workspace/${'a'.repeat(300)}`))).toBe(
      'a'.repeat(300),
    );
    expect(workspaceRelativePath(remote('/home/workspace/..hidden/ok..txt'))).toBe(
      '..hidden/ok..txt',
    );
  });
});

describe('presenceEndpoint', () => {
  const origin = 'http://0b6f3c1e-8a2d-4f55-9d7e-1c2b3a4d5e6f.ide.localhost:3100';
  const root = `${origin}/ide/0b6f3c1e-8a2d-4f55-9d7e-1c2b3a4d5e6f/stable-abc/static/out/`;

  it('builds the endpoint from VS Code’s file root', () => {
    expect(presenceEndpoint(root, origin)).toBe(
      `${origin}/ide/0b6f3c1e-8a2d-4f55-9d7e-1c2b3a4d5e6f/__devspace/presence`,
    );
  });

  it('never points at another origin, and needs an /ide/<copyId>/ path', () => {
    expect(presenceEndpoint(root, 'http://localhost:5173')).toBeNull();
    expect(presenceEndpoint(`${origin}/static/out/`, origin)).toBeNull();
    expect(presenceEndpoint(`${origin}/ide/a.b/static/`, origin)).toBeNull();
    expect(presenceEndpoint(undefined, origin)).toBeNull();
    expect(presenceEndpoint(42, origin)).toBeNull();
  });
});

/** A fake clock whose timers run when time is advanced. */
function fakeClock() {
  let now = 1_000_000;
  let nextId = 1;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const clock: Clock = {
    now: () => now,
    setTimeout: (callback, ms) => {
      const id = nextId++;
      timers.set(id, { at: now + ms, callback });
      return id;
    },
    clearTimeout: (handle) => void timers.delete(handle as number),
  };
  function advance(ms: number) {
    const end = now + ms;
    for (;;) {
      const due = [...timers.entries()]
        .filter(([, t]) => t.at <= end)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      now = due[1].at;
      due[1].callback();
    }
    now = end;
  }
  return { clock, advance, pending: () => timers.size };
}

function setUp(initial: Partial<Snapshot> = {}) {
  const { clock, advance, pending } = fakeClock();
  const snapshot: Snapshot = { file: null, focused: true, recentlyInteracted: false, ...initial };
  const sent: { at: number; report: Report }[] = [];
  const reporter = new Reporter(
    () => ({ ...snapshot }),
    (report) => sent.push({ at: clock.now(), report }),
    clock,
  );
  return { reporter, snapshot, sent, advance, pending, clock };
}

describe('Reporter', () => {
  it('reports at once on start, then a heartbeat every 30 s', () => {
    const { reporter, sent, advance } = setUp();
    reporter.start();
    advance(0);
    expect(sent).toHaveLength(1);
    advance(HEARTBEAT_MS - 1);
    expect(sent).toHaveLength(1);
    advance(1);
    expect(sent).toHaveLength(2);
    advance(HEARTBEAT_MS * 3);
    expect(sent).toHaveLength(5);
  });

  it('debounces editor changes by 1 s and sends the latest file', () => {
    const { reporter, snapshot, sent, advance } = setUp();
    reporter.start();
    advance(10_000);
    snapshot.file = 'a.txt';
    reporter.changed();
    advance(500);
    snapshot.file = 'src/app.txt';
    reporter.changed();
    advance(999);
    expect(sent).toHaveLength(1);
    advance(1);
    expect(sent).toHaveLength(2);
    expect(sent[1]!.report.file).toBe('src/app.txt');
  });

  it('never sends two reports less than 5.5 s apart, and does not lose a change', () => {
    const { reporter, snapshot, sent, advance } = setUp();
    reporter.start();
    advance(0);
    snapshot.file = 'src/app.txt';
    reporter.changed();
    advance(MIN_INTERVAL_MS - 1);
    expect(sent).toHaveLength(1);
    advance(1);
    expect(sent).toHaveLength(2);
    expect(sent[1]!.report.file).toBe('src/app.txt');
    expect(sent[1]!.at - sent[0]!.at).toBe(MIN_INTERVAL_MS);
  });

  it('is active only when focused with input in the last 2 minutes', () => {
    const { reporter, snapshot, sent, advance } = setUp();
    reporter.start();
    advance(0);
    expect(sent[0]!.report.active).toBe(false); // no input yet

    reporter.input(); // first input after an inactive report: sent (debounced)
    advance(MIN_INTERVAL_MS);
    expect(sent.at(-1)!.report.active).toBe(true);

    advance(ACTIVE_WINDOW_MS);
    expect(sent.at(-1)!.report.active).toBe(false); // a heartbeat after 2 min without input

    reporter.input();
    snapshot.focused = false;
    reporter.changed();
    advance(MIN_INTERVAL_MS);
    expect(sent.at(-1)!.report.active).toBe(false); // input, but the window lost focus
  });

  it('counts VS Code’s own "interacted recently" flag as input', () => {
    const { reporter, snapshot, sent, advance } = setUp({ recentlyInteracted: true });
    reporter.start();
    advance(0);
    expect(sent[0]!.report.active).toBe(true);
    snapshot.recentlyInteracted = false;
    advance(ACTIVE_WINDOW_MS - 1_000);
    expect(sent.at(-1)!.report.active).toBe(true);
    advance(HEARTBEAT_MS * 2);
    expect(sent.at(-1)!.report.active).toBe(false);
  });

  it('stops after dispose', () => {
    const { reporter, sent, advance, pending } = setUp();
    reporter.start();
    advance(0);
    reporter.dispose();
    reporter.changed();
    advance(HEARTBEAT_MS * 2);
    expect(sent).toHaveLength(1);
    expect(pending()).toBe(0);
  });
});
