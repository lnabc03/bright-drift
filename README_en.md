# bright-drift

> Workspace drift awareness for agents — so the agent immediately knows what external changes happened in its workspace.

bright-drift is an agent plugin that continuously watches the workspace, identifies file additions/modifications/deletions made by the user or external processes, and injects a file-level change list plus a budgeted line-level diff into the agent's context before the next model request. The core engine (`bright-drift-core`) is platform-independent; two adapters wire it into two host platforms:

| Platform                  | npm package                 | Install                                    |
| ------------------------- | --------------------------- | ------------------------------------------ |
| DeepSeek Harness (dsh)    | `bright-drift`              | `dsh plugin add bright-drift`              |
| Claude Code (CLI)         | `bright-drift-claude-code`  | `npx bright-drift-claude-code install`     |

## The problem

When a human and an agent edit the same workspace in parallel — the most common form of collaboration — the agent's view of a file goes stale the moment that file changes out from under it. Deletions, renames, function edits, formatter passes, build artifacts, branch switches: none of these user- or process-driven changes enter the agent's context.

This "workspace drift" carries real cost: the agent may revert a commit just to "restore" a file you deliberately deleted, or keep reasoning against an outdated view until it hard-blocks on a renamed symbol. Avoiding that has meant spelling out every change by hand — the exact burden bright-drift removes.

bright-drift watches the workspace, keeps a per-session baseline of what the agent has seen (the *Agent Knowledge Base*), and injects a compact, budgeted drift notice before the next model request — stating what happened on your behalf:

```
EXTERNAL·RENAMED  工作区中 1 个文件被重命名（非你操作）：
  renamed  src/lib/parser.ts → src/lib/parser-v2.ts
```

## Design principles

- **Honest attribution.** Every change is classified: agent write (echo, suppressed), command side-effect, formatter pass, external edit. Ambiguity always biases toward "external" and says so — an agent that wrongly believes a change is its own doing is worse than one that double-checks.
- **Budgeted.** Token-ladder budget (default ≤2000 tokens/injection); diffs degrade gracefully to one-line change summaries when over budget.
- **Fail-open.** Any internal error degrades to "no injection" and a log line — never a broken agent session.
- **Private by construction.** Logs record hashes, paths, and counts — never file contents. Content copies stay on your machine in the local state directory.

## Install (DeepSeek Harness)

```bash
dsh plugin --profile web add bright-drift
# or for headless:
dsh plugin --profile headless add bright-drift
```

Requires dsh ≥ 0.1.1-rc.2. The plugin mounts as a host-plane bundle; restart dsh and it's live.

### Development install

To install from source:

```bash
# 1. Clone and build — both lib/ outputs and the repo's own node_modules
#    must exist (the profile resolves the adapter's deps through a symlink
#    back into this checkout).
git clone https://github.com/lnabc03/bright-drift.git
cd bright-drift
pnpm install
pnpm -r build
```

2. **Add the `bright-drift-core` override first.** The adapter declares `bright-drift-core: workspace:*`, which pnpm cannot resolve outside this repo — this is the step that fails without the override. Edit `~/.dsh/profiles/web/pnpm-workspace.yaml` (create the `overrides:` key if absent):

```yaml
overrides:
  bright-drift-core: link:C:/absolute/path/to/bright-drift/packages/core
```

Use an absolute path with forward slashes.

3. Install into the profile **from the repo root** (relative specs are anchored to your invoking directory):

```bash
dsh plugin --profile web add link:./packages/dsh-adapter
```

This symlinks the adapter into `~/.dsh/profiles/web/node_modules/` and — because the adapter's `package.json` declares `dsh.bundle.patch` — automatically appends `bright-drift` to `dsh.profile.bundles`. No manual edit of `cordis.yml` or `cordis.patch.yml` is needed.

4. Restart the profile, then verify:

```
~/.dsh/logs/bright-drift/<date>.log   →   {"event":"plugin.applied", ...}
```

Notes / troubleshooting:

- `link:` tracks the live checkout: after code edits, run `pnpm -r build` and restart the profile. Moving or deleting the checkout breaks the profile — uninstall first if you plan to.
- Windows: pnpm creates symlinks for `link:` deps; enable Developer Mode or run from an elevated shell if you hit `EPERM`.
- Uninstall: `dsh plugin --profile web remove bright-drift` (the bundles entry is removed automatically).
- If pnpm still errors on `workspace:*`, the override in step 2 is missing, misplaced (it goes in the **profile's** `pnpm-workspace.yaml`, not the repo's), or not an absolute path.

## Usage (DeepSeek Harness)

Nothing to configure by default. Once installed:

- External/user edits are reported at the next step boundary with a line-level diff.
- The agent's own writes and formatter noise are recognized and suppressed (or folded into a silent `FORMATTED` line).
- Slash commands in the chat:
  - `/bright-drift status` — AKB size, pending drift, injection counters
  - `/bright-drift diff <path>` — preview the pending diff for one file
  - `/bright-drift nodiff add|remove|list [pattern]` — manage the diff blacklist (writes the project-level `.dsh/bright-drift.yml`, applies immediately)
  - `/bright-drift pause` / `resume` — pause injections (monitoring continues); accumulated drift is delivered in one batch on resume

