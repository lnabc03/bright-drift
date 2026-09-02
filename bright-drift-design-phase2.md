# bright-drift 二期设计文档（Claude Code adapter）

> 状态：设计定稿，待评审 · 日期：2026-09-02
> 上游：bright-drift-PRD.md §6（二期规划）、bright-drift-design-phase1.md（core 引擎与一期平台事实）、bright-drift-phase2-research.md（预研报告，含全部实测数据）
> 验证环境：Claude Code 2.1.258 / Windows 11；官方文档 code.claude.com/docs/en/hooks（2026-09-02 defuddle 全文复核）

---

## 1. 核实结论

### 1.1 总体判断

PRD §6.2 的「短命 hook 桥 + 独立 watcher daemon」架构**实测成立**，二期按此开工。预研完成三类验证：

1. **本机 spike**（沙盒项目 + headless `claude -p`，9 组实验）：SessionStart 拉起 detached daemon、PostToolUse 管道 matcher、UserPromptSubmit additionalContext 注入、30s 超时 fail-open、Stop hook 注入与死循环行为、SessionStart resume 重复触发——全部拿到实测结论。
2. **官方文档全文复核**：超时表、输出格式、10,000 字符上限、matcher 语法、`async`/`shell`/exec-form 字段、resume 重放语义——逐条确认或修正。
3. **生态调研**：官方无收编迹象（#30427 死档）；社区无同形态占位项目；`daemon + UserPromptSubmit 注入`形态有 letta-ai/claude-subconscious 先例背书。

### 1.2 勘误与新增硬约束（相对 PRD §6）

| # | PRD 假设 | 核实结论 | 处理 |
|---|---|---|---|
| E1 | §6.1 注入通道：UserPromptSubmit，粒度降级为用户发言轮 | 确认。另有增量：v2.1.163+ **Stop hook 支持 additionalContext 且对话继续** | 采纳为第二注入通道（P2-D6），需 at-most-once 门控（§5.6） |
| E2 | §6.2-4 桌面端/Agent SDK 不加载 hooks | 确认，且 VS Code 扩展同病（#87657/#18547，OPEN） | 二期只承诺 CLI；README 明示（§2.2） |
| E3 | §6.2-4 插件分发的 hooks 信任提示影响体验 | 信任为插件级一次性确认，体验无碍；但发现更大的坑：**#16288（插件 hooks.json 中 UserPromptSubmit/FileChanged 不触发）OPEN 未修** | 安装主路径改为 settings.json 注入（P2-D9），插件 marketplace 形态推迟 |
| E4 | （PRD 未涉及）additionalContext 尺寸上限 | 官方文档承诺 10,000 字符，超出 spill 成文件只剩预览；实测 2.1.258 上阈值 ≈25,000 字节（文档滞后于实现） | **硬约束：渲染产物 ≤ 9,500 字符**（按文档承诺取值，实测余量当安全垫），超线走降级梯（§5.7） |
| E5 | §6.2-2 daemon 拉起 | 可行；但 SessionStart 在 `startup/resume/clear/compact/fork` 五种 source 均触发（resume 实测确认） | daemon 拉起与注册必须幂等（§5.2） |
| E6 | §6.2-5 归因窗口跨进程交接 | Attributor toJSON/fromJSON 一期已满足（FR-7.6）；但 CC 的 PreToolUse hook 是短命进程，窗口开启的**预快照由 hook 进程就地完成**更可靠（§5.5.2） | 窗口状态仍落盘，daemon 异步接管 |
| E7 | （PRD 未涉及）resume 时注入重放 | 官方文档：resume/--continue 会**从 transcript 重放**历史注入文本，不重新跑 hook——时间戳类内容会陈旧 | 注入文本不写绝对时间戳，只写相对表述（§5.6.4） |

### 1.3 平台能力速查（设计依据，均含出处）

