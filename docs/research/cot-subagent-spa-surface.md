# 子代理工作与 CoT 的 SPA 呈现：codex/claude 事件考古 + bb 展开交互 + 我们 journal 缺口（#256）

回答 #256 三问：① codex 与 claude 对「子代理工作」和「CoT」各是什么事件形状；② bb SPA 的展开交互怎么实现（#229 S1–S8 的 CoT/工作流补充面）；③ 我们的 journal 需补什么。

研究对象四份，行号锚点约定：

| 锚点 | 对象 |
|---|---|
| `[pin@ba4265453]` | bb fork 点（本仓 submodule pin），`~/workspace/bb` git 考古 |
| `[vibe@8473d8c33]` | 用户 vibe 分支 `feature/omp-rpc-provider` tip（#229 已考古，本文只引用不重复） |
| `[up@c65a47fda]` | **bb 上游 get-bb/bb main**（2026-10 现势；含 #3250 thinking 行统一——pin 之后的关键演进） |
| `[wip@8ba4d43]` | 本仓 worktree 上的 WIP cot 提交（#257 CoT 面，另一 lane 在做）；基线 `origin/main debacb2` |

行号随版本漂移，file:line 仅为定位辅助。

---

## 0. 结论速览

| # | 结论 | 一句话 |
|---|------|--------|
| 1 | codex 子代理形状 | `subAgentActivity{kind: started\|interacted\|interrupted, agentThreadId, agentPath}` 帧族 → 合成 `toolCall{spawnAgent}` 委派行；子 turn 多路复用在根 provider thread 上，靠 `agentThreadId→callId` 映射 + FIFO delegation turn link 归父 `[pin]` |
| 2 | codex CoT 形状 | `reasoning{summary[], content[]}` item + `item/reasoning/summaryTextDelta`/`item/reasoning/textDelta` 双轨 delta，turn 作用域；`parentToolCallId` 可选 → 子代 CoT 自动挂委派行 `[pin]` |
| 3 | claude 子代理形状 | SDK `task_started/task_progress/task_updated/task_notification` → `backgroundTask` item（`local_agent`/`local_workflow`/`local_bash`）thread 作用域 + 委派工具行并存；workflow 带 phase/agent 合并快照 `[pin]` |
| 4 | claude CoT 形状 | `stream_event.thinking_delta` → `item/reasoning/textDelta`；完成的 assistant message 里 thinking 块 → `item/completed reasoning`（按 `(parentToolCallId, contentIndex)` 定身份）`[pin]` |
| 5 | pin 的 CoT 立场 | reasoning **永不成行**——活跃期只有 timeline 顶层 `activeThinking` 尾字段，完成即弃（快照测试锁定）`[pin]` |
| 6 | 上游已翻转 | `[up@c65a47fda]` #3250「Unify thinking rows」：reasoning 成行（活跃 `Thinking…` / 完成 `Thought`+时长+AiBrain01），可展开、跨完成保持展开态、进活动分组；**服务端 wire 零改动**——reasoning deltas 本来就在事件日志里，纯投影/SPA 演进 |
| 7 | SPA 展开机制 | 展开态 = `force ∨ (manual ?? (auto ∨ terminal latch))` 三态叠加 + 纯函数 auto-expand 收集器（scope-active 自顶向下传播）+ collapsed preview 点击/键盘豁免交互目标 `[pin]` |
| 8 | 我们现状 | `[wip@8ba4d43]` 根 turn CoT 已闭环（journal `model.thinking` → ux `item/reasoning/textDelta` → `buildActiveThinking` 折叠）；**子代理工作的 ux 面完全缺失**——`task.*` 全族在 ux-projection 显式 break，SPA 看不见任何委派 |
| 9 | 缺口清单 | G1 ux 不投影 task.* / G2 协议无 `parentToolCallId` / G3 无 thread 作用域 item 事件 / G4 子代活动与 CoT 不回父 / G5 reasoning 无终局行（不可回看）/ G6 委派行契约在 server 有、投影不产；补法 J1–J6（§6） |

---

## 1. codex 事件形状 `[pin@ba4265453]`

### 1.1 子代理：subAgentActivity 帧族 → 合成委派行

