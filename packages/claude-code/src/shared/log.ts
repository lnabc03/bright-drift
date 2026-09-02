import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { logsDir } from './paths.js';

/**
 * Append-only daemon log (privacy discipline per PRD FR-6: hashes, paths,
 * counts — never file contents). Best-effort; logging must never throw.
 */
export async function log(line: string): Promise<void> {
  try {
    const date = new Date().toISOString().slice(0, 10);
    const file = path.join(logsDir(), `${date}.log`);
    await fs.mkdir(logsDir(), { recursive: true });
    await fs.appendFile(file, `${new Date().toISOString()} ${line}\n`, 'utf8');
  } catch {
    // best-effort
  }
}
