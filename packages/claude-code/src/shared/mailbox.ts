import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { atomicWriteFile } from './atomic.js';
import { mailboxDir } from './paths.js';
import type { MailboxMessage } from './schema.js';

/**
 * hook→daemon mailbox (design §4.3): one JSON file per message, named
 * `<seq>-<type>.json`; seq is a zero-padded base-36 timestamp + random suffix
 * so lexicographic order ≈ chronological order and concurrent hooks never
 * collide. At-least-once, possibly out of order — consumers must be tolerant.
 */
export async function postMailbox(
  hash: string,
  sessionId: string,
  msg: MailboxMessage,
): Promise<void> {
  const seq = `${Date.now().toString(36).padStart(9, '0')}-${randomBytes(3).toString('hex')}`;
  const file = path.join(mailboxDir(hash, sessionId), `${seq}-${msg.type}.json`);
  await atomicWriteFile(file, JSON.stringify({ version: 1, ...msg }));
}

export interface DrainedMessage {
  file: string;
  msg: MailboxMessage;
}

/**
 * Read every pending message in one session's mailbox in seq order and delete
 * each file after it parses. Unparseable files are deleted too (logged by the
 * caller) — a poison message must not block the queue forever.
 */
export async function drainMailbox(dir: string): Promise<DrainedMessage[]> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  const out: DrainedMessage[] = [];
  for (const name of names.filter((n) => n.endsWith('.json')).sort()) {
    const file = path.join(dir, name);
    try {
      const raw = await fs.readFile(file, 'utf8');
      out.push({ file: name, msg: JSON.parse(raw) as MailboxMessage });
    } catch {
      // Corrupt message: drop it, keep draining.
    }
    await fs.rm(file, { force: true }).catch(() => {});
  }
  return out;
}

/** List session ids that currently have a mailbox directory. */
export async function listMailboxSessions(mailboxRootDir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(mailboxRootDir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}
