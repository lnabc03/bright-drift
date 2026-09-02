import { spawn } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicWriteFile, readJsonFile } from './atomic.js';
import { ensureWorkspaceDirs, lockFile, workspaceFile } from './paths.js';
import { SCHEMA_VERSION, type WorkspaceInfo } from './schema.js';

/** Process-existence probe; EPERM still means "alive". */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Absolute path of the bundled daemon entry. This shared module gets inlined
 * into bundles living at lib/hooks/*.js and lib/cli.js, so probe both depths.
 */
export function daemonEntryPath(): string {
  // Explicit override for tests (vitest runs from src/, bundles live in lib/).
  if (process.env.BRIGHT_DRIFT_DAEMON_ENTRY) return process.env.BRIGHT_DRIFT_DAEMON_ENTRY;
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(here, 'daemon', 'main.js'),
    path.join(here, '..', 'daemon', 'main.js'),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return candidates[0]!;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

async function daemonHealthy(hash: string): Promise<boolean> {
  const info = await readJsonFile<WorkspaceInfo>(workspaceFile(hash));
  return info?.version === SCHEMA_VERSION && pidAlive(info.daemonPid);
}

/**
 * Idempotent daemon launch (design §5.2.1): if workspace.json names a live
 * pid, done. Otherwise race an exclusive lock file; the winner spawns the
 * daemon detached (survives the hook process and the CC session, spike #1),
 * the losers spin briefly then fail open — a missing daemon only means "no
 * injections this turn", never a blocked session.
 */
export async function ensureDaemon(hash: string, cwd: string): Promise<void> {
  await ensureWorkspaceDirs(hash);
  if (await daemonHealthy(hash)) return;

  let lockFh: fs.FileHandle | undefined;
  try {
    lockFh = await fs.open(lockFile(hash), 'wx');
  } catch {
    // Another hook is launching right now — or a stale lock from a crashed one.
    for (let waited = 0; waited < 2000; waited += 100) {
      await sleep(100);
      if (await daemonHealthy(hash)) return;
    }
    // Stale lock: the holder died before finishing. Break it and retry once.
    await fs.rm(lockFile(hash), { force: true }).catch(() => {});
    try {
      lockFh = await fs.open(lockFile(hash), 'wx');
    } catch {
      return; // lost the retry race; fail open
    }
  }

  try {
    if (await daemonHealthy(hash)) return; // re-check under the lock
    const child = spawn(process.execPath, [daemonEntryPath(), '--hash', hash, '--workspace', cwd], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
    const info: WorkspaceInfo = {
      version: SCHEMA_VERSION,
      root: cwd,
      daemonPid: child.pid ?? 0,
      daemonStartedAt: Date.now(),
    };
    await atomicWriteFile(workspaceFile(hash), JSON.stringify(info));
  } finally {
    await lockFh.close().catch(() => {});
    await fs.rm(lockFile(hash), { force: true }).catch(() => {});
  }
}
