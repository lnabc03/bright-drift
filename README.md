# bright-drift

> Workspace drift awareness for AI coding agents — your agent always knows what changed while it was thinking.

**中文**：bright-drift 是一个 agent 插件：持续监控工作区，识别用户/外部进程对文件的增删改，在下一次模型请求前把「文件级增删清单 + 预算内的行级 diff」注入 agent 上下文。

## The problem

While your agent reasons, edits files, and runs commands, the workspace keeps moving: you fix a typo by hand, a formatter rewrites a file, a background `npm run build` regenerates outputs, a git operation swaps branches. The agent doesn't see any of it — it acts on a stale mental model, re-reads files defensively, or worse, overwrites your manual fix.

bright-drift closes that gap. It watches the workspace, keeps a per-session baseline of what the agent has seen (the *Agent Knowledge Base*), and injects a compact, budgeted drift notice right before the next model request:

```
COMMAND-SIDE-EFFECT  你的命令 `npm run codegen` 改动了 1 个文件：
  modified  src/api/client.gen.ts  (+12 -3)
  ── src/api/client.gen.ts
  @@ -40,7 +40,7 @@
  -  baseURL: 'http://localhost:3000',
  +  baseURL: 'https://api.example.com',
```

## Design principles

- **Single injection point.** One channel — the pre-step boundary — no mid-step interruptions, no duplicate messages.
- **Honest attribution.** Every change is classified: agent write (echo, suppressed), command side-effect, formatter pass, external edit. Ambiguity always biases toward "external" and says so — an agent that trusts a wrong "I did this" is worse than one that double-checks.
- **Budgeted.** Token-ladder budget (default ≤2000 tokens/injection); diffs degrade gracefully to one-line change summaries when over budget.
- **Fail-open.** Any internal error degrades to "no injection" and a log line — never a broken agent session.
- **Private by construction.** Logs record hashes, paths, and counts — never file contents. Content copies stay on your machine under `~/.dsh/state/bright-drift/`.

## Install (DeepSeek Harness)

```bash
dsh plugin --profile web add bright-drift
# or for headless:
dsh plugin --profile headless add bright-drift
```

Requires dsh ≥ 0.1.1-rc.2. The plugin mounts as a host-plane bundle; restart the profile (or let the patch watcher remount) and it's live.

### Development install (local checkout, pre-publish)

The bare-name command above only works once the package is on npm. To install from a source checkout:

**中文**：本地开发版安装步骤如下（发布 npm 前，裸包名安装不可用）。

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

Use an absolute path with forward slashes. 中文：必须先加这个 override，否则下一步 pnpm 会因 `workspace:*` 协议解析失败。

3. Install into the profile **from the repo root** (relative specs are anchored to your invoking directory):

```bash
dsh plugin --profile web add link:./packages/dsh-adapter
```

This symlinks the adapter into `~/.dsh/profiles/web/node_modules/` and — because the adapter's `package.json` declares `dsh.bundle.patch` — automatically appends `bright-drift` to `dsh.profile.bundles`. No manual edit of `cordis.yml` or `cordis.patch.yml` is needed. 中文：bundles 列表会自动登记，无需手改 cordis 配置。

4. Restart the profile, then verify:

```
~/.dsh/logs/bright-drift/<date>.log   →   {"event":"plugin.applied", ...}
```

Notes / troubleshooting:

- `link:` tracks the live checkout: after code edits, run `pnpm -r build` and restart the profile. Moving or deleting the checkout breaks the profile — uninstall first if you plan to.
- Windows: pnpm creates symlinks for `link:` deps; enable Developer Mode or run from an elevated shell if you hit `EPERM`.
- Uninstall: `dsh plugin --profile web remove bright-drift` (the bundles entry is removed automatically).
- If pnpm still errors on `workspace:*`, the override in step 2 is missing, misplaced (it goes in the **profile's** `pnpm-workspace.yaml`, not the repo's), or not an absolute path.

## Usage

Nothing to configure by default. Once installed:

- External/user edits are reported at the next step boundary with a line-level diff.
- The agent's own writes and formatter noise are recognized and suppressed (or folded into a silent `FORMATTED` line).
- Slash commands in the chat:
  - `/bright-drift status` — AKB size, pending drift, injection counters
  - `/bright-drift diff <path>` — preview the pending diff for one file
  - `/bright-drift pause` / `resume` — pause injections (monitoring continues); accumulated drift is delivered in one batch on resume

## Configuration

Global, in `~/.dsh/settings.yaml` (hot-reloads in ~100ms):

```yaml
bright-drift:
  enabled: true
  budget:
    maxInjectTokens: 2000      # per-injection token ceiling
    maxTotalDiffLines: 1000
    maxDiffLinesPerFile: 200
    maxFilesPerInjection: 50
  diff:
    contextLines: 3
    maxFileSizeKB: 512
  attribution:
    commandGraceMs: 1500       # writes within grace after a command end = its side-effect
    longCommandMs: 10000       # longer commands → ambiguous-external wording
    formatterWindowMs: 1000    # cosmetic diff right after an agent write = formatter pass
    formatterSilent: true
  inject:
    onPreStep: true
    onSessionStart: true
  baseline:
    persist: true
    persistContent: true       # content-addressed copies enable real diffs after restart
    contentStoreMaxMB: 256
  watch:
    respectGitignore: true
    extraIgnore: []
```

Per-project override: `<workspace>/.dsh/bright-drift.yml` (same shape, project wins).

## How it works

```
file events ──▶ watcher (chokidar, debounced) ──▶ reconcile vs AKB ──▶ classify drift
tool results ─▶ baseline update (read/write/edit re-read the file themselves)
shell calls ───▶ FR-7 attribution windows (bash/pwsh, foreground & background)
                     │
                     ▼
              per-session drift queue ──▶ pre-step waterfall ──▶ budgeted render ──▶ Sync Point
                                       (single channel,      (diff within token   (baseline rebased
                                        suppressed at turn    budget, attribution  exactly when the
                                        close)                labels attached)     message persists)
```

The engine (`bright-drift-core`) is platform-independent: no dsh imports, fully unit-tested off-harness (115 tests). The dsh adapter (`bright-drift`) is a thin host-plane bundle wiring core into dsh events.

## Repository layout

```
packages/
  core/            # bright-drift-core — platform-independent engine
  dsh-adapter/     # bright-drift — the dsh plugin
bright-drift-PRD.md               # product definition (Chinese)
bright-drift-design-phase1.md     # phase-1 technical design (Chinese, source of truth)
AGENTS.md                         # contributor/agent conventions
```

## Status & roadmap

- **Phase 1 (this repo, current)**: dsh adapter — M0 runtime verification ✅, M1 core engine ✅, M2 dsh integration ✅ (E2E-verified on a headless profile), M3 polish.
- **Phase 2**: Claude Code adapter (the serializable attribution state machine is designed for its daemon hand-off).
- **Phase 3**: Codex / opencode, as demand warrants.

Core APIs are experimental until v1.0.

## License

MIT
