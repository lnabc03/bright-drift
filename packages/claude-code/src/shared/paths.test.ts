import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { wsHash, wsHashSync } from './paths.js';

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bd-paths-'));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('wsHash', () => {
  it('is stable and 16 hex chars', async () => {
    const a = await wsHash(dir);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(await wsHash(dir)).toBe(a);
    expect(wsHashSync(dir)).toBe(a);
  });

  it('collapses a symlink onto the same hash (B6)', async () => {
    const target = path.join(dir, 'real');
    await fs.mkdir(target);
    const link = path.join(dir, 'link');
    try {
      await fs.symlink(target, link, 'dir');
    } catch {
      return; // symlink privilege unavailable on this Windows box
    }
    expect(await wsHash(link)).toBe(await wsHash(target));
  });

  it('differs across directories and survives a missing cwd', async () => {
    const other = path.join(dir, 'other');
    await fs.mkdir(other);
    expect(await wsHash(other)).not.toBe(await wsHash(dir));
    const missing = await wsHash(path.join(dir, 'gone'));
    expect(missing).toMatch(/^[0-9a-f]{16}$/);
  });
});