| 事实 | 取值 | 出处 |
|---|---|---|
| UserPromptSubmit 默认超时 | **30s**（command/http/mcp_tool）；超时丢弃输出、prompt 照常进入（fail-open 实测确认） | hooks 参考文档；spike #4 |
| 其他多数事件默认超时 | 600s，hook 条目 `timeout` 字段可覆盖（单位：秒） | hooks 参考文档 |
| SessionEnd | 无决策权、JSON 输出被丢弃，仅适合轻量清理 | hooks 参考文档 |
| additionalContext 注入形态 | 包成 system reminder，不进聊天 UI，不产可见 transcript 条目；下一次模型请求生效 | hooks 参考文档 §Add context for Claude |
| additionalContext 措辞要求 | 写**事实陈述**而非祈使指令——命令口吻会触发 prompt-injection 防线，被模型当面向用户示出 | hooks 参考文档（与一期「notice 是事实不是指令」原则天然一致） |
| SessionStart matcher | 可按 source 过滤：`startup\|resume\|clear\|compact\|fork` | hooks 参考文档 matcher 表 |
| hook 执行形态 | `async:true` 后台不阻塞；exec form（`command`+`args`）不经 shell；`shell` 字段可指定 bash/powershell（Windows 无 Git Bash 时默认 powershell） | hooks 参考文档 common fields |
| Stop 循环保护 | `stop_hook_active` 为 true 表示本轮已是 stop-hook 续跑；**官方 8 连阻断后强制收停** | hooks 参考文档 §Stop input；spike #2 实测 ~9 次重拉 |
| PostToolUse 载荷 | `tool_input.file_path`（spike 实测为绝对路径；官方注明可能相对，需结合 `cwd` 归一化） | spike #1；hooks 参考文档 |
| resume 重放 | 历史 UserPromptSubmit 注入从 transcript 重放，不重跑 hook | hooks 参考文档（E7） |

---

## 2. 二期范围

### 2.1 目标

- **G1**：CC CLI 上复现一期 FR-1~FR-4 的完整体验：外部增删改感知、归因（B/C/ambiguous）、预算内行级 diff 注入、冷启动对账。
- **G2**：core 引擎零修改复用（允许 additive 的小扩展，如注入策略的 CC 变体；不允许假设长驻进程的逻辑漏进 core）。
- **G3**：安装体验一条命令完成，且对 #16288 免疫（不依赖插件 hooks.json）。
- **G4**：fail-open 与默认隐私原则在 CC 平台完整保持（PRD 设计原则原样适用）。

### 2.2 非目标

- **桌面端 / Agent SDK / VS Code 扩展形态**（hooks 不加载，#87657 未修；文档明示 CLI-only）。
- **插件 marketplace 上架**（#16288 未修前插件 hooks.json 路径不可靠；M6 重估，届时若已修复则补充分发形态）。
- **turn 内逐 step 注入**（平台硬限制，无通道；Stop 通道只覆盖 turn 结束边界）。
- **进程级精确归因**（fanotify/eBPF，PRD §7.1 backlog，v2+ 再议）。
- **多工作区 daemon 复用的性能调优**（先正确，后优化）。

---

## 3. 总体架构

### 3.1 三件套

```
packages/claude-code/                # npm: bright-drift-claude-code
├── src/
│   ├── daemon/        # 长驻进程：复用 core 全部引擎
│   │   ├── main.ts          # 入口：幂等启动、锁文件、空闲自退
│   │   ├── workspace.ts     # 每工作区一个 watcher + 共享漂移检测
│   │   ├── session.ts       # 每会话 AKB / 归因器 / 待注入队列
│   │   └── mailbox.ts       # hook→daemon 邮箱目录监视
│   ├── hooks/         # 短命 hook 入口（node 单文件，零依赖 require core）
│   │   ├── session-start.ts     # 拉起/注册 daemon（幂等）
│   │   ├── user-prompt-submit.ts# 热路径：读预渲染注入文件 → 打印 → 退出
│   │   ├── post-tool-use.ts     # AKB 更新 + 归因窗口关闭 → 写邮箱
│   │   ├── pre-tool-use-bash.ts # 归因窗口开启：就地预快照 → 写邮箱
│   │   ├── stop.ts              # Stop 通道补投（at-most-once 门控）
│   │   └── session-end.ts       # 注销会话 → 写邮箱
│   ├── installer/     # settings.json 注入式安装器（版本戳、自检、卸载）
│   └── shared/        # 状态文件协议（schema、原子写、路径规约）
└── package.json
```

**形态决策（P2-D1）**：daemon 与 hooks 同一 npm 包分发。hook 脚本用 **exec form**（`"command": "node", "args": ["<hooks>/user-prompt-submit.js"]`）注册，不经 shell——规避 Windows bash/powershell 差异（hooks 文档：无 Git Bash 时默认 powershell）。

### 3.2 进程与数据流

