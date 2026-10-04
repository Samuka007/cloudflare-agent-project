# bb server 移植清单：server 侧 + provider 接口面（#17 前置）

> **provenance**：调查 by research subagent（scout 工具面无仓库写权限，parent 代为落盘），基线 bb @ `8473d8c33`（feature/omp-rpc-provider，desktop-nightly-2 钉版）。
> **处置注**（2026-10-03）：§0.1/§2.5/§4 中「daemon 保持 Node、agent-runtime 随 daemon 不移植」的结论基于 bb 原生拓扑，已被同日架构裁定**取代**——bb daemon 与 provider 应用一并移植进 Workers（daemon 的 child_process 半边替换为进程内类型化 JSON-RPC 接缝，见 #17 grill 裁定 Q2）。事实清单（模块/路由/表/Node 绑定/DO 形状/SPA 判据）全部有效，是移植作业的底稿。

> 范围：回答 bb server 的模块清单、provider 接口契约、harness/配置面、Node 绑定、已 DO 化部件、SPA 兼容判据。daemon↔server wire 协议已有 `bb-daemon-protocol.md`，SPA 组件面已有 `bb-spa-ux-surface.md`，本文不重复，只在衔接处引用。源码：`/home/nixos/workspace/bb`（read-only），基线 commit `8473d8c33`。行号证据随文标注。

## 0. 结论先行

1. **bb 的执行面不在 server**：`@bb/agent-runtime`（provider 子进程管理、stdio JSON-RPC、事件翻译）只被 `apps/host-daemon` 消费（`apps/host-daemon/package.json:25`）；server 是纯控制面（Hono + SQLite + WS hub）。
2. server 无鉴权凭据体系：公开 API 只有 Origin/Host 防 CSRF guard（`browser-request-guard.ts:147-175`）；`/internal/*` 用 daemon Bearer key（`server.ts:381-402`）。Access 前置后 server 自身不需要登录系统。
3. 事件模型是 append-only 单调 `seq` + WS `changed` 失效信号（非 token 流），持久化在 SQLite `events` 表（`packages/db/drizzle/0000_baseline.sql:107`）——天然映射 D1 + DO 广播。
4. provider 接口是三层：server 命令（daemon 协议）→ `AdapterCommand`（runtime 内部）→ stdio JSON-RPC 2.0（bridge 子进程）；移植时保 JSON-RPC 消息形状（#17 裁定 Q2：类型化进程内投递）。

---

## 1. bb server 模块清单（Q1）

### 1.1 入口与装配

- 入口 `apps/server/src/index.ts:1-38`：加载 `@bb/config/server` 配置 → 装进程诊断 → 动态 import `start-server.js`。
- `apps/server/src/start-server.ts:45-263` 是组装根：`initDb`（:50，better-sqlite3）→ `NotificationHub`（:54）→ `WatchInterestCoordinator`（:55）→ `HostSharedPortCoordinator`（:56）→ `TerminalSessionLifecycle`（:97）→ `PendingInteractionLifecycle`（:127）→ `machineAuth`（:120）→ `createApp(deps)`（:150）→ HTTP serve（:196）+ `injectWebSocket`（:200）→ 插件后启动（:215-223）→ 10s 周期 sweep（:225-228）→ SIGINT/SIGTERM 收敛（:257-262）。
- Hono app 装配 `apps/server/src/server.ts:268-670`：中间件链（trusted address :285、event-loop telemetry :293、CORS :300-312、compress :314-322）、顶层 GET（`/health` :324、`/install.sh` :325、`/install/version` :334、`/install/bb-app.tgz` :343）、`/api/v1` 挂 publicApi（:474）、`/internal` 挂 internalApi（:486）、三条 WS（`/ws` :488、`/ws/terminals/:terminalId` :509、`/internal/ws` :556）、SPA 静态兜底（:586-656）。

### 1.2 路由面（SPA 消费的全部端点域）

`server.ts:463-473` 注册 11 个公开路由族（前缀 `/api/v1`）：

