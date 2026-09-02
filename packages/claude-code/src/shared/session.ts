import { rm } from 'node:fs/promises';
import { atomicWriteFile, readJsonFile } from './atomic.js';
import { sessionFile } from './paths.js';
import { SCHEMA_VERSION, type SessionEntry } from './schema.js';

/**
 * Upsert a session registry entry (§4.2). Every hook call routes through
 * here so `lastSeenAt` doubles as the daemon's liveness signal (§5.2.3).
 * Unknown sessions self-heal into fresh entries.
 */
export async function touchSession(
  hash: string,
  sessionId: string,
  source?: string,
): Promise<void> {
  const file = sessionFile(hash, sessionId);
  const now = Date.now();
  const existing = await readJsonFile<SessionEntry>(file);
  const entry: SessionEntry = {
    version: SCHEMA_VERSION,
    sessionId,
    registeredAt: existing?.registeredAt ?? now,
    lastSeenAt: now,
  };
  const src = source ?? existing?.source;
  if (src !== undefined) entry.source = src;
  await atomicWriteFile(file, JSON.stringify(entry));
}

/** Remove a session entry (SessionEnd fast path). */
export async function removeSession(hash: string, sessionId: string): Promise<void> {
  await rm(sessionFile(hash, sessionId), { force: true }).catch(() => {});
}
