# AGENTS.md — bright-drift 开发约定

> 本文件是 agent 与协作者进入本仓库时的第一份指南。设计事实以三份上游文档为准：
> - `bright-drift-PRD.md` —— 产品定义、目标与非目标、跨期规划
> - `bright-drift-design-phase1.md` —— 一期技术设计（含对 PRD 的勘误表与决策记录 D1–D6）
> - `bright-drift-design-phase2.md` —— 二期技术设计（Claude Code adapter）
>
> 文档冲突时，**设计文档优先**（经过源码核实）；本文件与二者冲突时，以文档为准并修正本文件。

## 1. 项目一句话

bright-drift 是一个 agent 插件：持续监控工作区，识别用户/外部进程对文件的增删改，在下一次模型请求前把「文件级增删清单 + 预算内的行级 diff」注入 agent 上下文。核心引擎（`bright-drift-core`）平台无关，两个 adapter 接入两个平台：一期 DeepSeek Harness（dsh）、二期 Claude Code（CLI），均已发布。三期视需求 Codex/opencode。

## 2. 仓库结构（monorepo，pnpm workspace）

```
packages/
  core/            # bright-drift-core：平台无关引擎
  dsh-adapter/     # bright-drift：dsh 插件（一期，已发布）
  claude-code/     # bright-drift-claude-code：CC hooks + daemon（二期，已发布）
bright-drift-PRD.md               # 产品定义（中文）
bright-drift-design-phase1.md     # 一期技术设计（中文，单一事实源）
bright-drift-design-phase2.md     # 二期技术设计（中文）
bright-drift-phase2-research.md   # 二期预研报告（spike 实测数据）
```

**架构红线（不可违反，违者返工）：**

1. `core` 不得 import 任何 dsh/CC/平台 API；平台相关代码只能出现在 adapter 包。core 的测试必须能脱离宿主运行。
2. `core/attribution` 的归因窗口状态机**必须可序列化**（二期 CC daemon 跨进程交接的硬约束，PRD §6.2-5）。
3. **单一 Sync Point、注入通道 at-most-once**：漂移基线只有一处提交点——一期在 pre-step 渲染时，二期在投递确认时（outbox 模式，phase2 §5.6）。注入通道随平台而异：dsh 单一 pre-step（phase1 §5.5.4 已评估并放弃 additionalContexts/deferContext）；CC 是 UserPromptSubmit 主通道 + Stop 高优先级补投——但每条通道都必须按 batchId 做 at-most-once 门控，不得重复注入。
4. **fail-open 是验收项**：插件任何内部错误不得中断 agent 会话。所有事件监听体外层 try/catch，异常只进日志。
5. 归因歧义永远偏向「外部」（C 类），并在消息中如实标注另一种可能（PRD §3.6 不对称偏向原则）。

## 3. 开发流程

### 3.1 里程碑

一期（dsh）M0→M3、二期（CC）M4→M6 均已交付并发版（v0.3.0）。后续以 PRD §6 跨期规划为准；三期（Codex/opencode）视需求而定。二期遗留的可选低优先项（惰性重拉、死会话状态清理、部分 e2e 自动化缺口）不影响当前版本。

### 3.2 分支与提交

- 主分支 `main`：简单改动（文档、注释、错字等）直接提交推 main。功能分支 `feat/<topic>`、修复 `fix/<topic>` 仅在较大改动（新功能、行为变更、core 公共 API 变更）或开发者明确要求时使用，走 PR 合入。
- 提交信息用 Conventional Commits：`feat(core): …`、`fix(claude-code): …`、`docs(repo): …`、`test: …`、`chore: …`。scope 用包名（`core`/`dsh-adapter`/`claude-code`）或 `repo`。
- 一个 PR 只做一件事；改动 core 公共 API 的 PR 必须在描述里写明对其他 adapter 的影响（core API 在 v1.0 前标记 experimental，见 PRD §9.3）。
- 三包同仓库、版本统一（`bright-drift-core` / `bright-drift` / `bright-drift-claude-code`），发布时三者必须同版本。
- **发布走 tag 自动化**（`.github/workflows/release.yml`）：先把三包版本号 bump 对齐并合入 main，再 `git tag vX.Y.Z <commit> && git push origin vX.Y.Z`。workflow 会全量 build/typecheck/test、校验 tag 与三包 package.json 版本一致且 commit 在 main 上、按 core→bright-drift→bright-drift-claude-code 顺序发包、自动建 GitHub Release。npm 凭据是 repo secret `NPM_TOKEN`（granular automation token，绕 2FA）；任何 agent 不经手凭据（§6）。禁止把 tag 打在非发布 commit 上再前移（2026-08 事故）。

### 3.3 测试要求

- **core**：Vitest 单测，场景覆盖设计文档边界清单；归因静态分析（bash + pwsh 双语法）必须有参数化用例。
- **dsh-adapter**：端到端跑一期设计文档 §7 的 T1–T13 矩阵；行为级断言（T4）允许人工验收，但 PR 里要附录屏或日志。
- **claude-code**：daemon/hook 进程级测试跑 phase2 §7 的 P2-T1~T12；CI 用沙盒 + headless 形态。
- 性能门：压测 10 万文件仓库（PRD R5）；pre-step 早退路径 <1ms；FR-7 单次快照 <50ms。
- 测试不得依赖真实宿主进程之外的任何外部服务；watcher 测试用临时目录。

### 3.4 Definition of Done

