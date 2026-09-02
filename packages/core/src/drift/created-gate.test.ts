import { describe, it, expect } from 'vitest';
import { AgentKnowledgeBase } from '../baseline/akb.js';
import { makeCreatedFilter } from './created-gate.js';
import { reconcile } from './reconcile.js';
import type { TrackedStatus } from '../watcher/git.js';
import type { FileObservation } from './types.js';

function obs(path: string, overrides: Partial<FileObservation> = {}): FileObservation {
  return {
    path,
    exists: true,
    contentHash: 'h-new',
    content: Buffer.from('x'),
    mtimeMs: 2,
    size: 1,
    ...overrides,
  };
}

function statuses(entries: Record<string, TrackedStatus>): Map<string, TrackedStatus> {
  return new Map(Object.entries(entries) as [string, TrackedStatus][]);
}

describe('makeCreatedFilter (D7)', () => {
  it('returns no gate when includeUntracked is true', () => {
    expect(
      makeCreatedFilter(statuses({ 'a.ts': 'untracked' }), { includeUntracked: true }),
    ).toBeUndefined();
  });

  it('suppresses untracked creates, keeps tracked and unknown (E20)', () => {
    const filter = makeCreatedFilter(
      statuses({ 'junk.log': 'untracked', 'src/new.ts': 'tracked', 'other.ts': 'unknown' }),
      { includeUntracked: false },
    )!;
    expect(filter('junk.log')).toBe(false);
    expect(filter('src/new.ts')).toBe(true);
    expect(filter('other.ts')).toBe(true); // non-git → cannot distinguish → report
  });

  it('exempts window-predicted paths even when untracked (D8a)', () => {
    const filter = makeCreatedFilter(statuses({ 'out.gen.ts': 'untracked' }), {
      includeUntracked: false,
      predicted: (p) => p === 'out.gen.ts',
    })!;
    expect(filter('out.gen.ts')).toBe(true);
  });
});

describe('reconcile created gate', () => {
  it('drops created records rejected by the gate', () => {
    const akb = new AgentKnowledgeBase();
    const records = reconcile(akb, [obs('junk.log')], 1000, {
      createdFilter: makeCreatedFilter(statuses({ 'junk.log': 'untracked' }), {
        includeUntracked: false,
      }),
    });
    expect(records).toEqual([]);
  });

  it('a suppressed created cannot absorb a delete into renamed (delete stays, E5)', () => {
    const akb = new AgentKnowledgeBase();
    akb.set('old.ts', { contentHash: 'h1', mtimeMs: 1, size: 1, source: 'read', updatedAt: 1 });
    const records = reconcile(
      akb,
      [{ path: 'old.ts', exists: false }, obs('new.ts', { contentHash: 'h1' })],
      1000,
      { createdFilter: () => false },
    );
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ kind: 'deleted', path: 'old.ts' });
  });

  it('an allowed created still merges into renamed', () => {
    const akb = new AgentKnowledgeBase();
    akb.set('old.ts', { contentHash: 'h1', mtimeMs: 1, size: 1, source: 'read', updatedAt: 1 });
    const records = reconcile(
      akb,
      [{ path: 'old.ts', exists: false }, obs('new.ts', { contentHash: 'h1' })],
      1000,
      { createdFilter: () => true },
    );
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ kind: 'renamed', fromPath: 'old.ts', path: 'new.ts' });
  });
});
