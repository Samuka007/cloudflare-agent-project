# bb host 概念面对照：SPA 期望 × server-worker 实现（#187）

> **provenance**：research by lane-187（read-only）。bb 侧源码 = 子模块 `bb/` @ `ba42654`（fork 钉版，read-only 挂载于主工作区，本文所有 `bb/…:N` 行号对该 commit）；我方 = `apps/server-worker` + `packages/daemon-service` @ lane/187-host-surface（b1d3bbb）。前置事实承接：#49 attach bridge、#62 lastSeenAt 投影、#183 流式面盘点。
> 范围：bb SPA 消费的 host 概念全端点清单（路由/字段/语义）、host 状态机（connected/disconnected、lastSeenAt、宽限窗、协议版本拒绝）如何驱动 UI 渲染，对照我方实现，产出缺口矩阵 + 实现票切片。事实清单，不含实现。

## 0. 结论先行

1. **状态只有两态**：bb 的 `Host.status` 是 `"connected" | "disconnected"`（`bb/packages/domain/src/host.ts:8-9`），**没有第三态**，也没有任何"stale"判定——SPA 对 `lastSeenAt` 的唯一消费是把秒龄渲染成人话（"last seen 2h ago"），从不据此改状态（§4）。"attached/detached/stale" 在 bb 语义里分别对应：attached=有 active daemon session（hub 注册）→ connected；detached=session 关闭 → disconnected；stale=仅体现为 lastSeenAt 文案老化。
2. **status 是读时派生量，不是存储量**：bb 每次 /hosts 读都问 hub"该 host 有无已注册 daemon socket + active session 行"（`bb/apps/server/src/services/lib/entity-lookup.ts:71-80,104-113`）；我方等价实现为读时 DO RPC `hostLiveness`（`apps/server-worker/src/routes/hosts.ts:106-129`）。**语义等价**，传输不同（内存 map vs DO RPC）。
3. **最大的缺口不是路由，是广播**：GET/PATCH/DELETE 六条路由已移植且语义对齐，但 bb 在 attach/replace/close/rename/destroy 六个时机向 SPA 推 `host-connected`/`host-disconnected` changed 帧（§3.4）；我方 hub DO 的 `notifyHost`/`markDaemon*` 机制齐备（`ws/hub.ts:119-128,194-234`、`contract/domain/change-kinds.ts:53-54,100-109`）却**零生产者**——SPA 端订阅/失效机器（bb 侧）会一直等一个永远不来的失效信号，host 状态只在 60s staleTime 过期或手动刷新后更新。
4. **第二缺口是线程级 host 感知**：bb 的 "Host disconnected" 横幅/占位符由 thread.runtime.displayStatus（`waiting-for-host`/`host-reconnecting`）驱动，服务端按 environment→host 派生（`thread-runtime-display.ts:168-231`）；我方 M0 把 active 一律压成 `waiting-for-host`（`services/runtime-display.ts:18-23`），且 `environmentHostId` 恒 null——即便 S1 广播接通，线程横幅也只会永远报错。
5. **次级缺口**：`retry-update`/`join-codes`/daemon-RPC 五件套（directory/paths/pick-folder/provider-cli）路由未开；`lastRejectedProtocolVersion` 有列无写（SPA "Needs update" 面因此整体失活）；host name 从不采集（恒为 hostId 字面量，SPA 全部机器名显示为原始 id）；provider-cli 状态路由路径与 bb 合同不一致（`provider-cli-status` vs `provider-clis/status`）。

---

## 1. Host 域模型（字段×语义）

