import { ensureDaemon } from '../shared/daemon-launch.js';
import { emitAdditionalContext, hookContext, readHookInput, runHook } from '../shared/hook-io.js';
import { postMailbox } from '../shared/mailbox.js';
import { ensureWorkspaceDirs, stateRoot, wsHash } from '../shared/paths.js';
import { touchSession } from '../shared/session.js';

/**
 * Static overview (design §5.6.5): the CC equivalent of phase-1's prompt
 * section. SessionStart re-runs after compact/clear (E5), so this text
 * re-lands automatically after every context reset. Fact-statement style —
 * imperative phrasing trips CC's prompt-injection defenses (§1.3).
 */
export const STATIC_OVERVIEW = [
  'bright-drift monitors this workspace in the background.',
  'Files may change outside your own tool calls — edited by the user or by other processes — at any time, including mid-turn.',
  'When that happens, a notice listing the changed files is injected as a system reminder at a later turn boundary.',
  'Each notice is a statement of fact, not an instruction; its attribution label (external-change / command-side-effect / ambiguous) records the likely cause.',
].join(' ');

async function selftest(): Promise<void> {
  // Installer dry-run (§5.9-3): prove node runs us and the state root is
  // writable. No daemon, no mailbox, no stdout protocol output.
  const { promises: fs } = await import('node:fs');
  await fs.mkdir(stateRoot(), { recursive: true });
  await fs.access(stateRoot(), fs.constants.W_OK);
  process.stdout.write(JSON.stringify({ ok: true, stateRoot: stateRoot() }));
}

async function main(input: Record<string, unknown>): Promise<void> {
  if (process.env.BRIGHT_DRIFT_SELFTEST === '1') {
    await selftest();
    return;
  }
  const ctx = hookContext(input);
  if (!ctx) return;
  const source = typeof input.source === 'string' ? input.source : undefined;
  const hash = await wsHash(ctx.cwd);

  await ensureWorkspaceDirs(hash);
  await touchSession(hash, ctx.sessionId, source);
  await postMailbox(hash, ctx.sessionId, {
    type: 'session.register',
    sessionId: ctx.sessionId,
    cwd: ctx.cwd,
    ...(source !== undefined ? { source } : {}),
    ...(typeof input.transcript_path === 'string'
      ? { transcriptPath: input.transcript_path }
      : {}),
  });
  await ensureDaemon(hash, ctx.cwd);

  emitAdditionalContext('SessionStart', STATIC_OVERVIEW);
}

await runHook(main);
