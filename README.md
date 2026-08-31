# bright-drift

> 面向 AI 编程 agent 的工作区漂移感知——让 agent 始终知道「它思考期间」文件发生了什么变化。

bright-drift 是一个 agent 插件：持续监控工作区，识别用户/外部进程对文件的增删改，在下一次模型请求前把「文件级增删清单 + 预算内的行级 diff」注入 agent 上下文。一期平台是 DeepSeek Harness（dsh）。

## 要解决的问题

当你的 agent 在推理、改文件、跑命令时，工作区其实一直在变化：你手动改了个拼写、删除或重命名了某个文件，格式化工具重写了某个文件、后台 `npm run build` 重新生成了产物、git 操作切换了分支。agent 对这些一无所知——它带着过时的认知继续工作，要么反复重读文件做防御，要么更糟，直接覆盖掉你的手动修改。

bright-drift 补齐了这个缺口。它监控工作区，为每个会话维护一份「agent 已经见过什么」的基线（*Agent Knowledge Base*，AKB），并在下一次模型请求前注入一条紧凑、受预算约束的漂移通知：

```
COMMAND-SIDE-EFFECT  你的命令 `npm run codegen` 改动了 1 个文件：
  modified  src/api/client.gen.ts  (+12 -3)
  ── src/api/client.gen.ts
  @@ -40,7 +40,7 @@
  -  baseURL: 'http://localhost:3000',
  +  baseURL: 'https://api.example.com',
```

## 设计原则

- **单一注入点。** 只有一条通道——pre-step 边界；不在推理中途打断，不产生重复消息。
- **诚实的归因。** 每次变更都被分类：agent 自身写入（回声，被抑制）、命令副作用、格式化器改动、外部编辑。有歧义时一律偏向「外部」并如实说明——一个轻信了错误「是我干的」的 agent，比一个会二次核对的 agent 更危险。
- **预算约束。** 令牌阶梯预算（默认单次注入 ≤2000 tokens）；超预算时 diff 优雅降级为单行变更摘要。
- **fail-open。** 任何内部错误都降级为「不注入」加一条日志——绝不会弄坏 agent 会话。
- **默认隐私。** 日志只记录哈希、路径、计数——绝不记录文件内容。内容副本保存在本机 `~/.dsh/state/bright-drift/` 下。

## 安装（DeepSeek Harness）

```bash
dsh plugin --profile web add bright-drift
# 或 headless 环境：
dsh plugin --profile headless add bright-drift
```

需要 dsh ≥ 0.1.1-rc.2。插件以 host-plane bundle 形态挂载；重启 profile（或让 patch watcher 自动重挂载）后即生效。

### 本地开发安装

要从源码 checkout 安装：

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

## 用法

默认无需任何配置。安装后：

- 用户/外部编辑会在下一个 step 边界以行级 diff 上报。
- agent 自身的写入和格式化器噪音会被识别并抑制（或折叠成一行静默的 `FORMATTED`）。
- 聊天中的斜杠命令：
  - `/bright-drift status` — AKB 大小、待注入漂移、注入计数
  - `/bright-drift diff <path>` — 预览单个文件的待注入 diff
  - `/bright-drift pause` / `resume` — 暂停注入（监控继续）；恢复时累积的漂移一次性补投

## 配置

全局配置在 `~/.dsh/settings.yaml`（约 100ms 热更新）：

```yaml
bright-drift:
  enabled: true
  budget:
    maxInjectTokens: 2000      # 单次注入令牌上限
    maxTotalDiffLines: 1000
    maxDiffLinesPerFile: 200
    maxFilesPerInjection: 50
  diff:
    contextLines: 3
    maxFileSizeKB: 512
  attribution:
    commandGraceMs: 1500       # 命令结束后的宽限期内写入 = 其副作用
    longCommandMs: 10000       # 更长的命令 → ambiguous-external 措辞
    formatterWindowMs: 1000    # agent 写入后紧随的格式化 diff = 格式化器改动
    formatterSilent: true
  inject:
    onPreStep: true
    onSessionStart: true
  baseline:
    persist: true
    persistContent: true       # 内容寻址副本，使重启后仍能做真实 diff
    contentStoreMaxMB: 256
  watch:
    respectGitignore: true
    extraIgnore: []
```

项目级覆盖：`<workspace>/.dsh/bright-drift.yml`（同样结构，项目级优先）。

## 工作原理

```
文件事件 ──▶ watcher（chokidar，去抖）──▶ 与 AKB 对账 ──▶ 漂移分类
工具结果 ─▶ 基线更新（read/write/edit 自行重读文件）
shell 调用 ──▶ FR-7 归因窗口（bash/pwsh，前台与后台）
                     │
                     ▼
        会话级漂移队列 ──▶ pre-step waterfall ──▶ 预算渲染 ──▶ Sync Point
                          （单一通道，        （diff 在令牌       （消息持久化时
                           收尾时抑制）        预算内，附带归因标签） 精确 rebase 基线）
```

引擎（`bright-drift-core`）是平台无关的：不 import 任何 dsh API，可脱离 harness 完整跑单测（130 个用例）。dsh adapter（`bright-drift`）是一个薄的 host-plane bundle，把 core 接入 dsh 事件。

## 仓库结构

```
packages/
  core/            # bright-drift-core —— 平台无关引擎
  dsh-adapter/     # bright-drift —— dsh 插件
bright-drift-PRD.md               # 产品定义（中文）
bright-drift-design-phase1.md     # 一期技术设计（中文，单一事实源）
AGENTS.md                         # 贡献者/agent 约定
```

## 状态与路线图

- **一期（本仓库，当前）**：dsh adapter —— M0 运行时验证 ✅、M1 核心引擎 ✅、M2 dsh 集成 ✅（headless profile 上 E2E 验证通过）、M3 打磨。
- **二期**：Claude Code adapter（可序列化的归因状态机正是为其 daemon 交接而设计）。
- **三期**：Codex / opencode，视需求而定。

Core API 在 v1.0 前标记为 experimental。

## License

MIT