| 字段 | bb 定义与语义 | 我方 | 对齐 |
|---|---|---|---|
| `id` | 主机 id（enroll 时自报或 mint，`bb/packages/domain/src/host.ts:12`） | 同 | ✅ 原样移植（`contract/domain/host.ts:15-31`，头注 commit 8473d8c33） |
| `name` | 机器名；**daemon 自报 hostname**，enroll（`bb/apps/server/src/internal/hosts.ts:110`）与 session/open（`internal/session.ts:93`）都写入 | `upsertAttachedHost` 插行时 `name = hostId`，之后永不更新（`db/hosts.ts:27-40`） | ❌ SPA 所有机器名位（MachinePicker/设置页/横幅）将显示原始 id |
| `type` | 恒 `"persistent"`（`domain/src/host.ts:4-5`；list 只回 persistent 未销毁行，`packages/db/src/data/hosts.ts:142-148`） | 插行硬编码 `'persistent'`（`db/hosts.ts:32`） | ✅ |
| `status` | 读时派生，两态（§0.1） | 读时 DO RPC 派生（`routes/hosts.ts:111`） | ✅ 语义；⚠️ 传输成本见 §6 备注 |
| `maxPermissionMode` | 线程权限天花板，owner-only 可改（`domain/src/host.ts:16-22`） | PATCH 路由已移植（`routes/hosts.ts:69-79`） | ✅ 字段；❌ owner/machine 鉴权分界未实现（§6 G10） |
| `lastSeenAt` | daemon 任一 WS 帧 → 无条件 stamp（`daemon-protocol.ts:129-136` → `sessions.ts:203-223` 的 markHostSeen `data/hosts.ts:113-122`）；open/close 也 stamp（`data/sessions.ts:84,126`）。fresh=≤心跳 5s | attach bridge 插行 stamp（`db/hosts.ts:32-36`）+ 心跳投影，**SQL 节流 30s**（`packages/daemon-service/src/hosts-registry.ts:19-33`、`constants.ts:43`）；close 也 stamp（`service-do.ts:636-648`） | ✅ 三时机齐；⚠️ 精度 30s vs bb 5s（纯文案差异，见 §6 G6） |
| `lastRejectedProtocolVersion` | daemon 握手协议版本不匹配时写入 daemon 版本（`internal/session.ts:53-55`），成功 open 清 null（`:96-98`），驱动 SPA "Needs update/Retry update"（§4） | 列存在（migration #26），**无任何写入路径** | ❌ 整条协议升级面失活 |
| `createdAt`/`updatedAt` | mint/open 时间 | 同 | ✅ |
| `connectMachineId` | connect 插件配对 id（`data/hosts.ts:75-78,99`） | 列存在，恒 NULL | ➖ connect 通道不在范围 |

---

## 2. 端点×字段×语义对照（SPA 消费面）

bb 合同唯一来源 `bb/packages/server-contract/src/public-api.ts:599-692`（hosts 簇）；实现 `bb/apps/server/src/routes/hosts.ts:98-318`。我方合同已移植（`contract/api/hosts.ts`），路由仅 6 条（`routes/hosts.ts:25-129`，注册于 `app.ts:56`）。

