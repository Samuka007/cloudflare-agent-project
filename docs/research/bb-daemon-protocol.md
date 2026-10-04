# bb daemon 协议考古（#21 前置研究）

研究对象：`/home/nixos/workspace/bb`（独立 git 仓，只读），HEAD = `8473d8c33`（Add pinned OMP compatibility smoke）。本文所有行号以该提交为准；bb 上游前进后行号会漂移，但结构结论稳定。

目的：为 #21（GatewayDO + 出站 daemon + bash 工具）提供 bb 侧协议事实，逐条给证据。问题清单来自 #21/契约票；映射建议见 §7（仅陈述，不做设计决定）。

---

## 1. 进程形状：host-daemon 与 provider-bridge

### 1.1 host-daemon（Node 常驻进程）

- 入口 `apps/host-daemon/src/start-host-daemon.ts` → `daemon.ts` 组装：单实例锁（`lock.ts`）、host 身份（`identity.ts`）、与 server 的 `ServerConnection`、命令路由 `CommandRouter`。
- 身份文件持久化在 dataDir：`host-id` 与 `auth.json`（`packages/host-daemon-contract/src/local-state.ts:4-5`；写入见 `apps/host-daemon/src/identity.ts:33-70`）。首次启动走 enroll 换取长期 hostKey（§6）。
- 与 server 两条信道：
  1. **HTTP `/internal/*`**（事件批量上报、会话打开、服务端工具回调、交互请求），客户端实现 `apps/host-daemon/src/server-client.ts:304-584`；
  2. **WS `/internal/ws`**（服务端下行命令、心跳、终端流），实现 `apps/host-daemon/src/server-connection.ts`。
- 工具命令执行在 `apps/host-daemon/src/command-router.ts:130-222`：按 environmentId 划读写Lane（`envLane`，`packages/host-daemon-contract/src/commands.ts:1586`、`2311-2315`）、按 provider 进程/会话/线程分层串行，处理器映射表在 `command-dispatch.ts:358-843`。
- 事件外发经 `event-sink.ts`：内存队列 + 100ms 防抖批量 POST；队列只在内存，daemon 崩溃丢弃未上报事件是明示的取舍（`apps/host-daemon/src/event-sink.ts:11`、`244-247`）。

### 1.2 provider-bridge（OMP bridge，stdio JSONL 子进程）

bb 的「provider 桥」是一个独立 Node 进程，bb 主进程经 stdio 与它说 **JSON-RPC 2.0**（每行一帧）：

- 文件：`packages/agent-runtime/src/omp/bridge/bridge.ts`，头注即协议说明：「BB speaks JSON-RPC to this process. Each BB thread owns one `omp --mode rpc` child」（`bridge.ts:3-9`）。
- bridge 内部再为每条 thread spawn 一个 `omp --mode rpc --cwd … --no-title` 子进程（`bridge.ts:549-560`、`1022-1035`），把 omp 原生的 type-discriminated JSONL 帧规范化为 JSON-RPC。
- **宿主 → bridge 的请求方法**（`bridge.ts:1692-1827`）：
  - `initialize` → 回 `{ ok: true, protocolVersion: 1 }`（`bridge.ts:1696-1700`）
  - `model/list`（params: `{ cwd? }`）
  - `thread/start`（params 含 threadId、cwd、model、permissionMode 等）→ 回 `{ threadId, providerThreadId, sessionRestorable }`，随后推 `thread/identity` 通知（`bridge.ts:1706-1718`）
  - `thread/resume`（可携带 `ompRecovery` 恢复描述符；无描述符且会话不匹配则显式报错，`bridge.ts:1720-1763`）
  - `turn/start`（输入为 promptInput 数组，bridge 提取文本+图片后向 omp 发 `{type:"prompt"}`；`agentInvoked:false` 时直接结算 `omp/prompt/settled` 通知，`bridge.ts:1765-1792`）
  - `turn/steer`（向活跃 turn 注入 `{type:"steer"}`，`bridge.ts:1794-1807`）
  - `thread/stop`（`{type:"abort"}` 后关闭会话，`bridge.ts:1809-1818`）
  - 未支持方法回 JSON-RPC 错误 `-32601`（`bridge.ts:1820-1825`）。
