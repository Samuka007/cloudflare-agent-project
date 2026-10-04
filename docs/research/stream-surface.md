# 流式面盘点：edge↔SPA 现状 × bb 原语义 × daemon 消费 × omp 参考（#183）

> **provenance**：四面事实由 4 个并行 scout（read-only）取证 + parent 亲验关键锚（app.ts / event-log.ts / agent-do.ts / realtime-ws.ts / threads.ts:615-655 / hub.ts）；本仓基线 `2ffbbf8`，bb submodule @ `ba42654`。omp 参考源：vendored `packages/daemon-service/node_modules/@oh-my-pi/pi-coding-agent/src`（read-only）。
> **范围**：回答 (1) server-worker 有无流式端点、agent-DO journal append 有无订阅面；(2) bb 原 SPA 流式语义考古；(3) daemon client 消费 edge 的方式；(4) omp 流式 UX 相位参考。daemon↔server wire 协议已有 `bb-daemon-protocol.md`，SPA 组件面已有 `bb-spa-ux-surface.md`，server 移植清单已有 `bb-server-port-inventory.md`——本文不重复，只在流式衔接处引用。

## 0. 结论先行

1. **server-worker 的流式端点恰好三个，且没有一个是 token 流**：公共 `/ws` → NotificationHubDO（只广播 `changed` 失效提示帧，无 payload，`realtime-ws.ts:10-12`）；daemon attach `/ws`（带 Bearer 头时走 daemon face，`index.ts:74-77`）；`GET events/wait` 有界长轮询（≤60s，`threads.ts:615-655`）。**全仓无 SSE、无 chunked 流式响应、无 ETag**（搜索证据见 §1.3）。
2. **agent-DO 的 tap 机制已存在但生产上是死的**：`appendEvent` 每次 append 后 `pushToSubscribers()`（`agent-do.ts:1110,1123-1138`，persist-then-push），但推给的是 agent-DO 自己的 hibernation `/ws`（`agent-do.ts:890-901`）——**没有任何 HTTP 路由把升级转发到该 DO**，socket 集恒空；也无任何 AgentDO→hub 的通知调用。代码自证：turn append 不 ping hub，`events/wait` 只能 ≤500ms 切片轮询（`threads.ts:650-653`）。
3. **bb 原型本身也不是逐 token**：daemon 侧 `/internal/session/events` HTTP 批量上报（含流式文本 delta 事件），journal 持久化 `item/*/delta` 事件类型，但客户端 WS 只载 `changed` 粗粒度失效提示；SPA 50/200ms 去抖 invalidation + 50-1000ms 自节流 trailing refetch（≈50% 服务端占空比上限）——渲染粒度是「chunk-at-changed-refetch」，不是 token-by-token。
4. **daemon client 不消费 journal**：纯 WS 会话面（`/session/open` → `/ws?hostId&sessionId`），传输的是机器执行输出的字节偏移块（100ms 合帧），永不 HTTP 轮询；LLM token 流对它是不可见的（只见 settled `tool.exited`）。
5. **omp 参考的相位是事件隐式的**：`agent_start`→Loader「Working…」（elapsed/tok/s/stop），`message_start`→空 assistant 卡片 + 30fps grapheme 节流 reveal，tool 卡片 args 也 30fps reveal，无相位枚举无 FSM；无中途 wire resume（`auto_retry` 从头重试，流中文本仅 `message_end` 时持久化）。

**差距一句话**：现状离逐 token 流出缺三件——(a) 一条把 agent-DO 逐 append 推送接到公共 hub（或把 hub 升级指到 agent-DO `/ws`）的活线，使 turn 中途 append 不再只靠长轮询切片；(b) 帧语义升级（现 `changed` 仅 `latestSeq` 指针，要么加 delta payload 帧、要么接受「每 append 一次 refetch」的 N+1 并配 SPA 端游标）；(c) SPA 端 token 累积 + 节流渲染层（omp 30fps reveal 为参考件）。spec 需先裁定目标语义档位：bb 级「节流刷新」还是 omp 级「真流」——journal 词表（`model.delta` 已有）与 append 钩子（`pushToSubscribers` 已有）两者都已备好，缺的只在接线与帧面。

---

## 1. Face 1：server-worker 路由面 + agent-DO journal 订阅面