| 路由族          | 文件                                                                           | 覆盖                                                                                                                                                 |
| --------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| projects        | `routes/projects.ts`                                                           | 项目 CRUD、sources、attachments、threads 嵌套、skills、execution defaults（:133-246 响应组装）                                                       |
| thread-sections | `routes/thread-sections.ts`                                                    | 侧栏分区管理                                                                                                                                         |
| files           | `routes/files.ts`                                                              | 文件浏览/预览 lease（TTL 内存 map，:363-386）                                                                                                        |
| hosts           | `routes/hosts.ts`                                                              | 机器 fleet                                                                                                                                           |
| terminals       | `routes/terminals.ts`                                                          | 终端会话 REST                                                                                                                                        |
| environments    | `routes/environments.ts`                                                       | 环境管理                                                                                                                                             |
| threads         | `routes/threads/index.ts:9-15`（base/actions/data/interactions/tabs 五子文件） | 线程 CRUD、发消息、timeline（rows+maxSeq+page+delta，`routes/threads/data.ts:389-432` 带 timelineLatestRowsCache/conversationOutlineCache 内存 LRU） |
| system          | `routes/system.ts`                                                             | `/system/config`、generalSettings（app_settings 表读写 :162-201）、keybindings、appearance、experiments、voice transcription（:352-365）             |
| plugin-catalog  | `routes/plugin-catalog.ts:33-155`                                              | 目录、搜索、图标、install、marketplaces                                                                                                              |
| plugins         | `routes/plugins.ts:196-612`                                                    | 插件 CRUD、settings、rpc 分发、日志、token、updates                                                                                                  |
| skills-registry | `routes/skills-registry.ts:52-165`                                             | 技能市场                                                                                                                                             |

`/internal/*`（daemon 专用，`server.ts:480-486`）：hosts（enroll/enroll-key）、session（命令/事件/工具回调/交互请求）、skills（技能树 hash 拉取）、events、tool-calls、interactive-requests。鉴权例外清单 :381-402（enroll-key/enroll/ws 豁免，其余验 Bearer daemon key）。

### 1.3 会话/thread 注册与编排

- thread 注册/生命周期状态机全在 SQLite（threads、thread_operations、client_turn_requests、queued_thread_messages、pending_interactions 等表，`packages/db/drizzle/0000_baseline.sql:107-380` 与各迁移）。
- 发送编排 `services/threads/thread-send.ts`：`resolveSendMode`（:175-216，start/auto/steer/queue-if-active 判别）→ 事务内 append `client_turn_requested` 事件 → 经 `startLiveHostCommand`（:50-54，走 hub 的 daemon WS 下发命令）。thread 真正执行在 daemon 的 `command-dispatch.ts` + `runtime-manager.ts`（见 bb-daemon-protocol.md §1）。
- runtime 命令组装 `services/threads/thread-runtime-config.ts:164-339`：workspace/技能/插件工具/instructions 汇编；OMP 走「provider 拥有工具面」分支（:186-189 `providerOwnsRuntimeSurface`）。
- daemon 会话镜像：`internal/session-state.ts`、`internal/session-owner-side-effects.ts`（以 `host_daemon_sessions` 表为真相，:77-78、:145-146）。

### 1.4 daemon 管理面

- `internal/hosts.ts`（enroll）+ `ws/daemon-protocol.ts`（`/internal/ws` upgrade、validateDaemonWebSocket，server.ts:556-580）。
- 在线 RPC：NotificationHub 的 `hostOnlineRpcWaiters`（hub.ts:160-163）+ `services/hosts/online-rpc.ts:1-3`（randomUUID 关联请求/响应）。
- 命令持久化：`host_daemon_commands` / `host_daemon_command_attempts` 表（`0000_baseline.sql:138`、`0010_brief_james_howlett.sql:1`）。

### 1.5 通知/事件分发（NotificationHub 及后继）

- `apps/server/src/ws/hub.ts:143-191`：`NotificationHub implements DbNotifier`，全部进程内存态——clientKeysBySocket / daemonSessions / waiter Maps（threadEventWaiters :187、hostOnlineRpcWaiters :160、daemonRegistrationWaiters :154）/ terminal 发送队列（:178，32MiB 上限 :36）/ pendingDaemonDisconnects 宽限 timer（:166-173）。订阅键九种 target（:53-89）。
- `ws/watch-interests.ts:67-82`：客户端订阅折叠成 daemon `watch-set.replace`（:216-220），generation + fingerprint 去重（:205-214）。
- `ws/host-shared-ports.ts`：host 共享端口协调（内存态 + db）。

