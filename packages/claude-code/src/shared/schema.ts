/**
 * File-protocol schemas (phase-2 design §4). Everything that crosses a
 * process boundary — session registry, mailbox messages, pre-rendered
 * injections, workspace/daemon info, install stamp — is versioned JSON.
 */

export const SCHEMA_VERSION = 1 as const;

/** sessions/<sid>.json — §4.2. lastSeenAt is refreshed by every hook call. */
export interface SessionEntry {
  version: typeof SCHEMA_VERSION;
  sessionId: string;
  registeredAt: number;
  lastSeenAt: number;
  /** SessionStart source of the most recent (re)registration. */
  source?: string;
}

/** Mailbox message envelope: one JSON file per message, §4.3. */
export type MailboxMessage =
  | {
      type: 'session.register';
      sessionId: string;
      cwd: string;
      source?: string;
      transcriptPath?: string;
    }
  | { type: 'session.deregister'; sessionId: string; reason?: string }
  | {
      type: 'akb.observe';
      sessionId: string;
      toolUseId?: string;
      tool: string;
      filePath: string;
      action: 'read' | 'write';
    }
  | {
      type: 'window.open';
      sessionId: string;
      toolUseId?: string;
      command: string;
      shell?: string;
      background?: boolean;
      openedAt: number;
      preSnapshot?: WindowPreSnapshotEntry[];
      predictedPaths?: string[];
    }
  | { type: 'window.close'; sessionId: string; toolUseId?: string; closedAt: number }
  | { type: 'session.ping'; sessionId: string };

/** One stat() sample of an AKB-tracked path, taken by the PreToolUse hook. */
export interface WindowPreSnapshotEntry {
  path: string;
  mtimeMs: number;
  size: number;
  exists: boolean;
}

/** pending/<sid>.json — pre-rendered injection, daemon→hook, §4.4. */
export interface PendingInjection {
  version: typeof SCHEMA_VERSION;
  sessionId: string;
  /** Drift batch id; the Stop-channel gate is keyed on this (§5.6.2). */
  batchId: string;
  renderedAt: number;
  /** high = AKB-tracked file deleted/renamed; only high goes via Stop. */
  priority: 'normal' | 'high';
  /** Ready-to-inject text, guaranteed ≤ 9,500 chars by the renderer (§5.7). */
  text: string;
  /** Channels that already delivered this batch ('user-prompt-submit' | 'stop'). */
  deliveredVia: string[];
}

/** workspace.json — daemon identity for idempotent launch (§5.2.1). */
export interface WorkspaceInfo {
  version: typeof SCHEMA_VERSION;
  root: string;
  daemonPid: number;
  daemonStartedAt: number;
}

/** install.json — installer version stamp (§5.9). */
export interface InstallInfo {
  version: typeof SCHEMA_VERSION;
  installedAt: number;
  hooksPath: string;
  settingsTarget: string;
}