### 1.1 路由清单（apps/server-worker/src/app.ts + routes/*）

装配：Hono，中间件链 originGuard → accessGate → cors 挂 `/api/v1/*`（`app.ts:26-44`），`/ws` 挂 originGuard+accessGate（`app.ts:45-50`）。六路由族挂 `/api/v1`（`app.ts:53-58`）。composed worker 入口把 daemon face 前缀 `/enroll`、`/session/open`、`/agent/`、`/agent-sink/` 分流给 daemonServiceWorker（`index.ts:68,90-106`）；`/ws` **带 authorization 头时也归 daemon face**——浏览器 WebSocket 无法设头，故 hub 升级永不带 Bearer（`index.ts:74-77`）。

| 端点 | 性质 | 锚 |
| --- | --- | --- |
| GET `/health` | JSON | `app.ts:23` |
| GET `/ws` | **WS upgrade** → HUB DO `idFromName("hub")` | `app.ts:67-70`；`hub.ts:32-46`（非 upgrade → 426） |
| GET/POST `/api/v1/threads…`（25 个端点：CRUD/send/stop/timeline/events/events-wait/archive/pin/read/tabs/interactions…） | JSON | `routes/threads.ts:102-806`（F1 全表） |
| GET `/threads/:id/events/wait` | **有界长轮询**（默认 30s，cap 60s） | `threads.ts:615-655` |
| GET `/threads/:id/timeline?afterSequence=` | JSON + delta 行（见 §1.4） | `threads.ts:463-564`；`contract/api/threads.ts:795-799` |
| projects/hosts/plugins/system 族 | JSON | `routes/projects.ts`、`routes/hosts.ts`、`routes/plugins.ts`、`routes/system.ts`（F1 全表） |
| `/assets/*` + SPA 兜底 | 静态 | `app.ts:74,95-107` |

### 1.2 NotificationHubDO：谁连、什么帧、谁喂

- 客户端：浏览器 SPA（hub 职责注释 `hub.ts:11`；协议文档 `realtime-ws.ts:8-9`）。客户端帧仅 `subscribe`/`unsubscribe` × target `thread-detail:<id>`/`thread-list`（`hub.ts:49-70`；`realtime-ws.ts:29-58`）；malformed → close 1008（`hub.ts:53-61`）；无 greeting/ack 帧（`hub.ts:14-15`）。
- 服务端帧：`{type:"changed", entity, id, changes[], metadata?}`——失效提示 only，**无 payload**（`hub.ts:79-138`；`realtime-ws.ts:10-12,84-94`）。`metadata.latestSeq` 是 refetch 游标提示（`realtime-ws.ts:63-64`）；interaction 帧带 `{interactionId,status}` 补丁、问题正文仍走 HTTP refetch（`agent-do.ts:1140-1146`；`realtime-ws.ts:131-150`）。
- **喂给者只有控制面路由**：`hub(ctx).notifyThread/...` 全部出现在请求处理器里（create/send/stop/delete/archive/pin/read/tabs，`threads.ts:281,282,327-334,379,400-401,442-448,497-498,666,707,719,731,743,754,764,791`；settings 写 `system.ts:173,186,194,213`）。send 路径的 `events-appended` 通知发生在请求分派时刻（`threads.ts:330,444`），**不是 model token 到达时刻**。

### 1.3 流式端点判定（负证据）

- **NOT FOUND: SSE**——apps/server-worker/src 全搜 `event-stream|text/event|SSE`：零命中（唯一 `stream` 是无关 schema 字段 `contract/domain/hdc/local.ts:225`）。
- **NOT FOUND: chunked/流式 HTTP 响应**——`ReadableStream|TransformStream|chunked` 在 routes/services 零命中，handler 全 `ctx.json` 缓冲返回。
- **NOT FOUND: ETag/If-None-Match**——零命中。
- **NOT FOUND: 公共路由转发升级到 AGENT_DO**——`AGENT_DO` 全部用法是 RPC（getEvents/createThread/sendMessage/onExecutionUpdate，`seam/agent-do.ts:61-67,138,255`；`threads.ts:276-626`）。

### 1.4 agent-DO journal append 与 tap

