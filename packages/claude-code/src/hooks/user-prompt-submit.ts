import { emitAdditionalContext, hookContext, runHook } from '../shared/hook-io.js';
import { wsHash } from '../shared/paths.js';
import { markDelivered, readPending } from '../shared/pending.js';
import { touchSession } from '../shared/session.js';

/**
 * Hot path (design §5.6.1): one local file read, print, exit. The daemon
 * pre-renders; this hook never computes anything. 30s timeout with
 * fail-open semantics measured in spike #4 — a missing/corrupt pending
 * file just means "no injection this prompt".
 */
async function main(input: Record<string, unknown>): Promise<void> {
  const ctx = hookContext(input);
  if (!ctx) return;
  const hash = await wsHash(ctx.cwd);

  await touchSession(hash, ctx.sessionId);

  const pending = await readPending(hash, ctx.sessionId);
  if (!pending) return;
  if (pending.deliveredVia.includes('user-prompt-submit')) return;

  emitAdditionalContext('UserPromptSubmit', pending.text);
  await markDelivered(hash, ctx.sessionId, 'user-prompt-submit', pending.batchId).catch(() => {});
}

await runHook(main);
