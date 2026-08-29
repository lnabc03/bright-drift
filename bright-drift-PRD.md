# bright-drift —— 人机工作区上下文同步插件 PRD

| 项目 | 内容 |
|---|---|
| 文档版本 | v0.3（定稿。修订：项目正式定名 bright-drift） |
| 日期 | 2026-08-29 |
| 项目名称 | **bright-drift**（已定稿，语义与查重记录见 §9.2） |
| 许可证 | MIT |
| 一期平台 | DeepSeek Harness（dsh，开源 agent harness，Cordis 插件架构） |
| 二期平台 | Claude Code CLI |
| 三期平台（视情况） | Codex CLI、opencode |

---

## 1. 背景与问题定义

### 1.1 问题陈述

在 agent 辅助编程的工作区中，人与 agent 共同修改同一批文件。典型场景：

- agent 修改后，用户不满意，自行在编辑器中微调；
- 用户自行删除临时文件、废弃文档；
- 用户在外部终端执行脚本，批量改动了工作区文件；
- 用户切换 git 分支 / 回滚提交，工作区整体状态跳变。

agent 对这些**带外（out-of-band）修改完全无感知**，造成人机双方上下文不对称，表现为：

1. agent 在思考中对「某个文件怎么消失了」感到意外，浪费轮次排查；
2. agent 按旧认知继续推理，引用了已被用户改掉的值或函数，出错后才发现；
3. 更危险的情况：agent 用旧版本内容**覆盖**用户的修改（Anthropic 官方 issue #30427 与 OpenAI Codex issue #36717 描述的正是此类事故，两者至今均为 open 状态）。

目前的解法是用户显式口头告知「我改了/删了哪些文件」，成本全部转嫁给用户，且容易遗漏。

### 1.2 需求验证（截至 2026-08 的调研结论）

- **Claude Code** 仅有被动防护：Read/Edit 共享的 FileStateCache 会在写入时以 `File has been modified since read` 硬阻塞，防止覆盖；但这是写时乐观锁，不解决「agent 不知道文件变了/没了」的认知问题。其 `FileChanged` hook（v2.1+）支持 created/modified/deleted 且能感知外部编辑，但 matcher 只能按 basename 枚举、且存在插件注册后不触发的未修复 bug。
- **Codex** 无任何内置漂移检测，官方 issue #36717《Detect workspace drift before continuing stale plans》仍是 feature request。
- **DeepSeek Harness** 无任何内置文件变更感知能力，但其插件架构提供了全部必需的拦截点（见 §4.1）。
- 开源社区最接近的项目（如 claude-code-live-memory）只做到「文件变脏了」级别的提示，且为单平台；没有任何项目实现「**文件级增删 + 行级 diff，隐式注入下一轮模型请求**」的完整形态。

**结论：没有现成轮子，值得做，且各平台的钩子基础设施在 2026 年已经成熟。**

### 1.3 产品一句话定义

一个跨平台的 agent 插件：持续监控工作区，识别**用户（或任何外部进程）对文件的增删改**，在下一次模型请求前，将「文件级增删清单 + 预算内的行级 diff」隐式注入 agent 上下文，使人机双方对工作区的认知保持同步。

---

## 2. 目标与非目标

### 2.1 一期目标（DeepSeek Harness）

| 编号 | 目标 | 说明 |
|---|---|---|
| G1 | 认知同步 | agent 在任何外部文件变更发生后的**下一个模型请求**中即可获知，无需用户显式告知 |
| G2 | 带置信度的归因 | 变更按来源分为「工具写入/命令副作用/外部修改/格式化衍生」四类（§3.6），各有独立上报策略；归因不确定时如实标注，且永远偏向「外部」 |
| G3 | 信息充分且经济 | 文件级增删全量上报；行级 diff 在 token 预算内上报，超预算自动降级 |
| G4 | 零配置可用 | `dsh plugin add` 安装后默认行为即合理；高级行为可配置 |
| G5 | 不破坏 agent 主流程 | 插件任何内部错误不得中断 agent 会话（fail-open） |

### 2.2 非目标（一期明确不做）

| 编号 | 非目标 | 原因 |
|---|---|---|
| N1 | 不做写入拦截/审批 | 这是「防护」而非「同步」，dsh/CC 各自已有写时防护；一期只做感知与注入 |
| N2 | 不监听 agent 从未认知过的文件的内容级变更 | 未被 agent 读过的文件变更不会造成上下文不对称；只对 git 追踪文件上报文件级创建/删除（可选开关） |
| N3 | 不做进程级因果归因（fanotify/eBPF/ETW 追踪写入者 PID） | 跨平台成本高、权限门槛高；列为 v2 可选 precision mode（§7.1）。一期用 FR-7 快照时间窗完成 shell 写入归因 |
| N4 | 不做变更的语义理解/总结（LLM 摘要 diff） | 一期注入原始结构化 diff，不引入额外模型调用 |
| N5 | 不支持多工作区 / 远程工作区 | 一期单 workspace root、本地文件系统 |

