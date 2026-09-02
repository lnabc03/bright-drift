import { atomicWriteFile, readJsonFile } from './atomic.js';
import { pendingFile } from './paths.js';
import type { PendingInjection } from './schema.js';

/**
 * Read the pre-rendered injection for a session (daemon→hook direction,
 * §4.4). The hot path (UserPromptSubmit) is exactly this one file read.
 */
export async function readPending(
  hash: string,
  sessionId: string,
): Promise<PendingInjection | undefined> {
  const pending = await readJsonFile<PendingInjection>(pendingFile(hash, sessionId));
  if (!pending || typeof pending.text !== 'string' || pending.text.length === 0) {
    return undefined;
  }
  if (!Array.isArray(pending.deliveredVia)) return undefined;
  return pending;
}

/**
 * Record that a channel delivered a batch. This is the hook's only write on
 * the hot path; a lost write merely risks one duplicate injection of an
 * idempotent fact-statement (§4.4).
 *
 * The batchId guard closes a race: the daemon may render the NEXT batch over
 * the file between the hook's read and this write — without the guard, the
 * hook would mark a batch it never delivered as delivered, silently
 * swallowing it (smoke-test 2026-09-02).
 */
export async function markDelivered(
  hash: string,
  sessionId: string,
  channel: 'user-prompt-submit' | 'stop',
  batchId: string,
): Promise<void> {
  const pending = await readPending(hash, sessionId);
  if (!pending || pending.batchId !== batchId) return;
  if (pending.deliveredVia.includes(channel)) return;
  await atomicWriteFile(
    pendingFile(hash, sessionId),
    JSON.stringify({ ...pending, deliveredVia: [...pending.deliveredVia, channel] }),
  );
}
