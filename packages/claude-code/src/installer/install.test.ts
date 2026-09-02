import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkTmp } from '../testkit.js';
import {
  buildHookEntries,
  install,
  mergeHooks,
  removeOwnHooks,
  uninstall,
} from './install.js';

const HOOKS_DIR = path.join('C:\\deps', 'bright-drift-claude-code', 'lib', 'hooks');

let dir: string;
let settingsPath: string;

beforeEach(async () => {
  dir = await mkTmp('bd-install-');
  settingsPath = path.join(dir, 'settings.json');
  process.env.BRIGHT_DRIFT_STATE_HOME = path.join(dir, 'state');
  // Point the installer at a realistic package-layout hooks dir.
  process.env.BRIGHT_DRIFT_HOOKS_DIR = HOOKS_DIR;
});

afterEach(async () => {
  delete process.env.BRIGHT_DRIFT_STATE_HOME;
  delete process.env.BRIGHT_DRIFT_HOOKS_DIR;
  await fs.rm(dir, { recursive: true, force: true });
});

async function readSettings(): Promise<unknown> {
  return JSON.parse(await fs.readFile(settingsPath, 'utf8'));
}

describe('mergeHooks / removeOwnHooks', () => {
  it('strips only our commands and keeps third-party hooks', () => {
    const settings = {
      otherKey: { keep: true },
      hooks: {
        UserPromptSubmit: [
          { hooks: [{ type: 'command' as const, command: 'node', args: ['C:/other/hook.js'] }] },
          {
            hooks: [
              {
                type: 'command' as const,
                command: 'node',
                args: [path.join(HOOKS_DIR, 'user-prompt-submit.js')],
              },
            ],
          },
        ],
      },
    };
    removeOwnHooks(settings);
    expect(settings.hooks?.UserPromptSubmit).toHaveLength(1);
    expect(settings.hooks?.UserPromptSubmit?.[0]?.hooks[0]?.args[0]).toBe('C:/other/hook.js');
    expect(settings.otherKey).toEqual({ keep: true });
  });

  it('drops the hooks key entirely once nothing remains', () => {
    const settings = {
      hooks: {
        Stop: [
          {
            hooks: [
              { type: 'command' as const, command: 'node', args: [`x/${'bright-drift-claude-code'}/lib/hooks/stop.js`] },
            ],
          },
        ],
      },
    };
    removeOwnHooks(settings);
    expect('hooks' in settings).toBe(false);
  });

  it('merge is additive and idempotent across upgrades (path change)', () => {
    const settings = {
      hooks: {
        SessionStart: [
          {
            hooks: [
              { type: 'command' as const, command: 'node', args: ['old/bright-drift-claude-code/lib/hooks/session-start.js'] },
            ],
          },
        ],
      },
    };
    mergeHooks(settings, buildHookEntries(HOOKS_DIR));
    mergeHooks(settings, buildHookEntries(HOOKS_DIR)); // re-run = upgrade, not duplicate
    expect(settings.hooks.SessionStart).toHaveLength(1);
    expect(settings.hooks.SessionStart?.[0]?.hooks[0]?.args[0]).toBe(
      path.join(HOOKS_DIR, 'session-start.js'),
    );
  });
});

describe('install / uninstall (P2-T12)', () => {
  it('install creates settings with all six events, exec form, async SessionStart', async () => {
    await install({ settingsPath });
    const s = await readSettings() as unknown as {
      hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string; args: string[]; async?: boolean }> }>>;
    };
    expect(Object.keys(s.hooks).sort()).toEqual(
      ['PostToolUse', 'PreToolUse', 'SessionEnd', 'SessionStart', 'Stop', 'UserPromptSubmit'].sort(),
    );
    const start = s.hooks.SessionStart?.[0]?.hooks[0];
    expect(start?.command).toBe('node');
    expect(start?.async).toBe(true);
    expect(start?.args[0]).toContain('bright-drift-claude-code');
    expect(s.hooks.PostToolUse?.[0]?.matcher).toContain('Bash');
    expect(s.hooks.PreToolUse?.[0]?.matcher).toBe('Bash');

    const stamp = JSON.parse(
      await fs.readFile(path.join(dir, 'state', 'install.json'), 'utf8'),
    );
    expect(stamp.settingsTarget).toBe(settingsPath);
  });

  it('install preserves pre-existing third-party hooks', async () => {
    await fs.writeFile(
      settingsPath,
      JSON.stringify({
        hooks: {
          UserPromptSubmit: [
            { hooks: [{ type: 'command', command: 'node', args: ['C:/other/hook.js'] }] },
          ],
        },
      }),
    );
    await install({ settingsPath });
    const s = await readSettings() as unknown as {
      hooks: { UserPromptSubmit: Array<{ hooks: Array<{ args: string[] }> }> };
    };
    expect(s.hooks.UserPromptSubmit).toHaveLength(2);
  });

  it('uninstall removes our hooks and keeps everything else', async () => {
    await fs.writeFile(
      settingsPath,
      JSON.stringify({
        model: 'opus',
        hooks: {
          Stop: [{ hooks: [{ type: 'command', command: 'node', args: ['C:/other/stop.js'] }] }],
        },
      }),
    );
    await install({ settingsPath });
    await uninstall({ settingsPath });
    const s = await readSettings() as unknown as { model?: string; hooks?: Record<string, unknown[]> };
    expect(s.model).toBe('opus');
    expect(s.hooks?.Stop).toHaveLength(1);
    for (const [event, entries] of Object.entries(s.hooks ?? {})) {
      if (event === 'Stop') continue;
      for (const e of entries as Array<{ hooks: Array<{ args: string[] }> }>) {
        expect(e.hooks[0]?.args[0]).not.toContain('bright-drift-claude-code');
      }
    }
  });
});
