# AGENTS.md — bright-drift 开发约定

> 本文件是 agent 与协作者进入本仓库时的第一份指南。设计事实以两份上游文档为准：
> - `bright-drift-PRD.md` —— 产品定义、目标与非目标、跨期规划
> - `bright-drift-design-phase1.md` —— 一期技术设计（含对 PRD 的勘误表与决策记录 D1–D6）
>
> 两份文档冲突时，**设计文档优先**（它经过 dsh 源码核实）；本文件与二者冲突时，以文档为准并修正本文件。

## 1. 项目一句话

bright-drift 是一个 agent 插件：持续监控工作区，识别用户/外部进程对文件的增删改，在下一次模型请求前把「文件级增删清单 + 预算内的行级 diff」注入 agent 上下文。一期平台是 DeepSeek Harness（dsh），二期 Claude Code，三期视情况 Codex/opencode。

## 2. 仓库结构（monorepo，pnpm workspace）

```
packages/
  core/            # bright-drift-core：平台无关引擎（一期第一优先级交付）
  dsh-adapter/     # bright-drift：dsh 插件主包（npm bundle 形态）
  claude-code/     # 二期占位，一期不建
docs/              # PRD、设计文档（当前在仓库根，M1 时迁入）
```

**架构红线（不可违反，违者返工）：**

1. `core` 不得 import 任何 dsh/CC/平台 API；平台相关代码只能出现在 adapter 包。core 的测试必须能脱离 dsh 运行。
2. `core/attribution` 的归因窗口状态机**必须可序列化**（二期 CC daemon 跨进程交接的硬约束，PRD §6.2-5）。
3. 单一注入路径、单一 Sync Point：一期只允许 pre-step waterfall 一条注入通道（设计文档 §5.5.4 已评估并放弃 additionalContexts/deferContext）。
4. **fail-open 是验收项（G5）**：插件任何内部错误不得中断 agent 会话。所有事件监听体外层 try/catch，异常只进日志。
5. 归因歧义永远偏向「外部」（C 类），并在消息中如实标注另一种可能（PRD §3.6 不对称偏向原则）。

## 3. 开发流程

### 3.1 里程碑节奏

以设计文档 §8 为准：M0（运行时验证清单 §8.1，6 项）→ M1（core 七模块 + 单测）→ M2（dsh 集成）→ M3（发布打磨）。**M0 的 6 项实测未完成前，不开始 M2 的 adapter 编码**；M1 的 core 不依赖 M0，可以先行。

### 3.2 分支与提交

- 主分支 `main`，功能分支 `feat/<topic>`、修复 `fix/<topic>`；PR 合入，不直接推 main。
- 提交信息用 Conventional Commits：`feat(core): …`、`fix(adapter): …`、`docs: …`、`test: …`、`chore: …`。scope 只用包名（`core`/`dsh-adapter`）或 `repo`。
- 一个 PR 只做一件事；改动 core 公共 API 的 PR 必须在描述里写明对二期 adapter 的影响（core API 在 v1.0 前标记 experimental，见 PRD §9.3）。
- 语义化版本；core 与 adapter 同仓库但独立发版（`bright-drift-core` / `bright-drift`）。

### 3.3 测试要求

- **core**：Vitest 单测，场景覆盖设计文档 §6 的 E1–E18 边界清单；归因静态分析（bash + pwsh 双语法）必须有参数化用例。
- **adapter**：端到端跑设计文档 §7 的 T1–T13 矩阵；可自动化子集进 CI（headless profile），行为级断言（T4）允许人工验收但要在 PR 里附录屏或日志。
- 性能门：M1 压测 10 万文件仓库（PRD R5）；pre-step 早退路径 <1ms；FR-7 单次快照 <50ms。
- 测试不得依赖真实 dsh 进程之外的任何外部服务；watcher 测试用临时目录。

### 3.4  Definition of Done

一个 FR 完成 = 实现 + 单测/端到端断言 + 日志留痕 + 设计文档对应章节勾销（如设计有变，**先改设计文档再改代码**，保持文档为单一事实源）。

## 4. dsh 平台注意事项（一期 adapter）

1. **不要凭记忆写 dsh API**。dsh 迭代快，写代码前先查本机安装的源码与 `.d.ts`：设计文档附录「关键源码坐标」是入口。运行时能力用 Cordis Inspect Provider 核实。
2. 插件是 **Host 平面 bundle**（决策 D1）：root ctx 监听、按 `Agent` 对象 WeakMap 分键。不要注册成 preset 行；不要往 preset 里发布服务（isolate realm 规则见 dsh 的 editing-cordis-compositions skill）。
3. **永不修改 dsh 随附安装**（`config/agent-presets/` 下的 shipped preset、host composition）。需要改动 preset 行为时拷贝后改副本。
4. 事件契约要点：pre-step 先 `next()` 后追加；空批次 + 无工具执行 = 疑似 turn 关闭检查，**不注入**（§5.5.3）；`fs/observed` 监听器必须同步、不得 throw。
5. 工具名集合：读 `read`/`read_image`，写 `write`/`edit`，shell 是 `bash`（POSIX）或 `pwsh`（Windows）——归因逻辑必须按平台取正确的 shell 工具名。
6. 注入消息 source 固定为 `{kind:'plugin', plugin:'bright-drift', form:'notice', summary}`，summary ≤120 字符。
7. 依赖版本与 dsh 依赖树对齐：chokidar ^4.0.3、diff ^9.0.0（以安装树实际版本为准，升级前先核对）。

## 5. 安全与隐私

- **不索取、不存储任何凭据**（密码、API Key、Token）。配置里没有也不允许出现密钥字段。
- 日志只记哈希、路径、计数，**永不记录文件内容**（PRD FR-6）。
- content-store 的 blob 落盘在 `~/.dsh/state/bright-drift/blobs/`，属于用户本机状态，不进仓库、不上传。
- 插件不发起任何网络请求（一期无遥测）。

## 6. 配置与状态位置（实现时遵循）

| 内容 | 位置 |
|---|---|
| 全局配置 | `~/.dsh/settings.yaml` 的 `bright-drift:` 节（`ctx.settings.register`，D2） |
| 项目级覆盖 | `<workspace>/.dsh/bright-drift.yml`（插件自读，项目级优先） |
| AKB 持久化 | `~/.dsh/state/bright-drift/akb/<sessionId>.json`（按 sessionId 键控，非 workspace 哈希） |
| 内容副本 | `~/.dsh/state/bright-drift/blobs/`（sha1 寻址，LRU，默认 256MB） |
| 日志 | `~/.dsh/logs/bright-drift/<date>.log` |

## 7. 写作与文档语言

- 用户-facing 文档（README、官网文案）：英文为主，中文对照。
- 设计文档、PRD、内部讨论：中文。
- 代码注释：英文；commit message：英文。
