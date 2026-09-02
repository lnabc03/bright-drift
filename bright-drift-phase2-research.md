# bright-drift 二期预研报告：Claude Code adapter

> 状态：预研完成，待评审 · 日期：2026-09-02 · 验证环境：Claude Code 2.1.258（Windows 11 本机实测）+ 官方文档/社区调研
> 上游文档：bright-drift-PRD.md §6、bright-drift-design-phase1.md（core 接口约束）

## 0. 结论

**PRD §6.2 的 daemon 架构在真实 Claude Code 上验证通过，二期可按原计划开工。**
核心链路（SessionStart 拉起 daemon → PostToolUse 更新 AKB → UserPromptSubmit 注入 additionalContext）全部实测走通。但有 **6 处 PRD 需要修正**（见 §4），其中「插件分发的 hooks 不触发」bug（#16288，OPEN）和「additionalContext 超 ~25KB 静默 spill」是两条新的硬约束。

## 1. 本地 Spike 实测（CC 2.1.258）

方法：沙盒项目 `C:\tmp\bd-spike`，项目级 `.claude/settings.json` 注册 4 个 hook（SessionStart / UserPromptSubmit / PostToolUse / PreToolUse），headless `claude -p` 运行。

| 验证项 | 结果 | 备注 |
|---|---|---|
| `UserPromptSubmit` → `hookSpecificOutput.additionalContext` | ✅ 注入文本进入模型上下文，可被逐字引用 | 顶层 `additionalContext` 无效，必须嵌套在 `hookSpecificOutput` 并带 `hookEventName` |
| `SessionStart` 载荷 | ✅ 含 `session_id` / `transcript_path` / `cwd` / `source:"startup"` | daemon 关联会话所需信息齐全 |
| hook 内 spawn detached daemon（Node `detached:true` + `unref`） | ✅ 心跳存活超过 hook 进程与整个 headless 会话 | Windows 下 `node <script>` 命令形态直接可用 |
| `PostToolUse` matcher `"Read\|Edit\|Write\|MultiEdit"` | ✅ 触发，`tool_input.file_path` 为绝对路径 | 管道语法实测有效（agent1 提到 v2.1.191+ 还支持逗号分隔与 `if` 字段） |
| `PreToolUse(Bash)` | ✅ 触发，含 `tool_input.command` / `tool_use_id` | 归因窗口开启所需数据齐全 |
| additionalContext 尺寸行为 | ⚠️ 见下 | 与网传「10,000 字符硬上限」不符 |

### 1.1 additionalContext 尺寸边界（实测，修正网传结论）

| 注入体量 | 实测行为 |
|---|---|
| ≤ 25,018 字节 | 全文进入上下文（模型能精确计数、引用尾部标记） |
| ≥ 25,068 字节 | **静默 spill**：全文写入 `~/.claude/projects/<proj>/<session>/tool-results/hook-*-additionalContext.txt`，上下文只留 ~2KB 预览 + 文件指针；模型不主动 Read 该文件就等于注入丢失 |
| 任意体量 | 都会写 spill 文件（小体量时内容仍全文在上下文） |

**阈值实测 ≈ 25,000 字节**（25,018 通过 / 25,068 spill，2026-09-02 二分确认）。但官方文档承诺的上限是 **10,000 字符**（hooks 参考文档「Hook output strings…are capped at 10,000 characters」）——实测余量大于文档承诺，说明文档滞后；**工程红线按文档承诺取 ≤ 9,500 字符**（实测余量当作安全垫，不依赖）。PRD 默认 2000 token（≈8KB）预算恰在文档承诺线内。注意：spill 行为与 Codex「超预算 spill 成磁盘文件」同构，core/budget 的降级策略直接复用。

### 1.2 补充实测（2026-09-02 第二轮 spike）

| 验证项 | 结果 | 设计含义 |
|---|---|---|
| `Stop` hook `additionalContext` | ✅ 生效，但**无防护会死循环**：注入 → 对话继续 → Stop 再触发 → 再注入，官方 8 连阻断后强制收停（实测模型被重拉 ~9 次） | Stop 通道必须用 daemon 侧「按漂移批次 at-most-once 投递」门控；`stop_hook_active` 语义 = 「本轮已是 stop hook 触发的续跑」，首次触发即为 true，不能单独作门控 |
| `Stop` 输入载荷 | ✅ 含 `stop_hook_active` / `last_assistant_message` / `background_tasks` / `session_crons` | 足够做注入决策 |
| `SessionStart` 重复触发 | ✅ `--continue` 以 `source:"resume"` 对**同一 session_id** 再次触发 | daemon 注册必须幂等；watcher 按 cwd 共享、会话按 session_id 引用计数 |
| UserPromptSubmit 30s 超时 | ✅ 实测 35s 慢 hook：注入被丢弃、用户 prompt 照常进入（fail-open），transcript 有超时通告 | hook 热路径只做一次本地文件读（<10ms），任何 IPC 失败立即空输出退出 |
| hooks 官方文档复核 | ✅ 完成（defuddle 抓取全文） | 10,000 字符上限、`async:true` 后台 hook、exec form（`command`+`args` 无 shell）、`shell` 字段（bash/powershell）、resume 时历史注入从 transcript 重放（不重新跑 hook → 时间戳类内容会陈旧）、additionalContext 应写成事实陈述而非指令（防 prompt-injection 防线误伤） |

