# bright-drift Jcode adapter 预研报告

- 日期：2026-10-19
- bright-drift 版本：`0.4.0`（core / dsh-adapter / claude-code 三包同版本）
- Jcode 实测版本：`v0.99.0 (774613c90)`，安装于本机
- Jcode 源码快照：`48aa83e919e235d6cca87b7ce42858a9bd8e1f26`（2026-10-19，shallow clone）
- 结论等级：源码核实为主，文档核实为辅，少量推断已明确标注

---

## 0. 结论先行

**可行性高。Jcode 现有生命周期 hook 足以在不修改 Jcode 的前提下做出可用的 MVP，但要做到与 dsh 一期「每个模型请求前都可注入」等价的体验，建议同时推动 Jcode 上游增加一个同步的 `before_request` hook。**

三条主要结论：

1. **MVP 通道用 `post_tool_feedback`**。Jcode 在每个工具成功执行后同步运行该 hook，hook 的 stdout 会追加到工具结果中，模型通常能在下一次请求看到。它天然满足「模型请求前注入」的语义，且不需要守护进程以外的 IPC、不需要 `jcode api-bridge`、不需要改 Jcode。代价是：如果某一轮模型完全不调用工具，本轮无法注入。
2. **完整覆盖通道用 Jcode 上游 `before_request` hook**。在每个模型请求迭代前同步运行，stdout 作为隐藏的 `<system-reminder>` 用户消息追加到上下文。它对应 dsh 的 pre-step，能覆盖「用户提问后不调用任何工具」的场景。改动量估计 200 到 400 行 Rust 加测试，适合作为上游 PR。
3. **`jcode api-bridge` + TypeScript SDK 可作为过渡或可选增强，不建议作为默认路径**。SDK 的 `sendMessage({ noReply: true })` 可以在空闲时写入隐藏上下文，`softInterrupt` 可以在忙碌时于安全点插入消息，两者都有确认事件，适合做 at-most-once。但要求用户额外运行 `jcode api-bridge`，Windows 上 SDK 官方标注「已接线但无 live 端到端覆盖」，且软中断消息在 TUI 中按用户消息展示。它适合作为高级选项，不适合作为唯一通道。

**工作量预估**：MVP 1.5 到 2 周；加 bridge 通道 1 周；加上游 `before_request` 与切换 1 到 1.5 周；加发布与文档 0.5 周。总计 4 到 5 周，与二期 CC adapter 的量级接近。

补充：2026-10-19 已用隔离 `JCODE_HOME` 加 `jcode debug tool` 实测 `post_tool_feedback`，确认输出会以 `[post_tool_feedback]` 追加到工具结果，`pre_tool` / `post_tool` 字段与报告一致，hooks 数组形式可用，单 hook 输出在 8KB 处截断。实测记录见附录 D。

---

## 1. 调研范围与方法

### 1.1 调研对象

| 对象 | 内容 |
|---|---|
| Jcode 运行方式 | TUI、Desktop、`jcode run`、swarm/subagent、shared server |
| Jcode 扩展点 | `[hooks]`、`pre_tool_transform`、MCP、skills、AGENTS.md、prompt overlay、SDK、ACP、debug CLI |
| Jcode 数据面 | session 生命周期、工具调用、工具结果、transcript、配置、状态目录 |
| bright-drift 现状 | core 七个模块、dsh 一期 adapter、CC 二期 adapter、单 Sync Point、outbox 模式 |
| 目标平台约束 | Windows 路径与编码、Node 启动成本、Jcode 版本演进 |

### 1.2 证据来源

- 本机 `jcode --quiet version --json` 输出。
- Jcode 源码 shallow clone 与 `docs/HOOKS.md`、`docs/WRAPPERS.md`、`docs/SYSTEM_PROMPT_CONFIG.md`。
- 本机 `~/.jcode/config.toml` 只读检查，当前没有 `[hooks]` 段。
- bright-drift `packages/core`、`packages/dsh-adapter`、`packages/claude-code` 与三份设计文档。
- Node 冷启动实测：本机 Windows，`node --eval '0'` 平均约 103ms。

说明：源码快照 `48aa83e` 比安装版 `774613c90` 新一个提交。报告引用的 hook 契约同时与安装版随附的 `docs/HOOKS.md` 核对过。若两者在实现细节上有差异，以安装版实际行为为准，落地时需要用 M7.1 的端到端测试再确认。

### 1.3 证据等级约定

- **源码核实**：直接读到实现，给出文件与行号。
- **文档核实**：Jcode 随附文档明确写明。
- **推断**：基于实现做出的工程判断，报告中会标注。

---

## 2. bright-drift 现状与 adapter 契约

### 2.1 core 的七个模块

| 模块 | 职责 | 对 adapter 的意义 |
|---|---|---|
| `watcher` | chokidar 工作区监听、gitignore、git tracked 判定 | 每个工作区挂一个 |
| `baseline` | AKB、内容副本、sha1 寻址、LRU | 每个会话一份 |
| `drift` | reconcile、created gate、queue、revalidate | 把原始事件变成文件级漂移 |
| `attribution` | 归因窗口状态机、bash/pwsh 静态分析、格式化判定 | 需要 adapter 提供窗口开启/关闭和预快照 |
| `diff` | 文件 diff、二进制判定、token 估算 | 渲染前计算 |
| `budget` | 预算规划、diff/list 降级 | 渲染前裁剪 |
| `message` | 注入文本渲染、notice summary | adapter 直接复用 |

core 的公开 API 在 v1.0 前标记 experimental，新增平台适配时可以增补，但不得让 core 依赖任何平台 API。

### 2.2 两个既有 adapter 的通道对照

| 维度 | dsh 一期 | Claude Code 二期 |
|---|---|---|
| 进程形态 | Host 平面 bundle，进程内 | daemon + 短命 hooks |
| 会话事件 | `agent/created`、`agent/disposed`、`session/disposed` | SessionStart / SessionEnd |
| AKB 观察 | `fs/observed` 或工具事件 | PostToolUse |
| 归因窗口 | 工具执行前后 | PreToolUse(Bash) / PostToolUse(Bash) |
| 主注入通道 | pre-step 渲染 | UserPromptSubmit |
| 补投通道 | 无 | Stop，高优先级批次 |
| at-most-once | 单点渲染 + 注入 | pending 文件 `deliveredVia` + batchId |
| Sync Point | pre-step 渲染时 | 投递确认时（outbox） |

### 2.3 一个 adapter 必须提供的六件事

1. **会话生命周期**：发现新会话、恢复旧会话、注销关闭的会话。
2. **AKB 观察**：工具读写了哪些文件，写入后基线如何更新。
3. **归因窗口**：shell 命令开始前快照，结束后关闭窗口，后台命令保持打开。
4. **注入通道**：在模型下一次请求前，把预渲染文本送入上下文。
5. **at-most-once**：同一 batchId 只能投递一次，投递确认后才提交基线。
6. **fail-open**：hook 崩溃、超时、配置损坏、Node 缺失都不能中断 agent 会话。

Jcode adapter 的差异只应体现在第 2 到第 4 项的平台映射上，core 逻辑应零改动或仅做加法。

---

## 3. Jcode 平台能力审计

### 3.1 进程与会话模型

Jcode 是 Rust 实现的 shared server 架构。TUI、Desktop、`jcode run`、swarm worker 都通过协议连接到 daemon。会话有稳定的 `session_id`，持久化在 Jcode home 下。多个客户端可以附着到同一个会话。

对 bright-drift 的含义：