### 2.3 成功标准（一期验收）

1. 演示场景全通过（见 §5.6 测试矩阵），包括：用户微调 agent 刚写的文件、用户删除文件、用户新建文件、agent 连续多步任务中途被用户干预；
2. agent 直接工具写入（A 类）在注入消息中出现率为 **0**；Bash 命令副作用（B 类）归因准确率 ≥ 95%（T9/T10）；
3. 单次注入 P95 ≤ 200ms（从 pre-step 触发到注入完成），注入 token 默认 ≤ 2000；
4. 插件抛任何异常时会话不中断，仅在日志可见。

---

## 3. 核心概念

### 3.1 Agent 认知基线（Agent-Known Baseline, AKB）

插件为每个文件维护一份「agent 当前认知中的内容状态」：

```
AKB[path] = {
  contentHash: string,     // agent 最后认知的内容哈希（sha1）
  mtimeMs: number,         // 对应磁盘 mtime
  source: 'read' | 'write',// 基线来源：agent 读过 or 写过
  knownDeleted?: boolean,  // agent 已知该文件不存在
  updatedAt: number
}
```

**基线不是 git HEAD。** git HEAD 无法覆盖未提交的中间状态，且 agent 的工作常与 git 无关。AKB 通过拦截 agent 的 Read/Write/Edit 工具结果建立与更新——它是「agent 以为自己看到的世界」的快照。

### 3.2 漂移（Drift）

任一时刻，`Drift(path) = AKB[path]` 与磁盘实际状态的差异。漂移分四类：

| 类型 | 判定 | 上报粒度 |
|---|---|---|
| `modified` | 基线存在，磁盘存在，内容哈希不同 | 行级 diff（预算内） |
| `deleted` | 基线存在（或 knownDeleted=false），磁盘不存在 | 文件级 |
| `created` | 基线不存在，磁盘出现（仅对 git 追踪路径或配置开启时） | 文件级 + 可选内容预览 |
| `renamed` | 一次 delete + create 且内容哈希相同，合并判定 | 文件级（标注 from→to） |

与变更类型正交的另一维度是**归因**——变更是谁造成的。注入消息 = 变更类型 × 归因类别的二维组合，归因模型见 §3.6。

### 3.3 同步点（Sync Point）

每次向 agent 成功注入漂移信息后，AKB 全量对账为磁盘当前状态，漂移队列清空——注入即同步。保证同一份变更**不会被重复注入两次**。

### 3.4 自变更排除（Echo Suppression）的天然实现

agent 通过 Write/Edit 工具写文件时：`tools/post-execute` 钩子拿到工具结果 → 立即更新 AKB 为该工具写入的最终内容 → watcher 随后报来的文件系统事件与 AKB 对账，内容哈希一致则丢弃。

不需要传统 watcher 方案的「写入后 N 毫秒静默窗口」，**归因是精确的内容级判定，而非时间窗口启发式**。

### 3.5 注入时机：为什么选 pre-step 而不是 user-prompt

dsh 的 `agent/pre-step` 在**每一次模型请求前**触发（含一个用户 turn 内的多步工具循环）。这意味着：用户在 agent 连续工作的第 3 步和第 4 步之间改了文件，第 4 步的模型请求就能看到变更——比「下一轮用户对话」早得多。这正是「agent 按旧思路干下去，出错才发现」的根治点。

### 3.6 归因模型（Attribution）

「谁造成了变更」与「变更了什么」同等重要——归因错误的信息比没有信息更糟。变更来源分四类：

| 类别 | 来源 | 识别机制 | 上报策略 |
|---|---|---|---|
| **A · 工具写入** | agent 的 Write/Edit 类工具 | `tools/post-execute` 精确捕获（§3.4），零误差 | **完全抑制**，不上报 |
| **B · 命令副作用** | agent 的 Bash 类命令（脚本、构建、代码生成器、包管理器） | FR-7 快照时间窗：命令前后对 AKB 取哈希快照，窗口内变化的文件归因给该命令 | 上报，措辞为「你执行的 `xxx` 产生了以下变更」。注意这同样是认知缺口——agent 看得到 stdout，却不知道脚本写了哪些文件 |
| **C · 外部修改** | 用户编辑、用户的终端、文件同步进程等 | 排除 A/B/D 后的剩余 + 置信度标注 | 核心上报通道，预算内完整 diff |
| **D · 格式化衍生** | IDE 保存时自动格式化（prettier/gofmt-on-save） | FR-8 启发式：agent 写入后 ~1s 内、diff 仅空白/标点级 | 一行带过，不占 diff 预算 |