一个 FR 完成 = 实现 + 单测/端到端断言 + 日志留痕 + 设计文档对应章节勾销（如设计有变，**先改设计文档再改代码**，保持文档为单一事实源）。

## 4. dsh 平台注意事项（一期 adapter）

1. **不要凭记忆写 dsh API**。dsh 迭代快，写代码前先查本机安装的源码与 `.d.ts`：设计文档附录「关键源码坐标」是入口。运行时能力用 Cordis Inspect Provider 核实。
2. 插件是 **Host 平面 bundle**（决策 D1）：root ctx 监听、按 `Agent` 对象 WeakMap 分键。不要注册成 preset 行；不要往 preset 里发布服务（isolate realm 规则见 dsh 的 editing-cordis-compositions skill）。
3. **永不修改 dsh 随附安装**（`config/agent-presets/` 下的 shipped preset、host composition）。需要改动 preset 行为时拷贝后改副本。
4. 事件契约要点：pre-step 先 `next()` 后追加；空批次 + 无工具执行 = 疑似 turn 关闭检查，**不注入**（§5.5.3）；`fs/observed` 监听器必须同步、不得 throw。
5. 工具名集合：读 `read`/`read_image`，写 `write`/`edit`，shell 是 `bash`（POSIX）或 `pwsh`（Windows）——归因逻辑必须按平台取正确的 shell 工具名。
6. 注入消息 source 固定为 `{kind:'plugin', plugin:'bright-drift', form:'notice', summary}`，summary ≤120 字符。
7. 依赖版本与 dsh 依赖树对齐：chokidar ^4.0.3、diff ^9.0.0（以安装树实际版本为准，升级前先核对）。

## 5. Claude Code 平台注意事项（二期 adapter）

1. **daemon 是长驻进程、持有代码内存镜像**：升级后必须停 daemon（`install` 已自动 `stopDaemons`；hook 是短命进程每次读新 lib/，daemon 不重启则跑旧代码）。
2. **注入文本禁绝对时间戳**（phase2 §5.6.4）：CC resume/compact 会从 transcript 重放历史注入，绝对时间戳会陈旧误导，只用相对表述。
3. **渲染产物 ≤ 9,500 字符**（E4 红线）：官方承诺 10,000、实测 ~25KB spill，超线整批折叠为单行摘要。
4. **Windows 平台坑**：杀 daemon 用 PowerShell `Stop-Process`（Git Bash `kill <pid>` 不可靠）；原子写 rename 覆盖遇瞬时 EPERM 需重试。
5. hooks 是 esbuild 打包的 ESM 单文件，`yaml` 是 CJS dynamic require——构建须加 `createRequire` banner shim。
6. **平台限制（phase2 §2.2 非目标，不修）**：仅 CLI；桌面端/Agent SDK/VS Code 不加载 hooks（#87657）；插件 hooks.json 的 hook 发现损坏（#16288）。上架插件市场被此二 bug 阻塞，维持 settings.json 注入形态。
7. CC 配置 schema 与 dsh 五节通用（`watch`/`budget`/`diff`/`baseline`/`attribution`），仅 `inject` 节平台特有（dsh: `onPreStep`/`onSessionStart`/`promptSection`；CC: `onUserPrompt`/`onStop`/`staticOverview`）。

## 6. 安全与隐私

- **不索取、不存储任何凭据**（密码、API Key、Token）。配置里没有也不允许出现密钥字段。
- 日志只记哈希、路径、计数，**永不记录文件内容**（PRD FR-6）。
- content-store 的 blob 落盘在用户本机状态目录（dsh：`~/.dsh/state/bright-drift/`；CC：`~/.claude/state/bright-drift/`），不进仓库、不上传。
- 插件不发起任何网络请求（无遥测）。
- **操作宿主用户文件（dsh 的 `~/.dsh/` settings/profile/preset；CC 的 `~/.claude/settings.json`）时**：只读用 `read` 工具；修改必须字节级或显式 UTF-8 读写，**禁止**经 Windows PowerShell 5.1 默认编码（GBK）往返——会把非 ASCII 内容（含换行）损毁（2026-08-30 实测事故）。改动前先备份。

## 7. 配置与状态位置

| 内容 | dsh（一期） | Claude Code（二期） |
|---|---|---|
| 全局配置 | `~/.dsh/settings.yaml` 的 `bright-drift:` 节 | `~/.claude/state/bright-drift/config.yml` |
| 项目级覆盖 | `<workspace>/.dsh/bright-drift.yml` | `<repo>/.claude/bright-drift.yml` |
| 状态根 | `~/.dsh/state/bright-drift/` | `~/.claude/state/bright-drift/`（可用 `BRIGHT_DRIFT_STATE_HOME` 重定向） |
| AKB / 会话状态 | `~/.dsh/state/bright-drift/akb/<sessionId>.json` | `~/.claude/state/bright-drift/workspaces/<ws-hash>/akb/<sessionId>/` |
| 内容副本 | `~/.dsh/state/bright-drift/blobs/`（sha1 寻址，LRU，默认 256MB） | 同上 `akb/<sessionId>/blobs/` |
| 日志 | `~/.dsh/logs/bright-drift/<date>.log` | `~/.claude/state/bright-drift/logs/<date>.log` |

## 8. 写作与文档语言

- 用户-facing 文档：根 README 中文为主（`README.md`），英文版存 `README_en.md`，两者同步；子包 README（npm 页面展示）英文即可。
- 设计文档、PRD、内部讨论：中文。
- 代码注释：英文；commit message：英文。
