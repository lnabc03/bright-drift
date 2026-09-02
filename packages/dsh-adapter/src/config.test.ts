import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
  DEFAULT_CONFIG,
  ConfigResolver,
  mergeConfig,
  readProjectOverride,
  settingsSchema,
} from './config.js';

describe('mergeConfig', () => {
  it('returns defaults for empty/invalid overlays', () => {
    expect(mergeConfig(DEFAULT_CONFIG, undefined)).toEqual(DEFAULT_CONFIG);
    expect(mergeConfig(DEFAULT_CONFIG, { budget: 'garbage' } as never)).toEqual(DEFAULT_CONFIG);
  });

  it('merges field-wise and keeps unspecified fields', () => {
    const merged = mergeConfig(DEFAULT_CONFIG, {
      enabled: false,
      budget: { maxInjectTokens: 500 },
      watch: { extraIgnore: ['fixtures/**'] },
    } as never);
    expect(merged.enabled).toBe(false);
    expect(merged.budget.maxInjectTokens).toBe(500);
    expect(merged.budget.maxTotalDiffLines).toBe(1000);
    expect(merged.watch.extraIgnore).toEqual(['fixtures/**']);
    expect(merged.watch.respectGitignore).toBe(true);
  });

  it('rejects wrong-typed values and unknown keys', () => {
    const merged = mergeConfig(DEFAULT_CONFIG, {
      budget: { maxInjectTokens: 'lots', unknownKey: 1 },
    } as never);
    expect(merged.budget.maxInjectTokens).toBe(2000);
    expect('unknownKey' in merged.budget).toBe(false);
  });

  it('diff.blacklist defaults empty and merges as a string array (D9)', () => {
    expect(DEFAULT_CONFIG.diff.blacklist).toEqual([]);
    const merged = mergeConfig(DEFAULT_CONFIG, { diff: { blacklist: ['*.env', 'locks/**'] } } as never);
    expect(merged.diff.blacklist).toEqual(['*.env', 'locks/**']);
    const bad = mergeConfig(DEFAULT_CONFIG, { diff: { blacklist: [1, 2] } } as never);
    expect(bad.diff.blacklist).toEqual([]);
  });

  it('never mutates the base', () => {
    const before = structuredClone(DEFAULT_CONFIG);
    mergeConfig(DEFAULT_CONFIG, { enabled: false } as never);
    expect(DEFAULT_CONFIG).toEqual(before);
  });
});

describe('settingsSchema', () => {
  it('resolves defaults from undefined', () => {
    expect(settingsSchema(undefined)).toEqual(DEFAULT_CONFIG);
  });

  it('accepts a user section', () => {
    const resolved = settingsSchema({ inject: { onPreStep: false } });
    expect(resolved.inject.onPreStep).toBe(false);
    expect(resolved.inject.onSessionStart).toBe(true);
  });
});

describe('ConfigResolver project override (D2)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(tmpdir(), 'bright-drift-cfg-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('missing override file → global values', async () => {
    const resolver = new ConfigResolver();
    resolver.setGlobal({ budget: { maxInjectTokens: 777 } });
    await resolver.reloadOverride(dir);
    expect(resolver.resolve(dir).budget.maxInjectTokens).toBe(777);
  });

  it('project override wins over global', async () => {
    await fs.mkdir(path.join(dir, '.dsh'), { recursive: true });
    await fs.writeFile(
      path.join(dir, '.dsh', 'bright-drift.yml'),
      'budget:\n  maxInjectTokens: 123\nattribution:\n  formatterSilent: true\n',
    );
    const resolver = new ConfigResolver();
    resolver.setGlobal({ budget: { maxInjectTokens: 777 } });
    await resolver.reloadOverride(dir);
    const resolved = resolver.resolve(dir);
    expect(resolved.budget.maxInjectTokens).toBe(123);
    expect(resolved.attribution.formatterSilent).toBe(true);
    expect(resolved.budget.maxTotalDiffLines).toBe(1000); // untouched
  });

  it('invalid YAML override is ignored (fail-open)', async () => {
    expect(await readProjectOverride(dir)).toBeUndefined();
  });
});
