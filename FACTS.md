# FACTS — #436 cloud 常在线 + primary machine（只读侦查，HOLD 态）

Agent: lane-436 · 2026-10-06 · 状态：未写任何产品代码、未 commit、未开 PR。
范围：primaryHostId 与 status=connected 的**全部**生产者/消费者事实清单，备 grill 审。

---

## A. `status=connected` 的生产者与消费者

### A1. 唯一 status 生产者：`toHostRecord`
- `apps/server-worker/src/services/host-records.ts:14-25`：`status: (await daemonConnected(env, row.id)) ? "connected" : "disconnected"`（行 19）。
- `daemonConnected`（host-records.ts:28-37）＝ per-host `DaemonServiceDO.hostLiveness` RPC（`packages/daemon-service/src/service-do.ts:898+`：现役 session ＋ 活 socket），无绑定/RPC 失败一律降级 disconnected。

### A2. `toHostRecord` 的消费方（= 投影面，cloud 在此改恒 connected）
| 消费方 | 位点 |
|---|---|
| GET /hosts（列表） | `apps/server-worker/src/routes/hosts.ts:73-76` |
| GET /hosts/:id | `routes/hosts.ts:78-81` |
| GET /threads/:id?include=host | `routes/threads.ts:432-439` |

### A3. `daemonConnected` 的**非 hosts 列表**消费方（＝执行/悬置面，必须保持诚实离线）
| 消费方 | 位点 | 若被谎报 connected 的后果 |
|---|---|---|
| 线程详情 §9.3 row-4 悬置面 | `services/runtime-display.ts:56-71`（`resolveThreadRuntimeStateAsync`，daemonConnected 判定 @67 → 否则 `host-reconnecting`） | placeholder 绑定线程横幅消失，而 mid-turn dispatch 仍 host_offline → 显示与真值矛盾 |
| 线程列表批量 liveness | `services/runtime-display.ts:153-182`（per-distinct-host 缓存 @163-168） | 同上，侧栏行面失真 |

**结论（陷阱 1）**：恒在线投影必须收在 `toHostRecord`（或 `row.type === "placeholder"` 分支），**不得改 `daemonConnected` 本体**。

### A4. DO 缝 ＝ dispatch 安全的真门（投影完全不动这层）
- enroll 与 session/open 均具名拒绝保留 id：`packages/daemon-service/src/worker.ts:301-306`（enroll）、`:357-360`（session/open）→ 422 `validation_failed` "host id is reserved for the cloud placeholder"。
- 故 cloud 永无 DO session → 任何 dispatch（`packages/agent-do/src/agent-do.ts:2838-2841` `daemonFor(state.machineId ?? CLOUD_PLACEHOLDER_HOST_ID)` → `dispatch`）恒答 `host_offline`（`daemon.ts:42`；isolationOp twin `agent-do.ts:1349-1352`）。
- 同理兜底位：`routes/threads.ts:817`（host-files content 兜底 cloud）、`services/attachment-pickup.ts:45`。
- attach bridge 跳过刷新 cloud 行（`db/hosts.ts:36-41`）；hub `markDaemon*` 永不见 cloud。
- **ticket 边界 4（不派任务给 cloud）今日已由该 DO 缝结构性成立，与投影无关。**

## B. primaryHostId 的正本与消费方

### B1. 唯一 producer：`buildSystemConfig` 硬编码 null
- `apps/server-worker/src/routes/system.ts:110-129`：`primaryHostId: null as string | null`（**行 124**）；`GET /system/config`（system.ts:319-351）在行 345 原样透传。
- **端口今日从不解析 primary**。ticket 描述的"级联落到 lxc-stg-01 → 真机不可删"是 **bb 侧**行为（bb `services/hosts/primary-host.ts:70-76`）；端口的移植裁定是**去掉 dataDir 项**（`docs/research/bb-host-surface.md:169`："组合部署无服务端 host id 文件"），但从未落地（恒 null）。

