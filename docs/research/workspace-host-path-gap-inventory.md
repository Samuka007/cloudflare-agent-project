# workspace/host:path 语义落地差距盘点（#259）

目的：把 #73（产品裁决）、#80（两源地图）、`docs/design/control-plane-layer.md` §2（机制裁决）对照本仓当前代码，按四个面盘点「已达成 / 缺多少」，并给出切票。代码基线 = 本 lane 分支 `lane/259-w4-workspace-host-path`（bb submodule @ `d2ab40f0`）。

裁决输入（不再重复论证）：

- 绑定 = 轨迹数据：`thread.created{machineId}` 一次冻结、重放即真值、每派发零绑定查找（层文档 §2.1）。
- host:path 覆盖 = 工具参数级、单次派发换 machineId + `tool.dispatch` 落偏差、永不重写绑定（层文档 §2.2）。
- 宿主离线 = 执行悬置：消息可发、模型可回、Host Execution 显式拒绝、turn 诚实完成（#73 Q1 用户裁决）。
- 会话可携带性 / 纯云降级 = 显式延后（#73 Q2）。

---

## 1. 已达成（无需切票）

| 机制 | 证据 |
| --- | --- |
| 绑定进轨迹：`thread.created{title, machineId}` | `packages/agent-do/src/fsm-events.ts:73-77`（注释「Machine this thread's tool executions are bound to」） |
| 重放冻结：`state.machineId` | `packages/agent-do/src/turn-state.ts:210-218` |
| 派发按重放态解析 service DO；帧带 machineId | `packages/agent-do/src/agent-do.ts:2223-2231`、`packages/agent-do/src/daemon.ts:17-26` |
| 串机/离线显式失败，不挂起：`host_offline` 三态 outcome；mis-route 同路径 | `packages/agent-do/src/daemon.ts:28-35`、`packages/daemon-service/src/service-do.ts:227-231,347-350`、客户端镜像校验 `packages/daemon-service/src/client/tool-runtime.ts:467-473` |
| 执行悬置的轨迹半边：每 turn 一次 `turn.phase{host_lost, reason:"host_offline"}` + host 工具按 error 结果诚实入账 | `packages/agent-do/src/agent-do.ts:1463-1471`、`fsm-events.ts:49,119`；协议错误码 `machine_unavailable`(503, retryable) + `system/error` category `machine_disconnected`（`packages/protocol/src/errors.ts`、`events.ts:117`） |
| 客户端面绑定选择契约（bb 形状已移植） | `apps/server-worker/src/contract/api/shared.ts:88-145`：`workspaceArgsSchema`（unmanaged/managed-worktree/personal）、`reuseEnvironmentSchema`、`hostEnvironmentSchema{hostId, workspace}`、`projectDefaultEnvironmentSchema`；`POST /threads` 已解析 `environment` 字段（`apps/server-worker/src/routes/threads.ts:127`） |
| D1 侧形状占位 | `threads.environment_id` 列存在（`apps/server-worker/migrations/0001_control_plane.sql:74`）；ws hub `notifyEnvironment`（`apps/server-worker/src/ws/hub.ts:147-155`）；change-kinds 含 environment-detail/list |
| per-cwd 工具宿主重建先例（多工作区的在仓桥形） | `packages/daemon-service/src/client/task-isolation.ts:332-342` `viewFor(cwd)` + `ToolRuntime.execute:626-647`——隔离视图已按目录重建 omp 工具集 |

结论：**机制层（轨迹绑定、显式失败、悬置轨迹）与契约词汇（environment args）已就位且与 §2 一致；缺口全部在「喂值链、workspace 数据模型、参数级覆盖、daemon 多工作区、SPA 可见面」五处，归并为四张票。**

---

## 2. 缺口盘点

### A. 绑定喂值链断裂 + workspace 数据模型缺失（→ 票 1，P1）

