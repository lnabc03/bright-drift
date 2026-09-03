# bright-drift

> 面向 agent 的工作区漂移感知——让 agent 立即知道工作区中的文件发生了哪些外部更改。

bright-drift 是一个 agent 插件：持续监控工作区，识别用户/外部进程对文件的增删改，在下一次模型请求前把「文件级增删清单 + 预算内的行级 diff」注入 agent 上下文。核心引擎（`bright-drift-core`）平台无关，两个 adapter 把它接入两个宿主平台：

| 平台                    | npm 包                      | 安装命令                                   |
| --------------------- | -------------------------- | -------------------------------------- |
| DeepSeek Harness（dsh） | `bright-drift`             | `dsh plugin add bright-drift`          |
| Claude Code（CLI）      | `bright-drift-claude-code` | `npx bright-drift-claude-code install` |

## 要解决的问题

人类与 agent 在同一工作区并行编辑，是最常见的协作形态。然而从文件被外部改动的那一刻起，agent 对它的认知就开始过时：删除、重命名、修改函数名、格式化、构建产物、分支切换——这些由用户或外部进程产生的变更，都不会进入 agent 的上下文。

这种「工作区漂移」的代价往往是实质性的：agent 可能回退一个提交，只为「恢复」你主动删除的文件；或沿着一份早已过时的视图继续推进，直到被重命名的符号硬性阻断。规避这些风险，本该靠用户逐条复述——这正是 bright-drift 要消除的负担。

bright-drift 持续监控工作区，为每个会话维护一份「agent 已见内容」的基线（*Agent Knowledge Base*，AKB），并在下一次模型请求前注入一条紧凑、受预算约束的漂移通知，代用户陈述「发生了什么」：

```
EXTERNAL·RENAMED  工作区中 1 个文件被重命名（非你操作）：
  renamed  src/lib/parser.ts → src/lib/parser-v2.ts
```

## 设计原则

- **诚实的归因。** 每次变更都被分类：agent 自身写入（回声，被抑制）、命令副作用、格式化器改动、外部编辑。有歧义时一律偏向「外部」并如实说明——一个误信「改动出自自身」的 agent，比一个会二次核对的 agent 更危险。
- **预算约束。** 令牌阶梯预算（默认单次注入 ≤2000 tokens）；超预算时 diff 优雅降级为单行变更摘要。
- **fail-open。** 任何内部错误都降级为「不注入」加一条日志——绝不会弄坏 agent 会话。
- **默认隐私。** 日志只记录哈希、路径、计数——绝不记录文件内容。内容副本只保存在本机状态目录下。

## 安装 · DeepSeek Harness

```bash
dsh plugin --profile web add bright-drift
# 或 headless 环境：
dsh plugin --profile headless add bright-drift
```

需要 dsh ≥ 0.1.1-rc.2。插件以 host-plane bundle 形态挂载；重启dsh后即生效。

### 本地开发安装

从源码安装：

```bash
# 1. 克隆并构建——lib/ 产物和仓库自身的 node_modules 都必须存在
#    （profile 通过符号链接回到本 checkout 来解析 adapter 的依赖）。
git clone https://github.com/lnabc03/bright-drift.git
cd bright-drift
pnpm install
pnpm -r build
```

2. **先加 `bright-drift-core` override。** adapter 声明了 `bright-drift-core: workspace:*`，这个协议在仓库之外 pnpm 无法解析——缺了这步就会失败。编辑 `~/.dsh/profiles/web/pnpm-workspace.yaml`（若无 `overrides:` 键则新建）：

```yaml
overrides:
  bright-drift-core: link:C:/absolute/path/to/bright-drift/packages/core
```

使用绝对路径，斜杠用正斜杠。

3. **从仓库根目录**安装进 profile（相对路径 spec 以你的调用目录为锚）：

```bash
dsh plugin --profile web add link:./packages/dsh-adapter
```

这会把 adapter 软链到 `~/.dsh/profiles/web/node_modules/`，并且——因为 adapter 的 `package.json` 声明了 `dsh.bundle.patch`——会自动把 `bright-drift` 追加到 `dsh.profile.bundles`。无需手动改 `cordis.yml` 或 `cordis.patch.yml`。

4. 重启 profile，然后验证：

```
~/.dsh/logs/bright-drift/<date>.log   →   {"event":"plugin.applied", ...}
```

说明 / 排障：

- `link:` 会跟随 live checkout：改完代码后运行 `pnpm -r build` 并重启 profile。移动或删除 checkout 会弄坏 profile——若打算删，请先卸载。
- Windows：pnpm 会为 `link:` 依赖创建符号链接；若遇到 `EPERM`，请开启开发者模式或从管理员 shell 运行。
- 卸载：`dsh plugin --profile web remove bright-drift`（bundles 条目会自动移除）。
- 若 pnpm 仍对 `workspace:*` 报错，说明第 2 步的 override 缺失、放错了位置（应放在 **profile 的** `pnpm-workspace.yaml`，不是仓库的），或不是绝对路径。

## 用法 · DeepSeek Harness

默认无需任何配置。安装后：

- 用户/外部编辑会在下一个 step 边界以行级 diff 上报。
- agent 自身的写入和格式化器噪音会被识别并抑制（或折叠成一行静默的 `FORMATTED`）。
- 聊天中的斜杠命令：
  - `/bright-drift status` — AKB 大小、待注入漂移、注入计数
  - `/bright-drift diff <path>` — 预览单个文件的待注入 diff
  - `/bright-drift nodiff add|remove|list [pattern]` — 管理 diff 黑名单（写入项目级 `.dsh/bright-drift.yml`，立即生效）
  - `/bright-drift pause` / `resume` — 暂停注入（监控继续）；恢复时累积的漂移一次性补投

