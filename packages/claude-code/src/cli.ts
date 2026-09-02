import { hooksDir, install, selfcheck, uninstall } from './installer/install.js';

/**
 * CLI entry (design §5.9):
 *   bright-drift-claude-code install [--project]
 *   bright-drift-claude-code uninstall [--project] [--purge]
 */

function usage(): void {
  console.log(
    [
      'Usage:',
      '  bright-drift-claude-code install [--project]    Merge hooks into settings.json',
      '  bright-drift-claude-code uninstall [--project] [--purge]',
      '',
      '  --project   Target <cwd>/.claude/settings.json instead of the user settings',
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
      const { settingsPath } = await install({ project });
      console.log(`bright-drift hooks merged into ${settingsPath}`);
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