### B2. 服务端删除保护与 primary 解析**解耦**（"服务端正本已对"的代码证据）
- DELETE guard 直接锚 `CLOUD_PLACEHOLDER_HOST_ID` 字面量：`routes/hosts.ts:259-265`，400 `placeholder_host_removal_refused`；真机全可删（c8 测试 `:88,:93` 已断言 200）。
- → 改 primaryHostId 解析对服务端保护**零影响**；它的唯一消费者是 SPA。

### B3. UI 消费方（钉版 SPA，bb 仓）
- 危险区 primary host → Remove 禁用：bb `MachineSettingsView.tsx:383-404`（证据 `docs/research/bb-host-surface.md:99`）。
- primaryHostId=cloud 后接缝自对齐：cloud 无 Remove（对齐服务端 400）、真机显 Remove（对齐服务端 200）。
- SPA 改动走 bb 仓 PR（AGENTS.md "Submodule: bb"：本 worktree 永不改 bb 文件）。

### B4. primaryHostPlatform
- schema nullable（`contract/api/system.ts:218-219`；`hostPlatformSchema = darwin|linux|wsl|unknown`，`contract/hdc/local.ts:143-144`）。
- hosts 表**无 platform 列**（migration 0004 列清单；`db/rows.ts:173-177`）→ 端口只能恒 null（schema 合法）。**grill 点**：接受恒 null，还是加列。

### B5. 无其他消费方
- repo-wide grep `primaryHostId|primaryHostPlatform`：仅 B1 位点 ＋ migration/protocol 注释；**无测试 pin null**。

## C. 级联语义：ticket 文本 vs 端口先例的张力

- ticket：显式绑定(cloud) → dataDir → 唯一在线 → 仅存。
- 端口裁定已去 dataDir 项（bb-host-surface.md:169）；且 cloud 显式绑定居首后，"唯一在线/仅存"两腿仅当 cloud 行缺失才可达（生产不可达——migration OR IGNORE 播种且不可删；c8 `wipeRealHosts` 也保留 cloud 行，test:50-52）。
- **实效语义 ＝ primary 恒 cloud**；其余双腿只是防御性装甲。
- 实现落点注意：`buildSystemConfig` 是纯 env 函数（无 DB 访问）；解析需 D1 查询，须放 `GET /system/config` 的 async route 层（或注入 rows 的独立 resolver，建议对齐 bb 路径落 `services/hosts/primary-host.ts`）。
- "唯一在线"腿用哪个 connected 语义：建议 **DO liveness（真机）**，因为投影语义下 cloud 恒在线会霸占"唯一在线"腿（显式绑定腿在前可保优先，但语义混用会使两腿含义漂移）。

## D. thread 建立显式选 cloud → named 422 的唯一收口点

- `resolveThreadBinding`（`services/thread-binding.ts:79-162`）：
  - `type:"host"` 分支（109-145）：**今日 `hostId === "cloud"` 会静默通过** `requireNonDestroyedHost`（行存在、未销毁）并 materialize environments 行绑 cloud（当前洞）。
  - named 422 应插在该分支：显式 `requested.hostId === CLOUD_PLACEHOLDER_HOST_ID` → 422（与 `worker.ts:305` 措辞家族一致的具名拒绝）。
  - 同一函数覆盖 rebind：`PATCH /threads/:id/environment` → `resolveThreadBinding`（`routes/threads.ts:488-511`）→ **单收口双覆盖**。
  - 默认绑定不受影响：personal 无 hostId（126-128）与 project-default 兜底（150-153）仍落 cloud（部署默认 ≠ 显式选择；dispatch 仍 host_offline）。
- 残留/grill 点：
  - `reuse` 分支（88-107）不验 host 可执行性——历史绑 cloud 的环境行可被 reuse；修复后不再新增此类行，是否加防御待裁决。
  - UI 触发面：MachinePicker **非 connected 禁用**（bb-host-surface.md:100，`MachinePicker.tsx:132-174`）——cloud 投影 connected 后变为可选，**正是 422 存在的原因**；EnvironmentPicker "请求 setup 仅 connected"（`:455-543`）打到 cloud 会落 daemon RPC 502 `host_unavailable`，具名度弱于 422。

