/**
 * FR-8: formatter-derivative detection. A change counts as cosmetic when
 * the word-token sequences of both versions are identical (only whitespace
 * and/or punctuation changed). Decided at render time, where both contents
 * are available.
 */

const WORD_TOKEN = /[\p{L}\p{N}_$]+/gu;

export function isCosmeticDiff(oldContent: string, newContent: string): boolean {
  if (oldContent === newContent) return false;
  const a = oldContent.match(WORD_TOKEN) ?? [];
  const b = newContent.match(WORD_TOKEN) ?? [];
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export interface FormatWindowOptions {
  /** Max delay after an agent write within which cosmetic diffs count as D (default 1000ms). */
  formatterWindowMs?: number;
}

/**
 * Whether a modified record should be demoted to D (formatted): the file's
 * baseline was just established by an agent write and the drift surfaced
 * within the formatter window. The caller additionally checks
 * `isCosmeticDiff` once contents are loaded.
 */
export function withinFormatterWindow(
  baselineUpdatedAt: number | undefined,
  driftAt: number,
  options: FormatWindowOptions = {},
): boolean {
  if (baselineUpdatedAt === undefined) return false;
  return driftAt - baselineUpdatedAt <= (options.formatterWindowMs ?? 1000);
}
