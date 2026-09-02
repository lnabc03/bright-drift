import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { configFile } from './paths.js';

/**
 * CC config (phase-2 design §5.8). Schema is kept structurally in sync with
 * the phase-1 dsh adapter's config.ts; the `inject` section carries the CC
 * channel variants instead of the dsh ones. If the schemas ever fork, core
 * supports the superset.
 */
export interface BrightDriftConfig {
  enabled: boolean;
  watch: {
    respectGitignore: boolean;
    extraIgnore: string[];
    includeUntracked: boolean;
  };
  budget: {
    maxDiffLinesPerFile: number;
    maxTotalDiffLines: number;
    maxInjectTokens: number;
    maxDriftFilesForDiff: number;
  };
  diff: {
    contextLines: number;
    maxFileSizeKB: number;
    /** D9: gitignore-style globs whose diffs are suppressed (hash-only probe). */
    blacklist: string[];
  };
  baseline: {
    maxEntries: number;
    persist: boolean;
    persistContent: boolean;
    contentStoreMaxMB: number;
  };
  inject: {
    /** Main channel: deliver pending at UserPromptSubmit (§5.6.1). */
    onUserPrompt: boolean;
    /** Second channel: Stop-hook top-up for high-priority batches (§5.6.2). */
    onStop: boolean;
    /** SessionStart static overview (§5.6.5). */
    staticOverview: boolean;
  };
  attribution: {
    bashWindowGraceMs: number;
    longCommandMs: number;
    formatterWindowMs: number;
    formatterSilent: boolean;
  };
}

export const DEFAULT_CONFIG: BrightDriftConfig = {
  enabled: true,
  watch: { respectGitignore: true, extraIgnore: [], includeUntracked: false },
  budget: {
    maxDiffLinesPerFile: 200,
    maxTotalDiffLines: 1000,
    maxInjectTokens: 2000,
    maxDriftFilesForDiff: 50,
  },
  diff: { contextLines: 3, maxFileSizeKB: 512, blacklist: [] },
  baseline: { maxEntries: 5000, persist: true, persistContent: true, contentStoreMaxMB: 256 },
  inject: { onUserPrompt: true, onStop: true, staticOverview: true },
  attribution: {
    bashWindowGraceMs: 1500,
    longCommandMs: 10000,
    formatterWindowMs: 1000,
    formatterSilent: false,
  },
};

/** Project-level override, CC equivalent of phase-1's .dsh/bright-drift.yml. */
export const PROJECT_OVERRIDE_REL = path.join('.claude', 'bright-drift.yml');

/** Hard character ceiling for injected text (E4/§5.7): the docs promise a
 *  10,000-char cap on additionalContext; 2.1.258 spills silently at ~25KB.
 *  We budget against the documented promise and treat the headroom as slack. */
export const MAX_INJECT_CHARS = 9500;

type DeepPartialRecord = Record<string, unknown>;

function asRecord(value: unknown): DeepPartialRecord | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as DeepPartialRecord)
    : undefined;
}

const isStrArr = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === 'string');

/** Field-wise merge; unknown/wrongly-typed fields fall back to base values. */
export function mergeConfig(
  base: BrightDriftConfig,
  overlay: DeepPartialRecord | undefined,
): BrightDriftConfig {
  const out: BrightDriftConfig = structuredClone(base);
  if (!overlay) return out;

  if (typeof overlay.enabled === 'boolean') out.enabled = overlay.enabled;

  const sections = ['watch', 'budget', 'diff', 'baseline', 'inject', 'attribution'] as const;
  for (const section of sections) {
    const src = asRecord(overlay[section]);
    if (!src) continue;
    const tgt = out[section] as Record<string, unknown>;
    for (const [key, val] of Object.entries(src)) {
      if (!(key in tgt)) continue;
      const cur = tgt[key];
      if (typeof cur === 'boolean' && typeof val === 'boolean') tgt[key] = val;
      else if (typeof cur === 'number' && typeof val === 'number' && Number.isFinite(val))
        tgt[key] = val;
      else if (Array.isArray(cur) && isStrArr(val)) tgt[key] = val;
    }
  }
  return out;
}

/** Read a YAML config file; missing/invalid → undefined (fail-open). */
async function readYamlOverlay(file: string): Promise<DeepPartialRecord | undefined> {
  try {
    return asRecord(parseYaml(await fs.readFile(file, 'utf8')));
  } catch {
    return undefined;
  }
}

/**
 * Per-workspace config resolver: global config.yml + project override.
 * The daemon polls mtimes (see ConfigReloader) instead of fs.watch so no
 * extra watcher fds are needed outside the workspace tree.
 */
export class ConfigResolver {
  private global: BrightDriftConfig = DEFAULT_CONFIG;
  private override: DeepPartialRecord | undefined;

  async reloadGlobal(): Promise<void> {
    this.global = mergeConfig(DEFAULT_CONFIG, await readYamlOverlay(configFile()));
  }

  async reloadOverride(workspaceRoot: string): Promise<void> {
    this.override = await readYamlOverlay(path.join(workspaceRoot, PROJECT_OVERRIDE_REL));
  }

  resolve(): BrightDriftConfig {
    return mergeConfig(this.global, this.override);
  }
}

/** mtime-polling hot reload (§5.8: ~sub-second effect via the daemon's
 *  mailbox poll loop; cheaper than two more chokidar instances). */
export class ConfigReloader {
  private mtimes = new Map<string, number>();

  constructor(
    private readonly resolver: ConfigResolver,
    private readonly workspaceRoot: string,
  ) {}

  async initial(): Promise<void> {
    await this.resolver.reloadGlobal();
    await this.resolver.reloadOverride(this.workspaceRoot);
    await this.snapshot();
  }

  /** Re-read any config file whose mtime moved since the last check. */
  async poll(): Promise<boolean> {
    const files = [configFile(), path.join(this.workspaceRoot, PROJECT_OVERRIDE_REL)];
    let changed = false;
    for (const file of files) {
      let mtime = 0;
      try {
        mtime = (await fs.stat(file)).mtimeMs;
      } catch {
        // absent
      }
      if (this.mtimes.get(file) !== mtime) {
        this.mtimes.set(file, mtime);
        changed = true;
      }
    }
    if (changed) {
      await this.resolver.reloadGlobal();
      await this.resolver.reloadOverride(this.workspaceRoot);
    }
    return changed;
  }

  private async snapshot(): Promise<void> {
    for (const file of [configFile(), path.join(this.workspaceRoot, PROJECT_OVERRIDE_REL)]) {
      try {
        this.mtimes.set(file, (await fs.stat(file)).mtimeMs);
      } catch {
        this.mtimes.set(file, 0);
      }
    }
  }
}
