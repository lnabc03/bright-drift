import { ContentStore } from 'bright-drift-core';
import type { Context } from '@deepseek-ai/cordis';
import type { TimerService } from '@deepseek-ai/cordis-plugin-timer';
import type { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy';
// Type-only imports that register the host's Events augmentations this
// entry subscribes to (D10: the compiler is the contract test).
import type {} from '@deepseek-ai/dsh-agent'; // agent/created, agent/disposed, agent/pre-step, agent/turn-stopping
import type {} from '@deepseek-ai/dsh-session'; // session/disposed
import type {} from '@deepseek-ai/dsh-tools'; // tools/result, tools/pre-execute, tools/post-execute
import type {} from '@deepseek-ai/dsh-fs'; // fs/observed
import type {} from '@deepseek-ai/cordis-plugin-loader'; // loader/volatile-update
import { Config, ConfigResolver, DEFAULT_CONFIG, snapshotConfig, type PluginConfig } from './config.js';
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

/**
 * Declarative configuration schema (dsh 0.2.0, D10). Re-exported from
 * config.ts so the Loader finds it on the plugin module. Section-level
 * volatile → edits hot-commit via `loader/volatile-update` (no remount).
 */
export { Config };
export type { PluginConfig };

/**
 * Host-plane single-instance plugin (D1): root ctx listeners, per-Agent
 * state via WeakMap. Every listener body is wrapped fail-open (G5).
 *
 * `config` is the Loader-parsed Config with every section a Volatile
 * reference; `snapshotConfig()` resolves it (§5.9).
 */
export function apply(ctx: Context, config: PluginConfig): void {
  const logger = new Logger();
  const registry = new StateRegistry();
  const resolver = new ConfigResolver();
  const timer = ctx.get('timer') as TimerService | undefined;
  const watchers = new WatchRegistry(timer, logger);
  const contentStore = new ContentStore(blobsDir(), {
    maxBytes: DEFAULT_CONFIG.baseline.contentStoreMaxMB * 1024 * 1024,
    onError: (error, op) => logger.error('content-store', error, { op }),
  });
  const shellToolName: 'bash' | 'pwsh' = process.platform === 'win32' ? 'pwsh' : 'bash';

  // ---- Shared watcher attach/release (§5.3, enabled-gated) ----
  // The watcher is refcounted per root; each session holds one refcount via
  // `state.watcherAttached`. `enabled` toggles (config hot-update or
  // project override) acquire/release that ref without disturbing siblings.
  const attachWatcher = (state: AgentState): void => {
    if (state.watcherAttached) return;
    state.watcherAttached = true;
    const resolved = resolver.resolve(state.workspaceRoot);
    void watchers
      .acquire(state.workspaceRoot, resolved, (r, events) =>
        handleWatchBatch(r, events, registry.statesForRoot(r), {
          resolver,
          logger,
          onOverrideReload: (root, rootStates) => {
            const resolvedRoot = resolver.resolve(root);
            for (const s of rootStates) {
              reconfigureState(s, resolvedRoot);
              syncWatcher(s);
            }
            // §5.3: respectGitignore/extraIgnore may have changed.
            void watchers
              .refreshIgnore(root, resolvedRoot)
              .catch((e) => logger.error('watcher.refresh-ignore', e, { root }));
          },
          onIgnoreRulesChanged: (root) => {
            // .gitignore content changed — rebuild the matcher in place.
            void watchers
              .refreshIgnore(root, resolver.resolve(root))
              .catch((e) => logger.error('watcher.refresh-ignore', e, { root }));
          },
        }),
      )
      .catch((e) => {
        state.watcherAttached = false;
        logger.error('watcher.acquire', e, { root: state.workspaceRoot });
      });
  };

  const syncWatcher = (state: AgentState): void => {
    const resolved = resolver.resolve(state.workspaceRoot);
    if (resolved.enabled && !state.watcherAttached) attachWatcher(state);
    else if (!resolved.enabled && state.watcherAttached) {
      state.watcherAttached = false;
      void watchers
        .release(state.workspaceRoot)
        .catch((e) => logger.error('watcher.release', e, { root: state.workspaceRoot }));
    }
  };

  // ---- System-prompt section (§5.5.6): static notice-semantics legend ----
  // Re-assembled before every model step, so it survives compaction/resume.
  // Toggled live by the GLOBAL config value only (project override N/A).
  let systemPromptService: Context['systemPrompt'] | undefined;
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
  // Services may be provisioned asynchronously after our apply() runs
  // (observed live 2026-08-31: services were absent at apply time in the
  // web profile), so registration waits via ctx.inject — the watcher/session
  // machinery below starts immediately regardless.
  ctx.inject(['systemPrompt'], (injected) => {
    systemPromptService = injected.systemPrompt;
    syncPromptSection();
  });

  // ---- Global config (D2/D10): declarative Loader Config + volatile hot update ----
  // applyConfig is idempotent and cheap; loader/volatile-update is filtered
  // to THIS fiber by the loader, so it fires only for our own volatile commits.
  const applyConfig = (): void => {
    try {
      resolver.setGlobal(snapshotConfig(config));
      promptSectionEnabled = resolver.globalConfig().inject.promptSection;
      syncPromptSection();
      // Hot-apply live fields (AKB capacity, attribution windows) and
      // honor `enabled` toggles by attaching/releasing watchers (§5.9).
      for (const state of registry.all()) {
        reconfigureState(state, resolver.resolve(state.workspaceRoot));
        syncWatcher(state);
      }
      // §5.3: global respectGitignore/extraIgnore changes rebuild matchers.
      for (const root of watchers.roots) {
        void watchers
          .refreshIgnore(root, resolver.resolve(root))
          .catch((e) => logger.error('watcher.refresh-ignore', e, { root }));
      }
      logger.log('config.applied', {});
    } catch (error) {
      logger.error('config.apply', error);
    }
  };
  applyConfig();
  ctx.on('loader/volatile-update', () => {
    applyConfig();
  });

  const observeDeps = {
    registry,
    resolver,
    contentStore,
    logger,
    shellToolName,
    fsService: undefined as Pick<Context['fs'], 'processPath'> | undefined,
  };
  // fs may also arrive late; the listener reads deps.fsService per event.
  ctx.inject(['fs'], (injected) => {
    observeDeps.fsService = injected.fs;
  });
  const injectDeps = { registry, resolver, contentStore, logger };

  const rootFor = (agent: AgentState['agent']): string => {
    const cwd = agent.session.header.cwd;
    if (cwd) return cwd;
    const sandboxPolicy = ctx.get('sandboxPolicy') as SandboxPolicyService | undefined;
    return sandboxPolicy?.workspaceRoot ?? process.cwd();
  };

  // ---- Agent lifecycle (D10: agent/created replaced agent/session-start) ----
  // serial event: listeners are awaited before creation resolves, so this
  // body stays synchronous (heavy work is fire-and-forget), never throws,
  // and explicitly returns undefined.
  ctx.on('agent/created', (payload) => {
    try {
      const root = rootFor(payload.agent);
      const resolved = resolver.resolve(root);
      const state = registry.getOrCreate(payload.agent, root, resolved);
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
      if (payload.source === 'resume' && resolved.enabled && resolved.baseline.persist) {
        void (async () => {
          const loaded = await loadAgentState(state, logger);
          if (!loaded) return;
          // Restored engine objects use construction defaults; re-apply the
          // current config so AKB capacity and attribution windows survive resume.
          reconfigureState(state, resolver.resolve(root));
          if (resolved.inject.onSessionStart) {
            await reconcileOnStart(state, resolver.resolve(root), logger);
          }
        })().catch((e) => logger.error('agent-created.reconcile', e, { sessionId: state.sessionId }));
      }
      logger.log('session.start', { sessionId: state.sessionId, root, source: payload.source });
    } catch (error) {
      logger.error('agent-created', error);
    }
    return undefined;
  });

  ctx.on('agent/turn-stopping', (payload) => {
    try {
      const state = registry.get(payload.agent);
      if (!state) return;
      const resolved = resolver.resolve(state.workspaceRoot);
      if (resolved.baseline.persist) void saveAgentState(state, logger);
    } catch (error) {
      logger.error('turn-stopping', error);
    }
  });

  // ---- Disposal (D10): agent and session retire independently ----
  // The web UI may dispose an agent while its session stays in the store
  // (and vice versa on clear/compact). Whichever event arrives first claims
  // the cleanup synchronously; the second finds no registry entry (P2-2).
  const disposeState = (state: AgentState, reason: string): void => {
    registry.remove(state); // synchronous claim → idempotent across both events
    void (async () => {
      await saveAgentState(state, logger); // final persist; AKB json kept for resume
      if (state.watcherAttached) {
        state.watcherAttached = false;
        await watchers.release(state.workspaceRoot);
      }
      resolver.drop(state.workspaceRoot);
      logger.log('session.disposed', { sessionId: state.sessionId, reason });
    })().catch((e) => logger.error('session-disposed', e));
  };

  ctx.on('agent/disposed', (payload) => {
    try {
      const state = registry.get(payload.agent);
      if (state) disposeState(state, 'agent/disposed');
    } catch (error) {
      logger.error('agent-disposed', error);
    }
  });

  ctx.on('session/disposed', (session) => {
    try {
      const state = registry.getBySessionId(session.id);
      if (state) disposeState(state, 'session/disposed');
    } catch (error) {
      logger.error('session-disposed', error);
    }
  });

  // ---- Observation channels (§5.2) ----
  ctx.on('tools/result', makeToolsResultListener(observeDeps));
  ctx.on('tools/pre-execute', makePreExecuteListener(observeDeps));
  ctx.on('tools/post-execute', makePostExecuteListener(observeDeps));
  ctx.on('fs/observed', makeFsObservedListener(observeDeps));

  // ---- Injection channel (§5.5, single path, single Sync Point) ----
  ctx.on('agent/pre-step', makePreStepListener(injectDeps), { prepend: true });

  // ---- Commands (§5.10) — same async-provisioning reasoning as systemPrompt ----
  ctx.inject(['commands'], (injected) => {
    try {
      registerCommands(injected.commands, { registry, resolver, watchers, contentStore, logger });
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