codex app-server 的 thread item 词汇（`packages/agent-runtime/src/codex/schemas.ts` `codexHandledThreadItemSchema`）：`agentMessage`/`userMessage`/`commandExecution`/`fileChange`/`mcpToolCall`/`dynamicToolCall`/`collabAgentToolCall`/`subAgentActivity`/`webSearch`/`imageView`/`reasoning`/`plan`/`contextCompaction`。与子代理直接相关的两个：

| item | schema | 锚点 |
|---|---|---|
| `subAgentActivity` | `{type:"subAgentActivity", id, kind: "started"\|"interacted"\|"interrupted", agentThreadId, agentPath}` | schemas.ts:333–343 |
| `collabAgentToolCall` | `{id, tool, status, senderThreadId, receiverThreadIds, prompt, model, reasoningEffort, agentsStates}` | schemas.ts:411–421 |

投影（`packages/agent-runtime/src/codex/subagent-activity-translation.ts`）：

- **`buildSubAgentToolCallItem`（:59–85）**：合成中性 `toolCall{tool:"spawnAgent", arguments:{senderThreadId, receiverThreadIds:[agentThreadId], description:agentPath}, status, parentToolCallId?, result:{agentPath, agentThreadId}}`——非 pending 才带 result。vibe 的 omp 适配器逐字段复刻了它（#229 §2.2）。
- **started → `item/started`(pending)、interrupted → `item/completed`(interrupted)**，scope 都是父 turn（:87–110）。
- **adapter 跟踪**（`codex/adapter.ts`）：
  - `trackedSubAgentsByCallId` + `trackedSubAgentCallIdsByAgentThreadId`（callId↔agentThreadId 双向）；`delegationParentToolCallIdsByProviderThreadId` 把子 thread id 映到父 callId；`pendingDelegationTurnLinks` FIFO 兜底——**codex 把子 turn 多路复用在根 provider thread 上**，注释明说"Queue a FIFO fallback in addition to the explicit id mapping"（:1605–1688 一带）。
  - `interacted` = 对既有 agent 的 followup：已终局则 `pendingFollowups++` 并 re-arm（:1652–1667）——完成后追加消息不产生新委派行，下一个子 turn 继续归原父。
  - `interrupted` → `completeCodexTrackedSubAgent{status:"interrupted"}`；thread close 时 `clearCodexDelegationParentState` 清全部链接（:1196–1216）。
- **thread-view 归父**：子 turn 事件经 turn link 挂 `parentToolCallId`，委派行聚合 childRows；`PendingDelegationTurnLink`（providerThreadId→callId）在 `event-projection-state.ts:50–53`、消费在 `build-event-projection.ts:403–466`（#229 §1.4 已引）。

### 1.2 CoT：reasoning item + 双轨 delta

| 事件/item | schema | 锚点 |
|---|---|---|
| `reasoning` item | `{id, summary: string[], content: string[]}` | schemas.ts:452–458 |
| `item/reasoning/summaryTextDelta` | `{threadId, providerThreadId, itemId, delta}` | event-translation.ts:930–937；domain provider-event.ts:497–503 |
| `item/reasoning/textDelta` | 同上 | event-translation.ts:941–946；domain provider-event.ts:505–511 |
| 用量 | `tokenUsage.total/last.reasoningOutputTokens` 单列 reasoning tokens | event-translation.ts:988–1001 |

- 两类 delta 均 turn 作用域（domain `thread-event-scope.ts:107–108` `{policy:"turn"}`）。
- **summary 与 content 双轨**是 codex 特有（OpenAI reasoning summaries）；最终文本偏好 summary（`parseReasoningFinalText`: `summaryText || contentText`）。
- 与子代理的组合：delta/item 都带可选 `parentToolCallId` → 子代理内的推理 delta 挂到委派行 childProjection，与根推理互不污染。

## 2. claude 事件形状 `[pin@ba4265453]`

### 2.1 子代理：SDK task 事件族 → backgroundTask item

`packages/agent-runtime/src/claude-code/task-translation.ts`：

| SDK 事件 | 翻译 | 锚点 |
|---|---|---|
| `task_started` | `item/started` + `backgroundTask` item（`taskType`∈`local_workflow`/`local_bash`/`local_agent`/`local_subagent`，未知类型进 `opaqueTaskIds` 不物化） | :321–370 |
| `task_progress` | `item/backgroundTask/progress`（**500ms 节流** `CLAUDE_TASK_PROGRESS_THROTTLE_MS`；`workflow_progress` 记录折叠进快照；usage 更新） | :372–391 |
| `task_updated` | patch（status/description/error）→ progress 事件 | :393–429 |
| `task_notification` | `item/backgroundTask/completed`（status/summary/output_file/usage 终局） | :431–451 |

