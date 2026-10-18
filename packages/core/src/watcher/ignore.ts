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
  /**
   * Workspace-relative POSIX paths that stay watched even when the built-in
   * table, `.gitignore` or `extraIgnore` would hide them, plus their ancestor
   * directories so chokidar still descends into them. Used for the project
   * override file, which conventionally lives in a gitignored `.dsh/`
   * directory — without this, editing it would never reach the pipeline.
   */
  forceInclude?: string[];
  /** Called with .gitignore read failures; defaults to silent (fail-open). */
  onError?: (error: unknown) => void;
}

/** Normalize a workspace-relative path for force-include comparisons. */
function normalizePath(raw: string): string {
  const posix = raw.replaceAll('\\', '/');
  const stripped = posix.replace(/^\.\//, '').replace(/\/+$/, '');
  return stripped;
}

/**
 * Build a path matcher for chokidar's `ignored` option. Combines the
 * built-in table, the workspace `.gitignore` (when respected),
 * user-provided extra patterns, and `forceInclude` exemptions. Returned
 * matcher takes workspace-relative POSIX paths.
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

  // Force-included paths and every ancestor directory stay visible.
  const forced = new Set<string>();
  for (const raw of options.forceInclude ?? []) {
    const rel = normalizePath(raw);
    if (rel === '') continue;
    const segments = rel.split('/');
    for (let depth = 1; depth <= segments.length; depth += 1) {
      forced.add(segments.slice(0, depth).join('/'));
    }
  }

  return (relPath: string) => {
    if (relPath === '') return false;
    if (forced.has(normalizePath(relPath))) return false;
    return matcher.ignores(relPath);
  };
}

/**
 * Build a matcher over bare gitignore-style patterns only — no built-in
 * table, no .gitignore read (D9 diff blacklist). Empty pattern list yields
 * a matcher that never matches.
 */
export function createPatternMatcher(patterns: string[]): (relPath: string) => boolean {
  if (patterns.length === 0) return () => false;
  const matcher: Ignore = createIgnore();
  matcher.add(patterns);
  return (relPath: string) => relPath !== '' && matcher.ignores(relPath);
}