- 存储：`EventLog` DO SQLite，表 `events` PK `(thread_id, seq)`，seq 在 `transactionSync` 内 `MAX+1` 无洞分配（`event-log.ts:88-127`）；oversize `model.delta.text`/`tool.output.chunk`/`tool.result.output` 走 R2 bypass（`event-log.ts:42-47`）。
- **journal 词表已含 token 级事件**：`model.delta`（`event-log.ts:44`；turn driver 逐 delta append，F1 锚 `agent-do.ts:1349`）。
- **tap 存在**：`AgentDO.appendEvent` → `log.append` → `applyEvent` → `pushToSubscribers()`（`agent-do.ts:1099-1119`）；push 严格在 persist 之后（I3，`agent-do.ts:1121-1122`）。帧为 `threadEventsAppendedMessage({threadId, latestSeq})`——**指针 only，无 delta payload**（`agent-do.ts:1123-1138`；`realtime-ws.ts:116-128`）。interaction 生命周期帧同理（`agent-do.ts:1147-1169`）。
- **但 tap 生产上是死的**：agent-DO 自己的 `/ws`（hibernation accept，`agent-do.ts:890-901`）没有 HTTP 路由可达（§1.3），无任何客户端连接；AgentDO→NotificationHubDO 无通知调用（全搜 `hub|notify|broadcast|subscriber` in packages/agent-do/src：只有自有 socket push 与 DO 内 wake 通道，`agent-do.ts:2103-2126`）。代码自证：「per-thread DO appends turn events without pinging the hub」，所以 `events/wait` 以 ≤500ms 切片轮询 hub waiter 防睡过头（`threads.ts:650-653`）。
- 净效果：turn 中途 = journal-write + DO 内内存投影；对外新鲜度只靠 (a) 请求时刻的 hub 通知（send/stop 等）与 (b) HTTP 拉取。

### 1.5 SPA timeline 数据路径（poll + hint）

- GET `/threads/:id/timeline`：全量 `getEvents({sinceSeq:0, project:"ux"})` → `buildTimelinePage`（`threads.ts:486-489,539`）；`afterSequence` + 服务端 `timelineLatestRowsCache` 命中时返回 `delta.upsertRows`（`threads.ts:540-550`；`services/timeline.ts:508-548`）——delta 是行级 upsert，非 token。
- GET `/threads/:id/events?afterSeq=&limit=`（默认 100）：增量事件行（`threads.ts:593-613`）。
- GET `/threads/:id/events/wait?type=&afterSeq=&waitMs≤60000`：唯一长轮询；每轮查 agent DO 后 ≤500ms 打盹于 hub waiter（`threads.ts:615-655`）。

---

## 2. Face 2：bb 原 SPA 流式语义（bb @ ba42654）

### 2.1 daemon 侧 `/ws` 协议形状

- 客户端帧恰两种：`subscribe`/`unsubscribe` × 九种 target（thread/project/environment/host 的 detail+list + system）（`bb/packages/domain/src/change-kinds.ts:67-117,122-137`）。
- 服务端帧恰一种：`{type:"changed", entity, id?, changes[], metadata?}`（`change-kinds.ts:190-247`）。thread change-kind 16 种：`thread-created, thread-deleted, events-appended, history-rewritten, interactions-changed, status-changed, title-changed, queue-changed, archived-changed, pin-state-changed, parent-changed, environment-changed, read-state-changed, order-changed, tabs-changed, terminals-changed`（`change-kinds.ts:8-25`）。
- **NOT FOUND: token delta 帧 / 相位帧**——WS 上无任何文本 payload、无 turn 相位事件；唯一非 changed 服务端消息是三种瞬态控制信号 `thread-open`/`thread-pane-action`/`plugin-signal`（`bb/apps/app/src/lib/ws.ts:108-142`）。`packages/domain/src` 全搜 `delta|token|streaming`：delta 只以**持久化线程事件类型**存在（§2.4），从不成帧。
- metadata 粒度：`eventTypes[]`、`backgroundActivityChanged`、`hasPendingInteraction`、`projectId`（`bb/apps/app/src/hooks/realtime-cache-effects.ts:82-106`）——`eventTypes`（如 `item/agentMessage/delta`）只用于客户端决定**失效哪些 query**（`bb/apps/app/src/hooks/cache-owners/realtime-cache-registry.ts:13-17`）。

### 2.2 journal 写 → 通知的发射点

