import { randomUUID } from 'node:crypto';
import {
  createFileDiff,
  estimateTokens,
  isCosmeticDiff,
  probeFile,
  renderInjection,
  revalidateRecords,
  shouldInjectAtPreStep,
  withinFormatterWindow,
  type RenderEntry,
} from 'bright-drift-core';
import type { ContentStore } from 'bright-drift-core';
import type { AgentState, StateRegistry } from './state.js';
import type { ConfigResolver, BrightDriftConfig } from './config.js';
import type { Logger } from './log.js';
import type { AttributedDrift } from './pipeline.js';
import type { PluginUserMessage, PreStepDecision, PreStepListener } from './types.js';

export interface InjectDeps {
  registry: StateRegistry;
  resolver: ConfigResolver;
  contentStore: ContentStore;
  logger: Logger;
}

/** Load the baseline content copy for a record, memory cache → disk store (E18). */
async function loadBaselineContent(
  state: AgentState,
  contentRef: string | undefined,
  deps: InjectDeps,
): Promise<Buffer | null> {
  if (contentRef === undefined) return null;
  const cached = state.memoryCache.get(contentRef);
  if (cached) return cached;
  const stored = await deps.contentStore.get(contentRef);
  if (stored) state.memoryCache.set(contentRef, stored);
  return stored;
}

/**
 * Build the injection message for the pending queue and, on success, commit
 * the Sync Point (§5.5.2): reconcile the AKB to the current disk state and
 * retire exactly the rendered records (late arrivals survive, E12 race).
 * Returns null when there is nothing to say or rendering failed (fail-open).
 */
