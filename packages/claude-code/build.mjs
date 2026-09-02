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

// CJS deps (yaml) use dynamic require, which an ESM bundle lacks — shim it.
const REQUIRE_SHIM =
  "import { createRequire as __bdCreateRequire } from 'node:module';" +
  'const require = __bdCreateRequire(import.meta.url);';

/** @type {esbuild.BuildOptions} */
const base = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  sourcemap: false,
  minify: false,
  logLevel: 'warning',
  banner: { js: REQUIRE_SHIM },
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
    banner: { js: `#!/usr/bin/env node\n${REQUIRE_SHIM}` },
  }),
]);

console.log('built lib/hooks/*, lib/daemon/main.js, lib/cli.js');
