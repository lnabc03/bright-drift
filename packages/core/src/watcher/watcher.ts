import { watch, type FSWatcher } from 'chokidar';
import * as path from 'node:path';
import { toRelativeKey } from '../drift/probe.js';

export type WatchEventKind = 'add' | 'change' | 'unlink';

export interface WatchEvent {
  /** Workspace-relative POSIX path. */
  path: string;
  kind: WatchEventKind;
}

/** Debounced trigger: each call reschedules `fn`. */
export type DebounceTrigger = () => void;
export type DebounceFactory = (fn: () => void, ms: number) => DebounceTrigger;

/** Default debounce on native timers; the adapter injects ctx.timer.debounce. */
export const defaultDebounceFactory: DebounceFactory = (fn, ms) => {
  let timer: NodeJS.Timeout | undefined;
  return () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      fn();
    }, ms);
  };
};

export interface WorkspaceWatcherOptions {
  root: string;
  /** Debounce window (design §5.3: 300ms). */
  debounceMs?: number;
  /** Matcher over workspace-relative POSIX paths (from createIgnoreMatcher). */
  ignored: (relPath: string) => boolean;
  /** Debounced batch callback; same-path events are merged to final state. */
  onBatch: (events: WatchEvent[]) => void;
  onError?: (error: unknown) => void;
  /** Injectable for tests / adapter ctx.timer wiring. */
  debounceFactory?: DebounceFactory;
  /** Skip chokidar's initial add storm (default true). */
  ignoreInitial?: boolean;
}

/**
 * chokidar wrapper for one workspace root (design §5.3). Symlinks are never
 * followed (E13). Events are debounced and merged per path — consecutive
 * changes to one file flush once with the final kind (E12):
 *   add → change = add · change → unlink = unlink · add → unlink = dropped
 *   unlink → add = change
 */
export class WorkspaceWatcher {
  private readonly options: WorkspaceWatcherOptions;
  private watcher: FSWatcher | undefined;
  private pending = new Map<string, WatchEventKind>();
  private flush: DebounceTrigger | undefined;

  constructor(options: WorkspaceWatcherOptions) {
    this.options = options;
  }

  start(): void {
    if (this.watcher) return;
    const debounceMs = this.options.debounceMs ?? 300;
    const factory = this.options.debounceFactory ?? defaultDebounceFactory;
    this.flush = factory(() => this.flushNow(), debounceMs);

    this.watcher = watch(this.options.root, {
      ignoreInitial: this.options.ignoreInitial ?? true,
      followSymlinks: false, // E13
      ignored: (absPath: string, stats) => {
        // Keep the root itself and all directories traversable unless the
        // matcher rejects them; chokidar prunes ignored dirs entirely.
        const rel = toRelativeKey(this.options.root, absPath);
        if (rel === null) return false;
        if (stats?.isFile() === false && rel !== '' && !this.options.ignored(rel)) return false;
        return this.options.ignored(rel);
      },
    });

    const record = (kind: WatchEventKind) => (absPath: string) => {
      try {
        const rel = toRelativeKey(this.options.root, absPath);
        if (rel === null || this.options.ignored(rel)) return;
        this.merge(rel, kind);
        this.flush?.();
      } catch (error) {
        this.options.onError?.(error);
      }
    };

    this.watcher.on('add', record('add'));
    this.watcher.on('change', record('change'));
    this.watcher.on('unlink', record('unlink'));
    this.watcher.on('error', (error) => this.options.onError?.(error));
  }

  private merge(rel: string, kind: WatchEventKind): void {
    const prev = this.pending.get(rel);
    let next: WatchEventKind | null = kind;
    if (prev === 'add' && kind === 'change') next = 'add';
    else if (prev === 'unlink' && kind === 'add') next = 'change';
    else if (prev === 'add' && kind === 'unlink') next = null; // transient file, net zero
    if (next === null) this.pending.delete(rel);
    else this.pending.set(rel, next);
  }

  private flushNow(): void {
    if (this.pending.size === 0) return;
    const events = [...this.pending.entries()].map(([p, kind]) => ({ path: p, kind }));
    this.pending.clear();
    try {
      this.options.onBatch(events);
    } catch (error) {
      this.options.onError?.(error);
    }
  }

  /** Test hook: force-deliver pending events without waiting for debounce. */
  flushPending(): void {
    this.flushNow();
  }

  async stop(): Promise<void> {
    this.pending.clear();
    const w = this.watcher;
    this.watcher = undefined;
    if (w) await w.close();
  }
}
