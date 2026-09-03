import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { libDir, mkTmp, runHookFile } from '../testkit.js';
import { atomicWriteFile } from '../shared/atomic.js';
import { pendingFile, sessionFile, wsHash } from '../shared/paths.js';
import { SCHEMA_VERSION, type PendingInjection, type SessionEntry } from '../shared/schema.js';
import { STATIC_OVERVIEW, shouldInjectOverview } from './static-overview.js';

let stateHome: string;
let cwd: string;
let hash: string;
let env: NodeJS.ProcessEnv;

function hook(name: string): string {
  return path.join(libDir(), 'hooks', name);
}

function samplePending(overrides?: Partial<PendingInjection>): PendingInjection {
  return {
    version: SCHEMA_VERSION,
    sessionId: 's1',
    batchId: 'b1',
    renderedAt: Date.now(),
    priority: 'normal',
    text: 'drift notice body',
    deliveredVia: [],
    ...overrides,
  };
}

beforeEach(async () => {
  stateHome = await mkTmp('bd-hooks-state-');
  cwd = await mkTmp('bd-hooks-ws-');
  // The test process itself resolves paths against the tmp root too.
  process.env.BRIGHT_DRIFT_STATE_HOME = stateHome;
  hash = await wsHash(cwd);
  env = { BRIGHT_DRIFT_STATE_HOME: stateHome };
});

afterEach(async () => {
  delete process.env.BRIGHT_DRIFT_STATE_HOME;
  await fs.rm(stateHome, { recursive: true, force: true });
  await fs.rm(cwd, { recursive: true, force: true });
});

function parseInjection(stdout: string): { event: string; text: string } | null {
  if (!stdout.trim()) return null;
  const parsed = JSON.parse(stdout) as {
    hookSpecificOutput: { hookEventName: string; additionalContext: string };
  };
  return {
    event: parsed.hookSpecificOutput.hookEventName,
    text: parsed.hookSpecificOutput.additionalContext,
  };
}

describe('user-prompt-submit hook', () => {
  it('delivers a pending injection and records deliveredVia', async () => {
    await atomicWriteFile(pendingFile(hash, 's1'), JSON.stringify(samplePending()));
    const res = runHookFile(hook('user-prompt-submit.js'), { session_id: 's1', cwd }, env);
    expect(res.status).toBe(0);
    expect(parseInjection(res.stdout)).toEqual({
      event: 'UserPromptSubmit',
      text: 'drift notice body',
    });
    const after = JSON.parse(await fs.readFile(pendingFile(hash, 's1'), 'utf8'));
    expect(after.deliveredVia).toEqual(['user-prompt-submit']);
  });

  it('is silent on the second prompt of the same batch', async () => {
    await atomicWriteFile(
      pendingFile(hash, 's1'),
      JSON.stringify(samplePending({ deliveredVia: ['user-prompt-submit'] })),
    );
    const res = runHookFile(hook('user-prompt-submit.js'), { session_id: 's1', cwd }, env);
    expect(res.status).toBe(0);
    expect(res.stdout).toBe('');
  });

  it('refreshes session liveness even with nothing to inject', async () => {
    const res = runHookFile(hook('user-prompt-submit.js'), { session_id: 's1', cwd }, env);
    expect(res.status).toBe(0);
    expect(res.stdout).toBe('');
    const entry = JSON.parse(await fs.readFile(sessionFile(hash, 's1'), 'utf8')) as SessionEntry;
    expect(Date.now() - entry.lastSeenAt).toBeLessThan(10_000);
  });

  it('fails open on a truncated pending file (P2-T10)', async () => {
    await fs.mkdir(path.dirname(pendingFile(hash, 's1')), { recursive: true });
    await fs.writeFile(pendingFile(hash, 's1'), '{"version":1,"text":"torn', 'utf8');
    const res = runHookFile(hook('user-prompt-submit.js'), { session_id: 's1', cwd }, env);
    expect(res.status).toBe(0);
    expect(res.stdout).toBe('');
  });

  it('fails open on garbage stdin and on a missing payload', async () => {
    const garbage = runHookFile(hook('user-prompt-submit.js'), {}, env);
    expect(garbage.status).toBe(0);
    expect(garbage.stdout).toBe('');
  });

  it('stays within the 200ms cold-start budget (§8)', async () => {
    const res = runHookFile(hook('user-prompt-submit.js'), { session_id: 's1', cwd }, env);
    expect(res.elapsedMs).toBeLessThan(200);
  });
});

describe('stop hook (at-most-once gate, §5.6.2)', () => {
  it('ignores normal-priority batches', async () => {
    await atomicWriteFile(pendingFile(hash, 's1'), JSON.stringify(samplePending()));
    const res = runHookFile(hook('stop.js'), { session_id: 's1', cwd }, env);
    expect(res.status).toBe(0);
    expect(res.stdout).toBe('');
  });

  it('delivers a high-priority batch exactly once', async () => {
    await atomicWriteFile(
      pendingFile(hash, 's1'),
      JSON.stringify(samplePending({ priority: 'high' })),
    );
    const first = runHookFile(hook('stop.js'), { session_id: 's1', cwd }, env);
    expect(parseInjection(first.stdout)?.event).toBe('Stop');

    const second = runHookFile(hook('stop.js'), { session_id: 's1', cwd }, env);
    expect(second.stdout).toBe('');
  });

  it('does not re-deliver a batch already sent via user-prompt-submit', async () => {
    await atomicWriteFile(
      pendingFile(hash, 's1'),
      JSON.stringify(samplePending({ priority: 'high', deliveredVia: ['user-prompt-submit'] })),
    );
    const res = runHookFile(hook('stop.js'), { session_id: 's1', cwd }, env);
    expect(res.stdout).toBe('');
  });
});

describe('session-start hook selftest (installer dry-run, §5.9-3)', () => {
  it('reports ok without touching sessions or spawning a daemon', async () => {
    const res = runHookFile(
      hook('session-start.js'),
      { session_id: 'selftest', cwd, source: 'startup' },
      { ...env, BRIGHT_DRIFT_SELFTEST: '1' },
    );
    expect(res.status).toBe(0);
    expect(JSON.parse(res.stdout)).toMatchObject({ ok: true });
    // No workspace dirs created in selftest mode.
    expect(await fs.readdir(stateHome)).not.toContain('workspaces');
  });
});

describe('static overview (§5.6.5)', () => {
  it('labels match the phase-1 legend (EXTERNAL·* / COMMAND-SIDE-EFFECT / FORMATTED)', () => {
    expect(STATIC_OVERVIEW).toContain('EXTERNAL·*');
    expect(STATIC_OVERVIEW).toContain('COMMAND-SIDE-EFFECT');
    expect(STATIC_OVERVIEW).toContain('FORMATTED');
    expect(STATIC_OVERVIEW).not.toContain('external-change / command-side-effect / ambiguous');
  });

  it('shouldInjectOverview defaults true with no config (fail-open)', async () => {
    expect(await shouldInjectOverview(cwd)).toBe(true);
  });

  it('shouldInjectOverview honors inject.staticOverview: false', async () => {
    await fs.writeFile(path.join(stateHome, 'config.yml'), 'inject:\n  staticOverview: false\n');
    expect(await shouldInjectOverview(cwd)).toBe(false);
  });

  it('shouldInjectOverview fails open on a corrupt config', async () => {
    await fs.writeFile(path.join(stateHome, 'config.yml'), 'inject: [unclosed');
    expect(await shouldInjectOverview(cwd)).toBe(true);
  });
});