- **item 形状**（domain `provider-event.ts:266–297`）：`{type:"backgroundTask", id, taskType, description, status, taskStatus, skipTranscript, workflowName?, workflow?: WorkflowProgressSnapshot, usage?, summary?, error?, outputFile?, parentToolCallId?}`。
- **thread 作用域**：progress/completed 事件用 `threadScope()`（:279–284、:292–295）——后台任务活得比 spawning turn 长，行本体由 `item/started` 落位，后续状态线程级追加。这与 turn 作用域的 toolCall 行是两套生命周期。
- **代际 id**：`task:<taskId>#<generation>`（:119–121）——同 taskId 重启换新行，不复活旧行。
- **workflow 快照**（domain `background-task.ts`）：task 类型常量 :11–14；agent 四态+settled 判定 :55–82；`workflowAgentSnapshotSchema`/`workflowPhaseSnapshotSchema` :84–117；`workflowProgressSnapshotSchema` :124–130（provider 发 delta 批次，适配器按 `(record type, index)` 折叠成全量快照，快照整体取代旧快照）；status→itemStatus 映射（paused 留 pending 可恢复、stopped→interrupted）:144–160。
- **与委派工具行并存**：claude 线同时保留 `Agent/Task` 工具调用行 + backgroundTask 卡（#229 §2.2 引 task-translation.test.ts:290–321）。
- **断线结算**：`buildInterruptedClaudeTaskEvents`（:466+）在 session 重启/provider 退出时把 open task 补成 interrupted，daemon 崩溃由服务端在 re-register 时对账。

### 2.2 CoT：thinking 块与流式 delta

`translate-message.ts` + `sdk-extraction.ts`：

- **流式**：`stream_event` 里 `content_block_delta.delta.type==="thinking_delta"` → `{contentIndex, delta}`（sdk-extraction.ts:164–188）→ **`item/reasoning/textDelta`**，itemId 按 `(parentToolCallId, contentIndex)` 经 `claudeReasoningItemIds.getOrCreate` 定身份（translate-message.ts:839–860）。
- **完成**：assistant message content 里的 `thinking` 块 → `extractThinkingBlocks`（sdk-extraction.ts:189–205）→ **`item/completed` + `reasoning{summary:[], content:[text]}`**（translate-message.ts:761–790）。流式期间已收的 delta 与终局文本由 thread-view 去重（上游 `projectAssistantAndReasoningEvent`：deltas 拼接 === 终局全文则不再追加，[up] assistant-event-projection.ts:96–118）。
- claude 没有 summary 轨（`summary: []` 恒空）；与 codex 的差异只在上游是否有 summaries。

## 3. omp 帧对照（指针）

omp 原生帧族（`subagent_lifecycle`/`subagent_progress`/`subagent_event` 包装帧/`irc_message`）与 vibe 的投影决策已在 `subagent-ux.md`（#229）§1.2–1.3 考古，本文不重复。与本文相关的对齐点：我们的 `task.*` journal 家族（`spawn_planned`/`spawn_settled`/`async_result`/`subagent_parked`/`revived`/`aborted`）与 omp `subagent_lifecycle` 四态同构；缺的是 §6 的 ux 投影半边。

## 4. bb SPA 展开交互怎么实现 `[pin@ba4265453]`（+上游增量）

### 4.1 行模型前置

- 行是**纯投影产物**：thread-view 把事件流折成 row 树（delegation 行递归带 `childRows`，`build-thread-timeline.ts:686–703`）；委派子代是**扁平序列**而非合成 turn（"wrapping them in a synthetic turn would require aggregating child statuses into a turn status, which has no meaningful answer while the subagent is still running"，normalize-event-projection.ts:360–363）。
- SPA 收到的 timeline response = `rows` + 尾字段（含 `activeThinking`），WS 只发失效信号、客户端 delta 重取（bb-spa-ux-surface.md §2）。

### 4.2 展开状态机：ExpandableTimelineRow

`apps/app/src/components/thread/timeline/ExpandableTimelineRow.tsx`：

