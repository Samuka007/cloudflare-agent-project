# workspace/host 路由两源对照：bb 绑定模型 + omp host:path 语义（#80 前置研究）

研究对象与版本锁定：

- **bb**：`/home/nixos/workspace/bb`，HEAD = `8473d8c33`（与 `bb-daemon-protocol.md` 同一提交，行号互认）。
- **omp**：`/home/nixos/workspace/oh-my-pi`，HEAD = `9b9886514`（Merge PR #13885）。

目的：为 #80 给出两源各自**现成的** workspace/host 路由语义地图；#73（grilling）只裁真正的残余空白。结论先行：**除「跨设备离线续聊」外，两源对线程↔主机↔工作区的绑定、覆盖、权限与迁移都已有既定形状**，本文逐条给证据；§3 标注唯一共同空白。

---

## 1. bb：thread → host/workspace 绑定模型

### 1.1 数据模型：绑定链是 `threads → environments → (hosts × path)`

四张表构成绑定链（`packages/db/src/schema.ts`）：

| 表 | 键与语义 | 位置 |
| --- | --- | --- |
| `hosts` | `id, name, type(HostType), connectMachineId, maxPermissionMode, destroyedAt, lastSeenAt` | `schema.ts:88-106` |
| `project_sources` | 项目在某台 host 上的源 checkout：`(projectId, hostId, path)`，`type='local_path'`（CHECK 强制 hostId/path 非空），`isDefault`；唯一索引 `(projectId, hostId)` | `schema.ts:450-483` |
| `environments` | **绑定单位**：`(projectId, hostId NOT NULL, path)`；`managed/isGitRepo/isWorktree/branchName/baseBranch/defaultBranch/mergeBaseBranch`、`workspaceProvisionType`、`status`（默认 `provisioning`）；唯一索引 `(projectId, hostId, path)`，注释明示「workspace path 按 project 声明，不全局占用；两个 project 可指向同一目录」 | `schema.ts:485-536` |
| `threads` | `projectId NOT NULL` + `environmentId` **可空**，`ON DELETE SET NULL` | `schema.ts:538-547` |

要点：

- **environment = (host, 目录, 供给方式)**。thread 绑 environment，不直接绑 host/path；`threads.environment_idx`、`threads_environment_archived_deleted_idx` 都以 environmentId 为前导列（`schema.ts:602`、`620-624`）。
- thread 的 environmentId 是**可变的**：`updateThread` 接受 `environmentId`，变更时追加 `environment-changed` 事件（`packages/db/src/data/threads.ts:1601-1650`，`1638-1642`）。环境销毁后 thread 存活（environmentId 置 NULL）。
- 「thread 的工作机器」的规范读法：`resolveEnvironmentHostId`，注释即定义——"The machine a thread's work lands on, or null before it has an environment"（`apps/server/src/services/hosts/permission-ceiling.ts:42-46`）。
- `workspaceProvisionType` 四值：`unmanaged`（只验证既有 path）/ `managed-worktree`（从源 checkout 建 git worktree）/ `reconnect-managed-worktree`（重连既有 worktree）/ `personal`（host dataDir 下的个人 scratch 区）（`packages/host-workspace/src/provision.ts:74-115`；domain 侧判别联合 `packages/domain/src/environment.ts:1049-1068`）。

### 1.2 运行时路由链：一个 turn 如何落到某台机器

server 侧每次下发 thread 命令都做同一步解析：