- daemon 可以按 `session_id` 维护独立 AKB，按工作区分组共享一个 watcher。
- hook 是 Jcode daemon 主动 spawn 的外部进程，天然覆盖 TUI、Desktop、headless、swarm，不需要为每个前端单独适配。
- shared server 意味着同一个工作区可能同时有多个会话，包括子代理。adapter 必须能处理多会话并发。

### 3.2 生命周期 hooks

Jcode 的 hooks 定义在 `$JCODE_HOME/config.toml` 或 `~/.jcode/config.toml` 的 `[hooks]` 段。命令按 shell 风格解析，但**直接执行**，不经过 shell；`~/` 会展开；hook 进程的工作目录是会话 cwd。每次 hook 都会收到 `JCODE_HOOK_*` 环境变量和 `JCODE_HOOK_PAYLOAD` JSON。hook 进程会继承 `JCODE_HOOKS_DISABLED=1`，防止 hook 里再调用 jcode 时递归触发。

| 事件 | 同步性 | 关键输入 | stdout 去向 | 超时 | 对 bright-drift 的用途 |
|---|---|---|---|---|---|
| `session_start` | observer，detached | session_id、cwd、source=create/attach/resume | 丢弃 | 无 | 注册会话、拉起 daemon、冷启动对账 |
| `session_end` | observer，detached | session_id、cwd、source=close | 丢弃 | 无 | 注销会话、保存 AKB |
| `turn_start` | observer，detached | session_id、cwd、model、source=chat/run/failover | 丢弃 | 无 | 只能做信号，不能注入 |
| `turn_end` | observer，detached | status、tokens、最后一段 assistant 文本 | 丢弃 | 无 | 日志、指标、空闲判定 |
| `pre_tool` | **同步 gate** | TOOL_NAME、完整工具输入在 stdin | 只有 exit 2 时 stderr 进入工具错误 | 默认 5s | 归因窗口开启、bash 预快照 |
| `post_tool` | observer，detached | TOOL_NAME、TOOL_CALL_ID、TOOL_INPUT、TOUCHED_PATHS、STATUS | 丢弃 | 无 | AKB 观察、窗口关闭 |
| `post_tool_feedback` | **同步** | 同 post_tool，完整输入在 stdin | 追加到工具结果 | 默认 10s | **主注入通道** |
| `pre_tool_transform` | 同步 | 工具输入 JSON | 替换工具输入 | 默认 500ms | 与 bright-drift 无关 |

关键源码坐标：

- `crates/jcode-base/src/hooks.rs:105-127`：事件到配置项的映射。
- `crates/jcode-base/src/hooks.rs:342-376`：observer 的 detached 分发。
- `crates/jcode-base/src/hooks.rs:378-499`：`pre_tool` gate 语义。
- `crates/jcode-base/src/hooks.rs:501-597`：`post_tool_feedback` 语义与 8KB 上限。
- `crates/jcode-app-core/src/tool/mod.rs:1062-1081`：`pre_tool` 在工具执行前调用。
- `crates/jcode-app-core/src/tool/mod.rs:878-905`：feedback 追加到工具结果，带 `[post_tool_feedback]` 标记。
- `crates/jcode-app-core/src/tool/mod.rs:811-851`：`post_tool` 的字段构造。
- `crates/jcode-app-core/src/agent/turn_execution.rs:279-297`：`turn_start` 在用户消息之后、模型生成之前触发。
- `crates/jcode-app-core/src/agent.rs:1269-1283`：`session_start` / `session_end`。

**最重要的能力缺口**：Jcode 没有 `user_prompt_submit` 或 `before_request` 这类同步且可回传文本的 turn 边界 hook。`turn_start` 是 observer，stdout 被丢弃，无法注入。`post_tool_feedback` 是唯一能在不修改 Jcode 的前提下把文本送进模型上下文的同步通道。

### 3.3 工具名与路径

Jcode 的内置工具名是稳定字符串：

| 工具 | 名称 | 对 bright-drift 的语义 |
|---|---|---|
| 读文件 | `read` | AKB read |
| 写文件 | `write` | AKB write |
| 编辑 | `edit` | AKB write |
| 补丁 | `apply_patch` | AKB write，支持多文件、删除、移动 |
| shell | `bash` | 归因窗口；POSIX 是 bash，Windows 是 **cmd.exe** |
| 列目录 | `ls` | 目录，忽略 |
| 搜索 | `agentgrep` | 读，可能带 `path` 或 `paths` |
| 打开 | `open` | 可能是文件或 URL，过滤后使用 |
| 批处理 | `batch` | 子调用会再次走 registry，因此会触发 hook |
| 代码模式 | `codemode` | 可通过工具间接写文件，直接 fs 访问不在保证内 |
| 后台任务 | `bg` | 管理后台任务，不是 shell 本身 |
| 浏览器/电脑 | `browser`、`computer` | 可能产生工作区外副作用，归因保守处理 |
| MCP 工具 | `mcp__*` | 未知写入面，按 touched paths 尽量跟踪 |

Jcode 的 `touched_paths` 覆盖这些输入键：`file_path`、`path`、`target`、`target_path`、`old_path`、`new_path`、`paths` 数组前 8 个，以及 `apply_patch` 的补丁头。实现见 `crates/jcode-app-core/src/tool/mod.rs:673-744`。这足以覆盖 bright-drift 需要的读、写、补丁场景。

### 3.4 Windows shell 差异

这是本次调研最重要的平台发现之一：

- Jcode 的工具名在所有平台都叫 `bash`。
- 在 POSIX 上，它执行 `bash -c`。
- 在 Windows 上，它执行 `cmd.exe /D /S /C`，不是 PowerShell，也不是 Git Bash。

源码：`crates/jcode-app-core/src/tool/bash.rs:650-665`。工具描述也明确写着「Run a Windows cmd.exe command」。

bright-drift core 目前的 `Attributor` 只接受 `shell: 'bash' | 'pwsh'`，`analyzeCommand` 也只在 bash 与 pwsh 之间分派（`packages/core/src/attribution/static-analysis.ts:191-193`）。

因此在 Windows 上：

- 归因窗口本身仍然可用，B 类判定不依赖静态分析。
- 但 `predictedPaths` 会为空，导致 `created-gate` 对 git 未跟踪的新文件默认抑制。也就是说，cmd 命令新建的未跟踪文件可能被漏报。
- 不能把 cmd 命令当 pwsh 分析，语法差异会带来误判。

**建议**：core 增加 `analyzeCmd` 与 `shell: 'cmd'`，至少覆盖重定向、`copy`、`move`、`del`、`mkdir`、`rmdir`、`echo >`、`type >` 等常见写入形式；在分析器完成前，Windows 上默认 `watch.includeUntracked: true`，用更多噪声换取不漏报。

### 3.5 配置与状态目录

| 内容 | Jcode 路径 |
|---|---|
| Jcode home | `$JCODE_HOME`，否则 `~/.jcode` |
| 全局配置 | `$JCODE_HOME/config.toml`，否则 `~/.jcode/config.toml` |
| 会话记录 | `$JCODE_HOME/sessions/<session_id>.json` |
| 日志 | `$JCODE_HOME/logs/` |
| 项目级提示 | `<repo>/AGENTS.md`、`<repo>/.jcode/prompt-overlay.md` |
| 全局提示 | `~/.jcode/AGENTS.md`、`~/.jcode/prompt-overlay.md` |

源码：`crates/jcode-storage/src/lib.rs:163-170`、`crates/jcode-base/src/config/config_file.rs:15-19`。

bright-drift 建议使用：

```
$JCODE_HOME/state/bright-drift/
├── config.yml
├── install.json
├── logs/<date>.log
└── workspaces/<ws-hash>/
    ├── workspace.json
    ├── daemon.lock
    ├── sessions/<session_id>.json
    ├── mailbox/<session_id>/...
    ├── pending/<session_id>.json
    └── akb/<session_id>/
```

