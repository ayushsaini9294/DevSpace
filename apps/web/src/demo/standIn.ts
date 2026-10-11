import {
  applyAutoApprovals,
  demoCopyFiles,
  handleDemoRequest,
  markDemoPreviewed,
  mayaApproves,
  nextAutoApproval,
  undoDemoCopyFile,
  writeDemoCopyFile,
  type DemoCopyFile,
} from './server';
import { STATE_VERSION, initialState, type DemoState } from './state';

/**
 * The demo's in-browser stand-in for the DevSpace API. It answers the app's `/api/...` fetches
 * from sample data before anything reaches the network. Changes last for the visit: in memory,
 * and in sessionStorage so a reload keeps them (closing the tab forgets them).
 */

const STORAGE_KEY = 'devspace-demo-state';

let state: DemoState | null = null;

function load(): DemoState {
  try {
    const saved = sessionStorage.getItem(STORAGE_KEY);
    if (saved) {
      const parsed = JSON.parse(saved) as DemoState;
      if (parsed?.version === STATE_VERSION) return parsed;
    }
  } catch {
    // Storage blocked or unreadable: start fresh.
  }
  return initialState();
}

function save() {
  try {
    if (state) sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Storage full or blocked: the changes still last until the page is reloaded.
  }
}

function current(): DemoState {
  if (state === null) {
    state = load();
    scheduleAutoApprovals();
  }
  return state;
}

// ---------- Telling the pages about changes they didn't make ----------

type Listener = (projectIds: string[]) => void;
const listeners = new Set<Listener>();

/**
 * Hear about demo changes that happen without a request from the page (Maya's automatic
 * approval, the demo editor's saves), to refresh what's on screen. Returns the unsubscribe.
 */
export function subscribeDemoChanges(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function changed(projectIds: string[]) {
  save();
  for (const listener of listeners) listener(projectIds);
}

// ---------- Maya's automatic approval ----------

let approvalTimer: ReturnType<typeof setTimeout> | null = null;

/** Wake up when the next automatic approval is due. */
function scheduleAutoApprovals() {
  if (approvalTimer !== null) clearTimeout(approvalTimer);
  approvalTimer = null;
  if (state === null) return;
  const next = nextAutoApproval(state);
  if (next === null) return;
  approvalTimer = setTimeout(
    () => {
      approvalTimer = null;
      runAutoApprovals();
      scheduleAutoApprovals();
    },
    Math.max(0, next - Date.now()),
  );
}

function runAutoApprovals() {
  if (state === null) return;
  const projectIds = applyAutoApprovals(state, Date.now());
  if (projectIds.length > 0) changed(projectIds);
}

/** Whether Maya approves this submission by herself in the demo (it's the visitor's own work). */
export function mayaApprovesInDemo(projectId: string, submissionId: string): boolean {
  const p = current().projects.find((x) => x.id === projectId);
  const s = p?.submissions.find((x) => x.id === submissionId);
  return p !== undefined && s !== undefined && mayaApproves(current(), p, s);
}

let resets = 0;

/** Goes up on every Reset demo, so an edit made before a reset is never saved after it. */
export function demoResetCount(): number {
  return resets;
}

/** Put the demo back to its starting sample data. */
export function resetDemoState() {
  resets += 1;
  state = initialState();
  scheduleAutoApprovals();
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing saved, or storage blocked.
  }
}

// ---------- The demo IDE's files ----------

/** The files of my copy of a project, or null when I have no copy. */
export function readDemoCopy(projectId: string): DemoCopyFile[] | null {
  return demoCopyFiles(current(), projectId);
}

/** Save a file of my copy (the demo editor's auto-save). Returns whether it was saved. */
export function saveDemoCopyFile(projectId: string, path: string, content: string): boolean {
  const saved = writeDemoCopyFile(current(), projectId, path, content);
  if (saved) changed([projectId]);
  return saved;
}

/** Put a file of my copy back to main's version. Returns whether it changed. */
export function undoDemoCopyEdits(projectId: string, path: string): boolean {
  const undone = undoDemoCopyFile(current(), projectId, path);
  if (undone) changed([projectId]);
  return undone;
}

/** The visitor saw their page in the demo's preview (ticks a Getting started step). */
export function markDemoPreviewSeen(projectId: string) {
  if (markDemoPreviewed(current(), projectId)) changed([projectId]);
}

// ---------- Answering fetches ----------

/** The path of a request if it is one for the DevSpace API (`/api/...` on this site), else null. */
function apiPath(input: RequestInfo | URL): string | null {
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const url = new URL(raw, window.location.href);
  if (url.origin !== window.location.origin || !url.pathname.startsWith('/api/')) return null;
  return url.pathname + url.search;
}

async function readBody(init: RequestInit | undefined): Promise<unknown> {
  if (typeof init?.body !== 'string' || init.body === '') return undefined;
  try {
    return JSON.parse(init.body) as unknown;
  } catch {
    return undefined;
  }
}

/** Answer one API request from the demo state, as a real `Response`. */
export async function demoFetch(path: string, init?: RequestInit): Promise<Response> {
  const method = (init?.method ?? 'GET').toUpperCase();
  // An approval that is due (the timer may run late in a background tab) shows straight away.
  runAutoApprovals();
  const reply = handleDemoRequest(current(), method, path, await readBody(init));
  if (method !== 'GET') {
    save();
    scheduleAutoApprovals();
  }
  if (reply.body === undefined) return new Response(null, { status: reply.status });
  return new Response(JSON.stringify(reply.body), {
    status: reply.status,
    headers: { 'Content-Type': 'application/json' },
  });
}

let installed = false;

/** Answer `/api/...` fetches in the browser from now on; other requests go out as usual. */
export function installDemoApi() {
  if (installed) return;
  installed = true;
  const networkFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const path = apiPath(input);
    return path === null ? networkFetch(input, init) : demoFetch(path, init);
  };
}