- **bridge → 宿主的出向消息**：JSON-RPC response（按 id 结算）+ notification：`sdk/message`（透传 omp 原生帧，`{ threadId, message }`，`bridge.ts:1356-1359`）、`thread/identity`、`omp/prompt/settled`。
- omp 子进程侧自己的 RPC 帧也有形状约束：ready 帧 `{type:"ready", protocolVersion:1, supportedProtocolVersions, maxFrameBytes}`（`bridge.ts:186-194`），v2 协商 `negotiate_protocol`（`bridge.ts:791-847`），大帧分片 `rpc_chunk`（每片 ≤256KiB、重组上限 64MiB，`bridge.ts:179-184`、`408-508`）。
- 超时：`OMP_RPC_STARTUP_TIMEOUT_MS = 30_000`（协议协商）、`OMP_RPC_REQUEST_TIMEOUT_MS = 30_000`（单请求，`bridge.ts:331-332`）。

> 对 #21 的直接含义：bb 的「daemon 内部」分两层——daemon ↔ server 是自研 WS JSON 协议（§2/§4），daemon 内部跑 provider 用的是 stdio JSON-RPC 桥。我们的 Node shim 可以照这个分层：WS 面对边缘，bash 工具在 daemon 进程内直接执行（不需要第三层）。

---

## 2. WS/隧道层：daemon 如何连 edge

### 2.1 控制面 WS（daemon ↔ bb server）

- **建立顺序**：先 HTTP 打开会话，再开 WS 附着。
  1. `POST /internal/session/open`（Bearer hostKey），请求体 `hostDaemonSessionOpenRequestSchema`：`{ hostId, instanceId, hostName, hostType, connectMachineId?, hasMachineCredential, platform, dataDir, protocolVersion, activeThreads, loadedEnvironments }`（`packages/host-daemon-contract/src/session.ts:97-111`）。
  2. 响应 201 `hostDaemonSessionOpenResponseSchema`：`{ sessionId, heartbeatIntervalMs, leaseTimeoutMs, watchSet, connectShares, retiredEnvironmentIds }`（`session.ts:158-174`；服务端实现 `apps/server/src/internal/session.ts:42-147`）。
  3. WS URL：`{serverUrl http(s)→ws(s)}/internal/ws?sessionId=<sessionId>`（`apps/host-daemon/src/server-connection.ts:799-805`）。
- **握手要求**：`authorization: Bearer <hostKey>` 头 + `Sec-WebSocket-Protocol: bb-host-daemon.v1`（常量 `session.ts:33`，构造 `session.ts:887-895`；daemon 侧装配 `server-connection.ts:452-464`）。服务端升级校验三件套：protocol 头匹配、Bearer 验证、sessionId 属于该 host 的 open 会话（`apps/server/src/ws/daemon-protocol.ts:35-68`）。校验失败/消息不合法 → close 1008（`daemon-protocol.ts:113-121`、`205`、`217`）。
- **心跳与租约**：daemon 按 server 下发的 `heartbeatIntervalMs`（默认 5s，`apps/server/src/constants.ts:2`）发 `{"type":"heartbeat"}`（`server-connection.ts:745-777`）；server 每收到任意合法 WS 消息就把 lease 续到 `max(now+leaseTimeoutMs, 旧到期+1)`（`daemon-protocol.ts:129-136`；`LEASE_TIMEOUT_MS=30s`，`constants.ts:3`）。会话过期/被顶替时 server 发 `{"type":"session-close","reason":"replaced|expired|daemon-disconnect"}`（`session.ts:337-341`、`587-593`），daemon 收到后清会话并以 1s 代码重连（`server-connection.ts:690-701`）。
- **重连**：partysocket `ReconnectingWebSocket`，`maxRetries: Infinity`，退避 1s 起、×2 增长、30s 封顶（`server-connection.ts:447-464`；常量 `apps/host-daemon/src/server-connection-support.ts:104-109`）。断线期间可恢复消息按 key 去重缓存、重连后重放（`server-connection.ts:80-101`）。
- 协议版本不匹配时的自愈：open 收到 400 `protocol_version_mismatch` 后 daemon 触发自更新（§3），期间停止重连风暴（`server-connection.ts:372-411`）。