```
                ┌────────────── Claude Code CLI ──────────────┐
  用户发言 ────► │ UserPromptSubmit hook（短命，<10ms）          │
                │   读 pending/<sid>.json → 打印 → exit 0      │
  Read/Edit ──► │ PostToolUse hook → 写 mailbox/ 文件           │
  Bash 前 ────► │ PreToolUse hook → 就地 stat 快照 → 写 mailbox/ │
  turn 结束 ──► │ Stop hook → 读 pending（stop 批次）→ 投递一次  │
  会话始/终 ──► │ SessionStart/End hook → 注册/注销 mailbox      │
                └──────────────┬───────────────────────────────┘
                               │ 状态目录（唯一 IPC 通道，见 §5.3）
                ┌──────────────▼───────────────────────────────┐
                │ bright-drift daemon（detached node 进程）      │
                │  chokidar watcher（core/watcher）             │
                │  每会话：AKB + Attributor + DriftQueue         │
                │  预渲染：budget + message → pending/<sid>.json │
                │  空闲 30min 无存活会话 → 自退                  │
                └──────────────────────────────────────────────┘
```

**IPC 选型（P2-D2）：纯文件协议，无 socket/pipe。** 理由：

1. UserPromptSubmit 热路径只允许 <10ms——读一个本地文件是最快且最可靠的方案，daemon 预渲染把全部计算移出 hook。
2. hook→daemon 方向用邮箱目录（每消息一个 JSON 文件，原子 rename 写入），daemon 用自己的 chokidar 监听——复用 core/watcher 的成熟代码，天然跨平台（Windows named pipe 虽可用，但引入连接管理、权限、残留 pipe 等一类新问题）。
3. 文件协议可观察、可调试（`/bright-drift status` 类诊断直接读目录）、crash 后状态可恢复。
4. 代价：邮箱消费延迟 = watcher debounce（百毫秒级）。对 AKB 更新与归因窗口完全够用；唯一对延迟敏感的热路径（注入）不经过邮箱。

---

## 4. 状态目录与文件协议

### 4.1 布局（`~/.claude/state/bright-drift/`）

```
~/.claude/state/bright-drift/
├── config.yml                          # 全局配置（§5.8）
├── install.json                        # 安装器版本戳与自检信息（§5.9）
├── logs/<date>.log                     # 日志（只记哈希/路径/计数，原则同一期）
└── workspaces/<ws-hash>/               # ws-hash = sha1(规范化 cwd)[:16]
    ├── workspace.json                  # { root, daemonPid, daemonStartedAt, version }
    ├── daemon.lock                     # 幂等启动锁（含 pid，§5.2）
    ├── sessions/<session_id>.json      # 会话注册：{ registeredAt, lastSeenAt, akbMeta }
    ├── mailbox/<session_id>/<seq>-<type>.json   # hook→daemon 消息（§4.3）
    ├── pending/<session_id>.json       # daemon→hook 预渲染注入（§4.4）
    └── akb/<session_id>/               # AKB 内容副本（本机留存，隐私原则同一期）
```

**P2-D3**：状态根目录用 `~/.claude/state/bright-drift/`（PRD §6.1 既定）。`~/.claude/state/` 若不存在由安装器创建；不污染 `settings.json` 之外的任何 CC 自有文件。

### 4.2 会话注册条目（sessions/\<sid\>.json）

```json
{
  "version": 1,
  "sessionId": "…",
  "registeredAt": 1788330000000,
  "lastSeenAt": 1788330123000,
  "source": "startup"
}
```

`lastSeenAt` 由该会话的每次 hook 调用刷新（任何 hook 写邮箱或读 pending 时顺手 touch——写一个 `sessions/<sid>.json` 原子替换）。daemon 据此做存活裁决（§5.2.3）。

### 4.3 邮箱消息（hook→daemon）

文件名 `<seq>-<type>.json`，`seq` 为 hook 侧单调序号（时间戳 + 随机后缀防冲突）；daemon 按序消费后删除。消息类型：

| type | 载荷 | 产生者 |
|---|---|---|
| `session.register` | { sessionId, cwd, source, transcriptPath } | SessionStart |
| `session.deregister` | { sessionId, reason } | SessionEnd |
| `akb.observe` | { toolUseId, tool, filePath, action:"read"\|"write" } | PostToolUse(Read\|Edit\|Write\|MultiEdit) |
| `window.open` | { toolUseId, command, shell, background, openedAt, preSnapshot, predictedPaths } | PreToolUse(Bash)（预快照 hook 就地完成，§5.5.2） |
| `window.close` | { toolUseId, closedAt } | PostToolUse(Bash) |
| `session.ping` | { sessionId } | 任意 hook 的存活刷新（并入 lastSeen 亦可，M4 实测定夺） |

