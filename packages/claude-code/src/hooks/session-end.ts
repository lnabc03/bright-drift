import { hookContext, runHook } from '../shared/hook-io.js';
import { postMailbox } from '../shared/mailbox.js';
import { wsHash } from '../shared/paths.js';
import { removeSession } from '../shared/session.js';

/**
 * SessionEnd (design §5.2.3): JSON output is discarded and the shared budget
 * is 1.5s, so this is exactly one mailbox write. The daemon's 2h lastSeen
 * sweep is the real backstop for crashed sessions.
 */
async function main(input: Record<string, unknown>): Promise<void> {
  const ctx = hookContext(input);
  if (!ctx) return;
  const reason = typeof input.reason === 'string' ? input.reason : undefined;
  const hash = await wsHash(ctx.cwd);

  await postMailbox(hash, ctx.sessionId, {
    type: 'session.deregister',
    sessionId: ctx.sessionId,
    ...(reason !== undefined ? { reason } : {}),
  });
  await removeSession(hash, ctx.sessionId);
}

await runHook(main);