### 2.2 数据面隧道（TunnelDO，visitor ↔ 内网 origin）——GatewayDO 的参考实现

bb 的 Cloudflare 侧在 `apps/connect`（Worker + Durable Object），#21 的 GatewayDO 可参考两条不同用途的先例：

**A. TunnelDO（`apps/connect/src/tunnel-do.ts`）——HTTP/WS 反向隧道（二进制帧协议）**

- 帧协议定义在 `packages/tunnel-contract/src/index.ts:1-30`：每条二进制 WS 消息一帧 `[type:u8][streamId:u32 BE][payload]`；**文本消息保留给心跳** `bbt:hb` / `bbt:hb-ack`，靠 DO 的 `setWebSocketAutoResponse` 在不唤醒实例的情况下应答（`tunnel-do.ts:120-122`）。帧类型：`open-http` / `body-chunk` / `body-end` / `resp-head` / `open-ws` / `ws-open-ack` / `ws-data` / `close-stream`（`tunnel-contract/src/index.ts:46-133`）。`PROTOCOL_VERSION = 1`，dial 时 `?v=` 上报，缺省按 0（旧客户端）处理（`tunnel-contract/src/index.ts:17-23`；解析 `tunnel-do.ts:71-77`）。
- 会话生命周期（`tunnel-do.ts`）：
  - **一只 DO = 一个路由标签**（`tunnel-do.ts:91-98`）。tunnel 客户端 dial `wss://<label>.<baseDomain>/__tunnel?v=1`（`apps/host-daemon/src/connect-tunnel/index.ts:90-100`），URL 由 enrollment URL 推导 base domain（`connect-tunnel/index.ts:67-88`）。
  - `acceptTunnel`：单隧道语义，新连接顶替旧 socket（close 1000 "replaced"），废弃旧连接的在途流并显式失败（502/close 1001），协议版本与身份落 storage 以在 hibernation 后恢复（`tunnel-do.ts:267-305`、`109-133`）。
  - visitor 请求进来：无隧道 → 503 + `x-bb-tunnel-offline` 头（`tunnel-do.ts:216-227`）；HTTP → 分配 streamId、发 `open-http`，等待 `resp-head`（30s 超时 504，`tunnel-do.ts:26`、`355-405`）；WS upgrade → 发 `open-ws` 后以 `visitor:<streamId>` tag 接受 hibernation socket（`tunnel-do.ts:307-353`）。
  - 流 id 断电恢复：构造时扫描现存 visitor socket 的 attachment 取 max+1，防复用（`tunnel-do.ts:109-119`）。
  - 撤销通道：`/__control/close` 经跨脚本 DO binding 立即掐断隧道（`tunnel-do.ts:156-164`）。
  - presence：alarm 每 50s 更新 last_seen_at，隧道没了就清 storage（`tunnel-do.ts:29-30`、`254-265`）。
- 客户端侧重连退避：1s 起 ×2 封顶 30s，稳定连接 >10s 后重置 attempt（`packages/tunnel-client/src/reconnect.ts:1-49`）；心跳 20s 间隔、60s 判死（`packages/tunnel-client/src/session.ts:24-25`）。

**B. bb server 的 `/internal/ws` + NotificationHub——daemon 控制面（文本 JSON）**

server（Node，非 DO）侧：升级后 `hub.registerDaemon(sessionId, hostId, socket)`（`daemon-protocol.ts:91`），server→daemon 命令即经 hub 找到该 host 的 session socket 发 `host-rpc.request`（`apps/server/src/ws/hub.ts:636-668`）。这是与 #21 GatewayDO 语义最接近的先例（见 §7）。

