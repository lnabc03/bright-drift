import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import {
  analyzeCommand,
  probeFile,
  toRelativeKey,
  type SnapshotEntry,
} from 'bright-drift-core';
import type { ContentStore } from 'bright-drift-core';
import type { AgentState, StateRegistry } from './state.js';
import type { ConfigResolver } from './config.js';
import type { Logger } from './log.js';
import type {
  FsObservationLike,
  FsServiceLike,
  FsTargetLike,
  ToolExecLike,
  ToolResultLike,
} from './types.js';

export interface ObserveDeps {
  registry: StateRegistry;
  resolver: ConfigResolver;
  contentStore: ContentStore;
  logger: Logger;
  /** 'bash' on POSIX, 'pwsh' on Windows (AGENTS.md §4.5). */
  shellToolName: 'bash' | 'pwsh';
  /** Optional fs service for fs/observed path resolution (§5.2.3). */
  fsService?: FsServiceLike | undefined;
}

const READ_TOOLS = new Set(['read', 'read_image']);
const WRITE_TOOLS = new Set(['write', 'edit']);

/** Resolve a tool file_path argument to a workspace-relative key, or null. */
export function resolveToolPath(state: AgentState, filePath: unknown): string | null {
  if (typeof filePath !== 'string' || filePath === '') return null;
  const abs = path.isAbsolute(filePath) ? filePath : path.join(state.workspaceRoot, filePath);
  return toRelativeKey(state.workspaceRoot, abs);
}

/**
 * AKB baseline update after a successful read/write/edit (design §5.2.1):
 * re-read the file ourselves (tool results never echo content, C3).
 * Fire-and-forget from the emit listener; failures degrade to knownDeleted.
 */
async function updateBaseline(
  state: AgentState,
  rel: string,
  source: 'read' | 'write',
  partial: boolean,
  callId: string,
  deps: ObserveDeps,
): Promise<void> {
  const config = deps.resolver.resolve(state.workspaceRoot);
  const obs = await probeFile(state.workspaceRoot, rel, { maxFileSizeKB: config.diff.maxFileSizeKB });
  if (!obs.exists || obs.contentHash === undefined) {
    state.akb.markKnownDeleted(rel, Date.now());
    deps.logger.log('baseline.known-deleted', { sessionId: state.sessionId, path: rel });
    return;
  }
  const keepContent = !partial && !obs.binary && !obs.tooLarge && obs.content !== undefined;
  let contentRef: string | undefined;
  if (keepContent && obs.content) {
    state.memoryCache.set(obs.contentHash, obs.content);
    if (config.baseline.persistContent) {
      await deps.contentStore.put(obs.contentHash, obs.content);
    }
    contentRef = obs.contentHash;
  }
  const prev = state.akb.get(rel);
  state.akb.set(rel, {
    contentHash: obs.contentHash,
    ...(contentRef !== undefined ? { contentRef } : {}),
    mtimeMs: obs.mtimeMs ?? Date.now(),
    size: obs.size ?? 0,
    source,
    ...(partial ? { partial: true } : {}),
    updatedAt: Date.now(),
    lastToolCallId: callId,
  });
  deps.logger.log('baseline.update', {
    sessionId: state.sessionId,
    path: rel,
    source,
    partial,
    hash: obs.contentHash,
    prevHash: prev?.contentHash,
  });
}

/** tools/result listener (emit): AKB observation main channel (F1). */
export function makeToolsResultListener(deps: ObserveDeps) {
  return (exec: ToolExecLike, result: ToolResultLike): void => {
    try {
      const agent = exec.agent;
      if (!agent) return;
      const state = deps.registry.get(agent);
      if (!state) return;
      state.toolsRanSinceLastStep = true; // §5.5.3 flag
      if (result.isError) return;

      if (READ_TOOLS.has(exec.name) || WRITE_TOOLS.has(exec.name)) {
        const rel = resolveToolPath(state, exec.arguments.file_path);
        if (rel === null) return;
        const partial =
          exec.name === 'read_image' ||
          (exec.name === 'read' &&
            (exec.arguments.offset !== undefined || exec.arguments.limit !== undefined));
        const source = READ_TOOLS.has(exec.name) ? 'read' : 'write';
        void updateBaseline(state, rel, source, partial, exec.callId, deps).catch((e) =>
          deps.logger.error('baseline.update', e, { sessionId: state.sessionId, path: rel }),
        );
      }
    } catch (error) {
      deps.logger.error('tools-result', error);
    }
  };
}