| # | 端点 | bb 语义（锚） | 我方（锚） | 状态 |
|---|---|---|---|---|
| E1 | `GET /hosts` | 全体 persistent 未销毁 host + 读时 status（`entity-lookup.ts:104-113`） | `routes/hosts.ts:28-31`（listNonDestroyed + 逐行 toHostRecord） | ✅ 语义对齐 |
| E2 | `GET /hosts/:id` | 未销毁否则 404；**销毁行回 404 `host_unavailable` + `details.destroyedAt`**（`entity-lookup.ts:115-131`） | `routes/hosts.ts:33-36`；requireHost 销毁回 404 `host_not_found`（`:91-97`） | ✅；⚠️ 404 code/details 与 bb 不同（SPA 按 code 分支处会走兜底文案） |
| E3 | `PATCH /hosts/:id`（name） | owner-only（machine 凭据 403 `machine_host_management_forbidden`，`routes/hosts.ts:59-67,134-147`）；成功后 `notifyHost(hostId,["host-connected"])` 广播（`:145`） | `routes/hosts.ts:57-67`：改名成功，**无广播、无鉴权分界** | ⚠️ |
| E4 | `PATCH /hosts/:id/permission-ceiling` | 同上 owner-only + 广播（`routes/hosts.ts:152-164`，广播 `:162`）；"deliberately absent from the SDK and the bb CLI"（`:149-151`） | `routes/hosts.ts:69-79`：改 ceiling 成功，**无广播** | ⚠️ |
| E5 | `POST /hosts/:id/retry-update` | 前置校验两连 409：无 rejected → `host_update_not_needed`（`routes/hosts.ts:170-176`）；rejected ≥ server → `host_cannot_self_update`（`:177-183`）；通过则 `hub.requestHostProtocolUpdateRetry`（`:184-185`） | **路由缺失**（响应 schema 已移植 `contract/api/hosts.ts:89-90`） | ❌ |
| E6 | `DELETE /hosts/:id` | 主 host 拒删 400 `primary_host_removal_refused`（`routes/hosts.ts:192-198`）；吊销 host auth keys（`:200-203`）；**关停 daemon session**（`handleHostRemoved` → closeSession "expired" + closeDaemonSession，`session-owner-side-effects.ts:184-216`）；软销毁 destroyedAt（`:208`）；吊销 connect 凭据（`:209-215`） | `routes/hosts.ts:81-86`：仅 destroyedAt 软销毁。**daemon socket 不关**——DO 里活 socket 仍在，hostLiveness 仍答 connected，直至 daemon 自断 | ❌ 半套 |
| E7 | `GET /hosts/:id/directory` | daemon 在线 RPC `host.browse_directory`，离线 502（`routes/hosts.ts:221-233` + `online-rpc.ts`） | 路由缺失（schema 已移植 `contract/api/hosts.ts:25-53`） | ❌（依赖 daemon-RPC 传输，matrix E8） |
| E8 | `GET /hosts/:id/clone-default-path` | `project.clone_default_path` RPC（`routes/hosts.ts:237-250`） | 缺失 | ❌ 同上 |
| E9 | `POST /hosts/:id/paths/exist` | `host.paths_exist` RPC（`routes/hosts.ts:252-264`） | 缺失 | ❌ 同上 |
| E10 | `POST /hosts/:id/pick-folder` | `host.pick_folder` RPC；`clientHostId` 不符 409 `native_picker_unavailable`（`routes/hosts.ts:266-284`） | 缺失 | ❌ 同上 |
| E11 | `GET /hosts/:id/provider-clis/status` | `provider_cli.status` RPC，离线 502 `host_unavailable` "Host is not connected"（`routes/hosts.ts:286-297`、`online-rpc.ts:162-163`） | **路径不同**：`GET /hosts/:id/provider-cli-status`（`routes/hosts.ts:38`）；无 RPC 传输 → 恒 502 同 code 同 message（`:50-54`）。SPA 降级行为见 §4（我方代码注释 `routes/hosts.ts:39-49` 已记录 #76 裁定） | ⚠️ 路径不匹配 = 精确 404；SPA 收 404 后走 `statusError` 降级文案，与 502 同一分支（MachineSettingsView statusError 兜底），行为近似但非合同 |
| E12 | `POST /hosts/:id/provider-clis/install` | `provider_cli.install` RPC，NDJSON 流（`routes/hosts.ts:33-38,299-317`） | 缺失 | ❌ 同 E7 |
| E13 | `POST /hosts/join-codes` | owner-only mint join code（enrollKey），回 `{joinCode,hostId,expiresAt}` 201（`routes/hosts.ts:111-124`） | 缺失（无 enrollKey 签发体系；daemon-service /enroll 用静态 env key） | ❌ |
| E14 | `POST /hosts/enroll-key`（internal） | machine 凭据 403 + **仅 loopback**（`internal/hosts.ts:55-81`） | 等价物为 daemon-service `POST /enroll`（静态 env ENROLL_KEY，回 `{hostId,hostKey}`，`packages/daemon-service/src/worker.ts:110-145`） | ⚠️ 形状/信任模型不同（POC 认可） |
| E15 | `POST /hosts/enroll`（internal） | connect 机器身份校验 + machineAuth 凭据兑换 + **upsertHost 写 daemon 自报 name**（`internal/hosts.ts:83-122`） | 并入 `/enroll`（无凭据兑换、无 name） | ⚠️ |
| E16 | `POST /internal/session/open` + `/internal/ws` | 握手：版本不匹配→写 lastRejectedProtocolVersion + 广播 host-disconnected + 400（`internal/session.ts:52-77`）；upsertHost(name) + 清 rejected + openSession（stamp lastSeen，`data/sessions.ts:84`）→ WS 注册 hub → **此刻才广播 host-connected**（`ws/hub.ts:471-475`） | `POST /session/open`（`worker.ts:151-210`；版本不匹配 400 带 expected/received `:188-199`，不写任何 host 列）+ `GET /ws` upgrade 前移 401（`:223-249`）；openSession 顶替旧 session（`service-do.ts:424-458`） | ✅ 骨架；❌ 无 host 列写入差异（name/rejected）、❌ 无广播 |

---

## 3. host 状态机：写入方与读方

### 3.1 status 读时派生
- bb：`getOpenDaemonSessionForHost` = hub 有该 host 的注册 sessionId **且** 该 session 行 `status==="active"`（`entity-lookup.ts:55-69`）；两态映射 `toHostStatus:71-80`。
- 我方：`daemonConnected` → per-host `DaemonServiceDO.hostLiveness`（`routes/hosts.ts:120-129`）= DO 内有 current session **且** `liveSocket() !== null`（`service-do.ts:666-679`）。无 DAEMON_SERVICE 绑定/冷 RPC 失败一律降级 disconnected（`:101-105` 注释）。

