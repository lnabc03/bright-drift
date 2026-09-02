import { describe, it, expect } from 'vitest';
import { AgentKnowledgeBase } from '../baseline/akb.js';
import { reconcile } from './reconcile.js';
import type { AKBEntry } from '../baseline/types.js';
import type { FileObservation } from './types.js';

const NOW = 1000;

function akbWith(path: string, overrides: Partial<AKBEntry> = {}): AgentKnowledgeBase {
  const akb = new AgentKnowledgeBase();
  akb.set(path, {
    contentHash: 'hash-baseline',
    mtimeMs: 1,
    size: 10,
    source: 'read',
    updatedAt: 1,
    ...overrides,
  });
  return akb;
}

function obs(path: string, overrides: Partial<FileObservation> = {}): FileObservation {
  return {
    path,
    exists: true,
    contentHash: 'hash-new',
    content: Buffer.from('new content'),
    mtimeMs: 2,
    size: 11,
    ...overrides,
  };
}

describe('reconcile', () => {
  it('E1: drops echo events (hash matches baseline)', () => {
    const akb = akbWith('a.ts');
    const records = reconcile(akb, [obs('a.ts', { contentHash: 'hash-baseline' })], NOW);
    expect(records).toEqual([]);
  });

  it('E2: modified when hash differs, with content availability for line diff', () => {
    const akb = akbWith('a.ts', { contentRef: 'hash-baseline' });
    const [r] = reconcile(akb, [obs('a.ts')], NOW);
    expect(r).toMatchObject({ kind: 'modified', path: 'a.ts', contentAvailable: true });
  });

  it('E3: deleted when a tracked file goes missing', () => {
    const akb = akbWith('a.ts');
    const [r] = reconcile(akb, [obs('a.ts', { exists: false })], NOW);
    expect(r).toMatchObject({ kind: 'deleted', path: 'a.ts' });
  });

  it('ignores missing files the AKB never tracked', () => {
    const akb = new AgentKnowledgeBase();
    expect(reconcile(akb, [obs('ghost.ts', { exists: false })], NOW)).toEqual([]);
  });

  it('E4: delete+recreate with different content nets to modified', () => {
    const akb = akbWith('a.ts', { knownDeleted: true, contentRef: 'hash-baseline' });
    const [r] = reconcile(akb, [obs('a.ts')], NOW);
    expect(r).toMatchObject({ kind: 'modified' });
  });

  it('E4: delete+recreate with identical content nets to nothing', () => {
    const akb = akbWith('a.ts', { knownDeleted: true });
    expect(reconcile(akb, [obs('a.ts', { contentHash: 'hash-baseline' })], NOW)).toEqual([]);
  });

  it('created for files unknown to the AKB', () => {
    const akb = new AgentKnowledgeBase();
    const [r] = reconcile(akb, [obs('new.ts')], NOW);
    expect(r).toMatchObject({ kind: 'created', contentAvailable: false });
  });

  it('E5: deleted + created with same hash merges into renamed', () => {
    const akb = akbWith('old.ts');
    const records = reconcile(
      akb,
      [
        obs('old.ts', { exists: false, contentHash: 'hash-baseline' }),
        obs('new.ts', { contentHash: 'hash-baseline' }),
      ],
      NOW,
    );
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ kind: 'renamed', fromPath: 'old.ts', path: 'new.ts' });
  });

  it('E5: different hashes do NOT merge into renamed', () => {
    const akb = akbWith('old.ts');
    const records = reconcile(
      akb,
      [obs('old.ts', { exists: false }), obs('new.ts', { contentHash: 'other' })],
      NOW,
    );
    expect(records.map((r) => r.kind).sort()).toEqual(['created', 'deleted']);
  });

  it('E8: partial-read baselines degrade to file-level (no content diff)', () => {
    const akb = akbWith('a.ts', { partial: true, contentRef: 'hash-baseline' });
    const [r] = reconcile(akb, [obs('a.ts')], NOW);
    expect(r).toMatchObject({ kind: 'modified', contentAvailable: false });
  });

  it('E18: evicted content copy (no contentRef) degrades to file-level', () => {
    const akb = akbWith('a.ts'); // no contentRef
    const [r] = reconcile(akb, [obs('a.ts')], NOW);
    expect(r).toMatchObject({ kind: 'modified', contentAvailable: false });
  });

  it('binary and oversized files are file-level only', () => {
    const akb = akbWith('a.ts', { contentRef: 'hash-baseline' });
    const [r1] = reconcile(akb, [obs('a.ts', { binary: true })], NOW);
    expect(r1!.contentAvailable).toBe(false);
    const [r2] = reconcile(akb, [obs('a.ts', { tooLarge: true })], NOW);
    expect(r2!.contentAvailable).toBe(false);
  });

  it('D9: hash-only probe yields file-level modified with the diffSuppressed marker', () => {
    const akb = akbWith('secret.env', { contentRef: 'hash-baseline' });
    const [r] = reconcile(
      akb,
      [obs('secret.env', { content: undefined, contentSuppressed: true })],
      NOW,
    );
    expect(r).toMatchObject({ kind: 'modified', contentAvailable: false, diffSuppressed: true });
  });
});
