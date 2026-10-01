import { z } from 'zod';

/**
 * GitHub (Phase 13). DevSpace talks to GitHub only through its own GitHub App. Members connect
 * their GitHub account (the app's user authorization); their tokens are stored encrypted and
 * never reach the browser. Errors use ErrorResponseSchema.
 *
 * Error codes (409 unless noted):
 * - `github_not_configured`: GitHub isn't set up on this DevSpace yet (every GitHub route except
 *   GET /api/github/account and GET /api/projects/:projectId/github, which answer
 *   `configured: false` instead)
 * - `github_not_connected`: connect your GitHub account first (Settings → GitHub). Also when
 *   GitHub no longer accepts your stored tokens (they were revoked or expired): connect again.
 * - `app_not_installed`: the DevSpace app isn't installed on your GitHub account;
 *   `details.installUrl` is where to install it
 * - `repo_exists`: you already have a repository with that name on GitHub
 * - `email_warning_not_accepted`: `emailWarning.names` isn't empty and `acceptEmailWarning`
 *   wasn't true
 * - `already_published`: this project is already linked to a GitHub repository
 * - `not_published`: this project isn't linked to GitHub (sync, unlink)
 * - `sync_running`: a push is already running (Try again)
 * - `repository_not_ready`: the project has no main yet (publish)
 * - `github_repo_not_found` (404): import: the repository isn't reachable through your app
 *   installations (or doesn't exist)
 * - `github_permission_denied` (403): GitHub refused because the app lacks a permission (for
 *   example creating repositories); `message` says what to check
 * - `invalid_state` (400): the connect state is unknown, used, expired or someone else's
 * - `github_error` (502): GitHub refused or didn't answer (`message` says why, in plain words)
 * - 403 `forbidden` without the needed permission; 404 `not_found` for non-members
 */

/** `{ id, name }` of a user (same shape as UserRefSchema; local to avoid an import cycle). */
const UserRefSchema = z.object({ id: z.string(), name: z.string() });

// ---------- Names ----------

/**
 * A GitHub repository name: 1–100 of letters, digits, `.`, `-`, `_`; not `.` or `..`, and not
 * ending in `.git`. (GitHub would rename other characters to `-`; DevSpace asks for a valid one.)
 */
export const GithubRepoNameSchema = z
  .string()
  .trim()
  .min(1, 'Enter a repository name')
  .max(100, 'Use at most 100 characters')
  .regex(/^[A-Za-z0-9._-]+$/, 'Use only letters, numbers, dots, dashes and underscores')
  .refine((name) => name !== '.' && name !== '..', 'Pick another name')
  .refine((name) => !name.toLowerCase().endsWith('.git'), 'The name can’t end with .git');

/** `owner/name` of a GitHub repository. */
export const GithubRepoFullNameSchema = z
  .string()
  .trim()
  .max(140)
  .regex(/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/, 'Pick a repository from the list')
  .refine((v) => !/\/\.{1,2}$/.test(v), 'Pick a repository from the list');

/**
 * Turns a project name into a suggested repository name (for prefilling the publish form):
 * other characters become `-`, repeated `-` collapse, and the ends are trimmed.
 */
export function suggestGithubRepoName(projectName: string): string {
  const name = projectName
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .replace(/\.git$/i, '')
    .slice(0, 100);
  return name === '' ? 'my-project' : name;
}

export const GithubModeSchema = z.enum(['publish_once', 'keep_updated']);

// ---------- Your GitHub account (/api/github, logged in) ----------

/**
 * GET /api/github/account → GithubAccountView. `configured` is false when this DevSpace has no
 * GitHub App set up (then every other field is false/null). `installUrl` =
 * GITHUB_WEB_URL/apps/<slug>/installations/new (null when not configured).
 */
export const GithubAccountViewSchema = z.object({
  configured: z.boolean(),
  connected: z.boolean(),
  /** Your GitHub username, or null. */
  login: z.string().nullable(),
  connectedAt: z.iso.datetime().nullable(),
  installUrl: z.url().nullable(),
  /** Whether the app is installed on your GitHub account (null when not connected or unknown). */
  appInstalled: z.boolean().nullable(),
});

/**
 * POST /api/github/connect/start (body `{}`) → { url }: send the browser there (a full-page
 * navigation). GitHub comes back to APP_ORIGIN/settings/github/callback?code=…&state=….
 */
export const GithubConnectStartResponseSchema = z.object({ url: z.url() });

/**
 * POST /api/github/connect/finish { code, state } → GithubAccountView (connected). The state is
 * single use, 10 minutes, and bound to your session (400 `invalid_state` otherwise); 502
 * `github_error` if GitHub refuses the code. Connecting again replaces the old tokens.
 */
export const GithubConnectFinishRequestSchema = z.object({
  code: z.string().trim().min(1).max(2000),
  state: z.string().trim().min(1).max(200),
});

// DELETE /api/github/account (no body) → 204. Deletes your stored tokens. (You can also revoke
// DevSpace in your GitHub settings → Applications.)

/** One repository you can import (reachable through the app's installations). */
export const GithubRepoSchema = z.object({
  fullName: z.string(),
  private: z.boolean(),
  defaultBranch: z.string(),
  htmlUrl: z.string(),
  /** GitHub's size estimate in KB (may lag behind). */
  sizeKb: z.number().int().nonnegative(),
});