### 3.2 lastSeenAt 写入时机（bb 4 处 vs 我方 3 处）
| 时机 | bb | 我方 |
|---|---|---|
| enroll/upsert 建 host | `data/hosts.ts:93-107`（lastSeenAt 起始 null，**不 stamp**） | attach bridge 插行即 stamp now（`db/hosts.ts:32-36`）——比 bb 更早有值 |
| session open | `data/sessions.ts:84` markHostSeen | openSession 后 bridge 再 stamp（`worker.ts:201`） |
| daemon 每帧 | `daemon-protocol.ts:129-136` → `heartbeatSession`（`data/sessions.ts:203-223`，顺带续 lease）→ markHostSeen | **仅 heartbeat 帧**投影，SQL 自节流 ≥30s（`service-do.ts:604-610,655-664`；`hosts-registry.ts:25-32`）；其余帧仅续 lease（`service-do.ts:602`） |
| socket close | `closeSession` stamp（`data/sessions.ts:126`） | `webSocketClose` → projectLiveness（`service-do.ts:636-648`） |

### 3.3 断开与宽限（两扇 grace 窗）
- bb `handleDaemonSocketClosed`（`session-owner-side-effects.ts:134-176`）：unregister（→ 之后 /hosts 读 disconnected）→ closeSession "daemon-disconnect" → 通知线程 runtime 状态变化（`:159`）→ 5s `DAEMON_DISCONNECT_GRACE_MS`（pending interactions/background tasks 结算）+ 30s `DAEMON_ACTIVE_WORK_DISCONNECT_GRACE_MS = LEASE_TIMEOUT_MS`（active turn 的 reconnect 宣传窗，`constants.ts:4-5`）。
- 线程显示侧只认 30s 窗：`getDaemonDisconnectGraceExpiresAt`（`thread-runtime-display.ts:116-129`）= session closed + closeReason "daemon-disconnect" → `closedAt + 30s`；窗内 `host-reconnecting` + `hostReconnectGraceExpiresAt`，窗外 `waiting-for-host` + null（`:194-221`）。
- 我方：DO 侧 `webSocketClose` 仅 armGraceAlarm（orphan 判定，`service-do.ts:636-640`）；hub DO 侧 grace 状态机已在（mark/mark/get，`ws/hub.ts:194-234`）但无人调、无人读；且 hub 常量名 `DAEMON_ACTIVE_WORK_DISCONNECT_GRACE_MS = 5_000`（`ws/hub.ts:292-293`）——**名实不符**（bb 同名常量 = 30s）。runtime-display 的 M0 注释明言"carried for #30 to wire in"（`services/runtime-display.ts:16`）。

### 3.4 changed 广播生产者（bb 全表）
| 时机 | 广播 | 锚 |
|---|---|---|
| daemon WS 注册 hub（**只在 socket 注册后**，防"早广播→客户端缓存住 disconnected"竞态） | `host-connected` | `ws/hub.ts:471-475` + 回归测试 `test/app/hub.test.ts:497-519` |
| session close（任何原因，含 socket 掉线） | `host-disconnected` | `data/sessions.ts:128` |
| 协议版本拒绝 | `host-disconnected` | `internal/session.ts:57` |
| PATCH name / ceiling | `host-connected`（复用连接变化失效路径，注释自认权宜） | `routes/hosts.ts:145,162` |
| upsert 建 host / 复活 | `host-connected` | `data/hosts.ts:108,54-56` |
| destroy / 硬删 | `host-disconnected` | `data/hosts.ts:50-52,230` |

分发形状：`{type:"changed", entity:"host", id, changes}`，id 命中 host-list **和** host-detail 两个订阅键（`ws/hub.ts:79-85`）。SPA 端 `REALTIME_HOST_CHANGE_REGISTRY` 把两种 change 打到 hosts 列表/detail 前缀、project 列表、system providers、execution options 四组查询（`realtime-cache-registry.ts:485-499,985-987`）。
我方：`notifyHost` DO RPC + host 订阅键 + hostChangedMessageSchema 全部就位（`ws/hub.ts:119-128`、`change-kinds.ts:100-109,154-159,218-226`；threads.ts:895 接口位已留），**调用数为 0**。

---

## 4. SPA 渲染驱动映射（bb apps/app @ ba42654）

