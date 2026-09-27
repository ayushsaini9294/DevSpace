import { describe, expect, it } from 'vitest';
import { safeNext } from './safeNext';

describe('safeNext', () => {
  it.each([
    ['/', '/'],
    ['/projects', '/projects'],
    ['/projects/42?tab=files#readme', '/projects/42?tab=files#readme'],
    ['/a/../b', '/b'],
  ])('keeps the same-site path %s', (raw, expected) => {
    expect(safeNext(raw)).toBe(expected);
  });

  it.each([
    [null],
    [undefined],
    [''],
    ['projects'],
    ['//evil.example.com'],
    ['//evil.example.com/path'],
    ['/\\evil.example.com'],
    ['\\\\evil.example.com'],
    ['https://evil.example.com'],
    ['javascript:alert(1)'],
    ['/\tevil'],
    ['/\n/evil.example.com'],
    ['/login'],
    ['/signup?next=/x'],
  ])('falls back to / for %j', (raw) => {
    expect(safeNext(raw)).toBe('/');
  });
});