1. 取 `thread.environmentId` → `environments` 行，要求 `status === "ready" && path` 非空，否则 4xx `throwEnvironmentNotReady`；产出 **`WorkspaceCommandTarget { environmentId, hostId, workspaceContext: { workspacePath, workspaceProvisionType } }`**（`apps/server/src/services/environments/workspace-command-target.ts:33-50`）。
2. 以 `hostId` 寻址：`runLiveHostCommand` / `callHostRetryableOnlineRpc({ hostId, timeoutMs, command })`，经 hub 找到该 host 的 daemon WS 会话发 `host-rpc.request`（调用点遍布 `apps/server/src/routes/threads/*`、`services/queued-messages.ts:344-427` 等；hub 机制见 `bb-daemon-protocol.md` §2.2B）。
3. 防串机守卫：凡带 environmentId 的请求都校验 `environment.hostId === session.hostId`，不符即 403（`apps/server/src/internal/session.ts:171-175`、`interactive-requests.ts:132-136`、`tool-calls.ts:66-70`）。
4. daemon 侧按 `environmentId` 装载 runtime：`ensureEnvironment({ environmentId, workspacePath, workspaceProvisionType })`；**已装载 environment 的 path 与命令携带的不一致 → 显式失败 `workspace_type_mismatch`**（`apps/host-daemon/src/command-dispatch-support.ts:228-251`，`229-234`）。refresh 路径同样拒绝换 path（`apps/host-daemon/src/runtime-manager.ts:1024-1028`）。
5. 每个环境一个 runtime，创建时传入 `workspacePath: workspace.path` + `additionalWorkspaceWriteRoots`（`runtime-manager.ts:1361-1365`）；provider 桥为每条 thread spawn `omp --mode rpc --cwd <workspacePath>` 子进程（`packages/agent-runtime/src/omp/bridge/bridge.ts`，launch options `cwd: params.cwd` 在 `bridge.ts:1181-1186`；进程形状见 `bb-daemon-protocol.md` §1.2）。
6. thread 的宿主侧存储同样按 host 解析：`threadStoragePath = <daemon dataDir>/thread-storage/<threadId>`，server 从 `environment.hostId` 的会话上取（`apps/server/src/services/threads/thread-storage.ts:34-42`、`thread-runtime-config.ts:323-338`）。

### 1.3 换绑/迁移语义（bb 已有的形状）

- **换 environment（含跨 host）= DB 换绑 + 新环境重新 provision**。thread 可改 `environmentId`（§1.1）；命令流对换绑的处理是：旧 environment 的 runtime 让在途 turn 跑完，新命令路由到新 environment 的 runtime 并对新 runtime 调 `resumeThread`（daemon 侧行为有专项测试：`apps/host-daemon/src/command-dispatch.test.ts:870-878` 换绑注释、"The switch moves the thread mid-turn"；`:613-617` 断言 `newRuntime.resumeThread` 收到新 workspacePath）。
- **provider 会话的续聊凭据是 `ompRecovery` 描述符 `{ sessionId, sessionFile }`**，其中 `sessionFile` 是 **daemon 主机上的本地路径**（schema `bridge.ts:161-165`；resume 无描述符且无存活会话则显式报错 `bridge.ts:1720-1763`，`1743-1747` 校验 `providerThreadId === ompRecovery.sessionId`）。server 把描述符存进事件流并可在下个 turn 回放（`apps/server/src/services/threads/thread-commands.ts:191-267`），但**文件本身不迁移**。
- **host 离线的既定行为**：turn 下发前 `ensureHostSessionReadyForWork(hostId)` 不满足即失败；周期清扫对 `!hasDaemonForHost(host)` 的环境**显式顺延**并计数（`apps/server/src/services/periodic-sweeps.ts:193-223`）；排队消息等 host 回来再发（`services/queued-messages.ts`）。没有把 provider 会话搬到另一台 host 的路径。

### 1.4 UI/CLI surfaces（绑定的可见面）

