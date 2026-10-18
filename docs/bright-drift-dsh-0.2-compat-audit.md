# bright-drift × dsh 0.2.0 兼容性排查报告

> 范围：`bright-drift-core`（核心）+ `bright-drift`（dsh 适配器）。CC 适配器按要求暂缓。
> 排查日期：2026-10-18
> 目标运行时：`@deepseek-ai/dsh` **0.2.0-rc.2**（npm 全局安装，`dsh --version` 核实）
> 本机 Node v24.12.0 / pnpm 12.11.2
> 结论：**2 个致命破坏（P0）+ 1 个契约破坏（P1）+ 2 个需跟进项（P2）**；其余 **17 个接触面**逐一核对通过；`core` 零影响。

---

## 0. 一句话结论

`bright-drift` 0.3.0 装到 dsh 0.2.0 上**能加载、不报错、不崩**，但**完全不工作**：

| 现象 | 后果 |
|---|---|
| 监听 `agent/session-start`，该事件在 0.2.0 已被 `agent/created` 取代 | 永不触发 → `StateRegistry` 永远为空 → **不挂 watcher、不检测漂移、`/bright-drift` 全返回"当前会话未初始化"** |
| 调用 `ctx.settings.register(ns, schema)`，`settings` 服务已重写为 `SettingsForms` | 抛 `settings.register is not a function`（被 fail-open 吞掉）→ **全局配置通道整体失效，静默回落到 DEFAULT_CONFIG** |

最危险的是这两处都是 **silent failure**：`fail-open` 红线（AGENTS §2.4）把它们包装成了"只记一条日志"，而用户的观感是"插件装了但什么都没发生"。实测日志（隔离 DSH_HOME，真机启动）：

```json
{"t":"...","event":"plugin.applied","shellToolName":"pwsh"}
{"t":"...","event":"prompt-section.registered"}
{"t":"...","event":"commands.registered","names":["bright-drift"]}
{"t":"...","event":"settings.register.error","error":"settings.register is not a function"}
```

（此时已有一个真实 Agent 被创建并落盘会话：`sessions/--C-Users-...-probe-.../`，但**没有一行 `session.start`**。）

只把事件名改成 `agent/created` 后重启，立刻恢复：

```json
{"event":"session.start","sessionId":"probe-session-dde654d4-...","root":"C:/.../probe-ws","source":"startup"}
{"event":"watcher.acquired","root":"C:/.../probe-ws"}
```

—— 也就是说 **P0-1 的最小修复是一个词**，而 P0-2（配置通道）是一处**设计级迁移**。

---

## 1. 排查方法与证据强度

| 手段 | 说明 |
|---|---|
| `.d.ts` / 包 README 逐项核对 | 读的是本机安装的 0.2.0-rc.2 真实类型与源码文档（`node_modules/@deepseek-ai/dsh-*/lib/types/*.d.ts`），不是记忆 |
| 官方插件先例比对 | `dsh-time-context`（pre-step 注入）、`dsh-repeat-tool-reminder`（post-execute）、`dsh-workspace-changes`（host 平面监听工具事件）、`dsh-fs-observation-policy`（host 平面监听 `fs/*`）、`dsh-hooks-claude-code`（`agent/created` 做 SessionStart） |
| **隔离实机启动** | 新建临时 `DSH_HOME`（`%TEMP%\dsh-compat-home`）+ 非 shipped profile `bdcompat`（`--from-default-profile web`），`dsh plugin --profile bdcompat add bright-drift` 装**已发布的 0.3.0**，用 patch 注入一个 declarative agent（`agent-loop.config.agents`）触发会话生命周期，全程不碰用户 `~/.dsh`、不调模型、不用凭据 |
| 仓库基线 | `pnpm --filter bright-drift-core test` → **154 passed**；`pnpm --filter bright-drift test`（先 build core）→ **32 passed**。说明现有测试全绿，但**一条也抓不到本次破坏**（见 §7） |

未覆盖：需要真实模型请求才能触发的路径（pre-step 注入、tools 监听、压缩、headless 排水）。这些采用源码契约核对 + 官方先例，列入 §8 残余风险。

---

## 2. 破坏清单

### P0-1 `agent/session-start` 事件已不存在，会话初始化彻底失效

**证据**
- 0.2.0 的 agent 事件表（`dsh-agent/lib/types/runtime-types.d.ts`）里：`agent/created`（L227）、`agent/disposed`（L240）、`agent/status`（L252）、`agent/pre-step`（L304）、`agent/turn-stopping`（L387）…… **没有 `agent/session-start`**。
- 全量 grep 整个 dsh 安装目录（含 lib 打包产物）：`agent/session-start` **0 命中**，没有兼容 shim。
- 替代者 `agent/created` 语义一致且更强：

```ts
// dsh-agent/lib/types/runtime-types.d.ts:214-231
/** An entered agent is ready for per-agent initialization after factory setup.
 *  Listeners run in order and are awaited before creation resolves. ... */
'agent/created'(this: Scoped<Agent>, payload: {
    agent: Agent;
    source: SessionStartSource;   // 'startup' | 'resume' | 'clear' | 'compact'
    signal?: AbortSignal;
}): undefined | Promise<undefined>;   // @mode serial
```

**我方代码**：`packages/dsh-adapter/src/index.ts:186` `ctx.on('agent/session-start', …)`；
payload 类型在 `index.ts:23-26`（`SessionStartPayload`，字段恰为 `{agent, source}`，与 `agent/created` 的 payload 同构，只少了可选 `signal`）。

**正确性影响**：`source: 'resume'` 的冷启动对账（§5.5.5 / T7 / E11）也随之失效；不只是"没注入"，而是**基线从来没有建立**。

**修法**（最小）：

```ts
ctx.on('agent/created', (payload: SessionStartPayload) => {
  try { … } catch { … }
  return undefined;          // ⚠️ 必须显式返回（见下）
});
```

**注意 0.2.0 的 serial 语义**：该事件是 `@mode serial`，listener 的 throw / reject **会使 Agent 创建失败**（`A throw or rejection fails creation and skips later listeners`）。我方 listener 已整体 try/catch 且同步返回（异步工作全部 `void` 出去），满足要求；**迁移时不得把 `await` 引进这个 listener**。

**另一个实测坑**：`agent/created` 的返回类型是 `undefined | Promise<undefined>`，所以**返回 `void` 的箭头函数会直接 tsc 报错**（`Type 'void' is not assignable to type 'Promise<undefined> | undefined'`，见 §7.2 实测输出）。迁移时 listener 必须 `return undefined`，不能写成纯 `{ … }` 块体。

---

### P0-2 `ctx.settings.register(ns, schema)` 通道被移除，全局配置静默丢失

