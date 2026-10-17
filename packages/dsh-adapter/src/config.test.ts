import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
  Config,
  DEFAULT_CONFIG,
  ConfigResolver,
  mergeConfig,
  readProjectOverride,
  snapshotConfig,
  type PluginConfig,
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

describe('Config schema + snapshotConfig (0.4.0, D10)', () => {
  /** Parse raw patch data through the real schemastery schema. */
  const parse = (raw: unknown): PluginConfig => Config(raw as Record<string, unknown>) as PluginConfig;

  it('resolves defaults from empty input (volatile refs → plain snapshot)', () => {
    const parsed = parse({});
    // Volatile references, not plain values.
    expect(typeof parsed.enabled.get).toBe('function');
    expect(typeof parsed.budget.get).toBe('function');
    expect(snapshotConfig(parsed)).toEqual(DEFAULT_CONFIG);
  });

  it('accepts a user patch and keeps unspecified fields at defaults', () => {
    const resolved = snapshotConfig(parse({ inject: { onPreStep: false } }));
    expect(resolved.inject.onPreStep).toBe(false);
    expect(resolved.inject.onSessionStart).toBe(true);
  });

  it('legacy settings.yaml section round-trips field-for-field (0.2.0 auto-import)', () => {
    // A complete 0.1.x settings.yaml `bright-drift:` section. The host's
    // legacy import feeds it to this schema verbatim; any field rename
    // would reject the import and strand the user's config.
    const legacy = {
      enabled: false,
      watch: { respectGitignore: false, extraIgnore: ['dist/**'], includeUntracked: true },
      budget: { maxDiffLinesPerFile: 100, maxTotalDiffLines: 500, maxInjectTokens: 1500, maxDriftFilesForDiff: 20 },
      diff: { contextLines: 5, maxFileSizeKB: 256, blacklist: ['*.env'] },
      baseline: { maxEntries: 1000, persist: false, persistContent: false, contentStoreMaxMB: 64 },
      inject: { onSessionStart: false, onPreStep: false, promptSection: false },
      attribution: { bashWindowGraceMs: 2000, longCommandMs: 20000, formatterWindowMs: 500, formatterSilent: true },
    };
    expect(snapshotConfig(parse(legacy))).toEqual(legacy);
  });

  it('locks the section/leaf names against the legacy vocabulary', () => {
    const resolved = snapshotConfig(parse({}));
    expect(Object.keys(resolved).sort()).toEqual(
      ['attribution', 'baseline', 'budget', 'diff', 'enabled', 'inject', 'watch'].sort(),
    );
    expect(Object.keys(resolved.watch).sort()).toEqual(['extraIgnore', 'includeUntracked', 'respectGitignore'].sort());
    expect(Object.keys(resolved.budget).sort()).toEqual(
      ['maxDiffLinesPerFile', 'maxDriftFilesForDiff', 'maxInjectTokens', 'maxTotalDiffLines'].sort(),
    );
    expect(Object.keys(resolved.diff).sort()).toEqual(['blacklist', 'contextLines', 'maxFileSizeKB'].sort());
    expect(Object.keys(resolved.baseline).sort()).toEqual(
      ['contentStoreMaxMB', 'maxEntries', 'persist', 'persistContent'].sort(),
    );
    expect(Object.keys(resolved.inject).sort()).toEqual(['onPreStep', 'onSessionStart', 'promptSection'].sort());
    expect(Object.keys(resolved.attribution).sort()).toEqual(
      ['bashWindowGraceMs', 'formatterSilent', 'formatterWindowMs', 'longCommandMs'].sort(),
    );
  });

  it('a volatile reference reflects its parsed value via .get()', () => {
    const parsed = parse({ diff: { blacklist: ['*.md'] } });
    expect(parsed.diff.get()).toMatchObject({ contextLines: 3, blacklist: ['*.md'] });
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
