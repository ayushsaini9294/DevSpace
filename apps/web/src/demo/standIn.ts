import { handleDemoRequest } from './server';
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
  state ??= load();
  return state;
}

/** Put the demo back to its starting sample data. */
export function resetDemoState() {
  state = initialState();
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing saved, or storage blocked.
  }
}

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
  const reply = handleDemoRequest(current(), method, path, await readBody(init));
  if (method !== 'GET') save();
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
