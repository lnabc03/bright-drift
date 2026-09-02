import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { createIgnoreMatcher, createPatternMatcher, BUILTIN_IGNORE } from './ignore.js';

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(tmpdir(), 'bright-drift-ignore-'));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('createIgnoreMatcher', () => {
  it('built-in table covers node_modules, .git, dist', async () => {
    const match = await createIgnoreMatcher(dir, { respectGitignore: false });
    for (const d of ['node_modules/x/y.js', '.git/HEAD', 'dist/bundle.js']) {
      expect(match(d), d).toBe(true);
    }
    expect(match('src/index.ts')).toBe(false);
    expect(BUILTIN_IGNORE).toContain('node_modules');
  });

  it('respects the workspace .gitignore', async () => {
    await fs.writeFile(path.join(dir, '.gitignore'), 'logs/\n*.tmp\n!keep.tmp\n');
    const match = await createIgnoreMatcher(dir);
    expect(match('logs/a.log')).toBe(true);
    expect(match('data/file.tmp')).toBe(true);
    expect(match('data/keep.tmp')).toBe(false); // negation honored
    expect(match('src/a.ts')).toBe(false);
  });

  it('missing .gitignore is fine (fail-open)', async () => {
    const match = await createIgnoreMatcher(dir);
    expect(match('src/a.ts')).toBe(false);
  });

  it('extraIgnore patterns apply on top', async () => {
    const match = await createIgnoreMatcher(dir, {
      respectGitignore: false,
      extraIgnore: ['fixtures/**'],
    });
    expect(match('fixtures/sample.txt')).toBe(true);
    expect(match('src/a.ts')).toBe(false);
  });
});

describe('createPatternMatcher (D9)', () => {
  it('matches gitignore-style globs; empty list never matches', () => {
    const match = createPatternMatcher(['*.env', 'locks/**', 'package-lock.json']);
    expect(match('.env')).toBe(true);
    expect(match('locks/a.lock')).toBe(true);
    expect(match('package-lock.json')).toBe(true);
    expect(match('src/index.ts')).toBe(false);
    expect(createPatternMatcher([])('anything.ts')).toBe(false);
    expect(match('')).toBe(false);
  });
});