## Install (Claude Code CLI)

```bash
npx bright-drift-claude-code install            # user-level ~/.claude/settings.json
npx bright-drift-claude-code install --project  # this repo's .claude/settings.json only
npx bright-drift-claude-code uninstall          # remove (state kept; --purge deletes)
```

The installer **merges** hooks into settings.json (never overwrites existing entries) and installs five slash commands: `/bright-drift:status|diff|pause|resume|nodiff`. **CLI only** — Claude Code Desktop / Agent SDK / VS Code do not load hooks ([#87657](https://github.com/anthropics/claude-code/issues/87657)), and plugin hook discovery via `hooks.json` is broken ([#16288](https://github.com/anthropics/claude-code/issues/16288)).

Complementary to built-in CC defenses:

- **FileStateCache** is a write-time optimistic lock (`File has been modified since read`) — it stops the agent from clobbering your edits, but the agent never learns *that* the file changed or disappeared.
- **bright-drift** fills the awareness gap: deletion/rename detection, drift on files the agent only read, line-level diffs, proactive turn-boundary notices with attribution.

## Configuration

Except for the `inject` section and config-file locations, the two platforms share one config schema (the `watch`/`budget`/`diff`/`baseline`/`attribution` sections are identical):

```yaml
enabled: true
budget:
  maxInjectTokens: 2000      # per-injection token ceiling
  maxTotalDiffLines: 1000
  maxDiffLinesPerFile: 200
  maxDriftFilesForDiff: 50
diff:
  contextLines: 3
  maxFileSizeKB: 512
  blacklist: []              # diff blacklist (gitignore-style globs): matched files
                             # keep file-level notices only — no diff, no content copies
attribution:
  bashWindowGraceMs: 1500    # writes within grace after a command end = its side-effect
  longCommandMs: 10000       # longer commands → ambiguous-external wording
  formatterWindowMs: 1000    # cosmetic diff right after an agent write = formatter pass
  formatterSilent: false
baseline:
  persist: true
  persistContent: true       # content-addressed copies enable real diffs after restart
  contentStoreMaxMB: 256
watch:
  respectGitignore: true
  extraIgnore: []
  includeUntracked: false    # report created drift for git-untracked files;
                             # non-git workspaces report all; window-predicted
                             # command outputs are always reported
```

The `inject` section varies with each platform's injection channels:

- **dsh**: `onPreStep` (inject at the pre-step boundary), `onSessionStart` (inject on session start), `promptSection` (system-prompt section explaining notice semantics)
- **Claude Code**: `onUserPrompt` (UserPromptSubmit main channel), `onStop` (Stop top-up, high-priority only), `staticOverview` (SessionStart static overview)

Config-file locations (both hot-reload in ~100 ms):

| Platform     | Global                                        | Per-project override                       |
| ------------ | --------------------------------------------- | ------------------------------------------ |
| dsh          | `~/.dsh/settings.yaml`, under the `bright-drift:` key | `<workspace>/.dsh/bright-drift.yml`  |
| Claude Code  | `~/.claude/state/bright-drift/config.yml`     | `<repo>/.claude/bright-drift.yml`          |

## How it works

```
file events ──▶ watcher (chokidar, debounced) ──▶ reconcile vs AKB ──▶ classify drift
tool results ─▶ baseline update (read/write/edit re-read the file themselves)
shell calls ───▶ FR-7 attribution windows (bash/pwsh, foreground & background)
                     │
                     ▼
              per-session drift queue ──▶ injection channel ──▶ budgeted render ──▶ Sync Point
                                       (dsh: pre-step      (diff within token   (baseline rebased
                                        boundary; CC:       budget, attribution  exactly when the
                                        UserPromptSubmit    labels attached)     message persists)
                                        + Stop top-up)
```

The engine (`bright-drift-core`) is platform-independent: no host imports, fully unit-tested off-harness (154 tests). Both adapters are thin shells: `bright-drift` (dsh) wires core into dsh events, `bright-drift-claude-code` (CC) wires core into CC sessions via short-lived hooks + a detached daemon.

## Repository layout

```
packages/
  core/            # bright-drift-core — platform-independent engine
  dsh-adapter/     # bright-drift — the dsh plugin
  claude-code/     # bright-drift-claude-code — Claude Code hooks + daemon
bright-drift-PRD.md               # product definition (Chinese)
bright-drift-design-phase1.md     # phase-1 technical design (Chinese, source of truth)
bright-drift-design-phase2.md     # phase-2 technical design (Chinese)
bright-drift-phase2-research.md   # phase-2 research report (spike measurements)
AGENTS.md                         # contributor/agent conventions
```

## Status & roadmap

- **✅️ Phase 1 (dsh)**: M0 runtime verification → M1 core engine → M2 dsh integration → M3 polish, all released.
- **✅️ Phase 2 (Claude Code)**: M4 skeleton → M5 feature parity → M6 polish, all released.
- **⭕️ Phase 3**: Codex / opencode / …, as demand warrants.

## License

MIT
