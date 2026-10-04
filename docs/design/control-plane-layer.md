# 控制面连贯定义：harness/tool 注册 × host 路由 × 跨会话设置（#68）

> 工单：Samuka007/cloudflare-agent-project#68；类型：spec（零生产代码）。
> 脊柱输入：[omp-tool-execution-classification.md](../research/omp-tool-execution-classification.md)（下称「分类表」，branch research/tool-classification）的拆缝规则——**控制/状态面归 AgentDO，执行体归 daemon**。本层一切边界裁决都是这条规则的投影。
> 现状输入：`apps/server-worker/src/routes/{hosts,system}.ts`、`apps/server-worker/src/db/settings.ts`、`apps/server-worker/src/seam/agent-do.ts`、`packages/agent-do/src/{relay/wire.ts,agent-do.ts,fsm-events.ts,turn-state.ts,daemon.ts}`、`apps/daemon-worker/src/host-orchestrator-do.ts`、`packages/daemon-service/src/{service-do.ts,hosts-registry.ts}`、[bb-server-port-inventory.md](../research/bb-server-port-inventory.md) §1.2/§3。
> 既定裁决输入：总图 #1 Notes「Host addressing semantics: workspace binding + per-tool override, with explicit binding state in trajectory; no silent host switching」；engineering.md practice 7（两把钥匙）/ 10（移植保真）/ 11（DO 请求量预算）/ 12（PR-per-lane）；#17 裁定 Q4「harness 最小面」；#70 分类表三类归属。
> 消费者：#33（M1.5 工具集，§4 给接缝约束）、#14（M1 多机路由，§4 给接缝约束）、#73（host:path 产品语义 grilling，本文 §2 是它的形状底稿）、#80（bb/omp 路由考古，回填 §2 空白）。

## 0. 层图

控制面不是一个组件，是**一组共享同一条拆缝规则的职责**。自上而下：

```text
┌──────────────────────────────────────────────────────────────────────┐
│ bb SPA（逐字移植，零 agent 语义）                                       │
└──────────────┬───────────────────────────────────────────────────────┘
               │ /api/v1（Access JWT 只守前门，practice 7）
┌──────────────▼───────────────────────────────────────────────────────┐
│ 控制面 —— 本文定义的「一层」，三块共享一条拆缝规则：                    │
│   控制面归 DO（schema/裁决/绑定/设置的权威与轨迹投影）                 │
│   执行体归 daemon（fs/pty/natives，非权威、可替换）                    │
│                                                                      │
│  ① harness/tool 注册面          ② host 路由面          ③ 设置面       │
│  注册表住在 AgentDO；           绑定=thread.created     app 单行唯一  │
│  schema 照抄 omp 双资产 +       一次性冻结的轨迹数据；   权威；host 只 │
│  host/edge/hybrid 类标签        host:path 覆盖在工具    留收窄型操作  │
│  驱动后端选择                   参数层，不重写绑定      字段（ceiling）│
└──────┬───────────────────────┬───────────────────────┬───────────────┘
       │ createThread/         │ 绑定解析（一次性）      │ 读默认值
       │ sendMessage…          │ ▼                      │
┌──────▼───────────────────────┴───────────────────────┴───────────────┐
│ AgentDO（每 thread 一只）—— wire 面 = 注册表启用集；                  │
│ state.machineId = 绑定的重放投影（thread.created 携带，冻结）          │
│   出站缝：DaemonServiceClient{dispatch/kill/ackExecution/queryUnacked}│
│   executionId 自路由（threadId 前缀），machineId 显式在派发帧上        │
└──────┬───────────────────────────────────────────────────────────────┘
       │ 工具无关派发帧（分类表 §3.1：一条 daemon 链承载全部 host 工具）
┌──────▼───────────────────────────────────────────────────────────────┐
│ DaemonServiceDO（每机器一只）—— 会话/租约权威 + 执行 claim 权威        │
│ （unified-turn-state.md §1.2 模型二；hostKey 只守 daemon 接缝）        │
└──────┬───────────────────────────────────────────────────────────────┘
       │ WS + lease + offset 续传
┌──────▼───────────────────────────────────────────────────────────────┐
│ daemon client（每机器一个）—— 纯执行体：fs/pty/natives，无 agent 语义  │
└───────────────────────────────────────────────────────────────────────┘
```

注意三个「住在下层但不属于下层」的权威，避免层图误读：