---

## 3. HOST_DAEMON_PROTOCOL_VERSION 语义

- **当前值：128**，单一常量导出自协议包：`export const HOST_DAEMON_PROTOCOL_VERSION = 128 as const`（`packages/host-daemon-contract/src/commands.ts:40`）。
- **仓库规则（scheme B：任何 wire 变更必 bump）**：`AGENTS.md:23` 规定「凡可能改变 server ↔ host daemon 之间任何内容（session payload、WS 消息、host RPC command/result 的增删改、字段类型/必填/默认值/语义）都必须递增该常量；共享 TS 类型编译通过不构成 wire 兼容证据——已入编机器可能还跑着旧 daemon，版本不匹配正是触发其自动更新的机制」。
- **判定规则：会话打开时严格相等**。server 校验 `payload.protocolVersion !== HOST_DAEMON_PROTOCOL_VERSION` 即拒绝（`apps/server/src/internal/session.ts:52-77`）：
  - 记录 `lastRejectedProtocolVersion`、推送 `host-disconnected`；
  - 返回 400 `{ code: "protocol_version_mismatch", details: { retryUpdate, serverProtocolVersion } }`（retryUpdate 是 UI 侧点过「重试更新」的一次性标记，`hub.takeHostProtocolUpdateRetry`）。
  - schema 层故意放宽为 `z.number().int().positive()`，让旧版本得到可操作的错误而非裸校验失败（`session.ts:106-108` 注释）。
- **不匹配之后的两条自愈路径**：
  1. 旧 daemon：`ServerConnection` 收到该错误码后调 `ProtocolSelfUpdater.handleProtocolMismatch`，拉 server 的 bb-app 版本清单，仅当 `server.protocolVersion > HOST_DAEMON_PROTOCOL_VERSION` 才升级，拒绝降级（`apps/host-daemon/src/protocol-self-update.ts:195-206`；接线 `server-connection.ts:387-400`）。
  2. UI：`lastRejectedProtocolVersion !== 当前常量` → 「Needs update · daemon protocol N · server protocol M」徽标（`apps/app/src/lib/host-update-status.ts:4-24`）。
  - 反向（新 daemon + 旧 server）拒绝自更新，等 server 升级（`protocol-self-update.ts:203-205`）。
- **#21 语境（scheme A vs B）**：spec #17 写「scheme A 不动版本常量」，#21 写「仅 breaking 才 bump」。bb 事实是纯 scheme B 且「breaking」取最宽定义（连字段默认值变化都算）。若 M0 采用 scheme A（M0 内不改 wire 形状则常量不动），与 bb 事实不冲突——bb 的机制本质是「版本常量只在 wire 语义变化时变化」，A 只是把它收缩为「M0 期间恒为初值」；一旦发生 breaking 变更，仍需 bb 式的 bump + 拒绝路径。校验点应当只有一处：会话打开（HTTP），WS 升级只验会话有效不重复验版本（`daemon-protocol.ts:35-68`）。

---

## 4. 工具调用往返

### 4.1 server → daemon：WS `host-rpc.request` / `host-rpc.response`

- 请求（server→daemon）：`{ type: "host-rpc.request", requestId: uuid, command: <rpc command> }`（`session.ts:359-365`；构造 `hub` 调用方 `apps/server/src/services/hosts/online-rpc.ts:138-151`）。
- 命令分两种 transport（`commands.ts:1585-1603` 描述符、`:2125` 注册表）：
  - `onlineRpc`：同步问答型（文件、workspace 状态、技能、models…），daemon 必须在线；
  - `settled`：长事务型（`thread.start`、`turn.submit`、`environment.provision`、`project.clone`、`workspace.commit` 等），结果「最终结算」，增量产出走事件信道。完整命令类型清单见 `session.ts:415-472`（response union 逐一枚举了 54 个 commandType）。
