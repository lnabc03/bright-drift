import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { parse as parseYaml } from 'yaml';

/** Resolved plugin configuration (design §5.9). */
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
    onSessionStart: boolean;
    onPreStep: boolean;
    /** Static system-prompt section explaining notice semantics (§5.5.6). */
    promptSection: boolean;
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
  inject: { onSessionStart: true, onPreStep: true, promptSection: true },
  attribution: {
    bashWindowGraceMs: 1500,
    longCommandMs: 10000,
    formatterWindowMs: 1000,
    formatterSilent: false,
  },
};

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

const isStrArr = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

/**
 * Schema function for ctx.settings.register (M0-6 verified: the settings
 * service calls `schema(mergedValue)`; a plain function suffices). Unknown
 * or wrongly-typed fields fall back to defaults instead of failing.
 */
export function settingsSchema(value: unknown): BrightDriftConfig {
  return mergeConfig(DEFAULT_CONFIG, asRecord(value));
}

/** Field-wise merge of a partial overlay onto a base config. */
export function mergeConfig(
  base: BrightDriftConfig,
  overlay: Record<string, unknown> | undefined,
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
      else if (typeof cur === 'number' && typeof val === 'number' && Number.isFinite(val)) tgt[key] = val;
      else if (Array.isArray(cur) && isStrArr(val)) tgt[key] = val;
    }
  }
  return out;
}

export const PROJECT_OVERRIDE_REL = '.dsh/bright-drift.yml';

/** Read the project-level override file; missing/invalid → undefined (fail-open). */
export async function readProjectOverride(
  workspaceRoot: string,
): Promise<Record<string, unknown> | undefined> {
  try {
    const text = await fs.readFile(path.join(workspaceRoot, PROJECT_OVERRIDE_REL), 'utf8');
    return asRecord(parseYaml(text));
  } catch {
    return undefined;
  }
}

/** Per-root config resolver: project override wins over the global settings value (D2). */
export class ConfigResolver {
  private global: BrightDriftConfig = DEFAULT_CONFIG;
  private overrides = new Map<string, Record<string, unknown> | undefined>();

  setGlobal(next: unknown): void {
    this.global = mergeConfig(DEFAULT_CONFIG, asRecord(next));
  }

  async reloadOverride(root: string): Promise<void> {
    this.overrides.set(root, await readProjectOverride(root));
  }

  drop(root: string): void {
    this.overrides.delete(root);
  }

  resolve(root: string): BrightDriftConfig {
    return mergeConfig(this.global, this.overrides.get(root));
  }

  /** The effective global config (no project override applied). */
  globalConfig(): BrightDriftConfig {
    return this.global;
  }
}