**证据**
- `dsh-settings` 的服务已整体重写为 `SettingsForms`（`dsh-settings/lib/types/index.d.ts:62`），公开面只有：`configure / describe / update / replace / mutate / writable / documentPath / prepareDocument`。**没有 `register`，没有 `{get, watch}` scope**。
- 实机日志：`settings.register is not a function`。
- `~/.dsh/settings.yaml` 本身也已废弃：*"Once the Loader has settled every entry after Settings starts, a `settings.yaml` left in the harness home by earlier releases is imported once: each section is written into the entry of the same id … the file is renamed to `settings.yaml.imported`"*（`dsh-settings/README.md`）。**配置的唯一权威是 Cordis patch**。
- 0.2.0 的官方配置形态（多个官方包一致）：`export const Config = z.object({...})`（schemastery）+ `export function apply(ctx, config)`，由 Loader 校验并把 config 传给插件；只有 `.volatile()` 字段可在 Web 设置页编辑且**热提交不 remount**（`cordis-plugin-loader/README.md` §Volatile configuration；`dsh-settings/README.md`：*"Forms expose only volatile fields from active, uniquely addressed profile entries"*）。

**连带风险（已实测）**：在 profile patch 里给 `bright-drift` 行写 `config:`，`dsh --dump-config` 能正常合成：

```yaml
- id: bright-drift
  name: bright-drift
  config:
    enabled: false
    diff:
      blacklist: ['*.md']
```

但**我方 `apply(ctx)` 根本不读第二个参数** → 配置静默无效。更糟的是：0.2.0 会把用户旧 `~/.dsh/settings.yaml` 的 `bright-drift:` 节**按 entry id 尝试写入 profile patch**，而 `SettingsForms.write()` 对没有 Config schema 的 entry 直接抛错（`dsh-settings/lib/index.js`）：

```js
if (entry === void 0 || schema === void 0) throw new Error(`No configurable plugin entry "${ns}"`);
const form = volatileForm(schema);
if (form === void 0) throw new Error(`Plugin entry "${ns}" has no volatile fields`);
```

导入侧只 `warn` 跳过（`importLegacyDocument`：`settings: section %s of %s was not imported into entry %s`），并且文件已经被重命名为 `settings.yaml.imported`。**即：老用户升级后，其 bright-drift 全局配置会被移出配置体系、搁浅在一个改名后的旧文件里，且插件自己读不到**——这比直接报错更糟。

**修法**：见 §6 迁移方案（新增 schemastery `Config`、删掉 settings 注册块、改监听 `loader/volatile-update`）。

---

### P1-1 注入消息的 `source.kind` 词汇表被改写："没有通用 `plugin` kind"

**证据**
- 0.2.0 的 `MessageSourceMap` 改为**按生产者自声明**的 merge-extensible 联合（`dsh-llm/lib/types/message.d.ts:94-122`）：

> *"Merge-extensible sum type — each producer declares its own `kind` in its own module; **there is no shared catch-all `plugin` kind**."*

  内置只有 `user / model / tool / system-prompt`；其它生产者一律在**自己包里**做模块增强，例如：

```ts
// dsh-plan-mode/lib/types/index.d.ts
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap { 'plan-mode': { kind: 'plan-mode' } & ContextFormed }
}
// dsh-time-context / dsh-repeat-tool-reminder 同构
```

**运行时判定**：**不会崩**。会话日志只校验 `source.kind` 是非空字符串（`dsh-session/lib/index.js` `assertMessageEventShape`：`if (typeof source["kind"] !== "string" || source["kind"] === "") throw`），`user/message` 不校验具体取值；Web 端渲染只看 `form` 不看 `kind`（`dsh-client-ui-chat/lib/client.js` `contextBody`）。所以今天 `{kind:'plugin', form:'notice', summary}` 仍能注入、仍能显示。

**但有两处真实退化**：
1. 官方契约已不允许"catch-all plugin kind"，客户端 `contextProducer()` 对未知 kind 的 fallback 是 `label = kind` —— 注入行会显示成 **"plugin"** 而不是 "bright-drift"。
2. 无法被 UI/其它消费者按生产者识别，后续任何按 kind 分发的消费者都会把我们当 opaque。

**修法**：自声明 kind（`'bright-drift'`），并保留 `form:'notice' + summary`（≤120 字符，官方 `boundContextSummary` 的界，`dsh-llm/lib/types/message.d.ts:114`）：

```ts
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'bright-drift': { kind: 'bright-drift' } & ContextFormed;
  }
}
```

> 该增强只在**类型层**生效；运行时对象字面量照旧。若不想引入 `@deepseek-ai/dsh-llm` 依赖，也可以只在 `types.ts` 里把 kind 常量改成 `'bright-drift'` 并失去类型增强——但既然要为 §7 的契约测试引入类型依赖，建议一次做对。

---

### P2-1 `session/disposed` 的 payload 从 `{id}` 变成了 `Session` 对象

**证据**：`dsh-session/lib/types/index.d.ts:52` → `'session/disposed'(this: Scoped<Session>, session: Session): void;`

**运行时**：`Session` 有 `get id()`（`dsh-session/lib/types/index.d.ts:123`）和 `header`，所以 `payload.id` 仍取得到，**不炸**；只是与 `types.ts` 的 `SessionDisposedPayload { id: string }` 不符（类型漂移，属于"依赖记忆而非源码"的典型残留）。

**修法**：payload 一律按 `{ id: string }` → `Session`（只用到 `.id`）收窄，或直接改成 `(session: {id: string})`。

---

### P2-2 建议同时监听 `agent/disposed`（新事件，语义更贴合我们的清理点）

0.2.0 新增 `agent/disposed`：*"An agent left the registry; AgentLoop emits this after driver quiescence and scoped-registration unwind, but before session detachment"*（`runtime-types.d.ts:232-242`）。

我们目前只在 `session/disposed` 里做"落盘 + 释放 watcher + 摘 registry"。而 `session/disposed` 只覆盖**会话离开 store**；web 场景下会话可能长期留在 store 而 agent 已被回收（tab 关闭 / agent 回收但会话可恢复）。只监听 `session/disposed` 会漏掉 WeakMap 之外的 `bySessionId` Map 条目与 watcher refcount（watcher 泄漏 → 进程内 chokidar 常驻）。

**修法**：两条都听，`agent/disposed` 做 per-agent 清理（幂等），`session/disposed` 保留为会话级兜底。

---

## 3. 全量接触面核对表（22 项）

