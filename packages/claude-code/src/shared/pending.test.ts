import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { atomicWriteFile } from './atomic.js';
import { markDelivered, readPending } from './pending.js';
import { pendingFile } from './paths.js';
import { SCHEMA_VERSION, type PendingInjection } from './schema.js';

const HASH = 'testhash12345678';

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'bd-pending-'));
  process.env.BRIGHT_DRIFT_STATE_HOME = root;
});

afterEach(async () => {
  delete process.env.BRIGHT_DRIFT_STATE_HOME;
  await fs.rm(root, { recursive: true, force: true });
});

function sample(overrides?: Partial<PendingInjection>): PendingInjection {
  return {
    version: SCHEMA_VERSION,
    sessionId: 's1',
    batchId: 'b1',
    renderedAt: Date.now(),
    priority: 'normal',
    text: 'drift happened',
    deliveredVia: [],
    ...overrides,
  };
}

async function write(p: PendingInjection): Promise<void> {
  await atomicWriteFile(pendingFile(HASH, 's1'), JSON.stringify(p));
}

describe('readPending', () => {
  it('reads a valid pending file', async () => {
    await write(sample());
    expect((await readPending(HASH, 's1'))?.batchId).toBe('b1');
  });

  it('rejects empty text and malformed deliveredVia', async () => {
    await write(sample({ text: '' }));
    expect(await readPending(HASH, 's1')).toBeUndefined();
    await write(sample({ deliveredVia: 'stop' as unknown as string[] }));
    expect(await readPending(HASH, 's1')).toBeUndefined();
  });

  it('fails open when absent', async () => {
    expect(await readPending(HASH, 's1')).toBeUndefined();
  });
});

describe('markDelivered', () => {
  it('appends the channel exactly once', async () => {
    await write(sample());
    await markDelivered(HASH, 's1', 'user-prompt-submit');
    await markDelivered(HASH, 's1', 'user-prompt-submit');
    const p = await readPending(HASH, 's1');
    expect(p?.deliveredVia).toEqual(['user-prompt-submit']);
  });

  it('is a no-op when there is no pending file', async () => {
    await markDelivered(HASH, 's1', 'stop'); // must not throw
  });
});
