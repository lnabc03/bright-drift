import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { probeFile, toRelativeKey } from './probe.js';
import { sha1 } from '../baseline/hash.js';

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(tmpdir(), 'bright-drift-probe-'));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('probeFile', () => {
  it('reads small text files with hash', async () => {
    await fs.writeFile(path.join(dir, 'a.txt'), 'hello');
    const obs = await probeFile(dir, 'a.txt');
    expect(obs.exists).toBe(true);
    expect(obs.contentHash).toBe(sha1('hello'));
    expect(obs.content?.toString()).toBe('hello');
    expect(obs.binary).toBe(false);
  });

  it('missing files yield exists:false (E9 fail-open)', async () => {
    const obs = await probeFile(dir, 'nope.txt');
    expect(obs).toEqual({ path: 'nope.txt', exists: false });
  });

  it('detects binary content', async () => {
    await fs.writeFile(path.join(dir, 'b.bin'), Buffer.from([0x89, 0x00, 0x01]));
    const obs = await probeFile(dir, 'b.bin');
    expect(obs.binary).toBe(true);
  });

  it('oversized files skip content (tooLarge)', async () => {
    await fs.writeFile(path.join(dir, 'big.txt'), Buffer.alloc(2048, 65));
    const obs = await probeFile(dir, 'big.txt', { maxFileSizeKB: 1 });
    expect(obs.tooLarge).toBe(true);
    expect(obs.contentHash).toBeUndefined();
  });

  it('directories are not files', async () => {
    await fs.mkdir(path.join(dir, 'sub'));
    const obs = await probeFile(dir, 'sub');
    expect(obs.exists).toBe(false);
  });
});

describe('toRelativeKey', () => {
  it('normalizes to POSIX relative paths', () => {
    const root = path.join('root', 'ws');
    expect(toRelativeKey(root, path.join(root, 'src', 'a.ts'))).toBe('src/a.ts');
  });

  it('rejects paths outside the root', () => {
    expect(toRelativeKey('/a/b', '/a/c/file.ts')).toBeNull();
  });
});
