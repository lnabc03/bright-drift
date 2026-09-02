import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { readJsonFile } from './shared/atomic.js';
import { pidAlive } from './shared/daemon-launch.js';
import {
  pausedFile,
  pendingDir,
  sessionsDir,
  stateRoot,
  workspaceFile,
  wsHash,
} from './shared/paths.js';
import type {
  PendingInjection,
  SessionEntry,
  WorkspaceInfo,
} from './shared/schema.js';

/**
 * Operator-facing subcommands (design §5.10): status / pause / resume /
 * nodiff. All read or touch the state directory directly — no daemon RPC.
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
