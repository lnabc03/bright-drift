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

  it('forceInclude keeps a gitignored override file (and its dir) visible', async () => {
    // The project override lives in `.dsh/`, which is conventionally
    // gitignored — without forceInclude its edits never reach the pipeline.
    await fs.writeFile(path.join(dir, '.gitignore'), '.dsh/\n');
    const plain = await createIgnoreMatcher(dir);
    expect(plain('.dsh/bright-drift.yml')).toBe(true);

    const forced = await createIgnoreMatcher(dir, { forceInclude: ['.dsh/bright-drift.yml'] });
    expect(forced('.dsh')).toBe(false); // ancestor stays traversable
    expect(forced('.dsh/bright-drift.yml')).toBe(false); // the override itself
    expect(forced('.dsh/other.json')).toBe(true); // siblings stay ignored
    expect(forced('src/a.ts')).toBe(false); // no collateral widening
  });

  it('forceInclude also lifts a built-in table entry', async () => {
    const match = await createIgnoreMatcher(dir, {
      respectGitignore: false,
      forceInclude: ['dist/keep.json'],
    });
    expect(match('dist/keep.json')).toBe(false);
    expect(match('dist/other.js')).toBe(true);
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
