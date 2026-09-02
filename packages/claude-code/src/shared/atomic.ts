import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

/**
 * Atomic write (design §6/B5): write to a unique tmp sibling, then rename.
 * Readers only ever see complete JSON documents. On Windows, rename over an
 * existing file can transiently fail with EPERM/EACCES/EBUSY (another writer
 * mid-replace, AV/indexer holding a handle) — retry briefly before giving up.
 */
export async function atomicWriteFile(file: string, data: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  await fs.writeFile(tmp, data, 'utf8');
  let lastErr: unknown;
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      await fs.rename(tmp, file);
      return;
    } catch (err) {
      lastErr = err;
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY') throw err;
      await new Promise((r) => setTimeout(r, 20));
    }
  }
  await fs.rm(tmp, { force: true }).catch(() => {});
  throw lastErr;
}

/**
 * Read + parse a JSON state file. Any failure (missing, truncated mid-write,
 * permission) yields undefined — callers treat it as "no state" and fail open.
 */
export async function readJsonFile<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}