**乱序与丢失**：邮箱是「至少一次、可能乱序」通道。`window.close` 先于 `window.open` 到达时按 open 处理并立即关闭（以消息内时间戳为准重排，Attributor 的窗口状态机对此天然宽容——窗口只是时间区间 + 快照）。AKB observe 丢失的后果保守（文件状态偏旧 → 偏向报为外部变更），符合诚实归因原则。

### 4.4 预渲染注入文件（pending/\<sid\>.json）

daemon 在漂移检测 + 归因 + 预算渲染完成后写入，hook 只读：

```json
{
  "version": 1,
  "sessionId": "…",
  "batchId": "01J…",              // 漂移批次 id（Stop 门控用）
  "renderedAt": 1788330123000,
  "priority": "normal" | "high",  // high = 含 AKB 文件删除（Stop 通道仅投 high，P2-D6）
  "text": "<system-reminder 就绪的注入文本，已 ≤9,500 字符>",
  "deliveredVia": []              // ["user-prompt-submit"] / ["stop"]，投递记录
}
```

- hook 读到后**原样包进** `hookSpecificOutput.additionalContext` 打印。
- UserPromptSubmit hook 投递成功后，在文件内追加 `deliveredVia`（原子重写）——这是 hook 唯一的写操作；写失败无妨（代价是 Stop 通道可能重复补投一次，模型看到的是幂等的事实陈述，无害）。
- daemon 每轮渲染前检查 `deliveredVia`，已投递批次不重复渲染。

---

## 5. 核心机制设计

### 5.1 模块复用映射（core → 二期落点）

| core 模块 | 二期落点 | 改动 |
|---|---|---|
| `watcher` | daemon/workspace.ts 直接挂载 | 零改动 |
| `baseline`（AKB/ContentStore） | daemon/session.ts，按 sessionId 实例化 | 零改动 |
| `drift`（reconcile/queue/revalidate） | daemon | 零改动 |
| `attribution`（Attributor + 静态分析） | daemon；窗口开启数据来自邮箱 `window.open` | 零改动（toJSON/fromJSON 备用，见 §5.5.3） |
| `diff` / `budget` / `message` | daemon 预渲染管线 | budget 增字符红线检查（additive） |
| `sync/policy` | 需 CC 变体：注入时机从 pre-step 变为 user-prompt + stop | **additive**：新增 `shouldInjectAtUserPrompt()`，不动一期函数 |

### 5.2 daemon 生命周期

#### 5.2.1 幂等拉起（SessionStart hook）

1. hook 计算 `ws-hash`，检查 `daemon.lock`：pid 存活（`process.kill(pid, 0)`）且 `workspace.json.version` 匹配 → 直接写 `session.register` 邮箱消息，退出。
2. 否则抢锁（`open(lock, 'wx')` 排他创建），抢到者 spawn `node daemon/main.ts`（`detached:true, stdio:ignore, windowsHide:true`，`unref()`——spike #1 实测此形态存活超过会话），写 `workspace.json`，释放锁。
3. 抢锁失败 → 自旋等待 ≤2s 让赢者完成初始化，随后按 1 处理；超时则按「daemon 不可用」fail-open（本次会话无注入，日志记录）。
4. SessionStart hook 条目设 `async: true`（官方字段，后台不阻塞会话启动）；拉起本身 <100ms，余量充足。

#### 5.2.2 重复触发

`resume/clear/compact/fork` 均重跑 SessionStart（E5，resume 已实测）。注册按 `(sessionId)` 幂等：同 sid 重复注册只刷新 `lastSeenAt` 与 `source`。`fork` 产生新 sid，正常注册新会话；其 AKB 冷启动走 §5.6.5 对账。

#### 5.2.3 存活裁决与自退（P2-D4）

- daemon 每 60s 扫描 sessions/：`lastSeenAt` 距今 > **2h** 判死（覆盖用户挂起终端去吃饭的场景；CC 崩溃时 SessionEnd 不会发出，靠此兜底）。
- 存活会话数为 0 且持续 **30min**（PRD §6.2-2 既定值）→ flush 日志，退出。退出前删除 `daemon.lock` 与 `workspace.json.daemonPid`。
- SessionEnd 的 `session.deregister` 是快速路径（1.5s 预算内写一个文件，实测无压力），让「关掉最后一个会话」→ daemon 30min 后自退，不产生永久孤儿。

