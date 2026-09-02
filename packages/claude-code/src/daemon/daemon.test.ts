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
import { removeSession, touchSession } from '../shared/session.js';

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

async function spawnDaemonDirect(extraEnv: NodeJS.ProcessEnv = {}): Promise<ChildProcess> {
  const child = spawn(
    process.execPath,
    [path.join(libDir(), 'daemon', 'main.js'), '--hash', hash, '--workspace', cwd],
    { env: { ...process.env, ...FAST, ...extraEnv }, stdio: 'ignore' },
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
  it('register → observe → external modify → pending injection (P2-T1)', async () => {
    // Long liveness budgets: this test spans seconds, and the hooks' liveness
    // refresh (touchSession) is simulated once — in production every hook call
    // re-touches the session file.
    daemon = await spawnDaemonDirect({
      BRIGHT_DRIFT_SESSION_DEAD_MS: '60000',
      BRIGHT_DRIFT_IDLE_EXIT_MS: '60000',
    });
    await postMailbox(hash, 's1', {
      type: 'session.register',
      sessionId: 's1',
      cwd,
      source: 'startup',
    });
    await touchSession(hash, 's1', 'startup'); // the session-start hook's half

    // A fresh session with an empty AKB has nothing to say.
    await new Promise((r) => setTimeout(r, 500));
    expect(await readJsonFile(pendingFile(hash, 's1'))).toBeUndefined();

    // The agent reads the file (baseline), then an external process edits it.
    const file = path.join(cwd, 'a.txt');
    await fs.writeFile(file, 'v1\n');
    await postMailbox(hash, 's1', {
      type: 'akb.observe',
      sessionId: 's1',
      tool: 'Read',
      filePath: file,
      action: 'read',
    });
    await waitFor(async () =>
      (await readJsonFile<string[]>(path.join(stateHome, 'workspaces', hash, 'akb-paths.json')))?.includes(file) === true,
    );

    await fs.writeFile(file, 'v2 external\n');
    const got = await waitFor(async () => {
      const p = await readJsonFile<PendingInjection>(pendingFile(hash, 's1'));
      return p?.text.includes('EXTERNAL') === true && p.text.includes('a.txt');
    }, 15_000);
    expect(got).toBe(true);

    // deregister: the SessionEnd hook removes the session entry itself and
    // posts the mailbox message; an undelivered pending batch SURVIVES — the
    // sync point committed the AKB at render time, so deleting it would lose
    // the drift notice entirely (e2e P2-T3, 2026-09-02).
    await removeSession(hash, 's1');
    await postMailbox(hash, 's1', { type: 'session.deregister', sessionId: 's1' });
    expect(await waitFor(async () => !(await readJsonFile(sessionFile(hash, 's1'))))).toBe(true);
    // pending stays deliverable for a later resume
    expect((await readJsonFile<PendingInjection>(pendingFile(hash, 's1')))?.text).toContain('a.txt');
  }, 25_000);

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

  it('exits when workspace.json names another pid (stale duplicate sweep)', async () => {
    daemon = await spawnDaemonDirect();
    const pid = daemon.pid!;
    // A newer daemon takes over the workspace — the stale one must notice
    // within one sweep and exit (two daemons once raced over one workspace
    // when a state-dir reset stranded the old owner; e2e 2026-09-02).
    await atomicWriteFile(
      workspaceFile(hash),
      JSON.stringify({
        version: SCHEMA_VERSION,
        root: cwd,
        daemonPid: pid + 999999,
        daemonStartedAt: Date.now(),
      } satisfies WorkspaceInfo),
    );
    expect(await waitFor(() => !pidAlive(pid), 10_000)).toBe(true);
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