两条核心原则：

1. **不对称偏向**：B/C 误判的代价不对称——把 B 误归 C 只是措辞偏差（无害），把 C 误归 B 会让真实用户修改被静默忽略（严重）。**有歧义时永远偏向 C（外部）**，并在消息中如实标注歧义与另一种可能（如「可能来自你执行的 `pytest`，也可能是外部修改」）。
2. **不确定就暴露不确定**：归因是带置信度的字段而非布尔。agent 对歧义项的验证成本（Read 一下）远低于被错误归因误导的成本。

正向捕获通道（v2 可选，§7.1）：编辑器伴侣扩展可 100% 精确上报用户编辑事件，与上述推理式归因互补，不作为依赖。


---

## 4. 一期详细设计：DeepSeek Harness 插件

### 4.1 平台能力与接入点

dsh 基于 Cordis 组合框架，插件为导出 `apply(ctx)` 的 TypeScript 模块，通过 `dsh plugin --profile <web|headless|cli> add github:owner/repo` 安装分发，支持热加载。官方钩子桥接包（`dsh-hooks-claude-code` / `dsh-hooks-codex`）把各家钩子映射为一组规范拦截点，本插件直接使用这些**原生事件**：

| dsh 拦截点 | 语义 | 本插件用途 |
|---|---|---|
| `tools/pre-execute`（waterfall） | 工具执行前 | **FR-7 归因窗口开启**：Bash 类命令执行前对 AKB 取哈希快照 |
| `tools/post-execute`（waterfall） | 工具执行后，可见工具名与结果 | **AKB 维护**（read/write/edit 结果更新基线）+ **FR-7 窗口关闭**（二次快照，窗口内变化归因给该命令） |
| `agent/pre-step`（waterfall） | 每次模型请求前，可追加上下文消息 | **漂移注入主通道** |
| `agent/session-start`（emit） | 会话启动，可 `agent.inject()` 注入 additionalContext | 冷启动全量对账 + 存量漂移注入 |
| `agent/turn-stopping`（serial） | turn 结束前 | 落盘持久化 AKB（见 §4.6） |
| `session/disposed` | 会话销毁 | 清理 watcher、最终落盘 |

上下文注入走官方通道，注入内容携带 `{kind:'plugin', plugin:'bright-drift'}` 来源标注，append-only、不破坏 KV cache。

> **调研确认项（开工第一周须验证，见风险 R1）**：上述事件在 dsh 当前版本的具体 payload 结构（工具结果中是否含写入后完整内容、pre-step 注入消息的最大长度与格式约束），以 dsh 仓库 `packages/hooks` 与 Plugin Dev Skill 文档为准。

### 4.2 总体架构

```
┌─────────────────────────── dsh 进程（插件内） ───────────────────────────┐
│                                                                          │
│  tools/post-execute ──► BaselineStore（AKB，内存 + 持久化）               │
│                              ▲                                           │
│  chokidar watcher ──► Debouncer ──► DriftDetector ──► DriftQueue         │
│   (workspace root)        (300ms)      │ 与 AKB 对账        │            │
│                                        │ 分类 modified/      │            │
│                                        │ deleted/created/    │            │
│                                        │ renamed             │            │
│                                        ▼                     ▼            │
│  agent/pre-step ──► Injector ◄── DiffEngine ◄── BudgetController        │
│        │                │          unified diff     超限降级策略          │
│        └──── 注入漂移消息，然后 SyncPoint：AKB 对账 + 清空队列             │
│                                                                          │
│  agent/session-start ──► Reconciler：磁盘全量扫描 vs 持久化 AKB           │
└──────────────────────────────────────────────────────────────────────────┘
```

**全部组件运行在 dsh 插件进程内**，不需要独立守护进程（dsh 插件有持久生命周期，watcher 可直接挂载 `ctx`；与二期 CC 的短命 hook 进程模型形成对比，见 §6.2）。

模块划分（对应 monorepo 包结构）：

| 模块 | 职责 | 平台相关性 |
|---|---|---|
| `core/baseline` | AKB 数据结构、哈希、持久化 | 平台无关 |
| `core/watcher` | chokidar 封装、debounce、ignore 规则 | 平台无关 |
| `core/drift` | 漂移分类、rename 合并、对账算法 | 平台无关 |
| `core/attribution` | A/B/C/D 归因判定、快照窗口管理、置信度标注；窗口状态机可序列化（二期硬约束，见 §6.2） | 平台无关 |
| `core/diff` | 行级 unified diff 生成与截断 | 平台无关 |
| `core/budget` | token/行数预算与降级策略 | 平台无关 |
| `core/message` | 注入消息渲染（§4.5 协议） | 平台无关 |
| `dsh/adapter` | dsh 事件绑定、inject 通道适配 | 一期 |
| `claude-code/adapter` | CC hooks 适配 + 外部 daemon | 二期 |

