import { emitAdditionalContext, hookContext, runHook } from '../shared/hook-io.js';
import { wsHash } from '../shared/paths.js';
import { markDelivered, readPending } from '../shared/pending.js';
import { touchSession } from '../shared/session.js';

/**
 * Stop-channel top-up (design §5.6.2, P2-D6): only `priority:"high"` batches
 * (AKB-tracked file deleted/renamed) are delivered here, and at most once
 * per batch. The gate is the pending file's deliveredVia — NOT
 * stop_hook_active, which is already true on the first Stop of a turn
 * (spike #2). Without this gate the official 8-strike breaker is the only
 * thing stopping an inject→continue→inject loop.
 */
async function main(input: Record<string, unknown>): Promise<void> {
  const ctx = hookContext(input);
  if (!ctx) return;
  const hash = await wsHash(ctx.cwd);

  await touchSession(hash, ctx.sessionId);

  const pending = await readPending(hash, ctx.sessionId);
  if (!pending) return;
  if (pending.priority !== 'high') return;
  if (pending.deliveredVia.length > 0) return; // at-most-once per batch

  emitAdditionalContext('Stop', pending.text);
  await markDelivered(hash, ctx.sessionId, 'stop', pending.batchId).catch(() => {});
}

await runHook(main);