```
isExpanded = expandable && (forceExpanded
  || (manualExpansionOverride ?? (autoExpanded || terminalAutoExpanded || terminalAutoExpandedLatch)))
```

- **三输入**：`autoExpanded`（收集器算出的活跃前沿，随投影重算）；`terminalAutoExpanded`+latch（终局前沿到达即开，**闩住**直到用户 toggle 或卸载，:104–108）；`manualExpansionOverride: boolean|null`（用户点击后覆盖一切自动态，:121–126）。优先级：手动 > 自动。
- **交互面**：折叠态 preview 整块可点（role=button + tabIndex + aria-expanded，:176–204）；Enter/Space 触发（:141–153）；**命中 `a,button,input,select,textarea` 的点击不触发 toggle**（`isInteractivePreviewTarget`，:72–80）——嵌套子行的链接/按钮不会被父行展开吃掉；hover/focus 才亮 chevron（`forceHeaderChevronVisible`，:230–232）。
- 壳是通用 `ExpandablePanel`（summary 行 + collapsible body），行组件只决定 title/collapsedPreview/renderBody。

### 4.3 自动展开收集器：纯函数、作用域下传

`timeline-auto-expand.ts`：

- **可展开性规则**（:19–49）：`delegation` 需 `childRows.length>0 ∨ output` 非空；`workflow` 需 `workflow ∨ summary ∨ error`；web-search/web-fetch/approval 永不展开；同一谓词同时驱动标题帽与展开 affordance（`isNonExpandableSummary` :77–84，"cap rule and the per-row expand affordance can never disagree"）。
- **live frontier**（:86–109，:159–180）：仅当 scope active，找代理产出的尾行——pending delegation、pending workflow、image-view 自动开；conversation/turn/step-summary 不开。**scope-active 必须自顶向下传播**：活跃容器 = 顶层（thread active 时）+ *pending* 委派的 childRows；"a pending sub-delegation buried inside a completed parent does NOT auto-expand"（注释 :139–158）。
- **terminal frontier**（:111–137）：尾行是带 detail 的 system error 才开；终局遍历会**下降进 pending delegation 的 childRows** 找嵌套 error。
- 收集器输出 rowId 集合 → 行组件拿 `autoExpanded` 布尔；组件闩存终局态，收集器不保留旧终局行（"the collector does not keep old terminal rows auto-expanded"）。

### 4.4 委派行 / 工作流行渲染

- **委派行**（ThreadTimelineRows.tsx:1253–1296）：body = `TimelineDetailScroll size="delegation"`（768px 档 vs base 288px，detail-scroll-size.ts:30–32）+ `NESTED_TIMELINE_GROUP_LINE_CLASS_NAME` 嵌套组线 + 递归 `<TimelineRowsList rows={row.childRows} scopeActive={delegationActive}>`（子行复用同一套行渲染与自动展开）+ `row.output` 渲染成 assistant 消息正文；委派内禁 assistant 消息动作（#229 §1.4）。contentKey 用 `timelineRowsSignature(childRows)|output.length` 驱动滚动跟随。标题 shimmer 动词（timeline-row-title.ts:823–860）。
- **工作流行**：标题 `Running/Ran workflow: name (n/m agents)`（:863–978，`n/m` 由 `isSettledWorkflowAgentState` 数）；body = `WorkflowWorkRowBody` → shared-ui `WorkflowProgress` phase/agent 树 + `TimelineDetailScroll`（pending 时 streaming 跟随，WorkflowWorkRowBody.tsx:11–49）；降级渲染：无快照时只剩 summary/error 文本。
- **composer 横幅卡**：`ThreadBackgroundCommandsCard` 收集 pending 委派/工作流的嵌套 leaf 活动（vibe 增量，#229 §1.4）。

### 4.5 CoT 呈现：pin 立场 vs 上游 #3250（关键增量）

**pin（= 我们 submodule pin 的 SPA 现状）**：reasoning 永不成行。