项目级覆盖：`<repo>/.jcode/bright-drift.yml`。

注意：Jcode 的 hook 配置**只有全局一份**，没有项目级 hooks。因此安装器只能改 `$JCODE_HOME/config.toml`。这一点与 CC 的 `--project` 安装不同。

### 3.6 API bridge 与 SDK

Jcode 提供 harness API（protocol v1）：

- `jcode api-bridge` 启动一个本地 socket 或 Windows named pipe，把协议翻译到内部 daemon。
- TypeScript SDK `@1jehuang/jcode-sdk` 提供 `connect()`、`listSessions()`、`attachSession()`、`sendMessage()`、`softInterrupt()`、`events()` 等能力。
- `sendMessage(sessionId, content, { noReply: true })` 会调用 daemon 的 `append_context_message`，把消息写入 transcript 但**不启动模型 turn**。这正是一个「空闲时注入上下文」的通道。
- 忙碌时 `noReply` 会因为拿不到 agent 锁而返回 busy。此时可以用 `softInterruptWithId` 把消息排到下一个安全点，并用 `soft_interrupt_injected` 事件确认投递。
- `SoftInterruptInjected` 事件带有 `display_role` 字段，但协议请求本身不暴露 `display_role`，通过 SDK 发出的软中断在 TUI 中按用户消息展示。

源码坐标：

- `crates/jcode-harness-api/src/requests.rs:90-103`：`SendMessage` 的 `system_reminder` 与 `no_reply`。
- `crates/jcode-harness-api/src/requests.rs:126-140`：`SoftInterrupt` 与 `client_id`。
- `crates/jcode-app-core/src/server/client_lifecycle.rs:1172-1192`：`no_reply` 分支。
- `crates/jcode-app-core/src/server/client_lifecycle.rs:3354-3383`：`append_context_message`，拿不到锁就返回 busy。
- `crates/jcode-harness-api/src/events.rs:208-232`：`SoftInterruptInjected` 与 `point`。
- `sdk/typescript/src/client.ts:191-201`、`581-634`：`SendMessageOptions.noReply`。
- `sdk/typescript/src/client.ts:694-720`：`softInterrupt`。

**限制**：

1. 必须额外运行 `jcode api-bridge`。普通 TUI 用户不会自动启动它。
2. Windows 上 SDK 官方 README 写明「builds and is wired up，但没有 live 端到端覆盖」。这是明确的未验证风险。
3. `no_reply` 写入的是 `Role::User` 消息，没有 `display_role: system`，TUI 实时不显示，但重载历史后可能显示为用户消息。
4. `no_reply` 在忙碌时立即失败，不适合作为唯一通道。
5. 软中断是用户消息语义，可能被模型当作新指令回应。

### 3.7 系统提示与静态上下文

Jcode 的系统提示分层为：内置 base、能力模块、`AGENTS.md`、`.jcode/prompt-overlay.md`、`.jcode/preferred-tools.md`、memory 与 active skill。这些层在**会话创建时捕获**，运行中的会话保持启动时的提示，不会因为文件变化自动更新。

这意味着 bright-drift 不能像 dsh 的 `promptSection` 那样在每个请求拼装系统提示。Jcode adapter 只能走消息级注入。静态概述只能在会话启动后的第一次注入中附带，或者通过 bridge 的 `noReply` 写入。

`docs/SYSTEM_PROMPT_CONFIG.md` 也明确说明：修改这些文件只对**新会话**生效。

### 3.8 能力矩阵小结

| 能力 | Jcode | 对 adapter 的影响 |
|---|---|---|
| 会话开始/结束事件 | 有 | 可直接注册/注销 |
| 每轮开始事件 | 有，但只读 | 不能注入 |
| 每轮结束事件 | 有 | 可做日志与空闲判定 |
| 工具前同步 hook | 有 | 可做预快照与窗口开启 |
| 工具后同步 hook | 有，且 stdout 进入工具结果 | **可做注入** |
| 用户提问前同步 hook | 无 | 最大缺口 |
| 每模型请求前同步 hook | 无 | 上游建议 |
| 动态系统提示 | 无 | 只能消息注入 |
| 项目级 hooks | 无 | 安装器只改全局配置 |
| 本地 API/SDK | 有，需 bridge | 可选通道 |
| Windows 支持 | 有，cmd.exe | 需要 cmd 归因分析 |

---

## 4. 注入通道方案比较

### 方案 A：`post_tool_feedback` 主通道

工作方式：

1. daemon 监听工作区，检测漂移，完成归因、预算、渲染，写入 `pending/<session_id>.json`。
2. 模型调用任意工具，Jcode 在工具成功后同步运行 `post_tool_feedback`。
3. hook 读取 pending，原子 claim 一个 batch，把渲染文本打印到 stdout。
4. Jcode 在工具结果末尾追加：

```
[post_tool_feedback]
<workspace-drift 文本>
```

5. 模型在下一次请求看到工具结果和漂移文本。
6. hook 在打印后把 batch 标记为 delivered，daemon 收到确认后提交基线。

优点：

- 不需要修改 Jcode。
- 不需要 bridge。
- 文本在工具结果里，天然是「观察」语气，不会被当作新的用户指令。
- 覆盖 TUI、Desktop、`jcode run`、swarm worker。
- 与 CC 的 Stop 补投在时序上相似，都是「工具批次结束后、下一次模型请求前」。

缺点：

- 如果一轮完全没有工具调用，本轮无法注入。用户手动改文件后只问一个纯知识问题，会漏掉。
- 每次成功工具调用都会 spawn 一个 hook 进程，需要控制成本。
- 8KB 上限，且如果工具输出触发上下文保护被拒绝，feedback 可能随输出一起丢失。
- 注入发生在工具结果之后，不是用户提问之前。对于「先注入再决定是否读文件」的场景，慢半拍。

### 方案 B：`jcode api-bridge` + SDK

工作方式：

1. daemon 通过 `@1jehuang/jcode-sdk` `connect()` 到本地 bridge。
2. `attachSession(session_id)`，监听 `TurnDone`、`SoftInterruptInjected`、`SessionStatus`。
3. 空闲时用 `sendMessage({ noReply: true })` 写入 `<system-reminder>` 包裹的漂移文本，确认事件是 `ContextMessageAdded`。
4. 忙碌时用 `softInterruptWithId(session_id, text, { clientId: batchId })`，等待 `soft_interrupt_injected` 里出现该 batchId。
5. 确认后提交基线。

优点：

- 覆盖「不调用工具」的轮次。
- 空闲注入不启动模型 turn，不会产生额外费用。
- 有明确的投递确认事件，at-most-once 实现干净。
- 可以读取 `TurnDone.pending_soft_interrupts` 做补偿。

缺点：

- 需要 `jcode api-bridge` 常驻。安装器如果自动拉起，就要管理其生命周期与版本。
- Windows SDK 未经过 live 端到端验证。
- `no_reply` 写入的是用户角色消息，重载历史可能可见。
- 软中断是用户消息语义，模型可能回应它。
- 需要为每个会话维护一个 bridge 连接，协议 v1 的 bridge 每个连接只附着到一个会话。
- 多会话、子代理场景连接数会上升。

### 方案 C：上游 `before_request` hook（推荐长期方案）

工作方式：

1. Jcode 在每个模型请求迭代前同步运行 `before_request` hook。
2. hook 的 stdout 作为隐藏的 `<system-reminder>` 用户消息追加到本轮请求。
3. bright-drift daemon 预渲染 pending，hook 只做读取、claim、打印，保持毫秒级。
4. 覆盖 turn 内每一次工具循环后的模型请求，语义与 dsh pre-step 完全一致。

