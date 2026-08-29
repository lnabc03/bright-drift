import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';

/** Resolve the dsh home directory: $DSH_HOME, else ~/.dsh (design §5.10). */
export function dshHome(): string {
  return process.env.DSH_HOME ?? path.join(homedir(), '.dsh');
}

export function stateDir(): string {
  return path.join(dshHome(), 'state', 'bright-drift');
}

export function akbDir(): string {
  return path.join(stateDir(), 'akb');
}

export function blobsDir(): string {
  return path.join(stateDir(), 'blobs');
}

export function logsDir(): string {
  return path.join(dshHome(), 'logs', 'bright-drift');
}

export async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}
