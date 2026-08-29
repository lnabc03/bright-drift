import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { logsDir } from './paths.js';

/**
 * FR-6 logger: JSONL at ~/.dsh/logs/bright-drift/<date>.log.
 * Privacy red line (AGENTS.md §5): NEVER log file content — only paths,
 * hashes, counts, timings. All failures are swallowed (fail-open, G5).
 */
export class Logger {
  private dirReady: Promise<void> | undefined;

  private ensure(): Promise<void> {
    this.dirReady ??= fs.mkdir(logsDir(), { recursive: true }).then(() => undefined);
    return this.dirReady;
  }

  /** Fire-and-forget structured log line. `fields` must be content-free. */
  log(event: string, fields: Record<string, unknown> = {}): void {
    const line = JSON.stringify({ t: new Date().toISOString(), event, ...fields }) + '\n';
    const file = path.join(logsDir(), `${new Date().toISOString().slice(0, 10)}.log`);
    this.ensure()
      .then(() => fs.appendFile(file, line))
      .catch(() => {
        /* fail-open: logging must never break the plugin */
      });
  }

  error(event: string, error: unknown, fields: Record<string, unknown> = {}): void {
    const message = error instanceof Error ? error.message : String(error);
    this.log(`${event}.error`, { ...fields, error: message });
  }
}
