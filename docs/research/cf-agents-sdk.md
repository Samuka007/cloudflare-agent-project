# Cloudflare Agents SDK（npm `agents`）评估：ThreadDO 的候选底座

- 工单：Samuka007/cloudflare-agent-project#20（前置考古），隶属 #17 M0 spec；回应「若 agent 侧本是假的，不如用 CF 标准 agent 实现」的裁决请求
- 检索日期：2026-10-03
- 依据：一手来源为 developers.cloudflare.com/agents 官方文档 + cloudflare/agents GitHub 仓库源码（逐文件核对）+ npm registry；二手来源仅用于佐证活跃度，凡引用处显式标注。版本快照：`agents@0.26.0`（2026-10-02 发布）。

---

## 0. 结论先行

**建议：ThreadDO 用裸 DO（runtime 原语）自写，不继承 `Agent` 基类；Agents SDK 定位为「模式参照库 + 设计证据源」，不进 M0 依赖树。** 三个决定性理由：① 它的 state 模型是单行 JSON 快照、它的 chat 实现绑定 AI SDK 消息形状与自有 WS 协议帧，两者都与 #17「协议主权在我们、(threadId, seq) append-only 事件日志」直接冲突；② 我们最需要的 turn 安全语义（幂等接受、断连重放、事件先落盘）SDK 恰恰没有以可复用原语形态提供——它的重放是流恢复与全量 state 广播，不是 seq-cursor 事件重放；③ 0.x 阶段 minor 版本常态性 breaking（下文列举实证），把它放进「永久核心组件」意味着把平台 churn 引入我们最想稳定的一层。SDK 真正值钱的是**设计模式**（fiber 恢复分类法、Sessions 的表设计经验、chat recovery 的有界重试），这些抄设计不引依赖。

## 1. Agent 基类给了什么：逐项清点（问题 1）

