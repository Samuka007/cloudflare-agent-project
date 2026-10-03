# omp 引擎可移植性考古（#28 前置研究）

研究对象：[github.com/can1357/oh-my-pi](https://github.com/can1357/oh-my-pi)（下称 omp，MIT，badlogic/pi-mono 的 fork），浅克隆于 `/tmp/omp-src`，**commit 锚点 `d4d49e71bef3ac1420d45febf215b951decf5ae9`**（2026-10-03）。所有 `path:line` 相对该提交；上游前进后行号漂移，结构结论稳定。omp 源码不入本仓，本文只引用证据。

目的：为 #28（provider = loop 应用、M0 翻译层四问裁定）供给 omp 侧事实。裁定路由规则（#28 评论）：上云决策归本项目，**agent 功能语义抄 omp**，产品形状抄 bb。本文回答六问：①引擎架构 ②`--mode rpc` 合同 ③Node/Rust 绑定 ④可嵌入性 ⑤移植策略对照 ⑥工具集清单。

方法：五条并行读源 lane（loop/prompt+tools/rpc/bindings/embed）分头实读并交叉引用，本文为其综合；关键结论均给出双源或源码+文档互证。

---

## 0. 结论速览

| 问题 | 一句话结论 |
|---|---|
| ① 引擎架构 | loop 是**单文件双层 while + 三队列 + 标志位状态**（无枚举状态机），纯 TS；系统提示是 `string[]` 有序块、模板+数据一次性渲染、签名门控重建；工具契约 = 数据（schema 极小）+ description 文本承载协议；消息装配 = append-only 确定性投影，配对不变量是硬约束 |
| ② `--mode rpc` | **换行分隔 JSONL 帧（非 JSON-RPC 2.0）**；单进程=单会话、帧内无 threadId；无 thread/list、无 shutdown；完成语义三段式 ack→`prompt_result`→`session_settled`；恢复面 = `open_session`/`switch_session`/`get_entries{since}` |
| ③ 绑定清单 | TS→Rust 唯一通道是 **napi-rs 单 addon**（pi-natives，~130 导出）；**agent loop 本体零 Rust 依赖**（仅 tokenizer 有降级）；`child_process` 零使用（全 Bun.spawn / Rust 内嵌 shell）；provider 主路径是全局 `fetch` |
| ④ 可嵌入性 | `@oh-my-pi/pi-coding-agent` 以**裸 TS 源码**发布，`createAgentSession()` 全可选参数、`hasUI` 默认 false，headless 是一等路径；**四条注入缝**（StreamFn 传输 / getApiKey 鉴权 / SessionStorage 存储 / customTools+host-tools 工具）证明引擎可脱离终端与真实 fs 运行 |
| ⑤ 移植策略 | 三案均可行但死点不同：(a) 整包嵌入 = 垫片工程（Bun/sqlite/natives/fs 四债）；(b) 形状照抄 = 零垫片但语义转录风险；(c) 混合 = 只嵌 loop+provider 核心、工具走 host-tool 回桥，**与 omp 自身的缝完全同构**，证据最厚 |
| ⑥ 工具集 | 源码权威 = **30 内建 + 3 隐藏 = 33**（README 的"31"过时）；13 核心 essential + 17 discoverable + 3 条件激活 |

---

## 1. 引擎架构

### 1.1 包分层：引擎内核与 CLI 的边界

```
packages/agent   (@oh-my-pi/pi-agent-core)  ← loop 内核：agent.ts / agent-loop.ts / types.ts / compaction/
packages/ai      (@oh-my-pi/pi-ai)          ← provider 层：stream/streamSimple + 各 provider convertMessages
packages/coding-agent (@oh-my-pi/pi-coding-agent) ← 引擎装配 + CLI/TUI/工具实现 + RPC/ACP 模式
packages/wire    (@oh-my-pi/pi-wire)        ← RPC 线协议纯类型（零依赖）
```

- `packages/agent/package.json:37-45`：内核依赖仅 pi-ai/pi-catalog/pi-natives/pi-utils/pi-wire/snapcompact/otel-api。其中 pi-natives 在内核内的唯一用途是 tokenizer（§3.4）。
- **内核的 `node:` 导入全包只有 3 处**：`node:path`（speculative-execution.ts:1）、`node:timers/promises`（utils/yield.ts:28）、`node:util/types`（agent.ts:4）——loop 语义层面没有任何进程/fs/网络依赖。

### 1.2 loop 主循环

入口（`packages/agent/src/agent-loop.ts`）：

```ts
// agent-loop.ts:620-626
export function agentLoop(
	prompts: AgentMessage[],
	context: AgentContext,
	config: AgentLoopConfig,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): EventStream<AgentEvent, AgentMessage[]>
```

- `agentLoopContinue(context, ...)`（agent-loop.ts:682-712）：无新 prompt 的续跑（重试/恢复队列）；空 context 报错（:688-690），**结尾 assistant 带未配对 toolCall 才允许续跑**（`unpairedToolCallTail` :661-670）——重放/恢复场景的守门规则。
- 真正循环体 `runLoopBody`（:1180-1824），**双层 while**（:1293-1298）：

```ts
// agent-loop.ts:1293-1298
// Outer loop: continues when queued follow-up messages arrive after agent would stop
while (true) {
	let hasMoreToolCalls = true;
	// Inner loop: process tool calls and steering messages
	while (hasMoreToolCalls || pendingMessages.length > 0) {
```

内层每轮顺序：deadline 检查+协作让出（:1299-1306）→ **pause 门停靠**（:1310）→ 合入 `pendingMessages`（steering/aside，:1317-1325）→ `syncContextBeforeModelCall` 钩子 → `prepareProviderCall`（:1360）→ `beforeModelCall` 门（:1362-1373，可 `{stop:true}` 终止 run）→ `turn_start`（:1412-1416）→ **LLM 调用** `streamAssistantResponse`（:1422，函数体 :1974-2589）→ 工具批次 `executeToolCalls`（:1642，函数体 :3196+）。

- **续跑/停止判定**：`runnableStop = stopReason === "toolUse" || stopReason === "stop"`；`hasMoreToolCalls = runnableStop && toolCalls.length > 0`（:1587-1588）。注释（:1564-1576）明确三条规则：`stop_reason` 不回传 wire；`end_turn` 下出现 toolCall **照样执行**；唯一必须停的是 `length` 截断（尾部工具参数可能不完整）。
- 非终态重采样上限：Codex `pause_turn` 续跑 ≤8（:119, :1700-1712）、DSML 泄漏 nudge ≤2（:127, :1713-1732）、软性工具要求强制升级 ≤3（:135, :1609-1640）。
- run 结束条件（互斥五类）：队列空 break（:1809）/ gate stop（:1408）/ assistant error|aborted（:1560-1561）/ deadline（:1301, :1783）/ 终止工具结果（:1693，子代理 `yield`）。

**状态模型：没有枚举状态机**，可观测状态 = 标志位（`packages/agent/src/types.ts:980-991`）：

```ts
export interface AgentState {
	systemPrompt: string[];
	model: Model;
	thinkingLevel?: Effort;
	disableReasoning?: boolean;
	tools: AgentTool<any>[];
	messages: AgentMessage[];
	isStreaming: boolean;
	streamMessage: AgentMessage | null;
	pendingToolCalls: Set<string>;
	error?: string;
}
```

外加进程级 `AgentPauseGate`（pause.ts:25-107）与 run 级 AbortSignal。状态迁移点全在 `Agent#runLoop`（agent.ts:1652-2077：`isStreaming` 进出、`streamMessage` 随 message_start/update/end、`pendingToolCalls` 随 tool_execution_start/end）。

### 1.3 Run / Turn / Message 生命周期

- **Run** = 一次 `agentLoop` 调用，事件界 `agent_start`…`agent_end`（types.ts:1232-1239）。
- **Turn** = 一条 assistant 响应 + 其全部工具调用/结果（types.ts:1240-1242 注释原文）。每条 assistant 收尾发 `turn_end` 并调 `onTurnEnd` 钩子（agent-loop.ts:753-775）。
- **Message** = `AgentMessage`，四种标准 role：`user`/`developer`/`assistant`/`toolResult`（pi-ai types.ts:1053/1071/1127/1202），加宿主自定义 role（经 `convertToLlm` 过滤/转换）。
- 用户入口 `Agent.prompt()`（agent.ts:1499-1542）：busy 时抛 `AgentBusyError` 并明示走 `steer()`/`followUp()`（:1504-1506）——**注入与排队在类型层面就是两条路**。

### 1.4 Steer：turn 中途输入的语义

两条独立队列（agent.ts:415-416, :1295-1308）：

```ts
// agent.ts:1295-1308
steer(m: AgentMessage)   { this.#steeringQueue.push(m);  ... }   // 工作中注入
followUp(m: AgentMessage){ this.#followUpQueue.push(m);  ... }   // 停止后排程
```

- 投递模式 `"all" | "one-at-a-time"`，默认 one-at-a-time（agent.ts:538-539）。
- **注入点 = 边界，不是立即**：①run 开始（agent-loop.ts:1226）②内层每轮顶部合入 pending（:1317-1325，即"下一次模型调用之前"进 history）③**工具批次结束后**（:1752-1780）④外层停止点重查再退（:1799-1806，有则 `continue` 外层——停止点必须"排水"，否则消息滞留）。
- **批内探测是非消费 peek**：`hasSteeringMessages`（types.ts:272-291："poll 只 peek，队列保留所有权直到注入边界"）。探测到排队 steering 时只硬中止 **interruptible 纯等待工具**（agent-loop.ts:3243-3252, :3370-3375），其余工具靠协作 `steeringSignal` 自愿让位（bash 转后台）；**run 不取消**。
- **外部 abort 不清队列**（:1744-1751 注释：中断后 session 会 abort 再 continue，队列留给下一 run，避免"消息进了 history 但模型没机会回应"）。
- **Live steering**（provider 在流式响应里现场吃掉输入）：`LiveSteeringChannel`（live-steering.ts:28-89，`claim/accept/reject`）；不可现场转换的（非纯文本/带图）回落 deferred、边界注入；响应结束 finally 收账，`message.liveSteered = true`（agent-loop.ts:1488-1494, :1754-1758）。
- **Aside**（后台完成通知等被动消息）：永不打断工具（types.ts:341-350），带两阶段提交符号 `ASIDE_MESSAGE_COMMIT/DISCARD`（types.ts:48-65）。

### 1.5 消息装配：事件/会话结构 → 模型 messages

**装配流水线**（`prepareProviderCall`，agent-loop.ts:1914-1968；README 宣示同构）：

```
AgentMessage[] → transformContext() → convertToLlm() → per-provider normalize
              → append-only build → transformProviderContext() → provider request
```

1. `transformContext`（:1921-1923）：AgentMessage 级变换（压缩用此钩子，见 §1.7）。
2. `convertToLlm`（**必填**，types.ts:222）。默认实现（agent.ts:73-78）：

```ts
// agent.ts:73-78
function defaultConvertToLlm(messages: AgentMessage[]): Message[] {
	return messages.filter((m): m is Message => {
		if (m.role === "assistant") return !isProviderRefusalMessage(m);
		return m.role === "user" || m.role === "developer" || m.role === "toolResult";
	});
}
```

3. `normalizeMessagesForProvider`（:886-914，仅个别 provider 需要降级处理）。
4. **append-only 构建**（`StablePrefix` + `AppendOnlyLog`，append-only-context.ts:89-360）：system prompt + 工具规格首建后字节冻结（fingerprint 不变即复用）；消息只增不重序列化；`syncMessages` 发现数组缩短（=压缩发生）才整体重置（:347-360）。语义 = 配合 provider 前缀缓存，每轮只有新增消息是 cache miss。
5. 每次模型调用前**全量重建**请求上下文——没有跨轮的"请求对象复用"；这是重放一致性的结构性保证（同一 history 必然投影出同一 messages）。

**流式事件 → 内部事件**：provider 的 `AssistantMessageEvent`（start/text_delta/toolcall_delta/...）在 `streamAssistantResponse` 的 switch（:2352-2495）映射为 AgentEvent；流结束经 `retainCompletedToolCalls`（:2591-2603）——**error/abort 时只保留 `toolcall_end` 完成的工具调用**（未完成参数不安全，:2758-2760）。AgentEvent 全集（types.ts:1230-1252）：

```ts
agent_start | agent_end | turn_start | turn_end
message_start | message_update | message_end
tool_execution_start | tool_execution_update | tool_stream_update | tool_execution_end
```

**工具批次**：一个 assistant 消息 = 一个 batch；`concurrency: "shared"|"exclusive"`（或按参函数）调度（:3771-3797），`Promise.allSettled` 收集（:3799）——单工具失败不炸批次；**结果按批次 index 顺序入 history**（`flushResultMessages` :3381-3391，先完成也等槽位）。错误统一 `{ content: [{type:"text", text: e.message}], isError: true }`（:3595-3602）；`coerceToolResult`（:540-603）兜底畸形返回，空 error 内容补哨兵文本（Anthropic 拒绝空 error tool_result）。

**配对不变量（#28 裁定③的直接对标物）**：任何路径（abort/error/length/skip）都不得让 toolCall 悬空——aborted assistant 补占位 toolResult（:1520-1555）、length 截断为尾部 toolCall 补占位（:1665-1689）、中断批尾扫补 skipped 结果（:3809-3819）、**已完成的工具保留真实结果**（:3656-3663："a completed tool already ran its side effects, so the model must see what actually happened"）。

### 1.6 Abort 与 Pause（两个不同的轴）

- **Abort（run 级）**：单一 abort race（:2177-2200，listener 只注册一次）→ `finishAbortedStream` → `iterator.return()` 清理 + aborted assistant（stopReason:"aborted"，只留完成 toolCall）+ 占位结果保配对。分层：run 级 signal / 工具级 signal（external vs interruptible 双轨）/ 进程级 pause——**pause 不能用 abort 模拟**（pause.ts:1-19 头注释）。
- **Pause（进程级）**：`agentPauseGate` 单例在**每次模型调用前（:1310）+ 每个工具开始前（:3455）**停靠；语义 = 在飞工作跑完、队列不动、resume 后正常投递；run 自己的 abort 能解救 park 但不解除门。

### 1.7 Compaction：会话条目模型与确定性重建

- 压缩与分支摘要是**一等会话条目**（`CompactionEntry`/`BranchSummaryEntry`），不是普通消息（docs/compaction.md:29-45；entry 定义 `session-entries.ts`）。
- 重建规则（`buildSessionContext`，docs/compaction.md:46-53）：最新 compaction → 一条 `compactionSummary` 消息；`firstKeptEntryId` 起的保留条目重入；后续条目追加；`branch_summary`/`custom_message` 各自转换。custom 角色在 `convertToLlm()` 里经**静态模板**（compaction/prompts/compaction-summary-context.md 等）渲染成 user 消息——投影规则完全确定。
- 触发不在 loop 内：宿主（coding-agent session）在 `onTurnEnd`（session-maintenance.ts:2587-2590）与 agent_end 后检查执行；loop 只通过 `transformContext` 钩子 + AppendOnlyContext 的缩短检测感知（agent-loop.ts:1921-1923；append-only-context.ts:347-350）。
- 阈值判定纯函数在内核包：`shouldCompact(contextTokens, contextWindow, settings)`（agent/compaction/compaction.ts:364-367）。

### 1.8 系统提示拼装（prompt stack）

入口 `buildSystemPrompt(options)`：`packages/coding-agent/src/system-prompt.ts:631-1050`，**返回 `string[]` 有序块**（:597-609，"Providers should preserve entries as distinct messages/blocks"）：

1. **Block 0 — 主模板** `prompts/system/system-prompt.md`（250 行，13 段有序：RFC/XML 声明 → §Role → #Personality → §Runtime/#Skills & Rules → #Internal URLs → #Tool Inventory → #xd:// Tool Devices → §Scratchpad → §Tool Policy（含 `i` intent 字段说明）→ #Delegation → §Workflow → §Delivery → §Critical）。`customPrompt`/`SYSTEM.md` 可换模板，`systemPromptTemplate` 可全替换（:1008-1010）。
2. **eval prelude guidance 条目**（:1026-1029，browser/computer 等各占一条）。
3. **尾部 `<project-context>` 块**（project-prompt.md 渲染：workstation/repo-rules/dir-context/workspace-tree/workspace-roots/activeRepo/critical/appendPrompt，:1035-1040）。

工程性质（移植必须复制的三条）：

- **静态模板 + 一次性数据注入**：动态数据全经 `data` 对象渲染（:961-1007：environment/toolInventory/skills/contextFiles/...）；准备步骤并行、5s 竞速降级（`SYSTEM_PROMPT_PREP_TIMEOUT_MS = 5000`，:217, :723-752）——任何一步不阻塞启动。
- **缓存前缀是产品设计**：随目录变化的内容刻意切到尾部独立块，注释原文（:1030-1034）："so sessions in different directories share the static prefix and the Anthropic head cache breakpoint lands right before this block."
- **签名门控重建**：`session-tools.ts:2058-2090` 计算 prompt 输入签名，注释保证 "Two calls producing identical signatures are guaranteed to produce identical system prompt bytes"——相同签名跳过重建。每轮动态内容（工具结果附加指令、steering、TTSR 提醒）走 `addAdditionalContext`/additionalMessages 通道，**不改写系统提示**（types.ts:1063-1076）。
- append prompt 组装：memory/auto-learn/MCP 指令 + 用户 `--append-system-prompt` 文本经 `composeAppendPrompt`（system-prompt.ts:619-628）包成 `## User Instructions` 独立节（sdk.ts:3743-3811；MCP server instructions 每 server 截断 4000 字符，sdk.ts:1292）。

### 1.9 工具注册表与 tool schema 形状

**三层注册表**：

1. 名字正典：`tools/builtin-names.ts:1-38`（30 BUILTIN + 3 HIDDEN + 别名 `search→grep`；`mcp__<server>_<tool>` 前缀识别 :66-68）。
2. 工厂映射：`tools/index.ts:563-600`：

```ts
// tools/index.ts:557, 563-600（节选）
export type ToolFactory = (session: ToolSession) => Tool | null | Promise<Tool | null>;
export const BUILTIN_TOOLS: Record<BuiltinToolName, ToolFactory> = {
	read: s => new ReadTool(s),
	bash: s => new BashTool(s),
	...
};
export const HIDDEN_TOOLS: Record<HiddenToolName, ToolFactory> = {
	think: () => new ThinkTool(), yield: s => new YieldTool(s), goal: s => new GoalTool(s),
};
```

3. 选择计划：`resolveBuiltinToolPlan`（tools/index.ts:628-816）——`restrictToolNames` 不得扩张、自动补对（checkpoint↔rewind、edit→ast_edit、memory 四件套…:678-739）、逐工具 settings 门（`bash`←exec.enabled、`eval`←内核预检 :651-671 等 :740-802）。

**essential 铁律清单**（`tools/essential-tools.ts:23-37`）13 个核心名永不被降级为 xd:// 设备：`read, write, bash, edit, glob, find, eval, task, wait, learn, manage_skill, context_notes, new_context`。

**类型契约**：wire 基座 `Tool`（`packages/ai/src/types.ts:1463-1499`：name/description/parameters/strict/customWireName/native/examples）⊕ 运行时 `AgentTool`（`packages/agent/src/types.ts:1107-1217`：label/loadMode/concurrency/interruptible/approval/execute/renderCall/...）。执行签名（types.ts:1078-1085）：

```ts
export type AgentToolExecFn<...> = (
	this: AgentTool<...>, toolCallId: string, params: Static<TParameters>,
	signal?: AbortSignal, onUpdate?: AgentToolUpdateCallback, context?: AgentToolContext,
) => Promise<AgentToolResult>;
// AgentToolResult（types.ts:993-1008）: { content, details?, isError?, providerMetadata?, useless? }
```

`details` 不上 wire（UI/日志）；`useless` = 压缩可回收标记；截断溢出走 `artifact://` meta（tools/tool-result.ts builder）。

**每次模型调用的工具目录变换** `normalizeTools`（agent-loop.ts:1002-1034）：ArkType schema → JSON Schema；**注入 `i` intent 字段**（:916-998：默认 required、置首、"concise intent"、200 字符上限，`PI_NO_INTENT=1` 可关）——`i` 是运行时注入、不写进工具作者 schema；`examples` 渲染成调用语法 `<example>` 块拼进 description。

**bash 工具定义原文**（`packages/coding-agent/src/tools/bash.ts:330-337`，ArkType DSL）：

```ts
const BASH_TIMEOUT_DESCRIPTION = `timeout in seconds; 0 disables the command deadline; nonzero values are clamped to ${TOOL_TIMEOUTS.bash.min}-${TOOL_TIMEOUTS.bash.max}`;

const bashSchemaBase = type({
	command: type("string"),
	"timeout?": type("number").describe(BASH_TIMEOUT_DESCRIPTION),
	"cwd?": "string",
	"pty?": "boolean",
});
```

按设置门控的变体（bash.ts:339-380）：`bashSchemaWithAsync` 加 `"async?": "boolean"`；`bashSchemaWithService` 加 `"name?": "string <= 48"` + `"ready?": {log?, port?, host?, timeout?}`；第四变体为二者并。类元数据（bash.ts:495-503, :594-633）：`name = "bash"`、`label = "Bash"`、`loadMode = "essential"`、`strict = true`、`concurrency = args.pty === true ? "exclusive" : "shared"`、`parameters` getter 按设置选 schema 变体。

**description 模板**（`prompts/tools/bash.md` 全文，渲染即模型所见）：

```md
Persistent shell: one fact command/pipeline; dependencies use `&&`.
{{#if hasEval}}Scripts/heredocs/`$(…)`/complex pipelines → `eval`.{{else}}Scripts/heredocs/`$(…)`/complex flow → dedicated tool or checked-in script.{{/if}}
`cwd`, not `cd`; `pty` only interactive.
Internal URIs work as paths for builtins/coreutils, redirects, globs.
{{#if asyncEnabled}}`async` defers finite results but keeps the deadline (default {{defaultTimeoutSec}}s); `timeout: 0` for watchers and long jobs.{{/if}}
No `head`/`tail`/redirection; output trunc by default, full result at `artifact://<id>`.
{{#if hasLaunch}}Long-lived services: unique name; ready requires name; no async/timeout; pty defaults true. ready needs log regex or port (both if given); host defaults 127.0.0.1, ready.timeout 30s.{{/if}}
{{#if autoBackgroundEnabled}}Background results follow; NEVER poll; foreground wait unchanged.{{/if}}
```

要点：**使用协议承载在 description 文本，schema 反而极小**（read/grep 同构：read schema 仅一个 `path` 字段，read.ts:687-689；grep 为 pattern/path?/case?/gitignore?/skip?，grep.ts:60-66）。移植时 description 模板（prompts/tools/*.md）是与 schema 同级的资产。

---

## 2. `--mode rpc` 的 omp 侧合同

### 2.1 路由与帧格式

- Mode 枚举 `"text" | "json" | "rpc" | "acp" | "rpc-ui"`（cli/args.ts:23）；路由链 main.ts:2520-2530 动态 import `runRpcMode`（modes/rpc/rpc-mode.ts，2487 行）。
- **帧格式 = 换行分隔 JSON**，每帧 `{id?, type, ...}` 判别（rpc-types.ts:1-6 头注："Commands are sent as JSON lines on stdin. Responses and events are emitted as JSON lines on stdout"；逐行解析 rpc-input.ts:46-64，坏行回错误帧但不中断循环）。
- **陷阱**：`jsonrpc/` 目录名有误导——那是给 LSP/DAP stdio 客户端的 `Content-Length:` 帧编解码（message-framing.ts:1-8），与 `--mode rpc` 无关。bb 桥文档说的"JSON-RPC 2.0 信封"是 **bb 侧 bridge 的加壳**，omp 原生没有。
- 就绪帧（连接后第一帧，rpc-mode.ts:1234-1242）：`{type:"ready", protocolVersion:1, supportedProtocolVersions:[1,2], maxFrameBytes, maxReassembledFrameBytes}`——与 bb 侧记录逐字一致。
- 帧预算（rpc-frame.ts:6-10）：单帧 ≤1MiB；v2（`negotiate_protocol` :1719-1723 协商）把 >1MiB 逻辑帧拆 `rpc_chunk`（256KiB/片，重组上限 64MiB）；v1 超限走"压缩→shrink→overflow 帧"降级（:192-264）。

### 2.2 方法清单（omp 原生帧 ↔ bb 方法）

bb 侧每个 JSON-RPC 方法对应的 omp 原生帧：

| bb 方法 | omp 原生帧 | 委托（AgentSession 方法） | 证据 |
|---|---|---|---|
| `initialize` | 读 `ready` 帧 + 可选 `negotiate_protocol` | — | rpc-mode.ts:1719-1723 |
| `model/list` | `get_available_models` | `session.getAvailableModels` | rpc-mode.ts:2092-2125 |
| `thread/start` | （spawn 新进程即新会话，无显式 new）| — | §2.4 |
| `thread/resume` | `open_session {sessionDir}` 或 `switch_session {sessionPath}` | `openRpcSession` / `session.switchSession` | rpc-mode.ts:819-848, :789-792 |
| `turn/start` | `prompt {message, images?, streamingBehavior?}` | `session.prompt` | rpc-mode.ts:1729-1751; agent-session.ts:6888 |
| `turn/steer` | `steer {message, images?}` | `session.steer` | rpc-mode.ts:1753-1757; agent-session.ts:7829 |
| `thread/stop` | `abort` + 关 stdin | `session.abort({reason})` | rpc-mode.ts:1778-1781; agent-session.ts:9109 |

omp 原生命令全集远大于此（分发 switch rpc-mode.ts:1715-2424；机器可读命令表 `modes/rpc/wire/commands.ts:34-329`，codegen 源 = `wire/rpc-wire.schema.json`，6224 行 JSON Schema 2020-12）：`follow_up`/`remove_queued_message`/`promote_queued_message`/`abort_and_prompt`/`new_session`/`branch`/`fork`/`get_state`/`set_model`/`set_thinking_level` 族/`set_steering_mode`/`compact`/`bash`/`get_entries`/`get_tree`/`get_messages(_page)`/`set_event_filter`/`get_subagents` 族/`set_host_tools`/`set_host_uri_schemes` 等。**没有 `thread/list`、没有 `shutdown` 命令**——omp RPC 进程就是一个会话。

### 2.3 事件流与完成语义

- 事件源 = `AgentEvent`（§1.5）+ 会话层扩展（agent-session-events.ts:14-88：`auto_compaction_*`、`auto_retry_*`、`model_changed`、`notice`、`queue_update`、`goal_updated` 等）。
- 转发器 `RpcSessionEventForwarder`（rpc-session-events.ts:26-88）：给 message 事件统一打 `messageId`（`msg-<n>`，**先分配 id 再过滤**，改过滤不会把一条消息劈成两个 id）；`set_event_filter {events, messageUpdates}` 控制带宽——**默认 `"full"` 每个 delta 帧重发全量累积消息**，`"delta"` 投影只留增量。RPC 层不做 delta 合并（每事件 1 帧）；唯二合流是 `queue_update` 快照与 `live_levels`（100ms）。
- **完成语义三段式**：`prompt` 立即 ack `{agentInvoked}` → 终态 `prompt_result`（每个被接受的 prompt **恰好一帧**，按 id 关联：`{status: "completed"|"aborted"|"error", error?{message,provider?,model?,httpStatus?,retryable}, sessionSettled}`，rpc-prompt-results.ts:38-111）→ `session_settled`（谓词 = 无活跃 run、无排队、无后台工作，rpc-session-settle.ts:38-51）。**计费/结算钩子应挂 `prompt_result.sessionSettled === true`，不是 `agent_end`**。`error.retryable` 是 omp 唯一的可重试信号。

### 2.4 会话/恢复描述符（喂 ompRecovery）

- **进程=会话**：一个 `omp --mode rpc` 进程持有一个 session；bb 用"每 thread 一个子进程"补多线程，帧内没有 threadId（bb 桥的 `threadId`/`providerThreadId` 是 bridge 侧概念）。
- 磁盘身份：`sessionId = Bun.randomUUIDv7()`（session-manager.ts:127-129）；文件 `<sessionDir>/<fileSafeTimestamp>_<sessionId>.jsonl`（:1153-1155）；目录按 cwd 编码（session-paths.ts:213-215）；首行 `SessionHeader`（session-entries.ts:36-55：`{type:"session", id, cwd, parentSession?, previousSessionFiles?, providerPromptCacheKey?}`），后续每行 `SessionEntry {type, id, parentId, timestamp}`（id/parentId 构成树）。JSONL 格式与条目分类的完整规范见 docs/session.md（`SessionEntry` 联合含 message/model_usage/compaction/compaction/... 十余种）。
- 恢复入口：`open_session {sessionDir}` = "目录内最近非空会话"（`findMostRecentNonEmptySession`，rpc-mode.ts:819-848，--continue 的运行时等价物）；`switch_session {sessionPath}` = 精确文件（:789-792）；增量对账 `get_entries {since: entryId}`（未知 cursor 显式报错，rpc-compat.ts:14-23）。
- **死点更正：`ompRecovery` 在 omp 仓 grep 零命中——它是 bb 侧自造的描述符**。omp 侧可承载的等价字段：`{sessionId(=providerThreadId), sessionFile, cwd, lastEntryId, parentSession?}`；最稳恢复序：`switch_session(sessionFile)` → 失败则 `open_session(sessionDirForCwd(cwd))` → `get_entries{since}` 对账。

### 2.5 错误与生命周期

- 错误帧：`{id?, type:"response", command, success:false, error: string, code?: string}`（rpc-types.ts:525）——**无数值 JSON-RPC error code**（bb 的 `-32601` 是 bridge 信封翻译）；机器码稀疏，现存仅 `session_busy` 与 `unknown_since`。坏 JSON 行回无 id 的 parse 错误帧、循环继续（rpc-mode.ts:2468）。
- **无 shutdown 方法**：优雅关闭 = stdin EOF → `pendingExtensionRequests.rejectAll` → drain inputDispatcher + shutdownCoordinator → dispose → exit（rpc-mode.ts:2471-2487）——**断连后已接受的在途命令会跑完**；宿主要打断必须显式发 `abort`（bb `thread/stop` 即此）。协议层无心跳/超时（30s 超时是 bb 侧的）。
- stdout 背压写失败 → `session.dispose()` + `exit(1)`（:1230-1233）——omp 自杀不留僵尸。

### 2.6 RPC 是嵌入式引擎的薄投影（可移植性的关键证据）

- `main.ts:4-5` 头注："The SDK does the heavy lifting"；rpc 模式 = `createAgentSession()`（sdk.ts:1618）+ `runRpcMode(session)` 投影。§2.2 表中每条命令的委托目标都是 `AgentSession` 公共方法（prompt/steer/abort/switchSession/...）——**rpc-mode.ts 只做帧编解码/id 戳/票据归属/settle 观察，零 agent 语义**。
- 官方 TS 客户端支持自定义 transport（`rpc-client.ts:77-82` `spawn?: (agentArgs) => RpcAgentProcess`）——契约不绑 stdio；`wire/rpc-wire.schema.json` 是协议单一来源、conformance 测试钉住。
- 推论：AgentDO 可以 (i) 复刻同一套帧契约（从 schema codegen）把 DO 当"进程"替代品，或 (ii) 以 `AgentSession` 方法面为 DO 内部 API、对外再投影帧。两条路的内核面相同。

---

## 3. Node/Rust 绑定清单

### 3.1 Rust 核心：13 crate，单通道 napi addon

唯一 TS→Rust 通道是 **napi-rs 单 addon**（`pi_natives.<platform>-<arch>[.variant].node`；发布为 per-platform optionalDependency 叶子包，docs/native-crates.md:9-22、natives-architecture.md:51-68）。`bun:ffi` 与 pi-* crate **完全无关**——只有 7 处 OS 库小调用（prctl/dup2/kernel32/user32 等，packages/utils/src/process-name.ts:17 等）。

| crate | 用途 | workerd 兼容 |
|---|---|---|
| `pi-natives` | 唯一 N-API 出口 cdylib（~130 导出：Shell/PtySession/EditStore/grep/glob/countTokens/ast/...） | ❌ addon 无法加载 |
| `pi-shell` + vendor/brush | 内嵌 bash 解释器（运行时无关、持久会话）+ 输出最小化器 | ❌ |
| `pi-builtins` | ~100 个进程内 coreutils（cat/grep/sed/ls/find/jq...），"永不 fork" | ❌ |
| `pi-ast` | tree-sitter/ast-grep 匹配与编辑 | ❌（tree-sitter C 库） |
| `pi-edit` | 全部 edit 模式解析/匹配/应用；错误串与旧 TS 实现 "byte-identical" | ⚠️ 算法可移植（TS 祖先在 pi-mono） |
| `pi-diff` | jsdiff v9 兼容 Myers diff，**N-API-free** | ✅ 语义可直移 |
| `pi-vcs` | gitoxide/jj 进程内 VCS | ⚠️ 需退化 |
| `pi-vfs`/`pi-walker` | 可注入 fs facade / 并行目录遍历 | ⚠️ 抽象可映射，性能降级 |
| `pi-iso`/`pi-voice`/`pi-predict` | 工作树隔离/语音/输入补全 | ❌（内核/设备依赖，agent 语义无关） |

### 3.2 Node 内建使用分桶（agent / ai / coding-agent / utils 四包）

- **`child_process`：四个包零使用**。进程 spawn 全走 `Bun.spawn`（MCP stdio、LSP、浏览器启动、direnv 等 30 文件）。
- **bash 工具不走子进程**：主路径是 Rust 内嵌 brush shell（bash-executor.ts:1-14 "Uses brush-core via native bindings"；:650-653 持久 `Shell` 会话池；builtin 进程内解析不 fork）。
- **provider HTTP 主路径 = 全局 `fetch`**（anthropic-client.ts:244 `opts.fetch ?? fetch`；`FetchImpl` 可注入）。仅三处特殊传输：cowork（node:https+自定义 CA）、cursor（node:http2）、proxy CONNECT 隧道（net+tls）——都不在主路径。AWS SigV4 **刻意 WebCrypto-only**（aws-sigv4.ts:2）——移植友好的现成范例。
- `net`（19 处）全是本地守护 socket（launch broker/LSP mux/IDA/CDP/标题守护），**无对外监听**——服务端整体不带走。`worker_threads` 7 处 = 长任务隔离（eval 沙箱/浏览器 tab/computer）。`tty` 四包零使用。
- `bun:sqlite` 22 个文件（会话索引/history/memories/各缓存）——本地索引主力。
- **最深 Bun 债在 pi-utils**：模块**加载期**即执行 `Bun.env` 枚举改写并导出 `$env = Bun.env`（utils/env.ts:293-323）+ 顶层信号注册（postmortem.ts）——workerd 下**第一个 import 就死**。pi-ai 也有模块级 `Bun.env`（stream.ts:1667）。agent-core 本体仅 `Bun.env`/`Bun.sleep`/`Bun.hash` 三种易垫片 API。

### 3.3 agent loop 是否依赖 Rust？——**否（关键判定）**

`packages/agent/src` 对 natives 的唯一依赖是 tokenizer `countTokens`（agent/src/tokenizer.ts:3），且带纯 TS 降级 `bytes/4`（:54-56，strict/approximate/upperbound 三档）。**loop 语义（消息编排/工具协议/steering/compaction 挂接）是纯 TS**；Rust 重量全在工具实现层（bash/grep/glob/edit/read 编址/vcs/pty）。

### 3.4 workerd 兼容面结论

- ❌ 原样不可移植：napi addon 全家、bun:ffi、bun:sqlite（22 文件）、Bun.spawn/PtySession、worker_threads/net 守护、node:vm/module loader、https/http2/tls 特殊传输。
- ✅ 可移植：**agent loop 全部**、provider fetch 主路径（`FetchImpl` + WebCrypto SigV4 先例）、wire 纯类型、diff 语义、SessionStorage 接口缝（§4.3）。
- ⚠️ 需重实现：bash（无对等沙箱——建议外置执行面）、grep/glob（workerd 受限 fs）、edit hashline/AST 锚定（tree-sitter WASM 或降级）、会话持久化换 DO/SQLite 后端。
- 值得抄的机制：版本护栏（release-stamp 校验 + `missingNativeExport` 惰性报错 + tokenizer 三档降级）="能力探测+优雅降级"模板。

---

## 4. 可嵌入性（`@oh-my-pi/pi-coding-agent`）

### 4.1 发布形态与公开 API

- npm 包以**裸 TS 源码**发布（`main`/`types` = `./src/index.ts`，coding-agent/package.json:48-49；`engines: bun >=1.3.14`；版本 18.5.1 @ d4d49e71）。exports = `.` + `./*` 通配（→ 117 个显式子路径组，整个 src 目录全暴露）；**没有显式 `"./sdk"` 条目**——`@oh-my-pi/pi-coding-agent/sdk` 由通配落到 `src/sdk.ts`（package.json:50-58；docs/sdk.md:35）。
- 内核包 `@oh-my-pi/pi-agent-core` 同样 `./*` 全暴露（agent/package.json:60-77）——**从源码级取用 loop 而不拖 CLI 是包结构允许的**。
- 根入口是"全家桶"（连 TUI 组件都 re-export，index.ts:39-55）；docs/sdk.md:21 明说 package root 即 complete embedding surface。

### 4.2 SDK 面：headless 是一等路径

- `createAgentSession(options?): Promise<{session: AgentSession, ...}>`（sdk.ts:1618；选项面 sdk.ts:512-844）。全部字段可选（"provide to override, omit to discover"）：`cwd`/`authStorage`/`modelRegistry`/`getApiKey`/`model`/`sessionManager`/`settings`/`customTools`/`toolNames`+`restrictToolNames`/`systemPrompt` 系/`hasUI`（**默认 false**，:801-802）/`enableMCP`/`enableLsp`/`outputSchema` 等。
- 一轮 = `session.prompt(text)`（agent-session.ts:6888）+ `session.subscribe(listener)`（:4838）；工具控制 `setActiveToolsByName`/`setForcedToolChoice`（:6052/:2483）；`Agent`/`agentLoop` 可完全绕开 SDK 直接用（agent.ts:394; agent-loop.ts:620）。
- print 模式（`omp -p` / `--mode json`）复用同一 AgentSession（print-mode.ts:1-7）——**无 TTY 全自主运行是官方主路径**，非 hack。
- `createAgentSession` 的价值在 discovery×9 + 装配（extensions/skills/MCP/LSP/contextFiles...，全 fs 扫描）；**Workers 侧应以 options 预喂替代全部 discovery**（每个 discovery 结果都有对应注入字段）。

### 4.3 四条注入缝（脱离终端/fs 的证据）

| 缝 | 接口 | 证据 |
|---|---|---|
| 传输 | `StreamFn`（= streamSimple 签名）经 `AgentOptions.streamFn` 注入（"Custom stream function (for proxy backends, etc.)"，agent.ts:158） | agent/src/types.ts:31-33; agent.ts:158。**注意：`CreateAgentSessionOptions` 不暴露 streamFn**（sdk.ts 未列）——换传输须自建 Agent 或改 base，这是 Workers 的天然切口 |
| 鉴权 | `options.getApiKey`（sdk.ts:2105-2106）+ `SimpleStreamOptions.apiKey`（静态串或 resolver，ai/types.ts:699-703）；KeyCascade 六级优先级可整体跳过 | cascade.ts:142 |
| 会话存储 | `SessionStorage` 接口（session-storage.ts:119-207，含 `SessionStorageWriter` append/flush + `expectedSize` 乐观并发锁）；实现 File/Memory/**Indexed+Redis/SQL**（indexed-session-storage.ts:144；sql-session-storage.ts:269-295 自动探测 Postgres/MySQL）；`SessionManager` 构造接受注入 storage（:909），`inMemory()` :4151；SDK 注入点 `options.sessionManager`（sdk.ts:787-788） | Redis/SQL 后端先例 = **远端会话后端是官方支持的形态**；DO 版需实现 writeTextAtomic 乐观锁 |
| 工具 | `customTools`（SDK 选项）+ RPC 层 `set_host_tools`（宿主注册工具，引擎调用时回发 `host_tool_call`、宿主回 `host_tool_result`，rpc-types.ts:689-718） | **引擎原生支持工具执行体在宿主进程**——bash 在 DO 外执行的合法形态 |

### 4.4 依赖判定与断裂顺序

引擎依赖（agent-core/ai/catalog/wire/omptype/pi-utils）vs CLI-only（puppeteer-core/axe-core/语音原生件）划分明确；**无 ink/react/yoga**（TUI 是自研差分渲染）。**关键混合体：`pi-tui` 名为 TUI，但工具语义共享件（task/edit/thinking/bash-details 等）住在 `pi-tui/tools/*` 且被 sdk.ts 深度引用（sdk.ts:34,79,95,152,229,240,279）**——"只 import 引擎"绕不开它。

import 顺序即断裂顺序（workerd）：

1. 模块加载期 `Bun` 全局（pi-utils/env.ts:293-298 + pi-ai/stream.ts:1667）→ ReferenceError；
2. `from "bun"`/`bun:sqlite`（settings.ts:32、sqlite-credential-store.ts:7、session-index.ts:21 等）→ 模块解析失败；
3. `pi-natives` `.node`（tools/read.ts:5 直接 import EditStore/notebookToEditableText；agent tokenizer 有降级）；
4. `node:fs` 同步族（session-manager.ts:1、config/settings.ts:15、FileSessionStorage fd 语义）；
5. 进程型 CLI 依赖（puppeteer/Bun.spawn/pty，可裁剪）。

传输/鉴权/存储三条缝本身干净；**Anthropic Message 协议路径**（#28 主选）在 pi-ai 内是 fetch + SSE 解析 + `Bun.SHA256`（anthropic.ts:652,690 仅 Claude-Code 伪装头用）/`Bun.Image` 缩放（:826-836）——走 open.bigmodel.cn 端点不需要伪装头，垫片面极小。

---

## 5. 移植策略对照（证据支撑，不拍板）

三案的定义：(a) **引擎嵌入**——import omp 引擎进 Worker，垫 fs/进程/Bun 面；(b) **形状照抄**——按 omp 语义在 agent DO 重写 loop（#23 状态机包外面）；(c) **混合**——嵌入内核子集（loop+provider 流适配），工具/存储/提示按 DO 生态适配。

### 5.1 证据矩阵

| 维度 | (a) 整包嵌入 | (b) 形状照抄 | (c) 混合（嵌内核+适配工具） |
|---|---|---|---|
| 必须垫/换的面 | pi-utils import 期 Bun.env 副作用；`from "bun"`/bun:sqlite ×22；pi-natives ×3 直接 import；node:fs 同步族；sdk.ts discovery×9 全换预喂 | 无垫片；但要转录 §1 全部语义为代码+测试 | 仅 agent-core 三 API（env/sleep/hash）+ pi-ai 少量 Bun 指纹（目标 provider 路径）；SessionStorage→DO 适配器（有 Redis/SQL 先例可抄） |
| 语义保真 | 结构性高（同代码） | 取决于转录测试覆盖；omp loop 体 ~1800 行、边界情形密集（§1.4-1.6 的 peek/dequeue/收账/占位规则） | loop 同代码=高；工具语义按需抄数据（schema+description 原文在 §1.9） |
| workerd 风险 | 断裂顺序 §4.4 全中；长尾 Bun 使用不可枚举尽 | 无运行时风险 | 中低；风险集中在 SessionStorage 并发语义与 ArkType（纯 TS，可跑） |
| 上游同步 | fork 面大（垫片层随上游漂移） | 无 fork；语义漂移靠测试钉 | fork 面 = agent-core+ai 子集；接口缝（StreamFn/SessionStorage）稳定 |
| 死点 | workerd 无法加载 .node → pi-natives 全家必死 → bash/grep/edit/read 增强全失；等于"有脑无手"，工具必须外置——而外置即走向 (c) | live-steering/aside/pause 三轴 + 配对不变量 + append-only 重建是隐性契约，漏一条即静默行为差 | pi-tui/tools 语义件与 SDK 耦合需抽型；`CreateAgentSessionOptions` 不暴露 streamFn → 必须绕 SDK 自建 Agent |
| 与既有裁定的关系 | 与 #28 M0 范围（bash-only+Anthropic）错配（带入大量用不到的面） | 与 M0 完全同构；future 全量工具时重抄面大 | M0 用 (b) 的窄面起手、future 工具扩张时自然滑向 (c) |

### 5.2 证据指向的结构事实（供裁决，不代裁决）

1. **omp 自己已经回答了"引擎怎么脱离本地进程"**：四条注入缝（§4.3）+ `set_host_tools` 工具回桥（§2.2）+ RPC=投影（§2.6）。*工具执行体放宿主、引擎内核放别处*是 omp 官方支持形态——(c) 混合案与 omp 自身拓扑同构，不是我们发明的接缝。
2. **loop 语义层是纯 TS、零 Rust、零进程依赖**（§3.3）——(b) 的转录对象与 (a)/(c) 的嵌入对象是同一份代码，两条路的**语义考据成本已由本文付掉**（§1 全节即转录清单）。
3. **重放一致性有结构性保证可抄**：会话 JSONL 是事件树真源，`buildSessionContext`+`convertToLlm` 是确定性投影，append-only 前缀冻结 + 签名门控重建（§1.5/§1.7/§1.8）——#28 裁定③"同一事件序列重放逐字节一致"在 omp 里的对应物就是这套，照抄规则即可，不需要发明。
4. **M0 的最小面**（Anthropic Message + bash-only）恰好落在 (b) 的舒适区：bash schema+description 原文（§1.9）、`i` intent 注入规则（§1.9）、三段式完成语义（§2.3）、恢复描述符字段（§2.4）都是**数据或短规则**，不是代码搬运。
5. **工具扩张路径**（future MUST 票）：完整工具集 33 个（§6）里 workerd 原生可实现的只有少数（todo/ask/web_search 类）；fs/进程类必然走 daemon 执行（bb 形状）或 R2/KV 适配——即 (c) 的 host-tool 回桥形态。
6. **版本锚**：引擎以裸 TS 源码发布、MIT、包结构允许子路径取用（§4.1）——无论哪条路，`git submodule`/vendored 子集 + commit 锚（本文 = d4d49e71）都是合法且可审计的依赖形态。

---

## 6. 工具集清单（喂 future must-integrate 票）

**权威来源**：`tools/builtin-names.ts:1-36` + `tools/index.ts:563-600`。**30 内建 + 3 隐藏 = 33**；README 的 "31 built-in tools"（README.md:27）过时。

### 核心 13（essential，永远 top-level；essential-tools.ts:23-37）

| 工具 | 一句话 |
|---|---|
| `read` | 文件/目录/URL/内部 URI 读取；行选择器、归档/SQLite/PDF/图片/视频分派 |
| `write` | 文件创建/覆盖；同时是 `xd://` 设备的唯一执行传输 |
| `bash` | 持久 shell：单事实命令/管道；timeout/cwd/pty/async/service 模式 |
| `edit` | 外科手术式编辑（apply_patch 风格 envelope，hashline 锚） |
| `glob` | 按模式列文件/目录（gitignore 感知） |
| `find` | 语义 grep（jfind）：按"这段代码做什么"找文件+行段 |
| `eval` | JS/Python 内核执行 + batch LLM/judge 助手 |
| `task` | 派生子代理（worktree 隔离可选），递归深度门控 |
| `wait` | 等待后台 job/服务/peer 消息 |
| `learn` | 可复用经验写入长期记忆（可升级为 managed skill） |
| `manage_skill` | 创建/更新/删除隔离 managed skill |
| `context_notes` | 读/替换持久上下文笔记本 |
| `new_context` | 请求全新上下文窗口 |

### 其余 17（discoverable——xdev 开启时降为 `xd://` 设备，从 wire tools 数组摘下、经 read/write 传输派发；xdev.ts:61-67, :228-241；read/write 永不摘除）

| 工具 | 一句话 |
|---|---|
| `grep` | 正则/目标搜索文件内容 |
| `ast_grep` | AST 结构化搜索（50+ tree-sitter 语法） |
| `ast_edit` | AST 感知结构化改写，staged 预览+裁决 |
| `lsp` | LSP 查询 14 ops（诊断/hover/定义/重命名…） |
| `debug` | DAP 调试器（断点/单步/变量/内存） |
| `ida` | 跨 agent 共享 IDA Pro 数据库 |
| `github` | gh 包装（repo/PR/issue/code search/Actions） |
| `checkpoint` | git 快照保存会话状态（与 rewind 成对自动补齐） |
| `rewind` | 回滚到 checkpoint |
| `todo` | 结构化 todo 列表（exclusive 并发） |
| `web_search` | 多后端联网搜索 |
| `ask` | 向用户结构化提问 |
| `security_scan` | 原生安全审查 + Codex Security 云操作 |
| `memory_edit` / `retain` / `recall` / `reflect` | 记忆四件套（backend 可插拔：local/Hindsight/Mnemopi） |

### 隐藏 3（条件激活）

`think`（私有 scratchpad，外部思考模式）、`yield`（子代理终结交付，结构化输出）、`goal`（goal 模式）。

### 非注册表面（同经 `write xd://` 或动态注册）

`xd://resolve|reject|report_issue|propose` 固定设备；vibe 系 5 工具（spawn/send/wait/kill/list 持久 worker）；eval prelude 的 `browser`/`computer`；`mcp__<server>_<tool>` 外部工具（xdev 开启时挂为设备，`i` 字段剥离 mcp/tool-bridge.ts:108-127）。

M0 相关裁定（#28）：**M0 仅 bash**；上表其余 = future must-integrate 票的范围清单。

---

## 7. 死点与更正清单

1. **`ompRecovery` 不存在于 omp**（全仓 grep 零命中）——bb 侧自造描述符。omp 侧等价物：`open_session`/`switch_session`/`get_entries{since}`；建议字段 `{sessionId, sessionFile, cwd, lastEntryId}`（§2.4）。
2. **`jsonrpc/` 目录是 LSP/DAP 的 Content-Length 帧编解码**，与 `--mode rpc` 无关；omp 原生 RPC 是换行 JSONL，JSON-RPC 2.0 信封是 bb bridge 加的（§2.1）。
3. **README "31 built-in tools" 过时**，源码权威 30+3=33（§6）。
4. **`@oh-my-pi/pi-coding-agent/sdk` 子路径不在 exports 显式清单**，由 `./*` 通配提供； upgrading 时通配语义若变会静默断（§4.1）。
5. **`pi-tui` 不是纯 UI**：工具语义共享件住在 `pi-tui/tools/*` 且被 SDK 深度引用——"只嵌引擎不嵌 TUI"的设想在现有包结构下不成立，需抽型（§4.4）。
6. **`CreateAgentSessionOptions` 不暴露 streamFn**：换传输必须绕过 SDK 自建 `Agent`（或改 base StreamFn）——Workers 适配点正好在这里，但也意味着 SDK 高层 API 不能原样复用（§4.3）。
7. **workerd 无法加载 napi addon**：整个 Rust core（bash 内嵌 shell/grep 引擎/hashline 编辑锚定）在 Worker 内无对等物；**edit 错误文案 "byte-identical" 语义是 Rust 侧资产**，但其 TS 祖先实现存在于上游 pi-mono，形状照抄有底稿（§3.1/§3.4）。
8. **omp 断连语义（stdin EOF → drain 在途命令再退）在 Workers 无对应信号**：DO 的 WS close 必须显式定义 abort 策略，不能模仿"跑完再死"（§2.5；bb 的 `thread/stop interrupt` 语义是可对齐的先例）。
9. **omp RPC 帧内无 threadId（进程=会话）**：AgentDO 出站帧需自行补 threadId（照 bb `sdk/message {threadId, message}` 形状），并决定多 thread 复用单 DO 还是 `receive()` 分身（§2.4/§2.6 移植要点）。

---

## 附：证据基线与复现

- 源：`git clone --depth 1 https://github.com/can1357/oh-my-pi` @ `d4d49e71bef3ac1420d45febf215b951decf5ae9`。
- 官方文档（仓内 docs/）：session.md（存储格式/存储抽象）、compaction.md（重建规则）、natives-architecture.md + native-crates.md（Rust 边界）、sdk.md（嵌入面）。
- bb 侧对照：docs/research/bb-daemon-protocol.md（§1.2 OMP bridge 契约）。
- 五 lane 原始笔记（行级证据全量）：/tmp/omp-notes/01-loop.md、02-prompt-tools.md、03-rpc.md、04-bindings.md、05-embed.md（临时区，不入仓；本文已收编全部结论性证据）。

> AGENT GENERATED: by zhipu-coding-plan/glm-5.3-flash (research subagent)
