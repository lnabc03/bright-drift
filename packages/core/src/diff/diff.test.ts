import { describe, it, expect } from 'vitest';
import { createFileDiff, isBinaryContent, estimateTokens } from './index.js';

describe('createFileDiff', () => {
  it('returns null for identical content', () => {
    expect(createFileDiff('a\nb\n', 'a\nb\n')).toBeNull();
  });

  it('counts added/removed and renders hunks', () => {
    const old = 'line1\nconst TTL = 3600;\nline3\n';
    const next = 'line1\nconst TTL = 7200;\nline3\n';
    const diff = createFileDiff(old, next);
    expect(diff).not.toBeNull();
    expect(diff!.added).toBe(1);
    expect(diff!.removed).toBe(1);
    expect(diff!.patch).toContain('-const TTL = 3600;');
    expect(diff!.patch).toContain('+const TTL = 7200;');
    expect(diff!.patch).toContain('@@');
    expect(diff!.truncated).toBe(false);
  });

  it('truncates beyond maxLines (FR-4 per-file cap)', () => {
    const old = Array.from({ length: 100 }, (_, i) => `old${i}`).join('\n');
    const next = Array.from({ length: 100 }, (_, i) => `new${i}`).join('\n');
    const diff = createFileDiff(old, next, { maxLines: 20, contextLines: 0 });
    expect(diff!.truncated).toBe(true);
    expect(diff!.patch.split('\n').length).toBe(20);
    expect(diff!.totalLines).toBeGreaterThan(20);
  });
});

describe('isBinaryContent', () => {
  it('detects null bytes', () => {
    expect(isBinaryContent(Buffer.from([0x89, 0x50, 0x00, 0x47]))).toBe(true);
    expect(isBinaryContent(Buffer.from('plain text'))).toBe(false);
  });
});

describe('estimateTokens', () => {
  it('estimates 4 chars per token', () => {
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
    expect(estimateTokens('')).toBe(0);
  });
});