- **统一显示格式化**：`formatEnvironmentDisplay` 输出 `modeLabel`（自定义环境名 / "Provisioning" / "Working locally" / "Working remotely" / "Worktree"）与 compact 版（"Local"/"Remote"），供 app、CLI、composer 标签共用；host 上下文带 `locality: local|remote` 与 `{ name, connected }` 身份，注释明示用于「multi-machine surfaces that name the machine (thread metadata, offline notices)」，且单机时**不具名**（`packages/core-ui/src/environment-display.ts:6-18`、`43-95`）。
- **thread API 响应**内联 host：有 environment 时附 `host = getNonDestroyedHostWithStatus(environment.hostId)`（`apps/server/src/routes/threads/base.ts:116-118`）；thread 列表查询 join environments 带出 `environmentName/environmentWorkspaceProvisionType`（`packages/db/src/data/threads.ts:546-551`）。
- **CLI**：`bb status` 打印当前 project/thread/environment（`Environment: Working locally (env-1)`，`apps/cli/src/__tests__/command-output/status.test.ts:60-62`）；`bb environment status <id>` 任意环境巡检；选择器纪律——`--environment` 与 `--machine/--host` **互斥**，报错文案 "the environment already selects its machine"（`project.test.ts:353-355`）；终端按 `--thread`/`--environment`/machine 三种 scope 创建（`terminal.test.ts:66-76`）。

### 1.5 bb 侧小结

| 维度 | 既定语义 | 证据 |
| --- | --- | --- |
| 绑定单位 | environment = (projectId, hostId, path) 唯一；thread 绑 environmentId（可空、可改） | `schema.ts:485-536`、`538-547`、`data/threads.ts:1638-1650` |
| 路由 | turn → requireWorkspaceCommandTarget → hostId → daemon WS → per-env runtime → omp 子进程 `--cwd` | `workspace-command-target.ts:33-50`、`runtime-manager.ts:1361-1365` |
| 防漂移 | 换 path = `workspace_type_mismatch`；跨 session.hostId = 403 | `command-dispatch-support.ts:229-234`、`internal/session.ts:171-175` |
| 迁移 | 换绑 environment 支持（含 mid-turn）；provider 会话凭据 = host 本地 `sessionFile` 描述符 | `command-dispatch.test.ts:870-878`、`bridge.ts:161-165` |
| 离线 | host 掉线 → 命令失败/顺延/排队；无跨 host 会话搬运 | `periodic-sweeps.ts:193-223`、`queued-messages.ts:344-427` |

**【GAP-bb】跨设备离线续聊**：thread 的对话正本在 server DB，但 provider 会话正本（omp session file）只在原 host 的 `thread-storage`/dataDir（§1.2 第 6 点、§1.3 描述符语义）。host 永久离线后，换新 host 重建 environment 只能靠 server 事件流重放上下文，**没有既定的「携带 session file 到新 host 续聊」机制**。这是空白，不是设计缺陷声明——bb 显然选择了「会话文件留在执行机」的模型。

---

## 2. omp：工具参数级 host:path 覆盖 + workspace 绑定默认

### 2.1 workspace 绑定默认：单 cwd 进程绑定

- **启动时定死**：会话 cwd = `parsed.cwd ?? getProjectDir()`（`--cwd` 显式旗标经 `applyStartupCwd` 持久化；`packages/coding-agent/src/main.ts:1287`、`:33`）。
- **resume 重绑**：恢复会话时 `switchToResumedProject` 把整个进程迁到会话记录的 cwd，失败则显式回退启动 cwd 并告警（`main.ts:879-937`，回退分支 `:900-901`、`:916-935`）；记录 cwd 已消失时提示 "Move (re-root) it into the current directory?" 并 `SessionManager.moveTo` 重根（`main.ts:782-783`、`:868-874`）。
- **工具侧消费**：`ToolSession { cwd, additionalDirectories? }`——cwd 是唯一默认根，`additionalDirectories` 是多根扩展并转发给 subagent（`packages/coding-agent/src/tools/index.ts:208-212`）。所有相对路径解析都过 `resolveToCwd`（`tools/path-utils.ts:307-308`；读路径 `resolveReadPath` `:1203-1206`）。
- **bb 作为宿主时的对应**：bb 桥给每个 thread spawn `omp --mode rpc` 并以 `thread/start.params.cwd` 传 environment path（§1.2 第 5 点）——omp 的「workspace 绑定」在 bb 里就是 environment.path 的下游投影。
- ACP/RPC 宿主可为每个 `session/new` 提供任意 client-supplied workspace，settings/session manager 均按该 cwd 重建（`main.ts:520-548`）。

