# 子代理 UX 双模型考察：bb vibe 实现（omp RPC native provider）× cross-provider vs native subagent（#229）

研究对象两份：

1. **vibe 实现**：用户 bb fork 本地分支 `feature/omp-rpc-provider`（~/workspace/bb，未推远端——remote 仅有 main），107 commits，fork 点 = origin/main `ba4265453`（**恰为本仓 submodule pin**），tip `8473d8c33`。足迹 108 文件 +20,741/−669，核心为 `omp/adapter.ts`（3,030 行）与 `omp/bridge/bridge.ts`（1,866 行）。
2. **cross-provider vs native 两模型**：bb pin（`ba4265453`）内的 provider 中性委派面 + 三家 provider 的原生子代理表达（codex / claude-code / omp）。

行号锚点约定：vibe 分支锚点标 `[vibe@8473d8c33]`，pin 内文件标 `[pin@ba4265453]`；行号随版本漂移，file:line 仅为定位辅助。omp 自身子代理运行时语义的正本考古见 `omp-task-semantics.md`（#78），本文不重复。

---

## 0. 结论速览

| # | 结论 | 一句话 |
|---|------|--------|
| 1 | vibe 的本质 | omp RPC 作为 bb 第 5 个 native provider（`omp`），把 omp **原生**子代理帧（`subagent_lifecycle`/`subagent_progress`/`subagent_event`/`irc_message`）翻译成 bb **provider 中性**的委派形状，SPA 一行不改即渲染 |
| 2 | 核心投影决策 | native `task` 工具调用 = 运输层折叠不渲染；`subagent_lifecycle(detached)` → 合成 `toolCall{tool:"spawnAgent"}` 委派行；嵌套子代事件经 `parentToolCallId`/`parentBackgroundTaskId` 挂到委派行的 childProjection |
| 3 | 先例来源 | 合成 spawnAgent 形状抄自 pin 内 codex 上游实现（`subagent-activity-translation.ts`），omp 适配器是同一模式的第三个实例（codex、claude、omp） |
| 4 | 两模型辨析 | **cross-provider 委派**（bb 自己编排子 thread，可跨供应商）与 **provider 原生子代理**（模型 runtime 内部表达）是两种所有权不同的东西；bb 的答案是不让 UI 区分它们——都收敛到两种中性形状 |
| 5 | 对我们 W3 | 不学编排面（我们 sole provider = omp relay），学**形状层**：翻译必须发生在 ThreadDO 入账前；补 `parentBackgroundTaskId` 归属链、agent 类型徽章、终局清扫三处缺口；验收抄 fake smoke + 真 CDP 浏览器双层形态 |

---

## 1. vibe 实现考古（omp RPC 作为 bb native provider）

### 1.1 传输面：stdio JSON-RPC 桥 + 订阅制子代理帧

- 桥是 bb agent-runtime 拉起的子进程（`process: { command: "node", args: resolveBridgeProcessArgs(...) }` `[vibe@8473d8c33] omp/adapter.ts` standardMembers 段），逐行 JSON-RPC。bb→桥方法集：`initialize` / `model/list` / `thread/start` / `thread/resume` / `turn/start` / `turn/steer` / `thread/stop`（bridge.ts:1692-1826）；桥→omp runtime 的 RPC：`get_state` / `get_available_models` / `set_model` / `set_thinking_level` / `prompt` / `steer` / `abort`。
- **子代理帧是订阅制的**：thread 会话建立后桥显式请求 `set_subagent_subscription { level: "events" }`，注释"BB receives their native payloads as raw sdk/message events"（bridge.ts:1443-1448）。不订阅就收不到子代理事件——移植时漏掉这一步 = 子代理静默不可见。
- 交互通道：omp 扩展 UI 请求（`input`/`select`/`confirm`）经 `omp/extension-ui/request` 转成 bb pending interactions，`editor`/`open_url`/`setWidget` 三种 bb 无对应面的方法**fail-closed 取消**而非暴露宿主控件（bridge.ts:264-316 schema、:853-880 分流、:1293-1312 转发）。

### 1.2 事件面：omp 原生子代理帧 schema

`[vibe@8473d8c33] omp/adapter.ts`：