**核心引擎平台无关化是第一优先级架构约束**——二期、三期的全部增量工作收敛在各 adapter 内。

### 4.3 功能需求（一期）

#### FR-1 AKB 建立与维护（P0，自变更排除的地基）

- FR-1.1 监听 `tools/post-execute`，匹配 read 类工具：以工具返回的**文件内容**建立 `source:'read'` 基线。若工具结果只含部分内容（分页/截断读取），基线标记 `partial:true`，该文件的 modified 漂移**降级为文件级提示**（不做可能误导的行级 diff）。
- FR-1.2 匹配 write/edit 类工具：以工具输入参数与工具结果推导写入后完整内容，更新基线为 `source:'write'`。
- FR-1.3 文件被 agent 读取前已在 watcher 中产生的事件，若文件不在 AKB 中，按 §3.2 created 规则处理。
- FR-1.4 AKB 容量上限默认 5000 文件，LRU 淘汰；被淘汰的文件重新进入视野时按 created/未知处理（保守降级，不误报 modified）。

#### FR-2 变更采集（P0）

- FR-2.1 chokidar 监听 workspace root，默认遵循 `.gitignore` + 内置忽略表（`node_modules`、`.git`、常见构建产物目录、本插件状态目录）。
- FR-2.2 事件 debounce 300ms 合并；对同一路径的连续事件只保留最终态。
- FR-2.3 对账逻辑：watcher 事件到达时与 AKB 比较内容哈希——**与 AKB 一致的事件直接丢弃**（agent 自变更回声），不一致才进入 DriftQueue。
- FR-2.4 二进制文件（null 字节探测）、单文件 >512KB（默认，可配）不做内容 diff，仅文件级上报。
- FR-2.5 编辑器原子写（write-temp-then-rename）与保存产生的 chmod/元数据事件不产生误报（以内容哈希为准，而非 mtime）。

#### FR-3 漂移注入（P0）

- FR-3.1 `agent/pre-step` 触发时，若 DriftQueue 非空：渲染注入消息（§4.5）→ 追加为上下文消息 → 执行 Sync Point。
- FR-3.2 若 DriftQueue 为空，pre-step 零开销直接放行（早退路径，目标 <1ms）。
- FR-3.3 `agent/session-start`：读取持久化 AKB，对 workspace 做一次全量对账（处理「上次会话结束后、本次会话开始前」的漂移），非空则注入。
- FR-3.4 注入消息必须带 `kind:'plugin'` 来源标注，措辞明确「以下是用户对文件的外部修改，非你所为」，防止 agent 把变更归到自己头上或重复执行。

#### FR-4 预算与降级（P0）

- FR-4.1 三级预算（默认）：单文件 diff ≤ 200 行；总 diff ≤ 1000 行；注入消息 ≤ 2000 token（粗估 4 字符≈1 token）。
- FR-4.2 降级阶梯：完整行级 diff → 截断 diff（保留头尾，标注省略行数）→ 文件级清单 + `+a/-b` 统计。每级降级在消息中显式标注，agent 可自行 Read 获取全量。
- FR-4.3 漂移文件数 >50（如切分支、批量代码生成）时跳过所有 diff，只注入结构化清单 + 一句「大规模变更，建议重新阅读相关文件」。

#### FR-5 配置（P1）

配置文件 `<workspace>/.dsh/bright-drift.yml`（项目级）+ `~/.dsh/bright-drift.yml`（用户级），项目级优先：

```yaml
enabled: true
watch:
  respectGitignore: true      # 默认 true
  extraIgnore: []             # 追加忽略 glob
  includeUntracked: false     # created 漂移是否覆盖 git 未追踪文件，默认 false
budget:
  maxDiffLinesPerFile: 200
  maxTotalDiffLines: 1000
  maxInjectTokens: 2000
  maxDriftFilesForDiff: 50
diff:
  contextLines: 3             # unified diff 上下文行数
  maxFileSizeKB: 512
baseline:
  maxEntries: 5000
  persist: true               # turn-stopping 时落盘，供跨会话对账
inject:
  onSessionStart: true
  onPreStep: true
attribution:
  bashWindowGraceMs: 1500    # 命令结束后的归因窗口余量
  longCommandMs: 10000       # 超过则窗口内变更标 ambiguous-external
  formatterWindowMs: 1000    # D 类识别窗口
  formatterSilent: false     # D 类是否完全静默
```

#### FR-6 可观测性（P1）

- 本地日志 `~/.dsh/logs/bright-drift-<date>.log`：每次漂移检测、注入、降级、丢弃回声均留痕（含内容哈希前后值，不含文件内容本身）。
- dsh 自定义命令 `/bright-drift status`：输出当前 AKB 规模、待注入漂移、累计注入次数与 token 消耗、`/bright-drift diff <path>` 预览某文件待注入 diff。
- `/bright-drift pause|resume`：临时停用注入（如用户正在批量重构，不想每步打断 agent）。

