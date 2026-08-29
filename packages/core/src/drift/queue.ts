import type { DriftRecord } from './types.js';

/**
 * Per-agent pending-drift queue (design §4). Since every record is computed
 * as the net effect versus the AKB at reconcile time, a later record for the
 * same path simply replaces the earlier one — this is what collapses
 * repeated external edits into a single final-state report (E12).
 */
export class DriftQueue {
  private records = new Map<string, DriftRecord>();

  get size(): number {
    return this.records.size;
  }

  isEmpty(): boolean {
    return this.records.size === 0;
  }

  push(record: DriftRecord): void {
    if (record.kind === 'renamed' && record.fromPath !== undefined) {
      this.records.delete(record.fromPath);
    }
    this.records.delete(record.path);
    this.records.set(record.path, record);
  }

  pushAll(records: DriftRecord[]): void {
    for (const r of records) this.push(r);
  }

  peek(): DriftRecord[] {
    return [...this.records.values()];
  }

  /** Return all records in insertion order and clear the queue. */
  drain(): DriftRecord[] {
    const all = this.peek();
    this.records.clear();
    return all;
  }

  /**
   * Sync-Point commit: remove exactly the rendered records, keeping any
   * record that was replaced (re-detected) after the render snapshot —
   * object identity guards the race between peek and commit (§5.5.2).
   */
  commitRendered(rendered: DriftRecord[]): void {
    for (const r of rendered) {
      if (this.records.get(r.path) === r) this.records.delete(r.path);
    }
  }

  clear(): void {
    this.records.clear();
  }
}