| 权威 | 物理位置 | 为什么画进控制面层 |
| --- | --- | --- |
| 工具 schema 与启用裁决 | packages/agent-do（编译进 AgentDO） | 它裁决「模型看到什么工具面」，是控制职责；daemon 只收帧 |
| thread→host 绑定 | `thread.created` 事件（AgentDO 轨迹） | 绑定事实必须显式在轨迹（总图 #1 裁决），重放即真相 |
| 执行 claim（跑到哪/结果是什么） | DaemonServiceDO journal | 已由 unified-turn-state.md §1.2 裁给模型二，本文不改 |

三块与拆缝规则的关系：①决定**哪些工具存在、谁执行**；②决定**执行体落在哪台机器**；③决定**默认值与上限从哪读**。三块的扩展（#33 加工具、#14 加机器、settings 不动）都必须落在同一条脊柱上，这就是本票防碎片化的意义。

---

## 1. harness/tool 注册面

### 1.1 裁决：注册表住在 AgentDO，编译期模块注册，daemon 侧零能力协商

- **形状**：AgentDO 内一个静态注册表（模块常量 + 类标签），wire 装配按启用策略从中取集组装 `tools:` 数组。M0 现状已是此形状的最小实例：`wire.ts:77-98` 的 `BASH_TOOL`（omp 照抄：schema 来自 `packages/coding-agent/src/tools/bash.ts:330-337`，description 模板渲染 M0 条件全 false）+ `wire.ts:237` `tools: [BASH_TOOL]`。
- **不做 daemon 侧能力协商**。三个理由，全部有证据：
  1. bb 已裁定「provider 拥有工具面」是正解（`thread-runtime-config.ts:186-189` `providerOwnsRuntimeSurface` 分支，bb 对 OMP 不投影自己的工具 schema）——分类表 §5：照抄 omp 即完备，无对齐面。
  2. 能力协商会造出第二个 schema 权威，违反契约单一源（practice 1 的精神：omp 是工具面正本，edge 是透传投影）。
  3. 协商是运行时 DO 请求量（practice 11）：注册表是编译期资产，零请求。
- **注册表行形状**（#33 实现时的目标形态）：`{ name, schema（ArkType 照抄）, descriptionTemplate（prompts/tools/*.md 照抄）, class: "host"|"edge"|"hybrid", backend: 注册表自持的执行路由策略 }`。类标签直接取分类表 §2 三表结论（15 host / 11 edge / 7 hybrid；essential 13 = 8 host + 2 hybrid + 3 edge）。
- **照抄纪律的双资产**：schema 与 description 模板是同级资产（分类表 §2 序言），#33 两者都抄。运行时注入的 `i` intent 字段是 loop 层行为（`normalizeTools`），**不写进注册表行**（分类表 §6.6）。

### 1.2 裁决：类标签驱动执行路由，daemon 协议保持工具无关

- 注册表按类标签把工具调用路由到两个后端之一：
  - `edge` → AgentDO 本地（会话态落 DO storage，出站走原生 fetch）；
  - `host` → `DaemonServiceClient.dispatch`（executionId 幂等，machineId 显式）；
  - `hybrid` → 按分类表 §3.3 拆缝：控制/状态半在 DO，执行半按 backend 字段路由；后端可插拔类（learn/记忆四件/manage_skill 存储半）选 HTTP/DO-storage 后端即整体边缘化。
- **daemon 侧协议永不因新增工具而变**。派发帧 `{tool, arguments, executionId, machineId, timeoutMs}` 对工具名透明（`agent-do/src/daemon.ts:17-26`）；结果自路由回 AgentDO（`threadIdFromExecutionId`，execution-id.ts）。一条 daemon 链承载全部 host 工具、按工具名分派（分类表 §3.1，ida broker 同族先例）。
- **xdev 降级不进注册表语义**：降级只改 wire 呈现（17 个 discoverable 工具摘 wire 面经 read/write 派发），不改类标签与执行路由（分类表 §0）；设备处理器落哪侧随工具类。MCP 同理按传输分类：stdio→host，HTTP/SSE→edge 可承载（分类表 §4）。
- **注册面不归设置面管**（与 §3 的一致性钩子）：bb 的 dynamicTools/disallowedTools 工具策略设置对 omp 工具面**不适用**——provider 拥有工具面，edge 侧不设工具开关类 app 设置。启用策略（essential 集、类标签、xdev 开关）是注册表自身的编译期/部署期策略输入，不是跨会话设置。这条防止 settings 面长出与注册表矛盾的第二个工具裁决点。

---

## 2. host 路由面

### 2.1 裁决：绑定是轨迹数据，不是环境常量