| # | 我方使用点 | 0.2.0 状态 | 结论 | 证据坐标 |
|---|---|---|---|---|
| 1 | `apply(ctx)` 作为 bundle 行插件 | `export const name / inject / Config` + `apply(ctx, config)` | ✅ 兼容（实机 applied） | `dsh-workspace-changes/lib/types/index.d.ts:5-33` |
| 2 | `package.json` `dsh.bundle.patch` + `cordis.patch.yml` `- insert: [{id,name}]` | 未变，且**支持数组**（多 patch 文件） | ✅ 兼容（实机装载） | `dsh-base/cordis.patch.yml`；`dsh-web-app/package.json` `.dsh.bundle.patch` |
| 3 | `dsh plugin --profile X add <pkg>` 安装流程 | 保留；新增 peer 范围校验与 exemption | ✅ 兼容（实机安装 `bright-drift 0.3.0`） | `dsh-plugin-manager/README.md` §Version compatibility |
| 4 | `agent/session-start` | **已移除** | ❌ P0-1 → `agent/created` | `dsh-agent/.../runtime-types.d.ts:227` |
| 5 | `agent/turn-stopping` | 同签名，`@mode serial` | ✅ | 同上 L387 |
| 6 | `session/disposed` | payload 变为 `Session` | ⚠️ P2-1 | `dsh-session/.../index.d.ts:52` |
| 7 | （未监听）`agent/disposed` | 新增 | ➕ P2-2 建议补 | `runtime-types.d.ts:240` |
| 8 | `agent/pre-step` waterfall（先 `next()` 后追加、`{prepend:true}`） | payload/decision 同构；新增可选 `startsRequestSeries` | ✅ 官方同款写法仍在用 | `runtime-types.d.ts:92-99,304`；`dsh-time-context/lib/index.js` |
| 9 | `tools/result` (exec, result.isError) | 同签名，`@mode emit` | ✅ | `dsh-tools/.../index.d.ts:92` |
| 10 | `tools/pre-execute` (exec, next) | 同签名；决策类型收紧为 `PreToolDecision` | ✅（我们只是透传 `next()`） | 同上 L47、L445 |
| 11 | `tools/post-execute` (exec, result, next) | 同签名 | ✅ | 同上 L70、L465 |
| 12 | `ToolExecution{callId,name,arguments,agent}` | 未变（`arguments` 现为 `unknown`，我们本就窄化取值） | ✅ | 同上 L216-241 |
| 13 | `fs/observed`（同步、不 throw）+ `fs.processPath` | 未变 | ✅ | `dsh-fs/.../index.d.ts:52,106` |
| 14 | `systemPrompt.section({name,order,text})` | 未变（新增 scoped 覆盖/重名抛错） | ✅ 实机 `prompt-section.registered` | `dsh-system-prompt/.../index.d.ts:239` |
| 15 | `commands.register(def)` + `input.hint` + `{kind:'success'|'error',text}` | 未变（新增 `definitionId` / `recordInput` / `input.attachments`） | ✅ 实机 `commands.registered` | `dsh-commands/.../index.d.ts:94`；`types.d.ts:20-41` |
| 16 | `ctx.settings.register(ns, schema)` | **已移除**（服务重写为 `SettingsForms`） | ❌ P0-2 | `dsh-settings/.../index.d.ts:62-118` |
| 17 | `timer.debounce(cb, delay)`（`ctx.get('timer')`） | 未变；row `timer` 仍在 base bundle | ✅ | `cordis-plugin-timer/lib/types/index.d.ts:26` |
| 18 | `agent.session.header.cwd` 取工作区根（兜底 `sandboxPolicy.workspaceRoot`） | 未变 | ✅ 实机 root 正确 | `dsh-session/.../types.d.ts:58-63`；`dsh-sandbox-policy/.../index.d.ts:77` |
| 19 | Cordis `ctx.get / on(...,{prepend}) / inject / effect` | cordis 4.0.1 → **4.0.4**，四个 API 签名未变 | ✅ | `cordis/lib/types/{events,fiber,registry}.d.ts` |
| 20 | 注入消息 `source:{kind:'plugin',plugin,form:'notice',summary}` | kind 词汇表已改为按生产者自声明 | ⚠️ P1-1 | `dsh-llm/.../message.d.ts:94-122` |
| 21 | 工具名 `read/write/edit/read_image` + `file_path/offset/limit`；shell `bash/pwsh` | 完全未变 | ✅ | `dsh-tool-fs/lib/index.js:262,527,675,975`；`dsh-web-app/presets/standard.patch.yml` |
| 22 | 状态/日志目录 `$DSH_HOME/{state,logs}/bright-drift` | 未变（`DSH_HOME` 语义未变） | ✅ 实机写入隔离 home | `dsh-home-paths`；我方 `paths.ts:6` |

依赖对齐（AGENTS §4.7）：dsh 0.2.0 树内 `chokidar 4.0.3` / `diff 9.0.0` / `yaml 2.9.1`，我方 `chokidar ^4.0.3` / `diff ^9.0.0` / `yaml ^2.5.0`（另有 `ignore 5.3.2` 为 core 自用、dsh 侧不涉及）——**完全对齐，无需动作**。Node：dsh 包本身不声明 `engines`，但 base bundle 里 `session-query-sqlite` 等按 Node 22+ 设计；我们的 `>=20` 不算错，只是实际下限已由宿主决定，保持不动即可。

### 关于 `core`（核心引擎）

- `core` **不 import 任何 dsh API**（AGENTS §2.1 红线），本次 dsh 升级对它无直接影响。
- 单测 154 passed（含 10 万文件压测、真实 chokidar 临时目录、FR-7 归因、pre-step 早退 0.025µs/call），Node 24 下全绿。
- 唯一间接耦合是依赖版本（已对齐）与 `probeFile`/`diff` 的行为（`diff@9` 的 `createTwoFilesPatch` 语义未变，实测通过）。
- **结论：core 本次零改动**。唯一可选的收益是把"上次注入时间/批次"这类跨重启需要可重放的事实做成 dsh `sessionProjections` 投影（见 §5-A8），但那属于二期优化，不进本次兼容面。

---

## 4. 官方 0.2.0 现状与我们设计假设的差异（供设计文档勘误）

