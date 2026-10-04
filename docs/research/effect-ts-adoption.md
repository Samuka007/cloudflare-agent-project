# Effect-TS 采用评估：packages/agent-do 的运行时选型验证

- 工单：Samuka007/cloudflare-agent-project#29（agent DO 实现前置研究）；验证对象：所有者已发出的「Effect 允许、可混合、不出包」lane 指令
- 检索日期：2026-10-03
- 依据：一手来源为 effect.website 官方文档与发布公告、Effect-TS/effect GitHub 仓库（releases/issues/PR/源码，逐条核对，均标注 ref）、npm registry；本仓库现状（packages/agent-do/package.json）同样为一手证据。版本快照：`effect@4.0.0`（2026-10-01 发布）与 `effect@3.22.2`（2026-09-09，v3 末版）。
- 方法论警示：本次验证针对的正是「凭 prior 发出裁定」的风险——4.0.0 恰好在我们决策前两天（2026-10-01）发布，所有 v3 时代的兼容性结论都必须重新过一遍 v4 现实，下文逐条标注。

---

## 0. 结论先行

**建议：混合采用，且版本必须钉 `effect@4.0.0`（不是 3.x）。** Effect 用在 agent DO 内部的两个模块：**模型 relay 消费**（Stream + typed errors + 退避重试/封口前的结构化生命周期）与 **turn 编排**（Fiber 并行工具调用、interrupt 即取消/中止）。朴素 TS 保留：事件日志读写层、纯 reducer、DO 类壳、WS hibernation/alarm 接线、R2 旁路、daemon service DO 与 daemon client。`packages/protocol` 保持零 Effect 依赖，agent-do 公共入口不泄漏 Effect 类型。明确负面清单：不用 `effect/eventlog`（多副本加密同步模型，比我们重一个量级，且 v4 丢失了 Cloudflare adapter）、不用 Effect Cluster、M0 不用 `@effect/ai`、不要把 `effect/workers` 误当 Cloudflare Workers（它是 Web Worker runner）。

三个决定性理由：① **workerd 兼容是「维护中的事实标准」而非官方承诺**——无 `@effect/platform-cloudflare`（npm 404）、v4 平台文档的运行时清单不含 Cloudflare Workers，但 2025–2026 年全部 workerd 专项 issue（Scheduler 全局 timer 回退、Effect.fn 启动预算、Logger、sqlite-do 事务死锁）都以天级响应修复，且 v4 core 零运行时依赖、最小包体 7.1 kB，对 workerd 是友好的；② **churn 风险被 v4 的版本模型反转**——v4 起全家桶单一版本号 + lockstep 发布 + 官方 LTS（4.x bug 修复到 ≥2029-09），这比 CF Agents SDK 的 0.x churn 是结构性更好的承诺；而现在入场 3.22.2 意味着adopt即落后一代（sqlite-do 的 DO 事务三个关键修复只在 4.0.0）；③ **我们的用法恰好落在 Effect 的甜点区**（流消费、结构化并发、错误分类），而 22 条不变量里真正因 Effect 减少手写的只有 3–4 条——所以是「局部采用」而非「框架迁移」，off-ramp 因此可控（§5）。

---

## 1. 版本与发布节奏：churn 评估（问题 1）

### 1.1 版本事实（npm registry + GitHub releases，2026-10-03 检索）

