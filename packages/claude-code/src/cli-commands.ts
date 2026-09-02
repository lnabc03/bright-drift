import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import {
  AgentKnowledgeBase,
  ContentStore,
  createFileDiff,
  toRelativeKey,
  type AKBSnapshot,
} from 'bright-drift-core';
import { readJsonFile } from './shared/atomic.js';
import { pidAlive } from './shared/daemon-launch.js';
import {
  akbDir,
  pausedFile,
  pendingDir,
  sessionsDir,
  stateRoot,
  workspaceDir,
  workspaceFile,
  wsHash,
} from './shared/paths.js';
import type {
  PendingInjection,
  SessionEntry,
  WorkspaceInfo,
} from './shared/schema.js';

/**
 * Operator-facing subcommands (design §5.10): status / diff / pause /
 * resume / nodiff. All read or touch the state directory directly — no daemon RPC.
 * Everything here is best-effort and read-mostly; failures print, never
 * throw past main().
 */

/** Resolve the current workspace's hash + dir, or null when unknown. */
async function currentWorkspace(): Promise<{ hash: string } | null> {
  try {
    return { hash: await wsHash(process.cwd()) };
  } catch {
    return null;
  }
}

export async function cmdStatus(): Promise<number> {
  const ws = await currentWorkspace();
  if (!ws) {
    console.log('bright-drift: no state for this directory');
    return 0;
  }
  const info = await readJsonFile<WorkspaceInfo>(workspaceFile(ws.hash));
  const daemonUp = info !== undefined && pidAlive(info.daemonPid);

  let sessions: string[] = [];
  try {
    sessions = (await fs.readdir(sessionsDir(ws.hash))).filter((n) => n.endsWith('.json'));
  } catch {
    // none
  }

  let pendingCount = 0;
  let pendingKinds: string[] = [];
  try {
    for (const name of await fs.readdir(pendingDir(ws.hash))) {
      if (!name.endsWith('.json')) continue;
      const p = await readJsonFile<PendingInjection>(path.join(pendingDir(ws.hash), name));
      if (p && p.deliveredVia.length === 0) {
        pendingCount++;
        pendingKinds.push(`${p.priority}:${name.replace(/\.json$/, '').slice(0, 8)}`);
      }
    }
  } catch {
    // none
  }

  const paused = await fs
    .stat(pausedFile(ws.hash))
    .then(() => true)
    .catch(() => false);

  console.log(`bright-drift status (workspace ${ws.hash})`);
  console.log(`  daemon:    ${daemonUp ? `running (pid ${info!.daemonPid})` : 'not running'}`);
  console.log(`  sessions:  ${sessions.length} live`);
  console.log(`  pending:   ${pendingCount} undelivered${pendingKinds.length ? ` (${pendingKinds.join(', ')})` : ''}`);
  console.log(`  paused:    ${paused ? 'yes — monitoring continues, injection paused' : 'no'}`);
  console.log(`  state:     ${stateRoot()}`);
  return 0;
}

export async function cmdPause(): Promise<number> {
  const ws = await currentWorkspace();
  if (!ws) return 1;
  await fs.mkdir(path.dirname(pausedFile(ws.hash)), { recursive: true });
  await fs.writeFile(pausedFile(ws.hash), `${new Date().toISOString()}\n`, 'utf8');
  console.log('bright-drift paused: workspace monitoring continues, injection paused.');
  return 0;
}

export async function cmdResume(): Promise<number> {
  const ws = await currentWorkspace();
  if (!ws) return 1;
  await fs.rm(pausedFile(ws.hash), { force: true });
  console.log('bright-drift resumed: accumulated drift will be delivered in one batch.');
  return 0;
}

/**
 * On-demand diff preview (phase-1 `/bright-drift diff <path>` parity, §5.10):
 * the freshest persisted session AKB vs live disk. Read-only; the baseline is
 * the last DELIVERED state (snapshots persist at delivery-commit and stop),
 * so a just-observed agent write may be one save behind the daemon's memory.
 */
