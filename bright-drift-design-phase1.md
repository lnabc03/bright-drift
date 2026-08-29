# bright-drift 一期设计文档（DeepSeek Harness 插件）

| 项目 | 内容 |
|---|---|
| 文档版本 | v1.0 |
| 日期 | 2026-08-30 |
| 上游文档 | `bright-drift-PRD.md` v0.3（本文档不替代 PRD，是其一期部分的技术落地修订版） |
| 核实基准 | 本机 dsh 安装 `C:\Users\wjs_R\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh`（npm 发布包，含全部 `@deepseek-ai/dsh-*` 源码与 `.d.ts`）+ 运行时 Inspect Provider 目录 |
| 决策记录 | 见 §1.3（经逐题确认） |

---

## 1. 核实结论

### 1.1 总体判断

PRD 的技术路线**成立**：dsh 的 Cordis 事件体系提供了 PRD §4.1 所需的全部拦截点，且 payload 能力普遍**超过** PRD 的假设。但有 5 处事实修正和 3 处设计改进，本节逐一列出，正文设计均已按修正后的事实撰写。

### 1.2 勘误表（PRD → 实际）

| # | PRD 断言 | 核实结果 | 出处 |
|---|---|---|---|
| C1 | §1.2「DeepSeek Harness 无任何内置文件变更感知能力」 | **不准确。** dsh 已有 `dsh-fs-observation-policy`：read 前观察（`FS_NOT_OBSERVED`）+ 版本乐观锁（`FS_STALE_VERSION`， guarded write/edit 失配即拒绝），与 Claude Code 的 FileStateCache 写时防护等价。dsh 缺的是**主动感知与告知**（drift awareness），PRD 的差异化定位不变，但表述与「与平台关系」一节需修正 | `dsh-fs-observation-policy/README.md`、`dsh-fs` types |
| C2 | §4.1 `dsh plugin --profile <web\|headless\|cli> add github:owner/repo` | 实际命令为 `dsh plugin --profile <name> <pnpm args>`（转发 pnpm，故 `add github:owner/repo` 可行）。自动初始化的 profile 只有 `web` 与 `headless`，**无内置 `cli` profile**。分发形态：npm 包在 manifest 声明 `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`，patch 向 host composition 插入插件行 | `README.md`、`dsh-app-boot/README.md` §Profiles |
| C3 | §4.1 FR-1.2「以工具输入参数与工具结果推导写入后完整内容」 | write/edit 工具结果**不回显文件内容**（`formatWriteOutput` 明确 "no file content is echoed back"）。基线更新改为「工具成功后插件自行重读文件」（见 §5.2），更简单且不受 LF 归一化/歧义匹配影响 | `dsh-tool-fs` `write.d.ts`/`edit.d.ts` |
| C4 | §4.1 注入「append-only、不破坏 KV cache」 | 方向正确但需精确化：pre-step `enter` 决策里的消息会被**持久化**为会话日志的 `user/message`（`session.append("user/message", …)`），位于请求尾部，前缀缓存安全；代价是漂移消息会留存在历史中直至 compaction（与官方 time-context 插件相同语义，可接受） | `dsh-agent-loop/lib/index.js` L501–554 |
| C5 | §4.6 持久化按 `<workspace-hash>.json` 键控 | 改为按 **sessionId** 键控（见 §5.8）：AKB 语义是「这个 agent 认知的世界」，新会话在同一工作区应从空基线开始（否则会把别的会话的基线错当自己的）；跨会话 resume 保持同 sessionId，T7 场景不受影响。content-store 的 blob 全局共享 | 设计修订 |

### 1.2.1 核实中新发现的能力（PRD 未利用，设计采纳）

| # | 能力 | 设计采纳点 |
|---|---|---|
| F1 | `tools/result`（emit，冻结的最终结果）——官方 `dsh-agent-instructions` 插件即用此事件跟踪 read/write/edit 的文件触碰 | AKB 观察主通道（§5.2），替代 PRD 的 post-execute 独用方案 |
| F2 | `MessageSource` 的 `form` 词汇：`'notice'`（一件事的一次性通报，UI 折叠为一行，须带 ≤120 字符 `summary`）——比裸 `{kind:'plugin'}` 更贴合漂移通知 | 注入消息一律 `form:'notice'`（§5.5） |
| F3 | `agent.inject(message)`：不唤醒 driver、下一 step 边界领取——`agent/session-start` 文档明确推荐 | 保留为备用通道；主通道仍为 pre-step waterfall（§5.5） |
| F4 | `PostToolDecision.additionalContexts` / `ToolRunContext.deferContext`：工具结果后追加上下文（repeat-tool-reminder 先例） | 评估后**不采用**（保持单一注入路径与单一 Sync Point，见 §5.5.4） |
| F5 | `fs/observed`（emit）：read/write/edit 工具对目标的权威观察（present+version / absent） | AKB 版本信号的补充通道（§5.2.3） |
| F6 | `ctx.commands.register`：斜杠命令注册表，handler 返回文本直接渲染 | `/bright-drift` 命令族（§5.10） |
| F7 | `ctx.settings.register(ns, schema)`：用户级 settings 命名空间，schema 校验 + 热更新 + Web 设置 UI | 配置主通道（§5.9） |
| F8 | `ctx.timer`：debounce/throttle/interval，随 fiber 自动 dispose | watcher 防抖（§5.3） |
| F9 | 依赖树已含 `chokidar@4.0.3` 与 `diff@9.0.0` | 版本对齐声明（§5.11） |

