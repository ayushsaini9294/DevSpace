// devspace-tracker: DevSpace's own web extension, pre-installed in the IDE image (devspace-ide:5).
// It runs in VS Code's extension host worker in the member's browser, on the IDE origin. It posts
// `{ file, active }` to this IDE's presence endpoint (Phase 9) and, when the member runs
// "DevSpace: Send review findings" (Phase 10), a review folder's findings to the review-findings
// endpoint. The browser adds the `devspace_ide` cookie, so the API knows who is reporting. It makes
// no other network request.
import * as vscode from 'vscode';
import { presenceEndpoint, Reporter, workspaceRelativePath, type Report } from './tracker';
import {
  FINDINGS_FILE,
  isSubmissionId,
  REVIEWS_DIR,
  reviewFindingsEndpoint,
  reviewSubmissionIdOf,
  sendFindings,
} from './review';

/** Set by VS Code's extension host worker: `<copy IDE origin>/ide/<copyId>/<version>/static/out/`. */
type WorkerGlobals = { _VSCODE_FILE_ROOT?: unknown; location?: { origin: string } };

export const SEND_FINDINGS_COMMAND = 'devspace.sendReviewFindings';

export function activate(context: vscode.ExtensionContext) {
  const worker = globalThis as unknown as WorkerGlobals;
  const origin = worker.location?.origin ?? '';

  context.subscriptions.push(
    vscode.commands.registerCommand(SEND_FINDINGS_COMMAND, () =>
      sendReviewFindings(reviewFindingsEndpoint(worker._VSCODE_FILE_ROOT, origin)),
    ),
  );

  const endpoint = presenceEndpoint(worker._VSCODE_FILE_ROOT, origin);
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

/** The review folder to send: the one open in the editor, else the only one, else ask. */
async function pickSubmissionId(workspace: vscode.Uri): Promise<string | undefined> {
  const fromEditor = reviewSubmissionIdOf(vscode.window.activeTextEditor?.document.uri);
  if (fromEditor) return fromEditor;

  let ids: string[] = [];
  try {
    const entries = await vscode.workspace.fs.readDirectory(
      vscode.Uri.joinPath(workspace, REVIEWS_DIR),
    );
    ids = entries
      .filter(([name, type]) => type === vscode.FileType.Directory && isSubmissionId(name))
      .map(([name]) => name);
  } catch {
    // No reviews folder yet.
  }
  if (ids.length === 0) {
    void vscode.window.showErrorMessage(
      `No review folder found. Click "Review with my IDE AI" on a submission in DevSpace first.`,
    );
    return undefined;
  }
  if (ids.length === 1) return ids[0];
  return vscode.window.showQuickPick(ids, {
    title: 'DevSpace: Send review findings',
    placeHolder: `Which review? (folders in ${REVIEWS_DIR})`,
  });
}

/** Reads findings.md, preferring the editor's text so unsaved changes are sent too. */
async function readFindings(file: vscode.Uri): Promise<string | undefined> {
  const open = vscode.workspace.textDocuments.find((doc) => doc.uri.toString() === file.toString());
  if (open) return open.getText();
  try {
    return new TextDecoder().decode(await vscode.workspace.fs.readFile(file));
  } catch {
    return undefined;
  }
}

async function sendReviewFindings(endpoint: string | null) {
  const workspace = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!endpoint || !workspace) {
    void vscode.window.showErrorMessage(
      'DevSpace: this command works only in a DevSpace IDE with your copy open.',
    );
    return;
  }
  const submissionId = await pickSubmissionId(workspace);
  if (!submissionId) return;

  const file = vscode.Uri.joinPath(workspace, REVIEWS_DIR, submissionId, FINDINGS_FILE);
  const findings = await readFindings(file);
  if (findings === undefined) {
    void vscode.window.showErrorMessage(
      `Could not read ${REVIEWS_DIR}/${submissionId}/${FINDINGS_FILE}.`,
    );
    return;
  }

  const result = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Sending review findings…' },
    () => sendFindings((url, init) => fetch(url, init), endpoint, submissionId, findings),
  );
  if (result.ok) {
    void vscode.window.showInformationMessage(
      'Review findings sent to DevSpace. They show on the submission’s review page.',
    );
  } else {
    void vscode.window.showErrorMessage(result.message);
  }
}
