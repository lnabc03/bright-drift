import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkTmp } from '../testkit.js';
import { readJsonFile } from '../shared/atomic.js';
import { pendingFile, wsHash } from '../shared/paths.js';
import type { PendingInjection } from '../shared/schema.js';
import { WorkspaceEngine } from './engine.js';

/**
 * Engine pipeline tests (M5): watcher batches are driven directly through
 * handleWatchBatch so no real chokidar timing is involved. A real tmp
 * workspace backs every probe/diff.
 */

let stateHome: string;
let ws: string;
let hash: string;
let engine: WorkspaceEngine;

beforeEach(async () => {
  stateHome = await mkTmp('bd-engine-state-');
  ws = await mkTmp('bd-engine-ws-');
  process.env.BRIGHT_DRIFT_STATE_HOME = stateHome;
  hash = await wsHash(ws);
  engine = new WorkspaceEngine(hash, ws);
  await engine.start();
  await engine.handleRegister('s1');
});

afterEach(async () => {
  await engine.stop();
  delete process.env.BRIGHT_DRIFT_STATE_HOME;
  await fs.rm(stateHome, { recursive: true, force: true });
  await fs.rm(ws, { recursive: true, force: true });
});

async function observe(file: string, action: 'read' | 'write'): Promise<void> {
  await engine.handle({
    type: 'akb.observe',
    sessionId: 's1',
    tool: action === 'read' ? 'Read' : 'Edit',
    filePath: path.join(ws, file),
    action,
  });
}

async function readPending(): Promise<PendingInjection | undefined> {
  return readJsonFile<PendingInjection>(pendingFile(hash, 's1'));
}

/** Mark the current pending batch delivered so the next one may render. */
async function consumePending(): Promise<void> {
  const p = await readPending();
  if (p) {
    p.deliveredVia.push('user-prompt-submit');
    await fs.writeFile(pendingFile(hash, 's1'), JSON.stringify(p));
  }
}

describe('drift pipeline (P2-T1/T2 at engine level)', () => {
  it('external modification renders an EXTERNAL·MODIFIED pending with a diff', async () => {
    await fs.writeFile(path.join(ws, 'a.txt'), 'line1\nline2\n');
    await observe('a.txt', 'read');

    await fs.writeFile(path.join(ws, 'a.txt'), 'line1\nline2 CHANGED\nline3\n');
    await engine.handleWatchBatch([{ path: 'a.txt', kind: 'change' }]);

    const p = await readPending();
    expect(p).toBeDefined();
    expect(p!.priority).toBe('normal');
    expect(p!.text).toContain('EXTERNAL·MODIFIED');
    expect(p!.text).toContain('a.txt');
    expect(p!.text).toContain('+line2 CHANGED'); // line-level diff (FR-3)
    expect(p!.text).not.toMatch(/\d{4}-\d{2}-\d{2}/); // no absolute timestamps (E7)
  });

  it('echo suppression: agent writes produce no drift (P2-T2)', async () => {
    await fs.writeFile(path.join(ws, 'a.txt'), 'v1\n');
    await observe('a.txt', 'read');

    // Agent edits the file; the observe updates the baseline first.
    await fs.writeFile(path.join(ws, 'a.txt'), 'v2\n');
    await observe('a.txt', 'write');
    await engine.handleWatchBatch([{ path: 'a.txt', kind: 'change' }]);

    expect(await readPending()).toBeUndefined();
  });

  it('deletion of an AKB-tracked file renders priority high (P2-D6)', async () => {
    await fs.writeFile(path.join(ws, 'victim.txt'), 'gone soon\n');
    await observe('victim.txt', 'read');
    await fs.rm(path.join(ws, 'victim.txt'));
    await engine.handleWatchBatch([{ path: 'victim.txt', kind: 'unlink' }]);

    const p = await readPending();
    expect(p?.priority).toBe('high');
    expect(p?.text).toContain('DELETED');
    expect(p?.text).toContain('victim.txt');
  });

  it('command side effect attributes to category B via predicted paths (P2-T3)', async () => {
    await fs.writeFile(path.join(ws, 'gen.out'), 'old\n');
    await observe('gen.out', 'read');

    await engine.handle({
      type: 'window.open',
      sessionId: 's1',
      toolUseId: 'call-1',
      command: 'python gen.py > gen.out',
      openedAt: Date.now(),
      preSnapshot: [
        { path: path.join(ws, 'gen.out'), mtimeMs: (await fs.stat(path.join(ws, 'gen.out'))).mtimeMs, size: 4, exists: true },
      ],
      predictedPaths: ['gen.out'],
    });
    await fs.writeFile(path.join(ws, 'gen.out'), 'new output\n');
    await engine.handleWatchBatch([{ path: 'gen.out', kind: 'change' }]);
    await engine.handle({ type: 'window.close', sessionId: 's1', toolUseId: 'call-1', closedAt: Date.now() });

    const p = await readPending();
    expect(p?.text).toContain('COMMAND-SIDE-EFFECT');
    expect(p?.text).toContain('python gen.py');
  });

  it('window.open without toolUseId still opens an attributor window', async () => {
    await engine.handle({
      type: 'window.open',
      sessionId: 's1',
      command: 'make all',
      openedAt: Date.now(),
    });
    const state = engine.sessions.get('s1')!;
    const windows = state.attributor.toJSON().windows;
    expect(windows).toHaveLength(1);
    expect(windows[0]!.command).toBe('make all');
  });

  it('does not overwrite an undelivered pending batch', async () => {
    await fs.writeFile(path.join(ws, 'a.txt'), 'v1\n');
    await observe('a.txt', 'read');
    await fs.writeFile(path.join(ws, 'a.txt'), 'v2\n');
    await engine.handleWatchBatch([{ path: 'a.txt', kind: 'change' }]);
    const first = await readPending();

    await fs.writeFile(path.join(ws, 'a.txt'), 'v3\n');
    await engine.handleWatchBatch([{ path: 'a.txt', kind: 'change' }]);
    const second = await readPending();
    expect(second?.batchId).toBe(first?.batchId); // unchanged until delivered

    // After delivery the accumulated drift renders as a fresh batch.
    await consumePending();
    await engine.renderSession('s1');
    const third = await readPending();
    expect(third?.batchId).not.toBe(first?.batchId);
  });

  it('accumulated edits render as ONE complete diff after delivery (smoke-test regression)', async () => {
    // Reproduces the 2026-09-02 smoke-test bug: edit A renders batch 1, edit B
    // lands while batch 1 is undelivered, and nothing re-renders after
    // delivery — edit B was silently lost.
    await fs.writeFile(path.join(ws, 'a.txt'), 'l1\nl2\nl3\n');
    await observe('a.txt', 'read');

    // Edit A (deletes a line) → rendered immediately.
    await fs.writeFile(path.join(ws, 'a.txt'), 'l1\nl3\n');
    await engine.handleWatchBatch([{ path: 'a.txt', kind: 'change' }]);
    const batchA = await readPending();
    expect(batchA?.text).toContain('-l2');

    // Edit B (adds five lines) while batch A is still undelivered → queued.
    await fs.writeFile(path.join(ws, 'a.txt'), 'l1\nl3\nn1\nn2\nn3\nn4\nn5\n');
    await engine.handleWatchBatch([{ path: 'a.txt', kind: 'change' }]);
    expect((await readPending())?.batchId).toBe(batchA?.batchId); // not overwritten

    // Delivery of batch A must unblock the accumulated drift: the daemon's
    // poll tick calls renderAll, producing batch B with the FULL diff
    // (baseline = last delivered state, current disk content).
    await consumePending();
    await engine.renderSession('s1'); // what the daemon poll loop does
    const batchB = await readPending();
    expect(batchB?.batchId).not.toBe(batchA?.batchId);
    expect(batchB?.text).toContain('+n5'); // edit B present
    expect(batchB?.text).not.toContain('-l2'); // edit A NOT repeated (already delivered)
  });
});

