import { structuredPatch } from 'diff';

export interface FileDiffOptions {
  /** Context lines around changes (design FR-4: default 3). */
  contextLines?: number;
  /** Max rendered patch lines per file (design FR-4: default 200). */
  maxLines?: number;
}

export interface FileDiff {
  added: number;
  removed: number;
  /** Rendered unified-diff hunks (no file header), possibly truncated. */
  patch: string;
  truncated: boolean;
  /** Patch line count before truncation. */
  totalLines: number;
}

/** Null-byte probe on the first 8KB — cheap binary detection (design §5.3). */
export function isBinaryContent(content: Buffer): boolean {
  const probe = content.subarray(0, 8192);
  return probe.includes(0);
}

/**
 * Build a unified diff between baseline and current content, counted and
 * line-truncated. Returns null when contents are identical.
 */
export function createFileDiff(
  oldContent: string,
  newContent: string,
  options: FileDiffOptions = {},
): FileDiff | null {
  if (oldContent === newContent) return null;
  const contextLines = options.contextLines ?? 3;
  const maxLines = options.maxLines ?? 200;

  const patch = structuredPatch('baseline', 'current', oldContent, newContent, '', '', {
    context: contextLines,
  });

  let added = 0;
  let removed = 0;
  const lines: string[] = [];
  for (const hunk of patch.hunks) {
    lines.push(
      `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
    );
    for (const line of hunk.lines) {
      if (line.startsWith('+')) added += 1;
      else if (line.startsWith('-')) removed += 1;
      lines.push(line);
    }
  }

  const totalLines = lines.length;
  const truncated = totalLines > maxLines;
  const body = truncated ? lines.slice(0, maxLines) : lines;
  return {
    added,
    removed,
    patch: body.join('\n'),
    truncated,
    totalLines,
  };
}

/** Rough estimate: 4 chars ≈ 1 token (design §5.7). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