| UI 面 | 判据（字段→渲染） | 锚 |
|---|---|---|
| 机器设置列表行 | `status==="connected"` → 绿点+"Online"；否则 `lastSeenAt!==null` → "Offline · last seen X ago"；再否则 "Offline"；`lastRejectedProtocolVersion` 非空优先显示 "Needs update · daemon protocol X · server protocol Y" | `MachinesSettingsSection.tsx:70-99`（machineMetaLine），点 `:139`，权限列 `:151-153` |
| 机器详情页头 | 同上三元（headerMeta）+ 平台 + "paired X ago" | `MachineSettingsView.tsx:59-83,262-270` |
| 机器详情页 Provider CLIs 行 | `host.status!=="connected"` → "Unavailable while offline"；statusPending → "Checking…"；statusError → **"Status unavailable"**（我方恒 502 时 SPA 落在此行，#76 隐藏裁定） | `MachineSettingsView.tsx:332-356` |
| Updates 行 + Retry 按钮 | `hostNeedsUpdate`（disconnected + rejected≠server 版）→ 文案；`hostCanRetryUpdate`（rejected<server）→ Retry 按钮 → `POST retry-update` | `lib/host-update-status.ts:4-25`；`MachineSettingsView.tsx:357-379` |
| 危险区 | primary host → Remove 禁用（对应 E6 的 400 前置） | `MachineSettingsView.tsx:383-404` |
| MachinePicker（选机器） | 非 connected 项**禁用**；disconnected + lastSeenAt → "last seen X ago"；needs-update → 警示文案 | `MachinePicker.tsx:132-174`（禁用 `:133-141`） |
| EnvironmentPicker（机器分组环境选择） | 同上组头 + 离线时机器段落整体不可用/请求 setup 仅 connected | `EnvironmentPicker.tsx:455-543` |
| 添加机器对话框 | mint join-code → 展示 `curl …/install.sh --join-code …` 一行命令 + 倒计时；**新 host 出现在 /hosts 列表即原地翻绿**（依赖 host-connected 广播失效） | `AddMachineDialog.tsx:67-72,110-121`；测试 `AddMachineDialog.test.tsx:114-186` |
| **线程横幅（"Host disconnected"）** | thread.runtime.displayStatus：`waiting-for-host` → "{hostName} disconnected"（error 色）；`host-reconnecting` → "{hostName} disconnected. Waiting for reconnection..."（pending 色）；hostName 仅在多机时具名 | `ThreadDetailView.tsx:366-389`（buildHostConnectionNotice） |
| Follow-up 输入框占位 | `waiting-for-host` → "Host disconnected"；`host-reconnecting` → "Waiting for host to reconnect..."（compact："Reconnecting..."） | `follow-up-placeholder.ts:11-33,36-57` |
| 横幅激活/提交门 | 子线程 runtime 处于 {active, host-reconnecting, provisioning, starting, waiting-for-host} 计入横幅活动状态（`ThreadPromptContextBanner.tsx:130-143`）；host-reconnecting/waiting-for-host 的 follow-up 走排队而非即时发送（`shouldQueueFollowUpMessage`，`threadDetailPromptSubmission.ts:111-121`；提交按钮禁用 `ThreadDetailPromptArea.tsx:1513-1519`） | 同左 |
| 乐观更新保护 | 排队发送时保留 host blocker displayStatus，不许升 "active" | `thread-runtime-cache-owner.ts:637-653` |
| 数据源与失效 | `useHosts` = host-list WS 订阅 + 60s staleTime（`host-queries.ts:23-33`；订阅目标 `useRealtimeSubscription.ts:14,110-114`）；host-connected/disconnected → 失效 hosts/host 前缀/project 列表/providers/execution options（`realtime-cache-registry.ts:485-499`）；冷启动订阅前取数的水位线兜底（`system-cache-effects.ts:91-95,146-150`）；thread 详情 bootstrap 内嵌 host 时直写 host/hostList 缓存（`thread-detail-cache-owner.ts:60-73`） | 同左 |

> 对我方的直接推论：(a) 广播缺失时一切"实时翻绿/翻红"失效，只剩 60s 轮询兜底；(b) runtime-status M0 桩使横幅/占位符**恒报** "Host disconnected"（对 active 线程），即便 host 实际 connected；(c) name/lastRejectedProtocolVersion 缺写使设置页机器名与升级面失真/失活。

---

## 5. 缺口矩阵