`Agent` 基类（`extends Agent<Env, State>`，本质是 Durable Object 包装，沿袭 partyserver）提供以下能力。标注【内建】= 开箱即用；【要自己拼】= SDK 只给挂点，语义自己写。[来源：Agents API — https://developers.cloudflare.com/agents/runtime/agents-api/ ]

| 能力                             | 形态                 | 说明                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| -------------------------------- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 实例寻址/路由                    | 【内建】             | `/agents/:class/:name` URL + `routeAgentRequest()`/`getAgentByName()`；同名实例全局唯一，天然「每 thread 一只」                                                                                                                                                                                                                                                                                                                                       |
| 生命周期挂点                     | 【内建】             | `onStart/onRequest/onConnect/onMessage/onClose/onError/onStateChanged/onEmail`；WS 自动 accept、自动 hibernation                                                                                                                                                                                                                                                                                                                                      |
| 持久化 state                     | 【内建，但快照模型】 | `this.setState()` 整值替换：写 SQLite → 广播全部连接 → 触发 `onStateChanged`；见 §2                                                                                                                                                                                                                                                                                                                                                                   |
| 裸 SQL                           | 【内建】             | `this.sql\`...\`` 直通 DO 内嵌 SQLite，自建表完全放行                                                                                                                                                                                                                                                                                                                                                                                                 |
| 调度                             | 【内建】             | `schedule()`（延时/定点/cron）+ `scheduleEvery()`，SQLite 持久、单物理 alarm 多路复用、自带重试策略；见 §4                                                                                                                                                                                                                                                                                                                                            |
| durable execution                | 【内建】             | `runFiber()/startFiber()/stash()/onFiberRecovered()/keepAlive(While)/cancelFiber/inspectFiberByKey`；见 §4                                                                                                                                                                                                                                                                                                                                            |
| WS 连接管理                      | 【内建】             | `Connection` 对象（id/uri/state/send/close/tags）、`broadcast()`（可排除指定连接）、per-connection state；[来源：WebSockets — https://developers.cloudflare.com/agents/runtime/communication/websockets/ ]                                                                                                                                                                                                                                            |
| 连接协议帧                       | 【内建，可关】       | 新连接自动推 `cf_agent_identity`/`cf_agent_state`/`cf_agent_mcp_servers` 三个 JSON 帧；`shouldSendProtocolMessages` 返回 false 可抑制（RPC/普通消息/broadcast 不受影响）；[来源：Protocol messages — https://developers.cloudflare.com/agents/runtime/communication/protocol-messages/ ]                                                                                                                                                              |
| callable RPC                     | 【内建】             | `@callable()` 装饰器 + 客户端 `agent.stub.method()` 类型安全 RPC                                                                                                                                                                                                                                                                                                                                                                                      |
| thread/conversation 概念         | 【无，要自己拼】     | SDK 没有 first-class「thread」对象；会话持久化有两种预制件：`AIChatAgent`（已迁至 `@cloudflare/ai-chat`，消息持久化 + 可恢复流式）与 `agents/sessions`（append-only 消息树 + compaction + FTS5），**都是 message 形状，不是事件日志**；见 §2                                                                                                                                                                                                          |
| AI SDK 集成面                    | 【内建，双向耦合】   | 服务端 `AIChatAgent`/Think + `wrapAISDK()` 追踪；客户端 `AgentClient`/`useAgent`/`useAgentChat` React hooks、`agentFetch()`；peer 依赖 `ai@^6/^7`、`@ai-sdk/react@^3/^4`、react@19（全部 optional）；0.26 起另加 TanStack AI/`chat` 包通道；[来源：package.json peers — https://github.com/cloudflare/agents/blob/main/packages/agents/package.json ；Client SDK — https://developers.cloudflare.com/agents/communication-channels/chat/client-sdk/ ] |
| MCP/Email/Voice/Workflows/子代理 | 【内建】             | 与本次评估正交，不展开                                                                                                                                                                                                                                                                                                                                                                                                                                |

## 2. state 模型 vs 我们的 append-only 事件日志（问题 2）

**SDK 的 state 是「最新值快照」，不是事件溯源。** 源码实证（`packages/agents/src/state/index.ts`）：全部 state 存于单表单行——`cf_agents_state (id TEXT PRIMARY KEY, state TEXT)`，行 id 固定 `cf_state_row_id`，写入用 `INSERT OR REPLACE`，读取时 JSON.parse 整行。[来源：https://github.com/cloudflare/agents/blob/main/packages/agents/src/state/index.ts ] 文档同样明示：state 是「persistent + synchronized + bidirectional」的整值 JSON，`setState` 保存→广播→回调三步，广播内容是**全量 state**（协议帧 `cf_agent_state`）。[来源：Store and sync state — https://developers.cloudflare.com/agents/runtime/lifecycle/state/ ]

对照我们的设计（#20：`(threadId, seq)` 唯一索引、append-only、无快照表、冷启动重放）：

| 维度       | SDK `setState`                    | 我们的事件日志                    | 判定                                                                                                                            |
| ---------- | --------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 写模型     | 整值覆盖（最后写者胜）            | 只追加，seq 严格递增              | **冲突**：快照天然丢失事件序与中间轨迹，审计需求（#17 用户故事 4「trajectory 里看到每一步」）无法满足                           |
| 恢复语义   | 读回最后一份 JSON                 | 按 seq 重放重建内存态             | **冲突**：SDK 无重放原语，state 加载即恢复、无「重放一致性」可断言                                                              |
| 客户端同步 | 全量 state 帧 + 变更广播          | 客户端带 last seq，服务端增量重放 | **需绕行**：SDK 帧协议与我们冻结的 bb 形状协议（#17）互斥；可用 `shouldSendProtocolMessages=false` 关掉帧，但那等于不用它的同步 |
| 大 payload | state 必须可序列化 JSON，整值广播 | 事件引用 R2（#17 >100KB 旁路）    | **冲突**：无分块/旁路机制                                                                                                       |

SDK 里形状最接近事件日志的是 `agents/sessions`（实验性）：`cf_agents_session_messages (session_id, id, seq, parent_id, type, role, content, ...)` 主键 (session_id, id) WITHOUT ROWID、append 幂等（重复 id 返回 `inserted: false`）、parent_id 分支树、大内容分块表 `cf_agents_session_message_chunks`、compaction 摘要表 + 隐藏 overlay、FTS5 全文检索、字节预算化读取，源码注释还给出写经济学指导（DO SQLite 行写计费约为行读的 1000 倍，故每表 WITHOUT ROWID、无二级索引）。[来源：https://github.com/cloudflare/agents/blob/main/packages/agents/src/sessions/core.ts ] 但三点使它不能直接当我们的日志用：① **官方标注 `@experimental`，"whole agents/sessions surface may change before stabilizing"**（types.ts 原文），且近期已有 legacy `assistant_*` 表 lift-verify-drop 的内部迁移；② 它存的是 AI SDK `UIMessage` 兼容的 message（role/parts），不是我们的 `turn_started/tool_call/tool_output/reply_delta` 事件词汇；③ 它是「会话树」（分支可分叉），我们是「线性严格 seq」，验收断言（重放幂等、seq 连续）建立在后者上。

## 3. 出站连接与 DO 间通信（问题 3）

**对 agent 主动发起出站调用，SDK 立场是「不限、鼓励」。** 官方文档明示：agent 可从任意方法（onRequest、onMessage、scheduled task、自有方法）调用任何 provider 或「any service that exposes an OpenAI-compatible API」，且「can call AI models on their own — autonomously — and can handle long-running responses」、客户端中途断开时 agent 继续跑、重连后补发。[来源：Using AI models — https://developers.cloudflare.com/agents/runtime/operations/using-ai-models/ ] 我们对模型中转端点的流式 HTTPS fetch 属于平台已覆盖的原语（outbound fetch 阻止驱逐、单操作 ≤15 分钟——见 docs/research/do-turn-lifecycle-safety.md §1），SDK 层无新增约束；WS 流式回推客户端也是官方示例形态。

**ThreadDO ↔ GatewayDO：不需要 SDK，平台 stub 就是正解。** 两者都是同 Worker 内的顶层 DO，`env.GatewayDO.idFromName(machineId)` + stub fetch（含 WS upgrade 的 WebSocketPair）即可，与 SDK 无关。值得记录的是：SDK 自己的「动态代理/subAgent()」facet 机制**官方明确判定不适合我们的拓扑**——sub-agents 文档决策规则原文：「a facet is a child whose code or lifecycle the parent supervises and which must live inside the parent; an independent peer you address by name should be its own top-level Durable Object」，表格中「Many chats / documents / sessions per user → **No** — one top-level DO each + a per-user index」，并给出推荐形态恰是「每 chat 一只顶层 DO + 索引 DO」（`RoutedAgents` 只是该模式的 SDK 封装）。[来源：https://github.com/cloudflare/agents/blob/main/docs/agents/sub-agents.md ；Sub-agents — https://developers.cloudflare.com/agents/runtime/execution/sub-agents/ ] 即：即便采纳 SDK，GatewayDO 也保持顶层 DO、daemon 纯出站 WS 接入不变。

## 4. 真正值钱的部分：调度与 fiber（对照我们的 turn 安全模型）

SDK 把 DO 单 alarm 原语升级为一套 SQLite 持久化作业系统：

- **schedule/scheduleEvery**：延时/定点/cron/interval 四模式，作业存 SQLite、单物理 alarm 多路复用；cron 幂等（同表达式+回调+payload 重复调用返回既有作业）；[来源：Schedule tasks — https://developers.cloudflare.com/agents/runtime/execution/schedule-tasks/ ] 内部实现已迁入 Lifecycle job queue（schema v2，旧 `cf_agents_schedules` 表迁移后 DROP），默认重试 `maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 3000`，interval 作业 singleflight、30s hung 超时。[来源：scheduler.ts — https://github.com/cloudflare/agents/blob/main/packages/agents/src/schedules/scheduler.ts ]
- **durable execution（fibers）**：`runFiber(name, fn)` 注册于 SQLite（`cf_agents_runs` 行）+ 内部 keepAlive（默认 30s 心跳 alarm 抵消 70–140s 空闲驱逐）、`ctx.stash()` 落盘检查点、驱逐后下次激活经 alarm 或首个事件触发 `onFiberRecovered(ctx)`；`startFiber(name, fn, { idempotencyKey })` 提供幂等接受（同 key 重复投递返回 `accepted: false`）、保留状态行、`inspectFiberByKey`、取消。文档明确「这不是自动重放——恢复语义由你的领域决定」。事件执行期出错则删行不重试。[来源：Durable execution — https://developers.cloudflare.com/agents/runtime/execution/durable-execution/ ；Long-running agents — https://developers.cloudflare.com/agents/concepts/agentic-patterns/long-running-agents/ ]

对照 docs/research/do-turn-lifecycle-safety.md 的五步模型：**SDK 的 fiber 机制几乎逐条复刻了我们独立推导的 turn 安全模型**（幂等接受 ≙ 输入先落盘 + 幂等键；stash ≙ 事件增量落盘；onFiberRecovered ≙ 幂等重放恢复；alarm housekeeping ≙ alarm 兜底巡检）。这是「我们的设计方向正确」的最强外部佐证，但**佐证设计 ≠ 值得引入依赖**：fiber 绑定在 Agent 基类/Lifecycle 能力体系上，享受它就要连基类、协议帧、churn 一起吃；而裸 DO 上等价物（事件日志 + 幂等 INSERT OR IGNORE + 自写 alarm 巡检表）按 #17 已是必写项，增量约百余行，且语义 100% 在我们控制内、L1 测试直接断言。

## 5. 可复用 vs 会绊住的（问题 4）

**直接可复用（不引依赖的「抄设计」）**：

- Sessions 表设计经验：WITHOUT ROWID、无二级索引、大内容分块、compaction overlay、token 估算缓存——直接滋养我们事件日志的 schema/migration 设计；[来源：sessions/core.ts，URL 同 §2]
- fiber 恢复分类法与「checkpoint before expensive work, recover from the last checkpoint」原则；[来源：Long-running agents，URL 同 §4]
- chat recovery 的工程细节：有界重试预算（默认 6 次）、退避、无进展超时即封终态、终态错误帧下发客户端——正是我们 alarm 兜底巡检需要的语义细化；[来源：CHANGELOG 0.15.x 条目 + ai-chat 源码 — https://github.com/cloudflare/agents/blob/main/packages/ai-chat/src/index.ts ]

**用了会绊住的**：

- `setState`/state 同步：快照模型 + 全量广播协议帧，与事件日志、bb 形状协议冲突（§2）；
- `AIChatAgent`/`@cloudflare/ai-chat`/Think：机制最全但代价是**协议主权倒置**——客户端必须讲它的 UIMessage-chunk/`OutgoingMessage` 线协议、恢复走它的 ResumeHandshake/ResumableStream，我们的 packages/protocol 冻结（「按 bb 形状冻结，主权在我们」，#17）被整体绕开；内部机器巨大（ai-chat 单文件 ~7900 行），且 Think 近期刚 breaking 移除 `onChatMessage/assembleContext/getMaxSteps`；[来源：ai-chat/src/index.ts + CHANGELOG 0.20.0 条目]
- `agents/sessions`：形状最接近但 `@experimental`（§2）；
- facets/subAgent：官方决策规则判我们该用顶层 DO（§3）。

**灰色地带（按需再议）**：`schedule()` 是唯一「若裸写调度表超预算可单独考虑引入」的能力，但它挂在 Agent 基类上，单独引入不成立；M0 手写 alarm 兜底（do-turn-lifecycle-safety.md §3 已给出完整语义与陷阱清单）覆盖需求。

## 6. 版本与成熟度（问题 5）

| 维度          | 事实                                                                                                                                                                                                                                                                                                                                                                             | 来源                                                                        |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| 版本          | `agents@0.26.0`（2026-10-02），MIT，仍在 0.x（minor 即可 breaking）                                                                                                                                                                                                                                                                                                              | https://www.npmjs.com/package/agents                                        |
| 维护          | Cloudflare 官方 monorepo（npm maintainers: threepointone/rita3ko/whoiskatrin），5.7k stars，release 极高频：0.22→0.26 五周 4 个 minor，0.25/0.26 同日发布；CI 含 nightly/conformance/ai-sdk-compat                                                                                                                                                                               | https://github.com/cloudflare/agents + releases API                         |
| 采用量        | npm 周下载 2.2M（2026-10-03 快照）                                                                                                                                                                                                                                                                                                                                               | https://www.npmjs.com/package/agents                                        |
| 未 GA         | 未检索到 Agents SDK 的 GA 宣告；0.x 版本号本身即最直接的成熟度信号                                                                                                                                                                                                                                                                                                               | 检索记录，无 GA 页面                                                        |
| breaking 实证 | 近三个 minor 内：0.24 把 state 移入 opt-in Lifecycle 能力；experimental memory 栈整体移除（`Session.create` → sessions+ContextBlocks）；0.23 引入的 capnweb RPC 端点 0.24 即移除；Queue 能力重写（`cf_agents_queues` 表 DROP、行迁移进 job queue，且明文「Deployments skipping this release should upgrade through it」）；alarm-contribution 模型移除；调度表 schema v1→v2 迁移 | https://github.com/cloudflare/agents/blob/main/packages/agents/CHANGELOG.md |
| 依赖代价      | 运行时依赖 11 个（partysocket、capnweb、cron-schedule、esbuild、@cfworker/json-schema、yaml、mimetext、postal-mime、nanoid 等）；peer 依赖 react 19 / ai v6-v7 / vite（均 optional）；继承基类即把上述 churn 表面暴露给我们的永久核心组件                                                                                                                                        | package.json，URL 同 §1                                                     |

**与裸写 DO 的依赖账**：裸 DO 路线里 SDK 能替我们写的只有三块——WS 自动 accept/hibernation 包装（裸写约 30 行）、URL 路由（裸写约 3 行 `idFromName`）、schedule/fiber（裸写约 100–200 行，且 #17 本就要求 L1 测试直接断言 alarm 与重放语义，自写表反而更可测）。换来的代价是：0.x churn 落在永久核心、SDK 自管表的 schema 演化脱离我们「migration 文件管理、禁止 ad-hoc 改表」的纪律（#17 工程底线）、L1 测试对 cf_agents_* 内部结构的耦合。

## 7. 最终建议与「若采纳」映射（问题 6）

**建议：ThreadDO = 裸 DO 手写。** 理由汇总：协议主权（#17 冻结 bb 形状，SDK 帧协议互斥）、事件溯源形状（快照/message 形状都错位）、平台原语已覆盖需求而 SDK 缺 seq-cursor 重放原语、0.x churn 与「永久核心组件」的稳定性诉求相反、L1 可测性（自表自 alarm 直接断言 vs 耦合 cf_agents_* 内部）。SDK 的正确用法：设计参照（§5 可复用清单）+ 未来产品面的候选件（若日后要做标准 chat UI/快速原型，`AIChatAgent` + `useAgentChat` 可作为隔离组件单独评估，不进 ThreadDO 底座）。

**若最终裁决采纳 SDK，M0 各决定落到 SDK 机制上的方式**（供对照，非推荐）：

| 我们的设计                  | 裸 DO 做法                          | SDK 机制落点                                                                       | 吻合度                     |
| --------------------------- | ----------------------------------- | ---------------------------------------------------------------------------------- | -------------------------- |
| (threadId, seq) 事件日志    | 自建表 + 唯一索引                   | `this.sql` 自建表（cf_agents_* 命名空间让开）；**不**用 setState/Sessions          | 需绕行                     |
| turn 幂等键                 | INSERT OR IGNORE on (threadId, seq) | `startFiber(idempotencyKey)` 幂等接受 + retained 状态行                            | 直接吻合                   |
| 冷启动重放                  | onStart 内按 seq 重放               | 无对应原语；`onFiberRecovered` 只覆盖 fiber 中断，不重建历史                       | 缺失，仍要自写             |
| 重连重放（客户端 last seq） | 自写 cursor 重放端点                | 无对应原语（协议帧为全量 state；ResumeHandshake 是流恢复非事件重放）               | 缺失，仍要自写             |
| alarm 兜底巡检              | 自写巡检表 + alarm                  | `scheduleEvery()` 或 fiber housekeeping（自带重试/单飞/hung 超时）                 | 直接吻合                   |
| 长推理期保持活跃            | outbound fetch 阻止驱逐（≤15 分钟） | `keepAliveWhile()` 包裹推理循环                                                    | 直接吻合                   |
| 大 payload R2 旁路          | 事件存引用                          | 无对应原语                                                                         | 缺失                       |
| WS hibernation + 广播       | `acceptWebSocket` + 循环 send       | `onConnect/broadcast()` 自动 hibernation，`shouldSendProtocolMessages(false)` 关帧 | 直接吻合（关帧后为纯管道） |

一句话结论：**Agents SDK 证明了我们在 #20 的 turn 安全模型走在官方同一条路上（幂等接受、检查点恢复、alarm 兜底三件套逐条对得上），但它没有提供我们最核心的 append-only 事件日志与 seq-cursor 重放原语，反而在 state/chat/sessions 三处与我们冻结的协议契约正面冲突，且 0.x 阶段 churn 集中在基类与内部表结构——抄它的设计与表结构经验，不把它放进依赖树。**

## 来源清单

- Agents API（基类/生命周期/this.sql）：https://developers.cloudflare.com/agents/runtime/agents-api/
- Store and sync state：https://developers.cloudflare.com/agents/runtime/lifecycle/state/
- State 源码（cf_agents_state 单行快照）：https://github.com/cloudflare/agents/blob/main/packages/agents/src/state/index.ts
- WebSockets：https://developers.cloudflare.com/agents/runtime/communication/websockets/
- Protocol messages（cf_* 帧/抑制）：https://developers.cloudflare.com/agents/runtime/communication/protocol-messages/
- Schedule tasks：https://developers.cloudflare.com/agents/runtime/execution/schedule-tasks/
- Scheduler 源码（job queue/重试/迁移）：https://github.com/cloudflare/agents/blob/main/packages/agents/src/schedules/scheduler.ts
- Durable execution（fibers）：https://developers.cloudflare.com/agents/runtime/execution/durable-execution/
- Long-running agents：https://developers.cloudflare.com/agents/concepts/agentic-patterns/long-running-agents/
- Sub-agents：https://developers.cloudflare.com/agents/runtime/execution/sub-agents/ 与 https://github.com/cloudflare/agents/blob/main/docs/agents/sub-agents.md（决策规则）
- Sessions 源码（表结构/写经济学）：https://github.com/cloudflare/agents/blob/main/packages/agents/src/sessions/core.ts 与 types.ts
- AIChatAgent 源码（恢复引擎/流恢复）：https://github.com/cloudflare/agents/blob/main/packages/ai-chat/src/index.ts
- Using AI models（出站调用/自主长任务）：https://developers.cloudflare.com/agents/runtime/operations/using-ai-models/
- Client SDK：https://developers.cloudflare.com/agents/communication-channels/chat/client-sdk/
- npm `agents`（版本/下载量/维护者）：https://www.npmjs.com/package/agents
- 仓库主页与 package.json：https://github.com/cloudflare/agents 、https://github.com/cloudflare/agents/blob/main/packages/agents/package.json
- CHANGELOG（breaking 历史）：https://github.com/cloudflare/agents/blob/main/packages/agents/CHANGELOG.md
- 站内前置研究：docs/research/do-turn-lifecycle-safety.md（turn 安全模型与平台原语语义）

> AGENT GENERATED: by zhipu-coding-plan/glm-5.3-flash (research subagent)
