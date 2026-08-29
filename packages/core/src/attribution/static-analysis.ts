/**
 * Shallow static analysis of shell commands to predict write-target paths
 * (design §5.4.2, D5: bash + pwsh dual grammar). Parse failures never throw;
 * callers fall back to pure window-based attribution with an empty result.
 */

/** Split a command line into pipeline/sequence segments, honoring quotes. */
export function splitSegments(command: string): string[] {
  const segments: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i]!;
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
    } else if (ch === '|' || ch === ';' || (ch === '&' && command[i + 1] === '&')) {
      if (current.trim()) segments.push(current.trim());
      current = '';
      if (ch === '&') i += 1;
    } else {
      current += ch;
    }
  }
  if (quote) throw new Error('unterminated quote');
  if (current.trim()) segments.push(current.trim());
  return segments;
}

/** Tokenize one segment, honoring quotes. Quotes are stripped from tokens. */
export function tokenize(segment: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let has = false;
  for (let i = 0; i < segment.length; i += 1) {
    const ch = segment[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      has = true;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (has) {
        tokens.push(current);
        current = '';
        has = false;
      }
    } else {
      current += ch;
      has = true;
    }
  }
  if (quote) throw new Error('unterminated quote');
  if (has) tokens.push(current);
  return tokens;
}

const REDIRECT = /^\d?>>?$/;

/** Extract write targets from one token stream (shared operators). */
function extractCommon(tokens: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const tok = tokens[i]!;
    // Bare redirection operator: target is the next token.
    if (REDIRECT.test(tok)) {
      const target = tokens[i + 1];
      if (target && !REDIRECT.test(target) && !target.startsWith('&')) {
        out.push(target);
        i += 1;
      }
      continue;
    }
    // Attached redirections like `>file`, `2>file`, `>>file`.
    // fd duplication (`2>&1`, `>&-`) is not a file write.
    const attached = /^\d?(>>?)(.+)$/.exec(tok);
    if (attached?.[2]) {
      const target = attached[2];
      if (!target.startsWith('&') && target !== '-') out.push(target);
    }
  }
  return out;
}

/** bash: > >> tee sed -i and -o output flags (design §5.4.2). */
export function analyzeBash(command: string): string[] {
  try {
    const out: string[] = [];
    for (const segment of splitSegments(command)) {
      const tokens = tokenize(segment);
      out.push(...extractCommon(tokens));
      for (let i = 0; i < tokens.length; i += 1) {
        const tok = tokens[i]!;
        if ((tok === 'tee' || tok.endsWith('/tee')) ) {
          for (let j = i + 1; j < tokens.length; j += 1) {
            if (tokens[j]!.startsWith('-')) continue; // -a etc.
            out.push(tokens[j]!);
          }
        }
        if (tok === 'sed' || tok.endsWith('/sed')) {
          const hasInPlace = tokens.slice(i + 1).some((t) => t === '-i' || /^-i/.test(t));
          if (hasInPlace) {
            // Last non-option, non-script token is the file.
            const files = tokens.slice(i + 1).filter((t) => !t.startsWith('-'));
            const file = files[files.length - 1];
            if (file) out.push(file);
          }
        }
        if (tok === '-o') {
          const target = tokens[i + 1];
          if (target && !target.startsWith('-')) {
            out.push(target);
            i += 1;
          }
        }
      }
    }
    return [...new Set(out)];
  } catch {
    return [];
  }
}

/**
 * pwsh (PowerShell): > >> Out-File [-Append], Set-Content/Add-Content,
 * Tee-Object (-FilePath) (design §5.4.2, D5).
 */
export function analyzePwsh(command: string): string[] {
  try {
    const out: string[] = [];
    for (const segment of splitSegments(command)) {
      const tokens = tokenize(segment);
      out.push(...extractCommon(tokens));
      for (let i = 0; i < tokens.length; i += 1) {
        const tok = tokens[i]!.toLowerCase();
        if (tok === 'out-file' || tok === 'set-content' || tok === 'add-content') {
          // First non-flag token after the cmdlet is the path
          // (-FilePath/-Path may name it explicitly).
          for (let j = i + 1; j < tokens.length; j += 1) {
            const t = tokens[j]!;
            const lower = t.toLowerCase();
            if (lower === '-filepath' || lower === '-path') {
              const target = tokens[j + 1];
              if (target) {
                out.push(target);
                j += 1;
              }
              continue;
            }
            if (t.startsWith('-')) continue; // -Append, -Encoding utf8 …
            // For -Encoding-style pairs the next token is a value; the
            // conservative choice is to take the first bare token as path
            // and stop — covered cmdlets take the path first in practice.
            out.push(t);
            break;
          }
        }
        if (tok === 'tee-object') {
          for (let j = i + 1; j < tokens.length; j += 1) {
            const t = tokens[j]!;
            if (t.toLowerCase() === '-filepath') {
              const target = tokens[j + 1];
              if (target) out.push(target);
              break;
            }
            if (!t.startsWith('-')) {
              out.push(t);
              break;
            }
          }
        }
      }
    }
    return [...new Set(out)];
  } catch {
    return [];
  }
}

/** Dispatch on shell kind; unknown shells get redirection-only analysis. */
export function analyzeCommand(shell: 'bash' | 'pwsh', command: string): string[] {
  return shell === 'pwsh' ? analyzePwsh(command) : analyzeBash(command);
}