优点：

- 覆盖完整，不依赖 bridge。
- 时序正确，正好在 `messages_for_provider` 之前。
- 可以设置为 system display role，TUI 不显示为用户消息。
- 不需要额外进程。
- 对 Jcode 其他插件也是通用能力，容易上游接受。

缺点：

- 需要 Jcode 发版，存在排期不确定性。
- 每个请求多一次同步 hook 调用，需要严格超时与 fail-open。
- 需要在两个 turn loop（streaming 与 non-streaming）都接入，测试面较大。

### 方案 D：MCP 工具

把 bright-drift 暴露成 MCP 工具，例如 `bright_drift_status`、`bright_drift_ack`。模型需要主动调用才能看到漂移。

评价：不能作为主动注入通道，但可以作为诊断与手动查询的补充。建议在 MVP 之后加，不作为核心方案。

### 方案 E：prompt overlay / AGENTS.md

把静态说明写进 `.jcode/prompt-overlay.md` 或 `AGENTS.md`，告诉模型「有漂移时先调用某个工具」。

评价：只能提供静态指令，不能携带动态漂移内容。Jcode 在会话启动时捕获提示，运行中修改文件也不会生效。不可行。

### 4.1 方案对照表

| 维度 | A `post_tool_feedback` | B API bridge | C 上游 `before_request` | D MCP |
|---|---|---|---|---|
| 修改 Jcode | 否 | 否 | 是 | 否 |
| 额外常驻进程 | 否 | 是，`api-bridge` | 否 | 视实现 |
| 覆盖纯问答轮 | 否 | 是 | 是 | 否，需模型调用 |
| 覆盖 turn 内工具循环 | 是 | 是 | 是 | 否 |
| 注入可见性 | 工具结果内，隐蔽 | 用户消息，较显眼 | system reminder，可隐藏 | 模型主动读取 |
| at-most-once 确认 | hook 打印后本地确认 | 明确事件确认 | hook 输出即确认 | 工具返回确认 |
| Windows 风险 | 低 | 中高 | 低 | 低 |
| 实现复杂度 | 低 | 中高 | 中 | 中 |
| 建议 | **MVP 主通道** | 可选增强 | **长期主通道** | 诊断补充 |

### 4.2 推荐路线

1. **M7.1**：实现方案 A，先把 adapter 跑通。
2. **M7.2**：如果实测发现纯问答轮漏注入不可接受，再加方案 B 作为可选通道，默认关闭。
3. **M7.3**：向上游提 `before_request` hook，合并后把 A 降级为 fallback，C 成为默认主通道。
4. **M7.4**：加 MCP 诊断工具，可选。

---

## 5. 推荐架构

### 5.1 包结构

```
packages/jcode/
├── src/
│   ├── daemon/
│   │   ├── main.ts          # 入口、锁、空闲自退
│   │   ├── workspace.ts     # 每工作区 watcher + 共享漂移检测
│   │   ├── session.ts       # 每会话 AKB / Attributor / 队列
│   │   ├── mailbox.ts       # hook → daemon 文件邮箱
│   │   └── bridge.ts        # 可选：SDK 注入通道
│   ├── hooks/
│   │   ├── session-start.ts
│   │   ├── session-end.ts
│   │   ├── pre-tool.ts      # 归因窗口开启 + 预快照
│   │   ├── post-tool.ts     # AKB 观察 + 窗口关闭
│   │   └── feedback.ts      # 读取 pending、claim、打印
│   ├── installer/
│   │   ├── toml-edit.ts     # 保留注释的 TOML 行级编辑器
│   │   ├── install.ts       # 安装/卸载/自检
│   │   └── doctor.ts
│   ├── shared/
│   │   ├── config.ts        # 五节通用 + inject 节
│   │   ├── paths.ts         # JCODE_HOME / state root
│   │   ├── atomic.ts
│   │   ├── mailbox.ts
│   │   └── pending.ts
│   └── cli.ts
├── build.mjs                # esbuild 打包 hooks 与 daemon
└── package.json
```

包名建议 `bright-drift-jcode`，版本与三包对齐，下一次发布统一为 `0.5.0`。

### 5.2 进程与数据流

```
                    ┌──────────── Jcode daemon ────────────┐
用户输入 ──────────► │ 无 user_prompt / before_request hook   │
                    │ （MVP 阶段此处不注入）                 │
                    │                                       │
工具调用 ──────────► │ pre_tool hook（同步）                  │
                    │   bash? → 读 akb-paths.json → stat 快照 │
                    │   → 写 mailbox/window.open.json        │
                    │                                       │
工具结束 ──────────► │ post_tool hook（detached）             │
                    │   → 写 mailbox/akb.observe 或 close    │
                    │                                       │
工具成功 ──────────► │ post_tool_feedback hook（同步）         │
                    │   读 pending/<sid>.json                │
                    │   → 原子 claim                         │
                    │   → stdout 漂移文本                    │
                    │   → 标记 delivered                     │
                    └───────────────┬───────────────────────┘
                                    │ 文件协议
                    ┌───────────────▼───────────────────────┐
                    │ bright-drift daemon（Node，detached）  │
                    │   chokidar watcher                     │
                    │   每会话 AKB + Attributor + DriftQueue │
                    │   漂移检测 → 归因 → 预算 → 渲染        │
                    │   写 pending/<sid>.json                │
                    │   消费 mailbox/                        │
                    └───────────────────────────────────────┘
```

IPC 继续采用纯文件协议，理由与二期相同：可观察、可恢复、跨平台、热路径只读一个文件。daemon 用 chokidar 监听 mailbox，复用 core watcher 的成熟代码。

### 5.3 hook 映射

| Jcode 事件 | adapter hook | 动作 |
|---|---|---|
| `session_start` | `session-start.js` | `wsHash(cwd)`，幂等拉起 daemon，写 `session.register`，冷启动对账 |
| `session_end` | `session-end.js` | 写 `session.deregister`，触发 AKB 保存 |
| `pre_tool` | `pre-tool.js` | 仅对 `bash` 做工；读 `akb-paths.json`，stat 快照，静态分析 `command`，写 `window.open` |
| `post_tool` | `post-tool.js` | `read`/`write`/`edit`/`apply_patch` 写 `akb.observe`；`bash` 写 `window.close`；`run_in_background` 不关闭 |
| `post_tool_feedback` | `feedback.js` | 读 pending，claim，打印，标记 delivered |
| `turn_start` | 不安装 | 没有注入能力，暂不使用 |
| `turn_end` | 可选 | 日志、指标、空闲判定 |
| `pre_tool_transform` | 不安装 | 与 bright-drift 无关 |

### 5.4 注入状态机

```
IDLE
  │ watcher 批量到达
  ▼
COLLECTING
  │ 归因 + 队列稳定（debounce）
  ▼
RENDERING
  │ core: budget + message
  ▼
PENDING  ── pending/<sid>.json 写入，batchId 固定
  │
  ├─ feedback hook claim（原子 rename 到 in-flight）
  │      │ stdout 打印成功
  │      ▼
  │   DELIVERED ── 写 delivered 标记，daemon 提交 AKB 基线
  │
  ├─ bridge no_reply 确认（可选）
  │      ▼
  │   DELIVERED
  │
  └─ bridge soft interrupt 确认（可选）
         ▼
      DELIVERED
```

规则：