### 1.3 决策记录（2026-08-30，逐题确认）

| # | 决策点 | 结论 |
|---|---|---|
| D1 | 挂载平面 | **Host 平面 Bundle**：npm 包声明 `dsh.bundle.patch`，`dsh plugin --profile web add bright-drift` 安装；单例插件在 root ctx 监听（dsh-scope 事件准入向上传播，未打标签的监听者接收所有 agent 的 scope 事件），按 `Agent` 对象 WeakMap 分键管理全部会话 |
| D2 | 配置通道 | **settings 命名空间 + 项目级覆盖**：全局默认 `~/.dsh/settings.yaml` 的 `bright-drift` 节（热更新、Web UI 可见）；插件自读 `<workspace>/.dsh/bright-drift.yml` 作为项目级覆盖，项目级优先 |
| D3 | 基线内容存储 | **内存副本 + 磁盘 content-store**：sha1 寻址 blob 落 `~/.dsh/state/bright-drift/blobs/`，容量上限 + LRU 清理；跨会话 resume 仍可行级 diff；content-store 被禁用/淘汰时按 PRD 原案降级为文件级提示 |
| D4 | 客户端 UI | 一期**纯 Host + 斜杠命令**；漂移状态面板留 v1.1 |
| D5 | FR-7 范围 | **前台 bash + pwsh 全做**（Windows 上 dsh 的 shell 工具是 `pwsh`，重定向/写入语法单独覆盖）；`run_in_background` 后台任务窗口存活期不定，一律标 ambiguous-external |
| D6 | M0 实测 | 本会话不做运行时实测；设计基于已核实的静态契约（`.d.ts` + 官方插件 README + agent-loop 源码），M0 保留运行时验证清单（§8.1） |

---

## 2. 一期范围（相对 PRD 的修订）

### 2.1 目标

G1–G5 全部保留，措辞修订两处：

- G2 归因类别在 dsh 平台上的工具名集合明确为：读类 `read`/`read_image`，写类 `write`/`edit`，shell 类 `bash`（非 Windows）/`pwsh`（Windows）。
- G4「零配置可用」的安装路径修订为：`dsh plugin --profile web add bright-drift`（或 headless profile 同理），bundle patch 自动挂载。

### 2.2 非目标

N1–N5 保留。补充：

- N6 一期不做 Client 端 Slot UI（D4）。
- N7 一期不追踪 `run_in_background` 后台任务的写盘归因（D5，标 ambiguous-external 兜底）。
- N8 一期不拦截/不防护写入——与 dsh 内置 `fs-observation-policy`（写时乐观锁）为互补关系，README 须明示（呼应 C1）。

---

## 3. 平台事实基线（设计依据，均含出处）

| 事实 | 出处 |
|---|---|
| `agent/pre-step`：waterfall，payload `{agent, messages, turn, step, signal}`，返回 `PreStepDecision = {kind:'reject'} \| {kind:'enter', messages}`；`enter` 批次在 `step/start` 后逐条 `session.append("user/message")` **持久化** | `dsh-agent` runtime-types.d.ts；`dsh-agent-loop/lib/index.js` L492–554 |
| turn 关闭边界：上一步无工具调用且本 pre-step 领取批次为空时 loop `break`；**向空批次追加消息会强制多跑一次模型请求** | 同上 L542–546 → 设计对策 §5.5.3 |
| `tools/pre-execute`：waterfall，决策仅 `allow/deny/ask`，不可改参数 | `dsh-tools` types |
| `tools/post-execute`：waterfall，`(exec, result, next)`，`exec` 含 name/深冻结 arguments/agent/signal；`result` 为 `ToolExecutionResult`（`value`/`content`/`additionalContexts`） | `dsh-tools` types |
| `tools/result`：emit，冻结终态，fire-and-forget | 同上 |
| `agent/session-start`：emit，`source: 'startup'\|'resume'\|'clear'\|'compact'`，文档明示用 `agent.inject()` 播种上下文 | `dsh-agent` runtime-types.d.ts |
| `agent/turn-stopping`：serial，turn 提交前 await | 同上 |
| `session/disposed`：emit | `dsh-session` |
| `Agent.inject(message)`：不唤醒，下一 step 边界领取；idle 时挂起至下次唤醒 | `dsh-agent-loop` agent.d.ts |
| 工作区根：`agent.session.header.cwd`（`dsh-agent-instructions` 先例）；兜底 `ctx.sandboxPolicy.workspaceRoot` | `dsh-session` types；`dsh-sandbox-policy` |
| 事件作用域：scope 事件准入向上传播；root（未打标签）监听者接收所有 agent 的事件；`this` 为 `Scoped<Agent>`，payload 携带 agent | `dsh-scope/README.md` |
| 注入消息 source：`{kind:'plugin', plugin:'bright-drift', form:'notice', summary}`，`summary` ≤120 字符 | `dsh-llm` message.d.ts |
| 官方先例插件：`dsh-time-context`/`dsh-tmux-context`（pre-step 追加 sourced UserMessage）、`dsh-repeat-tool-reminder`（post-execute + WeakMap 分键）、`dsh-agent-instructions`（tools/result 观察 + `ctx.fs` 可选消费 + `header.cwd`） | 各包 README |
| 分发：profile = `$DSH_HOME/profiles/<name>/`（`$DSH_HOME` else `~/.dsh`）；bundle = 声明 `dsh.bundle.patch` 的 npm 包；patch 支持 `insert` 加行 | `dsh-app-boot/README.md` |
| `dsh-settings-file`：`~/.dsh/settings.yaml`，命名空间节、原子写、watch 热更新、Web UI | `dsh-settings-file/README.md` |

