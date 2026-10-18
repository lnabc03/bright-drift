# bright-drift × Claude Code 2.1.300 兼容性排查报告

> 范围：仅 `bright-drift-claude-code`（CC 适配器：hooks + daemon + installer）。`core` 与 dsh 适配器本轮已审，不重复。
> 排查日期：2026-10-18
> 目标运行时：`@anthropic-ai/claude-code` **2.1.300**（npm 全局安装，`claude --version` 核实；2026-10-14 发布，2.1.297/2.1.298 未发布）
> 基线：适配器开发验证环境 **2.1.258**（`bright-drift-design-phase2.md:5`，2026-09-02）
> 本机 Node v24.12.0（hook 进程实际使用的 node）/ Windows 11
> 结论：**0 个 P0、0 个 P1**。适配器在 2.1.300 上**全链路实测工作**（安装 → 会话 → 外部改动 → 注入 → 卸载），**17 个接触面逐一核对通过**。4 个 P2 跟进项（均为语义漂移或既有缺口，非本次升级引入的破坏）。

---

## 0. 一句话结论

`bright-drift-claude-code` 0.4.0 装到 CC 2.1.300 上**能装、能跑、能注入、能卸**，三条注入通道（SessionStart 静态概览、UserPromptSubmit 主通道、Stop 高优先级补投）全部实测到达模型，at-most-once 门控与 Sync Point 提交均正确。最大的形态变化是 **CC 已从 JS bundle 转为 270MB 原生 exe 分发**（Bun 编译），以及 hook 契约在 2.1.259–2.1.300 间的演进**全部是加固与修复、无一破坏我们依赖的契约**。需要跟进的都是既有缺口（归因窗口在工具失败时不关闭）或注释级漂移。

实测证据（隔离项目目录 + `BRIGHT_DRIFT_STATE_HOME` 重定向，全程未触碰用户 `~/.claude` 的任何配置文件）：

```
# 外部修改 note.txt 后 resume 同一会话，模型未读文件即答出改动内容：
- 新增内容：在原有 `hello drift` 一行之后追加了 `externally edited line`。
# 外部删除后，Stop 补投通道投递高优先级批次，模型确认：
收到变更通知：`note.txt` 已被外部删除（EXTERNAL·DELETED，高置信度）。我不会重新创建或恢复它。
# pending 文件证明门控：
{"batchId":"drift-mvdgm2gu-13bc91","priority":"normal","deliveredVia":["user-prompt-submit"], ...}
{"batchId":"drift-mvdgmo2h-f54767","priority":"high","deliveredVia":["stop"], ...}
```

---

## 1. 排查方法与证据强度

| 手段 | 说明 | 证据档位 |
|---|---|---|
| 官方文档全文（2026-10-18 抓取） | `code.claude.com/docs/en/hooks.md`（273KB hooks 参考全文）、`settings.md`、`headless.md` 落盘后逐节核对 | **实测/官方文档** |
| 二进制字符串抽取 | 2.1.300 起 CC 分发为 Bun 编译的 `claude.exe`（`node_modules/@anthropic-ai/claude-code-win32-x64/claude.exe`，270,863,520 字节）。JS 源码内嵌可抽：提取了**全部 34 个 hook 事件的 zod 输入 schema**、22 个 `hookSpecificOutput` 输出变体、hook 配置 schema、超时常量、10,000 字符阈值常量 | **静态核实**（二进制内嵌源码，非记忆） |
| 官方 CHANGELOG 全量 diff | 2.1.258→2.1.300 逐版本（用户提供官方 CHANGELOG.md；二进制内嵌 changelog 交叉验证 2.1.289–2.1.296） | **静态核实** |
| GitHub issue 状态复核 | `gh issue view 16288 / 87657 --repo anthropics/claude-code` | **实测** |
| **运行时端到端** | 隔离临时项目 `%TEMP%\cc-audit\rt` + 项目级 `.claude/settings.json`（不动用户配置）+ `BRIGHT_DRIFT_STATE_HOME` 隔离状态。两段：(a) 契约探针 hook 抓取六个事件的**真实 stdin JSON**；(b) 适配器 `install --project` → 真实 `claude -p` 会话 → 外部改动 → `--continue` 恢复 → 注入验证 → 外部删除 → Stop 补投验证 → `uninstall --project` 验证 | **实测** |

证据档位约定：**实测** = 本机 2.1.300 上跑出来的；**静态核实** = 官方文档或 2.1.300 二进制内嵌源码直接证据；**推断** = 由前两者合理外推（报告中单独标注）。

### 1.1 一个方法论前提变化：CC 不再有可读源码

2.1.258 时代的 `cli.js` minified bundle 已消失。2.1.300 的 npm 包（`@anthropic-ai/claude-code@2.1.300`，unpacked 仅 ~189KB）只剩 `bin/claude.exe` 壳 + `install.cjs` + `cli-wrapper.cjs` + `sdk-tools.d.ts`；真正的程序在 per-platform optionalDependency（win32-x64 为 270MB Bun 单文件 exe）。**对契约核查的影响可控**：Bun 编译保留全部字符串字面量与 zod schema 文本（含 `.describe()` 文档注释），本报告所有 schema 引用均直接抽自该 exe。但这意味着**"升级前 diff 相邻版本 cli.js"的旧做法失效**，替代防线见 §7。