/**
 * GET /api/github/repos → every repository you can reach through the DevSpace app's
 * installations (private ones included), sorted by full name. Needs a connected account
 * (`github_not_connected`); an empty list when the app isn't installed anywhere you can see.
 */
export const GithubRepoListResponseSchema = z.object({
  repos: z.array(GithubRepoSchema),
  installUrl: z.url().nullable(),
});

// ---------- A project's GitHub link (/api/projects/:projectId/github) ----------

export const GithubLinkStatusSchema = z.enum(['ok', 'pushing', 'paused', 'failed']);

/** The project's linked repository. */
export const GithubLinkViewSchema = z.object({
  repoFullName: z.string(),
  htmlUrl: z.string(),
  private: z.boolean(),
  mode: GithubModeSchema,
  /**
   * `pushing`: a push is queued or running. `paused`: GitHub has commits DevSpace doesn't (never
   * force-pushed; Try again after fixing it on GitHub). `failed`: the last push failed
   * (`statusReason`); retried automatically by housekeeping and by Try again.
   */
  status: GithubLinkStatusSchema,
  statusReason: z.string().nullable(),
  /** The main commit GitHub has from DevSpace, and when it was pushed. */
  lastPushedSha: z.string().nullable(),
  lastPushedAt: z.iso.datetime().nullable(),
  /** Whether main has commits GitHub doesn't have yet. */
  behind: z.boolean(),
  setUpBy: UserRefSchema.nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

/**
 * GET /api/projects/:projectId/github (any member) → ProjectGithubView.
 * - `configured`: GitHub is set up on this DevSpace.
 * - `connected`: you connected your GitHub account (publishing uses it).
 * - `canPublish`: you may publish (leaders, or `github.publish`) and the project isn't linked.
 * - `canManage`: you may Try again (leaders, or `github.publish`) on a linked project.
 * - `canUnlink`: leaders and co-leaders, on a linked project.
 * - `emailWarning.names`: display names of people whose real email address (not a noreply one)
 *   is in main's history, sorted; empty when none or when the repository isn't ready. Only for
 *   viewers with `canPublish` (empty for others).
 */
export const ProjectGithubViewSchema = z.object({
  configured: z.boolean(),
  connected: z.boolean(),
  installUrl: z.url().nullable(),
  link: GithubLinkViewSchema.nullable(),
  canPublish: z.boolean(),
  canManage: z.boolean(),
  canUnlink: z.boolean(),
  emailWarning: z.object({ names: z.array(z.string()) }),
});

/**
 * POST /api/projects/:projectId/github/publish → 202 ProjectGithubView (status `pushing`).
 * Leaders, or `github.publish`. Creates `name` on your GitHub account (private unless
 * `private: false`), adds it to the app's installation, saves the link and the project's
 * `githubMode`, then a worker pushes main with its full history (watch the `github`
 * invalidate key, or poll GET while `pushing`). `acceptEmailWarning` must be true when
 * `emailWarning.names` isn't empty.
 */
export const PublishGithubRequestSchema = z.object({
  name: GithubRepoNameSchema,
  private: z.boolean().default(true),
  mode: GithubModeSchema,
  acceptEmailWarning: z.boolean().default(false),
});

// POST /api/projects/:projectId/github/sync (body `{}`) → 202 ProjectGithubView: Try again
// (leaders, or `github.publish`; any status except `pushing`, else 409 `sync_running`).
// DELETE /api/projects/:projectId/github (body `{}` or none) → 204: unlink (leaders and
// co-leaders). The GitHub repository stays. Changing settings.githubMode on a linked project
// changes the link's mode; switching to `keep_updated` pushes at once.

// ---------- Activity and notifications ----------

/**
 * Activity rows: `github.published` { repoFullName, htmlUrl, private, mode }, `github.unlinked`
 * { repoFullName }, `github.sync_paused` { repoFullName, reason }, `github.sync_failed`
 * { repoFullName, reason } (automatic ones have no actor). Ordinary successful pushes aren't
 * logged.
 */
export const GITHUB_ACTIVITY_ACTIONS = [
  'github.published',
  'github.unlinked',
  'github.sync_paused',
  'github.sync_failed',
] as const;

export type GithubRepoName = z.infer<typeof GithubRepoNameSchema>;
export type GithubMode = z.infer<typeof GithubModeSchema>;
export type GithubAccountView = z.infer<typeof GithubAccountViewSchema>;
export type GithubConnectFinishRequest = z.infer<typeof GithubConnectFinishRequestSchema>;
export type GithubRepo = z.infer<typeof GithubRepoSchema>;
export type GithubRepoListResponse = z.infer<typeof GithubRepoListResponseSchema>;
export type GithubLinkStatus = z.infer<typeof GithubLinkStatusSchema>;
export type GithubLinkView = z.infer<typeof GithubLinkViewSchema>;
export type ProjectGithubView = z.infer<typeof ProjectGithubViewSchema>;
export type PublishGithubRequest = z.infer<typeof PublishGithubRequestSchema>;
export type GithubActivityAction = (typeof GITHUB_ACTIVITY_ACTIONS)[number];
