# bright-drift-claude-code

Workspace drift awareness for [Claude Code](https://docs.anthropic.com/en/docs/claude-code): a detached watcher daemon detects file changes made outside the agent's own tool calls (by the user or other processes) and injects budget-capped diffs into the agent context through hooks.

> Phase-2 package of the [bright-drift](https://github.com/lnabc03/bright-drift) monorepo. Currently **M4 skeleton**: daemon lifecycle + hook plumbing + installer. Full drift detection lands in M5.

## Install

```bash
npx bright-drift-claude-code install            # user-level ~/.claude/settings.json
npx bright-drift-claude-code install --project  # this repo's .claude/settings.json
npx bright-drift-claude-code uninstall          # remove hooks (state kept; --purge to delete)
```

Hooks are merged into `settings.json` (never overwritten) and registered in exec form (`node <file>` — no shell dependency, Windows-safe). Re-running `install` upgrades in place.

## How it works

- **Hooks** (short-lived node processes): SessionStart registers the session and launches the daemon (idempotent); UserPromptSubmit delivers the pre-rendered injection (one file read, <10 ms hot path); Stop tops up high-priority batches at most once; PostToolUse/PreToolUse feed the AKB and attribution windows via mailbox files; SessionEnd deregisters.
- **Daemon** (one per workspace, detached): owns the chokidar watcher, AKB, attribution and budget rendering; exits after 30 min without a live session.
- **State**: `~/.claude/state/bright-drift/` — plain JSON files, atomic writes, fully inspectable. All IPC is this directory; there are no sockets.

CLI only: Claude Code Desktop / Agent SDK / VS Code do not load hooks ([#87657](https://github.com/anthropics/claude-code/issues/87657)). Fail-open throughout: any internal error means "no injection", never a blocked session.

## License

MIT
