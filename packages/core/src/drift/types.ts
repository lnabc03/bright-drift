export type DriftKind = 'created' | 'modified' | 'deleted' | 'renamed';

/**
 * One observed drift, always expressed as the net effect relative to the
 * AKB baseline (see `reconcile`). Paths are workspace-relative, POSIX-style.
 */
export interface DriftRecord {
  path: string;
  kind: DriftKind;
  /** Source path for `renamed` records. */
  fromPath?: string;
  /** New content hash when known. */
  contentHash?: string;
  /**
   * Whether a full content copy of both sides is available, making a
   * line-level diff meaningful. False for partial-read baselines (E8),
   * evicted blobs (E18), binary and oversized files.
   */
  contentAvailable: boolean;
  /**
   * Diff deliberately suppressed by the user-configured diff blacklist
   * (D9): the probe ran hash-only, so no line-level diff exists by policy.
   * Renderers annotate this explicitly instead of looking like a failure.
   */
  diffSuppressed?: boolean;
  binary?: boolean;
  tooLarge?: boolean;
  mtimeMs?: number;
  size?: number;
  /** Detection time (epoch ms). */
  at: number;
}

/** Snapshot of one file's on-disk state, produced by the watcher/reconciler. */
export interface FileObservation {
  path: string;
  exists: boolean;
  /** SHA-1 of current content; undefined when unhashed (binary/oversized/missing). */
  contentHash?: string;
  /** Full content when read (small text files only). */
  content?: Buffer;
  mtimeMs?: number;
  size?: number;
  binary?: boolean;
  tooLarge?: boolean;
  /**
   * Probe ran hash-only because the path matches the diff blacklist (D9):
   * the hash is exact, but content was deliberately not captured.
   */
  contentSuppressed?: boolean;
}
