import { describe, expect, it } from 'vitest';
import {
  GithubRepoFullNameSchema,
  GithubRepoNameSchema,
  PublishGithubRequestSchema,
  suggestGithubRepoName,
} from './github.ts';
import { SetUpRepositoryRequestSchema } from './repository.ts';

describe('GitHub names', () => {
  it.each(['app', 'my-app', 'My_App.v2', 'a'.repeat(100)])('accepts %s', (name) => {
    expect(GithubRepoNameSchema.safeParse(name).success).toBe(true);
  });

  it.each(['', '.', '..', 'bad name', 'x.git', 'a/b', 'a'.repeat(101), 'ünï'])(
    'refuses %j',
    (name) => {
      expect(GithubRepoNameSchema.safeParse(name).success).toBe(false);
    },
  );

  it('suggests a valid name from a project name', () => {
    expect(suggestGithubRepoName('  My Cool Project!! ')).toBe('My-Cool-Project');
    expect(suggestGithubRepoName('***')).toBe('my-project');
    expect(GithubRepoNameSchema.safeParse(suggestGithubRepoName('Ünïcode app.git')).success).toBe(
      true,
    );
  });

  it('checks full names', () => {
    expect(GithubRepoFullNameSchema.safeParse('octo/app').success).toBe(true);
    expect(GithubRepoFullNameSchema.safeParse('octo/..').success).toBe(false);
    expect(GithubRepoFullNameSchema.safeParse('octo/../x').success).toBe(false);
    expect(GithubRepoFullNameSchema.safeParse('octo').success).toBe(false);
    expect(GithubRepoFullNameSchema.safeParse('a/b/c').success).toBe(false);
  });

  it('publishes private by default and needs no email tick unless asked', () => {
    expect(PublishGithubRequestSchema.parse({ name: 'x', mode: 'keep_updated' })).toEqual({
      name: 'x',
      private: true,
      mode: 'keep_updated',
      acceptEmailWarning: false,
    });
  });

  it('adds the github setup source', () => {
    expect(
      SetUpRepositoryRequestSchema.parse({ source: 'github', repoFullName: 'octo/app' }),
    ).toEqual({ source: 'github', repoFullName: 'octo/app' });
  });
});
