import type { Agent } from '@deepseek-ai/dsh-agent';

/**
 * Minimal Agent stand-in for unit tests. The real Agent is a rich runtime
 * interface; tests only ever touch `session.id` / `session.header.cwd`, so a
 * narrow stub with a cast keeps them honest without a host process.
 * (Excluded from the published build via tsconfig.)
 */
export function fakeAgent(sessionId: string, cwd: string): Agent {
  return { session: { id: sessionId, header: { cwd } } } as unknown as Agent;
}