---

## 2. 发现清单

**P0（装了不工作/破坏环境）：无。**
**P1（契约变化导致行为降级）：无。**

### P2-1 失败/被打断的 Bash 调用不关归因窗口（既有缺口，契约现已明确）

**证据（静态核实）**：官方文档明确 `PostToolUse` 只在工具**成功**后触发（hooks 参考 §PostToolUse："fire after a tool has already executed successfully"）；工具抛错/MCP 错误走 `PostToolUseFailure`（2.1.89 起存在），权限被拒走 `PermissionDenied`（2.1.89 起存在）。我们的 `post-tool-use.ts:28-36` 只在 PostToolUse(Bash) 发 `window.close`；`pre-tool-use-bash.ts:51-61` 的 `window.open` 在 PreToolUse 就开了。core 的归因窗口**无超时**（`core/src/attribution/attributor.ts:87`，前后台窗口关闭时间都是 `Number.MAX_SAFE_INTEGER`）。

**影响**：Bash 命令被用户拒绝、被打断（Esc）、或工具级失败时，窗口永久敞开 → 此后该会话内的外部改动会被错归为 `COMMAND-SIDE-EFFECT`（B 类）而非 `EXTERNAL`（C 类）——**方向与 PRD §3.6 的不对称偏向原则相反**（歧义应偏向外部）。概率低（需窗口开着 + 恰好有外部改动），但语义上是我们最在意的归因正确性。此缺口在基线 2.1.258 同样存在，非 2.1.300 引入。

**最小修复方向**（供后续 PR）：installer 增订 `PostToolUseFailure`（matcher `Bash`）与 `PermissionDenied`（matcher `Bash`）两个事件，复用现有 `post-tool-use.js` 的 `window.close` 分支（payload 字段同构：`tool_name`/`tool_input`/`tool_use_id`，已核实二进制 schema `hook_event_name:C("PostToolUseFailure")` / `C("PermissionDenied")`）。hooks 数从 6 变 8（install.ts 注释同步）。

**回归测试建议**：hook 级测试模拟 `PostToolUseFailure` stdin → 断言 mailbox 出现 `window.close`；engine 级断言窗口关闭后外部改动归 C 类。

### P2-2 Windows 下 daemon 被 SIGTERM 强杀，清理路径不执行（既有行为，实测确认）

**证据（实测）**：`install.ts:248-270` `stopDaemons()` 用 `process.kill(pid, 'SIGTERM')`；Node 在 Windows 上把 SIGTERM 映射为 `TerminateProcess`，daemon 的 `process.on('SIGTERM')` 清理（`main.ts:122-130` 删 `daemon.lock`/`workspace.json`）**不会执行**。本次实测 uninstall 后：进程确实消失（37728 gone），但 `workspace.json` 与 `pending/*.json` 残留，日志无 `daemon exit` 行。

**影响**：无实际危害——`ensureDaemon`（`daemon-launch.ts:54-95`）的 `pidAlive` 检查与新 daemon 的 stale 自检（`main.ts:83-91`）使残留自愈合；`--purge` 可整体删除。但这是"清理路径从未在 Windows 上被真实执行过"的实测确认，AGENTS §5.4 的措辞（"杀 daemon 用 PowerShell Stop-Process"）针对的是人工操作，installer 这条路径同样命中。

**最小修复方向**：可不改（自愈合已覆盖）；若要做干净，installer 在 Windows 上先向 mailbox 投一条 `session.ping` 之外的新消息类型（如 `daemon.shutdown`）让 daemon 自杀，超时再强杀。**不建议为此引入新消息类型**——记录即可。

### P2-3 子代理的工具事件并入主会话 AKB（语义注意项）

**证据（静态核实）**：官方文档 §Hook locations："Hooks from settings files… also run inside subagents"，输入带 `agent_id`/`agent_type` 字段（hooks 参考 §Common input fields）。我们的 `post-tool-use.ts` 不读 `agent_id`，子代理的 `Read`/`Edit` 会以主会话 `session_id` 进 AKB。

**影响**：子代理读文件会把该文件基线刷新为"已读"——基线保鲜方向正确（文件此刻的内容确实是最新的），但严格说主线程模型并未看到内容。归因方向不受影响（子代理的写本就应归 agent 侧）。**基线 2.1.258 同样如此**，非回归。

**修复方向**：不建议改。若未来要精确，可在 mailbox `akb.observe` 消息里透传 `agent_id` 并让 engine 对子代理 read 只做"内容快照"不标"模型已见"——属于 core 语义扩展，与本次兼容性无关。

### P2-4 注释引用的文档说法已过时（注释级漂移）

