import { ContentStore } from 'bright-drift-core';
import type { CtxLike, AgentLike, SettingsServiceLike, CommandsServiceLike, TimerServiceLike, FsServiceLike, SystemPromptLike } from './types.js';
import { ConfigResolver, DEFAULT_CONFIG, settingsSchema } from './config.js';
import { StateRegistry, reconfigureState, type AgentState } from './state.js';
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
import { PROMPT_SECTION_NAME, PROMPT_SECTION_ORDER, PROMPT_SECTION_TEXT } from './prompt-section.js';

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

  // ---- Shared watcher attach/release (§5.3, enabled-gated) ----
  // The watcher is refcounted per root; each session holds one refcount via
  // `state.watcherAttached`. `enabled` toggles (settings hot-update or
  // project override) acquire/release that ref without disturbing siblings.
  const attachWatcher = (state: AgentState): void => {
    if (state.watcherAttached) return;
    state.watcherAttached = true;
    const config = resolver.resolve(state.workspaceRoot);
    void watchers
      .acquire(state.workspaceRoot, config, (r, events) =>
        handleWatchBatch(r, events, registry.statesForRoot(r), {
          resolver,
          logger,
          onOverrideReload: (root, rootStates) => {
            for (const s of rootStates) {
              reconfigureState(s, resolver.resolve(root));
              syncWatcher(s);
            }
          },
        }),
      )
      .catch((e) => {
        state.watcherAttached = false;
        logger.error('watcher.acquire', e, { root: state.workspaceRoot });
      });
  };

  const syncWatcher = (state: AgentState): void => {
    const config = resolver.resolve(state.workspaceRoot);
    if (config.enabled && !state.watcherAttached) attachWatcher(state);
    else if (!config.enabled && state.watcherAttached) {
      state.watcherAttached = false;
      void watchers
        .release(state.workspaceRoot)
        .catch((e) => logger.error('watcher.release', e, { root: state.workspaceRoot }));
    }
  };

  // ---- System-prompt section (§5.5.6): static notice-semantics legend ----
  // Re-assembled before every model step, so it survives compaction/resume.
  // Toggled live by the GLOBAL settings value only (project override N/A).
  let systemPromptService: SystemPromptLike | undefined;
  let promptSectionEnabled = DEFAULT_CONFIG.inject.promptSection;
  let promptSectionOff: (() => void) | undefined;
  const syncPromptSection = (): void => {
    try {
      if (promptSectionEnabled && systemPromptService && !promptSectionOff) {
        promptSectionOff = systemPromptService.section({
          name: PROMPT_SECTION_NAME,
          order: PROMPT_SECTION_ORDER,
          text: PROMPT_SECTION_TEXT,
        });
        logger.log('prompt-section.registered', {});
      } else if (!promptSectionEnabled && promptSectionOff) {
        promptSectionOff();
        promptSectionOff = undefined;
        logger.log('prompt-section.unregistered', {});
      }
    } catch (error) {
      logger.error('prompt-section', error);
    }
  };
  ctx.inject(['systemPrompt'], (injected) => {
    systemPromptService = injected.get('systemPrompt') as SystemPromptLike;
    syncPromptSection();
  });

  // ---- Global settings namespace (D2 primary channel, F7) ----
  // Services may be provisioned asynchronously after our apply() runs
  // (observed live 2026-08-31: ctx.get('settings') was undefined at apply
  // time in the web profile), so registration waits via ctx.inject — the
  // watcher/session machinery below starts immediately regardless.
  ctx.inject(['settings'], (injected) => {
    try {
      const settings = injected.get('settings') as SettingsServiceLike;
      const scope = settings.register('bright-drift', settingsSchema);
      const applyResolved = (next: unknown): void => {
        resolver.setGlobal(next);
        promptSectionEnabled = resolver.globalConfig().inject.promptSection;
        syncPromptSection();
        // Hot-apply live fields (AKB capacity, attribution windows) and
        // honor `enabled` toggles by attaching/releasing watchers (§5.9).
        for (const state of registry.all()) {
          reconfigureState(state, resolver.resolve(state.workspaceRoot));
          syncWatcher(state);
        }
      };
      applyResolved(scope.get());
      scope.watch(applyResolved);
      logger.log('settings.registered', { ns: 'bright-drift' });
    } catch (error) {
      logger.error('settings.register', error);
    }
  });

  const observeDeps = {
    registry,
    resolver,
    contentStore,
    logger,
    shellToolName,
    fsService: ctx.get('fs') as FsServiceLike | undefined,
  };
  // fs may also arrive late; the listener reads deps.fsService per event.
  ctx.inject(['fs'], (injected) => {
    observeDeps.fsService = injected.get('fs') as FsServiceLike;
  });
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
      syncWatcher(state);
      // Project override may flip `enabled` or the attribution windows; once
      // loaded, re-apply live config and re-sync the watcher (D2, §5.9).
      void resolver
        .reloadOverride(root)
        .then(() => {
          reconfigureState(state, resolver.resolve(root));
          syncWatcher(state);
        })
        .catch((e) => logger.error('config.reload', e, { root }));

      // Cold-start reconciliation for resumed sessions (§5.5.5, T7/E11).
      if (payload.source === 'resume' && config.enabled && config.baseline.persist) {
        void (async () => {
          const loaded = await loadAgentState(state, logger);
          if (!loaded) return;
          // Restored engine objects use construction defaults; re-apply the
          // current config so AKB capacity and attribution windows survive resume.
          reconfigureState(state, resolver.resolve(root));
          if (config.inject.onSessionStart) {
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
        if (state.watcherAttached) {
          state.watcherAttached = false;
          await watchers.release(state.workspaceRoot);
        }
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

  // ---- Commands (§5.10) — same async-provisioning reasoning as settings ----
  ctx.inject(['commands'], (injected) => {
    try {
      const commands = injected.get('commands') as CommandsServiceLike;
      registerCommands(commands, { registry, resolver, watchers, contentStore, logger });
      logger.log('commands.registered', { names: ['bright-drift'] });
    } catch (error) {
      logger.error('commands.register', error);
    }
  });

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
