import type { AKBEntry, AKBSnapshot, AKBOptions } from './types.js';
import { DEFAULT_MAX_ENTRIES } from './types.js';

/**
 * In-memory AKB for one agent session. Paths are workspace-relative,
 * POSIX-normalized (`/` separators) — normalization happens at the
 * watcher/observation boundary, not here.
 */
export class AgentKnowledgeBase {
  private entries = new Map<string, AKBEntry>();
  private readonly maxEntries: number;

  constructor(options: AKBOptions = {}) {
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  }

  get size(): number {
    return this.entries.size;
  }

  get(path: string): AKBEntry | undefined {
    return this.entries.get(path);
  }

  has(path: string): boolean {
    return this.entries.has(path);
  }

  /** Insert or replace; enforces LRU-ish eviction by oldest `updatedAt` (FR-1.4). */
  set(path: string, entry: AKBEntry): void {
    this.entries.delete(path); // refresh insertion order
    this.entries.set(path, entry);
    while (this.entries.size > this.maxEntries) {
      let oldestPath: string | undefined;
      let oldestAt = Number.POSITIVE_INFINITY;
      for (const [p, e] of this.entries) {
        if (e.updatedAt < oldestAt) {
          oldestAt = e.updatedAt;
          oldestPath = p;
        }
      }
      if (oldestPath === undefined) break;
      this.entries.delete(oldestPath);
    }
  }

  delete(path: string): boolean {
    return this.entries.delete(path);
  }

  markKnownDeleted(path: string, at: number): void {
    const entry = this.entries.get(path);
    if (entry) entry.knownDeleted = true;
    void at;
  }

  /** Paths whose baseline content hash should be compared during reconciliation. */
  trackedPaths(): string[] {
    return [...this.entries.keys()];
  }

  [Symbol.iterator](): IterableIterator<[string, AKBEntry]> {
    return this.entries[Symbol.iterator]();
  }

  toSnapshot(sessionId: string, savedAt: number): AKBSnapshot {
    return {
      version: 1,
      sessionId,
      savedAt,
      entries: Object.fromEntries(this.entries),
    };
  }

  /** Restore from a persisted snapshot; unknown versions throw (callers fail-open). */
  static fromSnapshot(snapshot: AKBSnapshot, options: AKBOptions = {}): AgentKnowledgeBase {
    if (snapshot.version !== 1) throw new Error(`unsupported AKB snapshot version: ${snapshot.version}`);
    const akb = new AgentKnowledgeBase(options);
    for (const [path, entry] of Object.entries(snapshot.entries)) {
      akb.entries.set(path, { ...entry });
    }
    return akb;
  }
}