**证据**：`post-tool-use.ts:45` 注释 "The docs warn file_path may be relative"。现行官方文档（§PostToolUse input）明确："File-tool `tool_input` paths arrive … **always absolute**, with the platform's native separators, so backslashes on Windows"。

**影响**：零（相对路径兜底逻辑无害，仍防未知工具）。**修复**：改注释，顺手把"实测 2.1.300 文档"写进注释日期。

---

## 3. 接触面矩阵（17 项全部通过）

| # | 接触面 | 我方使用点 | 我们假设的契约 | CC 2.1.300 实际 | 状态 | 证据 |
|---|---|---|---|---|---|---|
| 1 | settings.json hooks 注入形态 | `installer/install.ts:50-70` | `{hooks:{Event:[{matcher?,hooks:[{type:"command",command,args?}]}]}}`；多层合并 | 未变；官方文档 §Hook locations 明确 hooks 跨层级 **merge 而非替换**；settings 文件热重载（"picked up automatically by the file watcher"） | ✅ 实测 | install→settings.json 写入、CC 会话内触发全部成功；文档 §Configuration |
| 2 | exec form（`command`+`args` 不经 shell） | `install.ts:51-56` | `args` 存在则直接 spawn 可执行文件 | 未变且有官方背书："The `node` plus script-path pattern works on every platform because `node.exe` is a real binary"（§Exec form and shell form）——正是我们的形态；中文路径 `D:\个人文档\…` 实测无引号/编码问题 | ✅ 实测 | 文档 §Command hook fields；schema `Am()`（`args:T(o()).optional()` "no shell"） |
| 3 | 六事件存在性与拼写 | `install.ts:32-39,58-69` | SessionStart/UserPromptSubmit/PostToolUse/PreToolUse/Stop/SessionEnd | 全部存在（2.1.300 共 34 个事件，全集见 §4） | ✅ 实测 | 二进制事件并集 schema；探针六事件全部触发 |
| 4 | stdin 公共字段 | `shared/hook-io.ts:29-37` | `session_id`、`cwd` 必有；`transcript_path` 可用 | 未变。公共字段 = `session_id/transcript_path/cwd/prompt_id?/permission_mode?/effort?/hook_event_name/agent_id?/agent_type?`（新增 `prompt_id`/`effort`，我们不读，无影响） | ✅ 实测 | 探针抓取的真实 payload（§9）；二进制基座 schema `O=f(()=>u({session_id,…}))` |
| 5 | SessionStart 输入（`source`/`transcript_path`） | `hooks/session-start.ts:24-37` | `source ∈ startup/resume/clear/compact` | 实际枚举多一个 **`fork`**（`["startup","resume","clear","compact","fork"]`；fork 自 2.1.214，早于基线）；我们按 string 透传，天然兼容 | ✅ 实测 | 二进制 `t0` schema；探针 payload `source:"startup"` |
| 6 | SessionStart `async:true` + additionalContext | `install.ts:58`、`session-start.ts:41-43` | async 后台不阻塞；其 additionalContext 仍能进上下文 | **成立**：async hook 的 `additionalContext`/`systemMessage` 在进程退出后"delivered on the next conversation turn"（§How async hooks execute）；首个响应会等 SessionStart hook（§SessionStart）；单行 JSON 无版本约束（多行 JSON 需 ≥2.1.295，我们单行） | ✅ 实测 | 静态概览文本出现在会话 1 transcript 并进入模型首条消息（§9）；2.1.295 changelog 修复项反证该通道存在 |
| 7 | UserPromptSubmit additionalContext 主通道 | `hooks/user-prompt-submit.ts` | `hookSpecificOutput.{hookEventName,additionalContext}` 随 prompt 进上下文 | 未变；渲染形态为 `<system-reminder>`，transcript 落 `hook_additional_context` 附件 | ✅ 实测 | 探针标记 `PROBE_MARKER_UPS_7312` 进入发给模型的消息体（§9） |
| 8 | Stop 补投 + `stop_hook_active` 防环 | `hooks/stop.ts` | Stop 支持 additionalContext 且对话继续；`stop_hook_active` 首个 Stop 即为 true（spike #2），故我们用 `deliveredVia` 门控 | 全部成立：Stop additionalContext 使对话继续、转录标注 `Stop hook feedback`；实测 payload `stop_hook_active:true`；8 次连续 continuation 上限仍在（`CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` 可调），**工具调用会重置计数**（探针跑了 20+ 次 Stop 未封顶，与文档一致）——证明我们的 at-most-once 门控是唯一可靠防环 | ✅ 实测 | 高优先级删除通知经 Stop 到达模型且只投一次（§9）；文档 §Stop |
| 9 | stdout JSON 解析契约 | `shared/hook-io.ts:20-26` | stdout 整个输出是单个 JSON 对象即被解析；fail-open 时什么都不打印 | 未变（§Exit code 0 解析规则）；**注意**：UserPromptSubmit/SessionStart/UserPromptExpansion/PostModelSwitch 的**纯文本 stdout 会被当作上下文注入**——我们的 fail-open 路径打印空串，安全 | ✅ 实测 | 探针+适配器双验证；文档 §Exit code 0 |
| 10 | 注入尺寸上限（E4 红线 ≤9,500 字符） | `shared/config.ts:79`、`daemon/render.ts:261` | 官方承诺 10,000；2.1.258 实测阈值 ≈25KB | **阈值收紧到正好 10,000 字符**（二进制常量 `g$s=1e4`，`Uue()` 对 `additionalContext`/`systemMessage`/`initialUserMessage`/纯文本 stdout 逐字段计量；超线写会话目录文件 + 2,000 字符预览，**CC 不会叫模型去读该文件**）。我们的 9,500 仍合规，安全垫从 ~15KB 缩到 500 字符 | ✅ 静态核实 | 二进制 `g$s=1e4`；文档 §JSON output / §Add context for Claude |
| 11 | 超时表 | 各 hook 注释 | UPS 30s；SessionEnd 共享 1.5s；其余 600s | **完全未变**：command 默认 600s（二进制 `ou=600000`），UPS 降为 30s，SessionEnd 共享 1.5s（二进制 `Kus=1500`，可按 per-hook timeout 抬到 60s 上限 `Xzr=60000`；`CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS` 覆盖）；async:true 不受 timeout 约束 | ✅ 静态核实 | 文档 §Common fields/§SessionEnd；二进制常量 |
| 12 | exit code 语义 | `shared/hook-io.ts:43-51` | 恒 exit 0 = 成功放行 | 未变；exit 2 = 阻塞（我们永不用）；新增 `onFailure:"block"`（2.1.295）我们不用——fail-open 是验收项，保持默认 `continue` | ✅ 静态核实 | 文档 §Exit code output / §Exit code 2 behavior per event |
| 13 | resume/compact 重放（禁绝对时间戳的依据） | `daemon/render.ts`（相对表述） | 历史注入在 resume 时被重放 | **仍然成立且被文档固化**："Claude Code saves the injected text in the session transcript… resume 时 replay the saved text rather than re-running the hook… values like timestamps become stale"（§Add context for Claude）。**红线维持**。补充实测：2.1.295 修复了"async SessionStart 不变 context 在每次 resume 重复注入"——我们的静态概览 resume 时不再重复落地，但原文随 transcript 重放仍可见（实测 transcript 中概览仅 1 次注入记录、跨 resume 可见） | ✅ 实测 | 文档 §1146 行；transcript 检查（§9） |
| 14 | daemon 生命周期（detached 存活 / CC 退出后残留） | `shared/daemon-launch.ts:76-95` | detached+unref 的 daemon 存活于会话之外；30min 空闲自退 | 未变；官方文档甚至给出同款建议："If your hook's work must outlive a `claude -p` session, start a fully detached process from it"（§Run hooks in the background）。实测 daemon 在 `-p` 会话退出后存活、uninstall 后被杀 | ✅ 实测 | 进程检查 + daemon 日志（§9）；文档 |
| 15 | `CLAUDE_CONFIG_DIR` 重定向 | `shared/paths.ts:10-12` | CC 官方支持 | 官方确认（settings 文档："set `CLAUDE_CONFIG_DIR`; Claude Code then stores your settings, session history, and plugins there"） | ✅ 静态核实 | settings.md §440 |
| 16 | Windows 杀进程方式 | `install.ts:262` | `process.kill(pid,'SIGTERM')` | 能杀死（实测），但 daemon 清理不执行（见 P2-2）。2.1.293 修复了"杀 hook/命令误杀同 PID 无关进程"，对我们无影响 | ✅ 实测 | §9 uninstall 验证 |
| 17 | headless `-p` 下 hooks 照常触发 | 全部 hook | `-p` 触发 SessionStart/UPS/工具/Stop/SessionEnd | 未变（`--bare` 除外，见 §4 注意项）；`-p` 无信任对话框即运行项目 settings hooks（文档 §Workspace trust）。**实测六事件全部触发**；注意 `-p` teardown 会砍未完成的 async hook（outcome `cancelled`）——我们的 session-start hook 实测 ~100ms 内完成，无虞 | ✅ 实测 | 探针 events.log 时间线（§9）；文档 §Run hooks in the background |

