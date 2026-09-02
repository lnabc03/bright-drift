# bright-drift-claude-code

Workspace drift awareness for [Claude Code](https://docs.anthropic.com/en/docs/claude-code): a detached watcher daemon detects file changes made outside the agent's own tool calls (by the user or other processes) and injects budget-capped, attributed diffs into the agent context through hooks.

> Phase-2 package of the [bright-drift](https://github.com/lnabc03/bright-drift) monorepo. The platform-independent engine lives in [`bright-drift-core`](https://www.npmjs.com/package/bright-drift-core).

## Install

```bash
npx bright-drift-claude-code install            # user-level ~/.claude/settings.json
npx bright-drift-claude-code install --project  # this repo's .claude/settings.json
npx bright-drift-claude-code uninstall          # remove hooks (state kept; --purge to delete)
```

Hooks are **merged** into `settings.json` (never overwritten) and registered in exec form (`node <file>` — no shell dependency, Windows-safe). Re-running `install` upgrades in place. The installer also drops four slash commands into `commands/bright-drift/`:

| Command | Effect |
|---|---|
| `/bright-drift:status` | Daemon liveness, live sessions, undelivered batches, pause state |
| `/bright-drift:pause` | Pause injection for this workspace (monitoring continues) |
| `/bright-drift:resume` | Resume — accumulated drift is delivered in one batch |
| `/bright-drift:nodiff <glob>` | Suppress line-level diffs for matching paths (list-only notice) |

## What you get

- External edits/deletes/renames surface as a `[workspace-drift]` system-reminder at the next prompt — with line-level diffs inside a token budget, and a hard 9,500-char ceiling (CC spills larger `additionalContext` payloads to disk silently).
- Attribution on every change: your own edits are suppressed (echo), Bash command side effects are named (`COMMAND-SIDE-EFFECT ... your command ...`), ambiguous cases say so honestly.
- High-priority batches (a file the agent knows was deleted/renamed) are topped up once at turn end via the Stop hook.
- Cold-start reconcile on resume: drift that happened while CC was closed is caught up.

CLI only: Claude Code Desktop / Agent SDK / VS Code do not load hooks ([#87657](https://github.com/anthropics/claude-code/issues/87657)). Fail-open throughout: any internal error means "no injection", never a blocked session.

Complementary to the built-in FileStateCache (a write-time optimistic lock): it stops the agent from clobbering your edits; bright-drift tells the agent *that* the workspace changed, with diffs, before it trips over stale assumptions.

## Configuration

Global `~/.claude/state/bright-drift/config.yml`, per-project `<repo>/.claude/bright-drift.yml` (project wins; both hot-reload within ~1s):

```yaml
budget: { maxInjectTokens: 2000, maxTotalDiffLines: 1000, maxDiffLinesPerFile: 200 }
diff:   { contextLines: 3, maxFileSizeKB: 512, blacklist: [] }   # also /bright-drift:nodiff
watch:  { respectGitignore: true, extraIgnore: [], includeUntracked: false }
inject: { onUserPrompt: true, onStop: true, staticOverview: true }
attribution: { bashWindowGraceMs: 1500, longCommandMs: 10000 }
```

## How it works

- **Hooks** (short-lived node processes): SessionStart registers the session and launches the daemon (idempotent); UserPromptSubmit delivers the pre-rendered injection (one file read, <10 ms hot path); Stop tops up high-priority batches at most once; PreToolUse(Bash) takes the attribution pre-snapshot in-process; PostToolUse feeds the AKB; SessionEnd deregisters.
- **Daemon** (one per workspace, detached): chokidar watcher, per-session AKB + attribution windows, budget rendering; exits after 30 min without a live session.
- **State**: `~/.claude/state/bright-drift/` — plain JSON, atomic writes, fully inspectable. All IPC is this directory; there are no sockets. Logs record hashes/paths/counts, never file contents.

## License

MIT
