import { promises as fs } from 'node:fs';
import { hookContext, runHook } from '../shared/hook-io.js';
import { readJsonFile } from '../shared/atomic.js';
import { postMailbox } from '../shared/mailbox.js';
import { akbPathsFile, wsHash } from '../shared/paths.js';
import type { WindowPreSnapshotEntry } from '../shared/schema.js';
import { touchSession } from '../shared/session.js';

/**
 * PreToolUse(Bash) hook (design §5.5.1-5.5.2, P2-D5): the attribution window
 * pre-snapshot is taken HERE, in the hook process, because the mailbox is
 * async — by the time the daemon saw window.open the command may already
 * have written files. Cost is bounded: stat() over the daemon-maintained
 * AKB path list (a few hundred entries, <50ms against a 600s timeout).
 *
 * M5 will add the command static analysis (predictedPaths) via an esbuild
 * bundle that inlines core's analyzeBash/analyzePwsh.
 */
async function main(input: Record<string, unknown>): Promise<void> {
  const ctx = hookContext(input);
  if (!ctx) return;
  const toolInput = (input.tool_input ?? {}) as Record<string, unknown>;
  const command = typeof toolInput.command === 'string' ? toolInput.command : '';
  if (!command) return;
  const toolUseId = typeof input.tool_use_id === 'string' ? input.tool_use_id : undefined;
  const background = toolInput.run_in_background === true;
  const hash = await wsHash(ctx.cwd);

  await touchSession(hash, ctx.sessionId);

  const paths = (await readJsonFile<string[]>(akbPathsFile(hash))) ?? [];
  const preSnapshot: WindowPreSnapshotEntry[] = await Promise.all(
    paths.map(async (p) => {
      try {
        const st = await fs.stat(p);
        return { path: p, mtimeMs: st.mtimeMs, size: st.size, exists: true };
      } catch {
        return { path: p, mtimeMs: 0, size: 0, exists: false };
      }
    }),
  );

  await postMailbox(hash, ctx.sessionId, {
    type: 'window.open',
    sessionId: ctx.sessionId,
    ...(toolUseId !== undefined ? { toolUseId } : {}),
    command,
    shell: 'bash', // CC's Bash tool is bash on every supported platform
    ...(background ? { background } : {}),
    openedAt: Date.now(),
    preSnapshot,
  });
}

await runHook(main);
