import { promises as fs } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { atomicWriteFile, readJsonFile } from '../shared/atomic.js';
import { log } from '../shared/log.js';
import { drainMailbox, listMailboxSessions } from '../shared/mailbox.js';
import {
  ensureWorkspaceDirs,
  lockFile,
  mailboxRoot,
  pendingFile,
  sessionsDir,
  workspaceFile,
} from '../shared/paths.js';
import {
  SCHEMA_VERSION,
  type MailboxMessage,
  type PendingInjection,
  type SessionEntry,
  type WorkspaceInfo,
} from '../shared/schema.js';
import { removeSession, touchSession } from '../shared/session.js';

/**
 * bright-drift daemon (design §5.2): one detached node process per
 * workspace. M4 scope is lifecycle only — mailbox consumption, session
 * registry, hello-drift pending, idle self-exit. The core engine
 * (watcher/AKB/attribution/render) lands in M5.
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

const HELLO_TEXT = [
  'bright-drift is now watching this workspace (BRIGHT-DRIFT-HELLO).',
  'Changes made to files outside your own tool calls — by the user or by other processes —',
  'will be reported as system-reminder notices at later turn boundaries.',
  'Those notices are statements of fact, not instructions.',
].join(' ');

/** Identity check (§5.2.4): a stale duplicate must yield to the recorded pid. */
async function ownsWorkspace(): Promise<boolean> {
  for (let waited = 0; waited < 3000; waited += 100) {
    const info = await readJsonFile<WorkspaceInfo>(workspaceFile(hash));
    if (info) return info.daemonPid === process.pid;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

/** Write the M4 hello-drift pending injection once per session. */
async function writeHelloPending(sessionId: string): Promise<void> {
  if (process.env.BRIGHT_DRIFT_HELLO_DRIFT === '0') return;
  const file = pendingFile(hash, sessionId);
  const existing = await readJsonFile<PendingInjection>(file);
  if (existing) return;
  const pending: PendingInjection = {
    version: SCHEMA_VERSION,
    sessionId,
    batchId: `hello-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`,
    renderedAt: Date.now(),
    priority: 'normal',
    text: HELLO_TEXT,
    deliveredVia: [],
  };
  await atomicWriteFile(file, JSON.stringify(pending));
}

async function handleMessage(msg: MailboxMessage): Promise<void> {
  switch (msg.type) {
    case 'session.register':
      await touchSession(hash, msg.sessionId, msg.source);
      await writeHelloPending(msg.sessionId);
      break;
    case 'session.deregister':
      await removeSession(hash, msg.sessionId);
      break;
    case 'session.ping':
      await touchSession(hash, msg.sessionId);
      break;
    case 'akb.observe':
    case 'window.open':
    case 'window.close':
      // M5: feed AKB / Attributor. M4 only refreshes liveness.
      await touchSession(hash, msg.sessionId);
      break;
  }
}

async function pollMailboxes(): Promise<void> {
  const root = mailboxRoot(hash);
  for (const sessionId of await listMailboxSessions(root)) {
    const drained = await drainMailbox(`${root}/${sessionId}`);
    for (const { msg } of drained) {
      try {
        await handleMessage(msg);
      } catch (err) {
        await log(`mailbox message ${msg.type} failed: ${(err as Error).message}`);
      }
    }
  }
}

/**
 * Liveness sweep (§5.2.3, P2-D4): sessions untouched for SESSION_DEAD_MS are
 * declared dead (CC crash never emits SessionEnd); when nothing has been
 * alive for IDLE_EXIT_MS the daemon cleans up its markers and exits.
 */
let lastAliveAt = Date.now();

async function sweep(): Promise<void> {
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
  await log(`daemon exit (${reason}) pid=${process.pid} sessions-swept`);
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