### 关于 core 与 dsh 适配器

本次未审（按要求）。间接说明：core 被 CC 包消费的部分（`analyzeCommand` 静态分析、归因状态机）不接触任何 CC 契约；本次唯一与 core 相关的接触面是归因窗口生命周期（P2-1），那是 adapter 订阅面缺口，不是 core 缺陷。

---

## 4. CC 版本 delta：2.1.258 → 2.1.300

**基线证据**：`bright-drift-design-phase2.md:5`"验证环境：Claude Code 2.1.258 / Windows 11；官方文档…（2026-09-02 defuddle 全文复核）"。**2.1.297/2.1.298 未发布**（npm 与 GitHub release 均从 2.1.296 直跳 2.1.299，2026-10-14）。`stable` dist-tag 当前在 2.1.292，`latest` 在 2.1.300。

### 4.1 与我们直接相关的变更

| 版本 | 变更 | 对我们的影响 |
|---|---|---|
| 2.1.299 | **UserPromptSubmit hooks 改为先于 skill/slash 命令展开执行**（"a hook that blocks the prompt now also stops its embedded shell commands"） | 无负面影响：我们的 UPS hook 只读 pending 文件。我们的 `/bright-drift-*` 斜杠命令的 `!`…`` 内联执行在展开阶段，晚于 UPS——语义不变 |
| 2.1.299 | 新增 **idle compaction**（`idleCompaction` 设置；空闲 ~54 分钟且 >200K tokens 时自动压缩） | 压缩后 SessionStart 以 `source:"compact"` 重跑——我们的会话重注册与静态概览重落地路径已覆盖该 source（实测 resume 同理）；PreCompact `auto` matcher 命中此触发 |
| 2.1.299 | Windows：无 Git Bash 时 shell-form PreToolUse/PermissionRequest hook 失败从放行改为阻塞 | 无影响：我们是 exec form（不经 shell） |
| 2.1.296 | 修复 headless 会话中 UPS hook 期间 Esc/中断导致 prompt 绕过检查；修复 hook 输出含 plugin hint tag 样文本被改写 | 无影响（前者是交互修复；我们的注入文本不含 plugin tag） |
| 2.1.295 | **新增 `onFailure:"block"`**；修复 **async SessionStart hook 的不变 context 在每次 resume 重复注入**；修复 async hook 多行 JSON 输出被忽略；CLAUDE_ENV_FILE 若干修复 | 概览在 resume 时去重 = 实测符合（见矩阵 #13）；我们单行 JSON，不受多行修复影响；不用 onFailure/CLAUDE_ENV_FILE |
| 2.1.293 | Windows：修复停止 status line/hook/shell 命令时误杀 PID 复用的无关进程 | 正面：daemon 环境更安全 |
| 2.1.292 | hook 输出中的 `<system-reminder>` 标签在到达模型前转义 | 无影响：我们的渲染产物不含该标签（若未来渲染文本包含用户文件内容碎片，此转义是**对我们有利**的防注入加固） |
| 2.1.300 | 修复后台命令运行时退出导致 SessionEnd hook 不触发 | 正面：我们的 `session.deregister` 更可靠 |