#### FR-7 命令副作用归因（P0，E14 的正式解）

- FR-7.1 `tools/pre-execute` 匹配 Bash 类工具：对 AKB 内全部文件（小集合，数十至数百）记录内容哈希快照，开启归因窗口；窗口期间的 watcher 事件暂存待分类。
- FR-7.2 对命令字符串做浅层静态分析（`>`、`>>`、`tee`、`sed -i`、`-o/--output` 的目标路径），将预测写入路径一并纳入快照。
- FR-7.3 `tools/post-execute`（+1.5s grace 吸收延迟落盘）二次快照：窗口内哈希变化者归因为 B 类，注入措辞含命令原文；窗口外事件按 C 类通道处理。
- FR-7.4 长命令（默认 >10s）窗口内发生的变更按 §3.6 不对称偏向原则标注为 ambiguous-external。
- FR-7.5 快照成本约束：仅覆盖 AKB + 预测路径，单次快照目标 <50ms；AKB 超 1000 文件时仅快照 mtime/size，内容哈希惰性计算。
- FR-7.6 归因窗口状态机（快照、待分类事件队列）必须可序列化，支持跨进程交接（二期 CC daemon 复用，见 §6.2-5）。

#### FR-8 格式化衍生识别（P1）

- FR-8.1 agent 工具写入后 1s 内发生的变更，若 diff 仅含空白/引号/分号级修改（tokenize 后忽略格式差异比较），归类 D 类（formatted）。
- FR-8.2 D 类上报为一行摘要，不占 diff 预算；可配置为完全静默。

### 4.4 边界情况清单

| # | 场景 | 预期行为 |
|---|---|---|
| E1 | agent 自己 write/edit 文件 | watcher 事件与 AKB 哈希一致 → 丢弃，零注入 |
| E2 | 用户修改 agent 刚写的文件 | 哈希不一致 → modified + 行级 diff 注入 |
| E3 | 用户删除 agent 读过的文件 | deleted 漂移注入：「文件已被用户删除」 |
| E4 | 用户删除后又重建同名文件（内容不同） | 对账后归类 modified（净效应正确） |
| E5 | 重命名 | delete+create 且哈希相同 → 合并为 renamed，单行上报 |
| E6 | 切换 git 分支（大量文件同时变化） | 触发 FR-4.3 大规模变更模式 |
| E7 | 用户在 agent 多步任务中途改文件 | 下一个 pre-step 即注入，无需等用户下一轮发言 |
| E8 | agent 只读了文件前 100 行（partial） | 文件级 modified 提示，不给可能错误的 diff |
| E9 | 文件在 pre-step 对账瞬间正被写入（半写状态） | 读取失败/哈希抖动 → 跳过本轮，事件会再次触发，下轮补报；永不阻塞 agent |
| E10 | 插件崩溃/异常 | try/catch 全包裹，fail-open，仅写日志 |
| E11 | 会话 resume（跨天继续） | session-start 全量对账，一次性注入累积漂移 |
| E12 | 同一文件连续多次外部修改 | debounce + 队列合并，只报最终态 diff（相对上次 Sync Point） |
| E13 | symlink / 挂载点 | 不跟随 workspace root 之外的 symlink |
| E14 | agent 通过 Bash 命令写文件（脚本、`sed -i`、构建等） | FR-7 快照窗口归因为 B 类，注入「你执行的 `xxx` 产生了以下变更」；B 类变更同样触发 Sync Point 更新 AKB |
| E15 | 用户在 agent 执行长命令（>10s）期间修改 AKB 文件 | 时间窗无法区分 → 按不对称偏向原则标注 ambiguous-external（措辞含命令假设），偏向按外部修改处理 |

### 4.5 注入消息协议（core/message 渲染格式）

```text
[workspace-drift · kind=plugin · bright-drift]
以下是上一次同步点之后工作区发生的变更，按来源分类。
请将其视为当前文件系统事实：EXTERNAL 部分不是你做的，不要重复执行，也不要基于旧内容继续推理。

EXTERNAL·MODIFIED (high confidence)  src/auth/token.ts  (+1 -1)
@@ -45,7 +45,7 @@
-  const TTL = 3600;
+  const TTL = 7200;
...

COMMAND-SIDE-EFFECT  你的命令 `npm run codegen` 改动了 12 个文件：
  src/generated/client.ts (+210 -88) 等，diff 从略，如需可自行 Read

EXTERNAL·MODIFIED (ambiguous)  config/db.yml  (+4 -2)
  发生于你的命令 `pytest` 执行期间，可能由该命令产生，也可能是外部修改

EXTERNAL·DELETED (high confidence)  docs/draft-plan.md
RENAMED  src/util.ts → src/utils.ts
FORMATTED  src/util.ts（IDE 保存时自动格式化，仅空白差异）

[2 个文件的 diff 因预算截断，仅列清单：src/a.ts (+30 -12), src/b.ts (+5 -1)]
[workspace-drift end]
```

