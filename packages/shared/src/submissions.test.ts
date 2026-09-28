import { describe, expect, it } from 'vitest';
import {
  CopyChangesResponseSchema,
  CreateCommentRequestSchema,
  CreateReviewRequestSchema,
  CreateSubmissionRequestSchema,
  FileSideSchema,
  isActiveSubmissionStatus,
  MAX_SUBMISSION_FILES,
  RejectSubmissionRequestSchema,
  SubmissionDetailSchema,
  SubmissionListQuerySchema,
  SuggestionDecisionRequestSchema,
  UpdateSubmissionRequestSchema,
} from './submissions.ts';

describe('CreateSubmissionRequestSchema', () => {
  it('accepts a title, optional description and paths', () => {
    expect(CreateSubmissionRequestSchema.parse({ title: '  Fix  ', paths: ['a.ts'] })).toEqual({
      title: 'Fix',
      description: '',
      paths: ['a.ts'],
    });
  });

  it('rejects a missing title, no paths, duplicates, bad paths and too many paths', () => {
    const bad = [
      { title: ' ', paths: ['a'] },
      { title: 'x'.repeat(201), paths: ['a'] },
      { title: 'x', paths: [] },
      { title: 'x', paths: ['a', 'a'] },
      { title: 'x', paths: ['../etc/passwd'] },
      { title: 'x', paths: ['/abs'] },
      { title: 'x', paths: [''] },
      { title: 'x', paths: ['a\\b'] },
      { title: 'x', paths: Array.from({ length: MAX_SUBMISSION_FILES + 1 }, (_, i) => `f${i}`) },
      { title: 'x', description: 'd'.repeat(10_001), paths: ['a'] },
    ];
    for (const body of bad) {
      expect(CreateSubmissionRequestSchema.safeParse(body).success).toBe(false);
    }
  });
});

describe('UpdateSubmissionRequestSchema', () => {
  it('allows an empty body (re-read the same files)', () => {
    expect(UpdateSubmissionRequestSchema.parse({})).toEqual({});
  });
});

describe('SubmissionListQuerySchema', () => {
  it('defaults to active', () => {
    expect(SubmissionListQuerySchema.parse({})).toEqual({ status: 'active' });
    expect(SubmissionListQuerySchema.safeParse({ status: 'merged' }).success).toBe(false);
  });
});

describe('CreateCommentRequestSchema', () => {
  it('accepts general, line, range, reply and suggestion comments', () => {
    const good = [
      { body: 'hi' },
      { body: 'hi', path: 'a.ts', side: 'base', line: 3 },
      { body: 'hi', path: 'a.ts', side: 'head', line: 3, startLine: 1 },
      { body: 'yes', parentId: 'c1' },
      { body: 'try', path: 'a.ts', side: 'head', line: 2, startLine: 2, suggestion: 'x' },
      { body: 'drop', path: 'a.ts', side: 'head', line: 2, suggestion: '' },
    ];
    for (const body of good) {
      expect(CreateCommentRequestSchema.safeParse(body).success, JSON.stringify(body)).toBe(true);
    }
  });

  it('rejects partial locations, bad ranges, located replies and base-side suggestions', () => {
    const bad = [
      { body: ' ' },
      { body: 'hi', path: 'a.ts' },
      { body: 'hi', path: 'a.ts', side: 'head' },
      { body: 'hi', path: 'a.ts', side: 'head', line: 0 },
      { body: 'hi', path: 'a.ts', side: 'head', line: 2, startLine: 3 },
      { body: 'hi', startLine: 1 },
      { body: 'hi', parentId: 'c1', path: 'a.ts', side: 'head', line: 1 },
      { body: 'hi', suggestion: 'x' },
      { body: 'hi', path: 'a.ts', side: 'base', line: 1, suggestion: 'x' },
      { body: 'hi', path: '../a', side: 'head', line: 1 },
    ];
    for (const body of bad) {
      expect(CreateCommentRequestSchema.safeParse(body).success, JSON.stringify(body)).toBe(false);
    }
  });
});

describe('small request schemas', () => {
  it('check decisions and reasons', () => {
    expect(SuggestionDecisionRequestSchema.safeParse({ decision: 'accept' }).success).toBe(true);
    expect(SuggestionDecisionRequestSchema.safeParse({ decision: 'maybe' }).success).toBe(false);
    expect(CreateReviewRequestSchema.safeParse({ decision: 'approved' }).success).toBe(true);
    expect(CreateReviewRequestSchema.safeParse({ decision: 'rejected' }).success).toBe(false);
    expect(RejectSubmissionRequestSchema.safeParse({ reason: '  ' }).success).toBe(false);
    expect(RejectSubmissionRequestSchema.safeParse({ reason: 'x'.repeat(2001) }).success).toBe(
      false,
    );
  });
});

describe('response schemas', () => {
  it('parse file sides and changes', () => {
    expect(FileSideSchema.parse({ kind: 'text', content: 'a' })).toEqual({
      kind: 'text',
      content: 'a',
    });
    expect(FileSideSchema.safeParse({ kind: 'text' }).success).toBe(false);
    expect(
      CopyChangesResponseSchema.parse({
        baseSha: 'a'.repeat(40),
        files: [{ path: 'a', change: 'added', openSubmissionId: null }],
      }).files,
    ).toHaveLength(1);
  });

  it('parse a submission detail', () => {
    const now = '2026-09-28T10:00:00.000Z';
    const detail = {
      id: 's1',
      title: 'T',
      status: 'open',
      author: { id: 'u1', name: 'Ann' },
      version: 1,
      fileCount: 1,
      commentCount: 0,
      approvals: 0,
      createdAt: now,
      updatedAt: now,
      description: '',
      baseSha: 'a'.repeat(40),
      headSha: 'b'.repeat(40),
      rejectReason: null,
      closedAt: null,
      files: [{ path: 'a', change: 'modified' }],
      reviews: [],
      comments: [],
      viewerActions: ['update', 'comment'],
    };
    expect(SubmissionDetailSchema.parse(detail)).toEqual(detail);
    expect(SubmissionDetailSchema.safeParse({ ...detail, viewerActions: ['merge'] }).success).toBe(
      false,
    );
  });

  it('know which statuses are active', () => {
    expect(isActiveSubmissionStatus('approved')).toBe(true);
    expect(isActiveSubmissionStatus('needs_update')).toBe(true);
    expect(isActiveSubmissionStatus('closed')).toBe(false);
    expect(isActiveSubmissionStatus('rejected')).toBe(false);
  });
});
