import {
  AgentKnowledgeBase,
  Attributor,
  DriftQueue,
  MemoryContentCache,
} from 'bright-drift-core';
import type { AgentLike } from './types.js';
import type { BrightDriftConfig } from './config.js';

/** Everything the plugin knows about one agent (D1: keyed by Agent object). */
export interface AgentState {
  readonly agent: AgentLike;
  readonly sessionId: string;
  /** Workspace root (agent.session.header.cwd, sandbox fallback applied by caller). */
  workspaceRoot: string;
  akb: AgentKnowledgeBase;
  queue: DriftQueue;
  attributor: Attributor;
  memoryCache: MemoryContentCache;
  /** §5.5.3 closing-suppression flag: set on tools/result, cleared per pre-step. */
  toolsRanSinceLastStep: boolean;
  paused: boolean;
  stats: {
    injections: number;
    tokensInjected: number;
    driftEvents: number;
  };
}

export function createAgentState(agent: AgentLike, workspaceRoot: string, config: BrightDriftConfig): AgentState {
  return {
    agent,
    sessionId: agent.session.id,
    workspaceRoot,
    akb: new AgentKnowledgeBase({ maxEntries: config.baseline.maxEntries }),
    queue: new DriftQueue(),
    attributor: new Attributor({
      windowGraceMs: config.attribution.bashWindowGraceMs,
      longCommandMs: config.attribution.longCommandMs,
    }),
    memoryCache: new MemoryContentCache(),
    toolsRanSinceLastStep: false,
    paused: false,
    stats: { injections: 0, tokensInjected: 0, driftEvents: 0 },
  };
}

/** Process-wide registry (single host plugin instance, D1). */
export class StateRegistry {
  private byAgent = new WeakMap<AgentLike, AgentState>();
  private bySessionId = new Map<string, AgentState>();

  get(agent: AgentLike): AgentState | undefined {
    return this.byAgent.get(agent);
  }

  getOrCreate(agent: AgentLike, workspaceRoot: string, config: BrightDriftConfig): AgentState {
    let state = this.byAgent.get(agent);
    if (!state) {
      state = createAgentState(agent, workspaceRoot, config);
      this.byAgent.set(agent, state);
      this.bySessionId.set(state.sessionId, state);
    }
    return state;
  }

  getBySessionId(sessionId: string): AgentState | undefined {
    return this.bySessionId.get(sessionId);
  }

  remove(state: AgentState): void {
    this.byAgent.delete(state.agent);
    this.bySessionId.delete(state.sessionId);
  }

  /** States holding a given workspace root (watcher fan-out, design §5.3). */
  statesForRoot(root: string): AgentState[] {
    const out: AgentState[] = [];
    for (const state of this.bySessionId.values()) {
      if (state.workspaceRoot === root) out.push(state);
    }
    return out;
  }

  all(): AgentState[] {
    return [...this.bySessionId.values()];
  }
}