设计要点：机器可解析的块标记（方便调试与测试断言）；归因类别与置信度是一等字段，不确定时如实暴露歧义（§3.6）；降级标注；引导 agent 自行 Read 的逃生门；B 类与 D 类默认从略 diff 以节省预算。

### 4.6 持久化与生命周期

- 内存态：AKB + DriftQueue 全量驻留 dsh 插件进程。
- 持久化：`agent/turn-stopping` 与 `session/disposed` 时，将 AKB（path → hash 的紧凑映射，不含内容）写入 `~/.dsh/state/bright-drift/<workspace-hash>.json`；原子写（tmp+rename）。
- 行级 diff 需要基线内容：AKB 内存中保留内容副本（限 maxEntries 与单文件大小）；持久化只存哈希——跨会话的首次 modified 漂移降级为文件级提示（保守正确）。

### 4.7 技术选型

| 依赖 | 用途 | 备注 |
|---|---|---|
| chokidar | 跨平台文件监听 | 成熟稳定，处理编辑器原子写 |
| diff（jsdiff） | 行级 unified diff | 零原生依赖 |
| 无其他重型依赖 | — | 插件保持轻量，安装秒级 |

### 4.8 一期里程碑

| 里程碑 | 内容 | 验收 |
|---|---|---|
| M0 调研验证（第 1 周） | 跑通 dsh 插件开发链路；验证 §4.1 各事件 payload；确认 pre-step 注入格式约束 | demo 插件在 pre-step 注入「hello」并被模型引用 |
| M1 核心引擎（第 1-2 周） | core 五模块 + 单测（E1-E6、E12 场景全覆盖） | 引擎单测全绿，可脱离 dsh 运行 |
| M2 dsh 集成（第 3 周） | adapter 绑定事件；FR-1~FR-4、FR-7 全通；E7/E11/E14/E15 端到端 | 真实 dsh 会话中演示 §1.1 三个痛点场景 + T9/T10 归因场景 |
| M3 打磨与发布（第 4 周） | FR-5/FR-6、文档、npm/GitHub 发布、README 演示 GIF | 陌生人按 README 10 分钟装完可用 |

---

## 5. 一期测试矩阵（验收用）

| 场景 | 前置 | 操作 | 断言 |
|---|---|---|---|
| T1 用户微调 | agent edit 了 f | 用户改 f 一行 | 下一次模型请求的上下文含 f 的 1 行 diff，措辞为外部修改 |
| T2 无回声 | agent edit 了 f | 无用户操作 | 后续所有 pre-step 无任何 f 相关注入 |
| T3 删除感知 | agent read 了 f | 用户删 f | 注入含 `DELETED f` |
| T4 中途干预 | agent 正在 5 步任务第 2 步 | 用户改相关文件 | 第 3 步请求即含漂移，agent 改变计划（行为级断言，人工观察） |
| T5 预算降级 | agent read 了 f | 用户粘贴 5000 行进 f | 注入为文件级 + 统计，无完整 diff，token ≤ 上限 |
| T6 切分支 | 会话进行中 | `git checkout` 另一分支 | 注入大规模变更清单模式，无崩溃 |
| T7 跨会话 | 昨天会话 agent 读过 f | 今天 resume 前用户改了 f | session-start 注入文件级 modified |
| T8 故障注入 | — | 人为让 watcher 抛异常 | 会话正常继续，日志有记录 |
| T9 命令归因 | AKB 内有文件 f | agent 执行 `python gen.py` 改写 f，无用户操作 | 注入为 COMMAND-SIDE-EFFECT 类，含命令原文；**不得**标为 EXTERNAL |
| T10 窗口歧义 | agent 执行 15s 长命令 | 用户在窗口内改了 AKB 文件 | 注入标注 ambiguous-external，偏向外部处理，措辞含命令假设 |

---

## 6. 二期规划：Claude Code CLI

> 二期只做规划与预研，一期 core 引擎的所有接口设计均以「CC adapter 可实现」为约束（例如 core 不假设长驻进程——见 §6.2）。

### 6.1 与一期的关键差异

