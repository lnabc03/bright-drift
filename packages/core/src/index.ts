// bright-drift-core public API (design doc §4.1 — seven modules).

// baseline
export { sha1 } from './baseline/hash.js';
export { AgentKnowledgeBase } from './baseline/akb.js';
export { ContentStore, MemoryContentCache, DEFAULT_STORE_MAX_BYTES } from './baseline/content-store.js';
export type { AKBEntry, AKBSnapshot, AKBOptions } from './baseline/types.js';
export { DEFAULT_MAX_ENTRIES } from './baseline/types.js';

// watcher
export { WorkspaceWatcher, defaultDebounceFactory } from './watcher/watcher.js';
export type {
  WatchEvent,
  WatchEventKind,
  WorkspaceWatcherOptions,
  DebounceTrigger,
  DebounceFactory,
} from './watcher/watcher.js';
export { createIgnoreMatcher, BUILTIN_IGNORE } from './watcher/ignore.js';

// drift
export { reconcile, mergeRenames } from './drift/reconcile.js';
export { revalidateRecords } from './drift/revalidate.js';
export type { RevalidateResult, RevalidateDrop, RevalidateDropReason } from './drift/revalidate.js';
export { DriftQueue } from './drift/queue.js';
export { probeFile, toRelativeKey } from './drift/probe.js';
export type { DriftKind, DriftRecord, FileObservation } from './drift/types.js';

// attribution
export { Attributor } from './attribution/attributor.js';
export type {
  Attribution,
  AttributorOptions,
  ShellWindow,
  SnapshotEntry,
} from './attribution/attributor.js';
export {
  analyzeBash,
  analyzePwsh,
  analyzeCommand,
  splitSegments,
  tokenize,
} from './attribution/static-analysis.js';
export { isCosmeticDiff, withinFormatterWindow } from './attribution/format.js';

// diff
export { createFileDiff, isBinaryContent, estimateTokens } from './diff/index.js';
export type { FileDiff, FileDiffOptions } from './diff/index.js';

// budget
export { planBudget, candidateFromDiff, DEFAULT_BUDGET } from './budget/index.js';
export type { BudgetOptions, RenderCandidate, RenderPlan, RenderMode } from './budget/index.js';

// message
export { renderInjection, buildSummary } from './message/render.js';
export type { RenderEntry, RenderOptions, RenderedInjection } from './message/render.js';

// sync policy
export { shouldInjectAtPreStep } from './sync/policy.js';
export type { PreStepContext } from './sync/policy.js';