### 4.2 事件面扩张（2.1.258 时未评估或不存在，按官方 CHANGELOG 追溯引入版本）

2.1.300 共 **34 个 hook 事件**（二进制事件并集 schema 实测）。我们用 6 个。其余事件中，引入版本可追溯的：ConfigChange（2.1.49）、InstructionsLoaded（2.1.69）、StopFailure（2.1.78）、FileChanged/CwdChanged（2.1.83）、PermissionDenied/TaskCreated（2.1.89）、PostToolUseFailure（≤2.1.119，当版已有）、MessageDisplay（2.1.152）、PreModelSwitch/PostModelSwitch（2.1.251）、SubagentStart（2.0.43）；PostToolBatch、UserPromptExpansion、TeammateIdle、Elicitation/ElicitationResult、WorktreeCreate/Remove、Setup、PostCompact、StopFailure 等在 259–300 区间无 "Added" 记录（早于基线或文档补录）。**即：34 个事件在 2.1.300 没有一个会破坏我们——破坏只可能来自"我们依赖的 6 个被改"，而它们全部被 §3 实测/静态核实通过。**

### 4.3 平台形态与两个历史 issue 复核

| 事项 | 基线记录（phase2 §2.2 / AGENTS §5.6） | 2.1.300 现状 | 结论 |
|---|---|---|---|
| #16288 插件 `hooks/hooks.json` 发现损坏 | OPEN，阻塞插件市场形态 | **仍 OPEN**（`gh issue view 16288`：CLI loader bug 未修；评论显示 Cowork 桌面侧 convention-based 加载工作，但原报告的 CLI 路径未修） | **维持 settings.json 注入形态不变** |
| #87657 桌面端/Agent SDK 不加载 hooks | OPEN，"桌面端不加载 hooks" | **仍 OPEN，但题述已被报告者自我修正**为"per-session 间歇性 0 hooks"（非全量不加载）；2026-09-10 有 macOS 复现评论。VS Code 扩展侧官方文档称 hooks 各端均触发，但 issue 未关 | 措辞修正：从"不加载"改为"**间歇性不加载（桌面/Agent SDK 会话）**"；CLI-only 定位维持 |
| 官方插件/市场形态 | 被 #16288 阻塞 | 仍阻塞；且 2.1.x 出现了"mod"（插件内 JS 函数 hooks，`claude plugin validate/test`）新形态——与我们的 daemon/文件协议架构不兼容，**不构成替代路径** | 不变 |

---

## 5. 新特性机会评估（逐条"采用/不采用 + 理由"）

