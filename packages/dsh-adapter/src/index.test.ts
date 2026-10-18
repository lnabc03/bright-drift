import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import { apply, name, Config } from './index.js';
import type { PluginConfig } from './config.js';
import { fakeAgent } from './testkit.js';

/**
 * apply() wiring tests against a mock Context (the audit's 0.2.0 postmortem:
 * the previous suite only tested sub-factories, so dead event names and a
 * removed settings service slipped through). Host-contract shape itself is
 * pinned by src/contract.ts at compile time; here we assert OUR wiring:
 * right events, right options, fail-open returns, idempotent disposal.
 */

type Listener = (...args: never[]) => unknown;

interface MockCtx {
  ctx: Context;
  listeners: Map<string, { fn: Listener; options?: { prepend?: boolean } }[]>;
  emit(name: string, ...args: never[]): unknown[];
  teardown(): void;
}

function mockCtx(): MockCtx {
  const listeners = new Map<string, { fn: Listener; options?: { prepend?: boolean } }[]>();
  let teardownFn: (() => void) | undefined;
  const ctx = {
    get: () => undefined, // timer/sandboxPolicy absent → plugin must cope (fail-open)
    on: (n: string, fn: Listener, options?: { prepend?: boolean }) => {
      listeners.set(n, [...(listeners.get(n) ?? []), { fn, options }]);
      return () => true;
    },
    inject: (_deps: string[], cb: (c: unknown) => void) => {
      cb(ctx); // synchronous provisioning of the fake services below
    },
    effect: (cb: () => (() => void) | void) => {
      teardownFn = cb() ?? undefined;
    },
    // Late-provisioned services consumed via ctx.inject([...]).
    systemPrompt: { section: () => () => {} },
    commands: { register: () => () => {} },
    fs: { processPath: (t: { targetKey: string }) => t.targetKey },
  };
  return {
    ctx: ctx as unknown as Context,
    listeners,
    emit(name, ...args) {
      return (listeners.get(name) ?? []).map((l) => l.fn(...args));
    },
    teardown() {
      teardownFn?.();
    },
  };
}

const parseConfig = (raw: Record<string, unknown>): PluginConfig => Config(raw) as PluginConfig;

let home: string;
let ws: string;
let prevHome: string | undefined;

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(tmpdir(), 'bright-drift-apply-home-'));
  ws = await fs.mkdtemp(path.join(tmpdir(), 'bright-drift-apply-ws-'));
  prevHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home; // keep plugin logs/state out of the real ~/.dsh
});

afterEach(async () => {
  if (prevHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = prevHome;
  // The plugin's teardown (watcher stop + AKB flush) and disposeState writes
  // are fire-and-forget, so a busy temp dir is expected for a moment; retry
  // rather than failing the assertion that already ran.
  const rm = (target: string) =>
    fs.rm(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  await new Promise((r) => setTimeout(r, 150));
  await rm(home);
  await rm(ws);
});

async function readEvents(): Promise<string[]> {
  const dir = path.join(home, 'logs', 'bright-drift');
  try {
    const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.log'));
    let text = '';
    for (const f of files) text += await fs.readFile(path.join(dir, f), 'utf8');
    return text
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l).event as string);
  } catch {
    return [];
  }
}

async function waitForEvent(event: string, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await readEvents()).includes(event)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

describe('apply() wiring (D10)', () => {
  it('registers the 0.2.0 event set; pre-step is prepended', () => {
    const mock = mockCtx();
    apply(mock.ctx, parseConfig({}));
    const registered = [...mock.listeners.keys()];
    for (const event of [
      'agent/created',
      'agent/disposed',
      'session/disposed',
      'agent/turn-stopping',
      'agent/pre-step',
      'tools/result',
      'tools/pre-execute',
      'tools/post-execute',
      'fs/observed',
      'loader/volatile-update',
    ]) {
      expect(registered, `missing listener: ${event}`).toContain(event);
    }
    expect(registered).not.toContain('agent/session-start'); // removed in 0.2.0 (P0-1)
    const preStep = mock.listeners.get('agent/pre-step')!;
    expect(preStep[0]!.options).toEqual({ prepend: true });
    mock.teardown();
  });

  it('agent/created returns undefined (serial event), initializes state, acquires watcher', async () => {
    const mock = mockCtx();
    apply(mock.ctx, parseConfig({}));
    const agent = fakeAgent('sess-w1', ws);
    const results = mock.emit('agent/created', { agent, source: 'startup' } as never);
    expect(results).toEqual([undefined]); // R5: never blocks/fails agent creation
    expect(await waitForEvent('session.start')).toBe(true);
    expect(await waitForEvent('watcher.acquired')).toBe(true);
    expect((await readEvents()).some((e) => e.endsWith('.error'))).toBe(false);
    mock.teardown();
  });

  it('enabled:false skips the watcher but still initializes the session', async () => {
    const mock = mockCtx();
    apply(mock.ctx, parseConfig({ enabled: false }));
    mock.emit('agent/created', { agent: fakeAgent('sess-w2', ws), source: 'startup' } as never);
    expect(await waitForEvent('session.start')).toBe(true);
    // Negative assertion: give the async override-reload path ample time to
    // (not) attach — 800ms absorbs parallel-suite scheduling jitter.
    await new Promise((r) => setTimeout(r, 800));
    expect(await readEvents()).not.toContain('watcher.acquired');
    mock.teardown();
  });

  it('agent/disposed and session/disposed are mutually idempotent (P2-2)', async () => {
    const mock = mockCtx();
    apply(mock.ctx, parseConfig({}));
    const agent = fakeAgent('sess-w3', ws);
    mock.emit('agent/created', { agent, source: 'startup' } as never);
    expect(await waitForEvent('watcher.acquired')).toBe(true);

    // Both orders must produce exactly one cleanup.
    mock.emit('agent/disposed', { agent } as never);
    mock.emit('session/disposed', agent.session as never);
    expect(await waitForEvent('session.disposed')).toBe(true);
    await new Promise((r) => setTimeout(r, 800));
    const evs = await readEvents();
    expect(evs.filter((e) => e === 'session.disposed')).toHaveLength(1);
    expect(evs.filter((e) => e === 'watcher.released')).toHaveLength(1);
    expect(evs.filter((e) => e === 'persist.saved').length).toBeGreaterThanOrEqual(1);
    mock.teardown();
  });

  it('loader/volatile-update re-applies config without remount', async () => {
    const mock = mockCtx();
    apply(mock.ctx, parseConfig({}));
    expect(await waitForEvent('config.applied')).toBe(true);
    const before = (await readEvents()).filter((e) => e === 'config.applied').length;
    mock.emit('loader/volatile-update', [['budget']] as never);
    expect(await waitForEvent('config.applied')).toBe(true);
    const evs = await readEvents();
    expect(evs.filter((e) => e === 'config.applied').length).toBeGreaterThan(before);
    expect(evs).not.toContain('plugin.disposed');
    mock.teardown();
  });

  it('plugin identity stays stable for the Loader and legacy config import', () => {
    expect(name).toBe('bright-drift');
  });
});