### 1.6 持久化格局

- **SQLite（better-sqlite3 + drizzle，`packages/db/src/connection.ts:1-3,168`）**：40+ 迁移表——threads、events（append-only，`event_large_values` 溢出表 `0031` :1）、projects、environments、hosts、host_daemon__、terminal_sessions、pending_interactions、app_settings（`0026`）、system_experiments（`0028`）、app_theme（`0042`）、automation__、workflow_*、prompt_history_entries、queued_thread_messages、thread_search_segments 等。
- **纯内存（移植时必须显式安置）**：NotificationHub 全部 socket/订阅/waiter 态、`routes/files.ts` previewLeases（:363，TTL→DO alarm 语义）、`routes/threads/data.ts` timeline LRU（:390-430，可丢弃）、`lifecycle-dedupers`、AsyncLocalStorage 请求上下文。

---

## 2. provider 接口契约（Q2）

### 2.1 分层

```
SPA/CLI ──HTTP/WS──► bb server（控制面）
bb server ──daemon WS(自研 JSON)──► host-daemon（执行面）
host-daemon ──AgentRuntime──► provider bridge 子进程（stdio JSON-RPC 2.0，每行一帧）
bridge ──spawn──► omp --mode rpc / claude-code / codex app-server / ACP agent
```

`@bb/agent-runtime` 仅被 `apps/host-daemon` 依赖（`apps/host-daemon/package.json:25`）；`packages/agent-runtime/src/README.md:3` 自述职责：process spawning、stdio framing、JSON-RPC dispatch、event translation、tool call routing、crash detection、shutdown。daemon 粘合层：`apps/host-daemon/src/runtime-manager.ts`、`command-dispatch.ts`。

### 2.2 runtime 内部命令（AdapterCommand，`packages/agent-runtime/src/provider-adapter.ts:134-230`）

`initialize`、`skills/configure`、`model/list`、`thread/start`（cwd/input/options/dynamicTools/disallowedTools/instructionMode）、`thread/resume`（可带 `ompRecovery` 恢复描述符）、`thread/fork`、`turn/start`（clientRequestId）、`turn/steer`（expectedTurnId）、`thread/stop`（activeTurnId 区分打断 vs 空闲停止，:198-204）、`thread/discard`、`thread/goal/clear`、`thread/name/set`、`thread/archive`/`thread/unarchive`。

`ProviderAdapter` 接口（:272-300）：id/displayName/capabilities；`approvalRequestPolicy: "runtime" | "provider"`（:283，审批升级强制侧）；`normalizeExecutionOptions`；`classifyExecutionSettingsChange → "unchanged"|"live"|"session"`（:297，配置漂移下 turn 携带或重建会话）；`process: { command, args, env }`（:300，spawn 描述）。

### 2.3 进程与会话管理（`runtime-provider-process.ts`）

- `RuntimeProviderProcess`（:28-40）：adapter + ChildProcess + pending JSON-RPC 表 + stderr tail（4KB 上限 :126）。
- `RuntimeProviderProcessManager`（:145-）：processKey（`providerId\0thread:` 前缀，runtime.ts:246-248）按 thread 复用进程；`ensureProvider`（:155-263）串行启动：spawn → `initialize` → post-initialize → `skills/configure`（:222-240）。
- 会话注册/列举：provider 会话注册在 daemon 侧 AgentRuntime 内存（processes Map）；durable 镜像是 server DB 的 `host_daemon_sessions` + thread.providerThreadId；恢复走 `thread/resume` + ompRecovery descriptor。

### 2.4 bridge stdio 合同