- 快照测试锁定双单向：`"omits completed reasoning from timeline rows"`、`"omits active reasoning from timeline rows"`（thread-view/test/timeline-cli-rendering.snapshots.test.ts:2294–2346）。
- 唯一面：timeline response 顶层 `activeThinking` 尾字段（server-contract/src/api/threads.ts:845），由 `buildProjectionActiveThinking`（reasoning-lifecycle-projection.ts:85–106）维护——**单一**最新 open lifecycle（`isNewerActiveThinkingLifecycle` 按 seq 决胜），`item/completed reasoning` 或 answer 终局即 finalize；根推理在嵌套子 turn 先完成时仍保持（snapshots:1392–1438）。
- SPA：`ThreadTimelinePanelContent.tsx:125` 把它传进 `ThreadTimelineSurface`，`isThinking` 时在活跃指示器里展示流式推理文本（ThreadTimelineSurface.tsx:182–191, :266–267）。**完成后不可回看**——文本不丢（delta 已在事件日志），但没有任何行能展开它。

**上游 `[up@c65a47fda]` commit `e0387861b`「Unify thinking rows and add a diagnostic events setting (#3250)」**：立场翻转，reasoning 成为一等 timeline 行。

- 投影：reasoning deltas 折成持久 `assistant-reasoning` 消息（assistant-event-projection.ts:57–118：`projectReasoningTextEvent` 按 `summary-delta`/`content-delta` 双轨缓冲，`item/completed reasoning` 终局并去重）；消息 → `kind:"operation"` 且 `opType:"reasoning"`（event-projection-message.ts:309, :388–398）。
- 行：`system` 行 `systemKind:"operation", operationKind:"reasoning"`，携带 **`reasoningId` = 规范推理身份（独立于结构行 id）**（build-thread-timeline.ts:173, :232；server-contract thread-timeline.ts:201）。canonical id 与行 id 分离是为了**委派嵌套下展开态不丢**（commit message："Carry a canonical reasoning disclosure ID separately from the structural row ID so delegation nesting preserves expansion"）。
- 渲染（ThreadTimelineRows.tsx:1199–1203, :1381–1383, :1586–1593）：`TimelineReasoningDetail`（max-h-80 滚动、border-l、prose 文本，TimelineReasoningDetail.tsx——7 行）；标题 `Thinking…`（pending, shimmer）/`Thought`（completed）+ 时长 decoration；只有完成态给 AiBrain01 图标；完成态进活动分组（timeline-view.ts `isSummarizableActivityRow` :725–745）。
- 展开保持：`TimelineReasoningExpansionProvider` 持 `Map<reasoningId, boolean>` 覆盖表 + `useTimelineReasoningExpansion(key)`（TimelineReasoningExpansion.tsx:9–39）——手动展开态在行重挂/投影重算后按 canonical id 恢复（mounted-thread 生命期）。
- **wire 零改动**：commit message 明说 "No server/host-daemon wire payload changed, so no daemon protocol bump is needed"——reasoning deltas 事件本来就在日志里，这是**纯投影/SPA 演进**。上游已从 server-contract 移除 `activeThinking` 尾字段（[up] server-contract thread-timeline.ts 零命中），活跃 Thinking 变成一条 pending reasoning 行。

**对我们 pin 版 SPA 的含义**：pin SPA 只有 activeThinking 指示器；要"CoT 可展开"有两条路——(a) 正向移植上游 #3250 的投影+SPA 增量（bb 官方已踩平）；(b) 只做 journal/ux 事件面（reasoning 终局行入 ux），SPA 决策另立票。

## 5. 我们现状审计 `[wip@8ba4d43]`（基线 origin/main `debacb2`）

### 5.1 已闭环：根 turn CoT（#257 面）

| 层 | 形状 | 锚点 |
|---|---|---|
| relay | Anthropic SSE `thinking_delta` → `{kind:"thinking-delta"}` chunk（`signature_delta` 保持吞掉） | agent-do/src/relay/anthropic-provider.ts:172–190, :257–265 `[wip]` |
| wire | 模型判定 `supportsExternalThinking` 决定 `think` 工具是否渲染；渲染了就 pin native reasoning OFF；glm 族走 native thinking | relay/wire.ts:275–320 `[wip]` |
| journal | **`model.thinking`** `{turnId, modelCallId, text(string|blobRef)}`——与 `model.delta` 同 flush 纪律（deltaFlushBytes/Ms）、同 R2 blob 通道；FSM guard=call running，不折进 deltaChars | fsm-events.ts:143–147；turn-state.ts:293–305；event-log.ts:45 `[wip]` |
| ux | `model.thinking` → **`item/reasoning/textDelta`** `{turnId, itemId:"itm-rs-<turnId>:<modelCallId>", delta}`（1:1，blob 行/空行不出面） | ux-projection.ts `case "model.thinking"` `[wip]` |
| 协议 | `reasoningItemSchema {type:"reasoning", id, summary[], content[]}`（bb 同形）+ `item/reasoning/textDelta` | packages/protocol/src/events.ts:97–110, :176–180 `[wip]` |
| timeline | `buildActiveThinking(events, threadStatus)`：status≠active 即 null；textDelta 累积 lifecycle；**同 call 的 answer delta 关闭该 lifecycle**（M0 折叠：journal 无独立 reasoning 终局行）；lastSeq 最新者胜 | apps/server-worker/src/services/timeline.ts:126–180；routes/threads.ts `activeThinking` 接线 `[wip]` |
| 测试 | journal 形状/R2/flush 顺序（cot-surface.test.ts）+ timeline 折叠 bb 平价（compat/active-thinking.test.ts） | `[wip]` 两文件 |

### 5.2 缺口 G1–G6（子代理面全缺，CoT 面缺终局）

| # | 缺口 | 证据 |
|---|---|---|
| G1 | **`task.*` journal 家族齐全但 ux 投影全部 break**——SPA 对委派零可见。家族本身完整：`task.spawn_planned{executionId, spawnId, agentId, agent, childThreadId, parentThreadId, machineId, mode: blocking\|background, jobId, task, solutionSpace, model?, depth}` / `task.spawn_settled{spawnId, childThreadId, status: ok\|error, output, outputTruncated?}` / `task.async_result` / `task.subagent_identity` / `task.subagent_parked/revived/aborted` | fsm-events.ts:308–513；ux-projection.ts:36–52（"M1.5 T16 task/subagent journal family: projected by tools/task/*, **not part of the UX envelope**"） |
| G2 | **协议层无 `parentToolCallId`**：toolCall/agentMessage/reasoning item 与两个 delta 事件都没有归属字段 → 即使投影出委派行，子代活动/子代 CoT 也挂不进去（bb 靠这个字段做 item 级挂链 + 委派 childRows 聚合） | protocol/src/events.ts:57–110, :160–184（对照 [pin] provider-event.ts `parentToolCallId` 遍布） |
| G3 | **全部 ux 事件 turn 作用域（`turnId` 必填）**：background/detached 子代理生命周期横跨多个父 turn，turn-作用域事件表达不了（bb backgroundTask 用 `threadScope()`；pin 下 delegation 行自身也是跨 turn 的 thread 级折叠） | protocol/src/events.ts:133–184（对照 [pin] task-translation.ts:279–295） |
| G4 | **子代活动与子代 CoT 不回父 journal**：子 DO 有独立 journal（childThreadId），父侧只有 spawn/settle 结算行；`completeSubagent` 只做交付。→ 委派行 childRows 永远空、`activeThinking` 只有父的（bb 两家先例都把子代推理/活动实时投影进委派行：codex 复用在根 thread + turn link；omp 走 `subagent_event` 包装帧订阅） | fsm-events.ts:356–365（spawn_settled 语义）；agent-do.ts completeSubagent；对照 §1.1/§3 |
| G5 | **reasoning 无终局行**：M0 把关闭折叠在 answer delta 边界，ux 面没有 `item/completed reasoning` → turn 结束后 CoT 不可展开回看（journal 原始 `model.thinking` 行都在，含 R2 blob，只是 ux 不再出）。pin bb 同立场（§4.5），但上游 #3250 已给出"成行"的成品路径 | timeline.ts buildActiveThinking 注释 `[wip]`；对照 [up] §4.5 |
| G6 | **server 契约已备、投影不产**：`TimelineDelegationWorkRow{callId, toolName, subagentType, description, output, completedAt, childRows}` 与 `TimelineWorkflowWorkRow`（含 workflow 快照/usage/summary/childRows?）在 contract 里齐备（verbatim 移植的 SPA 直接吃这两个 workKind），但 `projectTimelineRows` 只产 tool/command/conversation 行，无 delegation/workflow 分支 | apps/server-worker/src/contract/thread-timeline.ts:346–408；services/timeline.ts:184–473（无 delegation 分支） |

附：G4 的读穿可行性——seam 的 `readEvents` 已支持 `project: "raw" | "ux"`（apps/server-worker/src/seam/agent-do.ts:42），且 `task.spawn_planned.childThreadId` 就在 journal 里，server 侧跨 DO 读子 journal 的原材料齐全。

## 6. journal 需补什么：建议 J1–J6

排序按依赖与成本；J1–J4 是"子代理工作可见"的最小闭环，J5–J6 是"CoT 可展开"的两档。

| # | 建议 | 内容 | 依据 |
|---|---|---|---|
| J1 | **协议增 `parentToolCallId?: string`**（可选字段，向后兼容）于 toolCall/agentMessage/reasoning item 与 `item/agentMessage/delta`、`item/reasoning/textDelta` | 归属链的地基；bb 三家先例一致 | G2；[pin] provider-event.ts |
| J2 | **ux 投影折 `task.*` → 委派行事件**：`task.spawn_planned` → `item/started` + `toolCall{tool:"spawnAgent", arguments:{senderThreadId: parentThreadId, receiverThreadIds:[childThreadId], description: task, subagent_type: agent}}`（#229 S1+S3：`subagent_type` 进合成参数，徽章免费）；`task.spawn_settled`（ok→completed/error→failed）与 `task.subagent_aborted`（kill→interrupted、budget→照四态语义）→ `item/completed`。`mode:"blocking"` 行挂在 spawning turn；`mode:"background"` 见 J3 | 零 journal schema 改动（现有行字段够投影全部所需） | G1；#229 §2.3-1；[pin] subagent-activity-translation.ts:59–85 |
| J3 | **增 thread 作用域事件族**：`item/backgroundTask/progress` 与 `item/backgroundTask/completed`（bb 同名同形：`{itemId, …}` 无 turnId；`backgroundTask` item 旁路）——承载 background 子代理的跨 turn 生命周期（spawn_settled 前的"还活着"态、parked/revived 状态变化）。M0 可先只发 started/completed 两事件（无 progress 源），schema 一次到位 | G3；[pin] task-translation.ts:274–300 |
| J4 | **server timeline 投影增 delegation 分支**：`projectTimelineRows` 按 J1/J2 的事件产 `TimelineDelegationWorkRow`；childRows 聚合按 `parentToolCallId`（G4 解决前恒空数组，可展开性谓词自然隐藏展开箭头——bb `childRows.length>0 ∨ output` 同款行为）。子代结果回灌：`task.spawn_settled.output` → 委派行 `output`（#229 S7 摘要位） | G6；[pin] timeline-auto-expand.ts:37–38 |
| J5 | **子代活动/CoT 回父（二选一）**：<br>**(a) 读穿**（零 journal 改动）：timeline service 用 `spawn_planned.childThreadId` 对活跃子 DO `readEvents{project:"ux"}`，把子 ux 行按 `parentToolCallId=<spawnId 派生的 callId>` 挂 childRows；优点快，缺点跨 DO 读路径 + 子 journal blob 行需原样带过 + 子行 seq 与父行 seq 两个时间轴要合并策略<br>**(b) 回灌**（journal-first，推荐）：父 DO 在子运行期经既有完成回调/steer 通道增量追加 `task.subagent_event {spawnId, agentId, childThreadId, event: <子 ux 行 verbatim>}` journal 行（与 omp `subagent_event` 包装帧同构），ux 投影就地展开成带 `parentToolCallId` 的子行——单一读面、replay 稳定、blob 处理复用现有 BLOBBABLE 通道 | G4；[pin] codex 复用+turn link、[vibe] subagent_event id 嗅探（#229 §1.2）；seam readEvents（方案 a 原材料） |
| J6 | **CoT 终局行（可展开 CoT 的 journal 面）**：`model.call_completed` 时对该 call 的 thinking 累积发 `item/completed` + `reasoning{summary:[], content:[全文或续块]}`（ux 面；journal 已有原始行，只是补投影）；`itemId` 沿用 `itm-rs-<turnId>:<modelCallId>` 保证跨完成身份（= bb canonical reasoningId 的对应物）。SPA 侧两档：<br>• **档 1（零 SPA 改动）**：只落 ux 事件面，pin SPA 忽略之（reasoning 不成行），未来无痛升级<br>• **档 2（SPA 增量，block:bb-ux 需裁决）**：正向移植 [up] #3250 的行渲染+`reasoningId` 展开保持（bb 官方成品，含"活跃 Thinking 变 pending 行"的语义迁移——需同步替换 activeThinking 尾字段消费，注意我们 `[wip]` 刚接线的 `buildActiveThinking` 是 pin 语义） | G5；[up] e0387861b（§4.5）；#229 S8 |

**明确不做/延后**（防止顺手扩scope）：

- workflow 进度面：`TimelineWorkflowWorkRow` 契约留用，但 M0 无 workflow 源（sole provider = omp relay，无 claude `local_workflow` 帧；omp 帧族也无 phase/agent 树）——不投事件，不删契约。
- `item/reasoning/summaryTextDelta`：glm-5.3 无 summaries；`reasoningItem.summary` 数组已保形（`[wip]` 注释），留 schema 兼容即可。
- claude 桥 native task 族 / codex `collabAgentToolCall`：无对应 provider，形状表留档（附录）。

## 7. 验收形态建议（#229 S8 的 CoT/工作流补充面）

1. **单元（帧族平价）**：mock provider `thinkingDeltas` 已有（`[wip]` mock-provider.ts）；补 `task.*` → ux 投影表驱动测试（spawn/blocking、spawn/background、settle ok/error、aborted 三类 reason、parked/revived 状态行）。
2. **全链 fake smoke**：父 turn spawn 子 DO → 子跑 thinking+answer → settle 回灌；断言 timeline response 出现 delegation 行（childRows 非空、subagentType 徽章、output 摘要）。
3. **真 CDP 浏览器**（与 #229 S8 同构）：断言委派行渲染 + 展开交互（点开看子活动；`isInteractivePreviewTarget` 豁免：子行内按钮点击不收起父行）+ 活跃 Thinking 指示器文本随 delta 更新。
4. **回归锚**：`activeThinking` 语义改动（若走 J6 档 2）必须重跑 `[wip]` cot-surface + compat/active-thinking 两组测试并同步改注释里的 bb 锚点版本（pin → up）。

## 附：四家事件形状对照表

| 面 | codex `[pin]` | claude `[pin]` | omp `[vibe]`（指针） | 我们 `[wip@8ba4d43]` |
|---|---|---|---|---|
| 子代生命周期 | `subAgentActivity{started\|interacted\|interrupted}` → 合成 `toolCall{spawnAgent}` 行 | `task_started/…/task_notification` → `backgroundTask` item + 委派工具行并存 | `subagent_lifecycle` 四态 → 合成 `toolCall{spawnAgent}` | `task.spawn_planned/settled/aborted`（journal 有，ux 无 → G1） |
| 子代实时活动 | 子 turn 复用根 thread + turn link 归父 | task_progress（500ms 节流）+ workflow 快照 | `subagent_progress` 订阅帧 | 无（G4） |
| 子代归属链 | `agentThreadId→callId` 映射 + FIFO turn link + `parentToolCallId` | `parentToolCallId` 直挂 item | `parentToolCallId` + `parentBackgroundTaskId` | 字段不存在（G2） |
| CoT 流式 | `item/reasoning/summaryTextDelta` + `textDelta`（双轨，turn 作用域） | `thinking_delta` → `item/reasoning/textDelta`（按 contentIndex 定身份） | 经 `subagent_event` 包装帧 | `item/reasoning/textDelta`（`itm-rs-<turnId>:<modelCallId>`） |
| CoT 终局 | `reasoning{summary[], content[]}` item/completed | thinking 块 → `item/completed reasoning` | — | 无（G5；journal `model.thinking` 原始行在） |
| CoT SPA 呈现 pin | activeThinking 尾字段（live only） | 同左 | 委派行 childRows 内嵌 | activeThinking（已接线 `[wip]`） |
| CoT SPA 呈现 `[up]` | **reasoning operation 行**：`Thinking…`/`Thought`+时长+AiBrain01，`reasoningId` 跨完成保持展开，进活动分组；wire 零改动 | 同左 | 同左 | 未移植（J6 档 2） |
| 作用域模型 | delta/item=turn；委派行=跨 turn 折叠 | task 族=thread 作用域 | lifecycle 独立于 turn | 全部=turn（G3） |

> AGENT GENERATED: by zhipu-coding-plan/glm-5.3-flash (research subagent, #256)