---

## 4. 总体架构

```
┌─────────────────────── dsh Host 进程（bright-drift bundle 行，进程单例） ───────────────────────┐
│                                                                                                │
│  tools/result ────────┐                                                                        │
│  fs/observed（辅） ───┤──► BaselineStore（每 Agent 一份 AKB：内存副本 + content-store 引用）     │
│                       │         ▲                                                              │
│  chokidar watcher ──► Debounce ─┴─► DriftDetector ──► Attribution ──► DriftQueue（每 Agent）   │
│  （按 workspace root   (ctx.timer    │ 与 AKB 对账      │ A 抑制 / B 窗口 /   │                 │
│   去重共享，refcount）   300ms)      │ modified/deleted/ │ C 外部 / D 格式化    │                 │
│                                    │ created/renamed   │ + 置信度            │                 │
│  agent/pre-step ──► Injector ◄── DiffEngine ◄── BudgetController        ▼                     │
│  （waterfall，       │ 渲染 notice   unified diff   三级降级            （待注入）               │
│   prepend 监听，      │ 追加进 enter                                               │            │
│   先 next() 后追加）  └──── Sync Point：AKB 对账 + 清队列 ◄────────────────────────┘            │
│                                                                                                │
│  agent/session-start ──► Reconciler：磁盘全量扫描 vs 持久化 AKB（resume 场景）                   │
│  agent/turn-stopping ──► Persister：AKB 落盘（原子写）                                          │
│  session/disposed ─────► 清理 watcher 引用、最终落盘                                            │
│  /bright-drift 命令 ───► status / diff <path> / pause / resume                                 │
│  settings + 项目级 yml ─► ConfigResolver（项目级优先）                                          │
└────────────────────────────────────────────────────────────────────────────────────────────────┘
```

### 4.1 模块划分（monorepo）

| 包 | 模块 | 职责 | 平台相关性 |
|---|---|---|---|
| `bright-drift-core` | `baseline` | AKB 数据结构、sha1、content-store 读写、LRU | 平台无关 |
| 〃 | `watcher` | chokidar 封装、debounce、gitignore/内置忽略表 | 平台无关 |
| 〃 | `drift` | 漂移分类、rename 合并、对账算法 | 平台无关 |
| 〃 | `attribution` | A/B/C/D 判定、快照窗口状态机（**可序列化**，二期硬约束不变）、bash/pwsh 双语法浅层静态分析 | 平台无关 |
| 〃 | `diff` | unified diff 生成与截断（jsdiff） | 平台无关 |
| 〃 | `budget` | token/行数预算与降级阶梯 | 平台无关 |
| 〃 | `message` | 注入消息渲染（§5.6 协议） | 平台无关 |
| `bright-drift`（主包） | `dsh/adapter` | 事件绑定、inject 通道、settings/commands 注册、bundle patch | 一期 |
| （二期） | `claude-code/adapter` | CC hooks + daemon | 二期 |

核心引擎平台无关化仍是第一优先级架构约束；`attribution` 窗口状态机可序列化要求不变（PRD §6.2-5）。

---

## 5. 核心机制设计

### 5.1 AKB 2.0（修订 PRD §3.1）

```ts
AKB[path] = {
  contentHash: string,        // sha1
  contentRef?: string,        // content-store blob 键（= contentHash）；缺省表示无内容副本
  mtimeMs: number,
  size: number,
  source: 'read' | 'write',
  partial?: boolean,          // read 带 offset/limit 截断时标记（FR-1.1）
  knownDeleted?: boolean,
  updatedAt: number,
  lastToolCallId?: string,    // 最后一次建立基线的工具调用（D 类判定用）
}
```