详见 bb-daemon-protocol.md §1.2（不重复）：`packages/agent-runtime/src/omp/bridge/bridge.ts` 每线程 spawn `omp --mode rpc`；宿主方法 initialize/model/list/thread/start/thread/resume/turn/start/turn/steer，通知 thread/identity、omp/prompt/settled；帧上限 1MiB、超时 30s。ACP 通用桥 `src/acp/bridge/bridge.ts` + `agent-connection.ts:9-10`（spawn + readline）；已知 ACP agent 清单 `services/system/known-acp-agents.ts:26-94`（acp-opencode/acp-omp/acp-grok/acp-hermes，launch spec 含 modelCli/permissionCli/reasoningCli 适配参数）；provider 目录元数据 `packages/agent-providers/src/catalog.ts:242-246`。

### 2.5 「agent-runtime immutable」定性

`@bb/agent-runtime` 是源码进 daemon bundle、不对外发包的独立层（package.json source-only；README:133-134「source-only inside this workspace; the host daemon build creates the bridge bundles」）。对上合同只有 `AdapterCommand`/`ProviderAdapter` 与 daemon dispatch。承载 5 个 provider 的会话/恢复/翻译语义（rewind staging、turn replay filter、background work state，runtime.ts:59-61），回归面极大且已被 daemon 协议隔离。移植处置：child_process 半边被 worker 内 provider 应用取代（见处置注），`AdapterCommand`/`ProviderAdapter` 合同形状照抄为接缝。

---

## 3. harness / agent 应用级配置面（Q3）

| 类别                | 入口                                                                                                                    | 证据                                                                            |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| 模型路由            | thread execution options（model/serviceTier/reasoningLevel）+ project_execution_defaults 表 + 推理兜底 env              | `provider-adapter.ts:115-132`；`start-server.ts:80-81`；`0000_baseline.sql:279` |
| 执行设置漂移        | live vs session 分类                                                                                                    | `provider-adapter.ts:297-299`                                                   |
| 权限                | RuntimePermissionPolicy + permission escalation（user turn ask / system turn deny）+ approvalRequestPolicy              | `thread-runtime-config.ts:136-147`；`provider-adapter.ts:276-283`               |
| 工具策略            | dynamicTools/disallowedTools（built-in + 插件注册，session 启动时冻结）                                                 | `thread-runtime-config.ts:113-134`                                              |
| Prompt/instructions | STANDARD_AGENT_INSTRUCTIONS 模板 + 工具说明 + 插件 contributeInstructions（4096 上限）+ workspace/数据目录 instructions | `thread-runtime-config.ts:44-52,256-299`                                        |
| Skills              | skillRoots（project/shared/plugin/injected 四源）+ SkillTreeRegistry + skills/configure                                 | `thread-runtime-config.ts:191-245`；`runtime-provider-process.ts:222-240`       |
| MCP/ACP             | 已知 ACP launch spec + bb-app managed config 自定义 ACP agent                                                           | `known-acp-agents.ts:26-94`；`start-server.ts:74`                               |
| 插件设置            | plugins/:id/settings GET/PUT + app_settings/theme/experiments 表                                                        | `routes/plugins.ts:477-506`；`routes/system.ts:162-201`                         |
| 服务端模型调用      | OpenAI 兼容 key（标题生成/语音转写）                                                                                    | `start-server.ts:84,88`；`routes/system.ts:352-365`                             |
| OMP 特例            | OMP 拥有自己的 tools/rules/skills/memory/auth/subagents                                                                 | `thread-runtime-config.ts:186-189`                                              |

M0 harness 最小面（#17 裁定 Q4）：模型中转配置 + host 绑定声明 + session 注册表；其余类别按需长进来。

---

## 4. Node 绑定清单（Q4）

**server（apps/server/src）**：

- `@hono/node-server` + `@hono/node-ws`：HTTP listener（start-server.ts:1,38-43）与 WS upgrade（server.ts:1,273）→ Workers 原生 fetch/WS。
- `node:fs`：静态服务与预压缩旁车（server.ts:2,214-227,632）、install 资产（:326,344）、插件源（routes/plugins.ts:2）→ Workers Assets / R2。
- `node:child_process`：bb-app tarball 重建（services/install/bb-app-artifact.ts:1-8）→ 削除。
- `node:crypto`（routes/files.ts:2、routes/plugins.ts:1）→ WebCrypto。
- `node:zlib` brotli/gzip（routes/plugins.ts:4）→ 削除或压缩 Worker。
- `node:net/dns/https`：marketplace 抓取 SSRF 防护（services/plugin-catalog/marketplace-http.ts:1-4）→ fetch + 出口管控。
- `node:perf_hooks`、`node:path`、`node:url`、`node:timers/promises`、AsyncLocalStorage（request-context.ts）、`@hono/node-server/conninfo`（request-context.ts:1）→ performance / ctx.waitUntil / CF-Connecting-IP 重构。

