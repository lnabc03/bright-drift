import { describe, it, expect } from 'vitest';
import { isCosmeticDiff, withinFormatterWindow } from './format.js';

describe('isCosmeticDiff (FR-8)', () => {
  it('whitespace-only change is cosmetic', () => {
    expect(isCosmeticDiff('const  x=1', 'const x = 1')).toBe(true);
  });

  it('quote style + spacing change is cosmetic (word tokens unchanged)', () => {
    expect(isCosmeticDiff("import {a} from 'b'", 'import { a } from "b";')).toBe(true);
  });

  it('semicolon addition alone is cosmetic', () => {
    expect(isCosmeticDiff('const x = 1', 'const x = 1;')).toBe(true);
  });

  it('real token change is NOT cosmetic', () => {
    expect(isCosmeticDiff('const TTL = 3600', 'const TTL = 7200')).toBe(false);
  });

  it('identical content is not a diff at all', () => {
    expect(isCosmeticDiff('same', 'same')).toBe(false);
  });

  it('reordered tokens are NOT cosmetic', () => {
    expect(isCosmeticDiff('a b', 'b a')).toBe(false);
  });
});

describe('withinFormatterWindow', () => {
  it('inside the window', () => {
    expect(withinFormatterWindow(1000, 1800, { formatterWindowMs: 1000 })).toBe(true);
  });
  it('outside the window', () => {
    expect(withinFormatterWindow(1000, 2500, { formatterWindowMs: 1000 })).toBe(false);
  });
  it('no baseline write → never formatted', () => {
    expect(withinFormatterWindow(undefined, 100)).toBe(false);
  });
});
