/**
 * Compile-time contract test against the REAL dsh 0.2.0 types (D10).
 *
 * This file is never imported at runtime; it exists so `tsc` fails the
 * build the day a host release renames an event, reshapes a payload, or
 * removes a service this plugin depends on. The negative block pins APIs
 * that 0.2.0 REMOVED: if a future release reintroduces one, the
 * `@ts-expect-error` itself starts erroring and forces a human look.
 *
 * The Events map is populated by each package's `declare module
 * '@deepseek-ai/cordis'` augmentation, which only loads when the package
 * is imported — hence the bare type imports below.
 */
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-agent'; // agent/created, agent/disposed, agent/pre-step, agent/turn-stopping
import type {} from '@deepseek-ai/dsh-session'; // session/disposed
import type {} from '@deepseek-ai/dsh-tools'; // tools/result, tools/pre-execute, tools/post-execute
import type {} from '@deepseek-ai/dsh-fs'; // fs/observed
import type {} from '@deepseek-ai/dsh-settings'; // ctx.settings: SettingsForms
import type {} from '@deepseek-ai/cordis-plugin-loader'; // loader/volatile-update
import {
  CONTEXT_SUMMARY_MAX_CHARS,
  boundContextSummary,
  createUserMessage,
} from '@deepseek-ai/dsh-llm';
import './types.js'; // MessageSourceMap: 'bright-drift' kind
import { Config, snapshotConfig, type PluginConfig } from './config.js';
import { apply, name } from './index.js';

/** Positive contract: the exact host surfaces apply() relies on. */
export function _typeContract(ctx: Context, config: PluginConfig): void {
  // Plugin entry shape consumed by the Cordis Loader.
  void name;
  void Config;
  void apply(ctx, config);
  void snapshotConfig(config).budget.maxInjectTokens;

  // Agent lifecycle (serial: listeners must return undefined, sync).
  ctx.on('agent/created', (payload) => {
    const cwd: string | undefined = payload.agent.session.header.cwd;
    const source: 'startup' | 'resume' | 'clear' | 'compact' = payload.source;
    void cwd;
    void source;
    void payload.signal;
    return undefined;
  });
  ctx.on('agent/disposed', (payload) => {
    void payload.agent.id;
  });
  ctx.on('session/disposed', (session) => {
    const id: string = session.id; // Session object, not a {id} wrapper (P2-1)
    void id;
  });
  ctx.on('agent/turn-stopping', (payload) => {
    void payload.agent;
    void payload.turn;
    void payload.signal;
  });

  // Injection channel: waterfall, prepend, delegate first.
  ctx.on(
    'agent/pre-step',
    async (payload, next) => {
      const decision = await next();
      void payload.signal.aborted;
      void payload.turn;
      void payload.step;
      return decision;
    },
    { prepend: true },
  );

  // Observation channels.
  ctx.on('tools/result', (exec, result) => {
    void exec.callId;
    void exec.name;
    void exec.arguments;
    void exec.agent;
    void result.isError;
    return undefined;
  });
  ctx.on('tools/pre-execute', async (exec, next) => {
    void exec.agent;
    void exec.name;
    void exec.arguments;
    return next();
  });
  ctx.on('tools/post-execute', async (exec, result, next) => {
    void exec.callId;
    void result.isError;
    return next();
  });
  ctx.on('fs/observed', (target, observation, actor) => {
    void target.targetKey;
    void observation.kind;
    void actor;
  });

  // Config hot update (fiber-filtered: only this plugin's volatile commits).
  ctx.on('loader/volatile-update', (paths) => {
    void paths;
  });

  // Injection message: producer-declared source kind + bounded summary.
  const message = createUserMessage({
    content: [{ type: 'text', text: 'drift' }],
    source: { kind: 'bright-drift', form: 'notice', summary: boundContextSummary('x') },
  });
  void message.id;
  void message.role;
  void CONTEXT_SUMMARY_MAX_CHARS;
}

/**
 * Negative contract: APIs removed by dsh 0.2.0 must STAY removed. Each
 * `@ts-expect-error` is a tripwire — a host release that resurrects the
 * API (or renames something these lines touch) breaks the build here.
 */
export function _removedApiTripwires(ctx: Context): void {
  // P0-1: 0.1.x session-start event was deleted without a shim.
  // @ts-expect-error 'agent/session-start' is not a keyof Events in 0.2.0
  ctx.on('agent/session-start', () => undefined);

  // P0-2: the settings service was rewritten as SettingsForms; register()
  // and the whole ~/.dsh/settings.yaml channel are gone.
  // @ts-expect-error SettingsForms has no register() in 0.2.0
  ctx.settings.register('bright-drift', (v: unknown) => v);
}
