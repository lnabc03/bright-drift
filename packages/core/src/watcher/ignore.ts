import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import ignoreModule from 'ignore';
import type { Ignore } from 'ignore';

// `ignore` is CJS: under NodeNext the default-import type resolves to the
// module namespace, but at runtime the binding is the factory itself
// (index.js assigns both module.exports and module.exports.default).
const createIgnore = ignoreModule as unknown as () => Ignore;

/** Built-in ignore table (design §5.3). */
export const BUILTIN_IGNORE = [
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  'coverage',
  'target',
  '__pycache__',
  '.venv',
  'vendor',
];

export interface IgnoreRulesOptions {
  respectGitignore?: boolean;
  /** Additional gitignore-style patterns (config `watch.extraIgnore`). */
  extraIgnore?: string[];
  /** Called with .gitignore read failures; defaults to silent (fail-open). */
  onError?: (error: unknown) => void;
}

/**
 * Build a path matcher for chokidar's `ignored` option. Combines the
 * built-in table, the workspace `.gitignore` (when respected) and
 * user-provided extra patterns. Returned matcher takes workspace-relative
 * POSIX paths.
 */
export async function createIgnoreMatcher(
  root: string,
  options: IgnoreRulesOptions = {},
): Promise<(relPath: string) => boolean> {
  const matcher: Ignore = createIgnore();
  matcher.add(BUILTIN_IGNORE.map((d) => `${d}/`));
  if (options.extraIgnore?.length) matcher.add(options.extraIgnore);

  if (options.respectGitignore !== false) {
    try {
      const content = await fs.readFile(path.join(root, '.gitignore'), 'utf8');
      matcher.add(content);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') options.onError?.(error);
    }
  }

  return (relPath: string) => {
    if (relPath === '') return false;
    return matcher.ignores(relPath);
  };
}