- 响应（daemon→server）成功：`{ type: "host-rpc.response", requestId, commandType, ok: true, result }`，result 按 commandType 逐一 schema 校验（`session.ts:386-473`）；失败：`{ …, ok: false, errorCode, errorMessage }`（`session.ts:475-489`）。daemon 侧入口 `CommandRouter.handleOnlineRpcRequest`（`command-router.ts:151-195`），错误一律转成 ok:false 而非让 socket 崩。
- **超时**：server 侧 `hub.callHostOnlineRpc` 挂 waiter，超时抛 `HostOnlineRpcTimeoutError`（`hub.ts:636-668`）。默认 `COMMAND_TIMEOUT_MS = 30_000`（`apps/server/src/constants.ts:1`），遍布 HTTP 路由（如 `routes/environments.ts:168`）；长事务走 `LIVE_DAEMON_COMMAND_TIMEOUT_MS = 24h`（`services/hosts/live-command.ts:21`）。daemon 离线时可等注册：`waitForDaemonRegistration(hostId, timeoutMs)`（`hub.ts:513-528`）；`retryable` 命令可重试（`online-rpc.ts:47-111`）。
- **取消**：`thread.stop` 带 `intent: "interrupt" | "release"`（`commands.ts:405-414`），interrupt 语义是「等 runtime 自己得知中断后等待 graceful settle」（`commands.ts:399-404` 注释）；交互请求可经 `/internal/session/interactive-request/interrupt` 按_PROVIDER 请求身份精确打断（`session.ts:756-785`）。协议里没有 per-request 的通用 cancel 帧——取消都是业务命令。
- **进度**：不在 RPC 信道。settle 型命令的中间产出（token 用量、工具条目、流式文本）由 daemon 经 `POST /internal/session/events` 批量上报：请求 `{ sessionId, eventGroups: [{ threadId, events[] }] }`，相邻同 thread 事件压缩成组（`session.ts:189-273`、`237-245`）；响应逐事件回执 `{ acceptedEvents: [{eventIndex, threadId, sequence}], rejectedEvents: [{eventIndex, threadId, reason}] }`（`session.ts:275-306`）。`sequence` 是 server 单方拥有的序号，daemon 事件携带 `sequence` 或 `statusLabels` 会被拒（`session.ts:199-227`）。

### 4.2 daemon → server：HTTP 回调族

- `POST /internal/session/tool-call`：daemon 上 provider 运行时回调**服务端工具**（如线程换目录），请求 `{ threadId, providerThreadId, turnId, callId, tool, arguments, sessionId }`（`session.ts:704-718`），server 处理器 `apps/server/src/internal/tool-calls.ts:54-58`。
- `POST /internal/session/interactive-request`：注册权限/提问交互（pending interaction），响应 `created | existing | rejected`（`session.ts:725-754`）；UI 客户端裁决后经 `interactive.resolve` 命令回流 daemon（`commands.ts:459-468`）。
- `GET /internal/session/project-attachment-content`、`GET /internal/skills/tree/:hash`、`GET /internal/runtime-policy`：附件（校验 content-length）、技能树（hash 校验）、运行时策略（`server-client.ts:357-453`）。
- 全部要求 Bearer hostKey + 会话有效；附件下载还强制 HTTPS（除本机 LAN 场景明示放宽，`server-client.ts:404-408`）。

### 4.3 断连语义（#21 验收相关）

- daemon socket 断开：server 有 `DAEMON_DISCONNECT_GRACE_MS = 5_000` 宽限（`constants.ts:4`，`hub.ts:566-584`），期内重连则取消清理；会话随 socket 关闭即失效，重启的 daemon 走新的 session/open 做存活对账（`internal/session.ts:79-85` 注释、`handleHostSessionOpened`）。
- server 侧任何 RPC 在超时前都会向调用方抛明确错误（timeout / host offline / daemon 报错三类，`online-rpc.ts:125-136` 的 `isHostUnavailableApiError` 区分「没送达」与「送达但失败」）。**没有挂起等待的路径**——这与 #21 的「断连显式超时报错」验收一致。

---

## 5. 认证：Bearer token 的发放与校验

