import {
  WorkspaceWatcher,
  createIgnoreMatcher,
  createPatternMatcher,
  makeCreatedFilter,
  probeFile,
  reconcile,
  resolveGitTracked,
  toRelativeKey,
  type Attribution,
  type DriftRecord,
  type FileObservation,
  type SnapshotEntry,
  type TrackedStatus,
  type WatchEvent,
} from 'bright-drift-core';
import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import { atomicWriteFile } from '../shared/atomic.js';
import {
  ConfigReloader,
  ConfigResolver,
  PROJECT_OVERRIDE_REL,
  type BrightDriftConfig,
} from '../shared/config.js';
import { log } from '../shared/log.js';
import { akbPathsFile, pausedFile, pendingFile } from '../shared/paths.js';
import type { MailboxMessage } from '../shared/schema.js';
import { maybeRenderPending } from './render.js';
import {
  createSessionState,
  loadSessionState,
  reconcileOnStart,
  reconfigureSession,
  saveSessionState,
  type SessionState,
} from './session.js';
import type { AttributedDrift } from './types.js';

/**
 * Workspace engine (design §3.1 daemon/workspace.ts): ONE daemon process
 * owns ONE workspace — the watcher, the config resolver, and every CC
 * session registered on it (B1: watcher shared, AKB/queue/attribution
 * per session). Mailbox messages are translated into engine calls.
 */
export class WorkspaceEngine {
  readonly sessions = new Map<string, SessionState>();
  readonly resolver = new ConfigResolver();
  private readonly reloader: ConfigReloader;
  private watcher: WorkspaceWatcher | undefined;
  private ignored: (relPath: string) => boolean = () => false;

  constructor(
    private readonly hash: string,
    private readonly workspaceRoot: string,
  ) {
    this.reloader = new ConfigReloader(this.resolver, workspaceRoot);
  }

  get config(): BrightDriftConfig {
    return this.resolver.resolve();
  }

  async start(): Promise<void> {
    await this.reloader.initial();
    const config = this.config;
    this.ignored = await createIgnoreMatcher(this.workspaceRoot, {
      respectGitignore: config.watch.respectGitignore,
      extraIgnore: config.watch.extraIgnore,
      onError: (e) => void log(`ignore-rules: ${(e as Error).message}`),
    });
    // The watcher consults the matcher through a closure so .gitignore /
    // config changes hot-swap it without re-creating chokidar (phase-1 §5.3).
    this.watcher = new WorkspaceWatcher({
      root: this.workspaceRoot,
      debounceMs: 300,
      ignored: (rel) => this.ignored(rel),
      onBatch: (events) => void this.handleWatchBatch(events).catch((e) => void log(`batch: ${(e as Error).message}`)),
      onError: (e) => void log(`watcher: ${(e as Error).message}`),
    });
    this.watcher.start();
    await log(`engine start workspace=${this.workspaceRoot}`);
  }

  async stop(): Promise<void> {
    for (const state of this.sessions.values()) await saveSessionState(this.hash, state);
    await this.watcher?.stop();
  }

  /** Hot-reload tick, driven by the daemon's mailbox poll loop. */
  async pollConfig(): Promise<void> {
    if (await this.reloader.poll()) {
      const config = this.config;
      for (const state of this.sessions.values()) reconfigureSession(state, config);
      await this.refreshIgnore();
      await log('config reloaded');
    }
  }

  private async refreshIgnore(): Promise<void> {
    const config = this.config;
    this.ignored = await createIgnoreMatcher(this.workspaceRoot, {
      respectGitignore: config.watch.respectGitignore,
      extraIgnore: config.watch.extraIgnore,
      onError: (e) => void log(`ignore-rules: ${(e as Error).message}`),
    });
  }

  private async isPaused(): Promise<boolean> {
    try {
      await fs.stat(pausedFile(this.hash));
      return true;
    } catch {
      return false;
    }
  }

  // ---- session lifecycle -------------------------------------------------

  async handleRegister(sessionId: string): Promise<void> {
    const config = this.config;
    let state = this.sessions.get(sessionId);
    if (!state) {
      state =
        (await loadSessionState(this.hash, sessionId, this.workspaceRoot, config)) ??
        createSessionState(sessionId, this.workspaceRoot, this.hash, config);
      this.sessions.set(sessionId, state);
      // Cold-start reconcile (§5.6.5): async, never blocks registration.
      void reconcileOnStart(state, config)
        .then(() => this.renderSession(sessionId))
        .catch((e) => void log(`reconcile ${sessionId}: ${(e as Error).message}`));
    }
  }

