import { ContentStore } from 'bright-drift-core';
import type { CtxLike, AgentLike, SettingsServiceLike, CommandsServiceLike, TimerServiceLike, FsServiceLike } from './types.js';
import { ConfigResolver, DEFAULT_CONFIG, settingsSchema } from './config.js';
import { StateRegistry, type AgentState } from './state.js';
import { WatchRegistry } from './watchers.js';
import { handleWatchBatch } from './pipeline.js';
import {
  makeToolsResultListener,
  makePreExecuteListener,
  makePostExecuteListener,
  makeFsObservedListener,
} from './observe.js';
import { makePreStepListener } from './inject.js';
import { saveAgentState, loadAgentState, reconcileOnStart } from './persist.js';
import { registerCommands } from './commands.js';
import { Logger } from './log.js';
import { blobsDir } from './paths.js';

/** Cordis plugin identity (bundle row id in cordis.patch.yml). */
export const name = 'bright-drift';

interface SessionStartPayload {
  agent: AgentLike;
  source: 'startup' | 'resume' | 'clear' | 'compact';
}

interface SessionDisposedPayload {
  id: string;
}

interface SandboxPolicyLike {
  workspaceRoot: string;
}

/**
 * Host-plane single-instance plugin (D1): root ctx listeners, per-Agent
 * state via WeakMap. Every listener body is wrapped fail-open (G5).
 */
export function apply(ctx: CtxLike): void {
  const logger = new Logger();
  const registry = new StateRegistry();
  const resolver = new ConfigResolver();
  const timer = ctx.get('timer') as TimerServiceLike | undefined;
  const watchers = new WatchRegistry(timer, logger);
  const contentStore = new ContentStore(blobsDir(), {
    maxBytes: DEFAULT_CONFIG.baseline.contentStoreMaxMB * 1024 * 1024,
    onError: (error, op) => logger.error('content-store', error, { op }),
  });
  const shellToolName: 'bash' | 'pwsh' = process.platform === 'win32' ? 'pwsh' : 'bash';

  // ---- Global settings namespace (D2 primary channel, F7) ----
  const settings = ctx.get('settings') as SettingsServiceLike | undefined;
  if (settings) {
    try {
      const scope = settings.register('bright-drift', settingsSchema);
      resolver.setGlobal(scope.get());
      scope.watch((next: unknown) => resolver.setGlobal(next));
      logger.log('settings.registered', { ns: 'bright-drift' });
    } catch (error) {
      logger.error('settings.register', error);
    }
  }

  const observeDeps = {
    registry,
    resolver,
    contentStore,
    logger,
    shellToolName,
    fsService: ctx.get('fs') as FsServiceLike | undefined,
  };
  const injectDeps = { registry, resolver, contentStore, logger };

  const rootFor = (agent: AgentLike): string => {
    const cwd = agent.session.header.cwd;
    if (cwd) return cwd;
    const sandboxPolicy = ctx.get('sandboxPolicy') as SandboxPolicyLike | undefined;
    return sandboxPolicy?.workspaceRoot ?? process.cwd();
  };

  // ---- Session lifecycle ----
  ctx.on('agent/session-start', (payload: SessionStartPayload) => {
    try {
      const root = rootFor(payload.agent);
      const config = resolver.resolve(root);
      const state = registry.getOrCreate(payload.agent, root, config);
      void resolver.reloadOverride(root).catch((e) => logger.error('config.reload', e, { root }));
      void watchers
        .acquire(root, config, (r, events) =>
          handleWatchBatch(r, events, registry.statesForRoot(r), { resolver, logger }),
        )
        .catch((e) => logger.error('watcher.acquire', e, { root }));

      // Cold-start reconciliation for resumed sessions (§5.5.5, T7/E11).
      if (payload.source === 'resume' && config.baseline.persist) {
        void (async () => {
          const loaded = await loadAgentState(state, logger);
          if (loaded && config.inject.onSessionStart) {
            await reconcileOnStart(state, resolver.resolve(root), logger);
          }
        })().catch((e) => logger.error('session-start.reconcile', e, { sessionId: state.sessionId }));
      }
      logger.log('session.start', { sessionId: state.sessionId, root, source: payload.source });
    } catch (error) {
      logger.error('session-start', error);
    }
  });

  ctx.on('agent/turn-stopping', (payload: { agent: AgentLike; turn: number }) => {
    try {
      const state = registry.get(payload.agent);
      if (!state) return;
      const config = resolver.resolve(state.workspaceRoot);
      if (config.baseline.persist) void saveAgentState(state, logger);
    } catch (error) {
      logger.error('turn-stopping', error);
    }
  });

  ctx.on('session/disposed', (session: SessionDisposedPayload) => {
    try {
      const state = registry.getBySessionId(session.id);
      if (!state) return;
      void (async () => {
        await saveAgentState(state, logger); // final persist; AKB json kept for resume
        await watchers.release(state.workspaceRoot);
        resolver.drop(state.workspaceRoot);
        registry.remove(state);
        logger.log('session.disposed', { sessionId: state.sessionId });
      })().catch((e) => logger.error('session-disposed', e));
    } catch (error) {
      logger.error('session-disposed', error);
    }
  });

  // ---- Observation channels (§5.2) ----
  ctx.on('tools/result', makeToolsResultListener(observeDeps) as never);
  ctx.on('tools/pre-execute', makePreExecuteListener(observeDeps) as never);
  ctx.on('tools/post-execute', makePostExecuteListener(observeDeps) as never);
  ctx.on('fs/observed', makeFsObservedListener(observeDeps) as never);

  // ---- Injection channel (§5.5, single path, single Sync Point) ----
  ctx.on('agent/pre-step', makePreStepListener(injectDeps) as never, { prepend: true });

  // ---- Commands (§5.10) ----
  const commands = ctx.get('commands') as CommandsServiceLike | undefined;
  if (commands) {
    try {
      registerCommands(commands, { registry, resolver, watchers, contentStore, logger });
    } catch (error) {
      logger.error('commands.register', error);
    }
  }

  logger.log('plugin.applied', { shellToolName });

  // Fiber-owned teardown: release all watchers and flush AKB snapshots when
  // the host disposes the plugin (headless one-shot exit path relies on
  // context disposal to drain the event loop — chokidar would otherwise
  // keep the process alive).
  ctx.effect(() => {
    return () => {
      void watchers.stopAll().catch((e) => logger.error('watcher.stopAll', e));
      void Promise.all(
        registry.all().map((s) => saveAgentState(s, logger)),
      ).catch((e) => logger.error('teardown.persist', e));
      logger.log('plugin.disposed', {});
    };
  }, 'bright-drift:teardown');
}