#### 5.2.4 崩溃恢复

daemon 崩溃 → 锁文件 pid 失效 → 下一个 SessionStart（或任何 hook 发现 pending 长期不更新时的惰性重拉，M5 视实测决定要不要）重新拉起。watcher 状态全在磁盘（AKB 内容副本 + sessions），冷启动对账恢复一致视图。**fail-open 覆盖全流程**：任何一环坏掉 = 不注入，会话无感。

### 5.3 AKB 维护通道（FR-1 在 CC 的落法）

- PostToolUse(Read|Edit|Write|MultiEdit) hook：从 stdin JSON 取 `tool_name`、`tool_input.file_path`、`tool_use_id`，路径结合载荷 `cwd` 归一化为 POSIX 相对键（E：官方注明可能相对路径），写 `akb.observe` 邮箱消息，退出。**hook 不做任何 I/O 之外的事**。
- daemon 消费：`read` → AKB 登记（读 ContentStore 或磁盘取内容哈希）；`write` → AKB 更新 + 标记「agent 刚写过」（回声抑制窗口，同一期 D-系列语义）。
- **MultiEdit/NotebookEdit 等工具名集合**在 adapter 配置中显式枚举（同一期 §5.4.1 的 D5 思路），新工具出现时走「未知写工具 → 保守登记」策略。

### 5.4 变更采集（FR-2 落法）

daemon 内每工作区一个 chokidar watcher（core/watcher 原样），ignore 规则、created-gate（git tracked 判定）、revalidate 全部复用。**FileChanged hook 完全不使用**（预研 §3-2：basename matcher + #63148/#44925 未修）。

### 5.5 归因（FR-7/FR-8 落法）

#### 5.5.1 窗口生命周期

```
PreToolUse(Bash) hook                daemon
  1. 读 akb-paths 清单文件 ──┐
  2. 就地 stat 全部 AKB 路径   │（<50ms，AKB 有界）
  3. analyzeCommand 静态分析   │（复用 core，hook 内联 bundle）
  4. 写 window.open 邮箱 ────►  5. Attributor 开窗（as-of openedAt）
                                  6. watcher 漂移进入窗口覆盖期 → B/ambiguous
PostToolUse(Bash) hook
  7. 写 window.close ────────►  8. 关窗，effectiveUntil = closedAt + grace
```

#### 5.5.2 预快照就地进行（E6 决策，P2-D5）

PRD §6.2-5 设想「PreToolUse 落状态文件，daemon 二次快照」。预研后修订为：**hook 就地完成预快照**，理由：

1. hook→daemon 邮箱是异步的，daemon 收到 `window.open` 时命令可能已写文件——快照滞后会把 B 类误判为 ambiguous-external。
2. hook 侧快照成本可控：AKB 路径清单由 daemon 维护在 `workspaces/<hash>/akb-paths.json`（每次 AKB 变更原子重写），PreToolUse hook 读清单 + stat 全部路径，AKB 默认上限几百条 → <50ms，远低于 30s 超时。
3. 快照滞后的失败方向本偏向「外部」（安全方向），但就地快照直接消除整类竞态，更值得。
4. `Attributor.toJSON/fromJSON`（FR-7.6）保留作为 daemon 重启时窗口状态的恢复通道，硬约束不浪费。

`background`（run_in_background 等价物）判定：CC Bash 工具的 `run_in_background` 参数直接出现在 `tool_input` 中，hook 原样透传，D5 语义（后台命令窗口永不关闭、窗内漂移一律 ambiguous）由 daemon 侧 Attributor 原样执行。

#### 5.5.3 静态分析复用

`analyzeBash/analyzePwsh` 在一期已是纯函数。hook 进程使用 esbuild 打包的**零依赖单文件**（`hooks/pre-tool-use-bash.js` 内联 core 静态分析 + 路径归一化，构建期 tree-shake 掉 watcher/diff 等重模块），保证 hook 启动 <200ms（node 冷启动为主）。

### 5.6 漂移注入（FR-3 落法，二期改动最大的部分）

#### 5.6.1 主通道：UserPromptSubmit

