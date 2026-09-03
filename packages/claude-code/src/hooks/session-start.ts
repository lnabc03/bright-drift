import { ensureDaemon } from '../shared/daemon-launch.js';
import { emitAdditionalContext, hookContext, runHook } from '../shared/hook-io.js';
import { postMailbox } from '../shared/mailbox.js';
import { ensureWorkspaceDirs, stateRoot, wsHash } from '../shared/paths.js';
import { touchSession } from '../shared/session.js';
import { STATIC_OVERVIEW, shouldInjectOverview } from './static-overview.js';

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

  // Static overview (§5.6.5), gated by inject.staticOverview (§5.6.5).
  if (await shouldInjectOverview(ctx.cwd)) {
    emitAdditionalContext('SessionStart', STATIC_OVERVIEW);
  }
}

await runHook(main);