- **键控**：`WeakMap<Agent, Map<path, Entry>>` + 持久化按 sessionId（C5）。
- **内容副本**：内存 LRU（默认 200 文件）+ 磁盘 content-store（默认上限 256MB，LRU 清理；`baseline.persistContent: false` 可关）。淘汰顺序：内存先淘汰（落盘仍在），磁盘淘汰后该文件 diff 降级为文件级。
- 容量上限、LRU 淘汰语义同 PRD FR-1.4（默认 5000 条目）。

### 5.2 观察与基线更新（修订 FR-1）

#### 5.2.1 主通道：`tools/result`

官方先例（`dsh-agent-instructions`）证明该通道可靠。监听 `tools/result`（emit），过滤 `exec.agent` 存在且 `result.isError === false` 的调用：

| 工具 | 动作 |
|---|---|
| `read` | 取 `arguments.file_path`（+`offset`/`limit` 判 partial），**自行重读文件**计算哈希建立 `source:'read'` 基线；partial 时只记哈希不存内容副本（内容副本必须完整才有 diff 价值） |
| `read_image` | 同 read，恒 partial=true（二进制，不做 diff） |
| `write` / `edit` | 成功后**自行重读文件**建立 `source:'write'` 基线，内容副本入 content-store |
| `bash` / `pwsh` | FR-7 窗口关闭（见 §5.4.2） |

「自行重读」而非解析工具结果的原因（C3）：write/edit 结果无内容；read 结果是带行号的渲染文本，解析脆弱；插件在 Host 进程内直接 `fs.promises.readFile`，一次读取消耗可忽略。重读失败（文件恰被删除）→ 记 `knownDeleted`，不视为错误。

#### 5.2.2 嵌套调用

Code Mode（`run_code`）的子分派通过 `tool/code-dispatch` 事件桥接；`tools/result` 对子调用的可见性以 `parent` token 关联。一期策略：只观察**顶层** `tools/result`（子调用产生的写盘会经 watcher + FR-7 窗口归入 B 类，认知完整性不受损）。M0 验证项（§8.1）。

#### 5.2.3 辅助通道：`fs/observed`

read/write/edit 工具每次操作都会对目标发出 `present(version)`/`absent` 观察（actor 为工具 exec，含 `agent.session` 归属）。用途：

- `absent` 观察直接更新 `knownDeleted`，无需等 watcher；
- `present.version` 作为廉价的「版本未变」短路信号（与 AKB 记录的 version 一致则跳过重读——**注意 version 是不透明 token，只做相等性比较，不解析**）。

约束：`fs/observed` 的监听器必须同步、不得 throw、返回 promise 不被 await（官方契约）——只往里放同步记录，重读等异步工作转交队列。

#### 5.2.4 自变更排除（PRD §3.4 不变）

write/edit 成功 → AKB 立即更新为磁盘实际内容哈希 → watcher 回声事件对账一致 → 丢弃。精确内容级判定，无时间窗启发式。

### 5.3 watcher 与对账（FR-2 修订）

- **共享 watcher**：按 workspace root 去重，一个 root 一个 chokidar 实例，refcount 管理（多会话同 root 共享）；root 取自 `agent.session.header.cwd`（兜底 `ctx.sandboxPolicy.workspaceRoot`）。root 集合随 `agent/created`/`agent/disposed` 动态增删。
- debounce 300ms 用 `ctx.timer.debounce`（随 fiber 自动 dispose）；同路径连续事件保留最终态。
- 对账：事件路径规范化后与**所有持有该 root 的会话的 AKB** 比较；一致丢弃（回声），不一致进各会话的 DriftQueue。
- 忽略规则：`.gitignore` + 内置表（`node_modules`、`.git`、构建产物、`~/.dsh/state/bright-drift` 自身）+ 配置 `watch.extraIgnore`。
- 二进制（null 字节探测）与 >`diff.maxFileSizeKB`（默认 512KB）仅文件级上报；编辑器原子写以内容哈希为准，不产生误报（FR-2.4/2.5 不变）。
- symlink 不跟随 root 之外（E13 不变）。

### 5.4 归因（修订 FR-7/FR-8）

#### 5.4.1 类别与工具名集合（D5）

| 类别 | 触发源 | dsh 一期识别面 |
|---|---|---|
| A 工具写入 | `write`/`edit` 成功 | §5.2.4，零误差，完全抑制 |
| B 命令副作用 | `bash`（非 Win）/`pwsh`（Win）前台调用 | FR-7 快照窗口 |
| C 外部修改 | 排除 A/B/D 后剩余 | 核心上报通道 |
| D 格式化衍生 | write/edit 后 ~1s 内空白级 diff | FR-8 一行带过 |

#### 5.4.2 FR-7 快照窗口（修订点）

