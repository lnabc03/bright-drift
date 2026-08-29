import { createHash } from 'node:crypto';

/** SHA-1 hex digest of a UTF-8 string or buffer. Used as content address and blob key. */
export function sha1(content: string | Buffer): string {
  return createHash('sha1').update(content).digest('hex');
}