现状：`POST /threads` 接受 `environment` 选择但**静默丢弃**——`apps/server-worker/src/routes/threads.ts:285-288` 只调 `createThread({threadId, title})`；`packages/agent-do/src/agent-do.ts:430` 落 `machineId: request.machineId ?? "local"`（层文档早已点名「M0 缺陷只在上游喂值：单机常量」，至今未接）。

缺：

1. **解析函数** `environmentArgs → {machineId, workspace}` 不存在（层文档 §2.1 绑定来源链第 1-2 优先级无实现）。
2. **`environments` 表不存在**：migration 全文件无 `CREATE TABLE environments`；`threads.environment_id` 无生产者/读取方。bb 锚形：`environments = (projectId, hostId NOT NULL, path)` 唯一 + `workspaceProvisionType` + `status`（两源地图 §1.1，bb `schema.ts:485-536`）。
3. **project 级 workspace 绑定默认列**：projects 表无该字段（层文档 §2.1 明文「D1 projects 行字段，M1 新增」；`0001_control_plane.sql` projects 表可证）。
4. **显式换绑事件**：事件词汇无 rebind/environment-changed 类型（`fsm-events.ts` 全集可证）；§2.1 换绑机制无载体。
5. **协议契约漂移**：`packages/protocol/src/http.ts:41-48` 的 `createThreadRequestSchema` 无 `environment` 字段，server-worker 路由自行扩展（`threads.ts:127`）——违反「协议定义唯一住 `packages/protocol`」的项目约定，需回迁。
6. **执行绑定 ↔ D1 绑定无对账**：`thread.created.machineId`（执行真相）与 `threads.environment_id`（控制面行）目前互不知晓。

### B. host:path 参数级覆盖缺失（→ 票 2，P2）

现状：全链路无覆盖语义。工具 path 参数是普通字符串（`packages/agent-do/src/tools/registry.ts:129-132,367,378`）；`tool.dispatch` 事件无 machineId/偏差字段（`fsm-events.ts:188-196`）；AgentDO 派发只从 `state.machineId` 取值（`agent-do.ts:2227`）。若帧真带异机 machineId，客户端按错投拒绝（`client/tool-runtime.ts:467-473`）——即今天实现覆盖会先撞上防串机红。

缺：

1. 覆盖语法与解析（omp 锚形：任意 path 参数可写 `ssh://host/path`，process-global router 分发，两源地图 §2.2，omp `internal-urls/router.ts:84-88`、`ssh-protocol.ts:242-256`）。
2. 单次派发 machineId 换乘 + `tool.dispatch` 偏差记录（additive 可选字段，层文档 §2.2「零协议变更」——帧已有字段，事件缺字段）。
3. 未注册 host 的覆盖 = 显式 `unknown_host`/`host_offline` 失败，不降级默认机（层文档 §2.2 末条）。
4. 权限档：远端路径强制 exec 档；read/write 档工具连接前硬拒（omp `types.ts:115-116`、`ssh-url-ungated-tools.test.ts:25-62`）。
5. bash 的 per-call `cwd?` 逃生舱已半存在（帧 cwd→executor，`client/connection.ts:277-315`、`client/executor.ts` resolveCwd）但仅 sandbox 相对——纳入本票统一语义。

### C. daemon 多工作区缺失（→ 票 3，P1）

现状：**一进程一工作区**。`--sandbox`/`DAEMON_SANDBOX_ROOT`（默认 `/tmp/cap-sandbox`）→ 单一 `ToolRuntime` 惰性单例（`client/index.ts:44`、`client/connection.ts:61-66,392-398`）；ToolHost 以 sandbox cwd 构建一次（`client/tool-runtime.ts:197-218`，`setAgentDir` 全局重钉）；`tool.exec` 帧无 workspace 字段（`packages/daemon-service/src/protocol.ts:193-196`）；仅 bash 有 sandbox 相对 cwd 钳制（`client/tool-runtime.ts:435-456`）。

缺：

