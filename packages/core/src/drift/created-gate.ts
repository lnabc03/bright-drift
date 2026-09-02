import type { TrackedStatus } from '../watcher/git.js';

export interface CreatedGateOptions {
  /** Config watch.includeUntracked: when true, no gate at all (report every create). */
  includeUntracked: boolean;
  /** FR-7.2 predicted write target of an open/recently-closed window (D8a). */
  predicted?: (path: string) => boolean;
}

/**
 * Build the created-drift gate predicate for one watcher batch (design §5.3,
 * D7). Returns undefined when the gate is off entirely.
 *
 * Semantics per path: predicted-by-window → allow (a command's own output is
 * always reported); tracked or indistinguishable (non-git / git failure) →
 * allow; untracked in a git repo → suppress.
 */
export function makeCreatedFilter(
  statuses: Map<string, TrackedStatus> | undefined,
  options: CreatedGateOptions,
): ((path: string) => boolean) | undefined {
  if (options.includeUntracked) return undefined;
  const predicted = options.predicted;
  return (path: string) =>
    predicted?.(path) === true || statuses?.get(path) !== 'untracked';
}
