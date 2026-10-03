# DO 上的 turn 生命周期安全模型

- 工单：Samuka007/cloudflare-agent-project#6（"崩溃/驱逐持久化机制（M1 前需要）"，隶属 #1）
- 检索日期：2026-10-03
- 依据：仅 Cloudflare 官方文档（developers.cloudflare.com）；个别实现层细节 developers.cloudflare.com 未明确时，明确标注「文档未明确」并给出最接近的官方来源，不做猜测。唯一例外是 Cloudflare 官方博客（cloudflare.com 域名下 Cloudflare 自有发布），在引用处显式标注。

---

## 1. Durable Object 生命周期语义：restart vs eviction vs hibernation

官方生命周期模型有五个状态：**Active, in-memory**（运行中处理事件）→ **Idle, in-memory (hibernateable / non-hibernateable)** → **Hibernated**（移出内存，hibernatable WS 连接保持）→ **Inactive**（从宿主进程完全移除，可能冷启动）。[来源：Lifecycle of a Durable Object — https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/ ]

三者精确区别：

| 概念 | 触发条件 | 内存状态 | storage | WS（server 端，hibernation API） |
| --- | --- | --- | --- | --- |
| **Hibernation（休眠）** | 满足全部四个条件后，约 10 秒无任何事件/请求：① 无 `setTimeout`/`setInterval` 待触发回调；② 无未完成 I/O、无未决 `waitUntil` promise、无未关出站连接；③ 未使用 Standard WebSocket API（只能用 hibernation API accept 的 WS）；④ 无正在处理中的请求/事件 | **丢弃**（构造器会在下次事件时重跑） | 保留（唯一持久层） | 客户端连接保持在 Cloudflare 网络边缘，不断开；计费 duration 停止累计 |
| **Eviction（驱逐）** | idle, non-hibernateable 状态下 70–140 秒无事件；或 runtime 决策（主机迁移等） | **丢弃**，对象转 Inactive，可能整体离开该宿主 | 保留 | 连接终止（shutdown 语义：WS 自动断开，新实例尽快接管） |
| **Restart（重启）** | 部署新代码、Workers runtime 更新、runtime 决定换宿主、缺乏请求 | **丢弃**，构造器重跑，新请求路由到新实例 | 保留 | 连接自动终止；HTTP/RPC in-flight 请求若**不访问 storage** 可完成，**访问 storage 则立即报错**（维持全局唯一性）；runtime 更新时 in-flight 请求最多 30 秒完成 |

[来源：Lifecycle of a Durable Object — https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/ ]

关键补充事实：