1. 帧上 workspace 语义：`tool.exec`/`exec.spawn` 携带 workspace 标识；缺省回退 sandbox（向后兼容）。
2. per-workspace ToolHost 键控表：把 `task-isolation.viewFor(cwd)` 的按目录重建模式升为一等 workspace（隔离视图是先例，非设计从零）。
3. path 漂移显式失败：bb `ensureEnvironment` 的 `workspace_type_mismatch` 锚形（两源地图 §1.2，bb `command-dispatch-support.ts:228-251`）。
4. 进程级单例解钉：`setAgentDir` 全局、omp resolver 冻结、eval kernel 注册表（module-level，已按 `(sessionId, cwd, interpreter)` 键控，`client/eval-kernel.ts:35-39`，多 cwd 安全但需审计生命周期）。

### D. SPA workspace 可见面缺失（→ 票 4，P1，依赖票 1）

现状：服务端可喂的绑定数据为零——`ThreadSummary` 无 environment/host 内联（`packages/protocol/src/http.ts:21-31`）；无 `GET /hosts`、无 environments 路由（`packages/protocol/README.md` §1：hosts 12 + environments 12 全列 deferred）；sidebar-bootstrap 极简。钉死的 bb SPA（@`d2ab40f0`）可见面已备齐等数据：`formatEnvironmentDisplay` 用于 thread 头（`bb/apps/app/src/plugin/PluginThreadChat.tsx:8-10,179-183`）、EnvironmentPicker/WorktreePicker/RenameDialog、AddMachineDialog（接入门归 #258）、host offline 态。

缺：

1. 读面：thread 响应内联 host/environment（bb 锚形 `routes/threads/base.ts:116-118`）；最小 `GET /hosts`（id/name/status/lastSeen）。
2. 悬置呈现：`turn.phase{host_lost}` 已在事件流与 WS metadata，SPA 时间线呈现（消息可发/模型可回/Host Execution 拒绝占位）未接线。
3. 执行悬置（#73 Q1）与纯云降级（future）、可携带性（future）的 UI 词汇按 CONTEXT.md 落地。

---

## 3. 切票

| 票 | 面 | 优先级 | 依赖 |
| --- | --- | --- | --- |
| 1 绑定喂值链 + environments 数据模型（A1-A6） | 路径路由 | P1 | 无（keystone） |
| 2 host:path 参数级覆盖 + 偏差记录（B1-B5） | 路径路由 | P2 | 票 1（同文件串行 + 偏差需绑定语义） |
| 3 daemon 多工作区（C1-C4） | daemon | P1 | 无硬依赖；帧字段与票 1/2 协调（缺省回退 sandbox 保证独立可落） |
| 4 workspace 绑定可见面 + 悬置呈现（D1-D3） | SPA | P1 | 票 1（无数据可显） |

预算（参考类）：票 1 ≈ 控制面移植类往例（#29 seam / #49 attach bridge / #62 hosts-registry，均一个 lane 日级）→ 1 lane 日；票 3 ≈ T20 task-isolation 单票实测 + #125 spike 已证嵌入 → 1 lane 日；票 2 ≈ #274（protocol additive 字段 + 投影）→ 0.5-1 lane 日；票 4 ≈ W3 SPA 面票（CoT surface）→ 1 lane 日。票 1/2 零新增每派发 DO 跳（绑定解析只在创建时付一次，practice 11）。

## 4. 显式延后（有裁决，不切票）

- **纯云降级（Cloud-only Failover）**：#73 裁决为执行悬置的进化候选，未排期。
- **会话可携带性**：#73 Q2 显式延后（M2+ 或按需）；两源共同空白（两源地图 §3）。
- **managed-worktree 供给**：`workspaceArgsSchema` 已含类型词汇，但 worktree provision 执行体（bb `host-workspace/src/provision.ts:74-115` 锚形）超出「path 语义成型」范围——票 1 只落 unmanaged/personal 两型，worktree 供给另行切票（在票 1 里留注）。
