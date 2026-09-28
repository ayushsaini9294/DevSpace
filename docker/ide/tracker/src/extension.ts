// devspace-tracker: DevSpace's own web extension, pre-installed in the IDE image (devspace-ide:2).
// It runs in VS Code's extension host worker in the member's browser, on the IDE origin, and posts
// `{ file, active }` to this IDE's presence endpoint. The browser adds the `devspace_ide` cookie,
// so the API knows who is reporting. It makes no other network request.
import * as vscode from 'vscode';
import { presenceEndpoint, Reporter, workspaceRelativePath, type Report } from './tracker';

/** Set by VS Code's extension host worker: `<IDE_ORIGIN>/ide/<copyId>/<version>/static/out/`. */
type WorkerGlobals = { _VSCODE_FILE_ROOT?: unknown; location?: { origin: string } };

export function activate(context: vscode.ExtensionContext) {
  const worker = globalThis as unknown as WorkerGlobals;
  const endpoint = presenceEndpoint(worker._VSCODE_FILE_ROOT, worker.location?.origin ?? '');
  if (!endpoint) {
    // Not inside a DevSpace IDE (or VS Code changed how it loads extensions): stay quiet.
    console.warn('devspace-tracker: no presence endpoint found; not reporting');
    return;
  }

  const send = (report: Report) => {
    void fetch(endpoint, {
      method: 'POST',
      credentials: 'include',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(report),
    }).catch(() => {
      // Offline or the API is restarting: the next heartbeat tries again.
    });
  };

  const reporter = new Reporter(
    () => ({
      file: workspaceRelativePath(vscode.window.activeTextEditor?.document.uri),
      focused: vscode.window.state.focused,
      recentlyInteracted: vscode.window.state.active,
    }),
    send,
    {
      now: () => Date.now(),
      setTimeout: (callback, ms) => setTimeout(callback, ms),
      clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    },
  );

  const input = () => reporter.input();
  context.subscriptions.push(
    { dispose: () => reporter.dispose() },
    vscode.window.onDidChangeActiveTextEditor(() => {
      reporter.input();
      reporter.changed();
    }),
    vscode.window.onDidChangeWindowState((state) => {
      if (state.focused && state.active) reporter.input();
      reporter.changed();
    }),
    vscode.window.onDidChangeTextEditorSelection(input),
    vscode.window.onDidChangeTextEditorVisibleRanges(input),
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.document === vscode.window.activeTextEditor?.document) reporter.input();
    }),
    vscode.window.onDidChangeActiveTerminal(input),
    vscode.window.onDidChangeTerminalState(input),
  );

  reporter.start();
}

export function deactivate() {
  // Subscriptions (and the reporter's timer) are disposed by VS Code.
}
