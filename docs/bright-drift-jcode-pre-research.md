# bright-drift Jcode adapter 预研报告

- 日期：2026-10-19
- 状态：**需求挂起，暂不实现**
- bright-drift 版本：`0.4.0`
- Jcode 实测版本：`v0.99.0 (774613c90)`
- Jcode 源码快照：`48aa83e`（2026-10-19）

## 0. 结论

Jcode 适配在技术上可行，现有 hooks 足以做出 MVP，但 `post_tool_feedback` 作为主注入通道不够优雅：它绑定工具调用，纯问答轮无法注入，工具失败或大输出被截断时也可能丢失。

要完整覆盖且保持优雅，需要以下之一：

1. Jcode 上游增加窄口径 `context_inject` hook，推荐。
2. 合入 #1280 的 `pre_request` transform。
3. 接受额外常驻 `jcode api-bridge`，用 `noReply` / `softInterrupt` 注入。

当前决定：**需求挂起**。不实现 adapter，不安装 hooks，不改用户配置。恢复条件见第 8 节。

## 1. Jcode 的官方扩展能力

Jcode 没有插件注册表、插件清单、`jcode plugin install` 或进程内插件 ABI。它的官方扩展面是 **lifecycle hooks**，本质是配置里挂外部命令。

| 扩展面 | 官方 | 能力 | 对 bright-drift 的适用性 |
|---|---|---|---|
| `[hooks]` | 是 | 观察 turn/session/tool，`pre_tool` 可拦截，`post_tool_feedback` 可回传文本 | 当前唯一可行的官方接入面 |
| `pre_tool_transform` | 是 | 改写工具输入 | 不适用 |
| MCP | 是 | 增加工具 | 可做诊断，不能主动注入 |
| Skills | 是 | 提示词级能力 | 不能携带动态漂移 |
| `AGENTS.md` / `prompt-overlay.md` | 是 | 静态系统提示 | 动态写入会破坏 KV cache |
| Spawn hook | 是 | 控制 headed session 位置 | 不适用 |
| SDK / harness API | 是 | 本地客户端 attach、发消息、软中断 | 可作为 bridge 注入通道 |
| 原生插件 ABI / 市场 | 否 | 无 | 不存在 |

关键 hook：

| 事件 | 同步性 | 用途 |
|---|---|---|
| `session_start` / `session_end` | observer | 注册/注销会话 |
| `turn_start` / `turn_end` | observer | 只能做信号，不能注入 |
| `pre_tool` | 同步 gate | 归因窗口开启、bash 预快照 |
| `post_tool` | observer | AKB 观察、窗口关闭 |
| `post_tool_feedback` | 同步 | stdout 追加到工具结果，当前唯一无上游注入通道 |

Jcode 没有 `user_prompt_submit` 或 `before_request`。`turn_start` 的 stdout 被丢弃。

## 2. 注入通道对比

| 方案 | 需要上游 | 需要常驻进程 | 覆盖纯问答轮 | 注入可见性 | 评价 |
|---|---|---|---|---|---|
| `post_tool_feedback` | 否 | 否 | 否 | 工具结果内 | MVP 可用，但不优雅 |
| `api-bridge` + `noReply` / `softInterrupt` | 否 | 是 | 是 | 目前是 user 角色 | 唯一无需上游的完整折中 |
| 窄口径 `context_inject` hook | 是 | 否 | 是 | 隐藏 system-reminder | **推荐长期方案** |
| #1280 `pre_request` transform | 是 | 否 | 是 | 可控制 | 通用但 review 面大 |
| #1549 `session_start_context` | 是 | 否 | 只覆盖会话开始 | 隐藏 | 适合静态概述 |
| 本地 provider proxy | 否 | 是 | 是 | 完全可控 | 重型，不推荐 |
| 内部 `notify_session` | 否 | 否 | 是 | system 角色 | 私有协议，不推荐 |