1. **发放（enroll）**：
   - 引导材料：launcher `POST /internal/hosts/enroll-key` → `{ enrollKey, expiresAt, hostId }`（一次性、带过期，`session.ts:138-156`；路由 `apps/server/src/internal/hosts.ts:55-81`）。该路径与 `/internal/hosts/enroll` 在鉴权中间件里显式豁免（`apps/server/src/server.ts:382-388`）。
   - 换长期凭据：daemon `POST /internal/hosts/enroll`（Bearer enrollKey 或 join code）→ 201 `{ hostId, hostKey }`（`session.ts:116-136`；路由 `internal/hosts.ts:83-120`；daemon 侧 `apps/host-daemon/src/enroll.ts:22-23`）。
   - hostKey 写入 `authApiKeys` 表（含 metadata hostId/hostType），重复 enroll 会停用同 host 的其它活跃 key（`apps/server/src/services/machine-auth.ts:392-401`）；支持轮换 `rotateDaemonHostKey`（`:465-485`）。
   - hostId 持久化在 `<dataDir>/host-id`，hostKey 在 `<dataDir>/auth.json`（`local-state.ts:4-5`、`identity.ts:33-70`）。
2. **校验**：中间件从 `authorization` 头剥 `Bearer ` 前缀（缺失/空 → 401，`apps/server/src/internal/auth.ts:29-39`），交 `machineAuth.verifyDaemonHostKey(token)` 查库验证，失败 401（`auth.ts:42-51`）。适用于全部 `/internal/*` daemon 请求与 `/internal/ws` 升级（`server.ts:559-563`）。
3. **可选第二因子**：connect 机器凭据头 `x-bb-connect-machine`，HTTP 与 WS 均携带（`server-client.ts:315-321`、`server-connection.ts:456-460`），server 用它把 host 与 connect machine 关联（`internal/session.ts:86-91`）。
4. WS 层在 Bearer 之外还有两个独立校验：子协议头必须是 `bb-host-daemon.v1`、sessionId 必须属于该 host 的 open 会话（§2.1）。

---

## 6. WS 消息类型速查（逐类）

**server → daemon**（`hostDaemonServerWsMessageSchema`，`session.ts:587-602`）：

| type                                                      | 字段要点                                                               |
| --------------------------------------------------------- | ---------------------------------------------------------------------- |
| `session-close`                                           | `reason: replaced \| expired \| daemon-disconnect`                     |
| `host-rpc.request`                                        | `requestId` + 完整 command（schema 校验）                              |
| `watch-set.replace`                                       | 全量替换文件监听目标集（generation + workspace/threadStorage targets） |
| `connect-shares.replace`                                  | 全量替换端口共享集（generation + ports）                               |
| `terminal.open` / `attach` / `input` / `resize` / `close` | requestId/terminalId；attach 支持 `sinceSeq` 断点重放；input 为 base64 |

**daemon → server**（`hostDaemonDaemonWsMessageSchema`，`session.ts:688-699`）：

| type                                                         | 字段要点                                                                                      |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| `heartbeat`                                                  | 空 `{}`（任意消息都会续租，见 §2.1）                                                          |
| `environment-change`                                         | `environmentId` + `change: work-status-changed \| git-refs-changed \| thread-storage-changed` |
| `environment-metadata-change`                                | `environmentId` + workspace 属性                                                              |
| `connect-tunnel.identity`                                    | 隧道标签身份（label/baseDomain/machineId）                                                    |
| `terminal.opened` / `output` / `replay` / `exited` / `error` | output 携带 `chunk { seq, dataBase64 }`；replay 带 `replayStartSeq/nextSeq`                   |
| `host-rpc.response`                                          | `requestId` + `ok: true\|false`（成功含 result，失败含 errorCode/errorMessage）               |

---

## 7. 对 #21 的映射建议（一段话）

