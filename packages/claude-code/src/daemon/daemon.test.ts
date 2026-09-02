import { spawn, type ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { libDir, mkTmp, waitFor } from '../testkit.js';
import { atomicWriteFile, readJsonFile } from '../shared/atomic.js';
import { ensureDaemon, pidAlive } from '../shared/daemon-launch.js';
import { postMailbox } from '../shared/mailbox.js';
import {
  pendingFile,
  sessionFile,
  sessionsDir,
  workspaceFile,
  wsHash,
} from '../shared/paths.js';
import { SCHEMA_VERSION, type PendingInjection, type WorkspaceInfo } from '../shared/schema.js';

/**
 * Daemon lifecycle tests (design §5.2, P2-T5): real bundled daemon processes
 * against a tmp state root, with all timeouts scaled down via env.
 */

let stateHome: string;
let cwd: string;
let hash: string;
let daemon: ChildProcess | undefined;

const FAST = {
  BRIGHT_DRIFT_MAILBOX_POLL_MS: '100',
  BRIGHT_DRIFT_SWEEP_MS: '150',
  BRIGHT_DRIFT_SESSION_DEAD_MS: '600',
  BRIGHT_DRIFT_IDLE_EXIT_MS: '900',
};

beforeEach(async () => {
  stateHome = await mkTmp('bd-daemon-state-');
  cwd = await mkTmp('bd-daemon-ws-');
  hash = await wsHash(cwd);
  process.env.BRIGHT_DRIFT_STATE_HOME = stateHome;
  process.env.BRIGHT_DRIFT_DAEMON_ENTRY = path.join(libDir(), 'daemon', 'main.js');
});

afterEach(async () => {
  if (daemon?.pid && pidAlive(daemon.pid)) daemon.kill('SIGTERM');
  daemon = undefined;
  delete process.env.BRIGHT_DRIFT_STATE_HOME;
  delete process.env.BRIGHT_DRIFT_DAEMON_ENTRY;
  await fs.rm(stateHome, { recursive: true, force: true });
  await fs.rm(cwd, { recursive: true, force: true });
});

async function spawnDaemonDirect(): Promise<ChildProcess> {
  const child = spawn(
    process.execPath,
    [path.join(libDir(), 'daemon', 'main.js'), '--hash', hash, '--workspace', cwd],
    { env: { ...process.env, ...FAST }, stdio: 'ignore' },
  );
  // The daemon only owns the workspace once workspace.json names its pid.
  await atomicWriteFile(
    workspaceFile(hash),
    JSON.stringify({
      version: SCHEMA_VERSION,
      root: cwd,
      daemonPid: child.pid ?? 0,
      daemonStartedAt: Date.now(),
    } satisfies WorkspaceInfo),
  );
  return child;
}

describe('daemon lifecycle', () => {
  it('consumes register, writes hello-drift pending, tracks liveness', async () => {
    daemon = await spawnDaemonDirect();
    await postMailbox(hash, 's1', {
      type: 'session.register',
      sessionId: 's1',
      cwd,
      source: 'startup',
    });

    const got = await waitFor(async () => {
      const p = await readJsonFile<PendingInjection>(pendingFile(hash, 's1'));
      return p?.text.includes('BRIGHT-DRIFT-HELLO') === true;
    });
    expect(got).toBe(true);
    expect(await readJsonFile(sessionFile(hash, 's1'))).toMatchObject({ sessionId: 's1' });

    // deregister removes the session entry
    await postMailbox(hash, 's1', { type: 'session.deregister', sessionId: 's1' });
    expect(await waitFor(async () => !(await readJsonFile(sessionFile(hash, 's1'))))).toBe(true);
  }, 15_000);

  it('exits when idle and removes workspace.json (P2-D4)', async () => {
    daemon = await spawnDaemonDirect();
    const pid = daemon.pid!;
    const gone = await waitFor(() => !pidAlive(pid), 10_000);
    expect(gone).toBe(true);
    expect(await readJsonFile(workspaceFile(hash))).toBeUndefined();
  }, 15_000);

  it('sweeps sessions whose lastSeen is beyond the dead threshold', async () => {
    daemon = await spawnDaemonDirect();
    // A session that went silent long ago (crash without SessionEnd).
    await atomicWriteFile(
      sessionFile(hash, 'stale'),
      JSON.stringify({
        version: SCHEMA_VERSION,
        sessionId: 'stale',
        registeredAt: Date.now() - 10_000,
        lastSeenAt: Date.now() - 10_000,
      }),
    );
    expect(await waitFor(async () => !(await readJsonFile(sessionFile(hash, 'stale'))))).toBe(true);
  }, 15_000);

  it('ensureDaemon is idempotent: two launches, one daemon (P2-T5)', async () => {
    await ensureDaemon(hash, cwd);
    const first = await readJsonFile<WorkspaceInfo>(workspaceFile(hash));
    expect(first && pidAlive(first.daemonPid)).toBe(true);
    daemon = { pid: first!.daemonPid, kill: (s?: string) => process.kill(first!.daemonPid, s as NodeJS.Signals) } as unknown as ChildProcess;

    await ensureDaemon(hash, cwd);
    const second = await readJsonFile<WorkspaceInfo>(workspaceFile(hash));
    expect(second?.daemonPid).toBe(first!.daemonPid);

    // And the launched daemon passes its own identity check (stays up).
    expect(await waitFor(() => !pidAlive(first!.daemonPid), 1500)).toBe(false);
  }, 15_000);

  it('ensureDaemon recovers from a stale lock + dead pid (P2-T10)', async () => {
    // Simulate a crashed launcher: lock file present, workspace.json names a
    // pid that does not exist.
    await fs.mkdir(sessionsDir(hash), { recursive: true });
    await fs.writeFile(path.join(path.dirname(workspaceFile(hash)), 'daemon.lock'), '', 'utf8');
    await atomicWriteFile(
      workspaceFile(hash),
      JSON.stringify({
        version: SCHEMA_VERSION,
        root: cwd,
        daemonPid: 999_999_999,
        daemonStartedAt: Date.now() - 60_000,
      } satisfies WorkspaceInfo),
    );

    await ensureDaemon(hash, cwd); // ~2s stale-lock wait, then recovery
    const info = await readJsonFile<WorkspaceInfo>(workspaceFile(hash));
    expect(info && pidAlive(info.daemonPid)).toBe(true);
    daemon = { pid: info!.daemonPid, kill: (s?: string) => process.kill(info!.daemonPid, s as NodeJS.Signals) } as unknown as ChildProcess;
  }, 20_000);
});