- daemon 侧：`DriftQueue` 有积压且通过 `shouldInjectAtUserPrompt()` 策略判定 → 归因 → budget 渲染 → 写 `pending/<sid>.json`。**渲染永远发生在用户发言之前**（漂移事件驱动，非请求驱动），hook 读到的永远是成品。
- hook 侧：读 pending → 存在且 `deliveredVia` 未含 `user-prompt-submit`（针对该 batchId）→ 打印 JSON，记录投递 → exit 0。任何异常 → 空输出 exit 0（fail-open）。
- 时效语义变化（相对一期）：一期是「下一个模型 step 前」；二期是「下一次用户发言时」。**turn 内 agent 连续多步工作期间产生的漂移，本 turn 不可达**——平台硬限制，文档明示。

#### 5.6.2 第二通道：Stop hook 补投（P2-D6，采纳预研建议）

**只投 `priority:"high"` 批次**（当前定义：AKB 跟踪文件被**删除/重命名**——agent 下一步大概率撞墙的场景）：

1. Stop hook 读 pending → `priority:"high"` 且 `deliveredVia` 为空 → 打印 additionalContext → 记录 `deliveredVia:["stop"]`。
2. 对话因此继续一个 step，模型看到漂移通知后自然收尾，Stop 再次触发 → 此时 `deliveredVia` 已标记 → 不再注入 → turn 正常结束。
3. **at-most-once 门控是硬要求**：spike #2 实测无门控时官方 8 连阻断才收停，白烧 9 轮 token。门控状态在 pending 文件 `deliveredVia`（hook 侧即可判），不依赖 `stop_hook_active`（实测首轮即为 true，语义不可单独依赖）。
4. Stop hook 的 additionalContext 在官方文档中的定性是「non-error feedback that continues the conversation」——与我们的用法完全匹配。
5. normal 批次不走 Stop：turn 结束后用户通常会再发言，UserPromptSubmit 是更低打扰的通道。

#### 5.6.3 已评估并放弃的通道

| 通道 | 放弃理由 |
|---|---|
| FileChanged hook | basename matcher、#63148 插件不触发、#44925 Bash 漏事件；且「触发动作」非「注入上下文」，语义不符 |
| SessionStart additionalContext 投漂移 | 只在会话边界触发，漂移发生在会话中途；保留用于静态概述（§5.6.5） |
| PreToolUse additionalContext（拦每个工具调用注入） | 打扰频率过高，且 PreToolUse 超时行为复杂（SDK callback 超时阻断工具）；与「单一注入点」原则冲突 |
| PostToolUse additionalContext | 官方支持，但每个工具结果都注入会把 notice 稀释进工具流水；仅作 Stop 的备胎（若 Stop 门控实测翻车，M5 重估） |

#### 5.6.4 注入消息协议（沿用一期 §5.6，两处修订）

- notice 头部自包含说明保留（一期决策：任何情境可独立解释，二期正好用上——CC 的 system-reminder 形态与 dsh 注入形态措辞完全一致，core/message 零改动）。
- **不写绝对时间戳**（E7：resume 时 transcript 重放历史注入，绝对时间戳会陈旧误导）。统一用「在你上次发言后」「在上一个 turn 期间」等相对表述；排序语义由批次顺序承担。
- 措辞保持事实陈述（官方文档明示命令口吻触发 prompt-injection 防线）——一期 message 模块已是此风格，复查一遍模板即可。

#### 5.6.5 冷启动对账与静态概述（FR-3.3 落法）

- **冷启动对账**：SessionStart（startup/resume/fork）注册后，daemon 对该会话执行 AKB 全量对账（core/reconcile），结果走正常 pending 通道，**首个 UserPromptSubmit 一并带出**。resume 时 AKB 状态从磁盘恢复，与 watcher 当前视野对账。
- **静态概述**（一期 promptSection 的 CC 等价物）：SessionStart hook 返回 ~90 token 的 `hookSpecificOutput.additionalContext` 静态文本（「工作区会在 agent 思考时变化、notice 是事实不是指令、三类归因行为约定」）。SessionStart 在 compact 后重跑（source:"compact"）→ 概述在压缩后自动复活，比一期的 systemPrompt section 更省（不占每请求固定开销）。fork/clear 同理覆盖。

### 5.7 预算与降级（FR-4 落法）

1. core/budget 令牌阶梯不变（默认单次 ≤2000 tokens）。
2. **新增字符红线（E4）**：渲染产物最终过一道 `text.length ≤ 9500` 检查；超线 → 整批降级为单行变更摘要（现有降级梯的最末档），并在摘要尾部注明「N 个文件变更被折叠」。
3. 9,500 的取值：官方文档承诺 10,000 字符上限，实测 2.1.258 阈值 ≈25,000 字节（文档滞后）；按承诺取值，实测余量是安全垫。**不依赖 spill 文件机制**——模型不主动 Read 就等于丢失（spike #1 实测）。

