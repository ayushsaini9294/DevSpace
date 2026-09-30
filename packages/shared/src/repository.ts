import { z } from 'zod';
import { TemplateIdSchema } from './templates.ts';

/** Hosts a project can be imported from over https (see docs/decisions.md, Phase 4). */
export const IMPORT_HOSTS = ['github.com', 'gitlab.com', 'bitbucket.org'] as const;

export const MAX_IMPORT_BYTES = 200 * 1024 * 1024;

/** Files larger than this are listed in the browser but their content isn't sent. */
export const MAX_FILE_VIEW_BYTES = 1024 * 1024;

const SEGMENT = /^[A-Za-z0-9._-]+$/;

/**
 * A public https Git link on an allowed host, with no credentials, port, query or fragment,
 * and at least `owner/repo` in the path (GitLab subgroups allowed). Normalized to
 * `https://host/owner/repo` with any trailing `.git` or `/` removed.
 */
export const ImportUrlSchema = z
  .string()
  .trim()
  .min(1, 'Paste a Git link')
  .max(300)
  .transform((value, ctx) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      ctx.addIssue({ code: 'custom', message: 'Enter a full link starting with https://' });
      return z.NEVER;
    }
    const host = url.hostname.toLowerCase();
    const segments = url.pathname
      .replace(/\/+$/, '')
      .replace(/\.git$/, '')
      .split('/')
      .slice(1);
    const problem =
      url.protocol !== 'https:'
        ? 'The link must start with https://'
        : !(IMPORT_HOSTS as readonly string[]).includes(host)
          ? 'Only GitHub, GitLab and Bitbucket links are supported'
          : url.username || url.password || url.port || url.search || url.hash
            ? 'Remove any login details, port, query or # part from the link'
            : segments.length < 2 ||
                segments.some((s) => !SEGMENT.test(s) || s === '.' || s === '..')
              ? 'The link must point to a repository, like https://github.com/owner/repo'
              : null;
    if (problem) {
      ctx.addIssue({ code: 'custom', message: problem });
      return z.NEVER;
    }
    return `https://${host}/${segments.join('/')}`;
  });

/**
 * POST /api/projects/:projectId/repository — `repository.setup`. 202 RepositoryResponse.
 * Allowed only while the status is `none` or `failed`, else 409 `repository_exists`.
 * `empty` creates `main` with one commit adding README.md (`# <project name>`), credited to you.
 * `import` starts a background clone; poll GET until the status leaves `importing`.
 */
export const SetUpRepositoryRequestSchema = z.discriminatedUnion('source', [
  z.object({ source: z.literal('empty') }),
  z.object({ source: z.literal('import'), url: ImportUrlSchema }),
  /**
   * Phase 11: main starts with one commit holding the template's files (modes kept), credited
   * to you, with the message `Start from the <Name> template`. Ready at once (202, `ready`).
   */
  z.object({ source: z.literal('template'), template: TemplateIdSchema }),
]);

export const CommitSummarySchema = z.object({
  sha: z.string(),
  message: z.string(),
  authorName: z.string(),
  committedAt: z.iso.datetime(),
});

export const RepositoryStatusSchema = z.object({
  status: z.enum(['none', 'importing', 'ready', 'failed']),
  source: z.enum(['empty', 'import', 'template']).nullable(),
  /** The template main started from (Phase 11); null unless `source` is `template`. */
  template: TemplateIdSchema.nullable(),
  importUrl: z.string().nullable(),
  /** Why the last import failed, in plain words; null otherwise. */
  error: z.string().nullable(),
  /** The newest commit on main when ready; null otherwise (or if main has no commits). */
  lastCommit: CommitSummarySchema.nullable(),
});

/** GET /api/projects/:projectId/repository — any member. */
export const RepositoryResponseSchema = z.object({ repository: RepositoryStatusSchema });

/**
 * A path inside the repository: relative, forward slashes, no empty, `.` or `..` segments,
 * no leading or trailing slash, no backslashes or control characters. `''` is the root.
 */
export const RepoPathSchema = z
  .string()
  .max(1000)
  .refine(
    (value) =>
      value === '' ||
      (![...value].some((ch) => ch === '\\' || ch.charCodeAt(0) < 0x20) &&
        value.split('/').every((part) => part !== '' && part !== '.' && part !== '..')),
    'Invalid path',
  );

export const TreeEntrySchema = z.object({
  name: z.string(),
  path: z.string(),
  type: z.enum(['dir', 'file', 'symlink', 'submodule']),
  /** Size in bytes for files; null for everything else. */
  size: z.number().int().nullable(),
});

/**
 * GET /api/projects/:projectId/tree?path=<RepoPath> — any member; lists one folder of main.
 * Folders first, then files, each alphabetical (case-insensitive).
 * 409 `repository_not_ready` unless ready; 404 `not_found` if the path isn't a folder on main;
 * 400 `validation_error` for a bad path.
 */
export const TreeResponseSchema = z.object({
  path: z.string(),
  entries: z.array(TreeEntrySchema),
});

/**
 * GET /api/projects/:projectId/file?path=<RepoPath> — any member; one file on main.
 * `content` is UTF-8 text, or null when the file is binary or over MAX_FILE_VIEW_BYTES.
 * Same errors as the tree (404 if the path isn't a file).
 */
export const FileResponseSchema = z.object({
  path: z.string(),
  size: z.number().int(),
  isBinary: z.boolean(),
  tooLarge: z.boolean(),
  content: z.string().nullable(),
});

export type SetUpRepositoryRequest = z.infer<typeof SetUpRepositoryRequestSchema>;
export type CommitSummary = z.infer<typeof CommitSummarySchema>;
export type RepositoryStatus = z.infer<typeof RepositoryStatusSchema>;
export type TreeEntry = z.infer<typeof TreeEntrySchema>;
export type TreeResponse = z.infer<typeof TreeResponseSchema>;
export type FileResponse = z.infer<typeof FileResponseSchema>;