- `tools/pre-execute` 匹配 `bash`/`pwsh` 且 `run_in_background !== true`：对 AKB 全集 + 静态分析预测路径取快照（FR-7.5 成本约束不变：AKB >1000 文件时仅 mtime/size，哈希惰性）。
- **静态分析双语法**（D5）：bash 侧 `>`/`>>`/`tee`/`sed -i`/`-o`；pwsh 侧 `>`/`>>`（PowerShell 同样支持重定向）、`Out-File [-Append]`、`Set-Content`/`Add-Content`、`Tee-Object`。解析失败不报错，退回纯窗口归因。
- `tools/post-execute`（同一 exec）+ 1.5s grace 后二次快照归因。
- **后台任务**：`run_in_background: true` 的调用，命令结束后写盘仍在继续（Job 存活期不定）。一期不追踪 Job 生命周期；其 pre-execute 快照保留**但不关闭窗口**，窗口内变更一律标 `ambiguous-external`（措辞含命令原文与「后台任务」说明）——符合 §3.6 不对称偏向。
- 长命令（>10s）、歧义偏向、状态机可序列化：PRD FR-7.4/7.6 不变。

#### 5.4.3 FR-8 格式化衍生

不变（write/edit 后 `formatterWindowMs` 内、tokenize 后仅空白/标点差异 → D 类，一行带过，可配置静默）。

### 5.5 漂移注入（FR-3 修订，本文档改动最大的部分）

#### 5.5.1 主通道：`agent/pre-step` waterfall

按官方先例（time-context/tmux-context）的模式：**prepend 监听、先 `next()` 委托、下游决策为 `enter` 且有漂移待注入时，向返回批次尾部追加一条 sourced UserMessage**：

```ts
ctx.on('agent/pre-step', async (payload, next) => {
  const decision = await next();                          // 先委托，保下游语义
  if (decision.kind !== 'enter') return decision;         // 拒绝批次不动
  if (suppressClosingCheck(payload)) return decision;     // §5.5.3
  const queue = driftQueueOf(payload.agent);
  if (queue.isEmpty()) return decision;                   // 早退 <1ms（FR-3.2）
  const message = renderInjection(queue, budget, config); // §5.6
  return { kind: 'enter', messages: [...decision.messages, message] };
  // Sync Point 在渲染成功后立即执行（消息已进入持久化批次，
  // 即使后续请求失败也视同已同步——与 time-context 「记录 entered step」语义一致）
});
```

注入消息 source（F2）：

```ts
{
  kind: 'plugin',
  plugin: 'bright-drift',
  form: 'notice',
  summary: '工作区漂移：3 个文件变更（2 外部修改 / 1 命令副作用）'  // ≤120 字符，UI 折叠行
}
```

#### 5.5.2 Sync Point 时机

渲染成功且批次返回 = 已同步：AKB 对账为磁盘当前状态、队列清空。理由：dsh 在 `step/start` 后即持久化 `enter` 批次（C4），漂移消息已进入不可变的会话历史，即使模型请求随后失败，该事实也已送达 agent 的上下文——与 time-context 的语义对齐。同一变更不会注入两次（PRD §3.3 不变）。

#### 5.5.3 turn 关闭边界抑制（新机制，C4 衍生）

**问题**：turn 的最后，模型无工具调用收尾后，loop 会再做一次 pre-step 领取——批次为空即 `break` 关 turn。若此时向空批次追加漂移消息，会**强制多跑一次完整模型请求**（成本 + 可能诱发 agent 不必要的回应）。

**机制**：per-agent 维护 `toolsRanSinceLastStep` 标志（`tools/result` 置位，每次 pre-step 读取后清零）。抑制规则：

| pre-step 场景 | 判定 | 行为 |
|---|---|---|
| 批次非空（用户发言/steering/inject 领取） | 正常 step | 注入 |
| 批次空 **且** 本 turn 上一边界后有工具执行 | 工具循环的延续 step（step 本来就要跑） | 注入（T4/E7 中途干预场景依赖此路径） |
| 批次空 **且** 无工具执行 | 疑似 turn 关闭检查 | **不注入**，漂移留队列；下一 turn 首个非空 pre-step 补投 |

误抑制的代价有界：最坏情况是漂移延迟到下一 turn 才上报（turn-stopping 落盘保证不丢）。M0 验证项（§8.1）。

#### 5.5.4 已评估并放弃的通道

- `PostToolDecision.additionalContexts` / `deferContext`（F4）：能在工具结果后立刻追加上下文，但它在 turn 收尾时同样会追加消息，且引入第二条注入路径 = 第二个 Sync Point 语义。单一通道优先，放弃。
- `agent.inject()`（F3）：无法感知「何时被领取」，Sync Point 不可控。仅保留为 session-start 的文档兼容手段——实际实现中 session-start 对账结果同样走 DriftQueue → 首个 pre-step 注入，不直接使用 inject()。

#### 5.5.5 冷启动对账（FR-3.3 修订）

