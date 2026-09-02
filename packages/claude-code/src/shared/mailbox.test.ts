import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { drainMailbox, listMailboxSessions, postMailbox } from './mailbox.js';

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'bd-mailbox-'));
  process.env.BRIGHT_DRIFT_STATE_HOME = root;
});

afterEach(async () => {
  delete process.env.BRIGHT_DRIFT_STATE_HOME;
  await fs.rm(root, { recursive: true, force: true });
});

// mailbox paths derive from the state root, so a fixed fake hash is fine.
const HASH = 'testhash12345678';

describe('mailbox', () => {
  it('delivers messages in seq order and deletes consumed files', async () => {
    await postMailbox(HASH, 's1', { type: 'session.ping', sessionId: 's1' });
    await new Promise((r) => setTimeout(r, 5));
    await postMailbox(HASH, 's1', {
      type: 'akb.observe',
      sessionId: 's1',
      tool: 'Read',
      filePath: '/x',
      action: 'read',
    });

    const dir = path.join(root, 'workspaces', HASH, 'mailbox', 's1');
    const drained = await drainMailbox(dir);
    expect(drained.map((d) => d.msg.type)).toEqual(['session.ping', 'akb.observe']);
    expect(await fs.readdir(dir)).toEqual([]);
  });

  it('drops a corrupt message without blocking the queue', async () => {
    await postMailbox(HASH, 's1', { type: 'session.ping', sessionId: 's1' });
    const dir = path.join(root, 'workspaces', HASH, 'mailbox', 's1');
    await fs.writeFile(path.join(dir, 'zzzzzzzzz-corrupt.json'), '{torn', 'utf8');

    const drained = await drainMailbox(dir);
    expect(drained.map((d) => d.msg.type)).toEqual(['session.ping']);
    expect(await fs.readdir(dir)).toEqual([]);
  });

  it('drains an absent directory to empty', async () => {
    expect(await drainMailbox(path.join(root, 'nope'))).toEqual([]);
  });

  it('lists mailbox session dirs', async () => {
    await postMailbox(HASH, 's1', { type: 'session.ping', sessionId: 's1' });
    await postMailbox(HASH, 's2', { type: 'session.ping', sessionId: 's2' });
    const sessions = await listMailboxSessions(path.join(root, 'workspaces', HASH, 'mailbox'));
    expect(sessions.sort()).toEqual(['s1', 's2']);
  });
});
