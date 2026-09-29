import { describe, expect, it } from 'vitest';
import {
  CreateAiReviewRequestSchema,
  groupAiFindings,
  InvalidateKeySchema,
  parseAiFindings,
  type AiFinding,
} from './index.ts';

const f = (
  path: string,
  line: number | null,
  severity: AiFinding['severity'] = 'low',
): AiFinding => ({
  path,
  line,
  severity,
  title: 't',
  detail: 'd',
});

describe('parseAiFindings', () => {
  it('takes the first JSON array, even inside prose or fences', () => {
    const answer =
      'Notes [not json] then:\n```json\n[{"file":"/src/x.ts","line":4,"severity":"weird","title":"A","description":"B"}, 5, {"line":2}]\n``` [1]';
    expect(parseAiFindings(answer)).toEqual({
      findings: [{ path: 'src/x.ts', line: 4, severity: 'medium', title: 'A', detail: 'B' }],
      parseError: false,
    });
  });

  it('handles brackets inside strings and bad lines', () => {
    const answer = '[{"path":"a.ts","line":-3,"severity":"HIGH","title":"x ] y","detail":"["}]';
    expect(parseAiFindings(answer).findings).toEqual([
      { path: 'a.ts', line: null, severity: 'high', title: 'x ] y', detail: '[' },
    ]);
  });

  it('flags answers with no array', () => {
    expect(parseAiFindings('nothing here')).toEqual({ findings: [], parseError: true });
    expect(parseAiFindings('[1, 2')).toEqual({ findings: [], parseError: true });
    expect(parseAiFindings('[]')).toEqual({ findings: [], parseError: false });
  });
});

describe('groupAiFindings', () => {
  it('groups the same path within ±3 lines and lists distinct models', () => {
    const groups = groupAiFindings([
      { id: 'r1', model: 'm1', findings: [f('a.ts', 10), f('a.ts', 30), f('b.ts', null)] },
      { id: 'r2', model: 'm2', findings: [f('a.ts', 13, 'high'), f('a.ts', 17)] },
      { id: 'r3', model: 'm1', findings: [f('a.ts', 11), f('b.ts', null, 'medium')] },
    ]);
    expect(
      groups.map((g) => [
        g.path,
        g.startLine,
        g.endLine,
        g.severity,
        g.agreedBy,
        g.findings.length,
      ]),
    ).toEqual([
      ['a.ts', 10, 13, 'high', ['m1', 'm2'], 3],
      ['a.ts', 17, 17, 'low', ['m2'], 1],
      ['a.ts', 30, 30, 'low', ['m1'], 1],
      ['b.ts', null, null, 'medium', ['m1'], 2],
    ]);
  });
});

describe('schemas', () => {
  it('limits models and knows the ai-reviews invalidate key', () => {
    expect(CreateAiReviewRequestSchema.safeParse({ models: ['a', 'a'] }).success).toBe(false);
    expect(CreateAiReviewRequestSchema.safeParse({ models: ['a', 'b', 'c', 'd'] }).success).toBe(
      false,
    );
    expect(CreateAiReviewRequestSchema.safeParse({}).success).toBe(true);
    expect(InvalidateKeySchema.safeParse('ai-reviews:abc').success).toBe(true);
  });
});
