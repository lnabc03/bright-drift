#!/usr/bin/env node
/**
 * bright-drift boot smoke test against the locally installed dsh 0.2.0 host
 * (design §7.2 layer 2, D10). Productizes the audit's reproduction:
 *
 *   1. isolated DSH_HOME (never touches the real ~/.dsh)
 *   2. non-shipped profile from the official web template
 *   3. bright-drift linked from THIS repo build (junction, not npm)
 *   4. declarative agent so session lifecycle fires without a model request
 *   5. assert plugin.applied / config.applied / session.start /
 *      watcher.acquired appear and NO `*.error` event is logged
 *   6. volatile hot-update phase: edit the profile patch, expect a second
 *      config.applied WITHOUT plugin.disposed (remount would drop the
 *      unpersisted DriftQueue — §6.2 of the 0.2.0 audit)
 *
 * Prereqs: `pnpm --filter bright-drift build`, a `dsh` CLI on PATH.
 * Usage:   node scripts/smoke-dsh.mjs [--keep]
 */
import { spawn, spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const keep = process.argv.includes('--keep');
const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dshBin = process.platform === 'win32' ? 'dsh.cmd' : 'dsh';
const PROFILE = 'bdsmoke';
const BOOT_TIMEOUT_MS = 90_000;
const HOT_UPDATE_TIMEOUT_MS = 45_000;

const failures = [];
const assert = (cond, what) => {
  if (cond) console.log(`  ✓ ${what}`);
  else {
    failures.push(what);
    console.error(`  ✗ ${what}`);
  }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function readLog(home) {
  const dir = path.join(home, 'logs', 'bright-drift');
  try {
    const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.log'));
    let text = '';
    for (const f of files) text += await fs.readFile(path.join(dir, f), 'utf8');
    return text;
  } catch {
    return '';
  }
}

const events = (log) =>
  log
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line).event;
      } catch {
        return undefined;
      }
    })
    .filter(Boolean);

async function waitFor(fn, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await sleep(500);
  }
  console.error(`  … timed out waiting for: ${what}`);
  return false;
}

function killTree(child) {
  if (!child || child.killed) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore' });
  } else {
    try {
      process.kill(-child.pid, 'SIGKILL'); // process group
    } catch {
      child.kill('SIGKILL');
    }
  }
}