/** Stat-only snapshot of AKB-tracked + predicted paths (FR-7.5: hashes stay lazy). */
async function snapshotTracked(state: AgentState, predicted: string[]): Promise<Record<string, SnapshotEntry>> {
  const snapshot: Record<string, SnapshotEntry> = {};
  const paths = new Set([...state.akb.trackedPaths(), ...predicted]);
  await Promise.all(
    [...paths].map(async (rel) => {
      try {
        const stat = await fs.stat(path.join(state.workspaceRoot, rel));
        if (stat.isFile()) snapshot[rel] = { mtimeMs: stat.mtimeMs, size: stat.size };
      } catch {
        /* missing/unreadable: absence is information enough */
      }
    }),
  );
  return snapshot;
}

/**
 * tools/pre-execute listener (waterfall): open the FR-7 attribution window
 * for foreground/background shell calls, then delegate (decisions untouched).
 */
export function makePreExecuteListener(deps: ObserveDeps) {
  return async (
    exec: ToolExecLike,
    next: () => Promise<unknown>,
  ): Promise<unknown> => {
    try {
      if (exec.name === deps.shellToolName && exec.agent) {
        const state = deps.registry.get(exec.agent);
        if (state) {
          const command = typeof exec.arguments.command === 'string' ? exec.arguments.command : '';
          const background = exec.arguments.run_in_background === true;
          const predicted = analyzeCommand(deps.shellToolName, command)
            .map((p) => (path.isAbsolute(p) ? toRelativeKey(state.workspaceRoot, p) : p.split(path.sep).join('/')))
            .filter((p): p is string => p !== null);
          const preSnapshot = await snapshotTracked(state, predicted);
          state.attributor.openWindow({
            id: exec.callId,
            shell: deps.shellToolName,
            command,
            background,
            openedAt: Date.now(),
            preSnapshot,
            predictedPaths: predicted,
          });
          deps.logger.log('window.open', {
            sessionId: state.sessionId,
            callId: exec.callId,
            background,
            predicted,
          });
        }
      }
    } catch (error) {
      deps.logger.error('pre-execute', error);
    }
    return next();
  };
}

/** tools/post-execute listener (waterfall): close the FR-7 window (grace handled by core). */
export function makePostExecuteListener(deps: ObserveDeps) {
  return async (
    exec: ToolExecLike,
    _result: unknown,
    next: (value?: unknown) => Promise<unknown>,
  ): Promise<unknown> => {
    try {
      if (exec.name === deps.shellToolName && exec.agent) {
        deps.registry.get(exec.agent)?.attributor.closeWindow(exec.callId);
      }
    } catch (error) {
      deps.logger.error('post-execute', error);
    }
    return next();
  };
}

/**
 * fs/observed auxiliary channel (§5.2.3): MUST be synchronous and never throw.
 * Only synchronous bookkeeping here — `absent` marks knownDeleted immediately.
 *
 * `present.version` is intentionally NOT consumed: the design's suggested
 * "version unchanged → skip re-read" short-circuit would require storing dsh's
 * opaque version token in the AKB (a schema addition), yet our baseline is
 * content-hash based and established by a direct node fs re-read (§5.2.1),
 * which is both cheap and deliberately independent of the dsh fs service —
 * the latter must not be refreshed, or it would wash out the write-guard's
 * version (§5.2.3). The short-circuit is an optional micro-optimization with
 * real write-guard-interaction risk, so phase 1 opts out.
 */
export function makeFsObservedListener(deps: ObserveDeps) {
  return (target: FsTargetLike, observation: FsObservationLike, actor: unknown): void => {
    try {
      if (observation.kind !== 'absent') return;
      const agent = (actor as ToolExecLike | undefined)?.agent;
      if (!agent) return;
      const state = deps.registry.get(agent);
      if (!state) return;
      const fsService = deps.fsService;
      if (!fsService) return;
      const rel = toRelativeKey(state.workspaceRoot, fsService.processPath(target));
      if (rel === null) return;
      state.akb.markKnownDeleted(rel, Date.now());
    } catch {
      /* contract: listeners must not throw */
    }
  };
}
