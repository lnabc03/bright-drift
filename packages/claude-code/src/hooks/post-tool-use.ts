import * as path from 'node:path';
import { hookContext, runHook } from '../shared/hook-io.js';
import { postMailbox } from '../shared/mailbox.js';
import { wsHash } from '../shared/paths.js';
import { touchSession } from '../shared/session.js';

/** Read tools feed the AKB; write tools update it (design §5.3, D5-style
 *  enumeration — unknown write tools fall to the conservative path in the
 *  daemon, not here). */
const READ_TOOLS = new Set(['Read']);
const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

/**
 * PostToolUse hook (design §5.3/§5.5.1): translate the tool event into a
 * mailbox message and exit. No I/O beyond the mailbox write — the daemon
 * does all AKB/attribution work.
 */
async function main(input: Record<string, unknown>): Promise<void> {
  const ctx = hookContext(input);
  if (!ctx) return;
  const tool = typeof input.tool_name === 'string' ? input.tool_name : '';
  const toolInput = (input.tool_input ?? {}) as Record<string, unknown>;
  const toolUseId = typeof input.tool_use_id === 'string' ? input.tool_use_id : undefined;
  const hash = await wsHash(ctx.cwd);

  await touchSession(hash, ctx.sessionId);

  if (tool === 'Bash') {
    await postMailbox(hash, ctx.sessionId, {
      type: 'window.close',
      sessionId: ctx.sessionId,
      ...(toolUseId !== undefined ? { toolUseId } : {}),
      closedAt: Date.now(),
    });
    return;
  }

  const rawPath =
    typeof toolInput.file_path === 'string'
      ? toolInput.file_path
      : typeof toolInput.notebook_path === 'string'
        ? toolInput.notebook_path
        : undefined;
  if (!rawPath) return;
  // The docs warn file_path may be relative; anchor it at the payload cwd.
  const filePath = path.isAbsolute(rawPath) ? rawPath : path.resolve(ctx.cwd, rawPath);

  if (READ_TOOLS.has(tool)) {
    await postMailbox(hash, ctx.sessionId, {
      type: 'akb.observe',
      sessionId: ctx.sessionId,
      ...(toolUseId !== undefined ? { toolUseId } : {}),
      tool,
      filePath,
      action: 'read',
    });
  } else if (WRITE_TOOLS.has(tool)) {
    await postMailbox(hash, ctx.sessionId, {
      type: 'akb.observe',
      sessionId: ctx.sessionId,
      ...(toolUseId !== undefined ? { toolUseId } : {}),
      tool,
      filePath,
      action: 'write',
    });
  }
}

await runHook(main);
