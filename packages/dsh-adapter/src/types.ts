/**
 * Structural subsets of dsh runtime contracts used by this adapter.
 * Sources (pinned devDeps carry the full .d.ts; design doc §3 + appendix):
 * - agent events:      @deepseek-ai/dsh-agent runtime-types.d.ts
 * - tool pipeline:     @deepseek-ai/dsh-tools lib/types/index.d.ts
 * - message/source:    @deepseek-ai/dsh-llm lib/types/message.d.ts
 * - commands:          @deepseek-ai/dsh-commands lib/types
 * Runtime behavior verified by M0 probes (design §8.1).
 */

export interface SessionLike {
  id: string;
  header: { cwd?: string };
}

export interface AgentLike {
  session: SessionLike;
}

export interface TextBlock {
  type: 'text';
  text: string;
}

/** Plugin-sourced user message (dsh-llm message.d.ts: ContextFormed 'notice'). */
export interface PluginUserMessage {
  id: string;
  role: 'user';
  content: TextBlock[];
  source: {
    kind: 'plugin';
    plugin: string;
    form: 'notice';
    summary: string;
  };
}

export interface PreStepPayload {
  agent: AgentLike;
  messages: PluginUserMessage[];
  turn: number;
  step: number;
  signal: AbortSignal;
}

export type PreStepDecision =
  | { kind: 'reject' }
  | { kind: 'enter'; messages: PluginUserMessage[] };

export type PreStepListener = (
  payload: PreStepPayload,
  next: () => Promise<PreStepDecision>,
) => Promise<PreStepDecision>;

export interface ToolExecLike {
  callId: string;
  name: string;
  arguments: Record<string, unknown>;
  agent?: AgentLike;
}

export interface ToolResultLike {
  isError?: boolean;
}

/** fs/observed payload (dsh-fs types.d.ts). */
export type FsObservationLike = { kind: 'present'; version: unknown } | { kind: 'absent' };

export interface FsTargetLike {
  targetKey: string;
}

export interface FsServiceLike {
  processPath(target: FsTargetLike): string;
}

/** Minimal Cordis context surface this adapter consumes. */
export interface CtxLike {
  get(name: string): unknown;
  on(name: string, listener: (...args: never[]) => unknown, options?: { prepend?: boolean }): () => void;
  /** Register a fiber-owned effect; the returned disposer runs on plugin dispose. */
  effect(callback: () => (() => void) | void, label?: string): unknown;
  /**
   * Run callback in a child context once all named services are available
   * (Cordis Context.inject). Services can be provisioned asynchronously
   * after our apply() runs, so late-but-optional capabilities go here.
   */
  inject(deps: string[], callback: (ctx: CtxLike) => void): unknown;
}

export interface SettingsScopeLike<T> {
  get(): T;
  watch(callback: (next: T) => void): () => void;
}

export interface SettingsServiceLike {
  register<T>(ns: string, schema: (value: unknown) => T): SettingsScopeLike<T>;
}

export interface CommandsServiceLike {
  register(definition: {
    name: string;
    description: string;
    /** Declares that the command accepts trailing arguments (dsh composer admission). */
    input?: { hint: string };
    handler: (invocation: { agent: AgentLike; rawInput: string }) =>
      | { kind: 'success'; text?: string }
      | { kind: 'error'; text: string }
      | Promise<{ kind: 'success'; text?: string } | { kind: 'error'; text: string }>;
  }): () => void;
}

export interface TimerServiceLike {
  debounce<F extends (...args: never[]) => void>(callback: F, delay: number): F & { dispose(): void };
}
