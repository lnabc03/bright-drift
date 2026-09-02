import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { ContentStore } from 'bright-drift-core';
import { registerCommands } from './commands.js';
import { StateRegistry, type AgentState } from './state.js';
import { ConfigResolver, DEFAULT_CONFIG, PROJECT_OVERRIDE_REL } from './config.js';
import { Logger } from './log.js';
import { WatchRegistry } from './watchers.js';
import type { AgentLike } from './types.js';

type Result = { kind: 'success'; text?: string } | { kind: 'error'; text: string };
type Handler = (invocation: { agent: AgentLike; rawInput: string }) => Promise<Result>;

let ws: string;
let storeDir: string;
let state: AgentState;
let registry: StateRegistry;
let resolver: ConfigResolver;
let logger: Logger;
let agent: AgentLike;
let handler: Handler;

beforeEach(async () => {
  ws = await fs.mkdtemp(path.join(tmpdir(), 'bright-drift-cmd-'));
  storeDir = await fs.mkdtemp(path.join(tmpdir(), 'bright-drift-cmd-blobs-'));
  logger = new Logger(storeDir);
  registry = new StateRegistry();
  resolver = new ConfigResolver();
  agent = { session: { id: 'sess-cmd', header: { cwd: ws } } };
  state = registry.getOrCreate(agent, ws, DEFAULT_CONFIG);
  const commands = {
    register: (def: { handler: Handler }) => {
      handler = def.handler;
      return () => {};
    },
  };
  registerCommands(commands, {
    registry,
    resolver,
    watchers: new WatchRegistry(undefined, logger),
    contentStore: new ContentStore(storeDir, { maxBytes: 1024 * 1024 }),
    logger,
  });
});

afterEach(async () => {
  await fs.rm(ws, { recursive: true, force: true });
  await fs.rm(storeDir, { recursive: true, force: true });
});

const invoke = (rawInput: string): Promise<Result> => handler({ agent, rawInput });
const overrideFile = (): string => path.join(ws, ...PROJECT_OVERRIDE_REL.split('/'));

describe('/bright-drift nodiff (D9)', () => {
  it('add creates the project override file and applies immediately', async () => {
    const r = await invoke('nodiff add secret.env');
    expect(r.kind).toBe('success');
    expect(r).toMatchObject({ text: expect.stringContaining('secret.env') });

    const text = await fs.readFile(overrideFile(), 'utf8');
    expect(text).toContain('blacklist');
    expect(text).toContain('secret.env');
    // Hot-reloaded: the resolver now reports the pattern as effective.
    expect(resolver.resolve(ws).diff.blacklist).toEqual(['secret.env']);
  });

  it('add is idempotent; list shows the effective entries', async () => {
    await invoke('nodiff add secret.env');
    const dup = await invoke('nodiff add secret.env');
    expect(dup.kind).toBe('success');
    expect(dup).toMatchObject({ text: expect.stringContaining('已在 diff 黑名单中') });
    const list = await invoke('nodiff list');
    expect(list).toMatchObject({ text: expect.stringContaining('1. secret.env') });
  });

  it('remove deletes the pattern; removing an absent pattern errors', async () => {
    await invoke('nodiff add secret.env');
    await invoke('nodiff add locks/**');
    const r = await invoke('nodiff remove secret.env');
    expect(r.kind).toBe('success');
    expect(resolver.resolve(ws).diff.blacklist).toEqual(['locks/**']);

    const absent = await invoke('nodiff remove not-there.txt');
    expect(absent.kind).toBe('error');
  });

  it('preserves other keys and comments already in the override file', async () => {
    await fs.mkdir(path.dirname(overrideFile()), { recursive: true });
    await fs.writeFile(
      overrideFile(),
      '# 项目配置\nbudget:\n  maxInjectTokens: 777\ndiff:\n  blacklist: [a.lock]\n',
      'utf8',
    );
    const r = await invoke('nodiff add b.lock');
    expect(r.kind).toBe('success');
    const text = await fs.readFile(overrideFile(), 'utf8');
    expect(text).toContain('# 项目配置'); // comment survives
    expect(text).toContain('maxInjectTokens: 777');
    expect(resolver.resolve(ws).diff.blacklist).toEqual(['a.lock', 'b.lock']);
    expect(resolver.resolve(ws).budget.maxInjectTokens).toBe(777);
  });

  it('refuses to rewrite a malformed blacklist key', async () => {
    await fs.mkdir(path.dirname(overrideFile()), { recursive: true });
    await fs.writeFile(overrideFile(), 'diff:\n  blacklist: not-a-list\n', 'utf8');
    const before = await fs.readFile(overrideFile(), 'utf8');
    const r = await invoke('nodiff add secret.env');
    expect(r.kind).toBe('error');
    expect(r).toMatchObject({ text: expect.stringContaining('不是字符串数组') });
    expect(await fs.readFile(overrideFile(), 'utf8')).toBe(before); // untouched
  });

  it('requires a pattern for add/remove', async () => {
    const r = await invoke('nodiff add');
    expect(r.kind).toBe('error');
  });
});