| 一期设计假设 | 0.2.0 现实 | 影响 |
|---|---|---|
| F7：`ctx.settings.register(ns, schema)` 是配置主通道，`settings.yaml` 用户级命名空间 + Web 设置 UI + 热更新 | 该通道不存在；配置 = Loader Config（schemastery）+ profile/home patch；热更新靠 `.volatile()` + `loader/volatile-update`；**随附客户端没有 schema 自动表单**，设置页要自建客户端插件 | §5.9 / D2 需重写；AGENTS §7 配置位置表需改 |
| F3 备注：`agent/session-start` 文档推荐 `agent.inject()` 播种 | 事件改名 `agent/created`；`agent.inject()` 仍在但语义未变（不唤醒、可能错过已 claim 的批次） | §5.2 / §5.5.5 措辞需改；结论不变（仍走 pre-step） |
| C 系列：`source:{kind:'plugin', ...}` 是插件注入的标准来源 | 无 catch-all kind，生产者各自声明 | §5.5.2 / AGENTS §4.6 需改 |
| D1：host 平面 + 按 Agent WeakMap 分键 | 未变，但 0.2.0 新增 **agent preset 平面**（web 把工具行搬进 preset realm） | 结论不变（host 监听仍能收到 preset 内 agent 的事件；见 §8 残余风险） |
| 写守卫交互（§5.2.3）：只读 `fs/observed`、不刷新 dsh 观察状态 | 未变；`dsh-fs-observation-policy` 仍是弱引用 per-agent 版本记录、不持久化 | 结论不变（我们的直接 `node:fs` 重读策略依然正确且互不干扰） |

---

## 5. 0.2.0 新特性评估：能用的 / 别用的

### A1 ✅ 采用：schemastery `Config` + `.volatile()` + `loader/volatile-update`
这是 P0-2 的**正解**，拿回三个能力：
1. Loader 校验配置（非法值在加载期失败，而不是静默回落）；
2. `.volatile()` 节点的编辑**不 remount**，直接提交进运行中的 config 引用并 fire `loader/volatile-update`（`cordis-plugin-loader/lib/types/index.d.ts:29`），这正是旧 `scope.watch()` 的替代；
3. 用户旧的 `settings.yaml` `bright-drift:` 节**一次性自动导入**到同 id 行（`dsh-settings/lib/index.js` `importLegacyDocument`），只要字段同名即可无损迁移（见 §6.3）。

**但不要期待"免费设置 UI"**（这点容易想当然）：`autoGenerate` 目前**没有任何随附客户端实现**——`dsh-settings/README.md` 原文：*"Each form reports `autoGenerate`, enabled by default, for clients that build pages from the schema; **no shipped client does so yet**"*；配置页必须由**客户端插件**注册 `plugins.row.config` 槽位（`<包名>#<行 id>`）并自己画表单，`dshmarket` 就是这么做的（`dsh-client-ui-plugin-manager/README.md` §Configuration pages）。所以配置的落地形态是：

| 通道 | 是否可用 | 说明 |
|---|---|---|
| 手改 profile / home patch 的 `bright-drift.config:` | ✅ 随时可用 | 主力通道；文档写清楚即可 |
| `.volatile` 字段热生效 | ✅ | 改完 patch，HMR/重载后**不 remount** |
| `/bright-drift …` 命令写**项目级**覆盖 | ✅ 已有 | 现有的 `nodiff add/remove` 就是这条 |
| `/bright-drift config …` 命令写**全局**配置 | ✅ 可行 | 走 `ctx.configEditor.edit(entry, change)`（`dsh-config-editor/lib/types/index.d.ts:34`，profile 宿主均有挂载），无需客户端插件 |
| 自建设置页（表单 UI） | 🟡 需额外客户端包 | 与 0.1.x 的 settings UI 体验对齐的唯一途径；建议二期视反馈再决定 |

`dshmarket`（第三方）已按此形态声明 `peerDependencies: @deepseek-ai/schemastery ^3.18.1`，说明该依赖对外可用、且是社区约定。

### A2 ✅ 采用：`MessageSourceMap` 自声明 `'bright-drift'` kind（见 P1-1）

### A3 ✅ 采用（类型层）：`createUserMessage` / `boundContextSummary`
`dsh-llm` 现在是官方消息构造入口（`createUserMessage` 会 clone + freeze + 品牌化 id）。我们手搓 `{id: randomUUID(), role:'user', ...}` 运行时能过（校验只查非空字符串），但**契约上应由生产者构造**。`boundContextSummary` 保证 notice summary ≤120 字符，与我们既有约束一致。

### A4 ✅ 采用：`agent/created` 的 serial 语义
它等价于官方 `SessionStart`（`dsh-hooks-claude-code/README.md`：*"`SessionStart` adds context through awaited `agent/created` initialization before the first turn"*）。注意 listener 必须**快且不 throw**（throw 会 fail agent 创建）。

### A5 ❌ 不采用：`ctx.fs.watch(target, changed, signal)`
0.2.0 新增了后端级 watch（本地实现就是 chokidar），但它是**单文件 / 目录直接子项**语义（`dsh-api-workspace-files/README.md`：*"directories watch only direct entries"*），**不是递归工作区**。我们的需求是全树递归 + 忽略规则 + 按 root 共享 refcount，继续用自己的 `WorkspaceWatcher`（chokidar 4.0.3 与宿主完全同版）。

### A6 ❌ 不采用（但要记录）：`dsh-workspace-changes`
它按 turn 记录"本轮改了哪些文件"，git 树快照 + 文件工具编辑前整文件拷贝，产出 UI 的 changed-files 卡片。**不是我们的替代品**：
- 它是 **turn 域**（我们跨 turn 跟踪"模型没看到的改动"）；
- 数据只活在 Host 内存里（`ctx.workspaceChanges.summary/diff`），**完全没有模型面**（README:"Model Experience: None"）；
- 它会为每个 write/edit 整文件拷贝（≤2MB/文件/轮）—— 与我们的 AKB 内容副本**功能重叠**，属可接受的重复成本，不是冲突；
- 顺带说明：用户现在会在 dsh 里看到"本轮改动卡片"，这正是我们 notice 的**互补面**（卡片给人看，notice 给模型看），可以在 README 里一句话说清定位差异。

### A7 📌 记录（二期用）：`dsh-hooks-claude-code` / `dsh-hook-protocol`
dsh 0.2.0 自带 **Claude Code hooks 桥**（`SessionStart/UserPromptSubmit/PreToolUse/PostToolUse/Stop/SubagentStart/Stop` 映射到 `agent/created / agent/pre-step / tools/pre-execute / tools/post-execute / agent/turn-stopping / subagent/*`）。这对二期 CC 适配器有两个含义：
- 它**证明** CC 的 hook 语义可以在 dsh 侧完整表达，也给出了"同一份 hook 产物给两边用"的可行性；
- 但它只支持 CC 的命令钩子子集（23 个事件不支持、`UserPromptSubmit` 不支持纯 stdout 上下文、无 `transcript_path`），**不足以承载 bright-drift CC 适配器的 daemon/outbox 语义**，不能拿来替换二期实现。
（按要求本期不动 CC 适配器，仅登记。）