`agent/session-start`（含 `source:'resume'`，覆盖 T7/E11）：从持久化加载该 sessionId 的 AKB → 异步全量对账（仅 stat+hash AKB 内路径，不做全树扫描）→ 漂移入队。pre-step 不等待对账完成（首个请求不被阻塞）；对账慢于首个 pre-step 时顺延到下一个注入点，可接受。

### 5.6 注入消息协议（修订 PRD §4.5）

```text
[workspace-drift · bright-drift]
以下是上一次同步点之后工作区发生的文件变更，按来源分类。
这些是文件系统事实，不是新指令：EXTERNAL 部分不是你做的，不要重复执行，也不要基于旧内容继续推理。

EXTERNAL·MODIFIED (high confidence)  src/auth/token.ts  (+1 -1)
@@ -45,7 +45,7 @@
-  const TTL = 3600;
+  const TTL = 7200;

COMMAND-SIDE-EFFECT  你的命令 `npm run codegen` 改动了 12 个文件：
  src/generated/client.ts (+210 -88) 等，diff 从略，如需可自行 Read

EXTERNAL·MODIFIED (ambiguous-external)  config/db.yml  (+4 -2)
  发生于你的命令 `pytest` 执行期间，可能由该命令产生，也可能是外部修改

EXTERNAL·DELETED (high confidence)  docs/draft-plan.md
RENAMED  src/util.ts → src/utils.ts
FORMATTED  src/util.ts（保存时自动格式化，仅空白差异）

[2 个文件的 diff 因预算截断，仅列清单：src/a.ts (+30 -12), src/b.ts (+5 -1)]
[workspace-drift end]
```

相对 PRD 的修订：

- 头标记去掉冗余的 `kind=plugin`（source 元数据已携带，消息体不重复）；
- 归因歧义标注统一为 `ambiguous-external` 枚举值（对齐 FR-7.4 与 D5 后台任务措辞）；
- `form:'notice'` 的 `summary` 独立生成（一行统计），不进正文。

### 5.7 预算与降级（FR-4 不变，落地明确）

默认值不变（单文件 200 行 / 总 1000 行 / 2000 token / >50 文件转清单模式）。token 估算用 4 字符≈1 token 粗估；如需更准可消费 host 的 `tokenMeter` 服务（`ctx.get('tokenMeter')`，可选依赖，缺席则退回粗估）。

### 5.8 持久化（修订 PRD §4.6）

```
~/.dsh/state/bright-drift/
├── akb/<sessionId>.json      # AKB 快照：path → {hash, mtime, size, source, partial, contentRef}
└── blobs/<sha1前2位>/<sha1>  # content-store，全局共享，LRU（默认 256MB）
```

- 落盘时机：`agent/turn-stopping` + `session/disposed`；原子写（tmp+rename）。
- **sessionId 键控**（C5）：resume 保持同 id 命中；新会话从空基线开始（正确语义：它确实什么都没读过）。
- blob 按内容寻址，跨会话/跨 workspace 共享；`session/disposed` 后 AKB json 保留（供 resume），孤儿 blob 由 LRU 容量清理。
- 多会话并发同一工作区（PRD R6）：AKB 按会话隔离，天然无互相覆盖；watcher 共享只读。R6 降级为「已解决（一期语义内）」。

### 5.9 配置（修订 FR-5，D2）

**主通道**：`ctx.settings.register('bright-drift', schema)` → `~/.dsh/settings.yaml` 的 `bright-drift:` 节；schema 校验、热更新（`settings/updated` 事件即时生效）、Web 设置 UI 可见。

**项目级覆盖**：插件自读 `<workspace>/.dsh/bright-drift.yml`（chokidar 顺带 watch，变更即重读），逐字段覆盖全局值。

```yaml
# settings.yaml 节 / 项目级文件同构
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
baseline:
  maxEntries: 5000
  persist: true
  persistContent: true        # D3 新增：content-store 开关
  contentStoreMaxMB: 256      # D3 新增
inject:
  onSessionStart: true
  onPreStep: true
attribution:
  bashWindowGraceMs: 1500
  longCommandMs: 10000
  formatterWindowMs: 1000
  formatterSilent: false
```

### 5.10 命令与可观测性（FR-6 修订）

`ctx.commands.register({ name: 'bright-drift', … })`，handler 内解析 `rawInput` 子命令，返回 `{kind:'success', text}`（Web/headless 原生渲染）：

| 命令 | 行为 |
|---|---|
| `/bright-drift status` | 当前会话 AKB 规模、待注入队列、累计注入次数/token、watcher root 列表 |
| `/bright-drift diff <path>` | 预览该文件待注入 diff（受预算截断） |
| `/bright-drift pause` / `resume` | 暂停/恢复注入（watcher 与 AKB 维护不停，恢复后一次性补投累计漂移） |

