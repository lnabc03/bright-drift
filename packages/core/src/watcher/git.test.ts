import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { resolveGitTracked } from './git.js';

const hasGit = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasGit)('resolveGitTracked (D7)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(tmpdir(), 'bright-drift-git-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('distinguishes tracked from untracked inside a repo', async () => {
    execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
    await fs.writeFile(path.join(dir, 'tracked.ts'), 'x');
    execFileSync('git', ['add', 'tracked.ts'], { cwd: dir, stdio: 'ignore' });
    await fs.writeFile(path.join(dir, 'untracked.log'), 'x');
    const res = await resolveGitTracked(dir, ['tracked.ts', 'untracked.log']);
    expect(res.get('tracked.ts')).toBe('tracked');
    expect(res.get('untracked.log')).toBe('untracked');
  });

  it('reports unknown outside a git repo (cannot distinguish → gate reports, E20)', async () => {
    const res = await resolveGitTracked(dir, ['anything.ts']);
    expect(res.get('anything.ts')).toBe('unknown');
  });

  it('empty input short-circuits without spawning git', async () => {
    expect((await resolveGitTracked(dir, [])).size).toBe(0);
  });
});