- 事件插入统一经 `notifyInsertedEventThreads`：按 thread 批量合并后逐 thread 发一次 `notifyThread(threadId, ["events-appended"], {eventTypes})`（`bb/apps/server/src/internal/events.ts:316-343`）。
- 状态跃迁发 `status-changed`；回合结束发组合 `["events-appended","status-changed"]`（`bb/apps/server/src/services/threads/thread-lifecycle.ts:557,829,1643-1645`）；`NotificationBuffer` 可合并冲刷（`bb/apps/server/src/services/lib/notification-buffer.ts:17-56`）。
- 上游：daemon 经 `POST /internal/session/events` HTTP 批量上报事件组（含流式文本 delta），server 落 Postgres——进度不在 RPC/WS 信道（`bb-daemon-protocol.md` §4.1 已档，锚 `bb/apps/server/src/internal/session.ts:189-306`）。

### 2.3 SPA 消费面：realtime-cache-registry

- 连接：单例 `WebSocketManager` 包 partysocket ReconnectingWebSocket——min 1000ms、max 30000ms、×1.5、maxRetries Infinity（`bb/apps/app/src/lib/ws.ts:62-68`）；open 时重发全部 subscribe（`ws.ts:70-81`）。
- **重连语义：无 resume token / seq 游标 / 漏帧重放**；补课 = 重连后全量失效 realtime query keys（`invalidateRealtimeQueriesAfterServerReconnect`、`refetchErroredRealtimeQueriesOnInitialConnect`，`bb/apps/app/src/hooks/cache-owners/system-cache-effects.ts:47-100`，wired `useWebSocket.ts:16-19`）。入帧宽松解析（未知 kind 过滤、未知字段剥离，`ws.ts:144-154`）。
- `changed` 处理：按 change-kind 批量进 state map，**50ms 去抖 / 200ms max-wait** 冲刷（`realtime-cache-effects.ts:29-30,228-232,254-263`）；`status-changed` 绕过去抖立即冲（:258-259）。kind→query-keys 表 `REALTIME_THREAD_CHANGE_REGISTRY`（`realtime-cache-registry.ts:276-400`）；handler 做 `invalidateQueries` + in-flight 时的 **trailing refetch** 防丢（:234-247）。
- **event storm 节流**：trailing refetch 自节流，floor 50ms、cap 1000ms ≈ 观测 fetch 时长，刻意把服务端投影占空比压在 ≈50%（`realtime-cache-registry.ts:135-157`，注释点名「the event storm of an active agent turn」）；终态事件取消 in-flight 并立即 refetch（终态投影权威，:249-263）。
- 模型是 **invalidation + authoritative refetch**，非 optimistic update；`setQueryData` 仅用于纯 metadata 面（侧栏 pending-interaction 徽标）（registry 头注释 :13-24）。

### 2.4 流式文本渲染粒度

- delta 以**持久化事件类型**存在：`item/agentMessage/delta`、`item/commandExecution/outputDelta`、`item/fileChange/outputDelta`、`item/reasoning/summaryTextDelta`、`item/reasoning/textDelta`、`item/plan/delta`、`thread/tokenUsage/updated`，scope policy `"turn"`（`bb/packages/domain/src/provider-event.ts:469-559`；`thread-event-scope.ts:103-124`）——**从不过客户端 WS**，只随 timeline HTTP refetch 折进行。
- 服务端每次请求从零重建 in-turn timeline 投影（大线程 ~130-260ms，`bb/apps/server/src/services/threads/timeline-cache.ts:8-11`；窗口由 `routes/threads/data.ts:337-385` 出，事件预算默认 1500）。
- 渲染粒度 = **chunk-at-changed-refetch**（50-1000ms 节流），非逐 token。NOT FOUND：客户端 token 累积 buffer、SSE、per-delta WS push。
- 等待期显示 ongoing indicator（`ongoingIndicatorLabel`：`"Waiting for reconnection"`/provisioning/后台，`bb/apps/app/src/components/thread/timeline/ThreadTimelinePanelContent.tsx:94-99`；runtime 状态 `active|host-reconnecting|provisioning|starting|waiting-for-host`，`thread-runtime-status.ts:8-12`）。
- 对照：终端输出**确有**真流——专用 `/ws/terminals/:id` base64 帧 + seq 缺口检测 + 有界重连（`bb/apps/app/src/components/thread/terminal/ThreadTerminalView.tsx:773-949`）；assistant 正文没有对应物。

