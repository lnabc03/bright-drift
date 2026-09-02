import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { Document, parseDocument, isSeq } from 'yaml';
import {
  createFileDiff,
  createPatternMatcher,
  estimateTokens,
  probeFile,
  renderInjection,
  type RenderEntry,
} from 'bright-drift-core';
import type { ContentStore } from 'bright-drift-core';
import type { StateRegistry, AgentState } from './state.js';
import type { ConfigResolver } from './config.js';
import { PROJECT_OVERRIDE_REL } from './config.js';
import type { Logger } from './log.js';
import type { WatchRegistry } from './watchers.js';
import type { AgentLike, CommandsServiceLike } from './types.js';
import type { AttributedDrift } from './pipeline.js';

export interface CommandDeps {
  registry: StateRegistry;
  resolver: ConfigResolver;
  watchers: WatchRegistry;
  contentStore: ContentStore;
  logger: Logger;
}

type CommandResult = { kind: 'success'; text?: string } | { kind: 'error'; text: string };

function statusText(state: AgentState): string {
  const { stats } = state;
  return [
    `bright-drift status (session ${state.sessionId})`,
    `  workspace: ${state.workspaceRoot}`,
    `  AKB entries: ${state.akb.size}`,
    `  pending drift: ${state.queue.size}`,
    `  injections so far: ${stats.injections} (≈${stats.tokensInjected} tokens)`,
    `  paused: ${state.paused}`,
  ].join('\n');
}

/** Preview the pending diff for one path (§5.10 `/bright-drift diff <path>`). */
async function diffPreview(
  state: AgentState,
  rel: string,
  deps: CommandDeps,
): Promise<CommandResult> {
  const record = state.queue.peek().find((r) => r.path === rel) as AttributedDrift | undefined;
  const entry = state.akb.get(rel);
  if (!record && !entry) {
    return { kind: 'error', text: `bright-drift: ${rel} 既无待注入漂移也无基线记录` };
  }
  const config = deps.resolver.resolve(state.workspaceRoot);
  // D9: blacklisted paths never show content — preview degrades likewise.
  if (createPatternMatcher(config.diff.blacklist)(rel)) {
    const line = record
      ? `有待注入漂移（${record.kind}，hash ${record.contentHash?.slice(0, 8) ?? '?'}）`
      : `无待注入漂移（基线 hash ${entry!.contentHash.slice(0, 8)}）`;
    return { kind: 'success', text: `bright-drift: ${rel} ${line}；该路径在 diff.blacklist 中，内容预览被抑制` };
  }
  if (!record) {
    return { kind: 'success', text: `bright-drift: ${rel} 无待注入漂移（基线 hash ${entry!.contentHash.slice(0, 8)}）` };
  }
  const current = await probeFile(state.workspaceRoot, rel, { maxFileSizeKB: config.diff.maxFileSizeKB });
  let baseline: Buffer | null = null;
  if (entry?.contentRef) {
    baseline = state.memoryCache.get(entry.contentRef) ?? (await deps.contentStore.get(entry.contentRef));
  }
  let renderEntry: RenderEntry = { record, attribution: record.attribution, diff: null };
  if (current.content && baseline && record.kind === 'modified') {
    const diff = createFileDiff(baseline.toString('utf8'), current.content.toString('utf8'), {
      contextLines: config.diff.contextLines,
      maxLines: config.budget.maxDiffLinesPerFile,
    });
    renderEntry = { ...renderEntry, diff };
  }
  const rendered = renderInjection([renderEntry], config.budget);
  return { kind: 'success', text: `${rendered.text}\n\n(summary: ${rendered.summary}, ≈${estimateTokens(rendered.text)} tokens)` };
}

/**
 * Load the project override as a YAML Document (comments/formatting
 * preserved on rewrite). Missing file → empty Document; the caller decides
 * whether to create it.
 */
async function loadOverrideDocument(root: string): Promise<{ doc: Document; file: string }> {
  const file = path.join(root, ...PROJECT_OVERRIDE_REL.split('/'));
  try {
    const doc: Document = parseDocument(await fs.readFile(file, 'utf8'));
    if (doc.contents === null) doc.contents = doc.createNode({}); // empty file
    return { doc, file };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return { doc: new Document({}), file };
  }
}

/** Project-level diff.blacklist entries; undefined when the key is unset. */
function projectBlacklist(doc: Document): string[] | undefined {
  const node = doc.getIn(['diff', 'blacklist']);
  if (node === undefined || node === null) return undefined;
  const value = isSeq(node) ? node.toJSON() : undefined;
  if (Array.isArray(value) && value.every((x) => typeof x === 'string')) return value;
  throw new Error(`${PROJECT_OVERRIDE_REL} 的 diff.blacklist 不是字符串数组，拒绝自动改写（请手动编辑）`);
}

/**
 * D9: `/bright-drift nodiff add|remove <pattern>` edits the project-level
 * override file, then reloads it so the change applies immediately (the
 * watcher event would do the same one debounce later).
 */
