import { promises as fs } from 'node:fs';
import * as path from 'node:path';

export interface ContentStoreOptions {
  /** Disk capacity in bytes; LRU eviction by last access. Default 256MB. */
  maxBytes?: number;
  /** Called with non-fatal IO errors (fail-open; callers degrade to file-level). */
  onError?: (error: unknown, op: string) => void;
}

export const DEFAULT_STORE_MAX_BYTES = 256 * 1024 * 1024;

interface BlobMeta {
  size: number;
  lastAccess: number;
}

/**
 * Content-addressable on-disk blob store (design D3, §5.8).
 * Layout: <dir>/<sha1[0..2]>/<sha1>. Blobs are immutable and shared
 * across sessions/workspaces; capacity is enforced by LRU eviction.
 */
export class ContentStore {
  private readonly dir: string;
  private readonly maxBytes: number;
  private readonly onError: ((error: unknown, op: string) => void) | undefined;
  private index: Map<string, BlobMeta> | undefined;
  private totalBytes = 0;
  /** Monotonic access counter so LRU order is stable within one millisecond. */
  private lastAccess = 0;

  private touch(): number {
    const t = Date.now();
    this.lastAccess = t > this.lastAccess ? t : this.lastAccess + 1;
    return this.lastAccess;
  }

  constructor(dir: string, options: ContentStoreOptions = {}) {
    this.dir = dir;
    this.maxBytes = options.maxBytes ?? DEFAULT_STORE_MAX_BYTES;
    this.onError = options.onError;
  }

  private blobPath(hash: string): string {
    return path.join(this.dir, hash.slice(0, 2), hash);
  }

  /** Lazily build the index by scanning the store directory. */
  private async ensureIndex(): Promise<Map<string, BlobMeta>> {
    if (this.index) return this.index;
    this.index = new Map();
    this.totalBytes = 0;
    try {
      const shards = await fs.readdir(this.dir, { withFileTypes: true });
      for (const shard of shards) {
        if (!shard.isDirectory()) continue;
        const shardDir = path.join(this.dir, shard.name);
        for (const name of await fs.readdir(shardDir)) {
          try {
            const stat = await fs.stat(path.join(shardDir, name));
            if (!stat.isFile()) continue;
            const hash = name;
            this.index.set(hash, { size: stat.size, lastAccess: stat.mtimeMs });
            this.totalBytes += stat.size;
          } catch (error) {
            this.onError?.(error, 'index-stat');
          }
        }
      }
    } catch (error) {
      // Missing dir on first run is normal.
      this.onError?.(error, 'index-scan');
    }
    return this.index;
  }

  async has(hash: string): Promise<boolean> {
    const index = await this.ensureIndex();
    return index.has(hash);
  }

  /** Read a blob; returns null when absent or unreadable (degrade to file-level). */
  async get(hash: string): Promise<Buffer | null> {
    const index = await this.ensureIndex();
    try {
      const content = await fs.readFile(this.blobPath(hash));
      index.set(hash, { size: content.length, lastAccess: this.touch() });
      return content;
    } catch (error) {
      index.delete(hash);
      this.onError?.(error, 'get');
      return null;
    }
  }

  /** Write a blob (idempotent) and enforce capacity afterwards. */
  async put(hash: string, content: Buffer): Promise<void> {
    const index = await this.ensureIndex();
    try {
      const file = this.blobPath(hash);
      await fs.mkdir(path.dirname(file), { recursive: true });
      if (!index.has(hash)) {
        // Atomic write: tmp + rename.
        const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
        await fs.writeFile(tmp, content);
        await fs.rename(tmp, file);
        this.totalBytes += content.length;
      }
      index.set(hash, { size: content.length, lastAccess: this.touch() });
      await this.evictIfNeeded(index);
    } catch (error) {
      this.onError?.(error, 'put');
    }
  }

  private async evictIfNeeded(index: Map<string, BlobMeta>): Promise<void> {
    while (this.totalBytes > this.maxBytes && index.size > 0) {
      let oldestHash: string | undefined;
      let oldestAccess = Number.POSITIVE_INFINITY;
      for (const [hash, meta] of index) {
        if (meta.lastAccess < oldestAccess) {
          oldestAccess = meta.lastAccess;
          oldestHash = hash;
        }
      }
      if (oldestHash === undefined) break;
      const meta = index.get(oldestHash);
      index.delete(oldestHash);
      this.totalBytes -= meta?.size ?? 0;
      try {
        await fs.rm(this.blobPath(oldestHash), { force: true });
      } catch (error) {
        this.onError?.(error, 'evict');
      }
    }
  }

  /** Current tracked bytes (after index load). */
  async usageBytes(): Promise<number> {
    await this.ensureIndex();
    return this.totalBytes;
  }
}

export interface MemoryCacheOptions {
  /** Max cached files. Default 200 (design §5.1). */
  maxFiles?: number;
}

/**
 * In-memory content LRU in front of the disk store. Eviction here never
 * touches the disk copy; disk eviction is what degrades diffs to file-level.
 */
export class MemoryContentCache {
  private readonly maxFiles: number;
  private cache = new Map<string, Buffer>();

  constructor(options: MemoryCacheOptions = {}) {
    this.maxFiles = options.maxFiles ?? 200;
  }

  get size(): number {
    return this.cache.size;
  }

  get(hash: string): Buffer | undefined {
    const buf = this.cache.get(hash);
    if (buf) {
      this.cache.delete(hash);
      this.cache.set(hash, buf);
    }
    return buf;
  }

  set(hash: string, content: Buffer): void {
    this.cache.delete(hash);
    this.cache.set(hash, content);
    while (this.cache.size > this.maxFiles) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }

  delete(hash: string): void {
    this.cache.delete(hash);
  }

  clear(): void {
    this.cache.clear();
  }
}