### A8 🟡 可选：`sessionProjections`
`dsh-time-context` 用投影把"上次注入时间"做成**可重放**的日志折叠，从而在 resume/compaction 后仍正确节流。我们把同类事实（上次注入批次 / stats）放在内存里，重启即失。若未来要强化"注入历史可重放"，这是官方通道。

### A9 ❌ 不采用：`dsh-storage-domain` 存 AKB
`storage` 是 JSON KV + schema 域，适合小状态；我们 AKB 是 10 万条规模（快照 14MB JSON、209ms 往返，见压测）且要跨平台（CC 适配器也读同一套 core 格式）。自管 `$DSH_HOME/state/bright-drift/` 更合适。

### A10 🟡 建议：声明 `peerDependencies` 表达兼容区间
0.2.0 的插件管理器会在安装/启动时**校验插件声明的 dsh peer 范围**，不符则拒绝并给出 `incompatible-version`（可豁免）。当前我们**一条都不声明** → 装到任何 dsh 版本都"成功"，然后静默失效（正是本次踩的坑）。建议按社区惯例声明：

```jsonc
"peerDependencies": {
  "@deepseek-ai/cordis": "^4.0.4",
  "@deepseek-ai/schemastery": "^3.18.1",
  "@deepseek-ai/dsh-agent": ">=0.2.0-rc.1 <0.3.0-0",
  "@deepseek-ai/dsh-tools": ">=0.2.0-rc.1 <0.3.0-0",
  "@deepseek-ai/dsh-llm":   ">=0.2.0-rc.1 <0.3.0-0"
}
```
（照 `dsh-web-mobile` 的写法：`>=0.2.0-rc.1 <0.3.0-0`；`dshmarket` 亦声明了 `@deepseek-ai/schemastery ^3.18.1`。）

### A11 ❌ 维持既有决策：`additionalContexts` / `agent.inject()`
`ToolExecutionResult.additionalContexts`、`PostToolDecision.additionalContexts`、以及 `agent.inject(message)` 都在，但我们的一期设计已评估并放弃（无法感知领取时刻 → Sync Point 不可控 / 批次可错过）。0.2.0 未改变这个权衡，**继续走 pre-step**。

### A12 ℹ️ 无影响：`PreStepDecision.startsRequestSeries`
新增的可选字段（在本次 step 前开新的 model-message 序列）。我们不设置它 → 行为不变。

---

## 6. 迁移方案（P0-2 主体）

### 6.1 新的 apply 形态（已在本机 schemastery 3.18.4 上实测过语义）

```ts
// packages/dsh-adapter/src/config.ts
import z from '@deepseek-ai/schemastery';

/** 与旧 settings.yaml 节逐字段同名 —— 这是无损迁移的前提（见 §6.3）。 */
export interface BrightDriftConfig { /* 字段名不变 */ }

/** volatile 标在 section / 叶子节点上，不要标在根对象上（见下方实测）。 */
export const Config = z.object({
  enabled: z.boolean().default(true).volatile(),
  watch: z.object({
    respectGitignore: z.boolean().default(true),
    extraIgnore: z.array(String).default([]),
    includeUntracked: z.boolean().default(false),
  }).default({}).volatile(),
  budget:      z.object({ /* … */ }).default({}).volatile(),
  diff:        z.object({ /* … */ }).default({}).volatile(),
  baseline:    z.object({ /* … */ }).default({}).volatile(),
  inject:      z.object({ /* … */ }).default({}).volatile(),
  attribution: z.object({ /* … */ }).default({}).volatile(),
});

/** schemastery 解析结果里每个 volatile 节点是一个引用，必须 .get() 取快照。
 *  形状用 z.infer 自动推导即可（每个 volatile 节点已是 Volatile<T>），无需手写类型。 */
export type ConfigShape = z.infer<typeof Config>;

export function snapshot(config: ConfigShape): BrightDriftConfig {
  return {
    enabled: config.enabled.get(),
    watch: config.watch.get(),
    budget: config.budget.get(),
    diff: config.diff.get(),
    baseline: config.baseline.get(),
    inject: config.inject.get(),
    attribution: config.attribution.get(),
  };
}
```

```ts
// packages/dsh-adapter/src/index.ts
export function apply(ctx: CtxLike, config: ConfigShape): void {
  …
  const applyConfig = (): void => {                 // 原 applyResolved，体不变
    resolver.setGlobal(snapshot(config));           // 取代 scope.get()
    promptSectionEnabled = resolver.globalConfig().inject.promptSection;
    syncPromptSection();
    for (const state of registry.all()) {
      reconfigureState(state, resolver.resolve(state.workspaceRoot));
      syncWatcher(state);
    }
    for (const root of watchers.roots) {
      void watchers.refreshIgnore(root, resolver.resolve(root)).catch(…);
    }
  };
  applyConfig();
  ctx.on('loader/volatile-update', applyConfig);    // 取代 scope.watch(applyResolved)

  // 删除整个 ctx.inject(['settings'], …) 块与 settingsSchema()
}
```

**两条实测结论（决定了上面的写法）**：

| 试法 | 结果 | 结论 |
|---|---|---|
| `z.object({…}).volatile()`（根节点整体 volatile） | `Config({})` → **`{}`**；`Config({ diff: { blacklist: ['*.md'] } })` → **`{}`** | ❌ **默认值不再填充，配置全空** —— 绝不能这样写 |
| `z.object({…}).default({}).volatile()`（section 节点 volatile） | `.get()` → `{respectGitignore:true, extraIgnore:[]}`；`.get()` → `{contextLines:3, blacklist:['*.md']}` | ✅ 嵌套默认值 + patch 覆盖都正确 |
| `z.number().default(3).volatile()`（叶子 volatile） | 值是 `{get(), [Symbol(cosmokit.volatile.write)]()}` 引用对象 | ✅ 但必须 `.get()` 读，直接当普通值读会拿到引用对象 |
| 类型层 | `Volatile<T>` 只有 `get(): VolatileSnapshot<T>`（`cosmokit/lib/types/volatile.d.ts:7-10`） | ✅ 快照类型递归 readonly，正好匹配我们只读的 `BrightDriftConfig` |

其它要点：
- **删除** `settingsSchema()` / `ctx.inject(['settings'])` / `scope.get()` / `scope.watch()`；
- `mergeConfig()` 仍保留：项目级覆盖（`<workspace>/.dsh/bright-drift.yml`）继续叠在 Loader config 之上，`ConfigResolver` 结构不变；
- 给每个字段加 `.description()`（英文），设置页直接展示；
- volatile 节点下的字段都会被设置页当作可编辑字段（`isVolatilePath` 语义），所以"section 级 volatile"同时满足了 UI 与热更新。

### 6.2 remount 语义与"待注入漂移丢失"风险