async function nodiffEdit(
  state: AgentState,
  op: 'add' | 'remove',
  pattern: string,
  deps: CommandDeps,
): Promise<CommandResult> {
  const { doc, file } = await loadOverrideDocument(state.workspaceRoot);
  const list = projectBlacklist(doc) ?? [];
  const has = list.includes(pattern);
  if (op === 'add' && has) {
    return { kind: 'success', text: `bright-drift: \`${pattern}\` 已在 diff 黑名单中（共 ${list.length} 项）` };
  }
  if (op === 'remove' && !has) {
    return { kind: 'error', text: `bright-drift: \`${pattern}\` 不在 diff 黑名单中` };
  }
  const next = op === 'add' ? [...list, pattern] : list.filter((p) => p !== pattern);
  doc.setIn(['diff', 'blacklist'], next);
  await fs.mkdir(path.dirname(file), { recursive: true });
  // Explicit UTF-8 write (AGENTS.md §5: never round-trip via GBK defaults).
  await fs.writeFile(file, doc.toString(), 'utf8');
  await deps.resolver.reloadOverride(state.workspaceRoot);
  deps.logger.log('command.nodiff', { sessionId: state.sessionId, op, pattern, count: next.length });
  const verb = op === 'add' ? '加入' : '移出';
  return {
    kind: 'success',
    text: `bright-drift: 已把 \`${pattern}\` ${verb} diff 黑名单（项目级 ${PROJECT_OVERRIDE_REL}，现共 ${next.length} 项），热重载已生效`,
  };
}

function nodiffList(state: AgentState, deps: CommandDeps): CommandResult {
  const effective = deps.resolver.resolve(state.workspaceRoot).diff.blacklist;
  const body = effective.length
    ? effective.map((p, i) => `  ${i + 1}. ${p}`).join('\n')
    : '  （空）';
  return {
    kind: 'success',
    text: `bright-drift diff 黑名单（生效值）：\n${body}\n管理：/bright-drift nodiff add|remove <pattern>，或直接编辑 ${PROJECT_OVERRIDE_REL}（项目级清单整体覆盖全局设置）`,
  };
}

/** /bright-drift status | diff <path> | pause | resume (§5.10). */
export function registerCommands(commands: CommandsServiceLike, deps: CommandDeps): () => void {
  return commands.register({
    name: 'bright-drift',
    description: 'workspace drift awareness: status / diff <path> / nodiff / pause / resume',
    // Without an input descriptor the composer only admits the bare
    // command and treats trailing text as a plain message (verified
    // against dsh-commands built-ins: /permission, /feedback, /plan).
    input: { hint: '[status|diff <path>|nodiff add|remove|list [pattern]|pause|resume]' },
    handler: async (invocation): Promise<CommandResult> => {
      const agent: AgentLike = invocation.agent;
      const state = deps.registry.get(agent);
      if (!state) return { kind: 'error', text: 'bright-drift: 当前会话未初始化（尚无 workspace root）' };

      const sub = invocation.rawInput.trim().split(/\s+/).filter(Boolean);
      try {
        switch (sub[0] ?? 'status') {
          case 'status':
            return { kind: 'success', text: statusText(state) + `\n  watcher roots: ${deps.watchers.roots.join(', ') || '(none)'}` };
          case 'diff': {
            const rel = sub[1];
            if (!rel) return { kind: 'error', text: '用法：/bright-drift diff <path>' };
            return await diffPreview(state, rel, deps);
          }
          case 'nodiff': {
            const action = sub[1] ?? 'list';
            if (action === 'list') return nodiffList(state, deps);
            if (action === 'add' || action === 'remove') {
              const pattern = sub[2];
              if (!pattern) return { kind: 'error', text: `用法：/bright-drift nodiff ${action} <pattern>` };
              return await nodiffEdit(state, action, pattern, deps);
            }
            return { kind: 'error', text: `未知 nodiff 操作：${action}。可用：add / remove / list` };
          }
          case 'pause':
            state.paused = true;
            deps.logger.log('command.pause', { sessionId: state.sessionId });
            return { kind: 'success', text: 'bright-drift 已暂停注入（监控与基线维护继续）；恢复用 /bright-drift resume' };
          case 'resume':
            state.paused = false;
            deps.logger.log('command.resume', { sessionId: state.sessionId, pending: state.queue.size });
            return {
              kind: 'success',
              text: `bright-drift 已恢复注入；累计 ${state.queue.size} 条漂移将在下一个 step 边界一次性补投`,
            };
          default:
            return { kind: 'error', text: `未知子命令：${sub[0]}。可用：status / diff <path> / nodiff add|remove|list / pause / resume` };
        }
      } catch (error) {
        deps.logger.error('command', error, { sessionId: state.sessionId });
        return { kind: 'error', text: `bright-drift 内部错误（已记录日志）：${error instanceof Error ? error.message : String(error)}` };
      }
    },
  });
}
