/**
 * Turn-closing-boundary suppression (design §5.5.3, E16; revised by M0-2/F10).
 *
 * M0 runtime measurement corrected the mechanism: dsh's loop breaks right
 * after a no-tool step when the inbox is empty (agent-loop L564–571), so a
 * normal turn close fires NO trailing empty-batch pre-step. Empty batches
 * with no intervening tool calls remain only on two rare paths — a
 * post-`turnEnds` empty claim (L542) and an empty first claim (L543) —
 * where appending a message would force a model request that otherwise
 * would not run. Injecting into tool-continuation steps (empty batch but
 * tools ran) is free: the step runs regardless.
 *
 * The adapter maintains a per-agent `toolsRanSinceLastStep` flag (set on
 * tools/result, cleared on each pre-step read); this pure predicate carries
 * the decision so it can be unit-tested without the harness.
 */
export interface PreStepContext {
  /** Whether the collected enter-batch already carries messages. */
  batchEmpty: boolean;
  /** Whether any tool executed since the previous pre-step boundary. */
  toolsRanSinceLastStep: boolean;
}

export function shouldInjectAtPreStep(ctx: PreStepContext): boolean {
  if (!ctx.batchEmpty) return true; // normal step — inject
  if (ctx.toolsRanSinceLastStep) return true; // tool-loop continuation — inject
  return false; // suspected closing check — defer to next turn
}