### 2.2 工具参数级覆盖：path 参数即内部 URL，host:path 是 per-call 逃生舱

核心机制是一个 **process-global scheme registry**：`InternalUrlRouter`（`packages/coding-agent/src/internal-urls/router.ts:84-88`），「tools consult the router instead of branching on scheme names」，system prompt 按 handler 的 `promptDoc` 动态列出可用 scheme（`types.ts:4-8`）。已注册 scheme（`internal-urls/index.ts:11-32` 的 handler 全集）：

- **文件背书**：`local://`（会话内共享工件）、`ssh://`（远端 host:path，见下）、`artifact://`、`history://`、`skill://`、`rule://`、`omp://`、`cfg://`、`vault://`、`memory://`、`mcp://`、`issue://`/`pr://`、`xd://`、`agent://`、`security://`、`attachment://`、`conflict://`、`proc://` 等。
- **ssh:// 的既定语义**（`internal-urls/ssh-protocol.ts`）：
  - 形状 `ssh://host/<path>`，bare `ssh://` 列已配置主机（`:258-269`、`:338-348`）；agent 面文档一行契约："remote UTF-8 file/dir (max 1 MiB) for read/write/grep; bare lists hosts. Encode `:` `?` `#` as %3A %3F %23. Needs verified POSIX shell; else bash remote SSH or sshfs"（`prompts/internal-urls/ssh.md:1`）。
  - authority 解析：配置名（项目/托管 `ssh.json` capability，`:94-98`）优先；URL 里字面 `user@`/`:port` 是**覆盖**，但对已配置 bare 名拒绝（ControlMaster 缓存按 name 键），否则按不透明 OpenSSH destination 处理（`~/.ssh/config` alias 直接可用）（`:119-127`、`:207-239`）。IPv6、percent-escape、空 port/空 user、密码认证各有显式拒绝（`:128-206`）。
  - 能力上限明示：UTF-8 文本 ≤1MiB（`:45-46`、`:296-300`）；目录只出一层 listing 且 `immutable`、不许被 grep（`:317-336`；搜索拒绝有专项测试 `coding-agent/test/tools/grep-internal-urls.test.ts:700-730`）；FIFO/socket/device 拒绝并指引改用 `bash` 远程 SSH（`:287-291`）；二进制拒绝并指引 sshfs（`:301-306`）。
  - 写路径：`write` 由 handler 执行，`payload: "text"`、tier 恒 `exec`（`:360-364`；spec `:250`）。
- **bash 的 per-call cwd**：`cwd?` 是工具参数（`tools/bash.ts:335`）；缺省用 `this.session.cwd`，相对 cwd 解析 `resolveToCwd(cwd, this.session.cwd)`（`:1013`）；甚至接受 **URL cwd**（`virtualCwd`，仅内嵌 shell 文件系统可进入，service/PTY/客户端终端等外部后端拒绝，`:1005-1031`）；模型忘传 cwd 时从命令里提取 `cd <path> && …` 前缀（`:944-956`）。
- **selector 语法跨 scheme 一致**：`:N-M`/`:raw` 读选择器在 URI 之后剥离，`ssh://host:2222` 的尾 `:N` 是端口不是选择器（`packages/tui/src/tools/read.ts:164-166`；`split-internal-url-sel.test.ts:88-96`）；写工具只接受整文件选择器并拒绝行段（`ssh-url-approval.test.ts:62-75`）。

### 2.3 权限层级：远端 = exec 档，工具按 spec 裁决而非按 scheme 名分支