## 安装 · Claude Code (CLI)

```bash
npx bright-drift-claude-code install            # 用户级 ~/.claude/settings.json
npx bright-drift-claude-code install --project  # 仅当前仓库 .claude/settings.json
npx bright-drift-claude-code uninstall          # 卸载（状态保留，--purge 才删除）
```

安装器把 hooks **合并**进 settings.json（绝不覆盖已有条目），并写入五个斜杠命令：`/bright-drift:status|diff|pause|resume|nodiff`。**仅支持 CLI 形态**——Claude Code 桌面端 / Agent SDK / VS Code 扩展不加载 hooks（[#87657](https://github.com/anthropics/claude-code/issues/87657)）、插件 hooks.json 的 hook 发现机制整体损坏（[#16288](https://github.com/anthropics/claude-code/issues/16288)）。

与 CC 内置能力的关系：

- **FileStateCache** 是写时乐观锁（`File has been modified since read` 硬阻塞）——防止 agent 覆盖你改过的文件，但 agent 并不知道「文件变了/没了」。
- **bright-drift** 补认知缺口：删除/重命名感知、未读文件的漂移、行级 diff、外部修改在 turn 边界的主动告知与归因。

## 配置

除 `inject` 节与配置文件落点外，两平台配置结构完全一致（`watch`/`budget`/`diff`/`baseline`/`attribution` 五节通用）：

```yaml
enabled: true
budget:
  maxInjectTokens: 2000      # 单次注入令牌上限
  maxTotalDiffLines: 1000
  maxDiffLinesPerFile: 200
  maxDriftFilesForDiff: 50
diff:
  contextLines: 3
  maxFileSizeKB: 512
  blacklist: []              # diff 黑名单（gitignore 风格 glob）：命中的文件
                             # 只保留文件级通知，不生成 diff、不存内容副本
attribution:
  bashWindowGraceMs: 1500    # 命令结束后的宽限期内写入 = 其副作用
  longCommandMs: 10000       # 更长的命令 → ambiguous-external 措辞
  formatterWindowMs: 1000    # agent 写入后紧随的格式化 diff = 格式化器改动
  formatterSilent: false
baseline:
  persist: true
  persistContent: true       # 内容寻址副本，使重启后仍能做真实 diff
  contentStoreMaxMB: 256
watch:
  respectGitignore: true
  extraIgnore: []
  includeUntracked: false    # created 漂移是否覆盖 git 未追踪文件；
                             # 非 git 工作区一律上报；命令预测写入的路径豁免
```

`inject` 节随平台注入通道而异：

- **dsh**：`onPreStep`（pre-step 边界注入）、`onSessionStart`（会话开始注入）、`promptSection`（系统提示词段落解释通知语义）
- **Claude Code**：`onUserPrompt`（UserPromptSubmit 主通道）、`onStop`（Stop 补投，仅高优先级）、`staticOverview`（SessionStart 静态概述）

配置文件落点（均约 100ms 热更新）：

| 平台          | 全局                                         | 项目级覆盖                               |
| ----------- | ------------------------------------------ | ----------------------------------- |
| dsh         | `~/.dsh/settings.yaml` 的 `bright-drift:` 节 | `<workspace>/.dsh/bright-drift.yml` |
| Claude Code | `~/.claude/state/bright-drift/config.yml`  | `<repo>/.claude/bright-drift.yml`   |

## 工作原理

```
文件事件 ──▶ watcher（chokidar，去抖）──▶ 与 AKB 对账 ──▶ 漂移分类
工具结果 ─▶ 基线更新（read/write/edit 自行重读文件）
shell 调用 ──▶ FR-7 归因窗口（bash/pwsh，前台与后台）
                     │
                     ▼
        会话级漂移队列 ──▶ 注入通道 ──▶ 预算渲染 ──▶ Sync Point
        （dsh：pre-step    （dsh 单一通道；    （diff 在令牌      （消息持久化时
          边界；CC：         CC 双通道）        预算内，附带归因标签） 精确 rebase 基线）
          UserPromptSubmit
          + Stop 补投）
```

引擎（`bright-drift-core`）是平台无关的：不 import 任何宿主 API，可脱离 harness 完整跑单测（154 个用例）。两个 adapter 都是薄壳：`bright-drift`（dsh）把 core 接入 dsh 事件，`bright-drift-claude-code`（CC）用短命 hook + detached daemon 把 core 接入 CC 会话。

## 仓库结构

```
packages/
  core/            # bright-drift-core —— 平台无关引擎
  dsh-adapter/     # bright-drift —— dsh 插件（一期）
  claude-code/     # bright-drift-claude-code —— Claude Code hooks + daemon（二期）
bright-drift-PRD.md               # 产品定义（中文）
bright-drift-design-phase1.md     # 一期技术设计（中文，单一事实源）
bright-drift-design-phase2.md     # 二期技术设计（中文）
bright-drift-phase2-research.md   # 二期预研报告（spike 实测数据）
AGENTS.md                         # 贡献者/agent 约定
```

## 状态与路线图

- **✅️一期（dsh）**：M0 运行时验证 → M1 核心引擎 → M2 dsh 集成 → M3 打磨，均已发布。
- **✅️二期（Claude Code）**：M4 骨架 → M5 功能对齐 → M6 打磨，均已发布。
- **⭕️三期**：Codex / opencode / ……，视用户需求而定。

## License

MIT
