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

  it('re-renders an undelivered batch to absorb later drift (smoke test 2026-09-02)', async () => {
    // Report §2.1: with the Sync Point at render time, an undelivered batch
    // froze at first render and every notification lagged one version. Now
    // the staged batch re-renders against the SAME (last-delivered) baseline.
    await fs.writeFile(path.join(ws, 'a.txt'), 'v1\n');
    await observe('a.txt', 'read');
    await fs.writeFile(path.join(ws, 'a.txt'), 'v2\n');
    await engine.handleWatchBatch([{ path: 'a.txt', kind: 'change' }]);
    const first = await readPending();
    expect(first?.text).toContain('+v2');

    await new Promise((r) => setTimeout(r, 5)); // keep queue stamps distinct
    await fs.writeFile(path.join(ws, 'a.txt'), 'v3\n');
    await engine.handleWatchBatch([{ path: 'a.txt', kind: 'change' }]);
    const second = await readPending();
    expect(second?.batchId).not.toBe(first?.batchId); // re-rendered in place
    expect(second?.text).toContain('+v3');
    expect(second?.text).not.toContain('+v2'); // merged: no intermediate state

    // Delivery commits the merged batch; the queue is empty → no re-render.
    await consumePending();
    await engine.renderSession('s1');
    expect(engine.sessions.get('s1')!.queue.size).toBe(0); // retired on delivery
    const third = await readPending();
    expect(third?.batchId).toBe(second?.batchId);
    // …and the AKB baseline advanced to the delivered (v3) state.
    await new Promise((r) => setTimeout(r, 5));
    await fs.writeFile(path.join(ws, 'a.txt'), 'v4\n');
    await engine.handleWatchBatch([{ path: 'a.txt', kind: 'change' }]);
    const fourth = await readPending();
    expect(fourth?.text).toContain('+v4');
    expect(fourth?.text).not.toContain('+v3'); // v3 was the committed baseline
  });

  it('merges accumulated edits into the undelivered batch (smoke-test regression)', async () => {
    // Reproduces the 2026-09-02 smoke-test bug directly: edit A renders,
    // edit B lands while the batch is undelivered. Old behavior: batch A
    // froze (only '-l2'), edit B waited for a post-delivery render and the
    // intermediate batch was silently merged away. New: ONE merged batch.
    await fs.writeFile(path.join(ws, 'a.txt'), 'l1\nl2\nl3\n');
    await observe('a.txt', 'read');

    await fs.writeFile(path.join(ws, 'a.txt'), 'l1\nl3\n'); // edit A
    await engine.handleWatchBatch([{ path: 'a.txt', kind: 'change' }]);
    const batchA = await readPending();
    expect(batchA?.text).toContain('-l2');

    await new Promise((r) => setTimeout(r, 5));
    await fs.writeFile(path.join(ws, 'a.txt'), 'l1\nl3\nn1\nn2\nn3\nn4\nn5\n'); // edit B
    await engine.handleWatchBatch([{ path: 'a.txt', kind: 'change' }]);
    const merged = await readPending();
    expect(merged?.batchId).not.toBe(batchA?.batchId);
    expect(merged?.text).toContain('-l2'); // edit A still present
    expect(merged?.text).toContain('+n5'); // edit B absorbed into the batch
  });

  it('delivery retires the queue — no Stop-channel replay loop (smoke 2026-09-03)', async () => {
    // Reproduces the infinite replay: revalidateRecords returns refreshed
    // COPIES, so identity-based retirement no-op'd and the delivered batch
    // re-rendered (deliveredVia reset) after every commit.
    await fs.writeFile(path.join(ws, 'r.txt'), 'v1\n');
    await observe('r.txt', 'read');
    await fs.rename(path.join(ws, 'r.txt'), path.join(ws, 'r2.txt'));
    await engine.handleWatchBatch([
      { path: 'r.txt', kind: 'unlink' },
      { path: 'r2.txt', kind: 'add' },
    ]);
    const p = await readPending();
    expect(p?.priority).toBe('high');

    // The Stop hook delivers, then the poll tick observes it: the queue MUST
    // empty and the pending file MUST NOT be re-rendered.
    const delivered = await readPending();
    delivered!.deliveredVia.push('stop');
    await fs.writeFile(pendingFile(hash, 's1'), JSON.stringify(delivered));
    await engine.renderSession('s1');
    expect(engine.sessions.get('s1')!.queue.size).toBe(0);
    const after = await readPending();
    expect(after?.batchId).toBe(p!.batchId); // no re-render
    expect(after?.deliveredVia).toEqual(['stop']); // still marked delivered
  });

  it('retracts an undelivered batch whose facts all went stale (report §2.3)', async () => {
    // Create → quick delete before delivery: the staged CREATE must not be
    // delivered for a file that no longer exists.
    await fs.writeFile(path.join(ws, 'gone.txt'), 'x\n');
    await engine.handleWatchBatch([{ path: 'gone.txt', kind: 'add' }]);
    expect((await readPending())?.text).toContain('gone.txt');

    await new Promise((r) => setTimeout(r, 5));
    await fs.rm(path.join(ws, 'gone.txt'));
    await engine.handleWatchBatch([{ path: 'gone.txt', kind: 'unlink' }]);
    expect(await readPending()).toBeUndefined();
  });

  it('create → rename before delivery reports only the final name (report §2.3)', async () => {
    await fs.writeFile(path.join(ws, 'new.txt'), 'hello\n');
    await engine.handleWatchBatch([{ path: 'new.txt', kind: 'add' }]);
    const created = await readPending();
    expect(created?.text).toContain('new.txt');

    await new Promise((r) => setTimeout(r, 5));
    await fs.rename(path.join(ws, 'new.txt'), path.join(ws, 'final.txt'));
    await engine.handleWatchBatch([
      { path: 'new.txt', kind: 'unlink' },
      { path: 'final.txt', kind: 'add' },
    ]);
    const p = await readPending();
    expect(p?.batchId).not.toBe(created?.batchId);
    expect(p?.text).toContain('final.txt');
    expect(p?.text).not.toContain('new.txt'); // intermediate name never surfaces
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
