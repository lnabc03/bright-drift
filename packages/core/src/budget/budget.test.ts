import { describe, it, expect } from 'vitest';
import { planBudget, candidateFromDiff, DEFAULT_BUDGET } from './index.js';
import type { FileDiff } from '../diff/index.js';

function diff(lines: number): FileDiff {
  return {
    added: lines / 2,
    removed: lines / 2,
    patch: Array.from({ length: lines }, (_, i) => `line${i}`).join('\n'),
    truncated: false,
    totalLines: lines,
  };
}

describe('planBudget', () => {
  it('lets everything through under budget', () => {
    const items = [candidateFromDiff(diff(10)), candidateFromDiff(diff(20))];
    const plan = planBudget(items);
    expect(plan.modes).toEqual(['diff', 'diff']);
    expect(plan.truncatedCount).toBe(0);
    expect(plan.listOnlyMode).toBe(false);
  });

  it('demotes later files when the total line budget is exhausted', () => {
    const items = [
      candidateFromDiff(diff(600)),
      candidateFromDiff(diff(600)),
      candidateFromDiff(diff(10)),
    ];
    const plan = planBudget(items, { maxTotalDiffLines: 1000, maxInjectTokens: 1_000_000 });
    expect(plan.modes).toEqual(['diff', 'list', 'diff']);
    expect(plan.truncatedCount).toBe(1);
  });

  it('demotes on the token budget too', () => {
    const big = candidateFromDiff(diff(100)); // ~500+ tokens
    const plan = planBudget([big], { maxInjectTokens: 10, maxTotalDiffLines: 1_000_000 });
    expect(plan.modes).toEqual(['list']);
  });

  it('E6: more files than maxDriftFilesForDiff forces list-only mode', () => {
    const items = Array.from({ length: 51 }, () => candidateFromDiff(diff(4)));
    const plan = planBudget(items); // default cap 50
    expect(plan.listOnlyMode).toBe(true);
    expect(plan.modes.every((m) => m === 'list')).toBe(true);
  });

  it('files without diffs stay list-mode and do not count as truncated', () => {
    const items = [candidateFromDiff(null, 'a.ts deleted')];
    const plan = planBudget(items);
    expect(plan.modes).toEqual(['list']);
    expect(plan.truncatedCount).toBe(0);
  });

  it('defaults match design FR-4', () => {
    expect(DEFAULT_BUDGET).toEqual({
      maxDiffLinesPerFile: 200,
      maxTotalDiffLines: 1000,
      maxInjectTokens: 2000,
      maxDriftFilesForDiff: 50,
    });
  });
});
