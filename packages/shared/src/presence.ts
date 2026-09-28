import { z } from 'zod';

/**
 * Presence and preferences (Phase 9). Presence lives in Redis with a short expiry; nothing is
 * written to PostgreSQL per heartbeat (only `ProjectMember.lastSeenAt`, at most once a minute).
 */

const UserRef = z.object({ id: z.string(), name: z.string() });

// ---------- The tracker extension's report (IDE site) ----------

/** Longest `file` path a report may carry; longer ones are stored as null. */
export const MAX_PRESENCE_FILE_LENGTH = 300;

/** Seconds an `active` report keeps a member Active (the extension's heartbeat is 30 s). */
export const PRESENCE_ACTIVE_TTL_SECONDS = 90;

/** Fewest milliseconds between two accepted reports from one IDE session (extras: 204, dropped). */
export const PRESENCE_REPORT_INTERVAL_MS = 5_000;

/** C0 and C1 control characters, DEL, line/paragraph separators and bidi overrides/isolates. */
function isUnsafeCodePoint(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  return (
    code <= 0x1f ||
    (code >= 0x7f && code <= 0x9f) ||
    code === 0x2028 ||
    code === 0x2029 ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  );
}

/**
 * A report's `file`, made safe: a path relative to the workspace, at most 300 characters, with
 * no `..` segment, no leading `/` or `\`, no backslashes-as-root (`C:`), and no control
 * characters. Anything else (including a non-string) becomes null. The web app still renders
 * it as plain text only.
 */
export function sanitizePresenceFile(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  if (value.length === 0 || value.length > MAX_PRESENCE_FILE_LENGTH) return null;
  // Control characters (C0, DEL, C1) and Unicode line/paragraph separators and bidi overrides.
  if ([...value].some(isUnsafeCodePoint)) return null;
  if (value.startsWith('/') || value.startsWith('\\') || /^[A-Za-z]:/.test(value)) return null;
  if (value.split(/[/\\]/).some((segment) => segment === '..')) return null;
  return value;
}

/**
 * POST <IDE_ORIGIN>/ide/<copyId>/__devspace/presence — sent by the `devspace-tracker` web
 * extension from VS Code's page on the IDE site, with `Content-Type: application/json` and the
 * browser's `devspace_ide` cookie (`credentials: 'include'`). The API handles it itself (never
 * forwarded to the container) and always answers 204 with no body, whatever the outcome.
 * `file` is the active editor's path relative to /home/workspace, or null; an unsafe `file` is
 * stored as null (see sanitizePresenceFile). `active` = window focused and input in the last
 * 2 minutes. At most one report per 5 s per IDE session is used.
 */
export const PresenceReportSchema = z.object({
  file: z.unknown().transform(sanitizePresenceFile),
  active: z.boolean(),
});

// ---------- Presence views ----------

/**
 * - `active`: an IDE report with `active: true` in the last 90 s (`file` = what they have open,
 *   null when they share nothing or have no editor open; `copyOwner` set when a lead is in a
 *   member's copy)
 * - `online`: an open app socket for the project, or an IDE report with `active: false`
 * - `offline`: otherwise (`lastSeenAt` = when they were last seen, if ever)
 */
export const PresenceStateSchema = z.enum(['active', 'online', 'offline']);

export const PresenceViewSchema = z.object({
  user: UserRef,
  state: PresenceStateSchema,
  /** Plain text only. Always null unless `state` is `active` and the member shares their file. */
  file: z.string().nullable(),
  /** Set while a lead is working in someone else's copy (`active` only). */
  copyOwner: UserRef.nullable(),
  lastSeenAt: z.iso.datetime().nullable(),
});

/** GET /api/projects/:projectId/presence — any member; every member of the project. 404 otherwise. */
export const PresenceListResponseSchema = z.object({ members: z.array(PresenceViewSchema) });

// ---------- Personal preferences ----------

export const PreferencesSchema = z.object({
  /** Share which file I have open with teammates (default true). Off → I show as Active only. */
  shareOpenFile: z.boolean(),
});

/** GET /api/me/preferences → Preferences. PATCH /api/me/preferences (body below) → Preferences. */
export const UpdatePreferencesRequestSchema = z.object({ shareOpenFile: z.boolean() });

export type PresenceReport = z.infer<typeof PresenceReportSchema>;
export type PresenceState = z.infer<typeof PresenceStateSchema>;
export type PresenceView = z.infer<typeof PresenceViewSchema>;
export type PresenceListResponse = z.infer<typeof PresenceListResponseSchema>;
export type Preferences = z.infer<typeof PreferencesSchema>;
export type UpdatePreferencesRequest = z.infer<typeof UpdatePreferencesRequestSchema>;
