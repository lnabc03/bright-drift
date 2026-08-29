import { describe, it, expect } from 'vitest';
import { DriftQueue } from './queue.js';
import type { DriftRecord } from './types.js';

function record(path: string, kind: DriftRecord['kind'], extra: Partial<DriftRecord> = {}): DriftRecord {
  return { path, kind, contentAvailable: false, at: 1, ...extra };
}

describe('DriftQueue', () => {
  it('E12: repeated modifications of one file collapse to the final record', () => {
    const q = new DriftQueue();
    q.push(record('a.ts', 'modified', { at: 1 }));
    q.push(record('a.ts', 'modified', { at: 2 }));
    q.push(record('a.ts', 'modified', { at: 3 }));
    expect(q.size).toBe(1);
    expect(q.drain()[0]!.at).toBe(3);
    expect(q.isEmpty()).toBe(true);
  });

  it('later kinds replace earlier ones (modified → deleted)', () => {
    const q = new DriftQueue();
    q.push(record('a.ts', 'modified'));
    q.push(record('a.ts', 'deleted'));
    expect(q.drain().map((r) => r.kind)).toEqual(['deleted']);
  });

  it('renamed records evict stale entries for both paths', () => {
    const q = new DriftQueue();
    q.push(record('old.ts', 'deleted'));
    q.push(record('new.ts', 'renamed', { fromPath: 'old.ts' }));
    const all = q.drain();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ kind: 'renamed', fromPath: 'old.ts', path: 'new.ts' });
  });

  it('peek does not drain', () => {
    const q = new DriftQueue();
    q.push(record('a.ts', 'modified'));
    expect(q.peek()).toHaveLength(1);
    expect(q.size).toBe(1);
  });

  it('commitRendered removes rendered records but keeps re-detected ones (sync-point race)', () => {
    const q = new DriftQueue();
    q.push(record('a.ts', 'modified', { at: 1 }));
    q.push(record('b.ts', 'modified', { at: 1 }));
    const rendered = q.peek();
    // A newer drift for a.ts lands between peek and commit.
    q.push(record('a.ts', 'modified', { at: 2 }));
    q.commitRendered(rendered);
    const rest = q.peek();
    expect(rest).toHaveLength(1);
    expect(rest[0]).toMatchObject({ path: 'a.ts', at: 2 });
  });

  it('commitRendered of everything empties the queue', () => {
    const q = new DriftQueue();
    q.push(record('a.ts', 'modified'));
    q.commitRendered(q.peek());
    expect(q.isEmpty()).toBe(true);
  });
});
