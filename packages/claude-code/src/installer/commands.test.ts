import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkTmp } from '../testkit.js';
import { cmdNodiff, cmdPause, cmdResume, cmdStatus } from '../cli-commands.js';
import { install, uninstall } from './install.js';

let dir: string;
let originalCwd: string;

beforeEach(async () => {
  dir = await mkTmp('bd-m6-');
  originalCwd = process.cwd();
  process.env.BRIGHT_DRIFT_STATE_HOME = path.join(dir, 'state');
  process.env.CLAUDE_CONFIG_DIR = path.join(dir, 'claude-home');
  process.env.BRIGHT_DRIFT_HOOKS_DIR = path.join(dir, 'pkg', 'lib', 'hooks');
  process.chdir(dir);
});

afterEach(async () => {
  process.chdir(originalCwd); // Windows: can't rm a dir that is our cwd
  delete process.env.BRIGHT_DRIFT_STATE_HOME;
  delete process.env.CLAUDE_CONFIG_DIR;
  delete process.env.BRIGHT_DRIFT_HOOKS_DIR;
  await fs.rm(dir, { recursive: true, force: true });
});

async function capture(fn: () => Promise<number>): Promise<{ code: number; out: string }> {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => lines.push(args.join(' '));
  try {
    return { code: await fn(), out: lines.join('\n') };
  } finally {
    console.log = orig;
  }
}

describe('pause / resume (§5.10)', () => {
  it('pause creates the marker, resume removes it', async () => {
    expect((await capture(cmdPause)).code).toBe(0);
    const { wsHash } = await import('../shared/paths.js');
    const hash = await wsHash(dir);
    await expect(fs.stat(path.join(dir, 'state', 'workspaces', hash, 'paused'))).resolves.toBeDefined();

    expect((await capture(cmdResume)).code).toBe(0);
    await expect(fs.stat(path.join(dir, 'state', 'workspaces', hash, 'paused'))).rejects.toThrow();
  });
});

describe('nodiff (D9)', () => {
  it('creates .claude/bright-drift.yml with the blacklist', async () => {
    const { code } = await capture(() => cmdNodiff(['*.pem', 'secrets/**']));
    expect(code).toBe(0);
    const text = await fs.readFile(path.join(dir, '.claude', 'bright-drift.yml'), 'utf8');
    expect(text).toContain('"*.pem"');
    expect(text).toContain('secrets/**');
  });

  it('merges into an existing override without clobbering other keys', async () => {
    await fs.mkdir(path.join(dir, '.claude'), { recursive: true });
    await fs.writeFile(
      path.join(dir, '.claude', 'bright-drift.yml'),
      'budget:\n  maxInjectTokens: 777\ndiff:\n  blacklist:\n    - old/**\n',
    );
    await capture(() => cmdNodiff(['new/**']));
    const text = await fs.readFile(path.join(dir, '.claude', 'bright-drift.yml'), 'utf8');
    expect(text).toContain('maxInjectTokens: 777');
    expect(text).toContain('old/**');
    expect(text).toContain('new/**');
  });

  it('dedupes repeated patterns', async () => {
    await capture(() => cmdNodiff(['a/**']));
    await capture(() => cmdNodiff(['a/**', 'b/**']));
    const text = await fs.readFile(path.join(dir, '.claude', 'bright-drift.yml'), 'utf8');
    expect(text.match(/a\/\*\*/g)).toHaveLength(1);
  });
});

describe('status', () => {
  it('reports a clean workspace without throwing', async () => {
    const { code, out } = await capture(cmdStatus);
    expect(code).toBe(0);
    expect(out).toContain('bright-drift status');
    expect(out).toContain('not running');
  });
});

describe('diff (phase-1 parity)', () => {
  async function seedAkb(baseline: string): Promise<void> {
    const { wsHash } = await import('../shared/paths.js');
    const { createHash } = await import('node:crypto');
    const hash = await wsHash(dir);
    const ref = createHash('sha1').update(baseline).digest('hex');
    const akbDir = path.join(dir, 'state', 'workspaces', hash, 'akb', 's1');
    await fs.mkdir(path.join(akbDir, 'blobs', ref.slice(0, 2)), { recursive: true });
    await fs.writeFile(path.join(akbDir, 'blobs', ref.slice(0, 2), ref), baseline);
    await fs.writeFile(
      path.join(akbDir, 'state.json'),
      JSON.stringify({
        version: 1,
        akb: {
          version: 1,
          sessionId: 's1',
          savedAt: Date.now(),
          entries: {
            'a.txt': {
              contentHash: ref,
              contentRef: ref,
              mtimeMs: 1,
              size: baseline.length,
              source: 'read',
              updatedAt: 1,
            },
          },
        },
        attributor: { windows: [] },
      }),
    );
  }

  it('prints a unified diff against the persisted baseline', async () => {
    await seedAkb('line1\nline2\n');
    await fs.writeFile(path.join(dir, 'a.txt'), 'line1\nline2 CHANGED\n');
    const { cmdDiff } = await import('../cli-commands.js');
    const { code, out } = await capture(() => cmdDiff('a.txt'));
    expect(code).toBe(0);
    expect(out).toContain('a.txt');
    expect(out).toContain('+line2 CHANGED');
    expect(out).toContain('-line2');
  });

  it('reports no drift when disk matches the baseline, and untracked files', async () => {
    await seedAkb('same\n');
    await fs.writeFile(path.join(dir, 'a.txt'), 'same\n');
    const { cmdDiff } = await import('../cli-commands.js');
    expect((await capture(() => cmdDiff('a.txt'))).out).toContain('no drift');
    expect((await capture(() => cmdDiff('other.txt'))).out).toContain('not tracked');
    expect((await capture(() => cmdDiff(undefined))).code).toBe(1);
  });
});

describe('slash commands (§5.10)', () => {
  it('install writes five command markdown files, uninstall removes them', async () => {
    await install({ settingsPath: path.join(dir, 'settings.json') });
    const dirCmds = path.join(dir, 'claude-home', 'commands', 'bright-drift');
    const names = (await fs.readdir(dirCmds)).sort();
    expect(names).toEqual(['diff.md', 'nodiff.md', 'pause.md', 'resume.md', 'status.md']);
    const status = await fs.readFile(dirCmds + '/status.md', 'utf8');
    expect(status).toContain('allowed-tools: Bash(node *)');
    expect(status).toContain('cli.js" status');

    await uninstall({ settingsPath: path.join(dir, 'settings.json') });
    await expect(fs.stat(dirCmds)).rejects.toThrow();
  });

  it('--project writes commands under <cwd>/.claude/commands', async () => {
    await install({ project: true });
    const names = await fs.readdir(path.join(dir, '.claude', 'commands', 'bright-drift'));
    expect(names).toContain('status.md');
  });
});