describe('char red line (P2-T8, E4)', () => {
  it('collapses an oversized batch to a one-line summary ≤ 9,500 chars', async () => {
    // Loosen the token budget so the char cap is what bites.
    await fs.writeFile(
      path.join(stateHome, 'config.yml'),
      ['budget:', '  maxInjectTokens: 1000000', '  maxTotalDiffLines: 1000000', '  maxDiffLinesPerFile: 500', '  maxDriftFilesForDiff: 500'].join('\n'),
    );
    await engine.pollConfig();

    const line = 'x'.repeat(40);
    for (let i = 0; i < 8; i++) {
      const name = `big${i}.txt`;
      await fs.writeFile(path.join(ws, name), `${line}\n`);
      await observe(name, 'read');
      const body = Array.from({ length: 400 }, (_, j) => `${line}${j}`).join('\n');
      await fs.writeFile(path.join(ws, name), body);
    }
    await engine.handleWatchBatch(
      Array.from({ length: 8 }, (_, i) => ({ path: `big${i}.txt`, kind: 'change' as const })),
    );

    const p = await readPending();
    expect(p).toBeDefined();
    expect(p!.text.length).toBeLessThanOrEqual(9500);
    expect(p!.text).toContain('折叠'); // whole batch collapsed to the summary line
  }, 20_000);
});

describe('config gating', () => {
  it('enabled:false stops probing entirely', async () => {
    await fs.writeFile(path.join(stateHome, 'config.yml'), 'enabled: false\n');
    await engine.pollConfig();

    await fs.writeFile(path.join(ws, 'a.txt'), 'v1\n');
    await observe('a.txt', 'read');
    await fs.writeFile(path.join(ws, 'a.txt'), 'v2\n');
    await engine.handleWatchBatch([{ path: 'a.txt', kind: 'change' }]);
    expect(await readPending()).toBeUndefined();
  });

  it('diff.blacklist suppresses the diff but keeps the notice (D9)', async () => {
    await fs.writeFile(path.join(stateHome, 'config.yml'), 'diff:\n  blacklist:\n    - "*.secret"\n');
    await engine.pollConfig();

    await fs.writeFile(path.join(ws, 'k.secret'), 'a\n');
    await observe('k.secret', 'read');
    await fs.writeFile(path.join(ws, 'k.secret'), 'b\n');
    await engine.handleWatchBatch([{ path: 'k.secret', kind: 'change' }]);

    const p = await readPending();
    expect(p?.text).toContain('k.secret');
    expect(p?.text).toContain('diff 已被 diff.blacklist 抑制');
  });
});
