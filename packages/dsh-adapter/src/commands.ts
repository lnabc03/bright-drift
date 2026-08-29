import {
  createFileDiff,
  estimateTokens,
  probeFile,
  renderInjection,
  type RenderEntry,
} from 'bright-drift-core';
import type { ContentStore } from 'bright-drift-core';
import type { StateRegistry, AgentState } from './state.js';
import type { ConfigResolver } from './config.js';
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
  if (!record) {
    return { kind: 'success', text: `bright-drift: ${rel} 无待注入漂移（基线 hash ${entry!.contentHash.slice(0, 8)}）` };
  }
  const config = deps.resolver.resolve(state.workspaceRoot);
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

/** /bright-drift status | diff <path> | pause | resume (§5.10). */
export function registerCommands(commands: CommandsServiceLike, deps: CommandDeps): () => void {
  return commands.register({
    name: 'bright-drift',
    description: 'workspace drift awareness: status / diff <path> / pause / resume',
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
            return { kind: 'error', text: `未知子命令：${sub[0]}。可用：status / diff <path> / pause / resume` };
        }
      } catch (error) {
        deps.logger.error('command', error, { sessionId: state.sessionId });
        return { kind: 'error', text: `bright-drift 内部错误（已记录日志）：${error instanceof Error ? error.message : String(error)}` };
      }
    },
  });
}