| # | 特性（引入版本） | 评估 | 理由 |
|---|---|---|---|
| N1 | **FileChanged 事件 + SessionStart/CwdChanged 输出的 `watchPaths`**（2.1.83） | ❌ **不采用** | 官方原生文件监听，"no matter what changed the file… or a process outside Claude Code entirely"（§FileChanged），看似我们的替代品。但：(a) watch list 是**逐文件字面名**（matcher 按 `|` 拆成工作目录内的字面文件名）或绝对路径数组，**无递归、无 glob、无 ignore 语义**——我们要的是全树递归 + gitignore + 10 万文件规模；(b) 每次变更起一个 hook 进程，规模上不可行；(c) FileChanged 无 decision control、输出不进模型上下文（只有 systemMessage 闪现）——不是注入通道。定位类似 dsh 核查的 A5（`ctx.fs.watch`）：官方能力粒度不符，继续用 chokidar daemon |
| N2 | **PostToolUseFailure / PermissionDenied 事件**（≤2.1.119 / 2.1.89） | ✅ **采用**（P2-1 的修复） | 补上"失败/被拒的 Bash 不关归因窗口"缺口，matcher `Bash`，复用 `window.close` |
| N3 | PostToolUse 的 `additionalContext`（"next to the tool result"） | ❌ 不采用 | 按工具调用注入会破坏"轮边界注入 + 按 batchId at-most-once"的 Sync Point 纪律（phase1 §5.5.4 同款结论）；UPS+Stop 双通道已够 |
| N4 | `asyncRewake`（后台 hook exit 2 唤醒模型） | ❌ 不采用 | 唤醒语义依赖 exit 2 + stderr，粒度是"一 hook 一消息"，无批量/门控概念；我们的 Stop 补投实测可靠 |
| N5 | SessionStart `initialUserMessage`（`-p` 专用）/ `sessionTitle` / `reloadSkills` | ❌ 不采用 | 与漂移通知无关 |
| N6 | PreCompact / PostCompact | ❌ 不采用（现状已够） | 压缩后 SessionStart(`source:"compact"`) 已重跑我们的注册+概览；无需额外钩子 |
| N7 | `onFailure: "block"`（2.1.295） | ❌ 不采用 | 与 fail-open 红线（AGENTS §2.4）根本冲突；默认 `continue` 正是我们要的 |
| N8 | HTTP hooks / prompt hooks / agent hooks / MCP tool hooks | ❌ 不采用 | 我们的红线之一是"不发起网络请求"（AGENTS §6）；prompt/agent hook 需要调模型，与"hook 不消耗模型"设计相反 |
| N9 | `--bare` 模式（跳过一切 hooks） | ℹ️ 记录 | 用户加 `--bare` 时我们完全不工作——这是 CC 的预期行为，README/FAQ 值得一句话说明 |
| N10 | statusline / `terminalSequence` / OTel hook 事件 | ❌ 不采用 | 与核心功能无关；OTel 的 `hook_execution_complete` 带 `additional_context_chars` 等字段，调试时可用，不进产品 |
| N11 | `claude plugin` mod 形态（JS 函数 hooks、`claude plugin test/validate`） | ❌ 不采用 | mod 在 CC 进程内跑 JS，与我们"独立 daemon + 文件协议"架构不兼容；且 #16288 未修，市场形态仍不可用 |
| N12 | CwdChanged（2.1.83，`cwd` 跟随 worktree/cd） | 🟡 记录，不采用 | hook 输入的 `cwd` 在会话进入 worktree 后变为 worktree 根（官方文档明确 `${CLAUDE_PROJECT_DIR}` 不动、`cwd` 跟随）——我们的 `wsHash(realpath(cwd))` 会把 worktree 当作新工作区起第二个 daemon。语义可接受（worktree 是另一棵树），暂不动作；若未来要"主检出 daemon 覆盖 worktree"，CwdChanged 是入口 |

---

## 6. 迁移方案

**无需迁移。** 与 dsh 0.2.0 那轮（配置通道整体重写）不同，本次没有任何契约破坏：

- 不需要改代码来"恢复工作"——它本来就工作（§0 实测）。
- 建议的**可选**动作（均不阻塞发版，按优先级）：
  1. **P2-1 修复**（half-day）：installer 增订 `PostToolUseFailure` + `PermissionDenied`（matcher `Bash`）→ `window.close`；补 hook 级与 engine 级测试。这是唯一建议进代码的项。
  2. **P2-4 注释修正**（分钟级）：`post-tool-use.ts:45` 注释改为引用 2.1.300 文档的"always absolute"表述。
  3. **文档措辞**：AGENTS §5.6 的 #87657 描述改为"间歇性 0 hooks（桌面/Agent SDK），issue 仍 OPEN"；README 补 `--bare` 说明。
  4. 版本标注：phase2 设计文档抬头补一行"2.1.300 复核通过（2026-10-18，见 docs/bright-drift-cc-2.1-compat-audit.md）"。

---

## 7. 建议的新防线（CC 没有 .d.ts 的替代方案）

