import { describe, expect, it } from 'vitest';
import { ImportUrlSchema, RepoPathSchema, SetUpRepositoryRequestSchema } from './repository.ts';

describe('ImportUrlSchema', () => {
  it.each([
    ['https://github.com/owner/repo', 'https://github.com/owner/repo'],
    ['https://github.com/owner/repo.git', 'https://github.com/owner/repo'],
    ['  https://GitHub.com/owner/repo/  ', 'https://github.com/owner/repo'],
    ['https://gitlab.com/group/sub/repo', 'https://gitlab.com/group/sub/repo'],
    ['https://bitbucket.org/team/app.js', 'https://bitbucket.org/team/app.js'],
  ])('accepts %s', (input, normalized) => {
    expect(ImportUrlSchema.parse(input)).toBe(normalized);
  });

  it.each([
    'http://github.com/owner/repo',
    'git@github.com:owner/repo.git',
    'ssh://github.com/owner/repo',
    'file:///etc/passwd',
    'https://example.com/owner/repo',
    'https://github.com.evil.com/owner/repo',
    'https://localhost/owner/repo',
    'https://127.0.0.1/owner/repo',
    'https://user:pass@github.com/owner/repo',
    'https://github.com:8443/owner/repo',
    'https://github.com/owner/repo?x=1',
    'https://github.com/owner/repo#main',
    'https://github.com/owner',
    'https://github.com/owner/../repo',
    'https://github.com/owner/re po',
    'not a url',
    '',
  ])('rejects %s', (input) => {
    expect(ImportUrlSchema.safeParse(input).success).toBe(false);
  });
});

describe('RepoPathSchema', () => {
  it.each(['', 'README.md', 'src/app.ts', 'a/b/c.d.ts', '.github/workflows/ci.yml'])(
    'accepts %j',
    (path) => {
      expect(RepoPathSchema.safeParse(path).success).toBe(true);
    },
  );

  it.each([
    '/etc/passwd',
    '../secret',
    'src/../..',
    'src//app.ts',
    'src/',
    './src',
    'a\\b',
    'a\u0000b',
  ])('rejects %j', (path) => {
    expect(RepoPathSchema.safeParse(path).success).toBe(false);
  });
});

describe('SetUpRepositoryRequestSchema', () => {
  it('accepts empty and import', () => {
    expect(SetUpRepositoryRequestSchema.parse({ source: 'empty' })).toEqual({ source: 'empty' });
    expect(
      SetUpRepositoryRequestSchema.parse({ source: 'import', url: 'https://github.com/a/b.git' }),
    ).toEqual({ source: 'import', url: 'https://github.com/a/b' });
  });

  it('rejects an import without a valid url', () => {
    expect(SetUpRepositoryRequestSchema.safeParse({ source: 'import' }).success).toBe(false);
    expect(
      SetUpRepositoryRequestSchema.safeParse({ source: 'import', url: 'https://x.com/a/b' })
        .success,
    ).toBe(false);
  });
});