- **Pending operations 阻止驱逐**：service binding 请求、DO RPC、outbound `fetch()`、`container.monitor()`、`waitUntil`、`setTimeout`/`setInterval`、TCP socket、出站 WebSocket 都阻止驱逐，但**每个操作自开始起最多 15 分钟**（先到者为准），多个操作的时间窗不叠加；之后开始的操作可延长驻留。[来源：同上]
- **无 shutdown hooks**：Cloudflare 明确不提供关停回调，也不保证其能执行；官方模式是**增量写 storage**（例：边处理流边写进度）。文档同时说明 "Durable Object storage writes are fast and synchronous"。[来源：同上]
- **内存态不跨 hibernation/eviction**："in-memory state is not preserved across eviction or hibernation, persist anything important to storage"。[来源：In-memory state in a Durable Object — https://developers.cloudflare.com/durable-objects/reference/in-memory-state/ ]
- **全局唯一性与接管**：同一 ID 的 DO 全世界同时只有一个实例在跑；网络分区或软件更新时旧实例可能被替换，**新实例可在别处启动**。唯一性在「新事件开始」与「访问 storage」两点强制执行：被替换的旧实例若之后访问 storage 会收到异常；若从不访问 storage，它可能永远不知道自己已过期。[来源：Known issues — https://developers.cloudflare.com/durable-objects/platform/known-issues/ ]

**对 turn 的含义**：任何时刻、任何一种扰动都会清空全部 JS 内存；唯一可跨扰动存活的是 `ctx.storage`（KV/SQL/alarm 状态）。turn 的中间态只要没落盘，就视为随时会丢。

## 2. WebSocket 断开与 hibernation

**hibernation API 下 DO 会被回收吗——会，而且这正是设计目的。** 调 `state.acceptWebSocket(ws)` 后，DO 空闲时从内存移除，客户端连接由 Cloudflare 网络保持；收到消息/事件时 runtime 重新跑 `constructor` 再调用 `webSocketMessage`。[来源：Use WebSockets — https://developers.cloudflare.com/durable-objects/best-practices/websockets/ ]

- 断开语义：对端关闭时（DO 即使 hibernated 也会被唤醒）调用 `webSocketClose(ws, code, reason, wasClean)`。compat date ≥ 2026-04-07 起 runtime 自动回 Close 帧，handler 内 `ws.close()` 不再必需。[来源：Durable Object Base Class — https://developers.cloudflare.com/durable-objects/api/base/ ]
- **断开后 in-flight JS 状态保不住**：hibernation 明确 "In-memory state is reset"。跨 hibernation 的每连接状态只能用 `ws.serializeAttachment()` / `deserializeAttachment()`，上限 **16,384 字节**，且**任一方关闭连接即丢失**；更大的状态官方指引用 Storage API。[来源：Use WebSockets（serializeAttachment 一节）— https://developers.cloudflare.com/durable-objects/best-practices/websockets/ ]
- `webSocketMessage` 唤醒语义：消息到达 → constructor 重跑 → handler 执行；协议层 ping 帧由 runtime 自动 pong，**不唤醒** DO，也不进 handler；控制帧不触发 `webSocketMessage`。[来源：Use WebSockets + Base Class — URL 同上]
- **Standard API（`ws.accept()`）**：使用 Standard API 的 DO 永不满足 hibernation 条件（条件③），断开后对象按 idle, non-hibernateable 规则在 70–140 秒后被驱逐。hibernation 只支持 DO 作为 WebSocket **server**；出站 WS 不休眠，但出站 WS 连接阻止驱逐（每连接最长 15 分钟）。[来源：Use WebSockets — https://developers.cloudflare.com/durable-objects/best-practices/websockets/ + Lifecycle — https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/ ]
- **部署即断连**：新版本部署会重启所有 DO 并断开全部现有 WS 连接。[来源：Use WebSockets（"Code updates disconnect all WebSockets"）— https://developers.cloudflare.com/durable-objects/best-practices/websockets/ ]
- **WS 消息重投递语义：文档未明确。** 文档未说明 `webSocketMessage` 处理中途 DO 崩溃时该消息是否会重放（对比 alarm 的显式 at-least-once 承诺）。最接近的来源是 Alarms API 页面中 at-least-once 仅限 `alarm()` handler 的表述：https://developers.cloudflare.com/durable-objects/api/alarms/ 。工程上必须把 WS 消息按「可能丢、可能重复」处理：输入先落盘再执行。

**对 turn 的含义**：WS 断开 ≠ turn 丢失——用 hibernation API 时客户端断开只是触发 `webSocketClose`，DO 仍存活、可继续跑完 turn 并把事件写 storage，待客户端重连后重放。但 turn 产出的**未落盘**事件在断开/休眠/崩溃时都丢。

## 3. alarm 作为 turn 级 checkpoint

精确语义（全部来自官方 Alarms API 页）：[来源：https://developers.cloudflare.com/durable-objects/api/alarms/ ]

- **单 alarm**：每个 DO 同一时刻只能有一个 alarm；`setAlarm()` 覆盖旧值。多事件调度官方模式是「事件表存 storage + `alarm()` 处理到期事件再续设下一个」。
- **alarm 操作走 Storage API**，与其他存储操作遵循同一规则（即参与下文的持久性/事务屏障）。
- **at-least-once + 自动重试**：`alarm()` handler 抛未捕获异常时按指数退避重试，**首次失败后从 2 秒起，最多 6 次**；`alarmInfo.retryCount`/`isRetry` 可识别重试。**重试只适用于最近一次 `setAlarm()`**。
- **重试耗尽即丢**：6 次耗尽后该 alarm 不再执行，直到下次 `setAlarm()`。官方明确建议在 handler 内 catch 异常并自行续设 alarm 以实现无限重试；下游长时间故障或 bug 未修都会耗尽重试。
- handler 内调 `deleteAlarm()` 只 **best-effort** 阻止重试，不保证。
- alarm 运行期间 `getAlarm()` 返回 `null`（除非 handler 内又调用了 `setAlarm`）。
- **时间精度**：millisecond 粒度，通常到点后几毫秒内执行，但**维护或故障转移时可延迟最多约 1 分钟**；设过去时间 = 立即异步执行（不打断正在运行的 handler）。
- **constructor 先于 alarm**：从休眠/非活跃唤醒时先跑 constructor 再跑 `alarm()`，constructor 里设 alarm 必须先 `getAlarm()` 判空，否则会覆盖掉已设的 alarm。
- **崩溃后仍触发**："If an unexpected error terminates the Durable Object, the `alarm()` handler may be re-instantiated on another machine... run from the beginning"。alarm 状态本身是持久的，这是它区别于 `setTimeout` 的本质。
- **wall clock 上限**：alarm handler 单次调用最长 **15 分钟**（见 wall-time 表）。[来源：Queues Limits 页面 wall-time 表 — https://developers.cloudflare.com/queues/platform/limits/ ]

作为 turn 级 checkpoint 的可行性结论：

- **可行**：alarm 是持久的、崩溃存活的、at-least-once 的唤醒源，适合三类用途：① 「turn 存活检查」——每个 turn 开始时设 alarm，到期检查 turn 是否完成，未完成则从 storage 恢复/重放；② 长任务分段推进；③ TTL/清理。
- **局限**：① 单 alarm：同一 DO 上多个并发 turn 需要自己维护最小堆式调度表；② 至多约 1 分钟的触发延迟 + 6 次重试上限：不能作为实时路径，只能作兜底；③ at-least-once：恢复逻辑必须幂等（以 turn id + 事件序号为幂等键）；④ alarm 只保证「被唤醒」，**不保存任何执行现场**——恢复到哪一步完全取决于应用写过多少 checkpoint。

## 4. Cloudflare Queues 的投递保证

- **at-least-once，默认且仅有**："Queues provides at least once delivery by default"；偶发重复投递；无 exactly-once。去重要应用层做：写消息时生成唯一 ID 作为幂等键（数据库主键 / 上游 idempotency key）。[来源：Delivery guarantees — https://developers.cloudflare.com/queues/reference/delivery-guarantees/ ]
- **确认与重试**：消费者可逐消息 `ack()`（显式确认后不再重投）/ `retry()`（nack）；批级 `ackAll()`/`retryAll()`；单个调用优先级规则明确。投递失败默认重试 **3 次**（`max_retries` 可配，上限 100）；**批内一条失败则整批重投**，除非失败消息之前的消息已被显式 ack。[来源：Batching, Retries and Delays — https://developers.cloudflare.com/queues/configuration/batching-retries/ ]
- **DLQ**：消费者配置 `dead_letter_queue`；达到重试上限的消息进 DLQ，**未配置 DLQ 则永久删除**。DLQ 上无消费者的消息保留 4 天后删除。[来源：Dead Letter Queues — https://developers.cloudflare.com/queues/configuration/dead-letter-queues/ ]
- **限制**（决定能否承载 turn 级任务）：单消息 **128 KB**；每队列吞吐 5,000 msg/s（超限 `send()` 抛 Too Many Requests）；backlog 上限 25 GB；保留期付费可配至 14 天（Free 24h）；push 消费者并发 250；消费者单次调用 wall clock **15 分钟**、CPU 可配至 5 分钟；`delaySeconds` 最长 24 小时。[来源：Limits — https://developers.cloudflare.com/queues/platform/limits/ ]
- 批投递参数：`max_batch_size` 默认 10（1–100）、`max_batch_timeout` 默认 5 秒（0–60 秒），先到先触发。[来源：Batching, Retries and Delays — https://developers.cloudflare.com/queues/configuration/batching-retries/ ]

**能否承载 turn 级任务**：能承载「turn 的异步投递/重试通道」这一角色（at-least-once + DLQ + 15 分钟消费者窗口足够），但有三个约束：① 128 KB 消息上限 → 大 prompt/上下文必须放 DO storage 或 R2，消息只带引用；② 消费者是 Worker（push 模式），不是 DO——DO 可以向 queue 发消息（官方示例：Use Queues from Durable Objects — https://developers.cloudflare.com/queues/examples/use-queues-from-durable-objects/ ），消费入口需再路由回对应 DO；③ at-least-once + 整批重投语义 → turn 执行必须幂等。若 turn 要求低延迟同步流式路径，Queues 的批投递延迟（默认最长 5 秒组批）不适合作为主路径。

## 5. DO SQLite 存储的持久性保证

**写入何时可见/持久**（官方 SQLite-backed Durable Object Storage 文档）：[来源：https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/ ]

- 每个存储方法**隐式包裹在事务里**，原子且相互隔离；多次 `put()`/`delete()` 之间若无 `await`，自动合并为一个原子事务——机器故障时**要么全部落盘要么全部不落**（"Automatic write coalescing"）。
- `put()` 返回的 promise 通常立即完成：写入先进**内存 write buffer**，异步 flush 到磁盘；大量写入不 `await` 会撑内存（128 MB isolate 上限），`await` 会施加背压。
- **默认确认屏障（这是核心持久性契约）**："the system will pause outgoing network messages from the Durable Object until all previous writes have been confirmed flushed to disk. If the write fails, the system will reset the Object, discard all outgoing messages, and respond to any clients with errors"——即**外部世界不可能在写入成功落盘前观察到 DO 的任何动作**。`sync()` 可显式等待所有 pending 写入持久化完成；`allowUnconfirmed: true` 可换低延迟但放弃该屏障。
- 由此推出（文档语义的直接结论）：**「已对外可见 ⇒ 已持久化」**；反过来，只 `put()` 了、屏障还没放行就崩溃 → 该写入对外从未发生过，可能整体消失（合并事务 all-or-none）。所以 checkpoint 的正确顺序是：**先写 storage，再做对外副作用（发 WS 消息、调上游、回响应）**。

**WAL 与 fsync 的实现细节：developers.cloudflare.com 文档未明确。** 文档层面没有给出 WAL 模式、fsync 时机、复制 quorum 的规范描述。最接近的官方来源：① Cloudflare 官方博客《Zero-latency SQLite storage in every Durable Objects》描述了 DO 内嵌 SQLite 以 WAL 追加写入、WAL 帧流式复制到近端副本 quorum 确认、并以此支撑 30 天 PITR（https://blog.cloudflare.com/sqlite-in-durable-objects/ ，Cloudflare 官方博客，补充性质）；② developers.cloudflare.com 上的 PITR API 事实（可恢复到过去 30 天任意时点、"a durable log of data changes"）从产品行为上印证存在持久化变更日志（https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/ ）。应用层不应依赖任何超出上述「确认屏障」契约的细节。

**KV API vs SQL API 的持久性差异：无持久级别差异，差异在 API 形态。**

- SQLite-backed DO 上，异步 KV（`ctx.storage.get/put`）、同步 KV（`ctx.storage.kv.*`，存在隐藏表 `__cf_kv`）、SQL（`ctx.storage.sql.exec`）、PITR、alarm 共用同一个内嵌 SQLite 数据库，适用同一套事务/持久性语义。[来源：https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/ ]
- 差异是工程性的：SQL API 可表达多行事务与索引（`transactionSync()`，不支持 `BEGIN TRANSACTION` 语句）；同步 KV 无 await、天然与后续写合并为原子事务；SQL **游标跨 `await` 无快照隔离**（可能读到之后未提交的写入），必须同步消费完。[来源：同上]
- 另有 legacy KV-backed 后端（无 SQL/PITR），新账号已不能创建，与本文的 SQLite 后端不混谈。[来源：Access Durable Objects Storage — https://developers.cloudflare.com/durable-objects/best-practices/access-durable-objects-storage/ ]

**eviction/restart 时已提交写入是否必存：必存。** storage 就是唯一恢复源：文档反复陈述对象重启后由构造器从 storage 初始化；"you should use Storage API to persist state durably on disk that needs to survive eviction or restart of Durable Objects"；甚至对象存续本身与 storage 绑定（storage 为空且从未写过 → 关停后对象不再存在；写过则只有 `deleteAll()` 能清除）。[来源：Lifecycle — https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/ + Access Durable Objects Storage — https://developers.cloudflare.com/durable-objects/best-practices/access-durable-objects-storage/ ] 前提是写入已过确认屏障（见上）。PITR（30 天，覆盖 SQL+KV 数据）可作为误写/逻辑故障的回滚手段，`onNextSessionRestoreBookmark` + `ctx.abort()` 在下次重启时生效。[来源：https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/ ]

## 6. 综合结论：turn 生命周期安全模型

假设的 turn 形态：客户端经 WS（hibernation API）发送输入 → DO 执行 LLM 推理（含工具调用）→ 流式产出事件 → 事件写 storage 并推给客户端 → 完成态落盘。四种扰动：

- **无断连**（正常完成）
- **WS 断**（客户端掉线/网络切换；DO 未崩）
- **进程崩溃/重启**（deploy、runtime 更新、代码异常终止对象）
- **宿主驱逐/迁移**（idle 驱逐不适用——活跃期间不驱逐；此处指 runtime 决策迁移、全局唯一性接管）

| turn 阶段 | 无断连 | WS 断 | 进程崩溃/重启 | 宿主驱逐/迁移 |
| --- | --- | --- | --- | --- |
| **收到输入** | 无丢失 | 输入已到达 DO；若尚未落盘，仅丢失「未投递到客户端的 ack」 | 若输入未落盘即崩 → **输入永久丢失**（WS 消息无重投保证，文档未明确） | 同崩溃列（新实例对旧输入一无所知） |
| **推理中**（outbound fetch 流式） | 无丢失；outbound fetch 阻止驱逐（单操作 ≤15 分钟）；活跃期间无 wall clock 上限 | DO 继续推理，内存态仍在；结果可落盘待重连重放 | **全部内存态丢失**；未 checkpoint 的推理进度丢失；上游已消耗的 token 不退 | 同崩溃列；若发生唯一性接管，旧实例再碰 storage 即报错 |
| **工具执行** | 无丢失 | 同上 | 执行到一半的外部副作用**无法回滚**（上游已发生）；已完成但未记录的副作用会被重做 → **必须幂等工具** | 同崩溃列 |
| **事件写入** | 写入过确认屏障后必存 | 已落盘事件保留；未落盘事件丢失 | 已落盘事件必存；**已推送客户端但未落盘的事件**会造成「客户端看到过、重连后重放不到」的空洞 | 已落盘必存；同上空洞风险 |
| **完成** | 完成态落盘即安全 | 同左；客户端可随时重连重放 | 完成态已落盘 → 丢的只是「未送达的推送」，不丢事实 | 同左 |

逐格依据：生命周期/shutdown/驱逐语义 — https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/ ；hibernation 与 attachment — https://developers.cloudflare.com/durable-objects/best-practices/websockets/ ；确认屏障与合并事务 — https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/ ；WS 消息无重投承诺（文档未明确，按最弱处理）— https://developers.cloudflare.com/durable-objects/api/alarms/ （对比项）；唯一性接管 — https://developers.cloudflare.com/durable-objects/platform/known-issues/

**平台给的和必须应用层补的**：

| 保证 | 由谁提供 |
| --- | --- |
| 单写者/全局唯一、storage 事务原子性、确认屏障（可见⇒持久）、alarm at-least-once 唤醒、Queues at-least-once + DLQ、hibernation 期间连接保持 | 平台 |
| turn 输入先落盘再执行（WS 消息会丢） | 应用层 |
| 事件先写 storage 再推客户端（顺序不可反，否则出现客户端已见但无法重放的空洞） | 应用层 |
| turn 幂等（alarm/Queues 均 at-least-once，恢复路径会重放） | 应用层 |
| 推理中断恢复点（分段 checkpoint：每个工具调用/每段推理落一次状态） | 应用层 |
| 重连重放（客户端带 cursor，服务端从 storage 回放事件流） | 应用层 |
| alarm 6 次重试耗尽的兜底（handler 内 catch + 续设） | 应用层 |
| 大载荷外置（Queues 128 KB / attachment 16 KB 上限） | 应用层 |

**一句话结论**：DO 平台保证「落盘的丢不了、落盘前外部看不见」，但不保证「任何 turn 中间态被保存」——restart/eviction/hibernation 三者在任何时刻都可能清空 JS 内存且无 shutdown hook；alarm 是唯一崩溃存活的 DO 内调度原语（at-least-once、单 alarm、约 1 分钟抖动、6 次重试上限），Queues 可作跨对象 at-least-once 投递通道（128 KB 上限、DLQ 兜底）；因此 turn 级安全模型的正确形态是：**输入落盘 → 事件增量落盘 → 幂等消费 → alarm 兜底巡检 → 重连重放**，五者全部是应用层责任。

> AGENT GENERATED: by zhipu-coding-plan/glm-5.3-flash (research subagent)
