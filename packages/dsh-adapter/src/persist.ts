import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import {
  AgentKnowledgeBase,
  Attributor,
  probeFile,
  reconcile,
  type AKBSnapshot,
} from 'bright-drift-core';
import type { AgentState } from './state.js';
import type { BrightDriftConfig } from './config.js';
import type { Logger } from './log.js';
import type { AttributedDrift } from './pipeline.js';
import { akbDir, ensureDir } from './paths.js';

interface PersistedState {
  version: 1;
  akb: AKBSnapshot;
  attributor: ReturnType<Attributor['toJSON']>;
}

/**
 * AKB + attribution windows snapshot, atomic tmp+rename (§5.8).
 * Keyed by sessionId (C5): resume keeps the id, new sessions start empty.
 */
export async function saveAgentState(state: AgentState, logger: Logger): Promise<void> {
  try {
    await ensureDir(akbDir());
    const data: PersistedState = {
      version: 1,
      akb: state.akb.toSnapshot(state.sessionId, Date.now()),
      attributor: state.attributor.toJSON(),
    };
    const file = path.join(akbDir(), `${state.sessionId}.json`);
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(data));
    await fs.rename(tmp, file);
    logger.log('persist.saved', { sessionId: state.sessionId, entries: state.akb.size });
  } catch (error) {
    logger.error('persist.save', error, { sessionId: state.sessionId });
  }
}

/** Load persisted state into an existing AgentState; missing/corrupt → no-op. */
export async function loadAgentState(state: AgentState, logger: Logger): Promise<boolean> {
  try {
    const file = path.join(akbDir(), `${state.sessionId}.json`);
    const data = JSON.parse(await fs.readFile(file, 'utf8')) as PersistedState;
    if (data.version !== 1 || data.akb.sessionId !== state.sessionId) return false;
    state.akb = AgentKnowledgeBase.fromSnapshot(data.akb);
    state.attributor = Attributor.fromJSON(data.attributor);
    logger.log('persist.loaded', { sessionId: state.sessionId, entries: state.akb.size });
    return true;
  } catch {
    return false; // absent or corrupt snapshot: start fresh (fail-open)
  }
}

/**
 * Cold-start reconciliation (§5.5.5, E11/T7): probe every AKB-tracked path
 * and enqueue drift. Runs async after session-start; the first pre-step is
 * never blocked — slow reconciliation simply lands in a later injection.
 */
export async function reconcileOnStart(
  state: AgentState,
  config: BrightDriftConfig,
  logger: Logger,
): Promise<void> {
  try {
    const paths = state.akb.trackedPaths();
    if (paths.length === 0) return;
    const observations = await Promise.all(
      paths.map((p) => probeFile(state.workspaceRoot, p, { maxFileSizeKB: config.diff.maxFileSizeKB })),
    );
    const now = Date.now();
    const records = reconcile(state.akb, observations, now);
    for (const record of records) {
      const attributed: AttributedDrift = {
        ...record,
        attribution: state.attributor.classify(record.at),
      };
      state.queue.push(attributed);
    }
    logger.log('reconcile.session-start', {
      sessionId: state.sessionId,
      tracked: paths.length,
      drift: records.length,
    });
  } catch (error) {
    logger.error('reconcile.session-start', error, { sessionId: state.sessionId });
  }
}