推荐路线：

- 短期：bridge 做完整覆盖，`post_tool_feedback` 仅作 bridge 不可用时的 fallback。
- 长期：上游窄口径 `context_inject`，去掉 bridge 和 post_tool 主路径。
- 不采用：MCP 主动调用、prompt overlay、PATH shim、内部私有 socket。

## 3. 窄口径 `context_inject` 的实现思路

配置：

```toml
[hooks]
context_inject = "~/bin/bright-drift-context"
context_inject_timeout_ms = 500
```

契约：

- 每个 provider 请求前同步运行。
- stdin：`{ session_id, cwd, model, step }`。
- stdout：纯文本，空输出不注入。
- 失败、超时、非零退出 fail-open。
- 单次上限 16KB，多命令按顺序拼接。
- 不允许改写 messages、tools、static system prompt，只能追加文本。

Jcode 侧改动：

1. `HooksConfig` 增加 `context_inject` 和 `context_inject_timeout_ms`。
2. `hooks.rs` 增加同步 runner，行为类似 `run_post_tool_feedback`，但不解析工具输入。
3. 两个 turn loop 在 `messages_for_provider()` 之前调用 hook。
4. 有输出时调用现有 `append_turn_system_reminder`，写入 `Role::User`、`display_role=System` 的 system-reminder。
5. 消息必须持久化。这样下一次请求的前缀仍包含旧 drift，只有尾部新增，避免 `prefix_changed` 和缓存失效。
6. 没有 drift 时 hook 返回空，不写任何消息。

bright-drift 侧：

- daemon 继续监听、归因、预算、渲染，写 `pending/<session_id>.json`。
- `context_inject` hook 只做读取 pending、原子 claim、打印文本。
- 安装器写入单引号 wrapper 路径。
- `post_tool_feedback` 保留为 fallback。

改动量估计 100 到 200 行 Rust 加测试，明显小于 #1280。

## 4. 推荐架构（如果恢复）

包名：`bright-drift-jcode`，npm 包 + CLI + daemon。

```text
packages/jcode/
├── src/
│   ├── daemon/        # watcher、AKB、归因、队列、渲染、mailbox
│   ├── hooks/         # session-start/end、pre-tool、post-tool、feedback/context
│   ├── installer/     # TOML 编辑、安装、卸载、doctor
│   └── shared/        # config、paths、atomic、mailbox、pending
├── build.mjs
└── package.json
```

数据流：

```text
Jcode hooks → mailbox → daemon → 漂移检测/归因/预算/渲染
                                      ↓
                               pending/<sid>.json
                                      ↓
                 context_inject 或 bridge 或 post_tool_feedback
                                      ↓
                              投递确认 → 提交基线
```

规则：

- 渲染不提交基线，投递确认后才提交，保持单 Sync Point。
- 一个会话同时只有一个 pending batch，新漂移合并进同一 batch。
- 并行工具调用用原子 rename claim，保证同一 batchId 最多投递一次。
- hook 崩溃、超时、配置损坏、Node 缺失都不能中断会话。

状态目录：

