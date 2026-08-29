import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { WorkspaceWatcher, type WatchEvent } from './watcher.js';
import { createIgnoreMatcher } from './ignore.js';

let dir: string;
let watcher: WorkspaceWatcher | undefined;
let batches: WatchEvent[][];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitForBatch(timeoutMs = 5000): Promise<WatchEvent[]> {
  const start = Date.now();
  while (batches.length === 0) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for watch batch');
    await sleep(25);
  }
  return batches.shift()!;
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(tmpdir(), 'bright-drift-watch-'));
  batches = [];
});

afterEach(async () => {
  await watcher?.stop();
  watcher = undefined;
  await fs.rm(dir, { recursive: true, force: true });
});

async function startWatcher(ignored?: (rel: string) => boolean): Promise<void> {
  watcher = new WorkspaceWatcher({
    root: dir,
    debounceMs: 50,
    ignored: ignored ?? (await createIgnoreMatcher(dir)),
    onBatch: (events) => batches.push(events),
  });
  watcher.start();
  await sleep(150); // let chokidar settle
}

describe('WorkspaceWatcher (real chokidar, tmp dir)', () => {
  it('emits add for a new file', async () => {
    await startWatcher();
    await fs.writeFile(path.join(dir, 'a.txt'), 'hello');
    const batch = await waitForBatch();
    expect(batch).toContainEqual({ path: 'a.txt', kind: 'add' });
  });

  it('E12: rapid consecutive writes merge into one debounced change', async () => {
    await fs.writeFile(path.join(dir, 'a.txt'), 'v0');
    await startWatcher();
    await fs.writeFile(path.join(dir, 'a.txt'), 'v1');
    await fs.writeFile(path.join(dir, 'a.txt'), 'v2');
    await fs.writeFile(path.join(dir, 'a.txt'), 'v3');
    const batch = await waitForBatch();
    const forA = batch.filter((e) => e.path === 'a.txt');
    expect(forA).toHaveLength(1);
    expect(['change', 'add']).toContain(forA[0]!.kind);
    expect(await fs.readFile(path.join(dir, 'a.txt'), 'utf8')).toBe('v3');
  });

  it('ignores built-in table entries (node_modules)', async () => {
    await startWatcher();
    await fs.mkdir(path.join(dir, 'node_modules', 'pkg'), { recursive: true });
    await fs.writeFile(path.join(dir, 'node_modules', 'pkg', 'x.js'), 'x');
    await fs.writeFile(path.join(dir, 'real.txt'), 'r');
    const batch = await waitForBatch();
    expect(batch).toContainEqual({ path: 'real.txt', kind: 'add' });
    expect(batch.some((e) => e.path.includes('node_modules'))).toBe(false);
  });

  it('unlink events are delivered', async () => {
    await fs.writeFile(path.join(dir, 'gone.txt'), 'x');
    await startWatcher();
    await fs.rm(path.join(dir, 'gone.txt'));
    const batch = await waitForBatch();
    expect(batch).toContainEqual({ path: 'gone.txt', kind: 'unlink' });
  });

  it('does not follow symlinks (E13)', async () => {
    const outside = await fs.mkdtemp(path.join(tmpdir(), 'bright-drift-outside-'));
    try {
      await fs.writeFile(path.join(outside, 'secret.txt'), 's');
      await startWatcher();
      try {
        await fs.symlink(outside, path.join(dir, 'linked'), 'junction');
      } catch {
        // Symlink creation needs privileges on some Windows setups; skip then.
        return;
      }
      await fs.writeFile(path.join(outside, 'later.txt'), 'changed');
      await sleep(400);
      // The junction node itself may be reported, but writes INSIDE the
      // linked directory must never be traversed (followSymlinks: false).
      expect(batches.flat().some((e) => e.path.startsWith('linked/'))).toBe(false);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });
});