日志：`~/.dsh/logs/bright-drift/<date>.log`（插件自建目录；dsh home 解析复刻 `$DSH_HOME || ~/.dsh` 规则，不依赖内部包）。内容同 PRD FR-6（哈希前后值，不含文件内容）。fail-open：所有事件监听体外层 try/catch，异常仅写日志（E10/G5 不变）。

### 5.11 技术选型（修订 PRD §4.7）

| 依赖 | 版本对齐 | 用途 |
|---|---|---|
| chokidar | ^4.0.3（与 dsh 依赖树一致） | 文件监听 |
| diff（jsdiff） | ^9.0.0（同上） | unified diff |
| schemastery（zod 语法） | 随 dsh | settings schema |
| 无原生依赖 | — | 安装秒级 |

---

## 6. 边界情况清单（修订 PRD §4.4）

E1–E15 全部保留，修订/新增如下：

| # | 场景 | 修订后预期行为 |
|---|---|---|
| E8 | partial read | AKB 记哈希但不存内容副本；modified 漂移恒为文件级提示（内容副本缺失时也走此降级，语义统一） |
| E14 | bash/pwsh 写文件 | FR-7 窗口归因 B 类；**pwsh 语法纳入静态分析**（D5） |
| E15 | 长命令窗口内变更 | ambiguous-external 不变；**后台任务（run_in_background）同此标注**（D5） |
| E16（新） | turn 关闭边界存在待注入漂移 | 不注入、不多跑请求；turn-stopping 落盘，下一 turn 首个 pre-step 补投（§5.5.3） |
| E17（新） | Code Mode（run_code）子调用写文件 | 顶层 tools/result 不含子调用写盘细节 → watcher + FR-7 窗口归 B 类兜底（§5.2.2） |
| E18（新） | content-store blob 被 LRU 淘汰 | 该文件 modified 漂移降级文件级 + `+a/-b` 统计（语义同 E8） |

---

## 7. 测试矩阵（修订 PRD §5）

T1–T10 保留，修订与新增：

| 场景 | 修订 |
|---|---|
| T7 跨会话 | 断言升级（D3）：resume 后 content-store 命中 → **行级 diff 注入**；blob 被淘汰时降级为文件级（两条断言） |
| T9 命令归因 | 分平台跑：POSIX 用 `bash`，Windows 用 `pwsh`（含 `Set-Content` 写入变体） |
| T11（新）turn 收尾抑制 | agent 完成无工具调用的收尾回答时队列有漂移 → 断言无额外模型请求；下一 turn 首步注入 |
| T12（新）notice 形态 | 注入消息 source 为 `{kind:'plugin', plugin:'bright-drift', form:'notice'}` 且 summary ≤120 字符 |
| T13（新）后台任务歧义 | `run_in_background` 命令写文件 → ambiguous-external 且措辞含「后台任务」 |

验收标准（PRD §2.3）相应修订：第 2 条「B 类归因准确率 ≥95%」的测试集明确为 T9（bash）+ T9′（pwsh）；其余不变。

---

## 8. 里程碑（修订 PRD §4.8）

### 8.1 M0 调研验证（第 1 周）——静态核实已完成，运行时验证已完成 5/6

本会话已完成的静态核实：§1.2 勘误表全部条目 + §3 事实基线（以 `.d.ts`、官方 README、agent-loop 源码为据）。**运行时实测结果**（2026-08-30，本会话内动态 Cordis 探针 `probe-1`）：

1. ✅ pre-step `enter` 追加消息端到端可见：探针在 step 85（空批次延续步）追加 notice 消息，持久化为 `user/message` 并被模型在下一步引用（标记回读成功）。`{prepend: true}` + 先 `next()` 后追加的官方模式（time-context）实测有效。
2. 🔶 §5.5.3 关闭边界：已实测确认「工具循环延续步批次为空」成立（step 85/86 均 `incoming:0, out:0`）；「turn 收尾的空批次 → break」尾部模式待本回合结束后复核 dump（观测探针 `pkg-3` 运行中）。
3. ✅ root ctx 未打标签监听者收到其他 agent 的 scope 事件：探针在 root 捕获到子代理（不同 sessionId）的 `agent/session-start` 与 `agent/pre-step`。注：本会话 subagent 后端两次首请求失败（对照实验证明与探针无关），属环境问题，不影响契约结论。
4. ✅（负向确认）本 preset 未挂载 `run_code`，`tools/result` 只覆盖顶层调用；`tools/code-dispatch-log` 存在但无 Code Mode 可触发 → §5.2.2 的「子调用归 B 类兜底」为本 preset 下的唯一路径，设计不变。
5. ✅ bundle patch 闭环：`dsh plugin --profile m0probe add <本地包>` 自动初始化 profile、manifest `dsh.profile.bundles` 增层、`--dump-config` 组合树出现 `# == bright-drift-m0-bundle-probe` 层横幅与 insert 行；`remove` 后行消失。insert 行语法以 `dsh-base/cordis.patch.yml` 为准（`- insert: [- id: …  name: …]`）。HMR 由 `watchUserPatches` 常驻（静态确认）。
6. ✅ settings 命名空间：函数式 schema `settings.register('bright-drift-m0', fn)` 注册成功并解析默认值；外部编辑 `settings.yaml` 后 `settings/document-updated`（revision+1）与 `settings/updated`（`source:"provider"`，解析值正确）同步触发，实测热更新延迟 **~96ms**；Web 设置 UI 数据源 `settings.describe()` 依赖注册表（注册成功即入列）。