async function main() {
  // 0) Prereqs: built plugin + dsh CLI.
  await fs.access(path.join(pkgDir, 'lib', 'index.js')).catch(() => {
    throw new Error('lib/index.js missing — run `pnpm --filter bright-drift build` first');
  });
  const version = spawnSync(dshBin, ['--version'], { encoding: 'utf8', shell: process.platform === 'win32' });
  if (version.error || version.status !== 0) throw new Error('dsh CLI not found on PATH');
  console.log(`dsh ${String(version.stdout).trim()} — building isolated smoke profile`);

  // 1) Isolated DSH_HOME + probe workspace.
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'bright-drift-smoke-'));
  const probeWs = path.join(home, 'probe-ws');
  await fs.mkdir(probeWs, { recursive: true });
  const env = { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1' };
  console.log(`DSH_HOME=${home}`);
  let child;

  try {
    // 2) Materialize a non-shipped profile from the official web template.
    const created = spawnSync(dshBin, [PROFILE, '--from-default-profile', 'web', '--dump-config'], {
      env,
      encoding: 'utf8',
      shell: process.platform === 'win32',
    });
    if (created.status !== 0) {
      throw new Error(`profile creation failed:\n${created.stdout}\n${created.stderr}`);
    }
    const profileDir = path.join(home, 'profiles', PROFILE);

    // 3) Link the local build into the profile and register the bundle.
    await fs.mkdir(path.join(profileDir, 'node_modules'), { recursive: true });
    await fs.symlink(pkgDir, path.join(profileDir, 'node_modules', 'bright-drift'), 'junction');
    const pkgJsonPath = path.join(profileDir, 'package.json');
    const pkgJson = JSON.parse(await fs.readFile(pkgJsonPath, 'utf8'));
    pkgJson.dsh ??= {};
    pkgJson.dsh.profile ??= {};
    pkgJson.dsh.profile.bundles = [...(pkgJson.dsh.profile.bundles ?? []), 'bright-drift'];
    await fs.writeFile(pkgJsonPath, JSON.stringify(pkgJson, null, 2), 'utf8');

    // 4) Declarative agent: session lifecycle fires with no model request.
    //    A fresh profile's cordis.patch.yml is a comment header plus a bare
    //    `[]` document — appending after it would form a second YAML
    //    document and fail parsing, so the `[]` line is replaced instead.
    const patchPath = path.join(profileDir, 'cordis.patch.yml');
    const basePatch = await fs.readFile(patchPath, 'utf8').catch(() => '');
    const agentBlock =
      `# smoke: declarative agent so agent/created fires without a model request\n` +
      `- id: agent-loop\n` +
      `  config:\n` +
      `    agents:\n` +
      `      - id: smoke\n` +
      `        cwd: ${probeWs.replaceAll('\\', '/')}\n`;
    const mergedPatch = /^\s*\[\]\s*$/m.test(basePatch)
      ? basePatch.replace(/^\s*\[\]\s*$/m, agentBlock.trimEnd())
      : `${basePatch.trimEnd()}\n${agentBlock}`;
    await fs.writeFile(patchPath, mergedPatch.endsWith('\n') ? mergedPatch : `${mergedPatch}\n`, 'utf8');

    // 5) Boot the web host headlessly.
    console.log('booting host (headless web profile + declarative agent)…');
    child = spawn(dshBin, ['--profile', PROFILE, '--no-open', '--port', '0'], {
      env,
      shell: process.platform === 'win32',
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stderr.on('data', () => {}); // drain; assertions read the plugin log

    const booted = await waitFor(
      async () => events(await readLog(home)).includes('watcher.acquired'),
      BOOT_TIMEOUT_MS,
      'watcher.acquired',
    );
    const evs = events(await readLog(home));
    console.log('phase 1 — boot & session lifecycle:');
    assert(booted, 'watcher.acquired observed (agent/created → registry → watcher)');
    assert(evs.includes('plugin.applied'), 'plugin.applied logged');
    assert(evs.includes('config.applied'), 'config.applied logged (declarative Config path)');
    assert(evs.includes('session.start'), 'session.start logged (agent/created listener fired)');
    assert(
      !evs.some((e) => e.endsWith('.error')),
      `no *.error events${evs.some((e) => e.endsWith('.error')) ? ` — got: ${evs.filter((e) => e.endsWith('.error')).join(', ')}` : ''}`,
    );

    // 6) Volatile hot update: edit the profile patch, expect config.applied
    //    again and NO plugin.disposed (remount would lose the DriftQueue).
    if (booted) {
      console.log('phase 2 — volatile config hot update:');
      const before = events(await readLog(home)).filter((e) => e === 'config.applied').length;
      await fs.appendFile(
        patchPath,
        `\n# smoke: volatile-only edit must hot-commit without remount\n` +
          `- id: bright-drift\n` +
          `  config:\n` +
          `    budget:\n` +
          `      maxInjectTokens: 1500\n`,
        'utf8',
      );
      const hot = await waitFor(
        async () => events(await readLog(home)).filter((e) => e === 'config.applied').length > before,
        HOT_UPDATE_TIMEOUT_MS,
        'second config.applied',
      );
      const evs2 = events(await readLog(home));
      assert(hot, 'loader/volatile-update reached applyConfig (second config.applied)');
      assert(
        !evs2.includes('plugin.disposed'),
        'no remount on volatile edit (plugin.disposed absent → DriftQueue survives)',
      );

      // 7) Detection half of T1: an external file creation in the watched
      //    workspace must reconcile into a drift record. (The injection half
      //    needs a model request — covered by the T1–T13 matrix, not here.)
      console.log('phase 3 — watcher → drift detection (T1 detection half):');
      await fs.writeFile(path.join(probeWs, 'drift-target.txt'), `smoke ${Date.now()}\n`, 'utf8');
      const detected = await waitFor(
        async () => events(await readLog(home)).includes('drift.detected'),
        30_000,
        'drift.detected',
      );
      assert(detected, 'external create detected (watcher → pipeline → drift.detected)');
    }
  } finally {
    killTree(child);
    if (keep || failures.length > 0) {
      console.log(`smoke home kept at: ${home}`);
    } else {
      await fs.rm(home, { recursive: true, force: true }).catch(() => {});
    }
  }

  if (failures.length > 0) {
    console.error(`\nSMOKE FAILED (${failures.length}):`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log('\nSMOKE PASSED');
}

main().catch((error) => {
  console.error(`smoke harness error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