现状证据链：`thread.created` 事件携带 `machineId`（`fsm-events.ts:54-55`，注释明言「Machine this thread's tool executions are bound to」）；重放把它冻进 FSM 态（`turn-state.ts:163-171`）；AgentDO 派发桩按 `state.machineId` 解析 service DO 名（`agent-do.ts:934-943`）。**绑定的轨迹形状已经存在且正确**——M0 的缺陷只在上游喂值：server-worker 组合路径用 `env.ORCHESTRATOR_HOST_ID ?? "local"`（`seam/agent-do.ts:127`），单机常量。

落裁决（总图 #1「workspace binding + per-tool override, with explicit binding state in trajectory; no silent host switching」）：

| 生命周期阶段 | 裁决 | 证据/落点 |
| --- | --- | --- |
| **绑定来源** | 创建时解析一次：thread 显式 host 选择 > project 级 workspace 绑定默认（D1 projects 行字段，M1 新增）> 部署默认单机 | 解析发生在 server-worker 创建路径；解析函数是控制面代码，不是 DO RPC |
| **绑定冻结** | `createThread({machineId})` 一发即冻：写进 `thread.created`，此后派发一律从重放态解析，**每次工具派发零绑定查找**（practice 11：路由成本只在创建时付一次） | agent-do.ts:199 `machineId ?? "local"` 已是此形状 |
| **绑定校验** | 组合路径 `ensureHost` 幂等校验，mismatch 即显式红（`seam/agent-do.ts:144-147` `host_mismatch`）——不静默改投 | HostOrchestratorDO per-host（idFromName(hostId)） |
| **换绑** | 只能显式：owner 会话操作 + 新绑定事件（新轨迹事件 + FSM 迁移）。离线 host 的换绑产品行为归 #73 grilling，本文只定机制：**系统侧永不自动换** | 总图 #1「no silent host switching」 |
| **跨 host 干活** | 不换绑当前 thread；派生 sub-agent thread 各自绑定目标 host（handoff 语义） | 总图 #1「handoff to sub-agent for cross-host work」 |

### 2.2 裁决：host:path 覆盖发生在工具参数层，永不重写绑定

- omp 的 host:path 是**工具参数级**语义（read/grep 等 path 字段可写 host 限定路径；#80 考古回填精确语义）——它表达「这一次调用去别的机器执行」，不是「这个 thread 搬家」。
- 路由层形状：AgentDO 解析出参数级覆盖时，**该次派发**的 `machineId` 换成目标机器（`idFromName` 解析对应 service DO），同时在 `tool.dispatch` 事件上记录偏差（目标 machineId）；结果自路由不受影响（executionId 前缀是 threadId 不是 machineId）。派发帧本就带 machineId 字段（daemon.ts:21）——缝已经留好，零协议变更。
- 绑定本身不动：下一次派发回到 `state.machineId`。偏差历史由轨迹事件承载（满足「explicit binding state in trajectory」），UI 展示归 #73。
- 未注册 host 的覆盖派发 = 显式 `host_offline`/`unknown_host` 失败，不降级到默认机器执行（静默换 host 红线同样适用于覆盖路径）。

### 2.3 责任边界与 DO 请求量预算（practice 11）

| 路径 | 必碰 DO？ | 边缘消化 | 说明 |
| --- | --- | --- | --- |
| thread 创建：绑定解析 | 否 | D1 读 project 绑定默认（边缘可缓存） | 解析是纯函数；命中部署默认时连 D1 都不碰 |
| thread.created 绑定冻结 | 是（AgentDO append ×1） | — | 一次性，创建路径本就存在 |
| 每工具派发 | 是（目标 service DO ×1） | 绑定从重放态解析，零附加查找 | 不为路由读 D1/其他 DO |
| host:path 覆盖派发 | 是（目标机器 service DO ×1） | 偏差记录并入既有 `tool.dispatch` 事件，无独立写 | 覆盖不产生额外 DO 会计 |
| /hosts 列表活性 | 否（D1 读） | 活性读时推导（hosts.ts:15-24 现状）+ 心跳 SQL 自节流投影（hosts-registry.ts） | #62 修复模式：投影写自节流 |
| 换绑操作 | 是（AgentDO 绑定事件 ×1 + 后续派发自然迁移） | owner 会话门（Access JWT + owner 判定） | 显式低频操作 |

归属裁定：**fleet 真相（有哪些机器、活不活）在 D1 hosts 表**（行由 #49 attach 桥创建，service DO 心跳投影刷新）；**thread 级绑定真相在轨迹**；两者用途正交（fleet 面答「机器状态」，轨迹答「这个 thread 在哪跑过」），不互相写。 orchestration journal（HostOrchestratorDO，per-host）是组合路径的命令审计半边，不是绑定的权威。