**db 层（packages/db）**：`better-sqlite3` 12.10.0（package.json:31；connection.ts:1,168）+ drizzle better-sqlite3 驱动/迁移器（connection.ts:3、migrate.ts:1）+ WAL/增量 vacuum（connection.ts:167-171、data/maintenance.ts:401）→ **D1**（同步事务改异步；compare-and-set 注释 data/threads.ts:1942-1944 已预写「survives any future executor change」）。

**daemon 侧原 Node 绑定**：child_process/net/readline/http/https/fs（bb-daemon-protocol.md §1；acp/bridge/bridge.ts:14-19）——worker 移植后仅 daemon client（host 侧）保留真实进程语义。

**server 进程型部件**：setInterval sweep（start-server.ts:225）、setTimeout 宽限（hub.ts pendingDaemonDisconnects）、unref 语义 → Cron Triggers + DO alarms。

---

## 5. 已 DO 化 / 可平移部件（Q5）

bb 无 Durable Objects，但以下组件形状就是 DO，port 时直接换壳：

1. **NotificationHub**（hub.ts:143-）：单例 pub/sub + 按 key 订阅 + 请求-响应 waiter + 断线宽限 timer → Realtime/Gateway DO。
2. **previewLeases**（routes/files.ts:363-386）：`Map<id,{expiresAtMs}>` + 逐出扫描 → DO alarm + storage。
3. **WatchInterestCoordinator**（watch-interests.ts:67-）：interest 聚合 + generation/fingerprint 状态机 → 每 host DO 职责。
4. **daemon 会话 lease/heartbeat**：`host_daemon_sessions` 表 + validateDaemonWebSocket + 宽限 Map → session 行 + 在线 socket 合进每-host DO。
5. **timeline LRU**（routes/threads/data.ts:390-430）：纯加速缓存，可丢弃或 DO Map。

不可平移需重构：AsyncLocalStorage 请求上下文（request-context.ts）、进程内 changedMessageListeners 回调总线（hub.ts:219-224）、pending-interactions 进程内 waiter（services/interactions/pending-interactions.ts:1082-1088）。

---

## 6. SPA 兼容判据（Q6，验收底稿）

全面细节见 `bb-spa-ux-surface.md`；server 侧必须满足：

1. 首屏双读：`GET /system/config` + `GET /sidebar-bootstrap`。
2. 线程列表返回裸数组（`z.array(threadListEntrySchema)`），offset 参数但 SPA 不滚动加载。
3. timeline 合同：`rows` + 单调 `maxSeq` + `page{kind,hasOlderRows,olderCursor}` + `afterSequence` delta；事件 `(threadId, seq)` 唯一、append-only；`history-rewritten` 触发全量失效。
4. WS 契约：同源 `/ws`，`subscribe {target}`（九种 target，hub.ts:53-89），服务端推 `changed {entity,id,changes[],metadata}`，客户端宽松解析；瞬态信号 thread-open/thread-pane-action/插件 realtime；终端独立通道 `/ws/terminals/:id`（server.ts:509-554）。
5. 鉴权：SPA 无 token 逻辑；server 只有 Origin guard（browser-request-guard.ts:147-175）+ CORS 白名单（server.ts:300-312）。Access JWT 校验放 Worker，SPA 零改动；未过 Access 的 WS 由 ReconnectingWebSocket 自然恢复。
6. 静态面：Workers Assets 托管 `apps/app/dist`，域名根 + `not_found_handling="single-page-application"`；`/assets/*` miss 必须回 404 而非 index.html（server.ts:645-647 语义）。
7. 请求头：SDK fetch 带 `x-bb-app-surface: web`，Worker 透传不报错即可。

> AGENT GENERATED: by zhipu-coding-plan/glm-5.3-flash (research subagent)
