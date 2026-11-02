import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
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

/** Our seven bundled filenames — distinctive enough to recognize under any lib/hooks/. */
const OWN_FILES = new Set([
  'session-start.js',
  'user-prompt-submit.js',
  'post-tool-use.js',
  'pre-tool-use-bash.js',
  'tool-settled.js',
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

/**
 * Locations that can disappear between sessions: the npx cache (`_npx`) and
 * temporary extraction directories. Hooks pointing there fail with
 * MODULE_NOT_FOUND once npm prunes the cache (observed 2026-11: logs stopped
 * 2026-09-28, `_npx/<hash>` was gone by 2026-10-09). Installs from such
 * locations must be relocated before hooks are written.
 */
export function isEphemeralLocation(p: string): boolean {
  const norm = path.resolve(p).replaceAll('\\', '/').toLowerCase();
  if (norm.split('/').includes('_npx')) return true;
  const tmp = path.resolve(tmpdir()).replaceAll('\\', '/').toLowerCase();
  return norm === tmp || norm.startsWith(`${tmp}/`);
}

/**
 * Stable home for the deployed runtime. Deliberately outside the state root:
 * `uninstall --purge` deletes the state root but must not strand live hooks.
 */
export function runtimeRoot(): string {
  return path.join(claudeConfigDir(), 'bright-drift', 'runtime');
}

/**
 * Return a hooks dir that will still exist next session. A package running
 * from a stable install (global npm/pnpm, local checkout) is used in place;
 * an ephemeral one (npx cache, temp dir) is copied wholesale to
 * `<claude>/bright-drift/runtime/lib` and hooks point there. `install` is the
 * only sync point, so the previous copy is replaced on every run.
 */
export async function deployStableHooks(sourceHooksDir: string): Promise<string> {
  if (!isEphemeralLocation(sourceHooksDir)) return sourceHooksDir;
  const sourceLib = path.dirname(sourceHooksDir);
  const targetLib = path.join(runtimeRoot(), 'lib');
  await fs.rm(targetLib, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  await fs.mkdir(path.dirname(targetLib), { recursive: true });
  await fs.cp(sourceLib, targetLib, { recursive: true });
  // ESM marker: without it every hook run pays a parse retry and prints a
  // MODULE_TYPELESS_PACKAGE_JSON warning on stderr.
  let version = '0.0.0';
  try {
    const pkg = JSON.parse(
      await fs.readFile(path.join(path.dirname(sourceLib), 'package.json'), 'utf8'),
    ) as { version?: string };
    version = pkg.version ?? version;
  } catch {
    // Source package.json unavailable: keep the marker with a placeholder.
  }
  await atomicWriteFile(
    path.join(path.dirname(targetLib), 'package.json'),
    `${JSON.stringify({ name: 'bright-drift-claude-code', version, type: 'module', private: true }, null, 2)}\n`,
  );
  return path.join(targetLib, 'hooks');
}

/** The eight hook entries (§5.9-1), exec form: no shell anywhere (B9). */
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
    // A Bash call that fails or is denied never reaches PostToolUse — these
    // two events close the attribution window instead (design §5.5.1).
    PostToolUseFailure: [{ matcher: 'Bash', hooks: [cmd('tool-settled.js')] }],
    PermissionDenied: [{ matcher: 'Bash', hooks: [cmd('tool-settled.js')] }],
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
function cliPath(fromHooks = hooksDir()): string {
  return path.join(fromHooks, '..', 'cli.js').replaceAll('\\', '/');
}

export function buildSlashCommands(fromHooks = hooksDir()): Record<string, string> {
  const cli = cliPath(fromHooks);
  // Custom slash commands are prompt templates — CC has no client-side-only
  // command type, so the bang output always reaches the model. The trailing
  // instruction keeps the round-trip terse: relay verbatim, no commentary.
  const RELAY =
    '\n上面的 Bash 输出就是命令的完整结果。请原样转述给用户，不要添加解释、评论或后续动作。';
  const md = (description: string, body: string): string =>
    `---\ndescription: ${description}\nallowed-tools: Bash(node *)\n---\n${body}\n${RELAY}\n`;
  return {
    'status.md': md(
      'bright-drift workspace status (daemon, sessions, pending drift)',
      `!\`node "${cli}" status\``,
    ),
    'diff.md': md(
      'Diff a workspace file against the last delivered baseline',
      `!\`node "${cli}" diff $ARGUMENTS\``,
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

async function writeSlashCommands(dir: string, fromHooks = hooksDir()): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  for (const [name, content] of Object.entries(buildSlashCommands(fromHooks))) {
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

export async function install(
  opts: InstallOptions,
): Promise<{ settingsPath: string; stoppedDaemons: number; hooksDir: string; relocated: boolean }> {
  // npx cache/temp installs are relocated so the hook paths outlive the cache.
  const source = hooksDir();
  const dir = await deployStableHooks(source);
  const settingsPath = settingsPathFor(opts);
  const settings = await readSettings(settingsPath);
  mergeHooks(settings, buildHookEntries(dir));
  await atomicWriteFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  await writeSlashCommands(commandsDirFor(opts), dir);

  const stamp: InstallInfo = {
    version: SCHEMA_VERSION,
    installedAt: Date.now(),
    hooksPath: dir,
    settingsTarget: settingsPath,
  };
  await atomicWriteFile(installFile(), JSON.stringify(stamp));
  // Upgrades: hooks are short-lived and pick up the new lib/ on their next
  // invocation, but a RUNNING daemon holds the old code in memory and
  // ensureDaemon would idempotently reuse it — stop all daemons so the next
  // SessionStart launches the freshly installed build (smoke test 2026-09-02:
  // fixes appeared not to work until daemons were killed by hand).
  const stoppedDaemons = await stopDaemons();
  return { settingsPath, stoppedDaemons, hooksDir: dir, relocated: dir !== source };
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