export async function cmdDiff(rel: string | undefined): Promise<number> {
  if (!rel) {
    console.error('usage: bright-drift-claude-code diff <path>');
    return 1;
  }
  const ws = await currentWorkspace();
  if (!ws) {
    console.log('bright-drift: no state for this directory');
    return 0;
  }
  const root = process.cwd();
  const key = toRelativeKey(root, path.resolve(root, rel));
  if (key === null) {
    console.error(`bright-drift: ${rel} is outside this workspace`);
    return 1;
  }

  const akbRoot = path.join(workspaceDir(ws.hash), 'akb');
  let latest: { sid: string; mtimeMs: number } | undefined;
  try {
    for (const sid of await fs.readdir(akbRoot)) {
      const st = await fs
        .stat(path.join(akbRoot, sid, 'state.json'))
        .catch(() => undefined);
      if (st && (!latest || st.mtimeMs > latest.mtimeMs)) latest = { sid, mtimeMs: st.mtimeMs };
    }
  } catch {
    // none
  }
  if (!latest) {
    console.log('bright-drift: no AKB snapshot yet for this workspace');
    return 0;
  }

  const data = await readJsonFile<{ version: number; akb: AKBSnapshot }>(
    path.join(akbDir(ws.hash, latest.sid), 'state.json'),
  );
  if (!data || data.version !== 1) {
    console.log('bright-drift: AKB snapshot unreadable (version mismatch or corrupt)');
    return 0;
  }
  const entry = AgentKnowledgeBase.fromSnapshot(data.akb).get(key);
  if (!entry) {
    console.log(`bright-drift: ${key} is not tracked by the AKB (never observed or reported)`);
    return 0;
  }

  const store = new ContentStore(path.join(akbDir(ws.hash, latest.sid), 'blobs'));
  const baseline = entry.contentRef !== undefined ? await store.get(entry.contentRef) : null;
  if (!baseline) {
    console.log(
      `bright-drift: no content baseline for ${key} (hash-only or not persisted); baseline hash ${entry.contentHash}`,
    );
    return 0;
  }

  let current: string;
  try {
    current = await fs.readFile(path.join(root, key), 'utf8');
  } catch {
    console.log(`bright-drift: ${key} no longer exists on disk (baseline hash ${entry.contentHash})`);
    return 0;
  }
  const diff = createFileDiff(baseline.toString('utf8'), current);
  if (!diff) {
    console.log(`bright-drift: ${key} matches the last delivered baseline — no drift`);
    return 0;
  }
  console.log(`${key}  (+${diff.added} -${diff.removed}, vs last delivered baseline)`);
  console.log(diff.patch);
  if (diff.truncated) console.log(`… ${diff.omittedLines} lines omitted`);
  return 0;
}

/** Append patterns to the project-level diff blacklist (D9 nodiff). */
export async function cmdNodiff(patterns: string[]): Promise<number> {
  if (patterns.length === 0) {
    console.error('usage: bright-drift-claude-code nodiff <glob> [more globs...]');
    return 1;
  }
  const file = path.join(process.cwd(), '.claude', 'bright-drift.yml');
  let doc: Record<string, unknown> = {};
  try {
    const parsed = parseYaml(await fs.readFile(file, 'utf8'));
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      doc = parsed as Record<string, unknown>;
    }
  } catch {
    // missing/unparseable — start fresh
  }
  const diff = (doc.diff ?? {}) as Record<string, unknown>;
  const existing = Array.isArray(diff.blacklist)
    ? diff.blacklist.filter((x): x is string => typeof x === 'string')
    : [];
  const merged = [...new Set([...existing, ...patterns])];
  doc.diff = { ...diff, blacklist: merged };
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, stringifyYaml(doc), 'utf8');
  console.log(`diff.blacklist now: ${merged.join(', ')}`);
  console.log('(daemon hot-reloads the project override within a second)');
  return 0;
}
