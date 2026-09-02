import { execFile } from 'node:child_process';

/**
 * Git-tracking resolution for the created-drift gate (design D7).
 *
 * Lazily answers "is this path tracked by git?" for a batch of
 * workspace-relative paths with a single `git ls-files -z -- <paths>`
 * process — only invoked when a watcher batch actually contains created
 * candidates, never a full-tree scan at startup.
 *
 * Exit-code contract (verified against git 2.x):
 * - exit 0: repo OK; output lists exactly the tracked candidates (NUL-separated)
 * - non-zero (e.g. 128 "not a git repository") or spawn failure (git binary
 *   missing): cannot distinguish → every candidate is 'unknown', and the gate
 *   treats unknown as "report" (G1 beats noise reduction off-git, D7).
 */
export type TrackedStatus = 'tracked' | 'untracked' | 'unknown';

/**
 * Resolve the tracking status of workspace-relative paths under `root`.
 * Paths are POSIX-style relative keys; `git -C <root>` makes both the
 * pathspec interpretation and the output relative to `root`.
 */
export async function resolveGitTracked(
  root: string,
  paths: string[],
): Promise<Map<string, TrackedStatus>> {
  const result = new Map<string, TrackedStatus>();
  if (paths.length === 0) return result;

  const tracked = await new Promise<Set<string> | null>((resolve) => {
    execFile(
      'git',
      ['-C', root, 'ls-files', '-z', '--', ...paths],
      { maxBuffer: 16 * 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          resolve(null); // not a repo / no git binary / any failure → unknown
          return;
        }
        resolve(new Set(stdout.split('\0').filter((p) => p !== '')));
      },
    );
  });

  for (const p of paths) {
    result.set(p, tracked === null ? 'unknown' : tracked.has(p) ? 'tracked' : 'untracked');
  }
  return result;
}