1. **渲染不提交基线**。只有投递确认后才提交，这是单 Sync Point 的要求。
2. **一个会话同时只有一个 pending batch**。新漂移在 pending 未投递前合并进同一 batch，batchId 不变。这样避免乱序，也避免短时间多次注入。
3. **claim 用原子 rename**。并行工具调用时只有一个 hook 能抢到 batch。
4. **in-flight 不回到 pending**。如果 hook 在 claim 后崩溃，daemon 在启动或超时后只把它标记为 `abandoned`，不重新投递同一个 batchId。未提交的漂移由冷启动对账以**新的 batchId** 重新检测，这样同一批次永远不会被投递两次。
5. **fallback 不并行**。同一 batch 不能同时走 feedback 和 bridge。配置里选择主通道，另一个只在主通道不可用时接管未投递 batch。

### 5.5 归因映射

| Jcode 工具 | 归因动作 |
|---|---|
| `bash` 前台 | `pre_tool` 开窗，`post_tool` 关窗，grace 1.5s |
| `bash` 后台 | `run_in_background: true`，开 `background: true` 窗口，永不关闭，所有窗口内漂移标为 ambiguous-external |
| `write`、`edit`、`apply_patch` | `post_tool` 成功后将 touched paths 写入 AKB，reconcile 时作为自身写入被 A 类抑制 |
| `read`、`agentgrep`、`open` | `post_tool` 成功后将文件路径写入 AKB read |
| `batch` | 子调用各自触发 hook，按子工具处理；batch 自身的 touched paths 为空 |
| `codemode` | 通过 registry 调用的工具会触发 hook；直接 fs 访问不保证 |
| `computer`、`browser` | 不视为 shell 窗口，产生的文件变更走 C 类 |
| MCP 工具 | 有 touched paths 就按读/写观察，没有就忽略 |

归因歧义永远偏向外部的原则不变。Windows cmd 静态分析缺失时，宁可把新文件报为外部，也不要漏报。

### 5.6 配置

沿用五节通用 schema，`inject` 节改成 Jcode 形态：

```yaml
enabled: true
watch:
  respectGitignore: true
  extraIgnore: []
  includeUntracked: false
budget:
  maxDiffLinesPerFile: 200
  maxTotalDiffLines: 1000
  maxInjectTokens: 2000
  maxDriftFilesForDiff: 50
diff:
  contextLines: 3
  maxFileSizeKB: 512
  blacklist: []
baseline:
  maxEntries: 5000
  persist: true
  persistContent: true
  contentStoreMaxMB: 256
attribution:
  bashWindowGraceMs: 1500
  longCommandMs: 10000
  formatterWindowMs: 1000
  formatterSilent: false
inject:
  onPostToolFeedback: true
  onApiBridge: false
  bridgeAutoStart: false
  includeSubagents: true
  maxFeedbackBytes: 7500
  maxBridgeChars: 9000
```

`maxFeedbackBytes` 要小于 Jcode 的 8KB 上限，给 `[post_tool_feedback]` 标记和 UTF-8 多字节留余量。中文按 3 字节计算，7500 字节大约 2500 个汉字。

Windows 上建议在 `analyzeCmd` 落地前默认 `watch.includeUntracked: true`，避免 cmd.exe 新建的未跟踪文件被 created-gate 抑制。

### 5.7 安装器

安装器要做四件事：

1. 找到 `jcode` 与 `JCODE_HOME`。
2. 读 `config.toml`，在 `[hooks]` 段合并五条命令。
3. 自检：Node 路径、hook 文件存在、版本兼容、状态目录可写。
4. 卸载：只删除自己的命令，保留用户已有 hooks。

命令示例：

```toml
[hooks]
session_start = "C:\\Program Files\\nodejs\\node.exe \"C:\\Users\\me\\AppData\\Local\\...\\hooks\\session-start.js\""
session_end = "..."
pre_tool = "..."
post_tool = "..."
post_tool_feedback = "..."
pre_tool_timeout_ms = 5000
post_tool_feedback_timeout_ms = 10000
```

如果用户已经有同名 key，值可能是字符串或数组。安装器要把它规范成数组并追加自己的命令，卸载时只移除完全匹配的那一项。

**TOML 编辑策略**：

- 用 UTF-8 显式读写，禁止经过 Windows PowerShell 5.1 默认编码。
- 写入前备份 `config.toml.bright-drift.bak`。
- 优先实现保留注释的行级编辑器：定位 `[hooks]` 段，逐行解析 key，不重排其他内容。
- 如果 `[hooks]` 不存在，在文件末尾追加。
- 写入用原子 rename，Windows 上对瞬时 EPERM 重试。
- 自检时重新解析 TOML，确认结构合法。

不建议用「解析后整文件 stringify」的方案，除非能接受用户注释丢失。也不建议用环境变量覆盖，因为那要求用户换启动方式。

### 5.8 渲染与预算

直接复用 `renderInjection`，不新增平台文案。需要做三处适配：

1. **字节上限**：feedback 通道按 UTF-8 字节截断，而不是字符数。core 当前按 token/行预算，adapter 在输出前做最后一道 `truncateUtf8Bytes`。
2. **无绝对时间戳**：Jcode 会 resume/compact 并重放历史，绝对时间会陈旧误导。core 当前渲染没有时间戳，保持。
3. **D 类静默**：沿用 `formatterSilent`。

### 5.9 fail-open

所有 hook：

```ts
try {
  await main();
} catch {
  // 不写 stdout，exit 0
}
```

`pre_tool` 永远 exit 0，除非未来明确要做策略拦截。`post_tool_feedback` 超时或异常时不输出，Jcode 继续。daemon 起不来时，hook 只写一个日志并退出，不影响会话。

---

## 6. 关键设计细节

### 6.1 at-most-once

feedback 通道的确认点是「batch 被唯一 claim」。同一 batchId 只能被一个 hook claim，claim 成功后不会再回到 pending。实现顺序：

1. `pending/<sid>.json` 存在。
2. hook 读取并校验 `batchId`。
3. 原子 rename 到 `pending/<sid>.<batchId>.inflight`。rename 成功者获得投递权，其他 hook 看不到这个 batch。
4. 打印文本到 stdout。
5. 写 `delivered/<batchId>.json`，内容包含 `deliveredAt`、`channel: "feedback"`。
6. daemon 看到 delivered 后提交 AKB 基线并删除 inflight。

如果第 4 步之后、第 5 步之前进程被杀，inflight 会被标记为 `abandoned`，**不会**回到 pending。基线没有提交，冷启动对账会以新的 batchId 重新检测并投递。这样同一个 batchId 最多投递一次，符合 at-most-once 红线；代价是极窄的崩溃窗口里模型可能看到两次相似的事实陈述，但第二次属于新批次，不是同一 batch 的重复注入。

如果希望连内容重复也尽量避免，可以在 claim 后、打印前写一个 `attempted` 标记，并把「是否提交基线」与「是否已打印」分开记录。但这会引入更复杂的状态机，MVP 不建议。

bridge 通道的确认点更明确：

- `noReply`: `sendMessage` 返回成功，即 `ContextMessageAdded`。
- `softInterrupt`: 收到 `SoftInterruptInjected` 且 `client_ids` 包含 batchId。
- 如果 `TurnDone.pending_soft_interrupts` 表明未投递，下一轮重试或改走 `noReply`。

### 6.2 并行工具调用

Jcode 支持并行工具调用。多个 `post_tool_feedback` 可能同时运行。原子 rename 保证只有一个 hook 拿到 batch。没抢到的 hook 输出空字符串，Jcode 不追加任何内容。

`post_tool` 的 AKB 观察也并发，daemon 的 mailbox 消费者要按 `toolCallId` 去重，并按消息时间戳处理。AKB 的最终状态是「最后一次观察」，顺序不重要；归因窗口按 `toolCallId` 匹配，乱序到达时以消息内时间戳重排。

