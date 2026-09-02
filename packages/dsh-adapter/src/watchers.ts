import { WorkspaceWatcher, createIgnoreMatcher, type WatchEvent } from 'bright-drift-core';
import type { TimerServiceLike } from './types.js';
import type { BrightDriftConfig } from './config.js';
import type { Logger } from './log.js';

export interface WatchEntry {
  root: string;
  watcher: WorkspaceWatcher;
  refcount: number;
  /**
   * Live ignore matcher, hot-swappable (§5.3): the watcher consults it
   * through a delegating closure per event, so config/.gitignore changes
   * apply without re-creating chokidar.
   */
  ignored: (relPath: string) => boolean;
}

/**
 * One chokidar watcher per workspace root, shared by all sessions on that
 * root (design §5.3). Refcounted: released when the last session leaves.
 * The debounce is bridged to ctx.timer when available so timers dispose
 * with the plugin fiber (F8); otherwise native timers via core default.
 */
export class WatchRegistry {
  private entries = new Map<string, WatchEntry>();

  constructor(
    private readonly timer: TimerServiceLike | undefined,
    private readonly logger: Logger,
  ) {}

  get roots(): string[] {
    return [...this.entries.keys()];
  }

  async acquire(
    root: string,
    config: BrightDriftConfig,
    onBatch: (root: string, events: WatchEvent[]) => void,
  ): Promise<void> {
    const existing = this.entries.get(root);
    if (existing) {
      existing.refcount += 1;
      return;
    }
    const ignored = await createIgnoreMatcher(root, {
      respectGitignore: config.watch.respectGitignore,
      extraIgnore: config.watch.extraIgnore,
      onError: (e) => this.logger.error('ignore-rules', e, { root }),
    });
    const timer = this.timer;
    // The entry is filled in two steps so the watcher closure can consult
    // the LIVE matcher (hot-swapped by refreshIgnore) instead of a snapshot.
    const entry = {} as WatchEntry;
    entry.root = root;
    entry.refcount = 1;
    entry.ignored = ignored;
    entry.watcher = new WorkspaceWatcher({
      root,
      debounceMs: 300,
      ignored: (rel) => entry.ignored(rel),
      onBatch: (events) => onBatch(root, events),
      onError: (e) => this.logger.error('watcher', e, { root }),
      // Adapt ctx.timer.debounce (returns fn with dispose) to the core
      // DebounceFactory shape (returns a plain trigger).
      ...(timer
        ? {
            debounceFactory: (fn: () => void, ms: number) => {
              const debounced = timer.debounce(fn as (...args: never[]) => void, ms);
              return () => debounced();
            },
          }
        : {}),
    });
    entry.watcher.start();
    this.entries.set(root, entry);
    this.logger.log('watcher.acquired', { root });
  }

  /** Rebuild the ignore matcher in place (config or .gitignore changed). */
  async refreshIgnore(root: string, config: BrightDriftConfig): Promise<void> {
    const entry = this.entries.get(root);
    if (!entry) return;
    entry.ignored = await createIgnoreMatcher(root, {
      respectGitignore: config.watch.respectGitignore,
      extraIgnore: config.watch.extraIgnore,
      onError: (e) => this.logger.error('ignore-rules', e, { root }),
    });
    this.logger.log('watcher.ignore-refreshed', { root });
  }

  async release(root: string): Promise<void> {
    const entry = this.entries.get(root);
    if (!entry) return;
    entry.refcount -= 1;
    if (entry.refcount > 0) return;
    this.entries.delete(root);
    await entry.watcher.stop();
    this.logger.log('watcher.released', { root });
  }

  async stopAll(): Promise<void> {
    const roots = [...this.entries.keys()];
    for (const root of roots) {
      const entry = this.entries.get(root);
      this.entries.delete(root);
      await entry?.watcher.stop();
    }
  }
}
