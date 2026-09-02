import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repo lib/ of this package (tests run from src/, pretest has built lib/). */
export function libDir(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib');
}

export interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
  elapsedMs: number;
}

/** Spawn a bundled hook as CC would: JSON on stdin, JSON (maybe) on stdout. */
export function runHookFile(
  file: string,
  input: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
): RunResult {
  const started = Date.now();
  const res = spawnSync(process.execPath, [file], {
    input: JSON.stringify(input),
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 15_000,
  });
  return {
    status: res.status,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
    elapsedMs: Date.now() - started,
  };
}

/** Poll until fn() is truthy or the deadline passes. */
export async function waitFor(
  fn: () => boolean | Promise<boolean>,
  timeoutMs = 10_000,
  stepMs = 50,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return false;
}

export async function mkTmp(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}