- **当前版本：`effect@4.0.0`**，2026-10-01 发布。[来源：https://www.npmjs.com/package/effect ；https://github.com/Effect-TS/effect/releases/tag/effect@4.0.0 ]
- 近 12 个月（2025-10-01 → 2026-10-03）v3 线 stable 发布 37 次中占 6 次：`3.18.2`（2025-10-04）→ `3.22.2`（2026-09-09）；**minor 共 4 个**：`3.19.0`（2025-11-04）、`3.20.0`（2026-03-16）、`3.21.0`（2026-03-20）、`3.22.0`（2026-07-13），patch 节奏约每月 1–2 次。[来源：npm registry time 数据，https://registry.npmjs.org/effect ]
- v3 四个 minor 的 release notes 均不含 "breaking" 字样（本次逐个抓取核对）；Effect 的 breaking 变更历史上有部分落在 minor 里、以 unstable 模块为载体，v4 把这个约定写进了文档：`@stability unstable` = 可在 minor 内 breaking，`experimental` = 可在 patch 内 breaking，无标注 = 严格 semver。[来源：https://github.com/Effect-TS/effect/blob/main/MIGRATION.md 「Unstable Module System」节 ]
- **`4.0.0` 前有 107 个 beta + 11 个 rc**（npm versions 序列），说明这次 major 经过了长公测，不是突袭。[来源：https://registry.npmjs.org/@effect/sql-sqlite-do 同步版本序列佐证；effect 包同型 ]
- 4.0.0 同时发布了约 31 个生态包（`@effect/sql-*`、`@effect/platform-*`、`@effect/ai-*`、`@effect/vitest` 等）全部同名 `4.0.0`。[来源：https://github.com/Effect-TS/effect/releases （2026-10-01 波次）]

### 1.2 v4 的版本模型：对 churn 判据的反转

v4 起的结构性变化（[MIGRATION.md](https://github.com/Effect-TS/effect/blob/main/MIGRATION.md)）：

1. **全家桶单一版本号**：`effect@4.0.0` 配 `@effect/sql-pg@4.0.0`，不再有 `@effect/platform@0.x` 式的独立版本漂移——这正是我们否决 CF Agents SDK 时最痛的「依赖矩阵没法钉」问题，被官方用版本策略消灭。
2. **包大整合**：`@effect/platform`、`@effect/rpc`、`@effect/cluster` 并入 core `effect`；独立存留的只有 platform-\*/sql-\*/ai-\* 等运行时/提供方特定包。
3. **core 零运行时依赖**："The core `effect` package has zero runtime dependencies."——供应链面与 workerd 兼容面同时收窄。[来源：https://effect.website/blog/releases/effect/40 ]
4. **官方 LTS**：4.x bug 修复至 2029-09 或 5.0 后一年（取晚），安全修复至 2029-09 或 5.0 后两年；「每个 major 都有 LTS 政策」。[来源：https://effect.website/blog/releases/effect/40 「Long-term support」节 ]

对照我们的 churn 判据（cf-agents-sdk.md：0.x 五周 4 minor 即否决）：effect 3.x 近 12 个月 4 个 minor 且无 major；v4 发布即给出 ≥3 年 LTS 承诺。**节奏风险显著低于被我们否决的对象。** 残余风险有二，须如实记录：

- **v4.0.0 发布至今 2 天**。x.y.z.0 首版 + 2 天是全文档最年轻的证据；我们采用它等于进早鸟窗口。缓解：核心 `effect` 无第三方依赖链、有 107+11 轮公测；且我们把 Effect 限制在两个模块内（§6），炸了也是局部炸。
- **过渡期版本断层**：npm 上 `@effect/platform` latest 仍是 `0.97.2`、`@effect/sql` 仍是 `0.52.1`（v3 尾巴），而 `@effect/platform-node@4.0.0`、`@effect/sql-sqlite-do@4.0.0` 已发——旧包已并 core、不再跟随，装错包会拿到 v3 世代代码。纪律：**只装同名 4.0.0 全家桶，凡 0.x 版本号的 @effect 包一律视为 v3 遗物。** [来源：https://registry.npmjs.org/@effect/platform dist-tags ；https://registry.npmjs.org/@effect/sql ]

### 1.3 本仓库现状的偏差（必须修）

`packages/agent-do/package.json` 现钉 `"effect": "3.22.2"`。[来源：本仓库 `packages/agent-do/package.json` ] 该版本在 v4 发布后即为「上一代」：v3 线的 `@effect/sql-sqlite-do@0.30.0`（2026-07-13）**不含** 2026-09 的三个 DO 事务修复（§3.3），而我们的核心持久层恰是 DO SQLite。**lane 指令未指定版本号，按本节结论应改为 `effect@4.0.0`（精确钉版，不用 ^）。** 尚无任何 `from "effect"` import（grep 核对，2026-10-03），采用成本当前为零。

---

## 2. effect core 在 Cloudflare Workers（workerd）上的兼容性（问题 2）

### 2.1 官方立场：无一等支持，但有持续维护

- v4 平台文档的运行时清单只有 Node.js、Deno、Bun、browsers 四类；platform 包对应 `@effect/platform-node`/`-bun`/`-browser`/`-deno`。**没有 Cloudflare Workers，没有 `@effect/platform-cloudflare`**（npm 404，2026-10-03 检索）。[来源：https://github.com/Effect-TS/website/blob/main/apps/web/src/content/docs/v4/platform/introduction.mdx ；https://www.npmjs.com/package/@effect/platform-cloudflare ]
- effect.website 无官方「Cloudflare Workers 指南」页；Workers 相关内容散见于 This Week in Effect 社区动态。[来源：site 检索 + https://effect.website/blog/this-week-in-effect/2026/07/17/ ]
- 但 v4 core 零运行时依赖、纯 web 标准接口，最小程序打包 7.1 kB gzip（3.x 为 35.6 kB）；MIGRATION.md 给的另一口径为 ~6.3 kB / 带 Schema ~15 kB。对 Workers 3 MB（付费 10 MB）gzip 包体上限与 400 ms 启动 CPU 预算，包体项完全不构成约束。[来源：https://effect.website/blog/releases/effect/40 ；https://github.com/Effect-TS/effect/blob/main/MIGRATION.md 「Performance and Bundle Size」节 ]

**判定：workerd 是「社区实证 + 维护者快速响应」的一等半支持，不是文档承诺。** 对我们的含义：不做「Effect 在 workerd 一定万无一失」的假设，把验证点写进 L1（vitest-pool-workers 本身就跑在 miniflare/workerd 上，天然覆盖）。

### 2.2 workerd 专项 issue 实证（全部一手，按主题归档）

| 主题                                                                                                                        | Issue                                                                                                               | 状态           | 与我们的距离                                                                                                                                                        |
| --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 全局作用域禁 `setTimeout`/`setImmediate` → Scheduler 加 microtask 回退（`Disallowed operation called within global scope`） | [#7930](https://github.com/Effect-TS/effect/issues/7930)                                                            | closed（已修） | 直接相关：Effect 的协作式让渡曾撞 workerd 全局 timer 禁令；修复后模块顶层运行受限 Effect 的坑已填。我们不在模块顶层跑 Effect（DO constructor/alarm 驱动），风险更低 |
| `Effect.fn` 每个定义点构造 Error，约 1,600 个定义吃满 Workers 400 ms 启动 CPU 预算（每个 19–256 µs）                        | [#8038](https://github.com/Effect-TS/effect/issues/8038)                                                            | closed（已修） | 相关：agent DO 事件类型 + 工具错误类型若全用 `Effect.fn`/`Data` 类，定义点数量在千级；v4 已修，但保持「错误类型定义集中、避免无谓 `Effect.fn` 包装」是好纪律        |
| Logger 用 `console.group` 在 workerd 不可用                                                                                 | [#5429](https://github.com/Effect-TS/effect/issues/5429)                                                            | closed（已修） | 低                                                                                                                                                                  |
| Web handler 冷启动优化（Cloudflare）                                                                                        | [#7927](https://github.com/Effect-TS/effect/issues/7927)                                                            | closed         | 我们走 DO 类 + fetch handler，不经 HttpApp web handler 主路径                                                                                                       |
| `HttpApp.toWebHandlerLayerWith` 首请求被 abort → layer 构建被 memoise，isolate 永久挂起（error 1101）                       | [#6319](https://github.com/Effect-TS/effect/issues/6319)                                                            | **open**       | 注意项：若 M1+ 用 HttpApi 在 worker 上做路由需复核此坑；M0 的 DO RPC 面不受影响                                                                                     |
| FetchHttpClient 响应流转 workerd known-length capability 丢失                                                               | [#8205](https://github.com/Effect-TS/effect/issues/8205)                                                            | **open**       | 直接相关：relay SSE 消费走 fetch 流；影响限于长度元信息（分块/进度语义），不影响 SSE 行解析。列入 relay 模块的验证点                                                |
| MCP 订阅 keepalive（Cloudflare Workers）                                                                                    | [#8651](https://github.com/Effect-TS/effect/issues/8651) / [#8653](https://github.com/Effect-TS/effect/issues/8653) | closed         | 低                                                                                                                                                                  |
| sql-pg/mysql2 prepared statement 名在 Hyperdrive/PgBouncer 后碰撞                                                           | [#8320](https://github.com/Effect-TS/effect/issues/8320) / [#6509](https://github.com/Effect-TS/effect/issues/6509) | closed         | 不走此路径（我们是 DO 内嵌 SQLite），列作旁证：CF 生态问题有人管、修得快                                                                                            |

时间分布显示 workerd 专项修复集中在 2025-08 → 2026-09（#7927/#7930/#8038/#8275 均为近 14 个月），维护活跃度与响应速度有据可查。**已知 open 项 2 个（#6319/#8205），都不在 M0 关键路径。**

### 2.3 定时器/微任务语义

workerd 没有 Node 的 `setTimeout` 语义全量保证（全局作用域禁用 + CPU 限预算），Effect 的 Clock/Scheduler 是自带的（不依赖宿主 timer 实现并发调度），#7930 的修复保证了「不能设 timer 时回退 microtask」。设计文档 §2.5 的 alarm 语义（DO alarm 是兜底、软截止、~1 分钟抖动）与 Effect 无关——**驱逐后 Fiber 全灭，任何进程内 timer/timeout 都不存活，恢复动词只能由 alarm + 重放驱动**。这一点与是否 Effect 无关，但必须写明：**Effect 的 `Effect.timeout`/`Stream.timeout` 只管「活着的时候」的软超时，跨驱逐的 watchdog 仍是 DO alarm。**

---

## 3. @effect/platform 的 Cloudflare 面子集（问题 3)

### 3.1 DO 基座：无 Effect 包装，用裸 API

`@effect/platform-cloudflare` 不存在（npm 404）；v4 无任何 DurableObject 基类/hibernation/alarm 包装。**DO 类壳（`extends DurableObject`、`setWebSocketAutoResponse`、hibernation WS、`ctx.storage.sql`、alarm）一律裸 Cloudflare API，Effect 只在类方法体内经 `ManagedRuntime.runPromise`/`Effect.runPromise` 驱动。** 这不是权宜——Effect 官方在 v3 就是这么写的（§3.2 的 Cloudflare adapter 源码即此模式），我们对齐即可。

### 3.2 事件溯源 + DO 的先例：v3 有、v4 拆了

- v3：`@effect/experimental/EventLogServer/Cloudflare` 提供抽象类 `EventLogDurableObject extends DurableObject`（from `"cloudflare:workers"`），hibernatable WS（`setHibernatableWebSocketEventTimeout(5000)`）、写入→ack→向其他 peer 广播 changes、分块重组。**这就是 Effect 官方的「事件日志跑在 DO 上」先例。** [来源：https://github.com/Effect-TS/effect/blob/effect%403.22.2/packages/experimental/src/EventLogServer/Cloudflare.ts ]
- v4：该 adapter **未移植**。MIGRATION 注记原文："The Cloudflare adapter was not ported; combine EventLogServerEncrypted.layer with a custom Durable Object RpcServer.Protocol adapter." [来源：https://github.com/Effect-TS/effect/blob/main/migration/annotations/effect__experimental__EventLogServer__Cloudflare.yaml ]
- v4 的 `effect/eventlog` 模块仍在（unstable），形状是：`EventLog`（typed 事件写入：handler 先跑、成功才 commit entry）、`EventJournal`/`SqlEventJournal`、`EventLogServer`（RPC 远端协议：hello/auth 挑战、分块写、changes 流）、加密身份（publicKey/Identity）。[来源：https://github.com/Effect-TS/effect/tree/main/packages/effect/src/eventlog ]
- **判定：不用。** 该模块面向多副本、多身份、端到端加密的同步场景（hello 挑战、publicKey、remote replica），比我们「每 thread 单写者、(threadId,seq) 唯一、冷启动重放」的日志重一个量级；且其 Cloudflare adapter 在 v4 缺位，等于拿 unstable 模块再自写 adapter——两头成本。我们的 FSM 直接用 Effect 原语 + `@effect/sql-sqlite-do`（或裸 storage.sql）实现，形状对照 unified-turn-state.md §1.1 不变。

### 3.3 `@effect/sql-sqlite-do`：DO SQLite 驱动，存在且刚修完关键事务语义

- 包存在且活跃：`0.1.0` → `0.30.0`（2026-07-13，v3 末）→ `4.0.0`（2026-10-01）。[来源：https://www.npmjs.com/package/@effect/sql-sqlite-do ]
- v4 源码实证（`SqliteClient.ts`，364 行，逐段核对）：`SqliteClient.make` 接受 `storage: DurableObjectStorage`（即 `ctx.storage`）或裸 `db: SqlStorage`（`ctx.storage.sql`）；返回 blob 转 `Uint8Array`；信号量串行化访问；**传 `storage` 时 `withTransaction` 走 DO 原生 `storage.transaction()`，不发出任何 BEGIN/COMMIT SQL**，嵌套事务复用连接并记 depth，全程包 `Scheduler.PreventSchedulerYield`（注释原文：storage 事务关闭 input gate，会阻塞 dispatcher 任务）；只传 `db` 时 `withTransaction` 显式 fail（"Transactions require Durable Object storage"）。[来源：https://github.com/Effect-TS/effect/blob/main/packages/sql/sqlite-do/src/SqliteClient.ts ]
- 修复时间线（`git log` 逐条）：2026-06-24 DO 事务改用 storage 原生（#2217）→ 2026-09-16 原生事务完成失败传播（#8257）→ 2026-09-17 嵌套 storage 事务（#8267）→ 2026-09-18 用 `Scheduler.PreventSchedulerYield` 修 fiber 自动让渡撞 input-gate 的死锁（#8291，含 miniflare 回归测试；PR 正文明确「transaction 内显式 `yieldNow`/`sleep`/`fetch` 仍不支持」）。**这三个 9 月修复只进了 4.0.0；v3 末版 0.30.0（07-13）不含。** [来源：https://github.com/Effect-TS/effect/pull/8291 ；packages/sql/sqlite-do/src/SqliteClient.ts 的 commit 历史 ]
- 历史背景：#6006（2026-01-28，**至今 open**）报告 v3 时代 `withTransaction` 发 BEGIN/COMMIT 被 workerd 禁止（DO SQLite 禁手工事务语句）。open 状态是「报告早于修复、未被回链关闭」，不影响上述 v4 实证，但引用时不得说「已 closed」。 [来源：https://github.com/Effect-TS/effect/issues/6006 ]
- 旁注：`@effect/sql-d1` 存在（Cloudflare D1 驱动），与 DO 内嵌 SQLite 是两条路，我们不用。[来源：https://github.com/Effect-TS/effect/tree/main/packages/sql/d1 ]

**对 #29 的直接含义**：事件日志追加层有两条合法实现——(a) `@effect/sql-sqlite-do@4.0.0` 的 `withTransaction`（拿到 storage.transaction + 嵌套 + 死锁防护）；(b) 裸 `ctx.storage.sql.exec` + `(threadId,seq)` UNIQUE 约束、冲突即拒绝（I1 的天然实现）。(b) 更无聊、更少依赖面；(a) 买到的是事务包裹多语句 append（`turn.input` + 首个副作用事件的原子性）。建议 M0 用 (b) 起步、需要多语句原子性时切 (a)——两者都在「不出包」边界内，可互换。

### 3.4 名近实非警示：`effect/workers`

v4 unstable 模块 `workers` 的内容是 `Worker`/`WorkerRunner`/`Transferable`——**Web Worker（多线程）runner，不是 Cloudflare Workers**。[来源：https://github.com/Effect-TS/effect/tree/main/packages/effect/src/workers ] 写进负面清单防误用。

---

## 4. 与本工单用法的贴合度（问题 4）

### 4.1 Stream：模型 SSE 消费 + 断点 A 封口

- Effect 的 Stream 提供结构化的流消费/转换/资源安全终止；fibers 的取消会沿 Stream 传播。官方文档 v4 有完整 stream 章节。[来源：https://github.com/Effect-TS/website/tree/main/apps/web/src/content/docs/v4/stream ]
- 对应我们设计：relay 出站流 = `fetch` 响应体 → Stream 解析 SSE → delta 合并批量（~100ms/2KB）→ 落盘 → 推送；`Stream.timeout` 表达 15 min 平台帽；取消 turn = interrupt 该流 fiber。**必须说清的边界：Effect 不提供「封口」语义**——封口（断点 A：`model.call_sealed`、绝不重调、单次计费）是 FSM 重放纪律（unified-turn-state.md §3.1），驱逐时 fiber 随 isolate 死亡，恢复由 alarm + 重放驱动。Effect 买到的是**活着的调用**的结构化消费与取消，不是断点恢复。
- 已知毛刺：#8205（open，workerd 流长度元信息丢失）——不影响 SSE 行解析，列入 relay 模块验证点（§2.2）。

### 4.2 Fiber：并行工具调用 + steer/cancel 中断

- 官方对 Fiber 的定义即「resource-safe cancellation capabilities」；`Effect.all`/`FiberSet` 表达 N 个并行工具调用；`Fiber.interrupt` 表达 cancel 的中止语义。[来源：https://github.com/Effect-TS/website/blob/main/apps/web/src/content/docs/v4/concurrency/fibers.mdx ]
- 对应设计：`model.call_completed` 含 N 个完整 tool_calls → N 个 `tool.call` 逐个落盘下发（§2.2）；取消 = 对每个非终态 executionId 发 `exec.kill` + 本地 fiber interrupt（§2.4）。**steer 与 Fiber 无关**——设计裁定 steer 是落盘事件、下次调用边界生效（§2.3），不做流中注入，这点不因 Effect 改变。
- 部分完成聚合（断点 H）：「等全部终态才发起下一次模型调用」在 Effect 里是 `Fiber` 句柄集合的 join，天然表达；手写等价物是 Promise 账本 + abort 传播，Effect 版少一层自管状态。
- 内存面（DO 有 128 MB 上限）：v4 fiber 运行时重写后 50,000 fibers 堆 21.8 MB（3.x 为 157.5 MB）。我们的并发是「每 turn 数十个 fiber」量级，两个版本都够用，v4 顺手移除了这个本来就不该碰的天花板问题。[来源：https://effect.website/blog/releases/effect/40 ]

### 4.3 typed errors：协议错误分类

- Effect 的错误通道是类型参数 `Effect<A, E, R>`，`Data.TaggedError` 给 discriminated union；`Exit`/`Cause` 建模终态（含 defect/中断的区分）。[来源：https://github.com/Effect-TS/website/tree/main/apps/web/src/content/docs/v4/error-management ]
- 对应设计：I12（每个 modelCallId 恰一个终态 ∈ {call_completed, call_sealed, call_failed}）与 §4.2 的错误政策（可重试 vs 不可重试 vs 封口）正好是一个 typed error union + exhaustive switch 的形状；`host_offline`、`outcome_unknown`、429/5xx 可重试的分类获得编译器强制。**注意协议错误本体（`packages/protocol/src/errors.ts`）不 Effect 化**——分类映射在 agent-do 内部完成，协议层保持冻结的零依赖形状。

### 4.4 事件溯源 FSM + DO 的先例盘点

| 先例                                                         | 性质                                                                            | 可抄什么                                                                          | 是否引依赖              |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ----------------------- |
| `@effect/experimental/EventLogServer/Cloudflare`（v3，官方） | 「Effect 事件日志跑在 DO」的完整源码先例                                        | Effect 在 DO 方法体内经 ManagedRuntime 驱动、WS 面保持裸 API、写入→ack→广播的顺序 | 否（v3 包，已停更该面） |
| `effect/eventlog`（v4 core unstable）                        | 多副本加密事件日志                                                              | handler 先跑成功才 commit 的语义（与我们「先落盘后副作用」同向）                  | 否（§3.2 判定不用）     |
| `effect-rpc-workers`（社区，TWIE 2026-07-17）                | 「production-ready example of integrating @effect/rpc with Cloudflare Workers」 | @effect/rpc + CF Workers 的工程拼装参考                                           | 否（参照）              |
| Effect Cluster sharding on DO（#7322，open issue）           | 社区诉求，未官方落地                                                            | 证明有人在做，不证明能用                                                          | 否                      |

[来源：https://effect.website/blog/this-week-in-effect/2026/07/17/ ；https://github.com/Effect-TS/effect/issues/7322 ]

### 4.5 `@effect/ai-openai-compat`：M0 不用，M1 复议

`@effect/ai-openai-compat@4.0.0` 官方描述："Connects the Effect AI modules to any OpenAI-compatible API, with support for chat completions and embeddings." [来源：https://github.com/Effect-TS/effect/tree/effect%404.0.0/packages/ai/openai-compat ] 它依赖 v4 core 的 `effect/ai`（`LanguageModel`/`Chat`/`Toolkit`）。**M0 不采纳**：#29 的 relay 客户端接口已裁定「经 provider 应用注入、mock 先行」，形状由冻结的 packages/protocol 决定；引入 `LanguageModel` 抽象 = 在我们的 FSM 之上再叠一层官方 agent loop 抽象（Toolkit/Chat 本身就是个小 FSM），双重状态机没有好处。M1 若要做结构化输出/工具协议升级可复议。**其对 relay mock 的 SSE 行为兼容性本次未实测——证据不足，若复议需先 spike。**

---

## 5. off-ramp 评估：Effect 渗透度由「不出包」约束控制（问题 5）

### 5.1 渗透控制点（边界即回退设计）

1. **`packages/protocol` 零 Effect 依赖**（现状即如此：dependencies 只有 zod，本仓库 `packages/protocol/package.json`）。事件 schema、错误分类的**协议形状**永远朴素。这是最硬的一条边界：协议是跨包冻结契约，Effect 化它 = 全仓库绑架。
2. **纯 reducer 不进 Effect**（I14 重放幂等本来就要求纯）：turn 状态迁移函数是 `(state, event) → state` 的普通函数，Effect 只包 IO 边界（落盘、推送、relay 调用）。这同时是可测性最好的切法。
3. **Effect 只允许出现在 agent-do 的实现模块**：relay 消费、turn 编排两处；DO 类壳、WS hibernation 接入、alarm 接线、R2 旁路保持裸 CF API。
4. **公共入口不泄漏**：`index.ts` 只导出朴素类型与函数；Effect 类型只出现在 `./testing` 入口（L1 测试需要构造 runtime，可接受）。app/ 与 agent-do 只通过 WS/HTTP 协议对话，天然隔离。
5. **依赖注入限幅**：Layer/Context 只用于 composition root（DO constructor 里装配一次），服务协作用普通函数参数传递。不用 Effect Schema 编事件（protocol 已冻结 + zod 已在场）。

### 5.2 一旦 Effect 化就难拆的结构（如实清单）

| 结构                               | 拆除成本                                                         | 说明                                   |
| ---------------------------------- | ---------------------------------------------------------------- | -------------------------------------- |
| Stream 管线（relay 消费）          | 中：重写为手写 async iterator + AbortController + 自管批处理缓冲 | 局部于 relay 模块                      |
| Fiber 并行 + interrupt（工具扇出） | 中：重写为 Promise 账本 + 手写取消传播                           | 局部于 turn 编排                       |
| Layer/Context DI 图                | **高**：依赖图整体重写为手工构造注入                             | 所以 §5.1-5 限幅是硬约束，不是风格偏好 |
| Effect Schema 编事件               | **高**：事件编解码全网重写                                       | 已被「protocol 零依赖」挡住            |

### 5.3 回退面结论

遵守 §5.1 时，回退 = 重写 2 个模块（relay 消费、turn 编排），事件层/协议层/DO 壳零迁移；违反边界（全 Layer 化、Schema 化协议）时，回退 = 重写 DO 内核。**「不出包」不是纯洁性洁癖，是把最坏情况回退面从「整个 DO」压到「两个模块」的保险丝。**

---

## 6. 最终建议：逐条对照 22 条不变量 + lane 指令修正点（问题 6）

### 6.1 模块级裁定

| 模块                                  | Effect？                 | 内容                                                                                |
| ------------------------------------- | ------------------------ | ----------------------------------------------------------------------------------- |
| agent DO · relay 消费                 | **是**                   | Stream（SSE 解析/合并批量/timeout 帽）、typed errors（重试分类）、退避重试（≤2）    |
| agent DO · turn 编排                  | **是**                   | Fiber 并行工具调用、interrupt（cancel/中止）、Fiber join（部分完成聚合）            |
| agent DO · 事件日志层                 | 朴素（可换 §3.3(b)→(a)） | 裸 storage.sql + UNIQUE，或 `@effect/sql-sqlite-do@4.0.0` 事务                      |
| agent DO · 纯 reducer                 | 朴素                     | I14 要求纯，天然朴素                                                                |
| agent DO · DO 壳/WS hibernation/alarm | 朴素                     | 裸 CF API；Effect 在方法体内驱动                                                    |
| agent DO · R2 旁路                    | 朴素                     | fetch/R2 binding 直用                                                               |
| daemon service DO                     | 朴素（M0）               | journal 逻辑为普通 SQL + 状态机；无流/并发甜点区                                    |
| daemon client                         | 朴素                     | 宿主机进程管理；引入 Effect 无收益                                                  |
| packages/protocol                     | 零 Effect                | 冻结契约，永久朴素                                                                  |
| 不用                                  | —                        | `effect/eventlog`、Effect Cluster、`@effect/ai`（M0）、`effect/workers`（名近实非） |

### 6.2 22 条不变量逐条对照（unified-turn-state.md §7）

**因 Effect 减少手写的（4 条）**：

- **I13（封口后静默）**：封口后 fiber 已 interrupt，delta 只能来自活 fiber——「封口即无输出」由流生命周期结构性保证，不需要每个消费点手写哨兵。
- **I12（模型尝试终态唯一）**：typed error union + `Exit` 使三个终态的互斥在类型层表达，exhaustive switch 由编译器查。
- **I10（取消边界）**：cancel_requested 后不再有新调用/下发 = 先落盘 cancel、再 interrupt fiber 组；Fiber 的取消传播替代手写 abort 账本。
- **I15 的活体部分**：`Effect.timeout` 表达 15 min 调用帽与单调用软超时（跨驱逐的 alarm 兜底与 Effect 无关，不变）。

**无差（18 条）**：I1（UNIQUE 约束）、I2/I8/I9（FSM 纯逻辑）、I3/I4（先落盘后副作用的顺序纪律）、I5（纯派生函数）、I6/I7（日志不变量，对重放断言）、I11（计费守恒，FSM 纪律）、I14（纯函数重放，本就不该 Effect 化）、I16/I17/I18/I19/I20/I21（跨 DO 协议与 journal 语义，Effect 不跨进程）、I22（宿主机进程核验，朴素代码）。这些不变量无一因 Effect 变难或变易——它们本来就是应用层纪律。

**净结论**：Effect 改善集中在「流 + 并发 + 错误」三处的**活体路径**；全部恢复语义（重放、封口、去重、收尸）依旧由设计文档的 FSM 纪律承担。**批准中的「Stream/Fiber/typed errors 设计级契合」成立，但范围应收窄为「活体路径的工效」，不得解读为「Effect 承担断点恢复」。**

### 6.3 lane 指令修正点（「Effect 允许、可混合、不出包」）

1. **版本必须显式化为 `effect@4.0.0`（精确钉版）**：当前 `packages/agent-do/package.json` 的 `"effect": "3.22.2"` 在 v4 发布后是上一代，且 v3 线 sqlite-do 缺 2026-09 的三个 DO 事务修复（§3.3）。不写版本的「Effect 允许」会让执行 agent 拿着 3.22.2 起步。
2. **「不出包」精确化为三条**：protocol 包零 Effect 依赖；agent-do `index.ts` 公共入口不导出 Effect 类型（`./testing` 入口豁免）；事件编解码不用 Effect Schema。
3. **补负面清单**：`effect/eventlog`、Effect Cluster、`@effect/ai`（M0）、`effect/workers`（Web Worker 而非 CF Workers）。不写下来，就会有 agent「顺手」采用。

### 6.4 证据不足清单（不装确定）

- **v3 线的 LTS 终止日期**：官方博客只承诺「每个 major 都有 LTS」并给出 4.x 细则，完整政策「follow-up post」尚未发布（截至 2026-10-03）。若停留在 3.x，支持窗口证据不足。
- **effect 4.0.0 在 workerd 的规模化生产案例**：issue 报告者众、社区项目（effect-rpc-workers 等）自述 production-ready，但无官方案例清单——方向性证据充分，规模证据不足。
- **`@effect/sql-sqlite-do@4.0.0` 事务在 L1（vitest-pool-workers、`--max-workers=1`）下的行为**：源码与 PR 测试（miniflare 回归）均positive，但未在本仓 L1 环境实测。列入实现工单的第一个 spike。
- **`effect/eventlog` v4 是否会重获 Cloudflare adapter**：MIGRATION 只说未移植，无 roadmap 证据。

---

## 附：证据索引（本次检索的全部一手来源）

| 主题                                             | 来源                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 版本时间线                                       | https://registry.npmjs.org/effect （time 字段）；https://github.com/Effect-TS/effect/releases/tag/effect@4.0.0                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| v4 迁移与版本模型                                | https://github.com/Effect-TS/effect/blob/main/MIGRATION.md                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| v4 发布公告（LTS/零依赖/包体/内存）              | https://effect.website/blog/releases/effect/40                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 过渡期版本断层                                   | https://registry.npmjs.org/@effect/platform （latest 0.97.2）；https://registry.npmjs.org/@effect/sql （0.52.1）                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| workerd 专项                                     | [#7930](https://github.com/Effect-TS/effect/issues/7930)、[#8038](https://github.com/Effect-TS/effect/issues/8038)、[#5429](https://github.com/Effect-TS/effect/issues/5429)、[#7927](https://github.com/Effect-TS/effect/issues/7927)、[#6319](https://github.com/Effect-TS/effect/issues/6319)（open）、[#8205](https://github.com/Effect-TS/effect/issues/8205)（open）、[#8651](https://github.com/Effect-TS/effect/issues/8651)、[#8320](https://github.com/Effect-TS/effect/issues/8320)、[#6509](https://github.com/Effect-TS/effect/issues/6509) |
| DO SQLite 驱动                                   | https://github.com/Effect-TS/effect/blob/main/packages/sql/sqlite-do/src/SqliteClient.ts ；[#6006](https://github.com/Effect-TS/effect/issues/6006)（open）；[#8291](https://github.com/Effect-TS/effect/pull/8291)；https://www.npmjs.com/package/@effect/sql-sqlite-do                                                                                                                                                                                                                                                                                 |
| DO + 事件日志先例                                | https://github.com/Effect-TS/effect/blob/effect%403.22.2/packages/experimental/src/EventLogServer/Cloudflare.ts ；https://github.com/Effect-TS/effect/blob/main/migration/annotations/effect__experimental__EventLogServer__Cloudflare.yaml ；https://github.com/Effect-TS/effect/tree/main/packages/effect/src/eventlog                                                                                                                                                                                                                                 |
| 社区先例                                         | https://effect.website/blog/this-week-in-effect/2026/07/17/ ；[#7322](https://github.com/Effect-TS/effect/issues/7322)                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| AI 兼容包                                        | https://github.com/Effect-TS/effect/tree/effect%404.0.0/packages/ai/openai-compat                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 文档（Stream/Fiber/typed errors/平台运行时清单） | https://github.com/Effect-TS/website/tree/main/apps/web/src/content/docs/v4/stream ；…/v4/concurrency/fibers.mdx ；…/v4/platform/introduction.mdx                                                                                                                                                                                                                                                                                                                                                                                                        |
| 本仓库现状                                       | `packages/agent-do/package.json`（effect 3.22.2 钉版、无 import）；`packages/protocol/package.json`（零 Effect 依赖）                                                                                                                                                                                                                                                                                                                                                                                                                                    |

> AGENT GENERATED: by zhipu-coding-plan/glm-5.3-flash (research subagent)
