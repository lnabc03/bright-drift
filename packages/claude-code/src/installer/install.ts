import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicWriteFile, readJsonFile } from '../shared/atomic.js';
import { pidAlive } from '../shared/daemon-launch.js';
import { claudeConfigDir, installFile, stateRoot, workspacesRoot } from '../shared/paths.js';
import { SCHEMA_VERSION, type InstallInfo, type WorkspaceInfo } from '../shared/schema.js';

/**
 * settings.json injection installer (design §5.9, P2-D9). The plugin
 * hooks.json path is unreliable (#16288 OPEN), so hooks are merged directly
 * into the user's (or project's) settings.json — merged, never overwritten.
 */

export interface HookCommand {
  type: 'command';
  command: string;
  args: string[];
  async?: boolean;
}

export interface HookEntry {
  matcher?: string;
  hooks: HookCommand[];
}

/** Marker identifying a hook command as ours (path inside this package). */
const OWN_MARKER = `bright-drift-claude-code/lib/hooks/`;

/** Our six bundled filenames — distinctive enough to recognize under any lib/hooks/. */
const OWN_FILES = new Set([
  'session-start.js',
  'user-prompt-submit.js',
  'post-tool-use.js',
  'pre-tool-use-bash.js',
  'stop.js',
  'session-end.js',
]);

/** Absolute path of the bundled hooks directory, from any bundle depth. */
export function hooksDir(): string {
  // Explicit override for tests and unusual layouts.
  if (process.env.BRIGHT_DRIFT_HOOKS_DIR) return process.env.BRIGHT_DRIFT_HOOKS_DIR;
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.join(here, 'hooks');
}

/** The six hook entries (§5.9-1), exec form: no shell anywhere (B9). */
export function buildHookEntries(dir: string): Record<string, HookEntry[]> {
  const cmd = (file: string, extra?: Partial<HookCommand>): HookCommand => ({
    type: 'command',
    command: 'node',
    args: [path.join(dir, file)],
    ...extra,
  });
  return {
    SessionStart: [{ hooks: [cmd('session-start.js', { async: true })] }],
    UserPromptSubmit: [{ hooks: [cmd('user-prompt-submit.js')] }],
    PostToolUse: [
      {
        matcher: 'Read|Edit|Write|MultiEdit|NotebookEdit|Bash',
        hooks: [cmd('post-tool-use.js')],
      },
    ],
    PreToolUse: [{ matcher: 'Bash', hooks: [cmd('pre-tool-use-bash.js')] }],
    Stop: [{ hooks: [cmd('stop.js')] }],
    SessionEnd: [{ hooks: [cmd('session-end.js')] }],
  };
}

function isOwnCommand(hook: unknown): boolean {
  const h = hook as Partial<HookCommand>;
  if (h?.type !== 'command' || !Array.isArray(h.args) || typeof h.args[0] !== 'string') {
    return false;
  }
  const normalized = h.args[0].replaceAll('\\', '/');
  return (
    normalized.includes(OWN_MARKER) ||
    (normalized.includes('/lib/hooks/') && OWN_FILES.has(path.basename(normalized)))
  );
}

type Settings = Record<string, unknown> & { hooks?: Record<string, HookEntry[]> };

/**
 * Strip every bright-drift hook from a settings object (in place). Returns
 * the same object so callers can chain; unknown hooks are never touched.
 */
export function removeOwnHooks(settings: Settings): Settings {
  const hooks = settings.hooks;
  if (!hooks) return settings;
  for (const event of Object.keys(hooks)) {
    const kept = (hooks[event] ?? [])
      .map((entry) => ({
        ...entry,
        hooks: (entry.hooks ?? []).filter((h) => !isOwnCommand(h)),
      }))
      .filter((entry) => entry.hooks.length > 0);
    if (kept.length > 0) hooks[event] = kept;
    else delete hooks[event];
  }
  if (Object.keys(hooks).length === 0) delete settings.hooks;
  return settings;
}

/** Merge our entries into a settings object: idempotent, additive (§5.9-1). */
export function mergeHooks(settings: Settings, entries: Record<string, HookEntry[]>): Settings {
  removeOwnHooks(settings);
  const hooks = (settings.hooks ??= {});
  for (const [event, list] of Object.entries(entries)) {
    hooks[event] = [...(hooks[event] ?? []), ...list];
  }
  return settings;
}

export interface InstallOptions {
  /** Install into <cwd>/.claude/settings.json instead of the user settings. */
  project?: boolean;
  /** Override the settings file path (tests). */
  settingsPath?: string;
}

export function settingsPathFor(opts: InstallOptions): string {
  if (opts.settingsPath) return opts.settingsPath;
  return opts.project
    ? path.join(process.cwd(), '.claude', 'settings.json')
    : path.join(claudeConfigDir(), 'settings.json');
}

