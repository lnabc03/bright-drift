import {
  reconcile,
  probeFile,
  makeCreatedFilter,
  resolveGitTracked,
  type Attribution,
  type DriftRecord,
  type FileObservation,
  type TrackedStatus,
} from 'bright-drift-core';
import type { AgentState } from './state.js';
import type { ConfigResolver } from './config.js';
import { PROJECT_OVERRIDE_REL } from './config.js';
import type { Logger } from './log.js';

/** Drift record enriched with detection-time attribution (windows close fast). */
export interface AttributedDrift extends DriftRecord {
  attribution: Attribution;
}

export interface PipelineDeps {
  resolver: ConfigResolver;
  logger: Logger;
  /** Invoked after a project-override reload so live config re-applies (hot-update). */
  onOverrideReload?: (root: string, states: AgentState[]) => void;
}

/**
 * Watcher batch → probe (once per path) → created-gate → reconcile per
 * session → attribute → per-agent queue (design §4 pipeline, §5.3 D7 gate).
 * Never throws: per-session work is isolated and logged (G5 fail-open).
 */
export async function handleWatchBatch(
  root: string,
  events: { path: string; kind: string }[],
  states: AgentState[],
  deps: PipelineDeps,
): Promise<void> {
  // Project-override file changes hot-reload config for this root (D2).
  if (events.some((e) => e.path === PROJECT_OVERRIDE_REL)) {
    await deps.resolver.reloadOverride(root).catch((e) => deps.logger.error('config.reload', e, { root }));
    deps.onOverrideReload?.(root, states);
  }

  // Config is keyed by workspace root, so every session on it shares one
  // resolved value; when disabled for this root, skip probing entirely.
  const config = deps.resolver.resolve(root);
  if (!config.enabled || states.length === 0) return;

  // Probe each path once; reuse the observation across all sessions on this root.
  const observations = new Map<string, FileObservation>();
  await Promise.all(
    events.map(async (e) => {
      observations.set(
        e.path,
        await probeFile(root, e.path, { maxFileSizeKB: config.diff.maxFileSizeKB }),
      );
    }),
  );
  const obsList = [...observations.values()];

  // Created-drift gate (D7): resolve git-tracking of unknown-to-AKB paths in
  // ONE batched `git ls-files` call per watcher batch — lazy, never a
  // startup full-tree scan. git failure → all 'unknown' → reported (D7).
  let statuses: Map<string, TrackedStatus> | undefined;
  if (!config.watch.includeUntracked) {
    const candidates = new Set<string>();
    for (const state of states) {
      for (const obs of obsList) {
        if (obs.exists && !state.akb.has(obs.path)) candidates.add(obs.path);
      }
    }
    if (candidates.size > 0) {
      statuses = await resolveGitTracked(root, [...candidates]);
    }
  }

  const now = Date.now();
  for (const state of states) {
    try {
      // D8a: paths predicted by an open/recently-closed attribution window
      // are exempt from the gate — a command's own output is always reported.
      const createdFilter = makeCreatedFilter(statuses, {
        includeUntracked: config.watch.includeUntracked,
        predicted: (p) => state.attributor.predictedRecently(p, now),
      });
      const records = reconcile(
        state.akb,
        obsList,
        now,
        createdFilter ? { createdFilter } : {},
      );
      for (const record of records) {
        const attributed: AttributedDrift = {
          ...record,
          // Path-aware classification (D8b): predicted writes landing after
          // the grace window stay ambiguous-external with the command named.
          attribution: state.attributor.classify(record.at, record.path),
        };
        state.queue.push(attributed);
        state.stats.driftEvents += 1;
      }
      if (records.length > 0) {
        deps.logger.log('drift.detected', {
          root,
          sessionId: state.sessionId,
          count: records.length,
          kinds: records.map((r) => r.kind),
        });
      }
    } catch (error) {
      deps.logger.error('pipeline.session', error, { root, sessionId: state.sessionId });
    }
  }
}