### 5.8 配置（FR-5 落法）

- 全局：`~/.claude/state/bright-drift/config.yml`，schema 与一期 `settings.yaml` 节同构（预算、ignore、黑名单、归因窗口参数），daemon 热监听（chokidar，~100ms 生效）。
- 项目级：`<repo>/.claude/bright-drift.yml`（对应一期 `.dsh/bright-drift.yml`，nodiff 黑名单落点）。
- 配置加载逻辑抽到 `packages/claude-code/src/shared/config.ts`，与一期 config.ts 的 schema 保持同步；如 schema 演进出现分叉，以 core 支持的超集为准。

### 5.9 安装器（P2-D9，对 #16288 免疫的主路径）

```bash
npx bright-drift-claude-code install [--project]   # 默认装用户级 ~/.claude/settings.json
npx bright-drift-claude-code uninstall
```

1. 读取目标 settings.json → 合并 `hooks` 节的 6 个条目（SessionStart/UserPromptSubmit/PostToolUse×1/PreToolUse/Stop/SessionEnd），exec form 指向 `node_modules/bright-drift-claude-code/lib/hooks/*.js` 绝对路径。**合并而非覆盖**：已有其他 hook 条目原样保留，按 `command` 字符串识别自家条目做幂等更新。
2. 写 `install.json` 版本戳 `{ version, installedAt, hooksPath, settingsTarget }`；每次 install 重跑即升级（换路径 + 刷版本戳）。
3. 自检：install 末尾 dry-run 一次 session-start hook（直接 spawn 执行），确认 node 可用、路径可达、daemon 能拉起；失败打印修复指引。
4. 卸载：摘除自家 hook 条目、停 daemon（读 lock pid 后 SIGTERM）、保留状态目录（`--purge` 才删）。
5. **插件 marketplace 形态推迟**（§2.2）：#16288 修复后，plugin.json + hooks.json 仅作为分发壳，hooks 内容由安装器同款逻辑生成。
6. 合规预留：未来走 marketplace 时 hooks 命令必须全部 `${CLAUDE_PLUGIN_ROOT}` 相对路径（2026-08 官方审核新规），hooks 代码不引用任何宿主机绝对路径。

### 5.10 命令与可观测性（FR-6 落法）

一期 dsh 有 `/bright-drift status|diff|nodiff|pause|resume`。CC 侧：

- **斜杠命令**：二期通过安装器向 `~/.claude/commands/bright-drift/` 写入命令 markdown（frontmatter `allowed-tools` 放开一次 `!` 执行），命令体调用 `node .../lib/cli/status.js` 读状态目录渲染。**nodiff 子命令**直接改项目级 `.claude/bright-drift.yml`，daemon 热加载——与一期体验对齐。
- **pause/resume**：写 `workspaces/<hash>/paused` 标记文件，daemon 暂停渲染 pending（监控继续）；resume 删除标记，积压漂移一次性补投——语义与一期完全一致。
- **日志**：`logs/<date>.log`，同一期纪律（只记哈希/路径/计数，不记内容）。

---

## 6. 边界情况清单（相对 PRD §4.4 的二期增量）

| # | 场景 | 处理 |
|---|---|---|
| B1 | 多个 CC 会话同开同一工作区 | daemon 集中管理（PRD R6 重估兑现）：watcher 共享，每会话独立 AKB/pending；归因窗口按会话隔离（各会话只对自己发起的 Bash 开窗） |
| B2 | 同一会话并发两个 Bash（run_in_background） | Attributor 支持多窗口并存（一期已测）；后台窗口永不合拢，窗内漂移一律 ambiguous（D5） |
| B3 | daemon 崩溃后漂移积压 | watcher 视野随 daemon 一起丢；恢复后冷启动对账兜底——对账本身能发现「AKB 与磁盘的全部差异」，只是失去逐事件归因（全部按外部变更报告，安全方向） |
| B4 | 用户手动 kill daemon | 同 B3；下个 SessionStart 惰性拉起 |
| B5 | hook 读到半截 pending（daemon 写入中） | 全部状态文件**原子写**（tmp + rename）；hook 读失败/JSON 解析失败 → 空输出退出 |
| B6 | 工作区在 git worktree / symlink 下 | ws-hash 用 realpath 归一化后的 cwd 计算（与 core/watcher 的路径规约一致） |
| B7 | resume 重放陈旧注入 | 注入文本禁绝对时间戳（§5.6.4）；重放的历史 notice 是既成事实记录，语义无害 |
| B8 | compact 后 SessionStart 重跑 | 静态概述重新注入（§5.6.5）；AKB/pending 不受影响（daemon 持有，compact 不碰磁盘状态） |
| B9 | Windows 无 Git Bash | hooks 一律 exec form（node 直起），不经 shell；daemon detached 用 `windowsHide` |
| B10 | node 不在 PATH | 安装器自检发现即报错并给修复指引；运行期 hook 起不来 = fail-open |
| B11 | 用户从正在受监控的工作区里 uninstall | 卸载先停 daemon 再摘 hooks，顺序保证无残留注入；状态目录默认保留 |
| B12 | 超长命令（>10s）窗内用户改文件 | ambiguous-external，措辞含命令假设——Attributor 现有逻辑原样复用（一期 T10 场景） |

