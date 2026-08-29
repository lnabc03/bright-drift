import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { sha1 } from '../baseline/hash.js';
import { isBinaryContent } from '../diff/index.js';
import type { FileObservation } from './types.js';

export interface ProbeOptions {
  /** Files larger than this (KB) are reported without hash/content (default 512, FR-4). */
  maxFileSizeKB?: number;
}

const DEFAULT_MAX_FILE_SIZE_KB = 512;

/** Normalize an absolute path to a workspace-relative POSIX-style key. */
export function toRelativeKey(root: string, absPath: string): string | null {
  const rel = path.relative(root, absPath);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

/**
 * Observe one file's current state: stat, and for small files a full read
 * with SHA-1 + binary probe. Never throws — ENOENT yields `exists:false`,
 * other read failures yield `exists:false` too (E9: half-written files are
 * skipped this round; the next watcher event re-triggers probing).
 */
export async function probeFile(
  root: string,
  relPath: string,
  options: ProbeOptions = {},
): Promise<FileObservation> {
  const maxBytes = (options.maxFileSizeKB ?? DEFAULT_MAX_FILE_SIZE_KB) * 1024;
  const abs = path.join(root, relPath);
  try {
    const stat = await fs.stat(abs); // does not follow dangling symlinks into targets
    if (!stat.isFile()) return { path: relPath, exists: false };
    const base = {
      path: relPath,
      exists: true,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
    };
    if (stat.size > maxBytes) {
      return { ...base, tooLarge: true };
    }
    const content = await fs.readFile(abs);
    return {
      ...base,
      content,
      contentHash: sha1(content),
      binary: isBinaryContent(content),
    };
  } catch {
    return { path: relPath, exists: false };
  }
}
