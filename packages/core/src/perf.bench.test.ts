import { describe, it, expect } from 'vitest';
import { AgentKnowledgeBase } from './baseline/akb.js';
import { reconcile, type ProbeObservation } from './drift/reconcile.js';
import { Attributor } from './attribution/attributor.js';
import { shouldInjectAtPreStep } from './sync/policy.js';
import { sha1 } from './baseline/hash.js';

/**
 * Performance gates (AGENTS.md 搂3.3 / PRD R5):
 * - reconcile at 100k tracked entries must stay comfortably under one second
 * - the pre-step early-exit decision must be far below 1ms
 * - FR-7 attribution classification must be far below 50ms per event
 */

function fakeContent(seed: number): string {
  return `// file ${seed}\nexport const value = ${seed};\n`;
}

describe('performance gates', () => {
  it('reconcile: 100k tracked files, 1% drift, completes in < 1s', () => {
    const akb = new AgentKnowledgeBase({ maxEntries: 200_000 });
    const N = 100_000;
    const now = Date.now();
    const observations: ProbeObservation[] = [];
    for (let i = 0; i < N; i++) {
      const p = `src/mod-${i % 100}/file-${i}.ts`;
      const hash = sha1(fakeContent(i));
      akb.set(p, { contentHash: hash, mtimeMs: now, size: 40, source: 'read', updatedAt: now });
      // 1% of files drift on disk
      const drifted = i % 100 === 0;
      observations.push({
        path: p,
        exists: true,
        contentHash: drifted ? sha1(fakeContent(i + N)) : hash,
        mtimeMs: drifted ? now + 1000 : now,
        size: 40,
      });
    }

    const t0 = performance.now();
    const records = reconcile(akb, observations, now + 1000);
    const elapsed = performance.now() - t0;

    expect(records).toHaveLength(N / 100);
    expect(elapsed).toBeLessThan(1000);
    console.log(`reconcile 100k entries / 1k drift: ${elapsed.toFixed(1)}ms`);
  });

  it('pre-step early-exit decision: < 0.01ms per call (100k iterations < 1ms total budget x100 headroom)', () => {
    const t0 = performance.now();
    for (let i = 0; i < 100_000; i++) {
      shouldInjectAtPreStep({ batchEmpty: i % 2 === 0, toolsRanSinceLastStep: i % 3 === 0 });
    }
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(100); // 100k calls in <100ms 鈬?<1碌s/call, gate is <1ms
    console.log(`pre-step decision x100k: ${elapsed.toFixed(1)}ms (${(elapsed / 100).toFixed(3)}碌s/call)`);
  });

  it('FR-7 attribution classify: < 0.05ms per call (50碌s, gate is 50ms per snapshot)', () => {
    const attributor = new Attributor();
    const base = Date.now();
    attributor.openWindow({
      id: 'w1',
      shell: 'bash',
      command: 'npm run build',
      background: false,
      openedAt: base,
      preSnapshot: {},
      predictedPaths: [],
    });
    const t0 = performance.now();
    for (let i = 0; i < 10_000; i++) {
      attributor.classify(base + 100 + i);
    }
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(100); // 10k calls in <100ms 鈬?<10碌s/call, gate is 50ms
    console.log(`attribution classify x10k (1 open window): ${elapsed.toFixed(1)}ms`);
  });

  it('AKB snapshot round-trip at 100k entries stays under 1s', () => {
    const akb = new AgentKnowledgeBase({ maxEntries: 200_000 });
    const now = Date.now();
    for (let i = 0; i < 100_000; i++) {
      akb.set(`f${i}.ts`, { contentHash: sha1(`x${i}`), mtimeMs: now, size: 10, source: 'read', updatedAt: now });
    }
    const t0 = performance.now();
    const snap = akb.toSnapshot('bench', now);
    const json = JSON.stringify(snap);
    const restored = AgentKnowledgeBase.fromSnapshot(JSON.parse(json));
    const elapsed = performance.now() - t0;
    expect(restored.size).toBe(100_000);
    expect(elapsed).toBeLessThan(1000);
    console.log(`AKB snapshot round-trip 100k: ${elapsed.toFixed(1)}ms, json ${(json.length / 1024 / 1024).toFixed(1)}MB`);
  });
});