### 1.2 Spike 复现

脚本保留在 `C:\tmp\bd-spike/`（`hooks/log-and-inject.js`、`hooks/big-inject.js`、`hooks/fake-daemon.js` + `.claude/settings.json`）。如需复测：改 settings 里的 N 参数后 `claude -p "..."` 即可。

## 2. 官方文档核实（ hooks 能力清单）

来源：code.claude.com/docs/en/hooks（经搜索摘要与 issue 交叉验证；agent 无法直连文档站，**开工前建议浏览器逐条复核**）。

- **UserPromptSubmit**：可阻断（exit 2 / `decision:"block"`）但**不能改写 prompt 文本**；注入只能追加。**默认超时 30s**（疑似硬编码）——hook 内只能做快速 IPC 取 daemon 预计算结果，绝不做 diff。
- **SessionStart**：`source` 取值 `startup|resume|clear|compact|fork`，**全部会重复触发 → daemon 启动必须幂等**（PID 文件/端口锁）。默认超时 600s，拉起 daemon 余量充足。可返回 `additionalContext` / `watchPaths` 等。
- **PostToolUse / PreToolUse**：matcher 支持管道、正则（`mcp__.*`）、`if` 权限规则语法（`"Bash(git *)"`）。`tool_input.file_path` 可能是相对路径，需结合 `cwd` 解析。
- **hook 超时表**：多数事件 600s；UserPromptSubmit/PreModelSwitch 30s；SessionEnd 共享 1.5s 预算（**不能指望 SessionEnd 做清理重活**，daemon 需自管理空闲退出）。
- **Desktop / Agent SDK / VS Code**：存在 hooks 完全不加载的未修复问题（#87657、#18547）。二期只承诺 CLI 形态，文档明示。

## 3. 生态与官方动向

1. **官方不会收编此场景**。#30427（external file changes）已于 2026-03 被机器人判重关闭并锁定，无官方回应；其指向的「重复」issue 全部 closed-stale。官方答案是 FileChanged 原语（事件触发动作），**不是**「下一轮发言注入 diff」。生态位空着。
2. **FileChanged hook 不能替代 watcher daemon**（确认 PRD §6.2-1）：matcher 仍只有 basename；插件注册不触发（#63148 → 归并 #16288，**OPEN**）；Bash 写文件有时漏事件（#44925）。仅有的增量能力：`SessionStart`/`CwdChanged` 可返回 `watchPaths` 动态更新监听列表。
3. **社区已有「daemon + UserPromptSubmit 注入」形态先例**：letta-ai/claude-subconscious（2.9k stars，活跃，做记忆注入）——工程形态被验证。文件变更方向只有小项目（read-once 做 PreToolUse 改注 diff；expergis 停更），**无 dominant player 占位精确形态**。
4. **插件分发信任体验**：安装时一次性插件级信任（非逐条批准 hooks）；但 marketplace 刷新后新增 hooks 无重新同意（#73914，OPEN，area:security）+ 2026-08 CHAINDROP 蠕虫事件 → 官方审核趋严（hooks 必须用 `${CLAUDE_PLUGIN_ROOT}`，禁止宿主机绝对路径）。**对我们：插件 manifest 里的 hook 命令全部走 `${CLAUDE_PLUGIN_ROOT}` 相对路径。**
5. **Stop hook 支持 `hookSpecificOutput.additionalContext`（v2.1.163+）**：turn 末尾注入反馈且对话继续——这是 PRD 写就后出现的新通道，**可部分缓解「turn 内多步之间无法注入」的粒度降级**（见 §4-6）。
6. 三期参考：Codex hooks 对齐 CC 事件名；SessionStart 的 additionalContext 要放**顶层**（与 CC 相反）；注入内容在 transcript 可见（openai/codex#16933）。

## 4. 对 PRD §6 的修正清单