| # | 面 | bb 语义 | 我方现状 | 缺口 | 对 SPA 的可观察后果 |
|---|---|---|---|---|---|
| G1 | changed 广播 | 6 生产时机（§3.4） | 机制全在，生产者 0 | **接线** | 状态翻转要等 60s staleTime/手动刷新；AddMachineDialog 不原地翻绿 |
| G2 | 线程 runtime host 感知 | env→host 派生 + 30s reconnecting 窗（`thread-runtime-display.ts:168-231`） | active 恒 `waiting-for-host`，environmentHostId 恒 null（`runtime-display.ts:18-23,77-97`） | **实现 + M0 无 environment 的 host 绑定决策** | active 线程恒显横幅+占位符，即便 host 在线 |
| G3 | hub active-work 常量 | 30s（=LEASE，`constants.ts:5`） | hub 同名常量 5s（`ws/hub.ts:293`） | 名实不符 | 若直连会过早退出 reconnecting |
| G4 | name 采集 | enroll/open 写 daemon 自报 hostname | name=hostId 且不更新（`db/hosts.ts:32`） | 写入 | 全 UI 机器名显示原始 id |
| G5 | lastRejectedProtocolVersion 生命周期 | 拒绝写入/open 清除/retry 409 门 | 列在，无写 | E5 路由 + 握手写点 | "Needs update/Retry update" 面整体失活（隐性安全：旧 daemon 无升级提示） |
| G6 | lastSeenAt 精度 | 每帧 stamp（≤5s 旧） | 心跳投影 30s 节流 | 精度（可接受偏离，需裁定） | "last seen X ago" 偏大 ≤25s；无功能判读 |
| G7 | E5 retry-update 路由 | 双 409 门 + hub 重试旗标 | 缺失（schema 已移植） | 路由 | Retry 按钮永不出（依赖 G5 前置） |
| G8 | E13 join-codes | owner mint joinCode → install.sh | 缺失（静态 env key POC） | 签发体系（M1 key registry 前置） | 多机接入 UI 无法闭环 |
| G9 | E7-E10,E12 daemon-RPC 五件套 | host 在线 RPC | 缺失（matrix E8 裁定 crop） | DO→daemon RPC 传输（#30 seam） | 路径浏览器/文件夹选择/provider 安装不可用（离线文案兜底） |
| G10 | owner/machine 鉴权分界 | `assertHostManagementAllowed` 403（machine 不可管 host） | 单一 Access JWT gate（`middleware/access.ts`），无凭据种类 | 语义（多机前不致命） | — |
| G11 | E6 删除终局 | 主 host 拒删 + 吊销 keys + **关 daemon session** + 软销毁 | 仅软销毁；DO 活 socket 残留（hostLiveness 仍 true） | 终局动作 | 删除后机器"幽灵在线"直至 daemon 自断 |
| G12 | E2 404 形状 | `host_unavailable` + details.destroyedAt | `host_not_found`（`routes/hosts.ts:91-97`） | 错误码形状 | 销毁 host 详情页文案走兜底 |
| G13 | E11 路由形状 | `/hosts/:id/provider-clis/status` | `/hosts/:id/provider-cli-status` | 路径字面量 | 精确匹配 404；SPA 仍落 statusError 降级行（行为近似，合同不符） |
| G14 | /hosts 读放大 | 内存 map O(1) | 每 host 一次 DO RPC（冷 DO 实例化；`routes/hosts.ts:30` Promise.all） | 性能（非语义） | fleet 大时首读延迟；可后续批 RPC/缓存 |

---

## 6. 实现票切片建议（供 PM 切票）

- **S1（P0）host changed 广播接线**（消 G1）：生产点=（a）daemon-service DO session 顶替/open 成功、`webSocketClose` → 依 `#49` 同款桥接回调通知 hub `notifyHost(hostId,["host-connected"|"host-disconnected"])` + `markDaemonConnected/Disconnected`（socket 注册后再广播，守住 `hub.ts:471-475` 的竞态语义）；（b）PATCH name/ceiling、DELETE → `notifyHost`。验收：改 host 名/拔 daemon 后 SPA 60s 内免刷新翻转；对应 hub.test.ts:497 形状的回归测试。
- **S2（P0）线程 runtime host 感知**（消 G2/G3）：先裁 M0 host 绑定（无 environments 族：建议"当前唯一 attached host"或给 threads 表加 hostId 列，PM 定）；runtime-display 查 DO liveness + hub grace；`DAEMON_ACTIVE_WORK_DISCONNECT_GRACE_MS` 改 30s 对齐 bb（或裁定保留 5s 并改名）。验收：host 在线时 active 线程无横幅；拔线 30s 内 waiting-for-host，窗内 host-reconnecting+expiresAt。
- **S3（P1）host 身份与升级数据**（消 G4/G5/G7/G12）：session/open（或 /enroll）桥接里 upsert 写 name=daemon 自报 hostname；版本不匹配写 lastRejectedProtocolVersion、成功 open 清 null；开 E5 retry-update 双 409 门（hub 旗标可先落 DO）；requireHost 销毁分支改 `host_unavailable`+destroyedAt。验收：SPA 设置页显示真实机器名；人为版本不匹配出现 "Needs update"。
- **S4（P1）删除终局**（消 G11）：DELETE 时经 DO 关停当前 session（close socket + journal），再软销毁；"primary/最后一台"拒删规则按 bb `primary_host_removal_refused` 形状裁定。验收：删除后 /hosts 立即少一行且 DO 无活 socket。
- **S5（P2）路由形状与鉴权**（消 G13/G10）：provider-cli 状态路径改 `/provider-clis/status`（SPA 为钉版 fork，服务端就形）；machine 凭据分界在多机/机器凭据体系落地时一并做。
- **S6（P2，裁定项）lastSeenAt 精度**（消 G6）：30s 节流是 D1 写额保护（`hosts-registry.ts:5-17` 已论证）；若 PM 要求 bb 级 5s 新鲜度，把 `LIVENESS_PROJECTION_INTERVAL_MS` 降至心跳窗即可，代价写额 ×6。建议保持现状并记 ARCHITECTURE 偏离。
- **S7（P3，依赖项）**：G8 join-codes 依赖 M1 key registry；G9 daemon-RPC 五件套依赖 #30 seam/E8 解禁——维持 crop，不在 host 面单独开票。

