import { describe, expect, it } from 'vitest';
import {
  checkFindings,
  MAX_FINDINGS_BYTES,
  reviewFindingsEndpoint,
  reviewSubmissionIdOf,
  sendFindings,
} from './review';

const origin = 'http://127.0.0.1:3100';
const copyId = '0b6f3c1e-8a2d-4f55-9d7e-1c2b3a4d5e6f';
const root = `${origin}/ide/${copyId}/stable-abc/static/out/`;
const endpoint = `${origin}/ide/${copyId}/__devspace/review-findings`;

describe('reviewFindingsEndpoint', () => {
  it('is next to the presence endpoint, on the IDE’s own origin', () => {
    expect(reviewFindingsEndpoint(root, origin)).toBe(endpoint);
  });

  it('never points at another origin, and needs an /ide/<copyId>/ path', () => {
    expect(reviewFindingsEndpoint(root, 'http://localhost:5173')).toBeNull();
    expect(reviewFindingsEndpoint(`${origin}/static/out/`, origin)).toBeNull();
    expect(reviewFindingsEndpoint(undefined, origin)).toBeNull();
  });
});

describe('reviewSubmissionIdOf', () => {
  const remote = (path: string) => ({ scheme: 'vscode-remote', path });

  it('finds the submission id of any file in a review folder', () => {
    expect(
      reviewSubmissionIdOf(remote('/home/workspace/.devspace/reviews/sub_1/findings.md')),
    ).toBe('sub_1');
    expect(
      reviewSubmissionIdOf(remote('/home/workspace/.devspace/reviews/abc-DEF/REVIEW.md')),
    ).toBe('abc-DEF');
  });

  it('is null elsewhere, for other schemes or odd folder names', () => {
    expect(reviewSubmissionIdOf(undefined)).toBeNull();
    expect(reviewSubmissionIdOf(remote('/home/workspace/src/findings.md'))).toBeNull();
    expect(reviewSubmissionIdOf(remote('/home/workspace/.devspace/reviews/'))).toBeNull();
    expect(reviewSubmissionIdOf(remote('/home/workspace/.devspace/reviews/../x/f.md'))).toBeNull();
    expect(reviewSubmissionIdOf(remote('/home/workspace/.devspace/reviews/a.b/f.md'))).toBeNull();
    expect(reviewSubmissionIdOf(remote('/tmp/.devspace/reviews/abc/findings.md'))).toBeNull();
    expect(
      reviewSubmissionIdOf({
        scheme: 'untitled',
        path: '/home/workspace/.devspace/reviews/abc/findings.md',
      }),
    ).toBeNull();
    expect(
      reviewSubmissionIdOf(remote(`/home/workspace/.devspace/reviews/${'a'.repeat(65)}/f.md`)),
    ).toBeNull();
  });
});

describe('checkFindings', () => {
  it('accepts up to 50 KB of UTF-8 and refuses more or nothing', () => {
    expect(checkFindings('[]')).toEqual({ ok: true });
    expect(checkFindings('a'.repeat(MAX_FINDINGS_BYTES))).toEqual({ ok: true });
    expect(checkFindings('a'.repeat(MAX_FINDINGS_BYTES + 1))).toMatchObject({ ok: false });
    // 3 bytes each in UTF-8: fewer characters than the limit, but more bytes.
    expect(checkFindings('€'.repeat(20_000))).toMatchObject({
      ok: false,
      message: expect.stringMatching(/59 KB; DevSpace takes at most 50 KB/),
    });
    expect(checkFindings('  \n')).toMatchObject({ ok: false, message: /empty/ });
  });
});

describe('sendFindings', () => {
  type Call = { url: string; init: Parameters<Parameters<typeof sendFindings>[0]>[1] };
  function fakeFetch(status: number, body = '') {
    const calls: Call[] = [];
    const fn = async (url: string, init: Call['init']) => {
      calls.push({ url, init });
      return { ok: status >= 200 && status < 300, status, text: async () => body };
    };
    return { fn, calls };
  }

  it('POSTs { submissionId, findings } as JSON with the IDE cookie', async () => {
    const { fn, calls } = fakeFetch(201, '{"review":{}}');
    const findings = '[{"path":"a.ts","line":1,"severity":"low","title":"t","detail":"d"}]';
    expect(await sendFindings(fn, endpoint, 'sub_1', findings)).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(endpoint);
    expect(calls[0]!.init).toMatchObject({
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
    });
    expect(JSON.parse(calls[0]!.init.body)).toEqual({ submissionId: 'sub_1', findings });
  });

  it('does not send findings that are too big or empty', async () => {
    const { fn, calls } = fakeFetch(201);
    const result = await sendFindings(fn, endpoint, 'sub_1', 'x'.repeat(MAX_FINDINGS_BYTES + 1));
    expect(result).toMatchObject({ ok: false, message: /at most 50 KB/ });
    expect(await sendFindings(fn, endpoint, 'sub_1', '')).toMatchObject({ ok: false });
    expect(calls).toHaveLength(0);
  });

  it('shows the API’s message when it refuses', async () => {
    const { fn } = fakeFetch(409, '{"error":"ai_disabled","message":"AI review is off"}');
    expect(await sendFindings(fn, endpoint, 'sub_1', '[]')).toEqual({
      ok: false,
      message: 'DevSpace did not accept the findings (409): AI review is off',
    });
    const nested = fakeFetch(403, '{"error":{"code":"forbidden","message":"Not your copy"}}');
    expect(await sendFindings(nested.fn, endpoint, 'sub_1', '[]')).toMatchObject({
      message: 'DevSpace did not accept the findings (403): Not your copy',
    });
    const plain = fakeFetch(502, '<html>Bad gateway</html>');
    expect(await sendFindings(plain.fn, endpoint, 'sub_1', '[]')).toMatchObject({
      message: 'DevSpace did not accept the findings (502).',
    });
  });

  it('says so when DevSpace cannot be reached', async () => {
    const failing = async () => {
      throw new TypeError('Failed to fetch');
    };
    expect(await sendFindings(failing, endpoint, 'sub_1', '[]')).toMatchObject({
      ok: false,
      message: /Could not reach DevSpace/,
    });
  });
});
