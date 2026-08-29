/**
 * AKB (Agent Knowledge Base) entry — what the agent is known to believe
 * about one workspace file. See design doc §5.1.
 */
export interface AKBEntry {
  /** SHA-1 of the full file content at baseline time. */
  contentHash: string;
  /**
   * Content-store blob key (equals contentHash). Absent when no content
   * copy exists (partial reads, evicted blobs, persistContent disabled) —
   * drift for such files degrades to file-level reporting.
   */
  contentRef?: string;
  mtimeMs: number;
  size: number;
  /** Which tool kind established this baseline. */
  source: 'read' | 'write';
  /** True when the establishing read was offset/limit-truncated (FR-1.1). */
  partial?: boolean;
  /** Set when a re-read found the file gone (kept instead of dropping the entry). */
  knownDeleted?: boolean;
  /** Epoch ms of the last baseline update. */
  updatedAt: number;
  /** Tool call id that established the latest baseline (D-class heuristics). */
  lastToolCallId?: string;
}

/** JSON-serializable AKB snapshot, keyed by sessionId on disk (design C5). */
export interface AKBSnapshot {
  version: 1;
  sessionId: string;
  savedAt: number;
  entries: Record<string, AKBEntry>;
}

export interface AKBOptions {
  /** Max tracked paths; oldest-updated entries are evicted (FR-1.4). Default 5000. */
  maxEntries?: number;
}

export const DEFAULT_MAX_ENTRIES = 5000;
