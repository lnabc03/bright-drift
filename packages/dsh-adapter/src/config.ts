import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { parse as parseYaml } from 'yaml';
import z from '@deepseek-ai/schemastery';
import type { Volatile } from '@deepseek-ai/cordis';

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

/**
 * Declarative plugin Config consumed by the Cordis Loader (dsh 0.2.0, D10).
 *
 * Field names are byte-identical to the retired 0.1.x `settings.yaml`
 * `bright-drift:` section — the host's one-shot legacy import maps sections
 * to entry ids verbatim, so any rename would strand user config in
 * `settings.yaml.imported` forever.
 *
 * `volatile()` goes on SECTIONS and LEAVES, never on the root object:
 * a root-level volatile makes `Config({})` resolve to `{}` (defaults are
 * not filled — probed against schemastery 3.18.4). All-volatile also keeps
 * every config edit on the hot path (`loader/volatile-update`): an ordinary
 * field change would remount the plugin and silently drop the unpersisted
 * DriftQueue (§6.2 of the 0.2.0 audit).
 *
 * The schema validates types and fills defaults only — no min/max bounds —
 * so a malformed patch is rejected by the compositor with a log line rather
 * than changing runtime fail-open semantics.
 */
export const Config = z.object({
  enabled: z.boolean().default(true).volatile()
    .description('Master switch: watch workspaces and inject drift notices.'),
  watch: z.object({
    respectGitignore: z.boolean().default(true)
      .description('Honor .gitignore rules when watching the workspace.'),
    extraIgnore: z.array(z.string()).default([])
      .description('Additional gitignore-style globs to silence completely (no drift records).'),
    includeUntracked: z.boolean().default(false)
      .description('Report creations of git-untracked files (non-git workspaces always report).'),
  }).default({}).volatile().description('Filesystem watching.'),
  budget: z.object({
    maxDiffLinesPerFile: z.number().default(200)
      .description('Per-file unified-diff line cap before truncation.'),
    maxTotalDiffLines: z.number().default(1000)
      .description('Total diff-line cap per injection; excess files degrade to list-only.'),
    maxInjectTokens: z.number().default(2000)
      .description('Approximate token cap per injection (4 chars ≈ 1 token).'),
    maxDriftFilesForDiff: z.number().default(50)
      .description('Above this many drifted files, inject a file-level list without diffs.'),
  }).default({}).volatile().description('Injection budget and degradation ladder.'),
  diff: z.object({
    contextLines: z.number().default(3)
      .description('Context lines around each diff hunk.'),
    maxFileSizeKB: z.number().default(512)
      .description('Files larger than this are tracked hash-only (no content, no diff).'),
    blacklist: z.array(z.string()).default([])
      .description('Gitignore-style globs whose diffs are suppressed (hash-only probe, content never stored).'),
  }).default({}).volatile().description('Diff rendering and content capture.'),
  baseline: z.object({
    maxEntries: z.number().default(5000)
      .description('AKB capacity per session (LRU beyond this).'),
    persist: z.boolean().default(true)
      .description('Persist AKB snapshots for session resume reconciliation.'),
    persistContent: z.boolean().default(true)
      .description('Keep sha1-addressed baseline content copies on disk for line-level diffs after resume.'),
    contentStoreMaxMB: z.number().default(256)
      .description('Content-store size cap; least-recently-used blobs are evicted beyond it.'),
  }).default({}).volatile().description('Agent Knowledge Base persistence.'),
  inject: z.object({
    onSessionStart: z.boolean().default(true)
      .description('Reconcile persisted baselines against disk when a session resumes.'),
    onPreStep: z.boolean().default(true)
      .description('Append drift notices to the model request at step boundaries.'),
    promptSection: z.boolean().default(true)
      .description('Contribute a static system-prompt section explaining drift-notice semantics.'),
  }).default({}).volatile().description('Injection channels.'),
  attribution: z.object({
    bashWindowGraceMs: z.number().default(1500)
      .description('Grace period after a shell command ends during which writes are attributed to it.'),
    longCommandMs: z.number().default(10000)
      .description('Commands longer than this keep their attribution window open for the whole run.'),
    formatterWindowMs: z.number().default(1000)
      .description('Cosmetic-only changes within this window after an agent write are reported as FORMATTED.'),
    formatterSilent: z.boolean().default(false)
      .description('Suppress FORMATTED notices entirely instead of listing them.'),
  }).default({}).volatile().description('Drift attribution windows (bash/pwsh).'),
});

/**
 * The shape `apply(ctx, config)` receives from the Loader: every section is
 * a stable Volatile reference whose `.get()` yields an immutable snapshot.
 */
export interface PluginConfig {
  enabled: Volatile<boolean>;
  watch: Volatile<BrightDriftConfig['watch']>;
  budget: Volatile<BrightDriftConfig['budget']>;
  diff: Volatile<BrightDriftConfig['diff']>;
  baseline: Volatile<BrightDriftConfig['baseline']>;
  inject: Volatile<BrightDriftConfig['inject']>;
  attribution: Volatile<BrightDriftConfig['attribution']>;
}

/**
 * Resolve the volatile references into a plain config, filtered through
 * mergeConfig so the result is always a complete, mutable BrightDriftConfig
 * (volatile snapshots are recursively readonly and may omit nothing, but the
 * filter keeps this function safe against shape drift in either direction).
 */
export function snapshotConfig(config: PluginConfig): BrightDriftConfig {
  return mergeConfig(DEFAULT_CONFIG, {
    enabled: config.enabled.get(),
    watch: config.watch.get(),
    budget: config.budget.get(),
    diff: config.diff.get(),
    baseline: config.baseline.get(),
    inject: config.inject.get(),
    attribution: config.attribution.get(),
  });
}

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

const isStrArr = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

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
