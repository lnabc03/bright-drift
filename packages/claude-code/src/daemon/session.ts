import {
  AgentKnowledgeBase,
  Attributor,
  ContentStore,
  DriftQueue,
  MemoryContentCache,
  createPatternMatcher,
  probeFile,
  reconcile,
  type AKBSnapshot,
} from 'bright-drift-core';
import * as path from 'node:path';
import { atomicWriteFile, readJsonFile } from '../shared/atomic.js';
import type { BrightDriftConfig } from '../shared/config.js';
import { log } from '../shared/log.js';
import { akbDir } from '../shared/paths.js';
import type { AttributedDrift } from './types.js';

/**
 * Per-session engine state living inside the daemon process (design §3.1
 * daemon/session.ts). Mirrors the phase-1 AgentState shape minus the dsh
 * agent handle; persistence is a plain versioned JSON snapshot so a daemon
 * restart (or the 2h session-death sweep) loses no baseline (§5.2.4).
 */
export interface SessionState {
  sessionId: string;
  workspaceRoot: string;
  akb: AgentKnowledgeBase;
  queue: DriftQueue;
  attributor: Attributor;
  memoryCache: MemoryContentCache;
  contentStore: ContentStore;
  registeredAt: number;
}

export function createSessionState(
  sessionId: string,
  workspaceRoot: string,
  hash: string,
  config: BrightDriftConfig,
): SessionState {
  return {
    sessionId,
    workspaceRoot,
    akb: new AgentKnowledgeBase({ maxEntries: config.baseline.maxEntries }),
    queue: new DriftQueue(),
    attributor: new Attributor({
      windowGraceMs: config.attribution.bashWindowGraceMs,
      longCommandMs: config.attribution.longCommandMs,
    }),
    memoryCache: new MemoryContentCache(),
    contentStore: new ContentStore(path.join(akbDir(hash, sessionId), 'blobs'), {
      maxBytes: config.baseline.contentStoreMaxMB * 1024 * 1024,
    }),
    registeredAt: Date.now(),
  };
}

/** Re-apply live config to the long-lived engine objects (hot reload, §5.8). */
export function reconfigureSession(state: SessionState, config: BrightDriftConfig): void {
  state.akb.setMaxEntries(config.baseline.maxEntries);
  state.attributor.setWindows(
    config.attribution.bashWindowGraceMs,
    config.attribution.longCommandMs,
  );
}

interface PersistedSession {
  version: 1;
  akb: AKBSnapshot;
  attributor: ReturnType<Attributor['toJSON']>;
}

function snapshotFile(hash: string, sessionId: string): string {
  return path.join(akbDir(hash, sessionId), 'state.json');
}

/** Persist AKB + attribution windows (atomic write; best-effort). */
export async function saveSessionState(hash: string, state: SessionState): Promise<void> {
  if (state.akb.size === 0) return; // nothing worth persisting
  try {
    const data: PersistedSession = {
      version: 1,
      akb: state.akb.toSnapshot(state.sessionId, Date.now()),
      attributor: state.attributor.toJSON(),
    };
    await atomicWriteFile(snapshotFile(hash, state.sessionId), JSON.stringify(data));
  } catch (err) {
    await log(`session ${state.sessionId} snapshot save failed: ${(err as Error).message}`);
  }
}

/**
 * Restore a session from its snapshot. Missing/corrupt → undefined; caller
 * falls back to a fresh state and lets cold-start reconcile rebuild truth.
 */
export async function loadSessionState(
  hash: string,
  sessionId: string,
  workspaceRoot: string,
  config: BrightDriftConfig,
): Promise<SessionState | undefined> {
  const data = await readJsonFile<PersistedSession>(snapshotFile(hash, sessionId));
  if (!data || data.version !== 1 || data.akb.sessionId !== sessionId) return undefined;
  try {
    const state = createSessionState(sessionId, workspaceRoot, hash, config);
    state.akb = AgentKnowledgeBase.fromSnapshot(data.akb, {
      maxEntries: config.baseline.maxEntries,
    });
    state.attributor = Attributor.fromJSON(data.attributor);
    await log(`session ${sessionId} restored (${state.akb.size} akb entries)`);
    return state;
  } catch {
    return undefined;
  }
}

/**
 * Cold-start reconciliation (design §5.6.5, FR-3.3): probe every AKB-tracked
 * path against live disk and enqueue the differences. Attribution degrades
 * to external on anything found here (safe direction, B3).
 */
export async function reconcileOnStart(
  state: SessionState,
  config: BrightDriftConfig,
): Promise<number> {
  const paths = state.akb.trackedPaths();
  if (paths.length === 0) return 0;
  const diffBlacklisted = createPatternMatcher(config.diff.blacklist);
  const observations = await Promise.all(
    paths.map((p) =>
      probeFile(state.workspaceRoot, p, {
        maxFileSizeKB: config.diff.maxFileSizeKB,
        hashOnly: diffBlacklisted(p),
      }),
    ),
  );
  const now = Date.now();
  // Only AKB-tracked paths are probed, so no `created` records can arise and
  // the D7 created-gate is a no-op here (same as phase 1).
  const records = reconcile(state.akb, observations, now);
  for (const record of records) {
    const attributed: AttributedDrift = {
      ...record,
      attribution: state.attributor.classify(record.at, record.path),
    };
    state.queue.push(attributed);
  }
  await log(
    `session ${state.sessionId} cold-start reconcile: tracked=${paths.length} drift=${records.length}`,
  );
  return records.length;
}
