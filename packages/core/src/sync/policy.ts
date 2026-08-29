/**
 * Turn-closing-boundary suppression (design §5.5.3, E16).
 *
 * dsh's agent loop ends a turn when a pre-step collects an empty batch
 * after a step with no tool calls. Injecting into that empty batch would
 * force one extra full model request per turn. The adapter maintains a
 * per-agent `toolsRanSinceLastStep` flag (set on tools/result, cleared on
 * each pre-step read); this pure predicate carries the decision so it can
 * be unit-tested without the harness.
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