  async handleDeregister(sessionId: string): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (state) {
      await saveSessionState(this.hash, state);
      this.sessions.delete(sessionId);
    }
    // NOTE: an undelivered pending batch is deliberately KEPT. The Sync Point
    // committed the AKB at render time, so a later cold-start reconcile sees
    // no drift — deleting the pending file would lose the notice entirely
    // (e2e P2-T3 2026-09-02: drift rendered mid-turn, SessionEnd deleted it,
    // next turn reported nothing). The text is timestamp-free fact wording,
    // so late delivery on resume is accurate and harmless.
  }

  /** Session declared dead by the sweep: same as deregister. */
  async handleSessionDead(sessionId: string): Promise<void> {
    await this.handleDeregister(sessionId);
  }

  // ---- mailbox message handlers ------------------------------------------

  async handle(msg: MailboxMessage): Promise<void> {
    switch (msg.type) {
      case 'session.register':
        await this.handleRegister(msg.sessionId);
        break;
      case 'session.deregister':
        await this.handleDeregister(msg.sessionId);
        break;
      case 'session.ping':
        break; // liveness already refreshed by the hook itself
      case 'akb.observe':
        await this.handleObserve(msg);
        break;
      case 'window.open':
        this.handleWindowOpen(msg);
        break;
      case 'window.close':
        this.handleWindowClose(msg);
        break;
    }
  }

  /** AKB maintenance (design §5.3): re-read the file ourselves — tool
   *  results never echo content (phase-1 C3). */
  private async handleObserve(
    msg: Extract<MailboxMessage, { type: 'akb.observe' }>,
  ): Promise<void> {
    const state = this.sessions.get(msg.sessionId);
    if (!state) return;
    const rel = toRelativeKey(this.workspaceRoot, msg.filePath);
    if (rel === null) return;
    const config = this.config;
    const hashOnly = createPatternMatcher(config.diff.blacklist)(rel); // D9
    const obs = await probeFile(this.workspaceRoot, rel, {
      maxFileSizeKB: config.diff.maxFileSizeKB,
      hashOnly,
    });
    if (!obs.exists || obs.contentHash === undefined) {
      state.akb.markKnownDeleted(rel, Date.now());
      return;
    }
    const keepContent = !obs.binary && !obs.tooLarge && obs.content !== undefined;
    let contentRef: string | undefined;
    if (keepContent && obs.content) {
      state.memoryCache.set(obs.contentHash, obs.content);
      if (config.baseline.persistContent) {
        await state.contentStore.put(obs.contentHash, obs.content);
      }
      contentRef = obs.contentHash;
    }
    state.akb.set(rel, {
      contentHash: obs.contentHash,
      ...(contentRef !== undefined ? { contentRef } : {}),
      mtimeMs: obs.mtimeMs ?? Date.now(),
      size: obs.size ?? 0,
      source: msg.action,
      updatedAt: Date.now(),
      ...(msg.toolUseId !== undefined ? { lastToolCallId: msg.toolUseId } : {}),
    });
    await this.writeAkbPaths();
  }

  /** Attribution window opened by the PreToolUse hook's mailbox message
   *  (§5.5.1-2). The pre-snapshot was taken in the hook process (P2-D5);
   *  its absolute paths normalize to workspace-relative keys here. */
  private handleWindowOpen(msg: Extract<MailboxMessage, { type: 'window.open' }>): void {
    const state = this.sessions.get(msg.sessionId);
    if (!state) return;
    const preSnapshot: Record<string, SnapshotEntry> = {};
    for (const entry of msg.preSnapshot ?? []) {
      const rel = toRelativeKey(this.workspaceRoot, entry.path);
      if (rel !== null && entry.exists) {
        preSnapshot[rel] = { mtimeMs: entry.mtimeMs, size: entry.size };
      }
    }
    const predictedPaths = (msg.predictedPaths ?? [])
      .map((p) =>
        path.isAbsolute(p)
          ? toRelativeKey(this.workspaceRoot, p)
          : p.split(path.sep).join('/'),
      )
      .filter((p): p is string => p !== null);
    state.attributor.openWindow({
      id: msg.toolUseId ?? `win-${msg.openedAt}`,
      shell: 'bash', // CC's Bash tool is bash on every supported platform
      command: msg.command,
      background: msg.background ?? false,
      openedAt: msg.openedAt,
      preSnapshot,
      predictedPaths,
    });
  }

  private handleWindowClose(msg: Extract<MailboxMessage, { type: 'window.close' }>): void {
    const state = this.sessions.get(msg.sessionId);
    if (!state || !msg.toolUseId) return;
    state.attributor.closeWindow(msg.toolUseId, msg.closedAt);
  }

  // ---- watcher pipeline (design §5.4; phase-1 pipeline.ts adapted) -------

  /** Watcher batch pipeline — public so tests can drive it without chokidar. */
  async handleWatchBatch(events: WatchEvent[]): Promise<void> {
    // .gitignore content changes rebuild the ignore matcher (hot-swap).
    if (events.some((e) => e.path === '.gitignore')) await this.refreshIgnore();
    // Project-override edits take effect via pollConfig's mtime check; the
    // watcher event just shortens the latency.
    if (events.some((e) => e.path === PROJECT_OVERRIDE_REL.split(path.sep).join('/'))) {
      await this.reloader.poll();
      for (const state of this.sessions.values()) reconfigureSession(state, this.config);
    }

    const config = this.config;
    if (!config.enabled || this.sessions.size === 0) return;

    // Probe each path once; share the observation across sessions.
    const diffBlacklisted = createPatternMatcher(config.diff.blacklist);
    const observations = new Map<string, FileObservation>();
    await Promise.all(
      events.map(async (e) => {
        observations.set(
          e.path,
          await probeFile(this.workspaceRoot, e.path, {
            maxFileSizeKB: config.diff.maxFileSizeKB,
            hashOnly: diffBlacklisted(e.path),
          }),
        );
      }),
    );
    const obsList = [...observations.values()];

    // Created-gate (D7): one batched `git ls-files` for unknown-to-AKB paths.
    let statuses: Map<string, TrackedStatus> | undefined;
    if (!config.watch.includeUntracked) {
      const candidates = new Set<string>();
      for (const state of this.sessions.values()) {
        for (const obs of obsList) {
          if (obs.exists && !state.akb.has(obs.path)) candidates.add(obs.path);
        }
      }
      if (candidates.size > 0) {
        statuses = await resolveGitTracked(this.workspaceRoot, [...candidates]);
      }
    }

    const now = Date.now();
    for (const state of this.sessions.values()) {
      try {
        // D8a: paths predicted by an open attribution window are gate-exempt.
        const createdFilter = makeCreatedFilter(statuses, {
          includeUntracked: config.watch.includeUntracked,
          predicted: (p) => state.attributor.predictedRecently(p, now),
        });
        const records = reconcile(
          state.akb,
          obsList,
          now,
          createdFilter ? { createdFilter } : {},
        );
        for (const record of records) {
          const attributed: AttributedDrift = {
            ...record,
            attribution: state.attributor.classify(record.at, record.path),
          };
          state.queue.push(attributed);
        }
        if (records.length > 0) {
          await log(
            `drift ${state.sessionId}: ${records.map((r) => `${r.kind}:${r.path}`).join(',')}`,
          );
        }
      } catch (err) {
        await log(`pipeline ${state.sessionId}: ${(err as Error).message}`);
      }
      await this.renderSession(state.sessionId);
    }
  }

  // ---- rendering ----------------------------------------------------------

  async renderSession(sessionId: string): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    try {
      await maybeRenderPending(this.hash, state, this.config, {
        paused: await this.isPaused(),
      });
    } catch (err) {
      await log(`render ${sessionId}: ${(err as Error).message}`);
    }
  }

  /** Render pass for every session (called after config/pause flips). */
  async renderAll(): Promise<void> {
    for (const sessionId of this.sessions.keys()) await this.renderSession(sessionId);
  }

  /** Absolute AKB path list for the PreToolUse hook's pre-snapshot (§5.5.2). */
  private async writeAkbPaths(): Promise<void> {
    const all = new Set<string>();
    for (const state of this.sessions.values()) {
      for (const rel of state.akb.trackedPaths()) {
        all.add(path.join(this.workspaceRoot, rel));
      }
    }
    await atomicWriteFile(akbPathsFile(this.hash), JSON.stringify([...all]));
  }
}
