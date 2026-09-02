import { promises as fs } from 'node:fs';
import { readJsonFile } from '../shared/atomic.js';
import { log } from '../shared/log.js';
import { drainMailbox, listMailboxSessions } from '../shared/mailbox.js';
import {
  ensureWorkspaceDirs,
  lockFile,
  mailboxRoot,
  sessionsDir,
  workspaceFile,
} from '../shared/paths.js';
import {
  type SessionEntry,
  type WorkspaceInfo,
} from '../shared/schema.js';
import { removeSession } from '../shared/session.js';
import { WorkspaceEngine } from './engine.js';

/**
 * bright-drift daemon (design §5.2): one detached node process per
 * workspace. Owns the WorkspaceEngine (watcher / AKB / attribution /
 * rendering — §5.3-5.7), consumes hook mailbox messages, and self-exits
 * after 30 min without a live session (P2-D4).
 */

const SWEEP_MS = Number(process.env.BRIGHT_DRIFT_SWEEP_MS ?? 60_000);
const SESSION_DEAD_MS = Number(process.env.BRIGHT_DRIFT_SESSION_DEAD_MS ?? 2 * 60 * 60 * 1000);
const IDLE_EXIT_MS = Number(process.env.BRIGHT_DRIFT_IDLE_EXIT_MS ?? 30 * 60 * 1000);
const MAILBOX_POLL_MS = Number(process.env.BRIGHT_DRIFT_MAILBOX_POLL_MS ?? 300);

function requireArg(flag: string): string {
  const i = process.argv.indexOf(flag);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  if (!v) process.exit(1);
  return v;
}

const hash = requireArg('--hash');
const workspaceRoot = requireArg('--workspace');

/** Identity check (§5.2.4): a stale duplicate must yield to the recorded pid. */
async function ownsWorkspace(): Promise<boolean> {
  for (let waited = 0; waited < 3000; waited += 100) {
    const info = await readJsonFile<WorkspaceInfo>(workspaceFile(hash));
    if (info) return info.daemonPid === process.pid;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

const engine = new WorkspaceEngine(hash, workspaceRoot);

async function pollMailboxes(): Promise<void> {
  const root = mailboxRoot(hash);
  for (const sessionId of await listMailboxSessions(root)) {
    const drained = await drainMailbox(`${root}/${sessionId}`);
    for (const { msg } of drained) {
      try {
        await engine.handle(msg);
      } catch (err) {
        await log(`mailbox ${msg.type}: ${(err as Error).message}`);
      }
    }
  }
  // Config + pause hot-reload ride the same tick (mtime/stat polls, §5.8/§5.10).
  await engine.pollConfig().catch(() => {});
  await engine.pollPaused().catch(() => {});
}

/**
 * Liveness sweep (§5.2.3, P2-D4): sessions untouched for SESSION_DEAD_MS are
 * declared dead (CC crash never emits SessionEnd); when nothing has been
 * alive for IDLE_EXIT_MS the daemon cleans up its markers and exits.
 */
let lastAliveAt = Date.now();
let stopping = false;

async function sweep(): Promise<void> {
  // Ownership re-check (e2e 2026-09-02): a daemon that lost workspace.json
  // (state dir reset, or a newer daemon took over) must exit instead of
  // draining mailboxes in parallel with the live owner.
  const info = await readJsonFile<WorkspaceInfo>(workspaceFile(hash));
  if (!info || info.daemonPid !== process.pid) {
    await shutdown('stale');
  }

  const now = Date.now();
  let alive = 0;
  let names: string[] = [];
  try {
    names = await fs.readdir(sessionsDir(hash));
  } catch {
    names = [];
  }
  for (const name of names.filter((n) => n.endsWith('.json'))) {
    const entry = await readJsonFile<SessionEntry>(`${sessionsDir(hash)}/${name}`);
    if (!entry) {
      await fs.rm(`${sessionsDir(hash)}/${name}`, { force: true }).catch(() => {});
      continue;
    }
    if (now - entry.lastSeenAt > SESSION_DEAD_MS) {
      await removeSession(hash, entry.sessionId);
      await engine.handleSessionDead(entry.sessionId);
      await log(`session ${entry.sessionId} declared dead (lastSeen ${now - entry.lastSeenAt}ms ago)`);
    } else {
      alive++;
    }
  }

  if (alive > 0) {
    lastAliveAt = now;
  } else if (now - lastAliveAt > IDLE_EXIT_MS) {
    await shutdown('idle');
  }
}

async function shutdown(reason: string): Promise<never> {
  if (stopping) process.exit(0);
  stopping = true;
  await log(`daemon exit (${reason}) pid=${process.pid}`);
  await engine.stop().catch(() => {});
  await fs.rm(lockFile(hash), { force: true }).catch(() => {});
  await fs.rm(workspaceFile(hash), { force: true }).catch(() => {});
  process.exit(0);
}

async function start(): Promise<void> {
  await ensureWorkspaceDirs(hash);
  if (!(await ownsWorkspace())) {
    await log(`daemon pid=${process.pid} is stale for workspace ${hash}; exiting`);
    process.exit(1);
  }
  await engine.start();
  await log(`daemon start pid=${process.pid} workspace=${workspaceRoot} hash=${hash}`);

  process.on('SIGTERM', () => void shutdown('sigterm'));
  process.on('SIGINT', () => void shutdown('sigint'));

  // Mailbox polling: fs.watch would do, but a poll is platform-proof and the
  // consumer side tolerates the few-hundred-ms latency (design §3.2-4).
  // NOTE: these intervals are the daemon's keep-alive — never unref() them.
  setInterval(() => void pollMailboxes().catch(() => {}), MAILBOX_POLL_MS);
  setInterval(
    () => void sweep().catch((err) => void log(`sweep error: ${(err as Error).message}`)),
    SWEEP_MS,
  );

  await pollMailboxes();
  await sweep();
}

await start();