export async function buildInjection(
  state: AgentState,
  config: BrightDriftConfig,
  deps: InjectDeps,
): Promise<PluginUserMessage | null> {
  const peeked = state.queue.peek() as AttributedDrift[];
  if (peeked.length === 0) return null;

  // E19: re-validate queued records against live disk before rendering —
  // drops phantom creates (create→rename before injection), net-zero
  // modifications, and recreated-identical deletions. Dropped records
  // retire together with the rendered ones at the Sync Point below.
  const { keep: records, dropped } = await revalidateRecords(
    peeked,
    (p) => probeFile(state.workspaceRoot, p, { maxFileSizeKB: config.diff.maxFileSizeKB }),
    state.akb,
  );
  if (dropped.length > 0) {
    deps.logger.log('inject.revalidated', {
      sessionId: state.sessionId,
      dropped: dropped.map((d) => ({ path: d.record.path, reason: d.reason })),
    });
  }
  if (records.length === 0) {
    state.queue.commitRendered(peeked);
    return null; // everything pending was phantom/net-zero — retire silently
  }

  const entries: RenderEntry[] = [];
  const freshContent = new Map<string, Buffer>();

  for (const record of records) {
    let diff: RenderEntry['diff'] = null;
    let attribution: RenderEntry['attribution'] = record.attribution;

    if (record.kind === 'modified' && record.contentAvailable) {
      const entry = state.akb.get(record.path);
      const current = await probeFile(state.workspaceRoot, record.path, {
        maxFileSizeKB: config.diff.maxFileSizeKB,
      });
      const baseline = await loadBaselineContent(state, entry?.contentRef, deps);
      if (current.exists && current.content && baseline) {
        const oldText = baseline.toString('utf8');
        const newText = current.content.toString('utf8');
        // FR-8: demote formatter-derivative changes to D (design §5.4.3).
        if (
          entry?.source === 'write' &&
          withinFormatterWindow(entry.updatedAt, record.at, {
            formatterWindowMs: config.attribution.formatterWindowMs,
          }) &&
          isCosmeticDiff(oldText, newText)
        ) {
          attribution = { category: 'D', confidence: 'high' };
        } else {
          diff = createFileDiff(oldText, newText, {
            contextLines: config.diff.contextLines,
            maxLines: config.budget.maxDiffLinesPerFile,
          });
        }
        freshContent.set(record.path, current.content);
      }
    }
    entries.push({ record, attribution, diff });
  }

  const rendered = renderInjection(entries, {
    ...config.budget,
    formatterSilent: config.attribution.formatterSilent,
  });

  // ---- Sync Point: render succeeded, the message will be persisted (C4). ----
  const now = Date.now();
  for (const record of records) {
    try {
      switch (record.kind) {
        case 'deleted':
          state.akb.markKnownDeleted(record.path, now);
          break;
        case 'renamed': {
          const from = record.fromPath;
          const old = from ? state.akb.get(from) : undefined;
          if (from) state.akb.delete(from);
          const content = freshContent.get(record.path);
          if (old || record.contentHash) {
            state.akb.set(record.path, {
              contentHash: record.contentHash ?? old!.contentHash,
              ...(old?.contentRef !== undefined ? { contentRef: old.contentRef } : {}),
              mtimeMs: record.mtimeMs ?? now,
              size: record.size ?? 0,
              source: 'read',
              updatedAt: now,
            });
          }
          void content;
          break;
        }
        case 'created':
        case 'modified': {
          const content = freshContent.get(record.path);
          let contentRef: string | undefined;
          if (content && record.contentHash) {
            state.memoryCache.set(record.contentHash, content);
            if (config.baseline.persistContent) {
              await deps.contentStore.put(record.contentHash, content);
            }
            contentRef = record.contentHash;
          }
          if (record.contentHash) {
            state.akb.set(record.path, {
              contentHash: record.contentHash,
              ...(contentRef !== undefined ? { contentRef } : {}),
              mtimeMs: record.mtimeMs ?? now,
              size: record.size ?? 0,
              source: 'read',
              ...(content === undefined ? { partial: true } : {}),
              updatedAt: now,
            });
          }
          break;
        }
      }
    } catch (error) {
      deps.logger.error('sync-point.entry', error, { sessionId: state.sessionId, path: record.path });
    }
  }
  state.queue.commitRendered(peeked); // retire rendered + dropped (E19) together
  state.stats.injections += 1;
  state.stats.tokensInjected += estimateTokens(rendered.text);
  deps.logger.log('inject.rendered', {
    sessionId: state.sessionId,
    files: records.length,
    tokens: estimateTokens(rendered.text),
  });

  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: rendered.text }],
    source: {
      kind: 'plugin',
      plugin: 'bright-drift',
      form: 'notice',
      summary: rendered.summary,
    },
  };
}

/**
 * agent/pre-step waterfall listener (§5.5.1): prepend, delegate first, then
 * append one sourced notice message to the returned enter batch.
 */
export function makePreStepListener(deps: InjectDeps): PreStepListener {
  return async (payload, next) => {
    const decision = await next();
    try {
      if (decision.kind !== 'enter') return decision;
      if (payload.signal.aborted) return decision;
      const state = deps.registry.get(payload.agent);
      if (!state) return decision;
      const config = deps.resolver.resolve(state.workspaceRoot);
      if (!config.enabled || !config.inject.onPreStep) return decision;

      const toolsRan = state.toolsRanSinceLastStep;
      state.toolsRanSinceLastStep = false;
      const shouldInject = shouldInjectAtPreStep({
        batchEmpty: decision.messages.length === 0,
        toolsRanSinceLastStep: toolsRan,
      });
      if (!shouldInject) {
        if (!state.queue.isEmpty()) {
          deps.logger.log('inject.suppressed-closing', { sessionId: state.sessionId });
        }
        return decision;
      }
      if (state.queue.isEmpty() || state.paused) return decision;

      const message = await buildInjection(state, config, deps);
      if (!message) return decision;
      return { kind: 'enter', messages: [...decision.messages, message] };
    } catch (error) {
      deps.logger.error('inject', error);
      return decision; // G5 fail-open
    }
  };
}