| 维度 | dsh（一期） | Claude Code（二期） |
|---|---|---|
| 插件形态 | Cordis 插件，进程内长驻 | hooks 脚本（短命进程）+ 可选插件包分发 |
| 变更采集 | 进程内 chokidar | **需独立 watcher daemon**（由 SessionStart hook 拉起，pid 文件管理，会话退出不杀） |
| AKB 维护 | `tools/post-execute` 进程内直读 | `PostToolUse(Read\|Edit\|Write\|MultiEdit)` hook 写状态文件，daemon 读取 |
| 注入通道 | `agent/pre-step`（每个模型 step） | `UserPromptSubmit` → `additionalContext`（**粒度降级：仅用户发言轮**，turn 内多步之间无法注入，为平台硬限制） |
| 冷启动对账 | `agent/session-start` | `SessionStart` hook |
| 状态位置 | dsh 进程内存 | `~/.claude/state/bright-drift/`（daemon 持有内存态，hook 进程通过状态文件/本机 socket 通信） |

### 6.2 架构决策（二期预研结论）

1. **不用 CC 原生 `FileChanged` hook**：matcher 只能按 basename 枚举、无法监听整树，且存在插件注册后不触发的未修复 bug。自带 watcher daemon 是更可控的路线。
2. **daemon 形态**：SessionStart hook 检查并拉起 `bright-drift-daemon`（node 单文件，复用 core 引擎）；UserPromptSubmit hook 查询 daemon 的待注入漂移并渲染为 additionalContext 输出。daemon 空闲超时（如无会话引用 30 分钟）自动退出。
3. **与 CC 内置能力的关系**：CC 的 FileStateCache 已覆盖「写时防覆盖」，二期的增量价值在于——删除感知、未写仅读场景的漂移、行级 diff 呈现、turn 前主动告知。README 需明确说明互补关系，避免用户以为重复。
4. **已知坑（须在二期开工前逐一验证）**：桌面端/Agent SDK 会话不加载任何 hooks（该形态下插件静默失效，文档须明示）；插件分发形式的 hooks 信任提示对安装体验的影响。
5. **FR-7 在 CC 的落法**：CC hook 是短命进程，PreToolUse(Bash) 开启的快照须落状态文件，由 daemon 完成窗口管理与二次快照——**一期 `core/attribution` 的窗口状态机必须可序列化、可跨进程交接**（FR-7.6），此为二期对一期架构的硬约束。

### 6.3 二期里程碑（预估 3 周）

- M4 daemon + hook 桥接打通（第 1 周）
- M5 CC adapter 功能对齐一期 FR-1~FR-4（第 2 周）
- M6 安装体验打磨、与一期统一发版（第 3 周）

---

## 7. 三期方向（仅备忘，不展开）

- **Codex CLI**：hooks 已支持 `UserPromptSubmit` additionalContext（默认 ~2500 token 上限，超预算会 spill 成磁盘文件——正好复用 core/budget 的降级策略）；无 FileChanged 类事件，daemon 方案与二期同构。注意 hooks 有逐条 trust 审核流程。
- **opencode**：TS 插件体系（`chat.message` 等钩子），适配成本预计最低。
- 三期是否启动的决策点：二期完成后的用户反馈 + 官方是否收编（监控 CC #30427、Codex #36717 状态）。

### 7.1 归因增强 backlog（v2+，跨平台通用）

- **进程级因果归因（precision mode）**：Linux 用 fanotify（`FAN_REPORT_PIDFD`）/eBPF 获取写入者 PID，沿进程树判断是否 agent spawn 的 shell 后代（是 → B 类；是已知编辑器进程 → 高置信 C 类）；macOS EndpointSecurity、Windows ETW 成本高，按需投入。`core/attribution` 的判定器预留可插拔策略接口，native helper 作为可选信号源接入。
- **编辑器伴侣扩展**：极简 VS Code/Cursor 扩展，用 `onDidChangeTextDocument` 区分用户键入与程序化 WorkspaceEdit，正向捕获用户编辑（精度 100%），作为推理式归因的可选增强而非依赖。

---

## 8. 风险与开放问题

| # | 风险/开放问题 | 等级 | 应对 |
|---|---|---|---|
| R1 | dsh 事件 payload 与文档不符（开源项目迭代快） | 高 | M0 第一周专门验证；adapter 层做防御性解析 |
| R2 | 官方收编：CC/Codex 原生实现漂移检测 | 中 | 差异化押注多平台 + 行级 diff + 先发；core 引擎保持可独立用于任意 agent 框架 |
| R3 | 注入打断 agent 长链条推理的副作用（漂移消息使 agent 过度保守/反复重读） | 中 | 措辞协议明确「这是事实同步，不是新指令」；提供 pause 命令；收集 dogfooding 反馈迭代措辞 |
| R4 | Bash 工具写文件误归因（E14） | 中 | 一期软归因措辞；二期探索对 Bash 命令的写路径静态分析 |
| R5 | watcher 在超大 monorepo 的性能 | 中 | gitignore 遵循 + 忽略表 + AKB 范围收敛；M1 压测 10 万文件仓库 |
| R6 | 多 agent 会话并发同一工作区，AKB 互相覆盖 | 低（一期） | 一期声明不支持；daemon 化后（二期）天然集中管理，届时重估 |
| R7 | ~~命名与商标查重~~ 已定名 bright-drift（§9.2，v0.3 关闭）；残余项为域名注册与商标检索 | 低 | 发布前人工确认域名与商标 |
| R8 | B/C 归因误判：用户修改恰逢 agent 命令窗口被吞掉（最严重方向），或脚本输出被说成用户修改（无害方向） | 中 | §3.6 不对称偏向原则（歧义永远偏向外部）；长命令窗口标 ambiguous-external；日志记录全部归因决策供回溯 |