---

## 3. 设置面（跨会话/跨 host 设置的归属）

### 3.1 裁决：app 单行是唯一设置权威；host 行只留收窄型操作字段

- **现状即裁决**（bb 逐字，practice 10）：四族设置全部 app 单行/单键——`app_settings`（keyed "app_settings" 全行替换）、`system_experiments`（key/value 行）、`app_theme`、keybinding overrides（`db/settings.ts:11-16` 注释与实现，bb app-settings/experiments 移植）。票面「settings 维持现状」确认此基线，M1 不动。
- **per-host 扩展不开放**。host 行已有且只继续持有**操作字段**而非「设置」：`maxPermissionMode` ceiling（owner 会话专属修改，线程权限解析**向下**收敛到它，`contract/domain/host.ts:20-26`）。判据：**该值约束的是「这台机器允许发生什么」（操作上限）→ 归 host 行；该值是「人对 app 的偏好/配置」（跨机器同值）→ 归 app 单行**。为后者克隆 per-host 行是 n 行爆炸 + 漂移源，明令禁止。
- **执行影响值走四层优先级链**，每层只能收窄/具体化，不能静默放宽：

```text
部署 env（harness 三键：模型/中转/思考配置；resolveHarness 总解析，
  秘密只存 env，快照只存 key 存在性投影 —— provider-app/harness.ts）
  → app 单行（bb 四族，跨会话默认）
    → host 行操作字段（仅权限轴 ceiling，向下收敛）
      → thread 执行选项（#42，live/session 漂移分类同 harness）
        → 单次调用参数（tool.call timeoutMs、watchdog config patch）
```

  `classifyHarnessProjection` 的 unchanged/live/session 三值分类是链上「改了设置对在跑会话意味着什么」的通用形状；#42 的 thread 级 default-execution-options 复用同一分类语义（bb `classifyExecutionSettingsChange` 同构）。

### 3.2 与 ①② 的一致性钩子（防碎片化的核心）

| 疑似设置的东西 | 裁决归属 | 理由 |
| --- | --- | --- |
| 工具开关（bb dynamicTools/disallowedTools 形状） | **不是设置**——注册表启用策略（§1.2） | provider 拥有工具面；设置面长出工具开关 = 第二裁决点 |
| thread→host 绑定 | **不是设置**——路由数据（project 行字段 + thread 轨迹，§2.1） | 绑定是每 thread 一次性事实，不是可随时改的偏好；#50 里「personal 项目与 host:path 绑定纠缠」的查证不产生 per-host 设置，personal 行是 bb 逐字超集，保真偏差单独处置 |
| 模型/中转/思考配置 | 部署 env（harness 三键），不进 app_settings | 秘密与部署拓扑不落控制面 DB；快照投影已定义（harness.ts projectHarness） |
| xdev 开关、essential 集裁剪 | 注册表策略输入（部署期） | 同 §1.2，改它是发版行为不是改设置 |
| 权限上限 | host 行 ceiling（唯一 per-host 值） | 操作上限语义，向下收敛 |

---

## 4. 接口约束（消费者实现时必须遵守的缝）

**给 #33（M1.5 工具集）的一条约束：**

> 工具 schema 与启用裁决只存在于 AgentDO 注册表（omp 照抄双资产 + host/edge/hybrid 类标签）；daemon 接缝帧保持工具无关（`{tool, arguments, executionId, machineId, timeoutMs}`）——新增工具、xdev 降级、hybrid 后端选择零 daemon 协议变更，daemon 永不宣告或协商能力。

**给 #14（M1 多机路由）的一条约束：**

> thread→host 绑定是轨迹数据不是环境常量：`thread.created.machineId` 一次性冻结、重放即真相，后续派发一律从重放态解析 service DO 名（每派发零绑定查找）；host:path 覆盖只作用于单次派发的 machineId 并随 `tool.dispatch` 落偏差记录，永不重写绑定；换绑只能是显式 owner 操作 + 新绑定事件，系统永不静默换 host。

**settings（维持现状，无排期票）：**

> app 单行唯一权威 + host 只留收窄型 ceiling；任何「跨会话/跨 host 设置」新需求先过 §3.2 判据表，归错的块不改 settings 面形状。

### 与已排期票的接口对照

