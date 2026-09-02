import type { DriftRecord, FileObservation } from './types.js';

/** Why a queued record was dropped during revalidation (E19). */
export type RevalidateDropReason =
  | 'phantom-create' // created, but the path no longer exists (e.g. create→rename before injection)
  | 'phantom-modify' // modified, but the path no longer exists and nothing is tracked
  | 'phantom-rename' // renamed, but the target no longer exists and the source was never tracked
  | 'net-zero' // modified, but the content hash is back at the baseline
  | 'recreated-identical'; // deleted, but the path was recreated with identical content (E4)

export interface RevalidateDrop<T> {
  record: T;
  reason: RevalidateDropReason;
}

export interface RevalidateResult<T> {
  /** Records to render — original objects, refreshed, or reclassified. */
  keep: T[];
  /** Records to retire without rendering (with reasons for the log). */
  dropped: RevalidateDrop<T>[];
}

interface BaselineLike {
  contentHash: string;
  knownDeleted?: boolean;
}

/**
 * E19: re-validate queued drift records against the live filesystem right
 * before rendering (design §5.5.2 Sync Point, step order
 * peek → revalidate → render → commit).
 *
 * The queue accumulates records across watcher batches; between enqueue and
 * injection the world keeps moving (create→rename→edit→rename lands as
 * three phantom `created` records, a file may be edited back to its
 * baseline, a deleted path may be recreated). reconcile's net-effect
 * classification only applies within one batch — this pass is its
 * cross-batch counterpart.
 *
 * Revalidation may fix the kind and refresh hashes/metadata, but never
 * re-attributes: attribution belongs to the detection moment (FR-7 window
 * semantics), so extra fields on T (e.g. `attribution`) are preserved.
 * Probe failures fail open: the record is kept as-is.
 */
export async function revalidateRecords<T extends DriftRecord>(
  records: T[],
  probe: (path: string) => Promise<FileObservation>,
  baseline: { get(path: string): BaselineLike | undefined },
): Promise<RevalidateResult<T>> {
  const keep: T[] = [];
  const dropped: RevalidateDrop<T>[] = [];
  const cache = new Map<string, Promise<FileObservation | null>>();
  const probeCached = (path: string): Promise<FileObservation | null> => {
    let p = cache.get(path);
    if (!p) {
      p = probe(path).catch(() => null); // fail-open: unknown state → keep record
      cache.set(path, p);
    }
    return p;
  };

  for (const record of records) {
    const obs = await probeCached(record.path);
    if (obs === null) {
      keep.push(record);
      continue;
    }
    const entry = baseline.get(record.path);
    const refresh = (r: T): T => {
      const out: T = {
        ...r,
        ...(obs.contentHash !== undefined ? { contentHash: obs.contentHash } : {}),
        ...(obs.mtimeMs !== undefined ? { mtimeMs: obs.mtimeMs } : {}),
        ...(obs.size !== undefined ? { size: obs.size } : {}),
      };
      // D9: the suppression marker tracks the config at render time —
      // a path blacklisted after enqueue is still annotated (and vice versa).
      if (obs.contentSuppressed === true) out.diffSuppressed = true;
      else delete out.diffSuppressed;
      return out;
    };

    switch (record.kind) {
      case 'created':
        if (!obs.exists) {
          dropped.push({ record, reason: 'phantom-create' });
        } else keep.push(refresh(record));
        break;
      case 'modified':
        if (!obs.exists) {
          if (entry && !entry.knownDeleted) {
            keep.push({ ...record, kind: 'deleted', contentHash: entry.contentHash, contentAvailable: false });
          } else {
            dropped.push({ record, reason: 'phantom-modify' });
          }
        } else if (obs.contentHash !== undefined && entry && obs.contentHash === entry.contentHash) {
          dropped.push({ record, reason: 'net-zero' });
        } else keep.push(refresh(record));
        break;
      case 'deleted':
        if (obs.exists) {
          if (obs.contentHash !== undefined && entry && obs.contentHash === entry.contentHash) {
            dropped.push({ record, reason: 'recreated-identical' });
          } else {
            keep.push({ ...refresh(record), kind: 'modified' });
          }
        } else keep.push(record);
        break;
      case 'renamed':
        if (!obs.exists) {
          const fromEntry = record.fromPath ? baseline.get(record.fromPath) : undefined;
          if (record.fromPath && fromEntry && !fromEntry.knownDeleted) {
            keep.push({
              ...record,
              kind: 'deleted',
              path: record.fromPath,
              contentHash: fromEntry.contentHash,
              contentAvailable: false,
            });
          } else {
            dropped.push({ record, reason: 'phantom-rename' });
          }
        } else keep.push(refresh(record));
        break;
    }
  }
  return { keep, dropped };
}