---

## 3. Face 3：daemon client 消费 edge 的方式

- **WS 会话，非轮询**：唯一 HTTP 是 `POST /session/open`（Bearer hostKey；hostId+protocolVersion+bootId → `{sessionId, heartbeatIntervalMs, leaseTimeoutMs}`，`client/connection.ts:102-127`）；随后 WSS `/ws?hostId=&sessionId=` + Bun per-socket Bearer 头（`connection.ts:131-137`），attach 超时 10s。NOT FOUND：任何 latest-rows/delta HTTP 拉取、`afterSeq` 轮询、setInterval HTTP 轮询。
- 帧面：上行 `boot.announce` → 周期 heartbeat（服务端定频）+ 100ms 合帧 uplink flush（`connection.ts:176-203`）；下行 `exec.spawn/tool.exec/exec.resume{ackedOffset}/exec.kill/kill.list/exec.output_ack/exec.forget`，上行 `exec.started/exec.failed/exec.output{offset,text}/exec.output_gap/tool.exited/exec.killed_ack`（`connection.ts:266-373`）。
- **粒度 = 字节偏移块**：客户端从 ExecutionBuffer 每 100ms 发 `exec.output` 块，服务端 `exec.output_ack` 回 trim——journal 侧逐 op 记录（`src/journal.ts:75-103`，`foldOp` 单一折算）。NOT FOUND：journal 行/snapshot 的客户端读取。
- **agent-sink 方向**：service DO → `AGENT_DO.onExecutionUpdate(update)` 推 settled 更新（`service-do.ts:1294-1301`；投递失败靠 `queryUnacked` 看门狗重问，:1302-1303）；`src/agent-sink.ts` 是 L1 测试替身。**LLM token 流从不到达 daemon client**——它只见自己产生进程/工具输出的字节块与 settled `tool.exited`。
- **重连**：单一指数链覆盖 enroll+open+attach+disconnect：1s×2 ±20% jitter、5min cap、429 Retry-After 顶替本地等待（clamp 后）、>10s 稳定会话才 reset（`client/backoff.ts:22-28,115-141`；`client/session-loop.ts:40-80`）。Pinned by `test/l1-client-backoff.test.ts`（连续 503 一小时 open<100 次）与 `test/l1-ws-close-reconnect.test.ts`（close 主动终会话、清定时器、单次重连入链）。
- 边缘件 `src/edge.ts` 是协商接缝的护盾（auth 阶梯/负缓存/token bucket，`edge.ts:8-155`），无轮询端点。

---

## 4. Face 4：omp 参考流式 UX 相位

（锚均相对 `@oh-my-pi/pi-coding-agent/src`）