### 6.3 后台 bash

`bash` 的输入字段是 `run_in_background`，不是 `background`。源码：`crates/jcode-app-core/src/tool/bash.rs:815-838`。

后台命令的 `post_tool` 在「任务已启动」时就会触发，不代表命令结束。因此：

- `pre_tool` 看到 `run_in_background: true` 时，开一个 `background: true` 的窗口。
- `post_tool` 不关闭这个窗口。
- 窗口内所有漂移都归因为 ambiguous-external，消息中注明「后台任务」。
- 如果后续 `bg wait` 或 `turn_end` 能确认任务结束，可以选择关闭窗口，但默认不依赖。

这与 D5 的「后台任务生命周期无界」一致，代价是后台任务期间外部修改也会被标为歧义，属于保守方向。

### 6.4 Windows cmd.exe

建议分两步：

1. **MVP**：Windows 上 `watch.includeUntracked: true`，避免 cmd 新建的未跟踪文件被 created-gate 抑制。静态分析返回空 predicted paths，归因仍能按窗口判 B/C。
2. **core 增强**：新增 `analyzeCmd`，至少识别：
   - `>`、`>>`、`2>`、`&>` 重定向
   - `copy`、`xcopy`、`robocopy`、`move`、`ren`
   - `del`、`erase`、`rmdir`、`mkdir`、`md`
   - `echo ... > file`、`type ... > file`
   - `powershell -Command` 嵌套时回退到保守 C 类

`Attributor` 的 `ShellWindow.shell` 类型需要从 `'bash' | 'pwsh'` 扩展为 `'bash' | 'pwsh' | 'cmd'`。这是 core 的加法改动，对其他 adapter 无影响。

### 6.5 性能

本机实测 Node 冷启动约 103ms。如果 `pre_tool`、`post_tool`、`post_tool_feedback` 都配置成 Node 脚本，每次工具调用可能增加 200 到 300ms，这是不可接受的。

建议：

1. **`pre_tool` 只对 bash 付出 Node 成本**。用一个跨平台 shim 先判断 `JCODE_HOOK_TOOL_NAME`：
   - POSIX：`/bin/sh -c 'case "$JCODE_HOOK_TOOL_NAME" in bash) exec node "...";; esac'`
   - Windows：`cmd.exe /D /S /C "if /i "%JCODE_HOOK_TOOL_NAME%"=="bash" (node "...") else exit /b 0"`
   shim 启动估计约 5 到 15ms，非 bash 工具不受影响。Windows 上 cmd.exe 的嵌套引号规则容易出错，具体命令要在实现时用 hook 解析器测试固定，不要直接照抄上面的示意。
2. **`post_tool_feedback` 只在有 pending 时付出 Node 成本**。daemon 在写 pending 时同时创建一个 `pending/<sid>.flag`。shim 先检查 flag 是否存在，不存在直接退出。这样大多数工具调用只付 shim 成本。
3. **`post_tool` 的 AKB 观察**可以接受 detached 的 Node 成本，因为它不阻塞工具返回。但如果工具调用非常密集，仍会占 CPU。更彻底的方案是：
   - 用 bridge 的事件流替代 `post_tool`，零 hook 进程。
   - 或提供一个原生小助手（Rust/Go 单文件），负责把 hook 事件转发给 daemon。代价是跨平台二进制分发。
4. **MVP 先测再说**。如果实测工具调用间隔远大于 100ms，可以接受 `post_tool` 的 Node 成本；如果不可接受，再上 shim 或原生助手。

建议在报告落地时增加一个 perf 门：`pre_tool` 非 bash 早退小于 20ms，`post_tool_feedback` 无 pending 早退小于 20ms，有 pending 小于 300ms。

### 6.6 子代理与 swarm

Jcode 的 swarm worker 是独立 session，会触发 `session_start` 和工具 hooks。adapter 需要决定是否向子代理注入漂移。

建议：

- 默认 `inject.includeSubagents: true`，因为子代理也会读写文件，漂移对它有价值。
- 如果噪声过大，改为只向用户可见的顶层会话注入。判断依据可以来自 bridge 的 `SessionInfo`，但 hook 本身没有 parent 字段。
- 每个 session 独立 AKB，避免子代理的读污染主会话的基线。
- 同一工作区共享 watcher，避免 N 个 worker 开 N 个 chokidar。

### 6.7 恢复、compact 与历史重放

Jcode 支持 resume、fork、compact。注入文本必须：

- 不含绝对时间戳，只用「自上次同步点以来」这类相对表述。
- 不依赖某条消息一定还在历史里。
- batchId 只用于投递门控，不写进面向模型的文本。
- compact 之后，旧注入可能被摘要。下一次漂移注入仍然基于 AKB 的当前基线，不依赖旧文本。

### 6.8 安全与隐私

- hook 只记录路径、哈希、计数，不记录文件内容。
- content-store 位于 `$JCODE_HOME/state/bright-drift/`，不进仓库。
- 不发起网络请求。bridge 通道只连本机 owner-only socket/named pipe。
- 安装器修改 `config.toml` 前备份，使用 UTF-8 原子写，禁止 PowerShell 5.1 默认编码往返。
- hook 命令使用绝对路径并正确引用，避免工作目录或 PATH 劫持。
- 不在配置里放任何密钥。

---

## 7. 测试矩阵

| 编号 | 场景 | 断言 |
|---|---|---|
| J1 | 安装器合并 `[hooks]` | 保留注释、CRLF、非 ASCII；用户已有 hook 不丢；重复安装幂等 |
| J2 | 卸载 | 只删自己的命令；空 `[hooks]` 段处理正确；`--purge` 才删状态 |
| J3 | `session_start` 注册 | daemon 幂等拉起；workspace hash 稳定；断链/reattach 不重复注册 |
| J4 | `session_end` 注销 | AKB 保存；pending 处理符合预期；daemon 空闲自退 |
| J5 | `read` 观察 | AKB 记录读路径；目录被过滤；工作区外路径被忽略 |
| J6 | `write` / `edit` 观察 | 成功写入后 AKB 更新；自身写入不被报为外部 |
| J7 | `apply_patch` | 多文件、删除、移动路径都被提取；失败补丁不更新 AKB |
| J8 | 前台 bash | 开窗、关窗、B 类；长命令转 ambiguous-external |
| J9 | 后台 bash | 窗口不关闭；漂移标为 background ambiguous |
| J10 | Windows cmd 归因 | 无 `analyzeCmd` 时 includeUntracked 生效；有分析器时 predicted paths 正确 |
| J11 | feedback 投递 | 有 pending 时输出一次；无 pending 时零输出；8KB 截断 |
| J12 | 并行工具调用 | 原子 claim；只有一个 hook 输出；无重复 batch |
| J13 | inflight 崩溃恢复 | inflight 不回到 pending；标为 abandoned；冷启动对账以新 batchId 重新检测；不重复提交已 delivered 基线 |
| J14 | 纯问答轮 | 记录已知缺口；bridge 开启时能注入 |
| J15 | bridge 空闲注入 | `noReply` 成功；`ContextMessageAdded`；不启动模型 turn |
| J16 | bridge 忙碌注入 | `softInterruptWithId`；`soft_interrupt_injected` 携带 batchId；未投递时补偿 |
| J17 | 子代理/swarm | 每 session 独立 AKB；共享 watcher；不串会话 |
| J18 | fail-open | hook 崩溃、Node 缺失、配置损坏、超时都不影响 Jcode 会话 |
| J19 | 版本不兼容 | `jcode version --json` 低于测试范围时 doctor 警告；hook 仍 fail-open |
| J20 | 性能 | 非 bash 早退小于 20ms；无 pending feedback 早退小于 20ms；10 万文件仓库 watcher 不崩 |