`loader/volatile-update` 只在**纯 volatile 变更**时走热提交；任何**普通字段**变更会**remount**（dispose + 重新 apply）。而 `saveAgentState` **只持久化 AKB + 归因窗口，不持久化 `DriftQueue`**（`persist.ts:17-43`）。因此 remount 会**静默丢掉尚未注入的漂移**（这些路径的 AKB 未被 Sync Point 提交，后续 watcher 事件也不会重新触发）。

两个可选防线（择一，建议 ①）：
1. **全部 section/叶子标记 volatile**（§6.1 的写法），让配置编辑永不 remount → 旧 `scope.watch` 的热更新体验 1:1 保留；
2. 在 fiber dispose 时把 `queue` 一并快照进 AKB JSON，`loadAgentState` 时回灌（改 `core` 的 `AKBSnapshot` 或新增旁路文件）。成本更高，但也能修"进程被杀丢队列"的既有缺口。

### 6.3 用户旧配置的无损迁移

0.2.0 启动时会读旧 `~/.dsh/settings.yaml`，**按 entry id 把 section 写进 profile patch**（`LEGACY_SECTION_ENTRIES` 只映射三个改名过的 id，其余原样用 section 名），然后重命名文件；写入走 `SettingsForms.update(ns, values)` → `write()`，**entry 没有 schema 或没有 volatile 字段都会抛错**（见 P0-2）。我们的 entry id 恰好是 `bright-drift`，section 也是 `bright-drift:`，所以只要 `Config` 字段名与旧 schema **逐字一致**，迁移就是无损的：

| 旧 `settings.yaml` 键 | 新 `Config` 字段 | 备注 |
|---|---|---|
| `enabled` | `enabled` | 同名 |
| `watch.{respectGitignore,extraIgnore,includeUntracked}` | 同 | 同名 |
| `budget.{maxDiffLinesPerFile,maxTotalDiffLines,maxInjectTokens,maxDriftFilesForDiff}` | 同 | 同名 |
| `diff.{contextLines,maxFileSizeKB,blacklist}` | 同 | 同名 |
| `baseline.{maxEntries,persist,persistContent,contentStoreMaxMB}` | 同 | 同名 |
| `inject.{onSessionStart,onPreStep,promptSection}` | 同 | 同名 |
| `attribution.{bashWindowGraceMs,longCommandMs,formatterWindowMs,formatterSilent}` | 同 | 同名 |

> ⚠️ 迁移期要专门跑一个用例：旧文件 + 新插件 → `dsh --dump-config` 里 `bright-drift.config` 与旧值逐字段相等。若字段名有任何改动，导入会被 compositor 拒绝（"a section the running composition rejects is logged and stays only in the renamed file"）→ 用户配置进 `settings.yaml.imported` 后**永久失效**。

### 6.4 配置位置文档更新（AGENTS §7 / phase1 §5.9）

| 内容 | 0.2.0 之后 |
|---|---|
| 跨 profile 全局配置 | `$DSH_HOME/cordis.patch.yml` 的 `- id: bright-drift` 行 `config:`（真正的"全局"，等价于旧的 user settings） |
| 单 profile 配置 | `$DSH_HOME/profiles/<name>/cordis.patch.yml` 同形（`ctx.configEditor.edit()` / 未来的配置页写这里；home patch 与命令行 overlay 只读） |
| 项目级覆盖 | 不变：`<workspace>/.dsh/bright-drift.yml`（我们自己读，dsh 没有 workspace 级 patch 层） |
| 状态/日志 | 不变：`$DSH_HOME/state/bright-drift/`、`$DSH_HOME/logs/bright-drift/` |
| Web 设置页 | 需自建客户端插件才会出现（见 §5-A1），否则只见 YAML |

### 6.5 版本与兼容策略

- 这是一个 **breaking** 变更（要求 dsh ≥0.2），应发 **0.4.0**（三包同版本，AGENTS §3.2）。
- **不建议**写"双兼容"（同时注册 `agent/created` + `agent/session-start`、同时尝试 `settings.register` + Config）：0.2.0 里旧事件永不存在、旧服务永不出现，双通道只会增加阅读成本；且 0.1.x 已无实际用户群（本机 profile 已无 bright-drift 安装）。用 `peerDependencies` 表达边界（§5-A10），让 0.1.x 用户在**安装期**就被拒绝，而不是运行期静默失效。

---

## 7. 测试计划

### 7.1 本次为什么没抓到（测试缺口）

现有 32 个 adapter 用例全部用**自造 mock ctx**（`inject.test.ts` / `observe.test.ts` / `commands.test.ts`）与**手写结构类型**（`types.ts`）。它们断言的是"我方实现自己的契约"，而不是"宿主真实契约"。dsh 0.1.1-rc.2 → 0.2.0 的所有破坏（事件消失、服务方法消失、payload 变形、source kind 词汇表变化）**没有一条能被 tsc 或 mock 测出**。

### 7.2 必须新增的两层防线

1. **类型契约测试（编译期）**：把 adapter devDeps 提到 `0.2.0-rc.2`，新增 `src/contract.ts`（只做类型断言，不被 `index.ts` import，运行期不执行），用**真实 dsh 类型**约束我方 listener。注意：事件表是各包 `declare module '@deepseek-ai/cordis'` 增强进来的，**必须 `import type {}` 引入对应包**才会生效：

   ```ts
   import type { Context } from '@deepseek-ai/cordis';
   import type {} from '@deepseek-ai/dsh-agent';     // 注册 agent/* 事件
   import type {} from '@deepseek-ai/dsh-session';   // 注册 session/* 事件
   import type {} from '@deepseek-ai/dsh-tools';     // 注册 tools/* 事件
   import type {} from '@deepseek-ai/dsh-fs';        // 注册 fs/observed
   import type {} from '@deepseek-ai/dsh-settings';  // ctx.settings 的真实类型

   export function _typeContract(ctx: Context): void {
     ctx.on('agent/created', (payload) => {          // payload 形状由宿主类型表约束
       void payload.agent.session.header.cwd;
       void payload.source;                          // 'startup' | 'resume' | 'clear' | 'compact'
       return undefined;                             // ← 返回 void 会报错，见下
     });
     ctx.on('agent/pre-step', async (payload, next) => {
       const decision = await next();
       void payload.signal;
       return decision;
     });
     ctx.on('session/disposed', (session) => { void session.id; });
     ctx.on('fs/observed', (target, observation, actor) => {
       void target.targetKey; void observation.kind; void actor;
     });
     ctx.on('tools/pre-execute', async (exec, next) => {
       void exec.arguments; void exec.agent; return next();
     });
     // 负向断言（保留注释即可，或写成 @ts-expect-error 的自检用例）
     // ctx.on('agent/session-start', () => {});        // 事件已移除
     // ctx.get('settings').register('x', (v) => v);    // 服务已无 register
   }
   ```

   **本机实测输出**（用 0.2.0-rc.2 的真实 `.d.ts` 跑 `tsc --noEmit`，Node 24 / TS 5.9.3）：

   ```
   probe.ts(12,27): error TS2345: Argument of type '(this: Scoped<Agent>, payload: { agent: Agent; source: SessionStartSource; signal?: AbortSignal }) => void'
     is not assignable to parameter of type '… => Promise<undefined> | undefined'.
     Type 'void' is not assignable to type 'Promise<undefined> | undefined'.
   probe.ts(49,10): error TS2345: Argument of type '"agent/session-start"' is not assignable to parameter of type 'keyof Events'.
   probe.ts(52,3): error TS2532: Object is possibly 'undefined'.
   probe.ts(52,23): error TS2339: Property 'register' does not exist on type 'SettingsForms'.
   ```

   即：这一层能**一次性拦住本次的全部三个类型级破坏**（事件名、payload 形状、服务方法），并额外强制 `agent/created` listener 显式 `return undefined`。