dsh 那轮的防线是"真实 .d.ts 类型契约测试"；CC 侧没有类型产物（`sdk-tools.d.ts` 只有 SDK 工具类型，无 hook schema），且 2.1.300 起连可读 JS bundle 都没了。建议三层替代：

1. **真实 stdin 契约 fixture + schema 快照单测**（本次已产出原料）：把 §9 探针抓取的六事件真实 payload 脱敏后存为 `packages/claude-code/test/fixtures/hook-inputs/*.json`，给 `hookContext()`/各 hook 的字段读取写快照断言。防"字段改名/消失"类破坏。
2. **`claude -p` 契约冒烟脚本**（本次手法的脚本化，~3 分钟）：隔离项目目录 + 项目级 settings + 标记字符串探针（§9.1 的完整流程），断言 (a) 六事件 stdin 落盘、(b) transcript 里出现三条 marker、(c) 高优先级批次 `deliveredVia` 含 `stop`。每次 CC 升级后跑一次。这是唯一能抓"async SessionStart 不再投递"这类**运行时语义**破坏的层。
3. **升级前 changelog 机械核对清单**：CC 升级时先 `grep -i hook CHANGELOG.md`（官方 CHANGELOG 很规矩），命中我们六事件名/additionalContext/timeout/exit code 的条目逐条过 §3 矩阵。配合一条 strings 抽取命令（§9.3）可从 exe 直接验证事件并集与输出变体集合是否变化——`hook_event_name:C("…")` 与 `hookEventName:C("…")` 两个全集 diff 即得事件面增删。

## 8. 残余风险（静态核对通过，但需条件触发才能完全兑现）

| # | 风险 | 判断依据 | 建议 |
|---|---|---|---|
| R1 | **交互式会话**（非 `-p`）未实测。差异点：交互式有 workspace trust 门槛（未信任的文件夹**所有 settings 层级的 hook 都暂缓**，含用户级）；"首个响应等待 SessionStart hooks"的等待语义只在交互式 | 文档 §Workspace trust；基线 2.1.258 交互式已验过，本区间无相关破坏记录 | 下次发版前在交互式会话跑一次 T 矩阵冒烟 |
| R2 | 多 hook 并行语义下，我们与用户其它 UPS hook 的执行顺序不定（"All matching hooks run in parallel"）——若用户的 hook 写 pending 同路径…… | 不会：pending 路径按 `bright-drift` 状态目录隔离，并行只影响时序不影响正确性 | 无需动作 |
| R3 | `effort`/`prompt_id` 等新字段在旧版本不存在——我们若未来消费它们要版本门控 | 当前不消费 | 无需动作 |
| R4 | 企业 managed settings 的 `allowManagedHooksOnly:true` 会挡住我们的用户/项目级 hooks | 文档 §Hook locations | 属预期（企业策略），README 可一句话 |
| R5 | 测试环境走了第三方网关（api.kimi.com）+ `auto` permission mode，与官方 Anthropic 直连的 hook 触发时机理论上可能有差异 | hook 体系在模型请求之前/之后，与网关无关；且六事件 + 三通道均实测到达 | 记录；若用户报"注入了但模型不看"，先查网关 |

## 9. 复现命令与原始输出

### 9.1 契约探针（六事件 stdin 抓取 + 三通道标记）

```bash
# 隔离项目（不动 ~/.claude 任何配置；hooks 写在项目级 settings）
RT=/tmp/cc-audit/rt && mkdir -p "$RT/.claude/probe" "$RT/probe-out"
# 探针 hook：把 stdin JSON 落盘 probe-out/<event>.json；
# UserPromptSubmit 回 {hookSpecificOutput:{hookEventName,additionalContext:"PROBE_MARKER_UPS_7312"}}
# Stop 回 …"PROBE_MARKER_STOP_4419"；SessionStart(async:true) 回 …"PROBE_MARKER_SS_9854"
cd "$RT" && PROBE_OUT="$RT/probe-out" claude -p \
  "Use the Bash tool to run this exact command: echo probe-shell. Then …quote PROBE_MARKER_*…" \
  --allowedTools "Bash(echo:*)"
```

实测事件时间线（`probe-out/events.log`）：`SessionStart(async,source=startup)` → `UserPromptSubmit` → `PreToolUse` → `PostToolUse` → `Stop`×N（每次注入都使对话继续，工具调用重置 8 连上限）→ `SessionEnd(reason:"other")`。
transcript（`~/.claude/projects/C--Users-…-cc-audit-rt/<sid>.jsonl`，CC 自写）中三标记全部存在且进入模型消息体：`PROBE_MARKER_SS_9854`×10、`PROBE_MARKER_UPS_7312`×9、`PROBE_MARKER_STOP_4419`×104（多次为 Stop 循环）；UPS 渲染形态 `"UserPromptSubmit hook additional context: PROBE_MARKER_UPS_7312"` 包在 `<system-reminder>` 内。