端到端验收建议：

- 在临时 `JCODE_HOME` 和临时工作区中安装，使用 `jcode --quiet run` 触发一次带工具调用的回合。
- 用本地 mock provider 或低成本模型，避免 CI 依赖付费请求。
- 验证 transcript 中工具结果包含 `[post_tool_feedback]`，且模型下一轮能看到漂移文本。
- Windows 上单独跑一遍 cmd.exe 场景和 named pipe 场景。

---

## 8. 里程碑与工作量

| 里程碑 | 内容 | 预估 |
|---|---|---|
| M7.0 | 预研、源码核实、方案定稿 | 已完成，本报告 |
| M7.1 | hooks-only MVP：包骨架、daemon、mailbox、pending、feedback、installer、J1-J14 | 1.5 到 2 周 |
| M7.2 | 可选 bridge 通道：SDK 连接池、空闲/忙碌状态机、at-most-once、J15-J16 | 1 周 |
| M7.3 | 上游 `before_request` hook：Rust 实现、测试、Jcode PR、adapter 切换 | Jcode 侧 1 周，adapter 侧 0.5 周 |
| M7.4 | 文档、发布、三包版本对齐、回归 | 0.5 周 |

如果只做 MVP，2 周可以交付可用版本。如果要达到与 dsh 一期等价的覆盖，需要 M7.1 + M7.3，总计约 3.5 周。M7.2 是可选项，除非产品要求在没有上游改动的情况下覆盖纯问答轮。

---

## 9. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| 没有 user-prompt/before-request 注入点 | 纯问答轮漏注入 | MVP 接受；推动上游 `before_request`；或启用 bridge |
| Node hook 启动约 100ms | 工具调用变慢 | shim 早退、flag 文件、只对 bash/有 pending 时启动 Node |
| Windows cmd.exe 无静态分析 | 新建未跟踪文件漏报 | MVP 开 `includeUntracked`；core 增加 `analyzeCmd` |
| TOML 安装器改坏配置 | 用户 Jcode 无法启动 | 备份、UTF-8 原子写、行级编辑、安装后重新解析、doctor |
| `post_tool_feedback` 8KB 上限 | 大 diff 被截断 | core 预算 + 字节级截断 + 清单降级 |
| 上下文保护拒绝工具输出 | feedback 可能丢失 | 在渲染时限制大小；必要时拆批；记录日志 |
| bridge 需要常驻 | 用户配置成本 | 默认关闭；`bridgeAutoStart` 可选；doctor 明示 |
| Windows SDK 未 live 验证 | bridge 通道不稳定 | MVP 不依赖；bridge 标为 experimental |
| `no_reply` 消息在历史中可见 | 体验噪音 | 文本用 `<system-reminder>` 包裹；优先 feedback；上游加 display role |
| 并行工具调用竞争 | 重复或丢批次 | 原子 rename + inflight 回收 |
| 子代理注入噪声 | 上下文膨胀 | `includeSubagents` 开关；按 session 隔离 AKB |
| Jcode 预 1.0 API 变化 | hook 契约变化 | 版本检测、doctor、fail-open、CI 固定版本 |
| Jcode 更新后旧 daemon 跑旧代码 | 行为不一致 | 安装器 stop daemons；doctor 检查版本；daemon 自报版本 |

---

## 10. 上游建议（Jcode）

### 10.1 `before_request` hook

建议在 `[hooks]` 增加：

```toml
[hooks]
before_request = "~/bin/bright-drift-before-request"
before_request_timeout_ms = 250
```

契约：

- 在每次模型请求迭代前同步运行，位置在 `messages_for_provider()` 之前。
- 环境变量：`JCODE_HOOK_EVENT=before_request`、`JCODE_HOOK_SESSION_ID`、`JCODE_HOOK_CWD`、`JCODE_HOOK_MODEL`、`JCODE_HOOK_STEP`（本轮第几次请求）。
- stdin：JSON，包含 `session_id`、`cwd`、`step`、`model`。
- stdout：要追加的文本。空输出表示不注入。
- 失败、超时、非零退出都 fail-open，不注入，只记日志。
- 注入方式：追加一条 `Role::User` 的 `<system-reminder>` 消息，`display_role = System`，不改变系统提示前缀。
- 多个 hook 按声明顺序运行，输出拼接，总长度设上限（例如 16KB）。

实现坐标：

- streaming 路径：`crates/jcode-app-core/src/agent/turn_streaming_mpsc.rs:112-117`。
- non-streaming 路径：`crates/jcode-app-core/src/agent/turn_loops.rs:107-111`。
- 追加 system reminder：`crates/jcode-app-core/src/agent/turn_execution.rs:211-227`。
- 配置：`crates/jcode-config-types/src/lib.rs:916-963`。
- hook 实现：`crates/jcode-base/src/hooks.rs`。

这个 hook 对 Jcode 其他集成也有价值，不只是 bright-drift。

### 10.2 `InjectContext` API 请求

如果上游不想加 hook，可以给 harness API 增加：

```
req: "inject_context"
session_id, content, display_role: "system" | "user" | "background_task"
```

语义与内部 `append_context_message` 一致，但允许指定 display role，并在忙碌时返回明确状态。这样 bridge 通道就能做到隐藏注入，不需要软中断的用户消息语义。

### 10.3 把 `notify_session` 的能力暴露到 harness API

内部 `Request::NotifySession` 已经支持 `SoftInterruptSource::System`，可以注入 system 角色的消息。但它只在内部协议里，harness API 没有暴露。暴露一个受控版本，比让第三方直接连内部 socket 更安全。

### 10.4 项目级 hooks

当前 hooks 只能全局配置。如果支持 `<repo>/.jcode/config.toml` 的 hooks 覆盖，bright-drift 安装会更轻，用户也可以按项目开关。这个不是 MVP 阻塞项，但值得提。

---

## 11. 结论

Jcode 的 hooks 体系足够支撑一个可用的 bright-drift adapter。`post_tool_feedback` 是目前最好的无侵入注入通道，语义接近 CC 的 Stop 补投，适合先做 MVP。它的主要缺口是纯问答轮无法注入，这个缺口可以用上游 `before_request` hook 彻底解决，改动量可控，且对 Jcode 生态有普遍价值。`jcode api-bridge` 可以作为过渡方案，但不应该成为默认依赖。

建议的决策：

1. **先做 M7.1 hooks-only MVP**，用真实使用验证注入频率、噪声和性能。
2. **同时向上游提 `before_request` hook**，把它作为三期的主通道目标。
3. **bridge 通道默认关闭**，等上游 `InjectContext` 或 Windows SDK 验证后再考虑默认开启。
4. **core 增加 cmd 归因分析**，这是 Windows 上 Jcode 适配的硬需求，不是可选优化。

只要接受 MVP 阶段「纯问答轮可能漏一次」的取舍，这个 adapter 可以在两周内交付可用版本。

---

## 附录 A：关键源码坐标