| 帧 | schema | 锚点 |
|---|--------|------|
| `subagent_lifecycle` | `{ id, agent?, description?, status: started\|completed\|failed\|aborted, detached?, summary?, error? }` | :483-494 |
| `subagent_progress` | `{ id?, agent?, description?, task?, detached?, progress: record }` | :495-505 |
| `irc_message` | `{ id, from, to?, body, ts, replyTo? }`（agent 间传输） | :506-518 |
| `subagent_event` | 包装帧：child 事件 + 外层任务 id；id 嗅探链依次试 `id/subagentId/subagent_id/backgroundTaskId/taskId` × 外层/payload 两层 | :1659-1697 |

兼容性细节：omp 不同版本对 lifecycle/progress 有 flattened 与 `{type,payload}` 两种帧形，`normalizeOmpSubagentFrame` 统一展开（:643-648）。

### 1.3 投影决策：三个关键动作（本考古的核心）

**① 运输层折叠**——native `task` 工具调用本身不渲染（`[vibe@8473d8c33]` adapter.ts:2009-2028）：

> "OMP's native task tool is only the transport that creates the detached child. The lifecycle frame below becomes BB's single spawnAgent delegation; showing both creates the duplicate, non-delegation parent that hides its child body."（:2024-2027）

同时把 (父任务 item, native call id) 存进 `nestedNativeTaskParentByCallKey`，供后续嵌套生命周期归父（:2014-2023；键为 `nestedToolCallKey(scope, callId)` JSON 对，:966-968；上限 1,024 条 :613）。

**② lifecycle → 合成 spawnAgent 委派 item**——`buildOmpTaskItem`（:908-942）：

```ts
{ type: "toolCall", tool: "spawnAgent",
  arguments: { senderThreadId: parentThreadId, receiverThreadIds: [taskId], description },
  status: running→pending / completed→completed / stopped→interrupted / →failed,
  result: { agentId, summary?, usage? },   // 终局才带
  error?, parentToolCallId? }
```

历史演化（commit `0a2142d50` "Project OMP subagents as delegation tools"）：最初投影为 `backgroundTask` item（`taskType: local_subagent`，`threadScope` + `skipTranscript`），该 commit 改为 `toolCall{spawnAgent}` + `turnScope`，事件从 `item/backgroundTask/progress|completed` 换成 `item/toolCall/progress` + `item/completed`——即**从"后台任务卡"迁移到"委派行"**。动机：委派行活在 turn 流里、能挂 childProjection 嵌套子代活动；backgroundTask 卡在 thread 层、transcript 外，挂不了子代正文。

**③ 嵌套所有权链**——子代理内部活动（助手消息/推理/工具调用）经两条父链挂到委派行：显式 `parentToolCallId` + vibe 新增域字段 `parentBackgroundTaskId`（vibe 给 domain **全部** item/事件 schema 补了这个可选字段，`provider-event.ts:154` 起约 30 处）。thread-view 按 parentToolCallId 聚合 childProjection（见 §1.4）。

配套机制（均为边界硬化，值移植时参考量级）：

| 机制 | 语义 | 锚点 `[vibe@8473d8c33]` |
|---|---|---|
| 状态映射 | started/completed/failed/aborted → running/completed/failed/stopped | :895-906 |
| item id 方案 | `task:<id>@<identityEpoch>#<generation>`（同一 taskId 重启代际化，%/@/# 转义防碰撞） | :948-964 |
| 终局保留窗 | 至多保留 128 个终局任务（`OMP_MAX_RETAINED_TERMINAL_TASKS`），超限逐出最旧并清其嵌套 scope | :609-610, :1007-1028 |
| 驱逐门 | 有未终局任务时 turn state 不可驱逐（`isEvictable: !hasOpenOmpBackgroundTasks`） | :1425 |
| **detached-only** | `detached !== true` 的 lifecycle 直接丢弃——前台（inline）子代理不出委派行 | :2449-2450；测试 adapter.test.ts:1458-1468 |
| 嵌套 native 消歧 | 生命周期帧被外层任务 id 包裹时，"native call id 匹配 + child id 不同"才认定为第二层真实委派 | :2429-2446 |
| 终局清扫 | session replace / detach 时对所有 open task 补发终局事件（error="OMP session replaced/detached"），不留幽灵 Working 行 | `buildOmpTaskTerminationEvents`（0a2142d50 引入） |
| IRC 定性 | "IRC is OMP's agent-to-agent transport, not a tool invocation"——投影为中性 item + 委派父链，不做工具行 | :2373-2376 |