- `SchemeSpec.readTier` 默认 `read`，`ssh://` 显式 `exec`（`types.ts:115-116`；`ssh-protocol.ts:244-251`）。审批门实测：read/grep/write 对 `ssh://` 目标一律 exec 档（等价本地路径保持 read/write 档），含 hashline 包裹、grep 分隔串内嵌等绕过形态都被 substring 扫描兜住（`coding-agent/test/ssh-url-approval.test.ts:34-58`、端到端 wrapper 测试 `ssh-url-approval-gate.test.ts:13-16`）。
- 无 UI 时的安全契约：read/write 档工具（glob、ast_grep/ast_edit 等）**在建立任何 SSH 连接前**拒绝 `ssh://`——测试明确「a read/write-tier tool never calls resolve (never connects) for an ssh:// path」（`ssh-url-ungated-tools.test.ts:25-62`）。
- write 策略三要素 `via/payload/scope/tier` 由每个 scheme 自己声明， mutating 工具据此裁决（`types.ts:83-95`）。

### 2.4 omp 侧小结

| 维度 | 既定语义 | 证据 |
| --- | --- | --- |
| 默认绑定 | 单 cwd（启动 `--cwd`/resume 重绑），相对路径一律 `resolveToCwd` | `main.ts:1287`、`:879-937`、`path-utils.ts:307-308` |
| per-call 覆盖 | 任何 path 参数可写内部 URL；`ssh://host/path` 即跨机读写；bash 另有 `cwd?` 参数（含 URL cwd） | `router.ts:84-88`、`ssh-protocol.ts:242-256`、`bash.ts:335`、`:1005-1031` |
| 主机身份 | 无注册表：`ssh.json` capability 命名主机 + 不透明 OpenSSH destination；连接经共享 ControlMaster | `ssh-protocol.ts:94-98`、`:207-239`、header `:5-7` |
| 权限 | 远端读写 = exec 档；read/write 档工具连接前硬拒 | `types.ts:115-116`、`ssh-url-approval*.test.ts` |
| 会话持久 | 本机 session JSONL；resume 支持换 cwd 重根（moveTo），文件本身不跨机同步 | `main.ts:782-783`、`:868-874` |

**【GAP-omp】跨设备离线续聊**：session 文件是本机 JSONL，`moveTo` 只解决「项目目录搬家后重根」，没有任何两台设备间的会话同步/拉取语义——在 B 设备续 A 设备的会话需要自行搬运文件。与 GAP-bb 同根：会话正本属地是执行机。

---

## 3. 两源对照与 #73 残余空白

| 维度 | bb | omp |
| --- | --- | --- |
| 绑定单位 | environment（DB 行：hostId+path+供给方式），thread 外键绑定、可换绑 | 进程 cwd（会话元数据记录），启动/续聊时绑定 |
| host:path 覆盖层级 | **重量级**：换 = 新 environment provision + DB 换绑 + 事件流 | **轻量**：工具参数级 per-call URL，零状态变更 |
| 远端执行面 | 常驻 host-daemon（hostKey enroll、WS 控制面、envLane 串行） | 无常驻：按需 ssh + 共享 ControlMaster，能力上限 1MiB 文本 |
| 权限模型 | host 级 `maxPermissionMode` + provider permissionMode + 403 串机守卫 | tier 模型（read/write/exec），远端强制 exec 档 |
| 会话正本 | server DB 事件流 + host 本地 thread-storage/omp session file | 本机 session JSONL |
| 离线行为 | 命令失败/顺延/排队，等 host 回归 | 不适用（无服务端） |

**真正的空白（两源共同，且仅此一项）**：**跨设备离线续聊**——bb 换 host 后无 provider 会话搬运机制（sessionFile 属地主机的 `thread-storage`），omp 无会话文件跨机同步语义。其余问题（绑定形状、路由、per-call 覆盖、权限、迁移、UI 呈现）在两源中都是**已回答的既定语义**，#73 的 grilling 不应把它们当开放问题。

> 行号漂移免责：bb 行号基于 `8473d8c33`，omp 行号基于 `9b9886514`；上游前进后以结构结论为准。