照搬 bb 的**控制面形状**：GatewayDO 每机器一只（对应 bb「hostId ↔ socket」映射，`hub.ts:636-668`），daemon 先 HTTP 打开会话拿 sessionId/心跳参数、再以 `?sessionId=` 附着 WS（§2.1 的三步握手与 `bb-host-daemon.v1` 子协议 + Bearer 头可整体平移）；server→daemon 用 `host-rpc.request/response` + requestId + 30s 显式超时（DO 里可用 `alarm()` 做 watchdog，等价 hub waiter），daemon→server 的事件回传用「批量 POST + server 单方 sequence + 逐事件回执」的事务模型（§4.1/4.2），断连语义直接复用「宽限期 + 会话失效 + 重连重开 session/open 对账」（§4.3）。**不要照搬 TunnelDO 的二进制帧协议**：它是 visitor HTTP/WS 反向中继的流复用协议（§2.2A），而 GatewayDO 的 daemon 信道是低扇出的控制面，bb 自己对这类信道用的就是文本 JSON 消息（§2.2B）；TunnelDO 值得抄的是工程细节而非线格式——`setWebSocketAutoResponse` 心跳零唤醒（`tunnel-do.ts:120-122`）、hibernation 后从 storage/attachment 恢复易失状态（`:109-133`）、新连接顶替时显式废弃在途流（`:276-288`）。按 spec #17 契约需要调整的：认证改为 Worker 内 Access JWT/自签 daemon token（bb 是自建 hostKey 表，§5——发放/校验流程可保留，验证原语换成 Worker 侧）；协议版本按 scheme A 冻结 M0 常量、保留 bb 式「open 时严格相等 + 400 明细」校验点（§3）；大 payload 旁路 bb 没有现成先例（附件走 HTTP 流式 GET + 长度校验，§4.2），R2 引用方案是 spec #17 自有契约；`envLane` 读写串行（§1.1）在多工具并发时值得保留为 daemon 内部纪律。

## 附：关键常量

| 常量                                                        | 值                               | 位置                                                        |
| ----------------------------------------------------------- | -------------------------------- | ----------------------------------------------------------- |
| `HOST_DAEMON_PROTOCOL_VERSION`                              | 128                              | `packages/host-daemon-contract/src/commands.ts:40`          |
| WS 子协议                                                   | `bb-host-daemon.v1`              | `host-daemon-contract/src/session.ts:33`                    |
| `HEARTBEAT_INTERVAL_MS` / `LEASE_TIMEOUT_MS`（server 默认） | 5s / 30s                         | `apps/server/src/constants.ts:2-3`                          |
| `COMMAND_TIMEOUT_MS` / `DAEMON_DISCONNECT_GRACE_MS`         | 30s / 5s                         | `apps/server/src/constants.ts:1,4`                          |
| `LIVE_DAEMON_COMMAND_TIMEOUT_MS`                            | 24h                              | `apps/server/src/services/hosts/live-command.ts:21`         |
| WS 重连退避                                                 | 1s→30s，×2，启动超时 60s         | `apps/host-daemon/src/server-connection-support.ts:104-108` |
| 事件防抖                                                    | 100ms                            | `apps/host-daemon/src/event-sink.ts:11`                     |
| OMP RPC 超时（启动/请求）                                   | 30s / 30s                        | `packages/agent-runtime/src/omp/bridge/bridge.ts:331-332`   |
| OMP RPC 帧上限 / 分片 / 重组上限                            | 1MiB / 256KiB / 64MiB            | `bridge.ts:179-184`                                         |
| 隧道 `PROTOCOL_VERSION` / 心跳文本 / chunk 上限             | 1 / `bbt:hb`,`bbt:hb-ack` / 1MiB | `packages/tunnel-contract/src/index.ts:17-30`               |
| 隧道客户端心跳 / 判死                                       | 20s / 60s                        | `packages/tunnel-client/src/session.ts:24-25`               |
| 隧道重连退避（稳定阈值）                                    | 1s→30s（10s）                    | `packages/tunnel-client/src/reconnect.ts:2-10`              |
| TunnelDO resp-head 超时 / presence 周期                     | 30s / 50s                        | `apps/connect/src/tunnel-do.ts:26,30`                       |
