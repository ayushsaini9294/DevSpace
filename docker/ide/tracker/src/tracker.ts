// The tracker's logic, kept free of the `vscode` module so it can be unit tested.
// Phase 9 contract (CLAUDE.md): report `{ file, active }` on every editor change (debounced 1 s)
// and as a heartbeat every 30 s, to `<copy IDE origin>/ide/<copyId>/__devspace/presence`.

export type Report = { file: string | null; active: boolean };

export const DEBOUNCE_MS = 1_000;
export const HEARTBEAT_MS = 30_000;
/** "Active" = the window is focused and there was input in the last 2 minutes. */
export const ACTIVE_WINDOW_MS = 120_000;
/**
 * The API keeps at most one report per 5 s per IDE session and silently drops the rest, so the
 * tracker never sends faster than this: a change right after a heartbeat is sent a little later
 * instead of being lost.
 */
export const MIN_INTERVAL_MS = 5_500;

/** The folder the container opens: the member's copy. Reported paths are relative to it. */
export const WORKSPACE_ROOT = '/home/workspace';
/** The API refuses longer paths (it stores them as null). */
export const MAX_PATH_LENGTH = 300;

export type UriLike = { scheme: string; path: string };

// Control characters (C0, DEL and C1): never part of a path we report.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * The path of `file` relative to /home/workspace, or null when it isn't a file in the copy
 * (untitled, settings, output, a file elsewhere in the container) or doesn't meet the API's rules.
 * In the browser, files of the container have the `vscode-remote` scheme.
 */
export function workspaceRelativePath(file: UriLike | undefined): string | null {
  if (!file || file.scheme !== 'vscode-remote') return null;
  const prefix = `${WORKSPACE_ROOT}/`;
  if (!file.path.startsWith(prefix)) return null;
  const relative = file.path.slice(prefix.length);
  if (relative.length === 0 || relative.length > MAX_PATH_LENGTH) return null;
  if (CONTROL_CHARS.test(relative)) return null;
  if (relative.split('/').some((part) => part === '' || part === '.' || part === '..')) return null;
  return relative;
}

/**
 * The presence endpoint of this IDE, found from VS Code's file root in the extension host worker
 * (`<copy IDE origin>/ide/<copyId>/<version>/static/out/`). Null unless it is on this worker's own
 * origin: the tracker never sends anything to another site.
 */
export function presenceEndpoint(fileRoot: unknown, ownOrigin: string): string | null {
  if (typeof fileRoot !== 'string') return null;
  const match = /^(https?:\/\/[^/?#]+)(\/ide\/[A-Za-z0-9_-]+)\//.exec(fileRoot);
  if (!match || match[1] !== ownOrigin) return null;
  return `${match[1]}${match[2]}/__devspace/presence`;
}

export type Clock = {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
};

export type Snapshot = {
  /** The active editor's file, relative to the workspace (see workspaceRelativePath). */
  file: string | null;
  /** The browser window has focus. */
  focused: boolean;
  /** VS Code's own "interacted with recently" flag (WindowState.active). */
  recentlyInteracted: boolean;
};

/**
 * Decides when to send a report. One timer at a time: after every report the next heartbeat is
 * due in 30 s; a change replaces it with a report 1 s later (debounced), never sooner than 5.5 s
 * after the previous report.
 */
export class Reporter {
  private timer: unknown;
  private lastSentAt = Number.NEGATIVE_INFINITY;
  private lastInputAt = Number.NEGATIVE_INFINITY;
  private lastSentActive = false;
  private disposed = false;

  constructor(
    private readonly read: () => Snapshot,
    private readonly send: (report: Report) => void,
    private readonly clock: Clock,
  ) {}

  /** Sends the first report at once. */
  start() {
    this.arm(0);
  }

  /** The editor, focus or activity changed: report it (debounced). */
  changed() {
    this.arm(DEBOUNCE_MS);
  }

  /** The member typed, clicked, scrolled or otherwise used the window. */
  input() {
    this.lastInputAt = this.clock.now();
    if (!this.lastSentActive) this.changed();
  }

  dispose() {
    this.disposed = true;
    if (this.timer !== undefined) this.clock.clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** What would be reported now. */
  current(): Report {
    const snapshot = this.read();
    if (snapshot.focused && snapshot.recentlyInteracted) this.lastInputAt = this.clock.now();
    const active = snapshot.focused && this.clock.now() - this.lastInputAt <= ACTIVE_WINDOW_MS;
    return { file: snapshot.file, active };
  }

  private arm(delay: number) {
    if (this.disposed) return;
    if (this.timer !== undefined) this.clock.clearTimeout(this.timer);
    const now = this.clock.now();
    const wait = Math.max(delay, this.lastSentAt + MIN_INTERVAL_MS - now, 0);
    this.timer = this.clock.setTimeout(() => this.fire(), wait);
  }

  private fire() {
    this.timer = undefined;
    if (this.disposed) return;
    const report = this.current();
    this.lastSentAt = this.clock.now();
    this.lastSentActive = report.active;
    this.send(report);
    this.arm(HEARTBEAT_MS);
  }
}
