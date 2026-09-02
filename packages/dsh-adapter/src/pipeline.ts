import {
  reconcile,
  probeFile,
  type Attribution,
  type DriftRecord,
  type FileObservation,
} from 'bright-drift-core';
import type { AgentState } from './state.js';
import type { ConfigResolver, BrightDriftConfig } from './config.js';
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
 * Watcher batch → probe (once per path) → reconcile per session → attribute
 * → per-agent queue (design §4 pipeline). Never throws: per-session work is
 * isolated and logged (G5 fail-open).
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

  // Probe each path once; reuse the observation across all sessions on this root.
  const observations = new Map<string, FileObservation>();
  await Promise.all(
    events.map(async (e) => {
      const cfg = deps.resolver.resolve(root);
      observations.set(
        e.path,
        await probeFile(root, e.path, { maxFileSizeKB: cfg.diff.maxFileSizeKB }),
      );
    }),
  );
  const obsList = [...observations.values()];

  for (const state of states) {
    try {
      const config = deps.resolver.resolve(root);
      if (!config.enabled) continue;
      const now = Date.now();
      const records = reconcile(state.akb, obsList, now);
      for (const record of records) {
        const attributed: AttributedDrift = {
          ...record,
          attribution: state.attributor.classify(record.at),
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
