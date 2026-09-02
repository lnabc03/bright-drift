// Build pipeline (phase-2 design §5.5.3): every hook entry point and the
// daemon are bundled into zero-dependency single files under lib/, so a hook
// process is plain `node <file>.js` with no module resolution at runtime.
import * as esbuild from 'esbuild';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));

const hookEntries = [
  'session-start',
  'user-prompt-submit',
  'post-tool-use',
  'pre-tool-use-bash',
  'stop',
  'session-end',
];

/** @type {esbuild.BuildOptions} */
const base = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  sourcemap: false,
  minify: false,
  logLevel: 'warning',
};

await Promise.all([
  ...hookEntries.map((name) =>
    esbuild.build({
      ...base,
      entryPoints: [path.join(root, 'src', 'hooks', `${name}.ts`)],
      outfile: path.join(root, 'lib', 'hooks', `${name}.js`),
    }),
  ),
  esbuild.build({
    ...base,
    entryPoints: [path.join(root, 'src', 'daemon', 'main.ts')],
    outfile: path.join(root, 'lib', 'daemon', 'main.js'),
  }),
  esbuild.build({
    ...base,
    entryPoints: [path.join(root, 'src', 'cli.ts')],
    outfile: path.join(root, 'lib', 'cli.js'),
    banner: { js: '#!/usr/bin/env node' },
  }),
]);

console.log('built lib/hooks/*, lib/daemon/main.js, lib/cli.js');
