import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { atomicWriteFile, readJsonFile } from './atomic.js';

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bd-atomic-'));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('atomicWriteFile + readJsonFile', () => {
  it('writes JSON that reads back intact, creating parent dirs', async () => {
    const file = path.join(dir, 'a', 'b', 'c.json');
    await atomicWriteFile(file, JSON.stringify({ hello: 'world' }));
    expect(await readJsonFile(file)).toEqual({ hello: 'world' });
  });

  it('leaves no tmp files behind', async () => {
    const file = path.join(dir, 'x.json');
    await atomicWriteFile(file, '{}');
    expect((await fs.readdir(dir)).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  it('concurrent writers never produce a torn file', async () => {
    const file = path.join(dir, 'race.json');
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        atomicWriteFile(file, JSON.stringify({ writer: i, pad: 'x'.repeat(2000) })),
      ),
    );
    const parsed = await readJsonFile<{ writer: number }>(file);
    expect(typeof parsed?.writer).toBe('number');
  });

  it('readJsonFile fails open on truncated JSON (B5)', async () => {
    const file = path.join(dir, 'torn.json');
    await fs.writeFile(file, '{"version":1,"text":"never fini', 'utf8');
    expect(await readJsonFile(file)).toBeUndefined();
  });

  it('readJsonFile fails open on a missing file', async () => {
    expect(await readJsonFile(path.join(dir, 'nope.json'))).toBeUndefined();
  });
});