| 票 | 消费本层哪块 | 本层给它的缝 | 它欠本层的回填 |
| --- | --- | --- | --- |
| #33 M1.5 工具集 | ① 注册面 | §1.1 注册表行形状 + §4 约束（协议零变更） | hybrid 后端选型（HTTP vs SQLite/文件）回写 §1.2 backend 字段取值 |
| #14 M1 多机/fleet | ② 路由面 | §2.1 绑定生命周期 + §4 约束（重放态解析、显式换绑） | project 级 workspace 绑定默认的 D1 字段与解析函数实现；离线 host 换绑产品行为（喂 #73） |
| #73 grilling（host:path 产品语义） | ② 路由面 | §2.2 参数层覆盖机制（本文是形状底稿） | UI 展示/离线行为的用户裁决，不回改机制层 |
| #80 考古（bb/omp 路由形状） | ② 路由面 | §2 的空白标注 | omp host:path 精确参数语义（哪些工具、解析规则），回填 §2.2 |
| settings 维持现状 | ③ 设置面 | §3.1 优先级链 + §3.2 判据表 | 无（#42 thread 级选项走既有 live/session 分类） |

---

## 5. 争议裁决表（责任边界速查）

实现/评审中遇到归属争议，先查此表；表外争议按 §0 拆缝规则推导，推导不出再开裁决。

| 争议 | 裁决 | 依据 |
| --- | --- | --- |
| 工具 schema 该由 daemon 侧声明吗 | 否，AgentDO 注册表唯一权威 | providerOwnsRuntimeSurface（bb :186-189）；practice 1 契约单一源；§1.1 |
| 新工具要不要改 daemon 协议 | 永不 | 派发帧工具无关（daemon.ts:17-26）；一条链承载全部 host 工具（分类表 §3.1） |
| hybrid 工具的两半归谁 | 控制/状态半 DO，执行半 daemon 或 HTTP 后端 | 分类表 §3.3 拆缝规则 |
| thread 搬机器走绑定还是覆盖 | 搬家=显式换绑（owner+轨迹事件）；单次跨机=host:path 参数覆盖 | 总图 #1；§2.1/§2.2 |
| 派发时发现绑定 host 离线怎么办 | 显式 `host_offline`，不降级默认机器 | unified-turn-state §5.1；静默换 host 红线 |
| 绑定信息查 D1 还是轨迹 | thread 级查轨迹（重放态）；fleet 活性查 D1 | §2.3 归属正交裁定 |
| 新的 per-host 设置该开吗 | 只许收窄型操作字段，判据见 §3.1 | host ceiling 先例；防 n 行漂移 |
| 设置改了对在跑会话生效吗 | unchanged/live/session 三值分类说话 | harness.ts classifyHarnessProjection；bb classifyExecutionSettingsChange |
| 工具开关做成 app 设置行吗 | 不做；启用策略是注册表部署期输入 | §1.2/§3.2 一致性钩子 |

---

## 6. 证据基线与空白

- 拆缝规则与三类清单：分类表 §0/§2/§3（branch research/tool-classification，commit 锚点 omp `d4d49e71`）。
- M0 现状行级证据：`wire.ts:77-98,237`（BASH_TOOL + tools 数组）；`agent-do.ts:199,934-943,966-970`（machineId 冻结与派发解析）；`fsm-events.ts:54-55`、`turn-state.ts:163-171`（绑定进轨迹/重放）；`seam/agent-do.ts:127,144-147`（组合路径常量与 ensureHost 红）；`daemon.ts:17-26`（工具无关帧）；`service-do.ts:45-61`（per-machine claim 权威）；`hosts-registry.ts`（D1 投影自节流）；`db/settings.ts:11-16`、`routes/system.ts:34-41`（app 单行四族）；`contract/domain/host.ts:15-31`（ceiling 语义）；`routes/hosts.ts:15-24`（hosts 最小 + 读时活性）。
- 既定裁决：总图 #1 Notes（host 寻址语义）；#17 Q4（harness 最小面）；#70 → #33 阶段裁决（M1.5 独立）；#14 收窄裁定（多 daemon/fleet/compaction/崩溃恢复）；engineering.md practice 7/10/11。
- **空白（显式留白，不阻塞本票）**：① omp host:path 的逐工具参数语义与解析规则——#80 考古回填 §2.2；② 离线 host 的换绑/覆盖产品行为——#73 用户裁决；③ project 级绑定默认的 D1 字段名与解析函数——#14 实现期定，本文只锁「解析在创建路径、解析是边缘纯函数」两条。以上均标 [INFERENCE-Free]：机制层（冻结/覆盖/优先级）不依赖空白回填结果。

> AGENT GENERATED: by zhipu-coding-plan/glm-5.3-flash-max (spec subagent, #68)
