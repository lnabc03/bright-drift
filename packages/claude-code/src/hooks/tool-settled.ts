import { hookContext, runHook } from '../shared/hook-io.js';
import { postMailbox } from '../shared/mailbox.js';
import { wsHash } from '../shared/paths.js';
import { touchSession } from '../shared/session.js';

/**
 * Tool-settled hook (design §5.5.1, 2.1.300 audit P2-1): closes the
 * attribution window opened by PreToolUse(Bash) for calls that never reach
 * PostToolUse — PostToolUse only fires after a tool *succeeds*; failures go
 * to PostToolUseFailure and permission denials to PermissionDenied. For one
 * tool_use_id the three terminal events are mutually exclusive, and the
 * daemon's closeWindow is a no-op for unknown ids, so this hook is safe to
 * attach to both events. Without it a denied/failed command leaves the
 * window open forever (windows have no expiry), blaming later external
 * drift on a command that never ran — the wrong direction for the
 * asymmetric-bias rule (PRD §3.6).
 */
async function main(input: Record<string, unknown>): Promise<void> {
  const ctx = hookContext(input);
  if (!ctx) return;
  const tool = typeof input.tool_name === 'string' ? input.tool_name : '';
  if (tool !== 'Bash') return;
  const toolUseId = typeof input.tool_use_id === 'string' ? input.tool_use_id : undefined;
  const hash = await wsHash(ctx.cwd);

  await touchSession(hash, ctx.sessionId);
  await postMailbox(hash, ctx.sessionId, {
    type: 'window.close',
    sessionId: ctx.sessionId,
    ...(toolUseId !== undefined ? { toolUseId } : {}),
    closedAt: Date.now(),
  });
}

await runHook(main);