- **首 token 前**：`agent_start` 即 `ensureLoadingAnimation()` + 标题态 "working"（`modes/controllers/event-controller.ts:1061-1064`）；Loader = shimmer「Working…」+ working row（intent、elapsed 锚 `runStartedAt`、tok/s、stop 控件）（`modes/interactive-mode.ts:452-454,7308-7349,1323-1326`）；提交时刻就拉起（`interactive-mode.ts:3179,3275`）。**无占位文本气泡**；空 assistant 卡片迟到 `message_start` 才建（`event-controller.ts:1204-1209`）。
- **token 流渲染**：事件 `message_start/message_update/message_end`（`event-controller.ts:317-319`）；`message_update` 携带**累积快照** + delta（`text_delta/thinking_delta/...`，消费例 `agents-hub-deps.ts:169-173`；RPC 侧 `full|delta` 投影 `rpc/rpc-types.ts:28-29,548-565`）。渲染不在 provider 速率：`StreamingRevealController` 30fps（`STREAMING_REVEAL_FRAME_MS=1000/30`）grapheme 级 reveal，min step 3 grapheme/帧、落后时 8 帧自适应追赶（`modes/controllers/streaming-reveal.ts:7-9,19-28,72-121`）；tick 渲染组件级 `requestRender(component)`（全树 30fps 曾耗 ~5% CPU，issue #4377）。print mode 则丢 update 快照、只打 delta、`message_end` 权威（`modes/print-mode.ts:68-92`）。
- **工具相位**：`tool_stream_update` 流式喂 args 预览（`event-controller.ts:322-329`）；toolCall block 在 `message_update` 期间就建 live `ToolExecutionComponent` 卡（:1466-1558），partial JSON args 由 `ToolArgsRevealController` 同 30fps 揭示（`modes/controllers/tool-args-reveal.ts:477-484,511+`）；`tool_execution_start` 更新 working 消息为工具 intent 并终冻结 args reveal（`event-controller.ts:1806-1809,1875-1878`）；spinner 贯穿工具间隙（:1915,2021-2026）；`tool_execution_update` 部分结果入卡（:1912-1940）；`tool_execution_end` 结卡（:1958-2040）；审批门把标题翻 "attention"（:161-163,1897-1901）。单工具 >5s 后 HUD 出 1Hz elapsed（`interactive-mode.ts:949-990,1038-1058`）。
- **相位 API**：flat `AgentSessionEvent` 并集——`agent_start/end, turn_start/end, message_*, tool_execution_*, tool_stream_update, auto_compaction_*, auto_retry_*`（`event-controller.ts:312-333`；并集定义 `session/agent-session-events.ts:14-88`）；`agent_end` 带 `isTerminal?/yielded?/awaitingAsyncWork?` 区分真空闲与 retry/compaction/后台续跑（`agent-session-events.ts:16-31`）；订阅 `session.subscribe(listener)`（:90-91）；流中输入用 `streamingBehavior:"steer"|"followUp"` 排队（`interactive-mode.ts:3228-3242`）+ `queue_update`（`agent-session-events.ts:84-88`）。**无相位枚举/FSM**——相位隐式于事件序列。
- **中途 resume**：NOT FOUND——provider 流失败走 `auto_retry_start` 从头重试（倒计时渲染于维护 Loader，`event-controller.ts:333,2500-2504`）；流中文本**不持久化直到 `message_end`**（`session/session-manager.ts:769-773`）；TUI 本地恢复 = 弃流组件 + `rebuildChatFromMessages()` 重放（`event-controller.ts:1188-1200`；`interactive-mode.ts:3330-3334`）。

---

## 5. 差距清单：离逐 token 流出缺哪几件

前置事实：journal 词表已有 `model.delta`（`event-log.ts:44`）；逐 append 推送钩子已有（`pushToSubscribers`，persist-then-push）；HTTP 增量读已有（`events?afterSeq`、timeline `afterSequence` delta）。缺的是接线与帧面：

1. **活线（producer→hub）**：agent-DO 逐 append 推送落在无人可达的 DO 内部 `/ws`（§1.4）。需要一条 agent-DO→NotificationHubDO 的通知通道（hub 订阅各 thread 的 agent-DO `/ws`，或 append 后 RPC notify hub）——否则 turn 中途 `events-appended` 提示永远不发，SPA 只有长轮询切片（`threads.ts:650-653` 自证）。
2. **帧语义档位**：现 `changed` 帧仅 `latestSeq` 指针（`realtime-ws.ts:116-128`）。若逐 token 走 hint+refetch，则每次 append 触发一次 timeline/events HTTP 拉取（N+1，须加客户端游标去抖 ≈bb 的 50-1000ms 自节流）；若要真 token 帧，则需在 `realtime-ws.ts` 增补 delta payload 帧型（可向后兼容：bb SPA 忽略未知帧，`realtime-ws.ts:98-100`）。
3. **SPA 消费层**：本项目 SPA 尚无 bb 的 realtime-cache-registry 等价物（50/200ms 去抖 invalidation + trailing refetch + 重连补课），更无 omp 式 30fps reveal 渲染层；逐 token 落地需补「游标化增量读 + 节流渲染」这一层。
4. **目标语义裁定（spec 输入）**：bb 原型上限就是「节流刷新」（§2.4），omp 是「真流 + 本地节流渲染」（§4）。两者差距本质是客户端渲染层，而非 journal/传输——journal 已 token 粒度，且终端 WS（bb `/ws/terminals/:id`、本项目 daemon exec 帧）已证明真流通道在本架构可建。spec 应先定档位再定第 1-3 件的形态。

> AGENT GENERATED: by zhipu-coding-plan/glm-5.3-flash (research subagent)
