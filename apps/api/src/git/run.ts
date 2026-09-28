import { execFile, spawn } from 'node:child_process';
import { devNull } from 'node:os';

/** os.devNull is `\\.\nul` on Windows, which git can't open as a config file; `NUL` works. */
const NULL_DEVICE = process.platform === 'win32' ? 'NUL' : devNull;

/**
 * Runs the real `git` binary: no shell, a fixed argument array, a timeout, a cap on output, and
 * an environment where nothing outside DevSpace (system or user git config, credential helpers,
 * hooks, terminal or GUI prompts) can change what git does or make it wait for input.
 */

/** `-c` options passed to every git command. */
const HARDENING = [
  // Only https may be used to talk to other machines (no file://, ssh://, git://, ext::).
  'protocol.allow=never',
  'protocol.https.allow=always',
  'http.followRedirects=false',
  // Never run hooks, never ask for or store credentials.
  `core.hooksPath=${NULL_DEVICE}`,
  'credential.helper=',
  'core.askPass=',
  'core.symlinks=false',
  'core.fsmonitor=false',
  // No background maintenance that could keep files open after a command returns.
  'gc.auto=0',
  'maintenance.auto=false',
  'init.defaultBranch=main',
].flatMap((option) => ['-c', option]);

export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_BUFFER = 16 * 1024 * 1024;

export type GitErrorKind = 'failed' | 'timeout' | 'output_too_large' | 'aborted' | 'spawn_failed';

/** A git command that didn't succeed. `stderr` is for server logs only, never for clients. */
export class GitError extends Error {
  readonly kind: GitErrorKind;
  readonly exitCode: number | null;
  readonly stderr: string;

  constructor(kind: GitErrorKind, message: string, exitCode: number | null, stderr: string) {
    super(message);
    this.name = 'GitError';
    this.kind = kind;
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

/** Removes anything that looks like login details from a URL before it is logged. */
export function redact(text: string): string {
  return text.replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s]*@/gi, '$1***@');
}

/** The environment for git: the parent's, minus every GIT_* variable, plus our hardening. */
function gitEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.toUpperCase().startsWith('GIT_')) result[key] = value;
  }
  return {
    ...result,
    GIT_TERMINAL_PROMPT: '0',
    // Empty means "no helper": git skips it and, with prompts off, fails instead of waiting.
    GIT_ASKPASS: '',
    SSH_ASKPASS: '',
    GCM_INTERACTIVE: 'never',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: NULL_DEVICE,
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_OPTIONAL_LOCKS: '0',
    LC_ALL: 'C',
    ...extra,
  };
}

export interface RunGitOptions {
  /** Runs as `git --git-dir=<gitDir> …` (a path we built, never user input). */
  gitDir?: string;
  cwd?: string;
  /** Written to stdin, which is then closed. Without it stdin is empty. */
  input?: string | Buffer;
  timeoutMs?: number;
  /** Maximum stdout bytes kept; more fails with `output_too_large`. */
  maxBuffer?: number;
  /** Extra environment variables (e.g. commit identity). */
  env?: Record<string, string>;
  /** Aborting kills git and rejects with `aborted`. */
  signal?: AbortSignal;
  /**
   * Also allows the local `file` transport, for cloning one of our own bare repositories by a
   * path we built. Never set this for a command that touches a user-supplied URL.
   */
  allowLocalRepo?: boolean;
  /** Exit codes other than 0 that still count as success (e.g. 1 = conflicts for merge-tree). */
  okExitCodes?: readonly number[];
}

export interface GitResult {
  stdout: Buffer;
  stderr: string;
  exitCode: number;
}

const IS_WINDOWS = process.platform === 'win32';

/** After a kill, how long to wait for git's pipes to close before giving up on them. */
const KILL_GRACE_MS = 2_000;

/**
 * Kills git and the helper processes it started (e.g. git-remote-https). Those helpers hold
 * git's stdout/stderr open, so killing git alone leaves the pipes open and 'close' never fires.
 * Windows: taskkill /T. Elsewhere: git runs in its own process group, which is killed whole.
 */
function killTree(pid: number | undefined, kill: () => void): void {
  if (pid === undefined) {
    kill();
  } else if (IS_WINDOWS) {
    execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => kill());
  } else {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      kill();
    }
  }
}

export function runGit(args: readonly string[], options: RunGitOptions = {}): Promise<GitResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBuffer = options.maxBuffer ?? DEFAULT_MAX_BUFFER;
  const fullArgs = [
    ...HARDENING,
    ...(options.allowLocalRepo ? ['-c', 'protocol.file.allow=always'] : []),
    ...(options.gitDir !== undefined ? [`--git-dir=${options.gitDir}`] : []),
    ...args,
  ];
  const command = args[0] ?? 'git';

  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new GitError('aborted', `git ${command} was stopped`, null, ''));
      return;
    }
    const child = spawn('git', fullArgs, {
      cwd: options.cwd,
      env: gitEnv(options.env ?? {}),
      shell: false,
      windowsHide: true,
      // Own process group, so a timeout can kill git's helpers too (see killTree).
      detached: !IS_WINDOWS,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const chunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderr = '';
    let failure: GitError | null = null;
    let settled = false;

    const stop = (error: GitError) => {
      if (failure) return;
      failure = error;
      killTree(child.pid, () => child.kill('SIGKILL'));
      // Safety net: if something still holds the pipes open, stop waiting for them.
      setTimeout(() => {
        if (settled) return;
        child.stdout.destroy();
        child.stderr.destroy();
        finish(error);
      }, KILL_GRACE_MS).unref();
    };

    const timer = setTimeout(
      () => stop(new GitError('timeout', `git ${command} timed out`, null, stderr)),
      timeoutMs,
    );
    const onAbort = () => stop(new GitError('aborted', `git ${command} was stopped`, null, stderr));
    options.signal?.addEventListener('abort', onAbort, { once: true });

    const finish = (error: GitError | null, result?: GitResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve(result!);
    };

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxBuffer) {
        stop(new GitError('output_too_large', `git ${command} output too large`, null, stderr));
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      // Keep only the tail; progress output can be long.
      stderr = (stderr + chunk.toString('utf8')).slice(-8192);
    });
    child.stdin.on('error', () => undefined); // git may exit before reading all input
    child.on('error', (err) =>
      finish(
        failure ?? new GitError('spawn_failed', `could not run git: ${err.message}`, null, ''),
      ),
    );
    child.on('close', (code) => {
      if (failure) {
        finish(failure);
      } else if (code !== 0 && !(code !== null && options.okExitCodes?.includes(code))) {
        finish(new GitError('failed', `git ${command} exited with ${code}`, code, stderr));
      } else {
        finish(null, { stdout: Buffer.concat(chunks), stderr, exitCode: code ?? 0 });
      }
    });

    if (options.input !== undefined) child.stdin.end(options.input);
    else child.stdin.end();
  });
}