| 主题 | 坐标 |
|---|---|
| hook 总览与常量 | `crates/jcode-base/src/hooks.rs:1-46` |
| hook 事件到配置 | `crates/jcode-base/src/hooks.rs:105-127` |
| observer 分发 | `crates/jcode-base/src/hooks.rs:342-376` |
| `pre_tool` gate | `crates/jcode-base/src/hooks.rs:378-499` |
| `post_tool_feedback` | `crates/jcode-base/src/hooks.rs:501-597` |
| hook 环境变量 | `crates/jcode-base/src/hooks.rs:292-305` |
| 会话生命周期 hook | `crates/jcode-app-core/src/agent.rs:1269-1283` |
| `turn_start` hook | `crates/jcode-app-core/src/agent/turn_execution.rs:279-297` |
| 用户消息追加 | `crates/jcode-app-core/src/agent/turn_execution.rs:229-277` |
| system reminder 追加 | `crates/jcode-app-core/src/agent/turn_execution.rs:211-227` |
| 工具执行与 hook 顺序 | `crates/jcode-app-core/src/tool/mod.rs:970-1125` |
| touched paths | `crates/jcode-app-core/src/tool/mod.rs:673-744` |
| post_tool 字段 | `crates/jcode-app-core/src/tool/mod.rs:811-851` |
| feedback 追加 | `crates/jcode-app-core/src/tool/mod.rs:878-905` |
| batch 子调用 | `crates/jcode-app-core/src/tool/batch.rs:218-305` |
| bash 输入 | `crates/jcode-app-core/src/tool/bash.rs:815-838` |
| Windows cmd.exe | `crates/jcode-app-core/src/tool/bash.rs:650-665` |
| `SendMessage` | `crates/jcode-harness-api/src/requests.rs:90-103` |
| `SoftInterrupt` | `crates/jcode-harness-api/src/requests.rs:126-140` |
| `no_reply` 处理 | `crates/jcode-app-core/src/server/client_lifecycle.rs:1172-1192` |
| `append_context_message` | `crates/jcode-app-core/src/server/client_lifecycle.rs:3354-3383` |
| `SoftInterruptInjected` | `crates/jcode-harness-api/src/events.rs:208-232` |
| TS SDK `noReply` | `sdk/typescript/src/client.ts:191-201`、`581-634` |
| TS SDK `softInterrupt` | `sdk/typescript/src/client.ts:694-720` |
| Jcode home | `crates/jcode-storage/src/lib.rs:163-170` |
| 配置路径 | `crates/jcode-base/src/config/config_file.rs:15-19` |
| `HooksConfig` | `crates/jcode-config-types/src/lib.rs:916-963` |
| 文档 | `docs/HOOKS.md`、`docs/WRAPPERS.md`、`docs/SYSTEM_PROMPT_CONFIG.md` |

## 附录 B：Jcode 工具名清单（与归因相关）

| 名称 | 类别 | 备注 |
|---|---|---|
| `read` | 读 | `file_path` |
| `write` | 写 | `file_path` |
| `edit` | 写 | `file_path` |
| `apply_patch` | 写 | `patch_text`，支持多文件 |
| `bash` | shell | POSIX bash，Windows cmd.exe |
| `ls` | 读目录 | `path`，忽略 |
| `agentgrep` | 读 | `path`/`paths`，目录忽略 |
| `open` | 读/系统 | `target`，URL 忽略 |
| `batch` | 复合 | 子调用各自触发 hook |
| `codemode` | 复合 | 通过 registry 调用时触发 hook |
| `bg` | 后台任务 | 不是 shell |
| `computer` | GUI | 保守归因 |
| `browser` | 浏览器 | 保守归因 |
| `mcp__*` | MCP | 有 touched paths 才跟踪 |

## 附录 C：本报告没有覆盖的事项

- Jcode 桌面端与移动端的会话发现细节。
- Jcode 的 permission 系统与 hook 的精确先后顺序（不影响窗口开关，但值得在实现时实测）。
- Jcode 的 `codemode` 沙箱是否允许直接访问文件系统。
- Jcode `computer` 工具在桌面编辑器中的实际写文件路径。
- bridge 在 Windows named pipe 上的长连接稳定性。
- Jcode 未来是否会把 hooks 改为插件 ABI。

这些应在 M7.1 的实现阶段用实测补齐。

## 附录 D：沙盒实测记录（2026-10-19）

### D.1 环境

- 隔离 `JCODE_HOME`：临时目录，配置只包含 `[display] debug_socket = true` 与 `[hooks]`。
- 隔离工作区：临时目录。
- 启动方式：`jcode serve --socket <temp>/jcode.sock --debug-socket -C <temp>/workspace`。
- 触发方式：`jcode debug --socket <temp>/jcode.sock -S <session_id> tool "write {...}"` 与 `tool "read {...}"`。
- hook 脚本：Node 脚本，记录 `JCODE_HOOK_*` 环境变量和 stdin，并对 `post_tool_feedback` 输出 `FEEDBACK_MARKER`。
- 未向真实 `~/.jcode` 写入任何内容，测试后已删除临时目录。

### D.2 观测到的行为

1. `session_start` 在 `create_session` 后触发，携带正确的 `JCODE_HOOK_SESSION_ID` 和 `JCODE_HOOK_CWD`。
2. `pre_tool` 在 `write` 和 `read` 前触发，携带 `JCODE_HOOK_TOOL_NAME`、`JCODE_HOOK_TOOL_INPUT`，完整输入同时出现在 stdin。
3. `post_tool` 在工具成功后触发，携带 `JCODE_HOOK_STATUS=ok`、`JCODE_HOOK_TOUCHED_PATHS`（绝对路径）和 `JCODE_HOOK_TOOL_INPUT`。`post_tool` 的 stdin 为空，符合源码语义。
4. `post_tool_feedback` 在同一工具成功后触发，stdin 是完整工具输入 JSON。它的 stdout 被追加到工具结果，实际输出形如：

```
Created hello.txt (1 lines):
...

[post_tool_feedback]
FEEDBACK_MARKER
```

5. `JCODE_HOOK_PAYLOAD` 包含 `event`、`session_id`、`cwd`、`tool_name`、`tool_input`、`tool_call_id`、`touched_paths`、`status`、`duration_ms`、`output_bytes` 等字段，与报告中的字段表一致。
6. `read` 的 `touched_paths` 正确指向被读文件，`write` 的 `touched_paths` 正确指向写入文件。这说明 AKB 观察可以直接复用这两个事件。
7. 使用 `jcode server stop --force` 强制停止沙盒服务时，没有观测到 `session_end`。这与源码一致：`session_end` 只在正常关闭路径触发，崩溃或被强杀需要 daemon 的空闲清扫和冷启动对账兜底。
8. `[hooks]` 的数组形式可以正常解析。配置 `post_tool_feedback = [hook1, hook2]` 后，两个 hook 都运行，输出按声明顺序拼接。
9. `post_tool_feedback` 的单 hook 8KB 上限得到验证。hook1 输出 9000 个 `X`，工具结果里实际保留 8192 个 `X`，随后是 `[feedback truncated]`，再随后是 hook2 的 `HOOK2_END`。这与源码 `truncate_bytes(text, FEEDBACK_LIMIT)` 的行为一致。
10. 失败的工具调用不会触发 `post_tool_feedback`。`read missing.txt` 只产生了 `pre_tool` 和 `post_tool`（`status=error`）事件，没有 feedback 事件，工具结果里也没有 `[post_tool_feedback]`。

### D.3 这次实测没有覆盖的内容

- 真实模型 turn 下的注入时序。`jcode debug tool` 直接调用工具，不经过模型请求，因此只能验证 hook 契约和文本追加，不能验证「模型下一次请求看到」的端到端路径。
- `pre_tool` 的 exit 2 阻断语义。bright-drift 不使用该语义，未测试。
- `jcode api-bridge`、`noReply`、`softInterrupt` 在 Windows 上的实际行为。
- 并行工具调用下的 hook 竞争。`jcode debug tool` 是串行调用。
- 正常关闭会话时的 `session_end`。只验证了强制停止不会触发，未验证正常关闭路径。

这些仍是 M7.1 实现阶段需要补充的验收项。