### 1.4 中性面与 UI 面（pin 上已存在的呈现机器）

vibe 只做翻译；渲染全靠 pin 已有的中性委派面，SPA 组件零改动：

- thread-view：委派子代**扁平序列**挂委派行——"wrapping them in a synthetic turn would require aggregating child statuses into a turn status, which has no meaningful answer while the subagent is still running"（`[pin@ba4265453]` normalize-event-projection.ts:360-363）；`build-thread-timeline.ts:686-703` 委派行递归构建 childRows；跨 provider thread 的 turn 归父用 `PendingDelegationTurnLink`（providerThreadId → callId，event-projection-state.ts:50-53、build-event-projection.ts:403-466）。
- 汇总与标题：turn 汇总 "Ran/Running N subagent"（timeline-view.ts:496-499/:525-528）；标题动词 + shimmer（timeline-row-title.ts:841-846 `mapDelegationTitle`/`delegationVerbForStatus`）。
- SPA 组件 `[pin@ba4265453]`：委派行体 = delegation 档滚动容器（768px vs base 288px，`detail-scroll-size.ts:30-32`）+ 嵌套 rows、委派内禁 assistant 消息动作（ThreadTimelineRows.tsx:1252-1269、actions.test.ts:617）；auto-expand 规则——活跃 scope 穿透 pending 委派、闲置 thread 不自动展开（timeline-auto-expand.ts:130-135/:153-158）；图标 `UserRoundPlus`（ThreadTimelineRows.tsx:1546）。composer 横幅实时卡（收集 pending 委派/工作流的嵌套 leaf 活动，`ThreadBackgroundCommandsCard.tsx:93-126`）为 vibe 增量 `[vibe@8473d8c33]`（commit `6367cfe84`）。
- 元数据抽取：`subagentType`/`description` 只从委派工具参数的 `subagent_type|subagentType` / `description|prompt` 键提取（exec-lifecycle.ts:231-243）。

### 1.5 验收形态（可整体搬运的惯例）

| 层 | 形态 | 锚点 |
|---|---|---|
| 单元 | adapter.test.ts 4,242 行（全帧形/边界/代际） | `[vibe@8473d8c33]` |
| 假 provider | `fake-omp.mjs` 假 omp + smoke 977 行全链 | bridge/__tests__/、tests/integration/fake/smoke/omp-provider.test.ts |
| 钉版兼容 | CI 固定 omp 版本跑兼容 smoke（"Add pinned OMP compatibility smoke"） | commit `8473d8c33` |
| 真浏览器 | `omp-browser-smoke.mjs` 633 行：裸 CDP 驱动真 SPA，断言委派活动渲染 | tests/qa/scripts/（commit `6c302a052`） |

---

## 2. cross-provider vs provider-native：两个模型的角色矩阵

### 2.1 两模型是什么

- **cross-provider 委派（bb 编排）**：bb 自己的 `spawnAgent`/`resumeAgent` 工具创建 bb 管理的子 provider thread（`receiverThreadIds`），子 thread 可选不同 provider；生命周期（开/关/归档）、审批策略桥、结果回灌全归 bb。pin 内证据：`PROVIDER_THREAD_DELEGATION_TOOL_NAMES`（build-event-projection.ts:135-138）、委派工具名集 `{Agent, Task, spawnAgent, resumeAgent}`（tool-call-parsing.ts:4-9）。
- **provider 原生子代理（模型表达）**：模型 runtime 自己的子代理设施——codex `subAgentActivity`/`collabAgentToolCall`、claude `Agent/Task` 工具 + `task_started/task_notification`、omp `task` 工具 + `subagent_lifecycle` 帧族。所有权在 provider runtime，bb 只是观察者。

bb 的立场明确**压制 native、力推自家委派**：claude 桥直接拒绝——"bb has disabled Claude Code native subagents; use bb delegation instead"（bridge/bridge.ts:801 `[pin]`）；codex 线程启动可关 native subagents（codex/adapter.test.ts:1615 `[pin]`）。而 vibe 的 omp 线走相反路：**OMP owns its own rules, skills, memory, auth broker, tools, and subagents. Keep the BB-facing surface deliberately empty**（agent-providers/catalog.ts:114-117 `[vibe]`）——omp 能力面全空、子代理全权归 omp，bb 只翻译呈现。

### 2.2 对比矩阵

