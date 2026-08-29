/**
 * FR-7 snapshot-window attribution. The window state is plain JSON —
 * serializability is a hard cross-process requirement for the phase-2
 * Claude Code daemon (PRD §6.2-5, architecture red line #2).
 */

export interface SnapshotEntry {
  mtimeMs: number;
  size: number;
  /** Present only when the file was hashed eagerly (small AKBs, FR-7.5). */
  hash?: string;
}

/** JSON-serializable shell-command observation window. */
export interface ShellWindow {
  /** Tool call id of the shell invocation. */
  id: string;
  shell: 'bash' | 'pwsh';
  /** Raw command text, echoed back in B-class/ambiguous messages. */
  command: string;
  /** run_in_background: window never closes; drift inside is always ambiguous (D5). */
  background: boolean;
  openedAt: number;
  /** post-execute arrival time; undefined while running. */
  closedAt?: number;
  /**
   * End of attribution coverage: closedAt + graceMs for foreground,
   * Number.MAX_SAFE_INTEGER for background windows.
   */
  effectiveUntil: number;
  /** Pre-command stat snapshot of AKB-tracked paths + predicted paths. */
  preSnapshot: Record<string, SnapshotEntry>;
  /** Write targets predicted by static analysis. */
  predictedPaths: string[];
}

export type AttributionCategory = 'B' | 'C';
export type AttributionConfidence = 'high' | 'ambiguous-external';

export interface Attribution {
  category: AttributionCategory;
  confidence: AttributionConfidence;
  /** The shell command blamed for B / suspected for ambiguous-external. */
  command?: string;
  /** True when the suspect command ran with run_in_background (D5 wording). */
  background?: boolean;
}

export interface AttributorOptions {
  /** Grace period after command exit during which writes still count (default 1500ms). */
  windowGraceMs?: number;
  /** Commands running longer than this make in-window drift ambiguous (default 10000ms). */
  longCommandMs?: number;
  /** Clock injection for tests. */
  now?: () => number;
}

/**
 * Per-agent attribution state. Holds open/recent shell windows; classifies
 * drift records as B (command side effect) or C (external), with the
 * asymmetric bias towards external on any ambiguity (PRD §3.6).
 */
export class Attributor {
  private windows: ShellWindow[] = [];
  private readonly graceMs: number;
  private readonly longCommandMs: number;
  private readonly now: () => number;

  constructor(options: AttributorOptions = {}) {
    this.graceMs = options.windowGraceMs ?? 1500;
    this.longCommandMs = options.longCommandMs ?? 10000;
    this.now = options.now ?? Date.now;
  }

  /** Open a window for a foreground or background shell call. */
  openWindow(window: Omit<ShellWindow, 'effectiveUntil'> & { effectiveUntil?: number }): ShellWindow {
    const full: ShellWindow = {
      ...window,
      effectiveUntil:
        window.effectiveUntil ??
        (window.background ? Number.MAX_SAFE_INTEGER : Number.MAX_SAFE_INTEGER),
    };
    this.windows.push(full);
    return full;
  }

  /**
   * Mark post-execute arrival. Foreground windows stay effective for
   * `graceMs` longer (late async writes); background windows stay open
   * forever (D5: job lifetime is unbounded, everything is ambiguous).
   */
  closeWindow(id: string, at?: number): void {
    const w = this.windows.find((x) => x.id === id);
    if (!w) return;
    const t = at ?? this.now();
    w.closedAt = t;
    if (!w.background) w.effectiveUntil = t + this.graceMs;
  }

  /** Active (covering) windows for a timestamp. */
  private covering(at: number): ShellWindow[] {
    return this.windows.filter((w) => w.openedAt <= at && at <= w.effectiveUntil);
  }

  /**
   * Classify one drift record. Category A never reaches this point (self
   * writes are dropped as echoes at reconcile time, design §5.2.4); D is
   * decided later at render time (`isCosmeticDiff` + formatter window).
   */
  classify(recordAt: number): Attribution {
    this.prune();
    const candidates = this.covering(recordAt);
    if (candidates.length === 0) return { category: 'C', confidence: 'high' };

    // Latest window wins when several overlap.
    const w = candidates[candidates.length - 1]!;
    if (w.background) {
      return { category: 'C', confidence: 'ambiguous-external', command: w.command, background: true };
    }
    const duration = (w.closedAt ?? this.now()) - w.openedAt;
    if (duration > this.longCommandMs) {
      return { category: 'C', confidence: 'ambiguous-external', command: w.command };
    }
    return { category: 'B', confidence: 'high', command: w.command };
  }

  /** Whether a path was predicted as a write target of any active window. */
  predictedByAnyWindow(path: string, at: number): boolean {
    return this.covering(at).some((w) => w.predictedPaths.includes(path));
  }

  /** Drop windows past their effective coverage. */
  prune(): void {
    const t = this.now();
    this.windows = this.windows.filter((w) => w.effectiveUntil >= t || w.closedAt === undefined);
  }

  /** Serializable state for cross-process handoff (PRD §6.2-5). */
  toJSON(): { version: 1; windows: ShellWindow[] } {
    return { version: 1, windows: this.windows.map((w) => ({ ...w })) };
  }

  static fromJSON(
    state: { version: 1; windows: ShellWindow[] },
    options: AttributorOptions = {},
  ): Attributor {
    if (state.version !== 1) throw new Error(`unsupported attributor state version`);
    const a = new Attributor(options);
    a.windows = state.windows.map((w) => ({ ...w }));
    return a;
  }
}