## 7. 常量对照

| 常量 | bb | 我方 | 判 |
|---|---|---|---|
| 心跳间隔 | 5s（`apps/server/src/constants.ts:2`） | 5s（`daemon-service/src/constants.ts:31`） | ✅ |
| lease | 30s（`:3`） | 30s（`constants.ts:32`） | ✅ |
| 断开 grace（pending 交互结算） | 5s（`:4`） | DO 侧 DISCONNECT_GRACE_MS 5s（`:33`，orphan 判定用） | ✅（用途不同位） |
| active-work grace | 30s = LEASE（`:5`） | hub 同名常量 5s（`ws/hub.ts:293`） | ❌ G3 |
| last_seen 写入节奏 | 每帧（`daemon-protocol.ts:129-136`） | 心跳帧 + ≥30s SQL 节流（`hosts-registry.ts:19-33`） | ⚠️→✅ G6 裁决接受偏离（§8 S6） |
| 协议版本 | 严格相等，400+details（`session.ts:52-77`） | 严格相等，400+expected/received（`worker.ts:188-199`） | ✅（形状外 details 键名略异，M0 scheme A 认可） |

## 8. S3-S7 落地与裁决（#195，实现 lane）

> S1/S2（#193/#194）已先行落地；本节记录 #195 批次（S3-S7）的实现锚点与两条裁决（S6/S7）。bb 行号均对 ba42654。

### S3 host 身份与升级数据（消 G4/G5/G7/G12）

- **name 采集**：daemon client 在 session/open 载荷自报 `hostName`（`os.hostname()`，bb `hostDaemonSessionOpenRequestSchema:100`）；桥接回调 `onDaemonAttach(hostId, {hostName})` → `upsertAttachedHost` **仅首次插入**时写 name（bb `upsertHost` 对已存在行的 update set 不含 name，`data/hosts.ts:70-91`——重拨/主机改名不覆盖 owner 的 rename）。未自报时回退 hostId 字面量（裸 rig 握手）。
- **lastRejectedProtocolVersion 生命周期**：握手版本不匹配 → worker 桥接 `onDaemonProtocolReject` 写入 daemon 版本（bb `internal/session.ts:52-55`）；成功 open → upsert 冲突分支清 NULL（bb `:96-98`）。400 details 增加 bb 形状的 `retryUpdate`（take 语义旗标）与 `serverProtocolVersion`，保留 M0 scheme A 的 `expected/received`。
- **E5 retry-update 双 409 门**：`POST /hosts/:id/retry-update` 开通——rejected 为 null → 409 `host_update_not_needed`；rejected ≥ `DAEMON_PROTOCOL_VERSION` → 409 `host_cannot_self_update`；过门 → hub `requestHostProtocolUpdateRetry`（bb `routes/hosts.ts:166-186`）。旗标存 hub DO 内存 Set（bb `hub.ts:851-860` 同构，take=读清）；消费点=下次被拒握手（bb `internal/session.ts:56`）。
- **G12 404 形状**：读面（GET /hosts/:id、GET provider-clis/status）销毁行改答 404 `host_unavailable` "Host is unavailable" + details `{reason:"destroyed", hostStatus:null, suspendedAt:null, destroyedAt}`（bb `entity-lookup.ts:115-131` + `lifecycle-api-errors.ts:149-158`）；变更面（PATCH/retry-update/DELETE）按 bb `requireMutableHost`（`routes/hosts.ts:40-46`）对销毁行一律 404 `host_not_found`——只有读面区分墓碑，bb 语义原样。

### S4 删除终局（消 G11）