| 维度 | cross-provider 委派（bb 编排） | provider 原生子代理（omp 例） |
|---|---|---|
| 编排所有权 | bb：自有工具 + 子 thread 注册表 | omp runtime：task 工具 + agent 注册表四态（running/idle/parked/aborted，omp-task-semantics.md §5） |
| 子代数据形态 | 真 provider thread（自有 providerThreadId + turn 序列） | runtime 内 job/agent，无独立 thread 实体；事件以 `subagent_event` 包装帧流出 |
| 跨供应商 | ✅ 核心卖点：child thread 可指定任意 provider | ❌ 单 runtime 内部（omp 自己再代理多模型，但 bb 看不见） |
| 生命周期宿主 | bb thread 生命周期 | omp 会话：TTL 7min park、复活、aborted 墓碑（omp-task-semantics.md §5） |
| 交互面 | 子 thread 审批桥（继承父 escalation，claude bridge.ts:216 `permissionEscalationBySubagentParentToolUseId`） | omp extension-ui → bb pending interactions（bridge.ts:1293-1312 `[vibe]`） |
| 结果回灌 | child turn 结果挂 callId；`resumeAgent` 续聊 | omp `yield`/async-result 注入父会话（omp-task-semantics.md §3） |
| 取消/恢复 | bb thread stop 语义 | kill 墓碑 / park 复活；bb 侧 session replace/detach 时补终局事件防幽灵行 |
| 归父机制 | providerThreadId → PendingDelegationTurnLink（turn 级挂链） | parentToolCallId + parentBackgroundTaskId（item 级挂链） |
| **UI 呈现需求** | 收敛为委派行 + childProjection | **同样收敛为委派行**（合成 spawnAgent）或 backgroundTask 卡；SPA 无感 |
| 与我们拓扑适配 | 编排面不适用（sole provider = omp relay，A11 裁定）；形状层全适用 | ✅ 唯一适用路径 |

**关键洞察**：codex 的原生子代理投影（`subagent-activity-translation.ts:59-85` `[pin]`——`subAgentActivity{agentThreadId, agentPath}` → 合成 `toolCall{tool:"spawnAgent", arguments:{senderThreadId, receiverThreadIds:[agentThreadId], description:agentPath}}`）是三者中最干净的表达，vibe 的 omp 适配器原样复刻了它（commit `0a2142d50` 与 codex `buildSubAgentToolCallItem` 逐字段同构）。claude 线则保留 `backgroundTask{local_agent}` 卡 + 委派工具调用双行并存（task-translation.test.ts:290-321 `[pin]`："materializes subagent tasks while preserving the delegation tool call"）。**这就是"codex 的 subagent 表达很顺滑"的实底：native 活动直接变成一张中性委派行，无需第二张任务卡。**

### 2.3 对 W3 task 呈现的可迁移结论

1. **呈现层只认中性形状**：委派行（`toolCall{spawnAgent}` + childProjection）与后台任务卡（`backgroundTask`）两种形状足够覆盖三家 provider 的原生子代理。我们的 `server-worker` contract 已有两者（`TimelineDelegationWorkRow` apps/server-worker/src/contract/thread-timeline.ts:346-362；backgroundTask 域 provider-event.ts:266-284 + thread 作用域裁定 thread-event-scope.ts:102-110）。
2. **翻译责任在适配器/事件面，不在 SPA**：SPA 是 verbatim 移植的（deployable-units.md U2），一切 omp→中性形状的翻译必须发生在 ThreadDO 入账前。我们的 omp tool-runtime 在 daemon（U3 vendored `@oh-my-pi/pi-coding-agent`），子代理帧经 daemon WS → DaemonServiceDO → AgentDO，**翻译缝应在 AgentDO 事件入账前**（编排面 DO 可承载，#70 拆缝规则的延伸）。
3. **两模型不混做**：M1.5/W3 只做 native 呈现；bb 的 cross-provider 编排（自有 spawnAgent 工具、子 thread 管理、审批桥）不在范围——我们连第二个 provider 都没有。

---

## 3. 对我们 SPA 呈现的建议切片

按依赖排序；S1-S2 是前置形状缺口，S3-S6 是呈现质量，S7-S8 是验收。

