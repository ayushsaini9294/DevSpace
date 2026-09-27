import { describe, expect, it } from 'vitest';
import { CopyResponseSchema, CopyViewSchema, IdeLaunchResponseSchema } from './copies.ts';

const copy = {
  id: '6f1c1f0e-5b7a-4a52-9b0e-1d2f3a4b5c6d',
  branchName: 'copy/0b7c6a1e-2d3f-4e5a-8b9c-0d1e2f3a4b5c',
  containerStatus: 'none',
  createdAt: '2026-09-27T12:00:00.000Z',
  lastActiveAt: null,
};

describe('CopyViewSchema', () => {
  it('accepts a copy', () => {
    expect(CopyViewSchema.parse(copy)).toEqual(copy);
    expect(
      CopyViewSchema.parse({ ...copy, containerStatus: 'running', lastActiveAt: copy.createdAt })
        .containerStatus,
    ).toBe('running');
  });

  it('rejects an unknown container status or a bad date', () => {
    expect(CopyViewSchema.safeParse({ ...copy, containerStatus: 'paused' }).success).toBe(false);
    expect(CopyViewSchema.safeParse({ ...copy, createdAt: 'yesterday' }).success).toBe(false);
  });

  it('drops anything that is not part of the view, such as a path', () => {
    expect(CopyViewSchema.parse({ ...copy, path: '/srv/copies/x' })).not.toHaveProperty('path');
  });
});

describe('CopyResponseSchema', () => {
  it('allows no copy yet', () => {
    expect(CopyResponseSchema.parse({ copy: null })).toEqual({ copy: null });
  });
});

describe('IdeLaunchResponseSchema', () => {
  it('accepts only an absolute http(s) URL', () => {
    const url = 'http://127.0.0.1:3100/ide-launch?ticket=abc';
    expect(IdeLaunchResponseSchema.parse({ url })).toEqual({ url });
    expect(
      IdeLaunchResponseSchema.safeParse({ url: 'https://ide.example.dev/ide-launch?ticket=a' })
        .success,
    ).toBe(true);
    for (const bad of ['/ide-launch?ticket=a', 'javascript:alert(1)', 'data:text/html,x', '']) {
      expect(IdeLaunchResponseSchema.safeParse({ url: bad }).success, bad).toBe(false);
    }
  });
});