**遗留复核项**：M0-2 的 turn 关闭尾部（空批次 pre-step → loop break）在下一回合 dump 确认后勾销。

### 8.2 后续里程碑

| 里程碑 | 内容 | 验收 |
|---|---|---|
| M1 核心引擎（第 1–2 周）✅ 2026-08-30 | `bright-drift-core` 七模块 + 单测（E1–E6、E12、E16–E18 全覆盖；bash/pwsh 静态分析用例） | 引擎单测全绿（113 用例 / 14 文件），脱离 dsh 可跑（commit `aac2c05`） |
| M2 dsh 集成（第 3 周） | adapter 绑定；FR-1~FR-4、FR-7（含 pwsh）全通；E7/E11/E14/E15/E16 端到端 | 真实会话演示三个痛点场景 + T9/T9′/T10/T11 |
| M3 打磨与发布（第 4 周） | settings + 项目级覆盖、/bright-drift 命令族、日志、文档、npm 发布（bundle patch 形态）、README 演示 | 陌生人 `dsh plugin --profile web add bright-drift` 10 分钟可用 |

---

## 9. 风险表（修订 PRD §8）

| # | 风险 | 等级变化 | 说明 |
|---|---|---|---|
| R1 | dsh payload 与文档不符 | 高 → **低** | 静态契约已全部核实（§3）；残余为 §8.1 六项运行时验证 |
| R3 | 注入打断长链条推理 | 中（不变） | 缓解不变；`form:'notice'` 折叠降低 UI 噪音 |
| R5 | 超大 monorepo watcher 性能 | 中（不变） | M1 压测 10 万文件仓库不变 |
| R6 | 多会话并发同工作区 AKB 互相覆盖 | 低 → **关闭** | AKB 按 sessionId 隔离 + watcher 共享只读（§5.8），一期语义内已解决 |
| R8 | B/C 归因误判 | 中（不变） | 不对称偏向不变；pwsh 纳入后覆盖面扩大，后台任务明确走歧义标注 |
| R9（新） | content-store 磁盘占用失控 | 低 | 容量上限 + LRU；`persistContent:false` 一键关停退回 PRD 原案 |
| R10（新） | 关闭边界抑制误判（continuation 被当作 closing）导致 mid-turn 漂移延迟一个 step | 低 | 延迟有界（下一注入点补投）；M0-2 实测 |

---

## 10. 分发与发布（修订 PRD §9.1）

- 仓库结构不变（monorepo：`packages/core` → npm `bright-drift-core`；`packages/dsh-adapter` → npm `bright-drift`）。
- **`bright-drift` 包的 bundle 形态**：

  ```
  bright-drift/
  ├── package.json        # "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
  ├── cordis.patch.yml    # 向 host composition insert bright-drift 插件行
  └── lib/…               # adapter + 打包的 core
  ```

- 安装：`dsh plugin --profile web add bright-drift`（headless 同理）；卸载 `remove` 即撤行。
- CI 补充：端到端在 CI 内启动 headless profile 跑 T1–T8/T11 可自动化子集（PRD 已述，profile 名修正为 `headless`）。
- README 必备修订（C1/C2 衍生）：与 dsh 内置 `fs-observation-policy` 写时防护的**互补关系**说明（它防覆盖，我们管感知）；安装命令用真实 profile 语义。

---

## 附录：本次核实的关键源码坐标

| 主题 | 路径 |
|---|---|
| 事件契约全集 | `node_modules/@deepseek-ai/dsh-agent/lib/types/runtime-types.d.ts`、`dsh-tools/lib/types/index.d.ts`、`dsh-fs/lib/types/types.d.ts` |
| pre-step 持久化语义 | `node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js` L492–560 |
| 消息 source/form 词汇 | `node_modules/@deepseek-ai/dsh-llm/lib/types/message.d.ts` |
| scope 事件传播 | `node_modules/@deepseek-ai/dsh-scope/README.md` |
| 写时防护（互补能力） | `node_modules/@deepseek-ai/dsh-fs-observation-policy/README.md` |
| 注入先例 | `dsh-time-context`、`dsh-tmux-context`、`dsh-repeat-tool-reminder`、`dsh-agent-instructions` 各 README |
| profile/bundle 分发 | `node_modules/@deepseek-ai/dsh-app-boot/README.md` §Profiles |
| settings 文件后端 | `node_modules/@deepseek-ai/dsh-settings-file/README.md` |
