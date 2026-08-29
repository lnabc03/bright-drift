import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { ContentStore, probeFile, sha1 } from 'bright-drift-core';
import { buildInjection } from './inject.js';
import { handleWatchBatch } from './pipeline.js';
import { StateRegistry, type AgentState } from './state.js';
import { ConfigResolver, DEFAULT_CONFIG } from './config.js';
import { Logger } from './log.js';
import type { AgentLike } from './types.js';

let ws: string;
let storeDir: string;
let state: AgentState;
let registry: StateRegistry;
let resolver: ConfigResolver;
let contentStore: ContentStore;
let logger: Logger;

beforeEach(async () => {
  ws = await fs.mkdtemp(path.join(tmpdir(), 'bright-drift-ws-'));
  storeDir = await fs.mkdtemp(path.join(tmpdir(), 'bright-drift-blobs-'));
  logger = new Logger(storeDir); // keep tests out of the real ~/.dsh/logs
  registry = new StateRegistry();
  resolver = new ConfigResolver();
  contentStore = new ContentStore(storeDir, { maxBytes: 1024 * 1024 });
  const agent: AgentLike = { session: { id: 'sess-1', header: { cwd: ws } } };
  state = registry.getOrCreate(agent, ws, DEFAULT_CONFIG);
});

afterEach(async () => {
  await fs.rm(ws, { recursive: true, force: true });
  await fs.rm(storeDir, { recursive: true, force: true });
});

const deps = () => ({ registry, resolver, contentStore, logger });

/** Simulate the tools/result path: probe + establish a read baseline with content copy. */
async function establishBaseline(rel: string): Promise<void> {
  const obs = await probeFile(ws, rel);
  if (!obs.exists || !obs.content) throw new Error('fixture file missing');
  state.memoryCache.set(obs.contentHash, obs.content);
  state.akb.set(rel, {
    contentHash: obs.contentHash,
    contentRef: obs.contentHash,
    mtimeMs: obs.mtimeMs ?? 0,
    size: obs.size ?? 0,
    source: 'read',
    updatedAt: Date.now(),
  });
}

describe('buildInjection end-to-end (FR-2/FR-3/FR-4 core loop)', () => {
  it('E2: external modification renders a line-level diff and syncs the baseline', async () => {
    await fs.writeFile(path.join(ws, 'a.ts'), 'const TTL = 3600;\n');
    await establishBaseline('a.ts');
    await fs.writeFile(path.join(ws, 'a.ts'), 'const TTL = 7200;\n');

    await handleWatchBatch(ws, [{ path: 'a.ts', kind: 'change' }], registry.statesForRoot(ws), {
      resolver,
      logger,
    });
    expect(state.queue.size).toBe(1);

    const message = await buildInjection(state, DEFAULT_CONFIG, deps());
    expect(message).not.toBeNull();
    expect(message!.source).toMatchObject({ kind: 'plugin', plugin: 'bright-drift', form: 'notice' });
    expect(message!.source.summary.length).toBeLessThanOrEqual(120);
    const text = message!.content[0]!.text;
    expect(text).toContain('EXTERNAL·MODIFIED (high confidence)  a.ts');
    expect(text).toContain('-const TTL = 3600;');
    expect(text).toContain('+const TTL = 7200;');

    // Sync Point: queue retired, AKB rebased to the new content.
    expect(state.queue.isEmpty()).toBe(true);
    expect(state.akb.get('a.ts')?.contentHash).toBe(sha1('const TTL = 7200;\n'));

    // Second injection with no new drift → nothing to say.
    expect(await buildInjection(state, DEFAULT_CONFIG, deps())).toBeNull();
  });

  it('E1: agent self-write echo never enters the queue', async () => {
    await fs.writeFile(path.join(ws, 'a.ts'), 'v1\n');
    await establishBaseline('a.ts');
    // Agent rewrites (baseline updated by observe path BEFORE watcher echo).
    await fs.writeFile(path.join(ws, 'a.ts'), 'v2\n');
    await establishBaseline('a.ts');
    await handleWatchBatch(ws, [{ path: 'a.ts', kind: 'change' }], registry.statesForRoot(ws), {
      resolver,
      logger,
    });
    expect(state.queue.isEmpty()).toBe(true);
  });

  it('E3: deletion of a tracked file is queued as deleted', async () => {
    await fs.writeFile(path.join(ws, 'a.ts'), 'x\n');
    await establishBaseline('a.ts');
    await fs.rm(path.join(ws, 'a.ts'));
    await handleWatchBatch(ws, [{ path: 'a.ts', kind: 'unlink' }], registry.statesForRoot(ws), {
      resolver,
      logger,
    });
    const message = await buildInjection(state, DEFAULT_CONFIG, deps());
    expect(message!.content[0]!.text).toContain('EXTERNAL·DELETED (high confidence)  a.ts');
    expect(state.akb.get('a.ts')?.knownDeleted).toBe(true);
  });

  it('command side effect inside an FR-7 window is attributed B', async () => {
    state.attributor.openWindow({
      id: 'call-1',
      shell: 'pwsh',
      command: 'npm run codegen',
      background: false,
      openedAt: Date.now(),
      preSnapshot: {},
      predictedPaths: [],
    });
    await fs.writeFile(path.join(ws, 'gen.ts'), 'export {}\n');
    await handleWatchBatch(ws, [{ path: 'gen.ts', kind: 'add' }], registry.statesForRoot(ws), {
      resolver,
      logger,
    });
    const message = await buildInjection(state, DEFAULT_CONFIG, deps());
    expect(message!.content[0]!.text).toContain('COMMAND-SIDE-EFFECT  你的命令 `npm run codegen`');
  });

  it('D5: background command drift is ambiguous-external with 后台任务 wording', async () => {
    state.attributor.openWindow({
      id: 'call-bg',
      shell: 'pwsh',
      command: 'node watcher.js',
      background: true,
      openedAt: Date.now(),
      preSnapshot: {},
      predictedPaths: [],
    });
    state.attributor.closeWindow('call-bg');
    await fs.writeFile(path.join(ws, 'out.log'), 'line\n');
    await handleWatchBatch(ws, [{ path: 'out.log', kind: 'add' }], registry.statesForRoot(ws), {
      resolver,
      logger,
    });
    const message = await buildInjection(state, DEFAULT_CONFIG, deps());
    const text = message!.content[0]!.text;
    expect(text).toContain('ambiguous-external');
    expect(text).toContain('后台任务');
    expect(text).toContain('`node watcher.js`');
  });

  it('FR-8: cosmetic change right after an agent write is demoted to FORMATTED', async () => {
    await fs.writeFile(path.join(ws, 'fmt.ts'), 'const x = 1\n');
    await establishBaseline('fmt.ts');
    // Simulate an agent write baseline (source: write), then a formatter pass.
    state.akb.set('fmt.ts', { ...state.akb.get('fmt.ts')!, source: 'write', updatedAt: Date.now() });
    await fs.writeFile(path.join(ws, 'fmt.ts'), 'const   x = 1;\n');
    await handleWatchBatch(ws, [{ path: 'fmt.ts', kind: 'change' }], registry.statesForRoot(ws), {
      resolver,
      logger,
    });
    const message = await buildInjection(state, DEFAULT_CONFIG, deps());
    expect(message!.content[0]!.text).toContain('FORMATTED  fmt.ts');
  });
});