## E. 测试面（现状断言 vs 需翻转）

`apps/server-worker/test/compat/cloud-placeholder-host.test.ts`（ticket 所称 c8）：
- `:62` fresh-fleet `placeholder.status === "disconnected"` → **须翻转** `"connected"`。
- `:79` squatter 后 `status === "disconnected"` → **须翻转** `"connected"`（enroll/session-open 仍 422，断言保留）。
- `:66` 名称徽章断言「虚拟·W6 前不可执行」保留。
- 需**新增**：DELETE cloud → 400 `placeholder_host_removal_refused`（现无直接断言）；`/system/config` `primaryHostId === "cloud"`；显式 `hostId=cloud` 建线程 → 422 named；恒 connected 投影断言（真机离线仍 disconnected 对照）。
- 已有保留：真机删除 200（:88,:93）、placeholder-bound 线程 host face 502 host_offline（:97-107，不受投影影响——走 daemon RPC 非 toHostRecord）。
- 无其他测试 pin placeholder disconnected / primaryHostId null（repo grep 证据）。

需随改的注释/概念记录（同 commit）：
- `packages/protocol/src/environments.ts:185-200`（"The row never pretends to be online" → 恒 connected 投影语义）。
- `apps/server-worker/src/contract/domain/host.ts:8-10`（"never connected" 注释）。
- `CONTEXT.md:11`（"永不 connected" → 投影恒 connected、W6 前不可执行不变）。
- migration 0004 头注释＝史实记录，不改。
- `docs/ops/staging-daemon-host.md:189` ＝ staging 观察记录，可不改。

## F. 审阅重点清单（陷阱）

1. **投影泄漏到执行面**＝最大陷阱：`daemonConnected` 的两处 runtime-display 消费方（A3）不得跟随翻转。
2. `buildSystemConfig` 是同步纯函数——primary 解析必须挪到 async route 层（B1/C）。
3. "唯一在线"腿的 connected 语义选型（投影 vs DO）须定一（C）。
4. SPA 的 primaryRemove 态来自 `/system/config` 缓存——staging 验收注意刷新/`config-changed` 广播路径（GET config 无写后广播）。
5. 端口 400 code 为 `placeholder_host_removal_refused`，与 bb 的 `primary_host_removal_refused` 不同名——SPA 理想态根本不对 primary 发 DELETE；是否需要兼容 code 待裁决。
6. 无新 migration 需要（status/primary 均读时派生）；`migrations-replay.test.ts` 不受影响。
7. `hostSummarySchema`（protocol）在 server-worker 无生产者（仅 thread-binding.test.ts parse 用），无第二个 status 面。

---

## G. 终版裁决对齐（owner 三轮裁定，2026-10-06 steer 覆盖 ticket 原文）

1. 恒在线投影收在 `toHostRecord`（本文件 A2 投影面），`daemonConnected` 本体不动（A3 执行/悬置面保持诚实离线）——已实施。
2. primary 走 bb 级联**第一键的服务器本体绑定**：Worker 部署即云 → 该腿命名 cloud 行（C 的"显式绑定"落地形态，不新增解析层）；"唯一在线→仅存→null" 双腿按 bb 原样保留作防御性兜底（生产不可达）。
3. **具名 422 面具被裁掉**（ticket 边界 4 作废）：默认落 cloud 后直接执行自然 host_offline 失败（A4 DO 缝），无专门拒绝、无引导 UI、无执行兜底。thread-binding.test.ts:224-227 已钉"默认解析落 cloud"。
4. 无 executable 标志 / 无 type 演进预告（W6 升格缝不买）。
5. bb 仓零 diff 成立：SPA 的两个消费点（primary⇒Remove 禁用、MachinePicker connected 启用）都是上游既有语义，服务端只喂 `primaryHostId=cloud` ＋ 投影 connected，SPA 零改动自对齐。
6. 实施验证：server-worker typecheck 绿；c8/thread-binding/c1/host-identity-terminal/host-liveness/thread-suspension-face/c2/host-registry-bridge 8 套件 42 测试全绿。
