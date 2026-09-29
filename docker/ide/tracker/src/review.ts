// "DevSpace: Send review findings" (Phase 10 contract, section 4), kept free of the `vscode` module
// so it can be unit tested. "Review with my IDE AI" writes `.devspace/reviews/<submissionId>/` into
// the reviewer's own copy; the reviewer's AI fills in `findings.md`, and this command sends it to
// `<IDE_ORIGIN>/ide/<copyId>/__devspace/review-findings`.

import { presenceEndpoint, WORKSPACE_ROOT, type UriLike } from './tracker';

/** The folder "Review with my IDE AI" writes into, relative to the copy. */
export const REVIEWS_DIR = '.devspace/reviews';
export const FINDINGS_FILE = 'findings.md';
/** The API refuses findings longer than this (UTF-8 bytes). */
export const MAX_FINDINGS_BYTES = 50 * 1024;

const SUBMISSION_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** True for a folder name that can be a submission id. */
export function isSubmissionId(name: string) {
  return SUBMISSION_ID.test(name);
}

/**
 * The submission id of the review folder that `file` is in (any file of
 * `/home/workspace/.devspace/reviews/<submissionId>/`, e.g. its findings.md or REVIEW.md), or null.
 */
export function reviewSubmissionIdOf(file: UriLike | undefined): string | null {
  if (!file || file.scheme !== 'vscode-remote') return null;
  const prefix = `${WORKSPACE_ROOT}/${REVIEWS_DIR}/`;
  if (!file.path.startsWith(prefix)) return null;
  const id = file.path.slice(prefix.length).split('/')[0] ?? '';
  return isSubmissionId(id) ? id : null;
}

/** The review-findings endpoint of this IDE, next to the presence endpoint (same origin only). */
export function reviewFindingsEndpoint(fileRoot: unknown, ownOrigin: string): string | null {
  const presence = presenceEndpoint(fileRoot, ownOrigin);
  return presence && presence.replace(/\/presence$/, '/review-findings');
}

export type FindingsCheck = { ok: true } | { ok: false; message: string };

/** Checks findings before they are sent: not empty, and at most 50 KB. */
export function checkFindings(findings: string): FindingsCheck {
  if (findings.trim().length === 0) {
    return { ok: false, message: `${FINDINGS_FILE} is empty. Add the findings first.` };
  }
  const bytes = new TextEncoder().encode(findings).length;
  if (bytes > MAX_FINDINGS_BYTES) {
    const kb = Math.ceil(bytes / 1024);
    return {
      ok: false,
      message: `${FINDINGS_FILE} is ${kb} KB; DevSpace takes at most 50 KB. Shorten it and try again.`,
    };
  }
  return { ok: true };
}

type FetchLike = (
  url: string,
  init: {
    method: string;
    credentials: 'include';
    cache: 'no-store';
    headers: Record<string, string>;
    body: string;
  },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export type SendResult = { ok: true } | { ok: false; message: string };

/** The API's error message from a JSON body like `{ error, message }`, if there is one. */
function errorMessage(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { message?: unknown; error?: unknown };
    if (typeof parsed.message === 'string' && parsed.message) return parsed.message;
    if (typeof parsed.error === 'string' && parsed.error) return parsed.error;
    if (
      parsed.error &&
      typeof parsed.error === 'object' &&
      typeof (parsed.error as { message?: unknown }).message === 'string'
    ) {
      return (parsed.error as { message: string }).message;
    }
  } catch {
    // not JSON
  }
  return null;
}

/** POSTs `{ submissionId, findings }` and turns the answer into a message for the reviewer. */
export async function sendFindings(
  fetchFn: FetchLike,
  endpoint: string,
  submissionId: string,
  findings: string,
): Promise<SendResult> {
  const check = checkFindings(findings);
  if (!check.ok) return check;
  let res: Awaited<ReturnType<FetchLike>>;
  try {
    res = await fetchFn(endpoint, {
      method: 'POST',
      credentials: 'include',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ submissionId, findings }),
    });
  } catch {
    return { ok: false, message: 'Could not reach DevSpace. Check your connection and try again.' };
  }
  if (res.ok) return { ok: true };
  const text = await res.text().catch(() => '');
  const detail = errorMessage(text);
  return {
    ok: false,
    message: `DevSpace did not accept the findings (${res.status})${detail ? `: ${detail}` : '.'}`,
  };
}