```text
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

## 5. 平台关键发现

### 5.1 Windows shell 是 cmd.exe

Jcode 的工具名在所有平台都叫 `bash`，但 Windows 上实际执行 `cmd.exe /D /S /C`，不是 PowerShell。

bright-drift core 目前只支持 `bash` / `pwsh` 静态分析。Windows 上需要：

- MVP 先开 `watch.includeUntracked: true`，避免 cmd 新建未跟踪文件被 created-gate 抑制。
- core 增加 `analyzeCmd` 和 `shell: 'cmd'`，覆盖重定向、`copy`、`move`、`del`、`mkdir` 等常见写入形式。

### 5.2 Hook 路径引用

实测结论：

- 双引号内的反斜杠会被 Jcode 的 hook tokenizer 当作转义符剥离。
- 带空格的绝对 Node 路径无法直接作为 hook 命令启动，日志报 `program not found`。
- 可用形态：
  - 首选：生成 `.cmd` / `.sh` wrapper，配置里用单引号包裹 wrapper 路径，单引号内保留反斜杠。
  - 次选：`node "C:/.../hook.js"`，要求 Node 在 PATH，脚本路径用正斜杠。
- 安装器必须保留 `[hooks]` 之后的所有表，不能像 Orca 早期实现那样在 uninstall 时误删后续表。
- Windows 上避免让 hook 弹出控制台窗口，wrapper 应使用 `windowsHide` / `CREATE_NO_WINDOW`。

### 5.3 Hook 行为

沙盒实测确认：

- `post_tool_feedback` 的 stdout 会以 `[post_tool_feedback]` 追加到工具结果。
- 单 hook 输出在 8192 字节处截断，并追加 `[feedback truncated]`。
- `[hooks]` 数组形式可用，多个 hook 按声明顺序执行。
- `pre_tool` 和 `post_tool_feedback` 超时都会 fail-open。
- 失败的工具调用只触发 `post_tool` status=error，不触发 `post_tool_feedback`。
- 非零退出码在正常退出时不影响 stdout 捕获；不要在 `process.stdout.write` 后立即 `process.exit`。
- 强制停止 Jcode server 不会触发 `session_end`，需要 daemon 空闲清扫和冷启动对账兜底。

### 5.4 KV cache

动态 prompt-overlay 会让每轮约 97K tokens 的静态前缀失效（#900）。漂移必须作为**尾部消息**注入，不能改系统提示、`AGENTS.md` 或 `prompt-overlay.md`。

`context_inject` 的注入消息要持久化，否则下一次请求的历史前缀会变化。

### 5.5 多会话

按 `session_id` 建 AKB，不能假设一个 Jcode daemon 只有一个会话。子代理和 swarm worker 会各自触发 hooks。默认可以注入子代理，必要时用配置关闭。

## 6. 上游相关工作

截至 2026-10-19：

| 编号 | 状态 | 内容 | 关系 |
|---|---|---|---|
| [#737](https://github.com/1jehuang/jcode/issues/737) | open | 原生 file/path watch primitive | 产品思路最接近，但偏 agent 主动 watch，无归因/diff |
| [#770](https://github.com/1jehuang/jcode/issues/770) | open | session_start 无法注入上下文 | 确认核心缺口，只覆盖会话开始 |
| [#1185](https://github.com/1jehuang/jcode/issues/1185) | open | pre_request transform 提案 | 每请求注入机制 |
| [#1280](https://github.com/1jehuang/jcode/pull/1280) | open PR | pre_request 实现 | 有 review 问题，尚未合并 |
| [#1549](https://github.com/1jehuang/jcode/pull/1549) | open PR | session_start_context | 适合静态概述，不适合 turn 内漂移 |
| [#900](https://github.com/1jehuang/jcode/issues/900) | open | prompt-overlay 每轮重读导致缓存失效 | 反例，必须尾部注入 |
| [#833](https://github.com/1jehuang/jcode/issues/833) | open | host-level shared state | 外部 watcher shim，非漂移检测 |

第三方 prior art：

- Orca 已合并 Jcode 集成（PR #22539，commit `4c2cb3c`），使用 managed hooks，并修复了单引号 wrapper 路径问题。Windows 只做代码审查，未真机验证。
- memor-ai 支持 jcode，但只把 `turn_end` / `session_end` 当 ingest，recall 走 MCP。它基于 v0.79.1，认为 Jcode 没有可注入 hook；v0.99.0 的 `post_tool_feedback` 已改变这个前提。
- Jcode 内置 swarm file touch notifications 只覆盖 swarm 内部 agent，不覆盖用户/外部进程修改。

没有发现与 bright-drift 完全重复的 issue 或 PR。

## 7. 沙盒验证摘要

已验证：

- `session_start` 触发并携带 session_id/cwd。
- `pre_tool` 携带 tool_name、tool_input、stdin。
- `post_tool` 携带 touched_paths、status、tool_input。
- `post_tool_feedback` 的 stdout 追加到工具结果。
- 8KB 截断和 `[feedback truncated]`。
- hooks 数组、超时 fail-open、非零退出、失败工具无 feedback。
- 带空格脚本路径、单引号 wrapper 路径。
- 强制停止不触发 `session_end`。

未验证：

- 真实模型 turn 下的注入时序。
- `jcode api-bridge`、`noReply`、`softInterrupt` 在 Windows 上的实际行为。
- 并行工具调用下的 hook 竞争。
- 正常关闭会话时的 `session_end`。

## 8. 挂起原因与恢复条件

挂起原因：

- `post_tool_feedback` 绑定工具调用，不适合作为正式主通道。
- bridge 方案需要额外常驻进程，且注入消息目前是 user 角色。
- 上游 `context_inject` 或 #1280 尚未落地。
- Windows cmd.exe 归因分析还需要 core 改动。

恢复条件，满足任意一条即可重新评估：

1. Jcode 合入窄口径 `context_inject` hook。
2. #1280 `pre_request` merge，且 review 问题解决。
3. 产品接受 `jcode api-bridge` 常驻和 user 角色注入。
4. 用户明确要求只做 `post_tool_feedback` fallback 版本。

## 9. 如果恢复的工作量

| 里程碑 | 内容 | 预估 |
|---|---|---|
| M7.1 | bridge 通道或 upstream context_inject PoC | 1 到 1.5 周 |
| M7.2 | daemon、AKB、归因、预算、渲染、安装器 | 2 周 |
| M7.3 | Windows cmd 分析、路径 wrapper、测试矩阵 | 1 周 |
| M7.4 | 文档、发布、三包版本对齐 | 0.5 周 |

总计约 4 到 5 周。若只做 `post_tool_feedback` fallback，约 2 周，但接受纯问答轮漏注入。

## 10. 关键源码坐标

| 主题 | 坐标 |
|---|---|
| hook 定义与 runner | `crates/jcode-base/src/hooks.rs` |
| `HooksConfig` | `crates/jcode-config-types/src/lib.rs:916-963` |
| `pre_tool` 调用 | `crates/jcode-app-core/src/tool/mod.rs:1062-1081` |
| `post_tool` 字段 | `crates/jcode-app-core/src/tool/mod.rs:811-851` |
| feedback 追加 | `crates/jcode-app-core/src/tool/mod.rs:878-905` |
| `turn_start` | `crates/jcode-app-core/src/agent/turn_execution.rs:279-297` |
| system reminder 追加 | `crates/jcode-app-core/src/agent/turn_execution.rs:211-227` |
| streaming turn loop | `crates/jcode-app-core/src/agent/turn_streaming_mpsc.rs:112-117` |
| non-streaming turn loop | `crates/jcode-app-core/src/agent/turn_loops.rs:107-111` |
| Windows cmd.exe | `crates/jcode-app-core/src/tool/bash.rs:650-665` |
| `SendMessage` no_reply | `crates/jcode-harness-api/src/requests.rs:90-103` |
| `SoftInterrupt` | `crates/jcode-harness-api/src/requests.rs:126-140` |
| SDK noReply | `sdk/typescript/src/client.ts:581-634` |
| SDK softInterrupt | `sdk/typescript/src/client.ts:694-720` |
| Jcode home | `crates/jcode-storage/src/lib.rs:163-170` |

## 11. 最终决策

**Jcode adapter 需求挂起。** 当前不进入实现，不修改用户 Jcode 配置，不发布 `bright-drift-jcode` 包。

保留本文档作为后续恢复的决策依据。若上游出现 `context_inject` 或 #1280 合并，再按第 3 节和第 4 节重新启动。