- DELETE 序（bb `routes/hosts.ts:188-217`）：主 host 拒删 → 关停 DO 会话 → 软销毁 → `host-disconnected` 广播。
- **主 host 裁定**：bb 级联 `dataDir ?? 单连通 ?? 单公开`（`primary-host.ts:70-76`）移植时**去 dataDir 项**（组合部署无服务端 host id 文件）：唯一 connected host 优先，否则唯一存活 host；两者皆无 → null（都可删）。两台都连通时 primary=null，与 bb 一致。
- **会话关停**：DO 新 RPC `closeSession({hostId, reason:"expired"})`——journal `session_closed`（新 op，fold 置 `state.session=null`，重放一致）→ 顶替路径同款 waiter 清算 → 关 live socket（后续 `webSocketClose` 因 session 已 null 不再重复广播，bb `handleHostRemoved` 注释的同款"先关行再关 socket"序）→ 单次 `host-disconnected` 广播；随后软销毁 + 路由层第二帧 `host-disconnected`（bb 数据层 destroy 翻转检测同样多发一帧，`data/hosts.ts:50-52`）。
- **凭据吊销偏差（记档）**：bb DELETE 还吊销 host auth keys（`routes/hosts.ts:200-203`）。我方 POC 凭据模型只有一把部署级 env key（DO mirror 由部署身份 DO 持有，非 per-host），**没有 per-host 凭据可吊销**——该步随 M1 key registry 落地（G8 家族）。残余洞：env-key rig 下已删 host 的 daemon 仍可重开会话（幽灵 DO 会话），但行永不复活（upsert `WHERE destroyed_at IS NULL`）且 /hosts 永不列出；组合部署的 KV/DO 鉴权梯在 M1 前维持现状。

### S5 路由形状（消 G13）

- `GET /hosts/:id/provider-cli-status` → `GET /hosts/:id/provider-clis/status`（bb 合同唯一形状，`public-api.ts:679`；SPA 为钉版 fork，服务端就形）。502 `host_unavailable` "Host is not connected" 降级语义不变（daemon-RPC 传输仍 crop，见 S7）。
- G10 owner/machine 鉴权分界维持原裁定：随多机/机器凭据体系一并做（bb `assertHostManagementAllowed` 形状已录 §2 E3）。

### S6 裁决：lastSeenAt 保 30s SQL 节流（G6 关闭为"接受偏离"）

**裁定：保持现状。** 依据：

1. 写额保护是硬约束——心跳 5s 每帧写 D1 会在单 host 下烧掉免费档配额的显著份额，fleet 化后线性放大（`hosts-registry.ts:5-17` 论证维持有效）；
2. bb 每帧 stamp 依赖本地 SQLite 零额限制，Cloudflare D1 无此条件——**环境不同构**，bb 精度不可平移；
3. 功能面无消费方：/hosts status 是读时派生（DO hostLiveness），SPA 对 lastSeenAt 的唯一消费是 "last seen X ago" 文案（§4），30s 粒度下文案偏大 ≤25s，无任何判读逻辑受影响；
4. 若未来需要 bb 级 5s 新鲜度，单点旋钮 `LIVENESS_PROJECTION_INTERVAL_MS` 降至心跳窗即可，代价写额 ×6（§6 S6 预案保留）。

与 bb 的分歧正式记为 ARCHITECTURE 偏离：**last_seen 写入节奏 bb 每帧（≤5s 旧）/ 我方心跳帧 + ≥30s SQL 节流**；§7 常量对照 G6 行相应改判。

### S7 裁决：join-codes 与 daemon-RPC 五件套维持 crop（G8/G9 不动）

- **G8 join-codes（E13）**：依赖 M1 key registry（per-host enrollKey 签发/吊销体系；S4 的凭据吊销偏差同点收口）。POC 静态 env ENROLL_KEY 维持，不开票。
- **G9 daemon-RPC 五件套（E7 directory / E8 clone-default-path / E9 paths-exist / E10 pick-folder / E12 provider-cli install）**：依赖 #30 DO→daemon RPC seam（matrix E8 crop 裁定仍有效）。SPA 离线文案兜底路径已由 S5 统一后的 502 `host_unavailable` 覆盖，行为近似合同。不在 host 面单独开票。
- E11 status 的 RPC 实装同样待 #30；当前 502 常量应答是 crop 裁定的一部分（`routes/hosts.ts` 注释维持）。

### 缺口矩阵收账

| 缺口 | 状态 |
|---|---|
| G4 name 采集 | ✅ 关闭（S3） |
| G5 lastRejectedProtocolVersion 生命周期 | ✅ 关闭（S3） |
| G6 lastSeenAt 精度 | ✅ 裁决关闭：接受 30s 偏离（S6） |
| G7 E5 retry-update | ✅ 关闭（S3） |
| G11 E6 删除终局 | ✅ 关闭（S4；凭据吊销 → M1） |
| G12 E2 404 形状 | ✅ 关闭（S3） |
| G13 E11 路径字面量 | ✅ 关闭（S5） |
| G8 join-codes / G9 daemon-RPC 五件套 | ⏸ 维持 crop（S7；M1 key registry / #30 seam） |
| G10 owner/machine 鉴权 | ⏸ 维持原裁定（多机凭据体系时一并） |

> AGENT GENERATED: by zhipu-coding-plan/glm-5.3-flash (research lane #187)
