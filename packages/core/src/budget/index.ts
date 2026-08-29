import { estimateTokens, type FileDiff } from '../diff/index.js';

export interface BudgetOptions {
  /** Per-file rendered patch line cap (default 200, FR-4). */
  maxDiffLinesPerFile?: number;
  /** Total rendered patch lines per injection (default 1000). */
  maxTotalDiffLines?: number;
  /** Token cap per injection, 4 chars ≈ 1 token estimate (default 2000). */
  maxInjectTokens?: number;
  /** More drifted files than this switches everything to list-only (default 50, E6). */
  maxDriftFilesForDiff?: number;
}

export const DEFAULT_BUDGET: Required<BudgetOptions> = {
  maxDiffLinesPerFile: 200,
  maxTotalDiffLines: 1000,
  maxInjectTokens: 2000,
  maxDriftFilesForDiff: 50,
};

export interface RenderCandidate {
  /** Line count if the diff were rendered (0 for list-only entries). */
  diffLines: number;
  /** Estimated token cost of the full per-file block. */
  tokens: number;
  hasDiff: boolean;
}

export type RenderMode = 'diff' | 'list';

export interface RenderPlan<T extends RenderCandidate> {
  /** One mode per candidate, same order. */
  modes: RenderMode[];
  /** True when the file count alone forced list-only mode (E6). */
  listOnlyMode: boolean;
  /** How many candidates lost their diff due to budget. */
  truncatedCount: number;
  /** Inputs reordered or filtered never happen here — renderer owns ordering. */
  items: T[];
}

/**
 * Three-step degradation ladder (FR-4): per-file line cap (already applied
 * by the diff module) → total line/token caps → whole-batch list-only mode.
 * Pure and greedy: earlier items keep their diffs first.
 */
export function planBudget<T extends RenderCandidate>(
  items: T[],
  options: BudgetOptions = {},
): RenderPlan<T> {
  const opts = { ...DEFAULT_BUDGET, ...options };
  const listOnlyMode = items.length > opts.maxDriftFilesForDiff;

  let usedLines = 0;
  let usedTokens = 0;
  let truncatedCount = 0;

  const modes = items.map((item): RenderMode => {
    if (listOnlyMode || !item.hasDiff) {
      if (item.hasDiff) truncatedCount += 1;
      return 'list';
    }
    if (
      usedLines + item.diffLines > opts.maxTotalDiffLines ||
      usedTokens + item.tokens > opts.maxInjectTokens
    ) {
      truncatedCount += 1;
      return 'list';
    }
    usedLines += item.diffLines;
    usedTokens += item.tokens;
    return 'diff';
  });

  return { modes, listOnlyMode, truncatedCount, items };
}

/** Convenience for building a candidate from a diff result. */
export function candidateFromDiff(diff: FileDiff | null, overheadText = ''): RenderCandidate {
  if (!diff) return { diffLines: 0, tokens: estimateTokens(overheadText), hasDiff: false };
  return {
    diffLines: diff.patch === '' ? 0 : diff.patch.split('\n').length,
    tokens: estimateTokens(diff.patch + overheadText),
    hasDiff: diff.patch !== '',
  };
}
