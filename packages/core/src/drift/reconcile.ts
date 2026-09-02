import type { AgentKnowledgeBase } from '../baseline/akb.js';
import type { DriftRecord, FileObservation } from './types.js';

/**
 * Reconcile current file observations against the AKB and classify drift
 * as the net effect versus the baseline. Pure function — the caller
 * (watcher pipeline, session-start reconciler) gathers observations.
 *
 * Classification rules (design §5.3, PRD §4.4):
 * - exists && unknown to AKB            → created, subject to the
 *   `createdFilter` gate (D7: git-tracked only unless includeUntracked;
 *   window-predicted paths exempt, D8a)
 * - exists && hash matches baseline     → echo, dropped (E1)
 * - exists && baseline was knownDeleted → modified when hash differs (E4),
 *                                         nothing when identical
 * - exists && hash differs              → modified
 * - missing && tracked && !knownDeleted → deleted (E3)
 * - missing && untracked / knownDeleted → nothing
 *
 * A post-pass merges deleted+created pairs with identical hashes into a
 * single `renamed` record (E5). The gate runs BEFORE the merge: a created
 * suppressed by the gate can neither appear nor absorb a deleted record
 * (the delete stays reported on its own — losing the file is the salient fact).
 */
export interface ReconcileOptions {
  /** Gate for `created` records (design D7); absent = report every create. */
  createdFilter?: (path: string) => boolean;
}

export function reconcile(
  akb: AgentKnowledgeBase,
  observations: FileObservation[],
  now: number,
  options: ReconcileOptions = {},
): DriftRecord[] {
  const records: DriftRecord[] = [];

  for (const obs of observations) {
    const entry = akb.get(obs.path);
    const base = {
      path: obs.path,
      at: now,
      contentAvailable: false,
      ...(obs.contentHash !== undefined ? { contentHash: obs.contentHash } : {}),
      ...(obs.binary !== undefined ? { binary: obs.binary } : {}),
      ...(obs.tooLarge !== undefined ? { tooLarge: obs.tooLarge } : {}),
      ...(obs.mtimeMs !== undefined ? { mtimeMs: obs.mtimeMs } : {}),
      ...(obs.size !== undefined ? { size: obs.size } : {}),
    };

    if (obs.exists) {
      const sameHash =
        obs.contentHash !== undefined && entry?.contentHash === obs.contentHash;
      if (sameHash) continue; // E1 echo / E4 identical recreate
      if (!entry) {
        if (options.createdFilter && !options.createdFilter(obs.path)) continue; // D7 gate
        records.push({ ...base, kind: 'created', contentAvailable: false });
      } else {
        // Line-level diffs need a complete baseline copy AND current content.
        const contentAvailable =
          !entry.partial &&
          entry.contentRef !== undefined &&
          obs.content !== undefined &&
          !obs.binary &&
          !obs.tooLarge;
        records.push({
          ...base,
          kind: 'modified',
          contentAvailable,
          // D9: hash-only probe (diff blacklist) → file-level by policy.
          ...(obs.contentSuppressed ? { diffSuppressed: true } : {}),
        });
      }
    } else if (entry && !entry.knownDeleted) {
      // The baseline hash rides along so deleted+created pairs with
      // identical content can merge into `renamed` (E5).
      records.push({
        path: obs.path,
        kind: 'deleted',
        contentAvailable: false,
        at: now,
        contentHash: entry.contentHash,
      });
    }
  }

  return mergeRenames(records);
}

/** E5: deleted X + created Y with the same content hash ⇒ renamed X → Y. */
export function mergeRenames(records: DriftRecord[]): DriftRecord[] {
  const createdByHash = new Map<string, DriftRecord[]>();
  for (const r of records) {
    if (r.kind === 'created' && r.contentHash !== undefined) {
      const list = createdByHash.get(r.contentHash) ?? [];
      list.push(r);
      createdByHash.set(r.contentHash, list);
    }
  }
  if (createdByHash.size === 0) return records;

  const consumed = new Set<DriftRecord>();
  const renamed: DriftRecord[] = [];
  for (const r of records) {
    if (r.kind !== 'deleted') continue;
    const candidates = r.contentHash !== undefined ? createdByHash.get(r.contentHash) : undefined;
    const target = candidates?.find((c) => !consumed.has(c));
    if (!target) continue;
    consumed.add(r);
    consumed.add(target);
    renamed.push({
      path: target.path,
      fromPath: r.path,
      kind: 'renamed',
      contentAvailable: false,
      at: Math.max(r.at, target.at),
      ...(r.contentHash !== undefined ? { contentHash: r.contentHash } : {}),
    });
  }
  if (renamed.length === 0) return records;
  return [...records.filter((r) => !consumed.has(r)), ...renamed];
}