/**
 * Slash commands (design §5.10): markdown files under
 * <claude>/commands/bright-drift/ — user-level by default, project-level with
 * --project. Each body is a single inline `!` execution of the bundled cli.
 */
export function commandsDirFor(opts: InstallOptions): string {
  return opts.project
    ? path.join(process.cwd(), '.claude', 'commands', 'bright-drift')
    : path.join(claudeConfigDir(), 'commands', 'bright-drift');
}

/** Forward-slash the cli path: the md bodies are read on every platform. */
function cliPath(): string {
  return path.join(hooksDir(), '..', 'cli.js').replaceAll('\\', '/');
}

export function buildSlashCommands(): Record<string, string> {
  const cli = cliPath();
  const md = (description: string, body: string): string =>
    `---\ndescription: ${description}\nallowed-tools: Bash(node *)\n---\n${body}\n`;
  return {
    'status.md': md(
      'bright-drift workspace status (daemon, sessions, pending drift)',
      `!\`node "${cli}" status\``,
    ),
    'pause.md': md(
      'Pause drift injection for this workspace (monitoring continues)',
      `!\`node "${cli}" pause\``,
    ),
    'resume.md': md(
      'Resume drift injection; accumulated drift arrives in one batch',
      `!\`node "${cli}" resume\``,
    ),
    'nodiff.md': md(
      'Suppress line-level diffs for paths matching the given glob(s)',
      `!\`node "${cli}" nodiff $ARGUMENTS\``,
    ),
  };
}

async function writeSlashCommands(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  for (const [name, content] of Object.entries(buildSlashCommands())) {
    await atomicWriteFile(path.join(dir, name), content);
  }
}

async function removeSlashCommands(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
}

async function readSettings(file: string): Promise<Settings> {
  return (await readJsonFile<Settings>(file)) ?? {};
}

/** Installer dry-run (§5.9-3): prove node can execute the bundled hook and
 *  the state root is writable. Selftest mode never spawns the daemon. */
export function selfcheck(dir: string): { ok: boolean; detail: string } {
  const res = spawnSync(process.execPath, [path.join(dir, 'session-start.js')], {
    input: JSON.stringify({ session_id: 'selftest', cwd: process.cwd(), source: 'startup' }),
    env: { ...process.env, BRIGHT_DRIFT_SELFTEST: '1' },
    encoding: 'utf8',
    timeout: 10_000,
  });
  if (res.error) return { ok: false, detail: String(res.error) };
  if (res.status !== 0) return { ok: false, detail: `exit ${res.status}: ${res.stderr}` };
  try {
    const out = JSON.parse(res.stdout) as { ok?: boolean; stateRoot?: string };
    return out.ok
      ? { ok: true, detail: `state root: ${out.stateRoot ?? stateRoot()}` }
      : { ok: false, detail: `unexpected output: ${res.stdout}` };
  } catch {
    return { ok: false, detail: `unparseable output: ${res.stdout}` };
  }
}

export async function install(opts: InstallOptions): Promise<{ settingsPath: string }> {
  const dir = hooksDir();
  const settingsPath = settingsPathFor(opts);
  const settings = await readSettings(settingsPath);
  mergeHooks(settings, buildHookEntries(dir));
  await atomicWriteFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  await writeSlashCommands(commandsDirFor(opts));

  const stamp: InstallInfo = {
    version: SCHEMA_VERSION,
    installedAt: Date.now(),
    hooksPath: dir,
    settingsTarget: settingsPath,
  };
  await atomicWriteFile(installFile(), JSON.stringify(stamp));
  return { settingsPath };
}

export interface UninstallOptions extends InstallOptions {
  /** Also delete the state directory (default: keep). */
  purge?: boolean;
}

/** Stop every recorded daemon (§5.9-4: stop daemons BEFORE removing hooks). */
export async function stopDaemons(): Promise<number> {
  let stopped = 0;
  let hashes: string[] = [];
  try {
    hashes = await fs.readdir(workspacesRoot());
  } catch {
    return 0;
  }
  for (const hash of hashes) {
    const info = await readJsonFile<WorkspaceInfo>(
      path.join(workspacesRoot(), hash, 'workspace.json'),
    );
    if (info && pidAlive(info.daemonPid)) {
      try {
        process.kill(info.daemonPid, 'SIGTERM');
        stopped++;
      } catch {
        // already gone
      }
    }
  }
  return stopped;
}

export async function uninstall(opts: UninstallOptions): Promise<{ settingsPath: string }> {
  const settingsPath = settingsPathFor(opts);
  await stopDaemons();
  const settings = await readSettings(settingsPath);
  removeOwnHooks(settings);
  await atomicWriteFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  await removeSlashCommands(commandsDirFor(opts));
  if (opts.purge) {
    await fs.rm(stateRoot(), { recursive: true, force: true }).catch(() => {});
  }
  return { settingsPath };
}