---

## 7. 测试矩阵（二期增量，一期 core 测试不动）

| # | 测试 | 场景 | 预期 |
|---|---|---|---|
| P2-T1 | 端到端漂移注入 | headless 会话中外部修改 AKB 文件 → 下一轮 `-p --continue` 发言 | 注入含文件清单 + 行级 diff，归因 EXTERNAL |
| P2-T2 | 回声抑制 | agent 用 Edit 改文件 | 无注入 |
| P2-T3 | 命令归因 | agent 执行 Bash `python gen.py` 改写 AKB 文件 | COMMAND-SIDE-EFFECT 类，含命令原文（对齐一期 T9） |
| P2-T4 | 长命令歧义 | 15s 命令窗内用户改文件 | ambiguous-external（对齐一期 T10） |
| P2-T5 | daemon 幂等 | 同工作区连续 3 次 SessionStart | 仅一个 daemon 进程，锁文件正确轮换 |
| P2-T6 | daemon 崩溃恢复 | kill daemon → 修改文件 → 新会话 SessionStart | 冷启动对账报告全部差异（归因退化为外部） |
| P2-T7 | Stop 补投门控 | AKB 文件被删除 → turn 结束 | Stop 注入恰好一次，对话继续一轮后正常收停（不重拉 9 次） |
| P2-T8 | 字符红线 | 构造 >9,500 字符渲染产物 | 降级为单行摘要，无 spill 文件指针形态出现 |
| P2-T9 | 慢 daemon | mailbox 消费延迟 5s | hook 侧无感（热路径不依赖 mailbox），UserPromptSubmit <10ms |
| P2-T10 | fail-open 矩阵 | 状态目录只读 / pending 截断 / daemon.lock 残留死 pid | 会话全部正常继续，日志有记录 |
| P2-T11 | 多会话同工作区 | 两个 sid 并发，各自改/删不同文件 | 各自 pending 隔离，互不串扰 |
| P2-T12 | 安装器 | install ×2（升级）/ uninstall / 与已有第三方 hooks 共存 | 幂等、合并不覆盖、卸载干净 |

测试形态：沙盒项目 + headless `claude -p`（预研 spike 已验证该形态 hooks 全量生效），CI 可用同形态跑 P2-T1~T10；T11/T12 本机脚本。

---

## 8. 里程碑（修订 PRD §6.3，维持 3 周预估）

- **M4（第 1 周）骨架打通**：shared 状态协议 + daemon 生命周期（拉起/幂等/自退）+ 安装器 settings 注入 + UserPromptSubmit 读 pending 全链路（先用固定文本「hello drift」打通，再接 core）。**出口判据**：P2-T5/T10 通过。
- **M5（第 2 周）功能对齐**：watcher/AKB/归因/预算全量接入，Stop 补投与门控，冷启动对账，静态概述。**出口判据**：P2-T1~T4/T7/T8/T11 通过，FR-1~FR-4 体验与一期对齐。
- **M6（第 3 周）打磨发版**：斜杠命令、pause/resume、README（与 FileStateCache 互补说明 + CLI-only 明示）、`bright-drift-claude-code` 上 npm、与一期统一版本号发版；#16288/#87657 状态重估（决定是否补插件 marketplace 形态）。

**M4 开工即做**：packages/claude-code 骨架 + esbuild hook 单文件打包管线（hook 冷启动预算 200ms 是后续所有 hook 侧决策的约束，先立起来）。
