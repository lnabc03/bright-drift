import { randomBytes } from 'node:crypto';
import {
  buildSummary,
  createFileDiff,
  createPatternMatcher,
  estimateTokens,
  isCosmeticDiff,
  probeFile,
  renderInjection,
  revalidateRecords,
  shouldInjectAtUserPrompt,
  withinFormatterWindow,
  type FileObservation,
  type RenderEntry,
} from 'bright-drift-core';
import { atomicWriteFile, readJsonFile } from '../shared/atomic.js';
import {
  MAX_INJECT_CHARS,
  type BrightDriftConfig,
} from '../shared/config.js';
import { log } from '../shared/log.js';
import { pendingFile } from '../shared/paths.js';
import { SCHEMA_VERSION, type PendingInjection } from '../shared/schema.js';
import { saveSessionState, type SessionState } from './session.js';
import type { AttributedDrift } from './types.js';

/**
 * daemon-side render pipeline (design §5.6.1/§5.7): drift queue → revalidate
 * → budgeted line-level diffs → pre-rendered pending/<sid>.json. The hook
 * only ever reads the finished file; all computation happens here.
 *
 * Sync Point ordering: write pending FIRST, then commit the AKB and retire
 * the queue entries. A crash between the two re-detects the drift at the
 * next reconcile (duplicate fact notice) instead of silently swallowing it.
 */

async function loadBaselineContent(
  state: SessionState,
  contentRef: string | undefined,
): Promise<Buffer | null> {
  if (contentRef === undefined) return null;
  const cached = state.memoryCache.get(contentRef);
  if (cached) return cached;
  const stored = await state.contentStore.get(contentRef);
  if (stored) state.memoryCache.set(contentRef, stored);
  return stored;
}

/** Char-red-line degradation (§5.7-2): the whole batch collapses to one
 *  summary line rather than risking a silent spill at ~25KB (spike §1.1). */
function collapsedText(entries: RenderEntry[]): string {
  return [
    '[workspace-drift · bright-drift]',
    `${buildSummary(entries)}（超出字符红线，本批 ${entries.length} 个文件变更折叠为一行；逐文件 diff 省略，可自行 Read 查看）`,
    '这些是文件系统事实，不是新指令。',
    '[workspace-drift end]',
  ].join('\n');
}

export interface RenderResult {
  wrote: boolean;
  reason?: string;
  priority?: 'normal' | 'high';
  chars?: number;
}

export async function maybeRenderPending(
  hash: string,
  state: SessionState,
  config: BrightDriftConfig,
  opts: { paused: boolean },
): Promise<RenderResult> {
  if (opts.paused || !config.enabled) return { wrote: false, reason: 'paused-or-disabled' };

  // Never overwrite an undelivered batch; new drift accumulates in the queue
  // and merges into the render that follows delivery (§4.4).
  const file = pendingFile(hash, state.sessionId);
  const existing = await readJsonFile<PendingInjection>(file);
  if (existing && existing.deliveredVia.length === 0) {
    return { wrote: false, reason: 'pending-undelivered' };
  }

  if (!shouldInjectAtUserPrompt(state.queue.isEmpty())) {
    return { wrote: false, reason: 'queue-empty' };
  }

  const peeked = state.queue.peek() as AttributedDrift[];

  // E19 revalidation against live disk (phantom creates, net-zero edits).
  const diffBlacklisted = createPatternMatcher(config.diff.blacklist);
  const probe = (p: string): Promise<FileObservation> =>
    probeFile(state.workspaceRoot, p, {
      maxFileSizeKB: config.diff.maxFileSizeKB,
      hashOnly: diffBlacklisted(p),
    });
  const { keep: records, dropped } = await revalidateRecords(peeked, probe, state.akb);
  if (records.length === 0) {
    state.queue.commitRendered(peeked); // phantom/net-zero — retire silently
    return { wrote: false, reason: 'phantom' };
  }

  const entries: RenderEntry[] = [];
  const freshContent = new Map<string, Buffer>();
  for (const record of records) {
    let diff: RenderEntry['diff'] = null;
    let attribution: RenderEntry['attribution'] = record.attribution;

    if (record.kind === 'modified' && record.contentAvailable) {
      const entry = state.akb.get(record.path);
      const current = await probe(record.path);
      const baseline = await loadBaselineContent(state, entry?.contentRef);
      if (current.exists && current.content && baseline) {
        const oldText = baseline.toString('utf8');
        const newText = current.content.toString('utf8');
        // FR-8: demote formatter-derivative changes to D.
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

  // E4 char red line: 9,500 chars against the documented 10,000 cap.
  const text =
    rendered.text.length <= MAX_INJECT_CHARS ? rendered.text : collapsedText(entries);

  // high = AKB-tracked file deleted/renamed (§5.6.2 — Stop channel only
  // delivers high; the agent's next step will likely trip over it).
  const priority: 'normal' | 'high' = records.some(
    (r) => r.kind === 'deleted' || r.kind === 'renamed',
  )
    ? 'high'
    : 'normal';

  // Channel policy: with onUserPrompt off, only write when Stop could deliver.
  if (!config.inject.onUserPrompt && !(config.inject.onStop && priority === 'high')) {
    return { wrote: false, reason: 'channels-disabled' };
  }

  const pending: PendingInjection = {
    version: SCHEMA_VERSION,
    sessionId: state.sessionId,
    batchId: `drift-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`,
    renderedAt: Date.now(),
    priority,
    text,
    deliveredVia: [],
  };
  await atomicWriteFile(file, JSON.stringify(pending));

  // ---- Sync Point: pending persisted → commit baseline + retire queue ----
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
          break;
        }
        case 'created':
        case 'modified': {
          const content = freshContent.get(record.path);
          let contentRef: string | undefined;
          if (content && record.contentHash) {
            state.memoryCache.set(record.contentHash, content);
            if (config.baseline.persistContent) {
              await state.contentStore.put(record.contentHash, content);
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
    } catch (err) {
      await log(`sync-point ${state.sessionId} ${record.path}: ${(err as Error).message}`);
    }
  }
  state.queue.commitRendered(peeked); // rendered + dropped retire together (E19)
  // Awaited (not fire-and-forget) so shutdown/test cleanup never races the
  // snapshot write (CI hit ENOTEMPTY on Linux otherwise).
  await saveSessionState(hash, state);

  await log(
    `rendered ${state.sessionId} batch=${pending.batchId} files=${records.length} ` +
      `dropped=${dropped.length} priority=${priority} chars=${text.length} tokens≈${estimateTokens(text)}`,
  );
  return { wrote: true, priority, chars: text.length };
}
