import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkTmp } from '../testkit.js';
import {
  ConfigReloader,
  ConfigResolver,
  DEFAULT_CONFIG,
  MAX_INJECT_CHARS,
  mergeConfig,
} from './config.js';

let stateHome: string;
let ws: string;

beforeEach(async () => {
  stateHome = await mkTmp('bd-config-state-');
  ws = await mkTmp('bd-config-ws-');
  process.env.BRIGHT_DRIFT_STATE_HOME = stateHome;
});

afterEach(async () => {
  delete process.env.BRIGHT_DRIFT_STATE_HOME;
  await fs.rm(stateHome, { recursive: true, force: true });
  await fs.rm(ws, { recursive: true, force: true });
});

describe('mergeConfig', () => {
  it('keeps defaults on garbage and merges typed fields', () => {
    const merged = mergeConfig(DEFAULT_CONFIG, {
      enabled: false,
      budget: { maxInjectTokens: 500, nope: 1 },
      diff: { blacklist: ['*.pem'] },
      attribution: { longCommandMs: 'fast' },
    });
    expect(merged.enabled).toBe(false);
    expect(merged.budget.maxInjectTokens).toBe(500);
    expect(merged.diff.blacklist).toEqual(['*.pem']);
    expect(merged.attribution.longCommandMs).toBe(10_000);
  });

  it('does not mutate the base', () => {
    mergeConfig(DEFAULT_CONFIG, { enabled: false });
    expect(DEFAULT_CONFIG.enabled).toBe(true);
  });
});

describe('ConfigResolver + ConfigReloader', () => {
  it('resolves global config.yml, then project override wins', async () => {
    await fs.writeFile(
      path.join(stateHome, 'config.yml'),
      'budget:\n  maxInjectTokens: 1000\ninject:\n  onStop: false\n',
    );
    await fs.mkdir(path.join(ws, '.claude'), { recursive: true });
    await fs.writeFile(
      path.join(ws, '.claude', 'bright-drift.yml'),
      'budget:\n  maxInjectTokens: 300\n',
    );

    const resolver = new ConfigResolver();
    await resolver.reloadGlobal();
    await resolver.reloadOverride(ws);
    const cfg = resolver.resolve();
    expect(cfg.budget.maxInjectTokens).toBe(300); // project wins
    expect(cfg.inject.onStop).toBe(false); // global applies
    expect(cfg.inject.onUserPrompt).toBe(true); // default survives
  });

  it('missing files resolve to pure defaults', async () => {
    const resolver = new ConfigResolver();
    await resolver.reloadGlobal();
    await resolver.reloadOverride(ws);
    expect(resolver.resolve()).toEqual(DEFAULT_CONFIG);
  });

  it('poll() reports changes and hot-reloads', async () => {
    const resolver = new ConfigResolver();
    const reloader = new ConfigReloader(resolver, ws);
    await reloader.initial();
    expect(resolver.resolve().budget.maxInjectTokens).toBe(2000);

    await fs.writeFile(path.join(stateHome, 'config.yml'), 'budget:\n  maxInjectTokens: 42\n');
    // mtime granularity: make sure it moved
    await new Promise((r) => setTimeout(r, 20));
    expect(await reloader.poll()).toBe(true);
    expect(resolver.resolve().budget.maxInjectTokens).toBe(42);
    expect(await reloader.poll()).toBe(false); // stable again
  });

  it('char red line constant matches the design value (E4)', () => {
    expect(MAX_INJECT_CHARS).toBe(9500);
  });
});
