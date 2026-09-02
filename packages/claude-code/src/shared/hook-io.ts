/**
 * Hook process plumbing. Every hook is a short-lived node process (P2-D1):
 * JSON in on stdin, optional JSON out on stdout, exit 0 no matter what
 * (fail-open is an acceptance criterion — a broken hook must never block
 * the session, design G4 / PRD principles).
 */

/** Read the hook payload from stdin. Malformed/absent input yields {}. */
export async function readHookInput(): Promise<Record<string, unknown>> {
  let raw = '';
  try {
    for await (const chunk of process.stdin) raw += chunk;
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Wrap text into the hookSpecificOutput envelope CC expects (§1.3). */
export function emitAdditionalContext(hookEventName: string, text: string): void {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName, additionalContext: text },
    }),
  );
}

/** Extract the two fields every bright-drift hook needs; null → bail out. */
export function hookContext(
  input: Record<string, unknown>,
): { sessionId: string; cwd: string } | null {
  const sessionId = input.session_id;
  const cwd = input.cwd;
  if (typeof sessionId !== 'string' || sessionId.length === 0) return null;
  if (typeof cwd !== 'string' || cwd.length === 0) return null;
  return { sessionId, cwd };
}

/**
 * Run a hook body with a blanket fail-open guard: any throw is swallowed,
 * stdout stays clean, exit code stays 0.
 */
export async function runHook(
  main: (input: Record<string, unknown>) => Promise<void>,
): Promise<void> {
  try {
    await main(await readHookInput());
  } catch {
    // fail-open: nothing on stdout, exit 0
  }
}