| # | PRD 原文/假设 | 预研结论 | 影响 |
|---|---|---|---|
| 1 | §6.2-4「桌面端/Agent SDK 会话不加载 hooks」 | 确认，且有 VS Code 扩展同类问题（#87657/#18547，OPEN） | 维持：二期只承诺 CLI；README 明示 |
| 2 | §6.2-4「插件分发形式的 hooks 信任提示」 | 信任是插件级一次性确认，体验无碍；但 **#16288（插件 hooks.json 中 UserPromptSubmit/FileChanged 不触发）OPEN 未修** | **新增硬约束**：安装器必须内置「写入用户/项目 settings.json（带版本戳）」的 fallback 路径；或以 settings 注入为主、插件形态仅做分发壳 |
| 3 | （未涉及）additionalContext 上限 | 官方文档承诺 10,000 字符上限、超出 spill 成文件；**实测 2.1.258 上 ~25,000 字节才 spill**（文档滞后于实现） | **新增硬约束**：core/budget 渲染产物 ≤ 9,500 字符红线（按文档承诺取值，实测余量当安全垫）；超线降级为单行摘要（复用现有降级梯） |
| 4 | §6.1「SessionStart hook 拉起 daemon」 | 可行，但 `resume/clear/compact/fork` 均重触发 | daemon 拉起必须幂等；`SessionEnd` 仅 1.5s 预算，清理靠 daemon 空闲自退（PRD 已有 30min 超时设计，保留） |
| 5 | §6.1 注入粒度「仅用户发言轮，turn 内无法注入」 | 部分缓解：v2.1.163+ Stop hook 可注入 additionalContext 且对话继续 | **设计增量**：turn 内高优漂移（如 AKB 文件被删除）可经 Stop hook 在 turn 结束时补投；是否启用列入二期设计评审 |
| 6 | §7 Codex「~2500 token 上限」 | CC 侧实测上限远大于此；Codex 侧未实测 | 三期再验；core/budget 默认预算不变 |

## 5. 风险清单（合并两路调研 + spike）

| 风险 | 等级 | 缓解 |
|---|---|---|
| #16288：插件注册 hooks 不触发 | **高**（直接影响分发形态） | settings.json 注入 fallback；安装器带版本戳自检 |
| additionalContext 超 ~25KB 静默 spill | 中 | 预算红线 9,500 字符（官方承诺 10,000）+ 降级策略（已有 core/budget） |
| UserPromptSubmit 30s 超时疑似硬编码 | 中 | hook 只做本机 IPC（状态文件/socket），daemon 预计算 |
| daemon 生命周期无托管（CC 崩溃/退出不清理） | 中 | PID 文件 + 会话引用计数 + 空闲 30min 自退；Windows 孤儿进程处理需专项测试 |
| 桌面/SDK/VS Code 不加载 hooks | 低（二期范围外） | 文档明示 CLI-only |
| `tool_input.file_path` 可能为相对路径 | 低 | 结合 payload `cwd` 归一化 |
| 文档结论来自二手摘要 | 低 | 开工前浏览器复核 code.claude.com/docs/en/hooks |

## 6. 一期 core 就绪度核查

- ✅ **FR-7.6 硬约束已满足**：`Attributor.toJSON()/fromJSON()` 纯 JSON 序列化（`packages/core/src/attribution/attributor.ts:189`），注释明确标注二期跨进程交接用途。
- ✅ core 公共 API 七个模块（baseline/watcher/drift/attribution/diff/budget/message）无进程内状态假设，`WorkspaceWatcher` 可直接在 daemon 进程内复用。
- ⏳ 二期新增需求待设计：hook ↔ daemon IPC 协议（状态文件 vs 本机 socket/named pipe，Windows 兼容性是选型关键）、AKB 状态文件的并发写（多 CC 会话同工作区——PRD R6 届时重估）。

## 7. 里程碑建议（维持 PRD §6.3，细化第 1 周）

- **M4（第 1 周）daemon + hook 桥接打通**：daemon 骨架（复用 core watcher + 幂等启动 + 空闲自退）→ settings.json 注入式安装器（fallback 优先，规避 #16288）→ UserPromptSubmit 注入「hello drift」端到端。
- **M5（第 2 周）功能对齐 FR-1~FR-4**：AKB 状态文件通道（PostToolUse）、归因窗口跨进程交接（Attributor toJSON/fromJSON 落盘）、预算渲染 + 20KB 红线。
- **M6（第 3 周）安装体验**：插件形态打包（`${CLAUDE_PLUGIN_ROOT}` 合规）+ settings fallback 自检；与一期统一发版；README 补「与 FileStateCache 互补」说明（PRD §6.2-3）。
- **M4 开工前待办**：① ~~浏览器复核 hooks 官方文档 §2 各条~~ ✅ 2026-09-02 完成（defuddle 抓取全文复核，见 §1.2 补记）；② ~~二分确认 spill 精确阈值~~ ✅ ≈25,000 字节，红线按文档承诺取 9,500 字符；③ 决定 Stop hook 补投是否进二期范围 → **建议纳入**（有 at-most-once 门控即可，见 §1.2 补记），在设计文档中定案。
