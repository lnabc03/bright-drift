/**
 * Module augmentations and shared local aliases for the dsh Host plane.
 *
 * 0.4.0 (dsh 0.2.0, D10): production code consumes the REAL dsh `.d.ts`
 * types directly — the hand-written structural shims this file used to
 * hold were never type-checked against the host and let every 0.2.0
 * break slip through tsc. What remains here is only OUR contribution to
 * the harness's merge-extensible maps, plus narrow aliases the real
 * types intentionally leave opaque (tool arguments, event actors).
 */
import type { ContextFormed } from '@deepseek-ai/dsh-llm';
import type { Agent } from '@deepseek-ai/dsh-agent';

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /**
     * bright-drift workspace-drift notices (design §5.5, F2). 0.2.0 removed
     * the shared catch-all `plugin` kind; every producer declares its own.
     */
    'bright-drift': {
      kind: 'bright-drift';
    } & ContextFormed;
  }
}

/**
 * `ToolExecution.arguments` is `unknown` in the host types (tools validate
 * their own schemas). The observe channel only reads the tool-facing
 * `file_path` / `command` / `run_in_background` fields, so it narrows to a
 * string-keyed record at the boundary.
 */
export type ToolArguments = Record<string, unknown>;

/**
 * `fs/observed`'s `actor` is `object | undefined`; for tool-originated
 * observations it is the ToolExecution. We only need its `agent` field.
 */
export interface FsActorLike {
  agent?: Agent;
}
