import type { DriftRecord } from './types.js';

/**
 * Per-agent pending-drift queue (design §4). Since every record is computed
 * as the net effect versus the AKB at reconcile time, a later record for the
 * same path simply replaces the earlier one — this is what collapses
 * repeated external edits into a single final-state report (E12).
 */
export class DriftQueue {
  private records = new Map<string, DriftRecord>();
  /** path → enqueue wall-clock, parallel to `records`. Delivery-time
   *  retirement (retireUpTo) needs this because revalidation returns
   *  refreshed COPIES — object identity cannot recognize them (Stop-channel
   *  replay loop, smoke test 2026-09-03). */
  private enqueuedAt = new Map<string, number>();
  /** Wall-clock of the most recent push — the daemon compares it against a
   *  rendered batch's stamp to decide whether an undelivered batch is stale
   *  and must be re-rendered (phase-2 smoke test, 2026-09-02). */
  private lastPush = 0;

  get size(): number {
    return this.records.size;
  }

  isEmpty(): boolean {
    return this.records.size === 0;
  }

  get lastPushAt(): number {
    return this.lastPush;
  }

  push(record: DriftRecord): void {
    if (record.kind === 'renamed' && record.fromPath !== undefined) {
      this.records.delete(record.fromPath);
      this.enqueuedAt.delete(record.fromPath);
    }
    this.records.delete(record.path);
    this.records.set(record.path, record);
    this.lastPush = Date.now();
    this.enqueuedAt.set(record.path, this.lastPush);
  }

  pushAll(records: DriftRecord[]): void {
    for (const r of records) this.push(r);
  }

  peek(): DriftRecord[] {
    return [...this.records.values()];
  }

  has(path: string): boolean {
    return this.records.has(path);
  }

  /**
   * Bump lastPushAt without a record. Watcher events that produce no record
   * can still invalidate a QUEUED fact (a queued create whose file was just
   * deleted) — the daemon's re-render gate keys on this stamp, so the stale
   * batch gets revalidated and retracted instead of delivered.
   */
  touch(): void {
    this.lastPush = Date.now();
  }

  /** Return all records in insertion order and clear the queue. */
  drain(): DriftRecord[] {
    const all = this.peek();
    this.records.clear();
    this.enqueuedAt.clear();
    return all;
  }

  /**
   * Sync-Point commit: remove exactly the rendered records, keeping any
   * record that was replaced (re-detected) after the render snapshot —
   * object identity guards the race between peek and commit (§5.5.2).
   * NOTE: only works with the ORIGINAL peeked objects; revalidation copies
   * require retireUpTo instead.
   */
  commitRendered(rendered: DriftRecord[]): void {
    for (const r of rendered) {
      if (this.records.get(r.path) === r) {
        this.records.delete(r.path);
        this.enqueuedAt.delete(r.path);
      }
    }
  }

  /**
   * Delivery-time commit (phase-2 daemon): retire every entry enqueued at or
   * before the rendered batch's stamp. Entries re-pushed AFTER the render
   * (newer drift for the same path) carry a later stamp and survive.
   */
  retireUpTo(stamp: number): void {
    for (const [path, at] of [...this.enqueuedAt]) {
      if (at <= stamp) {
        this.records.delete(path);
        this.enqueuedAt.delete(path);
      }
    }
  }

  clear(): void {
    this.records.clear();
    this.enqueuedAt.clear();
  }
}
