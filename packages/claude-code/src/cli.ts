import { hooksDir, install, selfcheck, uninstall } from './installer/install.js';
import { cmdDiff, cmdNodiff, cmdPause, cmdResume, cmdStatus } from './cli-commands.js';

/**
 * CLI entry (design §5.9/§5.10):
 *   bright-drift-claude-code install [--project]
 *   bright-drift-claude-code uninstall [--project] [--purge]
 *   bright-drift-claude-code status
 *   bright-drift-claude-code diff <path>
 *   bright-drift-claude-code pause | resume
 *   bright-drift-claude-code nodiff <glob> [...]
 */

function usage(): void {
  console.log(
    [
      'Usage:',
      '  bright-drift-claude-code install [--project]    Merge hooks into settings.json',
      '  bright-drift-claude-code uninstall [--project] [--purge]',
      '  bright-drift-claude-code status                 Daemon/session/pending overview',
      '  bright-drift-claude-code diff <path>            Diff a file vs the last delivered baseline',
      '  bright-drift-claude-code pause                  Pause injection (monitoring continues)',
      '  bright-drift-claude-code resume                 Resume; accumulated drift is delivered',
      '  bright-drift-claude-code nodiff <glob> [...]    Suppress diffs for paths (list only)',
      '',
      '  --project   Target <cwd>/.claude/ instead of the user-level ~/.claude/',
      '  --purge     Also delete the state directory on uninstall',
    ].join('\n'),
  );
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const project = rest.includes('--project');
  const purge = rest.includes('--purge');

  switch (command) {
    case 'install': {
      const { settingsPath, stoppedDaemons } = await install({ project });
      console.log(`bright-drift hooks merged into ${settingsPath}`);
      if (stoppedDaemons > 0) {
        console.log(
          `stopped ${stoppedDaemons} running daemon(s) — they relaunch on the next session with the freshly installed build`,
        );
      }
      const check = selfcheck(hooksDir());
      if (check.ok) {
        console.log(`selfcheck ok (${check.detail})`);
      } else {
        console.error(`selfcheck FAILED: ${check.detail}`);
        console.error('hooks were installed but may not run; ensure node >=20 is on PATH.');
        return 1;
      }
      return 0;
    }
    case 'uninstall': {
      const { settingsPath } = await uninstall({ project, purge });
      console.log(`bright-drift hooks removed from ${settingsPath}`);
      console.log(purge ? 'state directory deleted.' : `state kept at (use --purge to delete).`);
      return 0;
    }
    case 'status':
      return cmdStatus();
    case 'diff':
      return cmdDiff(rest.filter((a) => !a.startsWith('--'))[0]);
    case 'pause':
      return cmdPause();
    case 'resume':
      return cmdResume();
    case 'nodiff':
      return cmdNodiff(rest.filter((a) => !a.startsWith('--')));
    case undefined:
    case 'help':
    case '--help':
      usage();
      return command === undefined ? 1 : 0;
    default:
      console.error(`unknown command: ${command}`);
      usage();
      return 1;
  }
}

process.exitCode = await main(process.argv.slice(2)).catch((err) => {
  console.error(`bright-drift-claude-code: ${(err as Error).message}`);
  return 1;
});
