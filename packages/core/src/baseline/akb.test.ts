import { describe, it, expect } from 'vitest';
import { AgentKnowledgeBase } from './akb.js';
import type { AKBEntry } from './types.js';

function entry(overrides: Partial<AKBEntry> = {}): AKBEntry {
  return {
    contentHash: 'h',
    mtimeMs: 1,
    size: 10,
    source: 'read',
    updatedAt: 1,
    ...overrides,
  };
}

describe('AgentKnowledgeBase', () => {
  it('set/get/delete basics', () => {
    const akb = new AgentKnowledgeBase();
    akb.set('a.ts', entry({ contentHash: 'h1' }));
    expect(akb.get('a.ts')?.contentHash).toBe('h1');
    expect(akb.size).toBe(1);
    akb.delete('a.ts');
    expect(akb.has('a.ts')).toBe(false);
  });

  it('evicts the oldest-updated entry beyond maxEntries (FR-1.4)', () => {
    const akb = new AgentKnowledgeBase({ maxEntries: 2 });
    akb.set('old.ts', entry({ updatedAt: 1 }));
    akb.set('mid.ts', entry({ updatedAt: 2 }));
    akb.set('new.ts', entry({ updatedAt: 3 }));
    expect(akb.has('old.ts')).toBe(false);
    expect(akb.has('mid.ts')).toBe(true);
    expect(akb.has('new.ts')).toBe(true);
    expect(akb.size).toBe(2);
  });

  it('setMaxEntries shrinks capacity and evicts immediately (settings hot-update)', () => {
    const akb = new AgentKnowledgeBase({ maxEntries: 10 });
    akb.set('a.ts', entry({ updatedAt: 1 }));
    akb.set('b.ts', entry({ updatedAt: 2 }));
    akb.set('c.ts', entry({ updatedAt: 3 }));
    akb.setMaxEntries(2);
    expect(akb.size).toBe(2);
    expect(akb.has('a.ts')).toBe(false); // oldest evicted
    expect(akb.has('b.ts')).toBe(true);
    expect(akb.has('c.ts')).toBe(true);
  });

  it('markKnownDeleted keeps the entry', () => {
    const akb = new AgentKnowledgeBase();
    akb.set('a.ts', entry());
    akb.markKnownDeleted('a.ts', 5);
    expect(akb.get('a.ts')?.knownDeleted).toBe(true);
    expect(akb.has('a.ts')).toBe(true);
  });

  it('snapshot roundtrip preserves entries (C5 sessionId-keyed)', () => {
    const akb = new AgentKnowledgeBase();
    akb.set('a.ts', entry({ contentHash: 'h1', contentRef: 'h1', partial: true }));
    const snap = akb.toSnapshot('session-1', 100);
    expect(snap.sessionId).toBe('session-1');
    const restored = AgentKnowledgeBase.fromSnapshot(snap);
    expect(restored.get('a.ts')).toEqual(akb.get('a.ts'));
  });

  it('rejects unknown snapshot versions', () => {
    expect(() =>
      AgentKnowledgeBase.fromSnapshot({ version: 99, sessionId: 's', savedAt: 0, entries: {} } as never),
    ).toThrow();
  });
});