| # | 切片 | 内容 | 依据 |
|---|---|---|---|
| S1 | **采纳委派行为主呈现形状** | omp 子代理（detached task/后台 agent）→ `toolCall{tool:"spawnAgent", arguments:{senderThreadId, receiverThreadIds:[taskId], description}}` + `item/toolCall/progress` + `item/completed`；不做 backgroundTask 卡路线（claude 式双行在这里只添噪） | §1.3②、§2.3；形状 contract 已在 server-worker |
| S2 | **补 `parentBackgroundTaskId` 归属链** | pin 无此字段（全仓 grep 零命中）；vibe 补它是为了让缺显式父调用的嵌套子代事件（消息/推理/IRC）也能挂对委派行。我们的 domain/provider-event.ts 需同步该可选字段，否则深层嵌套（子代理内再 spawn）归属错乱 | §1.3③；`[vibe]` provider-event.ts:154+ |
| S3 | **agent 类型徽章透传** | omp `subagent_lifecycle.agent`（scout/reviewer/task…）在 vibe 里只落入 description 兜底（`${agent} task`），合成参数无 `subagent_type` 键 → `getDelegationMetadata` 抽不出 subagentType，委派行丢徽章。建议翻译层把 omp agent 塞进合成参数 `subagent_type`（或扩展 metadata），SPA 即自动显示 | exec-lifecycle.ts:231-243 `[pin]`；adapter.ts:2480-2482 `[vibe]` |
| S4 | **detached-only 语义显式化** | inline（`detached:false`）子代理无委派行。omp 无内置 blocking agent，实际几乎全 detached，与 M1.5 task 语义一致；但移植测试要锁这条，防止未来误把 inline 帧渲染成空壳委派行 | adapter.ts:2449-2450、adapter.test.ts:1458-1468 `[vibe]`；omp-task-semantics.md §1.3 |
| S5 | **终局清扫接恢复面** | session replace/detach 时对所有 open 子代理补终局委派事件——对接我们的 host disconnected 半停语义与 thread 恢复资格判定，避免恢复后幽灵 "Working…" 委派行 | `buildOmpTaskTerminationEvents` `[vibe]`；CONTEXT.md 执行悬置；#193/#194 |
| S6 | **嵌套交互请求** | 子代理内的 omp extension-ui（input/select/confirm）→ pending interactions；`editor/open_url/setWidget` fail-closed。W3 验收应含"子代理内问询"一条 | bridge.ts:264-316/:853-880/:1293-1312 `[vibe]` |
| S7 | **用量与终局摘要** | lifecycle `summary`/`usage{tokens,toolUses,durationMs}` 进委派 result，turn 汇总/横幅卡免费获得 | buildOmpTaskItem result、ThreadBackgroundCommandsCard.tsx:93-126 `[vibe]` |
| S8 | **双层验收形态** | fake omp 帧族单元 + 全链 fake smoke + 真 CDP 浏览器断言委派活动渲染；omp 上游前进时钉版兼容 smoke。与我们 CDP 验收惯例同构 | §1.5 |

**不学清单**：bb 的 cross-provider 委派编排面（自有 spawnAgent 工具注册、子 thread 的跨 provider 分派、`resumeAgent` 会话续聊、claude 审批策略桥）——这些以"多 provider 并存"为前提，我们 sole-provider 拓扑下没有对应物；需要的只是它们 converged 之后的**形状**。

---

## 附：vibe 分支 commit 索引（按主题聚类，107 中与子代理呈现直接相关者）

| 主题 | commits（`[vibe@8473d8c33]` 短哈希） |
|---|---|
| 委派投影定形 | `0a2142d50`（spawnAgent 化）、`0d00d9c67`（transport 折叠）、`6c302a052`（真委派活动渲染） |
| 嵌套生命周期 | `3843f4f3b`、`fae9185f6`、`597ebc49b`、`ce04cc699`、`033d22c26`、`7746f74d3`（detached 子代 scope 到父 turn） |
| 实时子代呈现 | `6367cfe84`（横幅卡）、`21803c1cf`（workflow child rows）、`4f7a66d3a`（live child details）、`779a37e8a`（detached child tool details） |
| 归属与诊断 | `f68804bc2`、`bb6311649`、`b3ca25cb2`、`3ac3e01f0`、`dcaa59e42` |
| 验收 | `8473d8c33`（pinned 兼容 smoke）、`e83e465ea`（command output E2E）、omp-browser-smoke（`6c302a052` 内 +97 行） |

> AGENT GENERATED: by zhipu-coding-plan/glm-5.3-flash (research subagent, #229)
