import { createHash } from 'node:crypto';
import { promises as fs, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';

/**
 * Claude Code config dir: $CLAUDE_CONFIG_DIR, else ~/.claude.
 * (CC itself honors CLAUDE_CONFIG_DIR; we follow it for consistency.)
 */
export function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR ?? path.join(homedir(), '.claude');
}

/**
 * State root for everything bright-drift persists (phase-2 design §4.1, P2-D3).
 * BRIGHT_DRIFT_STATE_HOME overrides it — used by tests and the e2e sandbox so
 * they never touch the real ~/.claude/state tree.
 */
export function stateRoot(): string {
  return (
    process.env.BRIGHT_DRIFT_STATE_HOME ??
    path.join(claudeConfigDir(), 'state', 'bright-drift')
  );
}

export function configFile(): string {
  return path.join(stateRoot(), 'config.yml');
}

export function installFile(): string {
  return path.join(stateRoot(), 'install.json');
}

export function logsDir(): string {
  return path.join(stateRoot(), 'logs');
}

function hashPath(p: string): string {
  return createHash('sha1').update(path.resolve(p)).digest('hex').slice(0, 16);
}

/**
 * Workspace hash: sha1(realpath(cwd))[:16] (§4.1, B6). realpath collapses
 * symlink / git-worktree aliases of the same tree onto one daemon.
 */
export async function wsHash(cwd: string): Promise<string> {
  try {
    return hashPath(await fs.realpath(cwd));
  } catch {
    // Unreadable cwd: fall back to the literal path; the hash is still stable.
    return hashPath(cwd);
  }
}

/** Sync variant for hot paths where an async hop is awkward. */
export function wsHashSync(cwd: string): string {
  try {
    return hashPath(realpathSync(cwd));
  } catch {
    return hashPath(cwd);
  }
}

export function workspacesRoot(): string {
  return path.join(stateRoot(), 'workspaces');
}

export function workspaceDir(hash: string): string {
  return path.join(workspacesRoot(), hash);
}

export function workspaceFile(hash: string): string {
  return path.join(workspaceDir(hash), 'workspace.json');
}

export function lockFile(hash: string): string {
  return path.join(workspaceDir(hash), 'daemon.lock');
}

export function sessionsDir(hash: string): string {
  return path.join(workspaceDir(hash), 'sessions');
}

export function sessionFile(hash: string, sessionId: string): string {
  return path.join(sessionsDir(hash), `${sessionId}.json`);
}

export function mailboxRoot(hash: string): string {
  return path.join(workspaceDir(hash), 'mailbox');
}

export function mailboxDir(hash: string, sessionId: string): string {
  return path.join(mailboxRoot(hash), sessionId);
}

export function pendingDir(hash: string): string {
  return path.join(workspaceDir(hash), 'pending');
}

export function pendingFile(hash: string, sessionId: string): string {
  return path.join(pendingDir(hash), `${sessionId}.json`);
}

export function akbDir(hash: string, sessionId: string): string {
  return path.join(workspaceDir(hash), 'akb', sessionId);
}

/** Path list the PreToolUse hook stats for the attribution pre-snapshot (§5.5.2). */
export function akbPathsFile(hash: string): string {
  return path.join(workspaceDir(hash), 'akb-paths.json');
}

export function pausedFile(hash: string): string {
  return path.join(workspaceDir(hash), 'paused');
}

export async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

/** Create the full per-workspace directory skeleton (idempotent). */
export async function ensureWorkspaceDirs(hash: string): Promise<void> {
  await Promise.all([
    ensureDir(sessionsDir(hash)),
    ensureDir(mailboxRoot(hash)),
    ensureDir(pendingDir(hash)),
    ensureDir(path.join(workspaceDir(hash), 'akb')),
  ]);
}
