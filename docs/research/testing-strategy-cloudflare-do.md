# 测试策略研究：Cloudflare Workers + Durable Objects（M0 前置）

> 回答 #14（M1 可用性硬化）前置问题：M0 行走骨架怎么测。研究对象为 Cloudflare 官方测试栈与官方文档描述的本地/生产语义差异；结论是对 M0 的明确分层建议。写作日期 2026-10-03，引用以当日文档为准。

## 0. 结论先行

**推荐方案 C：官方栈为主（`@cloudflare/vitest-plugin`，即 `@cloudflare/vitest-pool-workers` 的后继包）+ 少量部署后协议面验收 + 故障注入只在真实 staging 做。** 理由与分层见 [§6](#6-结论m0-测试分层建议)。

## 1. 官方测试栈：能力与边界

### 1.1 包名现状：vitest-pool-workers → vitest-plugin

`@cloudflare/vitest-pool-workers` 已被 `@cloudflare/vitest-plugin` 取代（Vitest 4.1+；官方提供 codemod `npx @cloudflare/codemods vitest:pool-workers-to-vitest-plugin`，"The package API and Vitest configuration are unchanged"）。本文统一称「Vitest 集成」，引用现行文档。

来源：[Migrate to Vitest plugin](https://developers.cloudflare.com/workers/testing/vitest-integration/migration-guides/migrate-to-vitest-plugin/)、[Write your first test](https://developers.cloudflare.com/workers/testing/vitest-integration/write-your-first-test/)（`npm i -D vitest@^4.1.0 @cloudflare/vitest-plugin`）

### 1.2 运行模型

Vitest 集成把测试跑在 workerd（生产同款运行时）里、经 Miniflare 全本地运行：每个测试文件一套独立存储环境（"Each test file gets its own storage environment"），默认并发跑测试文件；需要共享存储时用 `--max-workers=1 --no-isolate`。插件自动注入 `nodejs_compat` 等兼容 flag——官方明确警告这可能让测试里的 Worker 行为与部署后不同（`process` 等 Node 全局在测试里可用、生产不可用）。

来源：[Isolation and concurrency](https://developers.cloudflare.com/workers/testing/vitest-integration/isolation-and-concurrency/)（隔离模型、`--max-workers=1 --no-isolate`、nodejs_compat 警告）、[Local development](https://developers.cloudflare.com/workers/local-development/)（"same runtime used in production, workerd"）

### 1.3 能力矩阵（对照本项目需要的点）

| 能力                                   | 支持情况                                                                                                                                                                                              | 官方依据                                                                                                                                                                                                                                                                      |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Durable Objects（含 SQLite-backed）    | 支持。直接从 `env` 拿 stub、RPC 调用；`runInDurableObject(stub, cb)` 进 DO 内部断言实例与 `state.storage.sql`；官方示例即 SQLite Counter（`new_sqlite_classes` 迁移照常配）                           | [Testing Durable Objects](https://developers.cloudflare.com/durable-objects/examples/testing-with-durable-objects/)                                                                                                                                                           |
| Alarms                                 | 支持。`runDurableObjectAlarm(stub)` 立即执行并移除已调度的 alarm，不等定时器                                                                                                                          | [Test APIs](https://developers.cloudflare.com/workers/testing/vitest-integration/test-apis/)、[Testing Durable Objects](https://developers.cloudflare.com/durable-objects/examples/testing-with-durable-objects/)                                                             |
| 驱逐/重启语义                          | 支持。`evictDurableObject(stub)`（默认等在飞请求最多 30s）、`evictAllDurableObjects()`、`abortAllDurableObjects()`（硬杀不留内存态）；官方示例演示「内存态清零、SQLite 存活」                         | [Test APIs](https://developers.cloudflare.com/workers/testing/vitest-integration/test-apis/)、[Testing Durable Objects](https://developers.cloudflare.com/durable-objects/examples/testing-with-durable-objects/)                                                             |
| WebSocket 服务端（含 hibernation API） | 支持，**但有已知限制**：DO + WebSocket 与按文件存储隔离不兼容，需 `--max-workers=1 --no-isolate` 共享存储。官方示例演示 hibernatable WS 跨 `evictDurableObject` 存活/被关（`{ webSockets: "hibernate" | "close" }`）                                                                                                                                                                                                                                                                  | [Known issues](https://developers.cloudflare.com/workers/testing/vitest-integration/known-issues/)、[Testing Durable Objects §Testing WebSocket behavior across eviction](https://developers.cloudflare.com/durable-objects/examples/testing-with-durable-objects/) |
| 出站请求 mock（HTTP + WebSocket）      | 支持，用 `@msw/cloudflare`（MSW ≥2.14）；出站 WS 用 MSW `ws.link()`，实现方式是 patch `WebSocket` 全局                                                                                                | [Mock outbound requests](https://developers.cloudflare.com/workers/testing/vitest-integration/mock-outbound-requests/)、[request-mocking fixture](https://github.com/cloudflare/workers-sdk/blob/main/fixtures/vitest-plugin-examples/request-mocking/test/websocket.test.ts) |
| 集成测试入口                           | `exports.default.fetch(request)` 调主 Worker 的真实 handler；`exports` **不含 Assets**，测静态资源要用 `startDevWorker()`。DO 测试要求 `main` 配置（wrangler configPath 即可）                        | [Test APIs](https://developers.cloudflare.com/workers/testing/vitest-integration/test-apis/)、[Write your first test](https://developers.cloudflare.com/workers/testing/vitest-integration/write-your-first-test/)                                                            |
| 代码覆盖率                             | 仅 Istanbul（插桩），不支持 V8 原生覆盖率                                                                                                                                                             | [Known issues](https://developers.cloudflare.com/workers/testing/vitest-integration/known-issues/)                                                                                                                                                                            |
| Fake timers                            | 不作用于 KV/R2/cache 模拟器（不能靠推进假时间过期 KV）                                                                                                                                                | [Known issues](https://developers.cloudflare.com/workers/testing/vitest-integration/known-issues/)                                                                                                                                                                            |
| 动态 `import()`                        | 在 `exports.default.fetch()` 集成模式与 DO 事件 handler 内不可用，需静态 import                                                                                                                       | [Known issues](https://developers.cloudflare.com/workers/testing/vitest-integration/known-issues/)                                                                                                                                                                            |

### 1.4 官方推荐的测试结构

官方把测试分两层：**单元测试用 Vitest 集成**（跑在 workerd 里、直接断言绑定状态与 DO），**集成测试用 Wrangler 的 `createTestHarness()`**（跑生产构建产物、可用任意 Node 测试框架、配 MSW/Playwright）。文档原话："For most projects, use the Workers Vitest integration for unit tests and the `createTestHarness()` API for integration tests."

来源：[Testing 总览](https://developers.cloudflare.com/workers/testing/)、[Integration test harness](https://developers.cloudflare.com/workers/testing/test-harness/)

### 1.5 workers-sdk 仓库的实践组织

Cloudflare 自己按「能力域」组织示例/测试：[`fixtures/vitest-plugin-examples/`](https://github.com/cloudflare/workers-sdk/tree/main/fixtures/vitest-plugin-examples) 下有 `durable-objects`（直接访问 DO）、`request-mocking`（HTTP + WS mock）、`rpc`、`d1`、`queues` 等独立 fixture，每个都是独立 Vitest 工程。其自身 CI（GitHub Actions `ubuntu-latest`）日常跑这套 Vitest 测试：[`test-and-check.yml`](https://github.com/cloudflare/workers-sdk/blob/main/.github/workflows/test-and-check.yml)。这说明两点：官方栈在 GitHub Actions 上是一等公民；「直接拿 stub 测 DO」与「`exports.default.fetch()` 打协议面」两种写法官方都在用，不是二选一。

## 2. 本地（miniflare/vitest）与生产的语义差异

官方文档明说的差异清单，按本项目相关度排列：

| 行为                | 生产语义                                                                                                                                          | 本地测试语义                                                                                                            | 来源                                                                                                                                                                                            |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 驱逐时机            | 无请求后 hibernateable 态 ~10s 进 hibernation；非 hibernateable 态 70–140s 后整体驱逐；挂起 I/O（含出站 WS/TCP 连接）阻止驱逐，每个操作最长 15min | 时机不由测试复现，用 `evictDurableObject()` 显式、确定性地注入驱逐；文档未明确本地 workerd 是否按生产同款时间表自动驱逐 | [Lifecycle](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/)、[Test APIs](https://developers.cloudflare.com/workers/testing/vitest-integration/test-apis/) |
| 全局唯一性          | 全球单实例；唯一性在收事件/访问存储时强制，网络分区或软件更新时实例可能被替换                                                                     | 单 workerd 进程内天然唯一，跨地域分裂无法在本地出现；「事件不碰存储期间被替换」这一类 bug 本地测不到                    | [DO Known issues](https://developers.cloudflare.com/durable-objects/platform/known-issues/)                                                                                                     |
| 代码更新            | 全球最终一致传播；请求可能打到新 Worker + 旧 DO 代码（典型数秒到数分钟）；DO 关停时在飞 HTTP 存储访问立即报错、WS 连接被终止交给新实例            | 本地无此传播窗口；文档未明确本地如何模拟双版本并存                                                                      | [DO Known issues](https://developers.cloudflare.com/durable-objects/platform/known-issues/)、[Lifecycle](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/)  |
| WS hibernation      | 客户端连接保持在 CF 网络边缘，DO 出内存；`serializeAttachment` 恢复每连接状态                                                                     | hibernation 行为可测（`evictDurableObject` + hibernatable WS），但连接真挂在 CF 边缘的拓扑是生产才有                    | [WebSockets best practices](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)                                                                                       |
| 账户级限制          | 出站连接 6 个/请求；SQLite DO 上限 10GB（Paid）/1GB（Free），写满报 `SQLITE_FULL`；CPU 30s/请求                                                   | 本地模拟不强制账户配额；文档未明确本地限额数值                                                                          | [DO Limits](https://developers.cloudflare.com/durable-objects/platform/limits/)                                                                                                                 |
| nodejs_compat       | 配置里没有 flag 就不可用，未声明地用 `process` 等会部署失败或生产报错                                                                             | 测试插件自动注入 `nodejs_compat`，测试可能全绿但部署挂                                                                  | [Isolation and concurrency](https://developers.cloudflare.com/workers/testing/vitest-integration/isolation-and-concurrency/)                                                                    |
| `wrangler dev` 特有 | —                                                                                                                                                 | DO 存储只读线上、写入留在内存（除非显式 `script_name`）；编辑代码热重载后 DO alarm 可能失效，官方建议改完重启 dev       | [DO Known issues](https://developers.cloudflare.com/durable-objects/platform/known-issues/)                                                                                                     |
| `wrangler tail`     | —                                                                                                                                                 | WebSocket 请求的日志延迟到连接关闭才吐出                                                                                | [DO Known issues](https://developers.cloudflare.com/durable-objects/platform/known-issues/)                                                                                                     |

一条方法论注记：官方在 lifecycle 页明确「没有 shutdown hooks，靠增量写存储恢复」，这类崩溃恢复语义正是 `evictDurableObject`/`abortAllDurableObjects` 存在的目的——**生产随机驱逐在测试里被替换为确定性驱逐注入**，这是官方认可的模式。

## 3. DO 的官方测试模式

官方文档给出两种互补写法（同一页示范）：

1. **进程内直接驱动（单元向）**：测试代码里 `env.NAMESPACE.idFromName(...)` → `.get(id)` 拿 stub → 直接 RPC 调 DO 方法；要看内部/私有方法/SQLite 就 `runInDurableObject(stub, (instance, state) => …)`。适合断言事件日志存储格式、序列号推进、alarm handler 行为。
2. **HTTP 驱动（集成向）**：`exports.default.fetch(new Request(...))` 走 Worker 真实路由 → Worker 内部再 stub 到 DO。适合断言协议面：状态码、鉴权、路由到正确的 DO。

不存在的第三种是「new ThreadDO() 裸实例化」：官方路径都经 stub（全局唯一性、存储、事件上下文都由运行时提供），裸构造绕过运行时没有官方背书，也不必要。workers-sdk 的 fixture 也全是 stub/exports 驱动（见 §1.5）。

来源：[Testing Durable Objects](https://developers.cloudflare.com/durable-objects/examples/testing-with-durable-objects/)、[Write your first test](https://developers.cloudflare.com/workers/testing/vitest-integration/write-your-first-test/)

## 4. 套到本项目形状：ThreadDO + GatewayDO + SPA

本项目拓扑（ROADMAP 不变式）：ThreadDO（LLM loop + append-only 事件日志存 DO SQLite，`(threadId, seq)` 唯一）；GatewayDO（每台机器一只，**服务端**接 daemon 外拨的 WS 长连 + Bearer）；SPA 同源部署；DO 永不外拨。

### 4.1 GatewayDO 的 WS 长连能不能在 vitest 里模拟？

拆成两侧看：

- **服务端（GatewayDO accept + Bearer 鉴权 + 消息路由 + hibernation）**：可以真实跑。官方 fixture 就是同构的 `WebSocketServer` DO：`stub.fetch(url, { headers: { Upgrade: "websocket" } })` 升级、`ctx.acceptWebSocket()` + `webSocketMessage`/`webSocketClose` handler、再叠 `evictDurableObject({ webSockets: "hibernate" | "close" })` 测连接跨驱逐存活。Bearer 校验只是升级请求的 header 断言，天然在覆盖范围内。唯一坑：**这套必须共享存储跑**（`--max-workers=1 --no-isolate`），否则撞已知限制。
- **客户端（真实 daemon 进程）**：模拟不了。Vitest 集成里主 Worker 不暴露网络端口（`exports` 连 Assets 都不含，官方要真服务器让用 `startDevWorker()`），测试进程外没有可连的 URL；daemon 是跑在用户机器上的独立进程，本来也不是 Worker 代码。**真实 daemon ↔ GatewayDO 的握手、断线重连、长连稳定性只能在部署后的环境测**（`wrangler dev` 起真端口，或 preview/staging 部署）。

### 4.2 ThreadDO 的 LLM loop

出站 LLM API 用 `@msw/cloudflare` 的 `http.*` handler mock（官方支持单元/`exports.default.fetch()` 集成两种模式）。loop 的崩溃恢复语义（事件已持久、turn 进行中被杀）用 `evictDurableObject`/`abortAllDurableObjects` 注入后重放断言。注意文档未明确 MSW 是否拦截 **DO 内部**发起的出站 WS（官方只声明 worker handler 与 `exports.default.fetch()` 路径；`ws.link` 实现是 patch `WebSocket` 全局，同进程内 DO 理论上被覆盖）——但本项目不变式是 DO 永不外拨，此缺口用不到；若未来破坏不变式，这一点要重新核实。

### 4.3 SPA 静态资源

`exports` 不含 Assets，Vitest 集成测不了同源静态资源的服务行为（官方指向 `startDevWorker()`）。M0 的 SPA 是最小合同面，不值得为此上 Vite 测试栈：协议面验收放到部署后层，浏览器内交互留给双设备演示。

### 4.4 坑清单（写测试前要知道）

1. DO + WS 测试必须 `--max-workers=1 --no-isolate`（[Known issues](https://developers.cloudflare.com/workers/testing/vitest-integration/known-issues/)）。
2. 测试自动注入 `nodejs_compat`——主 wrangler config 里要么显式写上，要么保证代码不用 Node API，否则「测试绿、部署红」（[Isolation and concurrency](https://developers.cloudflare.com/workers/testing/vitest-integration/isolation-and-concurrency/) 官方警告场景）。
3. 所有存储操作必须 await、响应体必须消费完，否则按文件隔离的清理会出诡异竞态（[Known issues](https://developers.cloudflare.com/workers/testing/vitest-integration/known-issues/) 官方建议清单）。
4. 集成模式/DO handler 里禁动态 `import()`（同上）。
5. fake timers 不影响 KV/R2/cache 模拟器；DO 的 alarm 不靠等待，用 `runDurableObjectAlarm`（[Test APIs](https://developers.cloudflare.com/workers/testing/vitest-integration/test-apis/)）。

## 5. CI（GitHub Actions）怎么跑

- **Vitest 层零特殊配置**：全本地 workerd，GitHub Actions `ubuntu-latest` 直接 `npx vitest`；Cloudflare 自己的 workers-sdk 就这么跑（[test-and-check.yml](https://github.com/cloudflare/workers-sdk/blob/main/.github/workflows/test-and-check.yml)）。
- **部署验收层**：CI 里用 `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` secrets（[官方 GitHub Actions 指南](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/)），二选一：
  - `wrangler preview`：为分支/PR 建 Preview 部署（分支名默认，可打 tag/写 message），不影响其他分支；
  - `wrangler versions upload`：上传不立即部署的版本，`--preview-alias` 给版本起别名，后续 `wrangler versions deploy` 可做渐进放量。

  来源：[Wrangler commands](https://developers.cloudflare.com/workers/wrangler/commands/workers/)（`preview`、`versions upload`/`versions deploy` 条目）

- 部署后的**协议面验收**（HTTP 状态/鉴权/WS 握手）官方没有提供专门框架，用普通脚本（curl / Node ws 客户端）打 preview URL 即可；M0 规模够用。
- M0 阶段建议只做「vitest 必绿 + push 后 staging 自动部署 + 冒烟脚本」；版本渐进放量是 M1 之后的选项。

## 6. 结论：M0 测试分层建议

### 推荐方案 C（= 官方栈 B + 真实 staging 故障注入）

逐条理由：

1. **官方栈覆盖的恰是本项目最要命的不变式**：append-only 事件日志的 SQLite 断言、seq 推进、alarm 重试、崩溃后重放——`runInDurableObject` + `evictDurableObject` + `runDurableObjectAlarm` 全部确定性可达，且跑在生产同款 workerd 里。方案 A（纯对外黑盒）测不到这些内部不变式，方案 C 不引入新栈（vitest-plugin 本来就是官方推荐位）。
2. **WS 长连按侧拆**：GatewayDO 服务端语义（accept/Bearer/路由/hibernation 跨驱逐）在 vitest 里全真模拟；daemon 客户端侧只留一个薄集成点（部署后用真 daemon 打 preview/staging），不试图在单测里伪造传输层。
3. **故障注入只在 staging**：驱逐时机、全球唯一性、代码更新传播、账户限额都是生产语义（§2），本地模拟注定失真；M0 就把「杀 daemon、重部署触发 DO 回收、断网重连」做成 staging 手册脚本（对照 ROADMAP M1 的故障注入验收，M0 先跑通最小说明），M1 再自动化。
4. **CI 成本最低**：vitest 层零凭证零部署；staging 层一个 wrangler preview + 冒烟脚本；双设备演示保持手工（这正是 M0 的验收形态）。

### 分层覆盖表

| 层                                    | 工具/环境                                                                                             | 覆盖什么                                                                                                                                                                                                 | 不覆盖什么                                                                                       | 触发                           |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------ |
| L1 单元+集成（in-workerd）            | `@cloudflare/vitest-plugin` + `@msw/cloudflare`；WS/hibernation 套件用 `--max-workers=1 --no-isolate` | ThreadDO 事件日志 SQLite 断言、seq 唯一/推进、alarm handler、崩溃重放（evict/abort 注入）、GatewayDO accept/Bearer/路由/hibernation 语义（测试内模拟 daemon 客户端）、LLM API mock、Worker HTTP 协议逻辑 | 真实 daemon 进程、真网络/TLS、生产驱逐时机、全球唯一性、代码更新传播、账户限额、SPA 静态资源服务 | 每次推送，CI 必跑              |
| L2 部署后协议面                       | `wrangler preview`（或 staging Worker）+ curl/Node ws 冒烟脚本                                        | 真部署产物、真 daemon ↔ GatewayDO 握手与鉴权、SPA 同源可打开、基础冒烟（建 thread→发消息→读日志）                                                                                                        | 多区域行为、限额边界、故障恢复                                                                   | push 后自动；daemon 联调时手动 |
| L3 真实 staging 故障注入 + 双设备演示 | staging 部署 + 手册脚本                                                                               | 杀 daemon 重连、重部署触发 DO 回收后长连恢复、断网重连、换设备续聊（M0/S3 验收）                                                                                                                         | 无（这是唯一真实语义层）；代价是不可回归自动化                                                   | M0 验收节点；M1 转自动化       |

### 不推荐项

- 方案 A（纯对外黑盒）：丢失 DO 内部不变式断言能力，LLM loop 的崩溃恢复几乎不可测；被官方栈替代无收益。
- 在 vitest 里伪造「daemon 掉线/断网」：传输层行为本地失真（§2），写出来是假安心，归 L3。

> AGENT GENERATED: by zhipu-coding-plan/glm-5.3-flash (research subagent)
