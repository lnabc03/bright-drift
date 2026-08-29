import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { ContentStore, MemoryContentCache } from './content-store.js';
import { sha1 } from './hash.js';

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(tmpdir(), 'bright-drift-store-'));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('ContentStore', () => {
  it('put/get/has roundtrip', async () => {
    const store = new ContentStore(dir);
    const content = Buffer.from('hello world');
    const hash = sha1(content);
    expect(await store.has(hash)).toBe(false);
    await store.put(hash, content);
    expect(await store.has(hash)).toBe(true);
    expect((await store.get(hash))?.toString()).toBe('hello world');
  });

  it('index survives a fresh instance (disk persistence)', async () => {
    const hash = sha1('persisted');
    await new ContentStore(dir).put(hash, Buffer.from('persisted'));
    const reopened = new ContentStore(dir);
    expect(await reopened.has(hash)).toBe(true);
  });

  it('get returns null for unknown hashes (fail-open)', async () => {
    const store = new ContentStore(dir);
    expect(await store.get('deadbeef'.repeat(5))).toBeNull();
  });

  it('evicts least-recently-accessed blobs beyond capacity (D3)', async () => {
    const store = new ContentStore(dir, { maxBytes: 24 });
    const a = sha1('aaaa');
    const b = sha1('bbbb');
    const c = sha1('cccc');
    await store.put(a, Buffer.from('aaaa1111'));
    await store.put(b, Buffer.from('bbbb2222'));
    await store.get(a); // touch a so b becomes oldest
    await store.put(c, Buffer.from('cccc3333')); // 24 bytes > 24? equal — triggers next put
    await store.put(sha1('dddd'), Buffer.from('dddd4444'));
    expect(await store.has(b)).toBe(false);
    expect(await store.has(a)).toBe(true);
  });

  it('is idempotent for identical blobs', async () => {
    const store = new ContentStore(dir);
    const hash = sha1('same');
    await store.put(hash, Buffer.from('same'));
    await store.put(hash, Buffer.from('same'));
    expect(await store.usageBytes()).toBe(4);
  });
});

describe('MemoryContentCache', () => {
  it('evicts oldest beyond maxFiles, refresh on get', () => {
    const cache = new MemoryContentCache({ maxFiles: 2 });
    cache.set('a', Buffer.from('a'));
    cache.set('b', Buffer.from('b'));
    cache.get('a'); // refresh
    cache.set('c', Buffer.from('c'));
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBeDefined();
    expect(cache.get('c')).toBeDefined();
  });
});