2. **启动冒烟测试（运行期，可脚本化）**：本次用过的手法产品化 —— 隔离 `DSH_HOME` + 非 shipped profile + declarative agent，断言日志里出现 `plugin.applied / session.start / watcher.acquired` 且**没有** `*.error`。这层能拦住"事件名/服务名漂移"这类类型层可能漏掉的动态问题（例如服务是 `ctx.get` 而不是 `ctx.inject` 时）。

### 7.3 一期矩阵 T1–T13 在 0.2.0 上重跑（不可省）

重点：T1/T2/T3（注入可见）、T4（行为级）、T7/E11（resume 对账）、T11（headless 退出排水）、T12（多会话共享 watcher）、T13（性能门）。压测门不变：pre-step 早退 <1ms（现 0.025µs）、FR-7 快照 <50ms、10 万文件仓库。

### 7.4 新增用例

- 旧 `settings.yaml` → Config 的逐字段迁移等价性；
- `loader/volatile-update` 热更新（改 `budget.maxInjectTokens` 后新批次即生效、且**不 remount**、pending queue 不丢）；
- `agent/disposed` 清理幂等（与 `session/disposed` 先后到达均不重复释放 watcher）；
- P1-1：注入消息 `source.kind === 'bright-drift'` 且 `summary.length ≤ 120`。

---

## 8. 残余风险（静态核对通过，但需 E2E 才能兑现）

| # | 风险 | 判断依据 | 建议 |
|---|---|---|---|
| R1 | **host 平面的 root 监听者是否仍能收到 preset realm 内 agent 的 `agent/pre-step`** | `agent/created` 已实测在 root 收到；`tools/*`、`fs/*` 有官方 host 行先例（`dsh-workspace-changes`、`dsh-fs-observation-policy` 都是 base host 行，服务的正是 preset 内工具） | 0.2.0 首轮 E2E 必须显式验一次 pre-step（T1/T2 覆盖） |
| R2 | **PTC 模式**（`DSH_TOOLS_MODE=ptc`）：模型只调 `run_code`，真实 `read/write/edit` 变成子派发 | 源码核对：子派发走同一 `execute()` 管线（`parent` token + 原 `name`/`arguments`，`dsh-tools/lib/index.js:1298-1360`），因此 `tools/result` 仍会带 `agent` 与 `file_path` | 0.2.0 E2E 里加一条 PTC 变体（`mode: both` 最容易复现） |
| R3 | headless 一次性退出是否仍靠 `ctx.effect` disposer 排水（chokidar 不吊住进程） | Cordis 4.0.4 `effect()` 语义未变 | T11 重跑 |
| R4 | 压缩/摘要会把历史 notice 折掉 | 与 0.1.x 同理，属既有设计 | 不变 |
| R5 | 一次 `agent/created` 抛错会 fail Agent 创建（serial） | 我方 listener 已 try/catch + 同步返回 | 迁移时加断言：listener 返回 `undefined` 且 3 秒内不阻塞 |
| R6 | 多 profile（web/headless）共用 `$DSH_HOME/state/bright-drift/akb/<sessionId>.json` | sessionId 全局唯一，格式未变 | 无需动作 |

---

## 9. 建议实施顺序

1. **P0-1（15 分钟）**：`agent/session-start` → `agent/created`，`SessionDisposedPayload` 放宽为 `{id}`，补 `agent/disposed` 清理；补类型契约测试骨架（devDeps → 0.2.0-rc.2）。
2. **P0-2（半天 + 文档）**：先改设计文档（phase1 §5.9 / D2 / F7、AGENTS §4.4 §4.6 §7、README 双语文案），再加 `Config`（schemastery，**section 级 volatile + `.get()` 快照**）+ `apply(ctx, config)` + `loader/volatile-update`，删 settings 注册块；补 §7.4 迁移用例。
3. **P1-1 / A3（小时级）**：`MessageSourceMap` 自声明 `'bright-drift'`，注入消息改用 `createUserMessage` + `boundContextSummary`。
4. **A10**：声明 `peerDependencies` 兼容区间，并在 README 标注 "dsh ≥ 0.2.0"。
5. **回归**：T1–T13 + 新增用例 + 启动冒烟，发布 **0.4.0**（core/dsh-adapter/CC 三包同版本；CC 包本次无逻辑变更但仍需同版本发布，或按 AGENTS §3.2 说明例外）。

---

## 10. 附：本次复现步骤（可重复执行）

```powershell
# 1) 隔离宿主，不碰用户 ~/.dsh
$t = Join-Path $env:TEMP 'dsh-compat-home'
$env:DSH_HOME = $t
$env:DSH_TELEMETRY_DISABLED = '1'

# 2) 建一个非 shipped profile（用官方 web 模板）
dsh bdcompat --from-default-profile web --dump-config | Select-Object -First 5

# 3) 装已发布的 bright-drift 0.3.0
dsh plugin --profile bdcompat add bright-drift          # → + bright-drift 0.3.0，自动进 dsh.profile.bundles

# 4) 让会话生命周期事件发生（不调模型）：patch 里塞一个 declarative agent
#    - id: agent-loop
#      config:
#        agents:
#          - id: probe
#            cwd: <某临时工作区>
dsh --profile bdcompat --no-open --port 0

# 5) 读插件日志：有 plugin.applied / settings.register.error，但没有 session.start
Get-Content "$t\logs\bright-drift\*.log"

# 6) 把安装副本的 'agent/session-start' 替换成 'agent/created'，重启：
#    → session.start + watcher.acquired 出现（P0-1 修复验证）
```