抓取的真实 stdin 要点：公共字段 `session_id/transcript_path/cwd/prompt_id/permission_mode/effort/hook_event_name`；`PreToolUse(Bash)` 带 `tool_input.command/description`、`tool_use_id`；`PostToolUse(Bash)` 另带 `tool_response.{stdout,stderr,interrupted,isImage}` 与 `duration_ms`；`Stop` 带 `stop_hook_active:true`、`last_assistant_message`、`background_tasks:[]`、`session_crons:[]`；`SessionStart` 带 `source:"startup"`（无 `permission_mode`）；`SessionEnd` 带 `reason:"other"`。

### 9.2 适配器端到端（注入 + Stop 补投 + 卸载）

```bash
cd "$RT" && export BRIGHT_DRIFT_STATE_HOME=/tmp/cc-audit/rt-state
node <repo>/packages/claude-code/lib/cli.js install --project   # settings 合并 + selfcheck ok
claude -p "Read the file note.txt, then reply with just: done"  # daemon 起（日志 daemon start pid=37728），概览注入
echo "externally edited line" >> note.txt                       # 外部改动
claude -p --continue "Without reading any files, reply: what changed in note.txt?"
# → 模型答出 "+externally edited line"；pending 文件 deliveredVia:["user-prompt-submit"]；
#   daemon 日志：cold-start reconcile tracked=1 drift=1 → rendered → committed
rm note.txt && claude -p --continue "Reply with exactly: acknowledged"
# → 模型确认 EXTERNAL·DELETED；pending deliveredVia:["stop"]（UPS 与渲染竞态错过，Stop 补投命中，恰是设计场景）
node <repo>/packages/claude-code/lib/cli.js uninstall --project # settings 回到 {}；daemon 消失（P2-2：workspace.json 残留、自愈合）
```

### 9.3 二进制契约抽取（exe 时代替代 cli.js diff）

```bash
EXE="$(npm root -g)/@anthropic-ai/claude-code/node_modules/@anthropic-ai/claude-code-win32-x64/claude.exe"
tr -c '[:print:]\n' '\n' < "$EXE" | grep -a '.\{20,\}' > strings.txt   # ~57MB
grep -a -o 'hook_event_name:C("[A-Za-z]*")' strings.txt | sort -u      # 事件全集（34）
grep -a -o 'hookEventName:C("[A-Za-z]*")'  strings.txt | sort -u      # 输出变体全集（22）
grep -a -o 'g\$s=[0-9e]*' strings.txt                                  # additionalContext 阈值（1e4）
grep -a -o 'Kus=[0-9]*\|Xzr=[0-9]*\|ou=[0-9]*' strings.txt            # SessionEnd 1500/60000、默认 600000
```

---

## 附：本次环境遗留物

- `%TEMP%\cc-audit\rt`（测试项目）、`%TEMP%\cc-audit\rt-state`（隔离状态目录）、`%TEMP%\cc-audit\strings.txt` 等中间产物——在 Temp 下，可留可删。
- CC 在 `~/.claude/projects/C--Users-wjs-R-AppData-Local-Temp-cc-audit-rt/` 下自写了测试会话的 transcript（CC 的正常行为，非我们写入；如需清理可用 `claude` 的会话管理或手动删该目录）。
- 用户 `~/.claude/settings.json` 与凭据**全程未读未写**（hooks 装在项目级；安装器目标为项目 settings）。

---

## 12. 落地补充（2026-10-18，修复实施记录）

报告审阅后按 §6 顺序实施，全部落地于分支 `fix/cc-attribution-window-close`：

| 项 | 落地内容 | 验证 |
|---|---|---|
| P2-1 | 新增 hook 入口 `src/hooks/tool-settled.ts`（Bash 终态 → `window.close`）；installer 增订 `PostToolUseFailure` + `PermissionDenied`（matcher `Bash`，共用该 bundle）；`build.mjs` 入口与 `OWN_FILES` 同步；hook 条目 6 → 8 | 新增 hook 级测试 3 个（失败关窗/拒批关窗/非 Bash 与缺字段 fail-open）+ engine 级测试 1 个（关窗后外部改动仍归 `EXTERNAL·MODIFIED`）；`pnpm test` **76 passed**（基线 72）、`pnpm -r typecheck` 全绿 |
| P2-4 | `post-tool-use.ts:45` 注释改为引用 2.1.300 文档"file-tool 路径恒为绝对路径"，相对路径归一化保留为未知工具兜底 | — |
| 文档措辞 | phase2 设计文档：头部补 2.1.300 复核行、§4.3 `window.close` 生产者、§5.5.1 窗口生命周期图 + 互斥终态说明、§5.9 条目数 6→8、E2/E6 措辞、§3 架构图；AGENTS §5.6 改为"间歇性"并补 `--bare` 说明；根 README 双语 + 子包 README 同步（含 PostToolUseFailure/PermissionDenied 关窗职责） | — |
| P2-2 / P2-3 | 按报告结论**不改**（残留自愈合；子代理 AKB 并入方向正确），仅记录 | — |

未发版：版本号 bump 与 tag 发布待维护者决定（AGENTS §3.2 的 tag 自动化流程）。