---

## 9. 开源计划

### 9.1 仓库与发布

- GitHub 单仓库 monorepo：`packages/core`（平台无关引擎）、`packages/dsh-adapter`、`packages/claude-code`（二期）；MIT LICENSE；语义化版本。
- 分发：一期走 dsh 官方途径 `dsh plugin add github:<owner>/bright-drift`；core 与 adapter 同时发 npm（二期 daemon 需要 npm 包形态）。
- CI：GitHub Actions——core 单测矩阵（node 20/22 × ubuntu/macos/windows）、一期端到端测试（在 CI 内启动 dsh headless profile 跑 T1-T8 的可自动化子集）。
- README 必备：30 秒演示 GIF、与 CC 内置防护的互补关系说明、已知限制（E14 等）如实列出。

### 9.2 命名（已定稿：bright-drift）

**正式名称 `bright-drift`**。语义三重契合项目定位：bright = 照亮（照亮 agent 的工作区盲区）/ 聪颖的（让 agent 对工作区心里有数）/ 清晰明朗的（同步后的认知状态）；与 drift（混沌、渐行渐远）形成词义对仗，问题与解法同时装进名字。

查重记录（2026-08-29，三平台）：

- **npm / PyPI**：`bright-drift`、`brightdrift`、`bright-drift-core` 全部空闲；
- **GitHub**：无意义重名仓库（仅一批自动生成的数字后缀空壳仓库及一个不相关的显微镜校正项目，无心智占位冲突）；
- **域名**：`bright-drift.com/.dev`、`brightdrift.dev` 注册状态待发布前人工确认（沙箱无法可靠探测）。

曾用名与落选名存档：DriftSync（v0.1 代号，npm 被占且多平台重名）、driftsight（GitHub 存在活跃同名仓库）、driftgaze / driftseer / sightdrift（三平台零冲突的备选形变，最终让位于语义更强的 bright-drift）。

包名规划：npm 统一连字符形态——`bright-drift`（一期 dsh 插件主包）、`bright-drift-core`（平台无关引擎）、`bright-drift-claude-code`（二期 adapter）；GitHub 仓库名 `bright-drift`。

README 中明确定义术语 drift / baseline / sync point，建立项目话语体系（利于社区传播与后续官方收编对话中的心智占位）。

### 9.3 社区策略

- 发布后定向反馈渠道：CC #30427、Codex #36717 两个 issue 下留言提供方案（这两个 issue 的关注者就是精准早期用户）；
- 接受平台 adapter 贡献的架构前提：core 引擎 API 稳定化（v1.0 前标记 experimental）。

---

## 10. 成功指标（发布后 3 个月）

| 指标 | 目标 |
|---|---|
| 一期 dogfooding：作者自身日常使用覆盖率 | ≥ 80% 工作日 |
| T1-T8 场景在真实使用中回归失败率 | 0 |
| 注入 token 开销中位数 / P95 | ≤ 500 / ≤ 2000 |
| GitHub stars / 外部贡献者 PR | ≥ 200 / ≥ 3 |
| CC 二期发布 | M6 按期 |

---

## 附录 A：调研依据（2026-08-29）

- dsh 插件架构与拦截点：DeepSeek Harness 官方仓库及 Plugin Dev Skill（`agent/pre-step`、`tools/post-execute`、`agent/session-start` 等规范拦截点；`agent.inject()` 与动态 system prompt section 注入通道；注入内容 `{kind:'plugin'}` 来源标注）。
- Claude Code：FileStateCache 写时防护（`File has been modified since read`）；`FileChanged` hook 能力与 basename matcher 限制；issue #30427（external file changes，open）；桌面/SDK 会话 hooks 不加载问题。
- Codex：hooks 框架（`UserPromptSubmit` additionalContext、~2500 token 默认上限、trust 审核流程）；issue #36717（workspace drift，open）。
- 社区先例：claude-code-live-memory（FileChanged + stale 提示，单平台）；context-mode（多平台钩子适配，方向为会话记忆而非工作区同步）；Aider `--watch-files`（监听用于捕获指令注释，非上下文同步）。