> 注：第 6 步只改 `%TEMP%\dsh-compat-home\profiles\bdcompat\node_modules\bright-drift\lib\index.js` 的**临时副本**，未改动仓库与已发布包。

---

## 11. 落地补充（2026-10，0.4.0 实施时实测发现）

本节记录**本报告未预见、实施 0.4.0 时由"真实安装形态"冒烟暴露**的问题，结论已并入 phase1 决策 **D11**：

| # | 问题 | 证据 | 结论 |
|---|---|---|---|
| S1 | 插件被 `dsh plugin add file:` 拷进 profile 后，**运行期 `import '@deepseek-ai/*'` 无法解析**——profile 的 `node_modules` 里只有插件自身与其普通依赖，宿主的 `@deepseek-ai/*` 在 dsh 安装树内，`HostResolvedRootInclude` 只解析 entry 名、不注入插件的解析路径 | `ERR_MODULE_NOT_FOUND Cannot find package '@deepseek-ai/schemastery' imported from .../node_modules/bright-drift/lib/config.js`；启动报文 `bright-drift (bright-drift): failed to import` | 运行期**零 dsh import**：注入消息改为本地 `createNoticeMessage()`（与 `createUserMessage`/`boundContextSummary` 逐字等价，单测对拍）；`@deepseek-ai/schemastery` 是唯一例外，改为 **`dependencies`** 以便装进 profile（其链为叶子库；volatile 跨副本安全：`Symbol.for('cosmokit.volatile.write')` + `~standard.vendor` 字符串判定） |
| S2 | 本地源码安装时 profile 的 override 必须用 `file:`；`link:` **不会**把 `bright-drift-core` 落地到 profile（`pnpm list` 显示已解析，实际无该目录），症状同样是 `failed to import` | 同上，错误里先报 `bright-drift-core`，换 `file:` override 后该错误消失、改为报 S1 的包 | README 双语与 AGENTS §4 的安装命令改为 `dsh plugin add file:…` + `overrides: bright-drift-core: file:<abs>`；`link:` 仅保留为临时迭代手段并标注"不能用于验证安装" |
| S3 | 旧冒烟用符号链接安装，**天然掩盖 S1/S2** | junction 形态 8/8 通过，`file:` 形态立刻失败 | 冒烟改为 `dsh plugin add file:<repo>` 真实形态，并新增"安装副本能独立 `import` 自身依赖"断言 |

修复后在 dsh 0.2.0-rc.2 上实测：真实安装形态冒烟 8/8 通过（`plugin.applied / config.applied / session.start / watcher.acquired / 零 error / volatile 热更新无 remount / drift.detected`），单测 43 项、全仓 build+typecheck 零错。

### 11.1 R2（PTC 模式）关闭：嵌套子派发仍走完整 tools/* 管线

§8 的 R2 只剩静态推断，本次用 `DSH_TOOLS_MODE=ptc` 起进程、新会话实测（模型只能调 `run_code`，`read`/`edit`/`pwsh` 全部变为 run_code 内部子派发）：

| 观测 | 日志证据 | 说明 |
|---|---|---|
| 嵌套 `read` 产生观察 | `baseline.update {path: "packages/dsh-adapter/cordis.patch.yml", source: "read", hash: "976c10a5…"}` | `tools/result` 对子派发同样触发，且携带 `agent` 与原始 `file_path` |
| 嵌套 `pwsh` 开归因窗口 | `window.open {callId: "call_00_fJ1EuA5q7frLgfU62Jy24737:ptc:1", predicted: ["packages/dsh-adapter/cordis.patch.yml"]}` | callId 的 `:ptc:1` 后缀直接证明是 PTC 子派发；`predicted` 非空说明 `analyzeCommand` 对子派发同样拿到了**原始命令文本** |
| 归因 B 类 | 通知正文 `COMMAND-SIDE-EFFECT  你的命令 Add-Content -LiteralPath '…cordis.patch.yml' -Value '# ptc-shell-test' …` | 与 native 模式逐字同形 |
| agent 自写回声抑制 | `baseline.update {source: "write", prevHash: "eb61cbd8…"}`，其后通知不含该文件 | Sync Point 与回声抑制对嵌套写同样成立 |
| 外部改动 C 类 | `EXTERNAL·MODIFIED (high confidence) … (+1 -0)` + `@@ -3,3 +3,4 @@` 行级 diff | 与 native 一致 |
| 静态分析落空时的兜底 | `git checkout -- <path>` 的 `predicted: []`（分析器不解析该子命令的路径参数），但改动仍被归为 B 类 | 窗口本身即兜底依据，预测不是归因的必要条件 |
| 会话健康 | 该会话 16 条事件、0 条 `*.error`；同 root 上两个会话仅 `watcher.acquired` 一次 | watcher refcount 共享在多会话下正确 |

**结论**：R2 关闭——PTC 模式不需要任何额外代码路径，审计 §5-A11 的"维持单通道"决策在 PTC 下同样成立。副作用提醒：`run_code` 内的子派发 callId 形如 `<root>:ptc:<n>`，若将来新增按 callId 的持久键，必须按完整字符串（含后缀）处理，不能假定为纯 UUID。

### 11.2 R3（headless 一次性退出排水）关闭

§8 的 R3 担心"chokidar 吊住进程"。用新建的 `headless` 模板 profile（`bdheadless`，`file:` 安装本地构建）+ 临时工作区跑一次性任务，两次结果一致：

| 指标 | Run 1（读文件任务） | Run 2（无工具任务） |
|---|---|---|
| 墙钟耗时 / 退出码 | 5.4s / 0 | 3.4s / 0 |
| `plugin.applied` → `watcher.acquired` | 08:38.488 → 08:38.571（83ms） | 04:01.859 → 04:01.939（80ms） |
| 业务事件 | `session.start`(startup) → `baseline.update(note.txt, read)` | 无（任务未触碰文件） |
| 排水序列 | `persist.saved(turn-stopping)` → `plugin.disposed` → `persist.saved(teardown)` | 同左（`entries=0`） |

关键判据：**watcher 已真实 acquire（chokidar 在跑）之后，进程仍在 4–5 秒内以 exit 0 自然退出**——即 `ctx.effect` 的 disposer 确实跑到了 `watchers.stopAll()`，事件循环没有被文件监听句柄占住。对照 M2 事故（teardown 缺失时 headless 以 10 分钟超时暴露），可确认该回归未在 0.2.0 复现。附带确认：`persist.saved` 出现两次（turn-stopping 与 teardown 各一次），重复 flush 幂等。

**结论**：R3 关闭。headless 形态无需任何改动。
