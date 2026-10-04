# omp task/subagent 行为语义考古（#78，#74 grilling 前置）

研究对象：omp（[github.com/can1357/oh-my-pi](https://github.com/can1357/oh-my-pi)）task 工具与子代理运行时。源码锚点 `/tmp/omp-src` **commit `d4d49e71bef3ac1420d45febf215b951decf5ae9`**（2026-10-03，与 omp-engine-portability.md 同锚）。`path:line` 相对该提交；上游前进后行号漂移，结构结论稳定。行为面描述另与 omp 文档镜像（`docs/tools/task.md`、`docs/tools/wait.md`，锚点内同文件）互证。

目的：为 #74（grilling omp task/subagent 语义）供给行为事实。回答五问：①派发形状 ②隔离后端（#70 已定类 hybrid）③结果回灌 ④并发/取消与 wait 协作 ⑤子代理生命周期。omp 源码不入本仓，本文只引用证据。

---

## 0. 结论速览

| 维度 | 一句话结论 |
| --- | --- |
| 派发形状 | **batch（`{context, tasks[]}`，默认开）每项一个子代理**；flat 单派发运行时仍收；执行模式按 item 定（`blocking: true` 内联、否则后台 job）；batch 流式期间逐项投机预启动（speculative launch，默认开） |
| 隔离后端 | hybrid（#70 定类）：编排面进程内；`isolated` 工作区走 pi-natives PAL（`crates/pi-iso`）八后端候选降级，patch/branch 两种回收合并，基线快照 ≤1 GiB |
| 结果回灌 | 子代理**必须经隐藏 `yield` 工具收尾**（≤3 次提醒，末次强制 toolChoice）；产出入 `agent://<id>` 工件族；后台完成的结果以 `async-result` follow-up 注入父会话，**且使早于它的 yield 失效** |
| 并发/取消 | 会话级 `Semaphore` 按 `task.maxConcurrency`（默认 32，0=无限）就地伸缩，跨 task 调用统一限流；取消三级：`proc://<id>/kill`、父调用 signal、预算/墙钟强制停；硬中止 → `aborted` 终态墓碑，预算中止可复活 |
| wait 协作 | `wait` 只等**自己启动的** job/service（30 分钟安全帽），peer 消息/steering 中断即可唤醒；结果本来自动投递——wait 是"阻塞时的最后手段"，不是轮询通道 |
| 生命周期 | 注册表四态 `running\|idle\|parked\|aborted`；完成（成功或失败）→ `idle` + adopt，TTL 7 min 后 park（session 释放、ref+sessionFile 保留），`write agent://<id>` / Agent Hub 复活；`aborted` 终态不可逆 |

---

## 1. 派发形状（dispatch shape）

### 1.1 两种线形，一个执行语义

- **Batch 形**（`task.batch` 默认 on，task/settings.ts:195-199）：`{ context, tasks: item[] }`。`context` **必填**，渲染进每个子代理系统提示的 `CONTEXT` 节；`tasks[]` 每项一个独立 spawn，项间允许不同 `agent` 类型。校验在 task/index.ts:245-287（`validateSpawnParams`）：空 tasks、缺 context、项缺 task、重名（大小写不敏感）、顶层 task 与 tasks 并存均拒绝。
- **Flat 形**：`{ ...item }` 一次一派发。`task.batch` 关闭时 `tasks`/`context` 显式拒绝（task/index.ts:219-224）；**开启时运行时仍收 flat 形**（内部调用方、旧转录兼容，task/index.ts:619-629 `lenientArgValidation = true`——arktype 失败时原始参数透传 execute，让自检错误先说话）。
- 归一化入口 `resolveSpawnItems`（task/index.ts:296-299）+ `spawnParamsFor`（:320-328）：batch 容器上的 `model` 直接拒绝——"put it on each tasks[] item"（:212-213），不静默丢弃。

### 1.2 关键 item 字段语义

| 字段 | 语义 | 证据 |
| --- | --- | --- |
| `name` | 稳定注册表/IRC id；提示层要求 CamelCase ≤32，wire 只要求 string；缺省生成 AdjectiveNoun 名，`AgentOutputManager` 会话内唯一化（重名 `-2`/`-3`，嵌套 `Parent.Child`） | docs/tools/task.md:42, :199; output-manager.ts:6-11, :83-87 |
| `agent` | 类型选择（scout/reviewer/...）；缺省用 spawn policy 默认（通常 `task`） | docs/tools/task.md:43 |
| `solutionSpace` | 问题开放度描述；**作为唯一输入喂子代理首 prompt 的 `auto` 思考分级器**（judge 只看此字段不看 task 正文）；schema 声明必填但宽松校验允许缺失（回落按 task 文本分级） | docs/tools/task.md:45 |
| `effort` | 仅 `task.enableEffort=true`（默认 off）出现；lo/med/hi 映射到解析模型支持的档位；覆盖 agent 自身 selector 含 auto | docs/tools/task.md:46, :163 |
| `model` | 一次 spawn 的**有序偏好**，不是封闭白名单：逐候选试凭据，全失败则 spawn 失败，**不回落父模型**（agent 定义/task.agentModelOverrides 的模型才有父回落）；歧义字面量 preflight 失败 | docs/tools/task.md:47, :53, :55 |
| `outputSchema`/`schemaMode` | 调用点结构化契约 + 校验模式；优先级 per-call > agent frontmatter `output` > 继承父会话 schema；permissive 重试耗尽可带警告收无效 payload，strict 失败 | docs/tools/task.md:48-49, :109 |
| `tools` | 父 eval 内核（Python/JS）已定义的命名工具；子代理调用**在父内核执行**；双内核同名、未知名、计划模式均 preflight 失败 | docs/tools/task.md:50, :135 |
| `isolated` | 仅 `task.isolation.enabled=true` 且计划模式关闭时出现在 schema；keep-alive 的隔离代理跨 idle/parked 保留工作区 | docs/tools/task.md:51 |

### 1.3 执行模式判定与投机预启动

- **per-item 决定内联/后台**：agent 类型声明 `blocking: true` 的项内联跑完再返回；其余项在 `async.enabled`（tools/settings.ts:892-896，默认 on）+ 有 AsyncJobManager 时注册为后台 job 立即返回。混合调用先注册后台 job、再内联跑 blocking 子集（task/index.ts:921-925, :1059-1060, :1191-1194）。无内置 agent 声明 blocking。
- **Speculative launch**（`task.speculativeLaunch` 默认 on，task/settings.ts:209-213，仅 batch）：流式调用中每个 `tasks[]` 项 JSON 对象闭合即开跑其 SpawnRun（`context` 须先闭合）；dispatch 收养参数仍匹配的 run，不匹配/hook 阻断/turn 中止则全部作废（task/index.ts:649-661, :855-856, :930-936；docs/tools/task.md:132）。预启动需宿主授权 `authorizeLaunch`。
- **Agent 发现**：按确切名 first-wins——项目 `.omp/agents` > 用户 > 扩展包根 > Claude marketplace 插件 > 内置（scout/reviewer/security-reviewer/task/sonic）；`.claude/agents` 等显式跳过；create 时 memoize、执行时重读盘（docs/tools/task.md:136, :194）。

---

## 2. 隔离后端（#70 定类 hybrid 的实底）

#70 分类（commit `f63b8ff`，omp-tool-execution-classification.md §3）：`task` = **编排面 DO 可承载、`isolated` 隔离执行体归 daemon**。源码实底：

- **编排面**（进程内、无 natives）：spawn 计划、job 注册、信号量、注册表/生命周期、yield 收账——全部普通 TS。
- **隔离执行体**：`isolated: true` 时经 `parseIsolationBackend`（worktree.ts:481-484，`auto` ⇒ undefined 交 resolver）把设置映射为 PAL 候选提示，`ensureIsolation` → `isoResolve`/`isoStart`（crates/pi-iso）落工作区；后端不可用沿候选表降级（structured-subagent.ts:874-876; docs/tools/task.md:111, :133, :148）。候选序：Linux `overlay`（fuse-overlayfs/fusermount 回落）、APFS/Btrfs/ZFS/reflink 克隆、Windows ProjFS、递归拷贝兜底。
- **基线预算**：每仓未提交快照上限 `ISOLATION_BASELINE_MAX_CONTENT_BYTES = 1 GiB`（worktree.ts:130），超限 spawn 前失败不缓冲（:267-270 `captureBaseline`）。
- **回收合并两式**（`task.isolation.merge`，enum patch|branch，task/settings.ts:115-119）：
  - patch 式：捕获根/嵌套 patch，`repo.canApplyPatch` 预检——仅反向可应用视为已应用（isolation-runner.ts:722-727）；嵌套仓独立 diff、`applyNestedPatches` 单独合并（worktree.ts:408; isolation-runner.ts:805）。
  - branch 式：agent 提交到 `omp/task/<agentId>` 分支再 cherry-pick 回父仓；提交失败把活 diff 写 `<id>.patch` 救援（isolation-runner.ts:362-365, :503-505; worktree.ts:862）。
- **应用门**：`task.isolation.apply=true`（默认，task/settings.ts:101-105）才落父仓；`false` 只捕获。捕获/合并失败保留恢复工件（docs/tools/task.md:113, :183）。branch 合并临时 stash 父仓，stash-pop 冲突报 `stashConflict` 且提交留在 HEAD（docs/tools/task.md:197）。

---

## 3. 结果回灌（result backfill）

### 3.1 yield 是唯一收尾门

- 子代理必须经隐藏 `yield` 工具结束（YieldTool：tools/yield.ts:289-293，`name="yield"`、`approval="read"`、`intent="omit"`）。支持增量（`type: string[]` 分节累积）与终态两种调用形态（yield.ts:1-5 头注；`YieldDetails` :65-84）。
- **缺失 yield 恢复**：≤3 次内部提醒（`MAX_YIELD_RETRIES = 3`，executor.ts:2210），末次尝试强制 `toolChoice = yield`（:2372-2375）；仍不 yield 则注入 `SYSTEM WARNING: Subagent exited without calling yield tool after 3 reminders.`（docs/tools/task.md:159, :186）。预算强制停把提醒梯压缩为单次强制终局 yield，部分发现仍作为正式报告回收（executor.ts:2217-2221, :2345-2353）。
- **yield 质量闸**：连续 3 次空结果提交直接 abort 子代理而非无限重试（yield.ts:281-285, :484, :551）；schema 校验连续失败 3 次后放行非合规数据（`schemaOverridden` 标记，yield.ts:272-278）。

### 3.2 工件族与读取面

- 每个子代理写 `<id>.md`（全文输出）、`<id>.jsonl`（会话史）；有 `data` 的结构化结果另写 `<id>.json` sidecar（schema 无效也写）；隔离补丁 `<id>.patch` / 嵌套 `<id>.nested-<n>-<path>.patch`（docs/tools/task.md:89-94）。
- `agent://<id>` 解析到工件；JSON 路径后缀 `agent://<id>/<key>/<index>` 抽值（优先 sidecar）；嵌套子代理点号 id `agent://<id>.<child>`；`agent://all` 只写广播（docs/tools/task.md:92; output-manager.ts:6-11）。`history://<id>` 渲染简洁转录，活/parked 皆可读（docs/tools/task.md:93）。
- **截断预算**：输出 500_000 字节 / 5000 行（task/types.ts:29-32，env `PI_TASK_MAX_OUTPUT_*` 可调；executor.ts:2641-2644）；内联摘要阈值 5000 字符，超限强制指向 `agent://<id>` 工件（result-summary.ts:16, :60-61）。

### 3.3 后台完成 → async-result 注入 → yield 失效链

这是 task 语义里最微妙的一条：

1. 后台 job 完成 → 所属会话的投递 sink 格式化结果（>12_000 字符溢出工件+预览，async-job-delivery.ts:25, :28）→ 以 `async-result` follow-up 消息入 **yield 队列**注入父会话 run（agent-session.ts:1950-1963, :2809）。
2. **时序后到的 async-result 使先前 yield 失效**：执行器监测到 yield 之后注入的 async-result，就解除 yield 闩、重跑提醒梯索要**计入了后台结果的**新 yield（executor.ts:1143-1147, :1673-1676, :2420-2424）；被作废而未刷新的 stale yield 直接判 run 失败而不是让父代理拿过期载荷行动（:2524-2527）。消息类型常量 `ASYNC_RESULT_MESSAGE_TYPE = "async-result"`（async-job-delivery.ts:21-25）。
3. 终局语义：**只有无未决 owner 工作的 yield 才是终态**（executor.ts:2420-2424）——后台 job 先结算折叠为 async-result turn，再来一次干净 yield 才收尾。

### 3.4 同步路径回灌

`async.enabled=false` / 无 job manager / 全 blocking 时，调用阻塞至全部 spawn 结束，`details.results[]` 每 spawn 一个 `SingleResult`（身份/状态/输出/模型/结构化结果/工件元数据/`extractedToolData`），batch 聚合 usage；任一 spawn 错误则整体 error（docs/tools/task.md:76-87; task/index.ts:382-386）。

---

## 4. 并发/取消与 wait 协作

### 4.1 并发模型

- **会话级 `Semaphore`**：`task.maxConcurrency` 默认 32（task/settings.ts:235-239），0=无限（parallel.ts:131-135）；每次 acquire/release **就地重设**上限，设置中途变更对排队的 spawn 同样生效（task/index.ts:639-643）。一个 permit 罩一个 `SpawnRun`，**跨所有 task 调用统一限流**（含 sync 与投机 run；docs/tools/task.md:164）。eval `workpool()` 同用此上限（workpool.ts:150-153）。
- **递归深度**：`task.maxRecursionDepth` 默认 2，负值关闭（task/settings.ts:271-275; task/types.ts:231-235 `canSpawnAtDepth`）；到顶后 `runSubprocess` 剥离子代理的 `task`（docs/tools/task.md:172）。
- **自递归防环**：`PI_BLOCKED_AGENT` + 每调用 spawn policy 预检（docs/tools/task.md:108）。
- **Provider 并发托架防自锁**：spawn 树宽度超 `maxConcurrency` 时父等子、子等父持位死锁（上游 issue #3749）——修法是 provider 流调用按槽托架（一次 LLM 调用一个槽位，bracket 收窄），树深超限不再自锁（provider-concurrency.ts:8-11, :74-78）。
- **软请求预算 / 墙钟**：`task.softRequestBudget` 默认 200 请求，超限注入收尾 notice，**1.5× 强制停**并逼一次终局 yield（settings.ts:337-346; executor.ts:149-158, :1630-1632）；`task.maxRuntimeMs` 默认 0 关闭（settings.ts:291-294; executor.ts:1413-1427）。scout/sonic 内置更低预算，配置只能往下压（settings.ts:345-346）。

### 4.2 取消语义

三入口，后果分层：

| 入口 | 作用 | 后果 | 证据 |
| --- | --- | --- | --- |
| `write proc://<jobId>/kill`（无 content） | 取消后台 job / owned 子代理 / 停服务 | 归属运行中的 subagent 被 abort 并释放 session | docs/tools/task.md:26, :158; wait.md:26 |
| 父工具调用 signal | 取消 sync run；后台 job 不受父调用取消影响（已 detach） | call signal 传播到 SpawnRun | docs/tools/task.md:158 |
| 预算/墙钟强制停 | 软中止 | keep-alive 且有 reviver ⇒ **可复活**：置 `idle` 走 follow-up/复活路径 | executor.ts:3246-3250 |
| 内部硬中止 / call signal / 墙钟 | 真杀 | `aborted` **终态墓碑**：session 释放，延迟的复活/进度永不翻转墓碑 | executor.ts:3251-3281; agent-registry.ts:190-193 |

关键不对称：**budget 中止是唯一可复活的 abort**（executor.ts:2144-2147 注释——"a soft stop that never escalated still identifies as a budget abort so the lifecycle can park the agent as resumable"）；其余一律终态。

### 4.3 wait 与 task 的协作契约

- `wait` 无参、essential、interruptible（tools/wait.ts:24-26, :49-59）。**只等自己启动的**：job 按 `ownerId` 过滤（wait.ts:83），"Work it did not start never sustains a wait——a peer owes no message"（:43-48 头注）；无可等物立即报 `Nothing to wait for`（:92-96）。
- 唤醒竞速（`Promise.race`，wait.ts:136-144）：owned job 结算 / IRC 消息 / owned service 完成 / **30 分钟安全帽**（`WAIT_MAX_MS = 30*60_000`，:25，无调用方可选 timeout）/ call abort。先查队列信箱、再查已结算未投递 job（:74-90）。
- 消息与 job 的 photo-finish：消息赢则消息返回、**job 仍走普通 async 投递**不丢（:156-159）；steering 中断返回 `Wait interrupted by message.` + `interrupted: true`（:160-170）。
- **纯 peer 等待梯**：只有 running peer 能唤醒时，message-only 窗口按连续 wait 次数 5/10/30/60/300 秒放行，≥60 秒间隔重置（docs/tools/wait.md:17，锚点内文档）。
- **设计立场**：结果与消息**本来就自动投递**（async-result 注入 / yield 队列），wait 是"阻塞到无事可做时的栅栏"，不是轮询通道（docs/tools/wait.md:20; prompts/tools/wait.md:4 "NEVER poll while work remains"）。500 ms 进度快照（wait.ts:26, :134）。
- 进阶协作面：`write agent://<id>` 唤醒/续派 parked 代理（复活收据 `revived`，irc/bus.ts:139-143）；eval `workpool()`/`agent()` 是 task 之上的池化/句柄封装，结果同样自动投递（prompts/system/workflow-notice.md:18-21）。

---

## 5. 子代理生命周期

```
 spawn ──► running ──(finish/失败)──► idle ──(TTL 7min)──► parked ──(write agent:// / Hub)──► idle
              │                                                                                        ▲
              ├──(硬中止：signal/墙钟/内部终止)──► aborted（终态墓碑）                                   │
              └──(预算软停 + reviver)──► idle（可复活）──────┘（同上路径）                                 
```

- **注册表四态** `running | idle | parked | aborted`（pi-tui/overlays/agent-hub-types.ts:7）。`session` 字段**恰在 parked/aborted 时为 null**（agent-registry.ts:68-70）；`aborted` 终态不可逆，延迟回调只能确认不能翻转（:190-193）；注册走 CAS（`registerIfAvailable` 只认缺席或指定 parked ref，:161-170）。
- **完成即 keep-alive**：成功与失败都置 `idle` 并 `AgentLifecycleManager.adopt`——"finished and failed subagents both stay interrogable"（executor.ts:3292-3307）。`Main` 永不 park（docs/tools/task.md:123）。
- **TTL park**：`task.agentIdleTtlMs` 默认 420_000（7 min，task/settings.ts:324-327），≤0 关闭；park = 释放活 session、保留 `AgentRef` + sessionFile，timer unref 不撑进程（agent-lifecycle.ts:1-21 头注, :57-63）。park 与并发 ensureLive/peer 送信互斥合流（:12-16）。
- **复活**：`write agent://<id>` / Agent Hub / collab revive / RPC 路径都汇入 `ensureLive`（agent-lifecycle.ts:341+; collab/host.ts:1092-1115; rpc-mode.ts:745-746），从 JSONL 重建 session；IRC bus 投递给 parked 收件人先复活再送（bus.ts:139-143）。
- **跨进程持久**：进程重启后 parked 树由 transcript 扫描恢复（persisted-agents.ts:613+），树爬升无深度上限（:472-474）；kill 墓碑持久化防重启后把被杀转录误认为可复活代理（executor.ts:3265-3269）。
- **隔离代理的保留**：keep-alive 的 isolated run 完成后不拆工作区，清理权移交 lifecycle owner；显式 release 才捕获最终 patch/branch 并清隔离句柄（docs/tools/task.md:51, :121）。
- **一次性助手例外**：`keepAlive=false`（eval `agent()` 等内部路径）跑完即 dispose+unregister，无 IRC 无复活（executor.ts:3284-3290）。

---

## 6. 语义总表（#74 直接取用）

| # | 行为面 | 语义 | 证据（omp @ `d4d49e7`） |
| --- | --- | --- | --- |
| 1 | 派发粒度 | 一次调用一 spawn；batch 形一次调用 N spawn（默认） | docs/tools/task.md:3, :35-36; task/settings.ts:195-199 |
| 2 | 共享上下文 | batch `context` 必填，渲染进每个子代理系统提示 CONTEXT 节 | docs/tools/task.md:35, :40; task/index.ts:277-279 |
| 3 | 执行模式 | per-item：`blocking: true` 内联，否则 async job；混合调用两轨并行 | task/index.ts:921-925, :1191-1194; docs/tools/task.md:3 |
| 4 | 投机预启动 | batch 流式逐项闭合即启动，dispatch 收养或全弃 | docs/tools/task.md:132; task/settings.ts:209-213 |
| 5 | 模型选择 | 有序偏好试凭据；显式选择器不回落父模型 | docs/tools/task.md:47, :55 |
| 6 | 隔离 | PAL 八后端降级；基线 ≤1 GiB；patch/branch 回收；apply 门默认开 | worktree.ts:130, :481-484; isolation-runner.ts:503-505; task/settings.ts:101-119 |
| 7 | 收尾门 | 唯一经 `yield`；≤3 提醒 + 末次强制 toolChoice；无 yield 注入 SYSTEM WARNING | executor.ts:2210, :2345-2375; docs/tools/task.md:186 |
| 8 | 回灌 | 同步=SingleResult 合并；异步=async-result follow-up 注入 yield 队列 | agent-session.ts:1950-1963, :2809; async-job-delivery.ts:25 |
| 9 | yield 失效 | 后到的 async-result 作废先前 yield，强制重 yield；stale 未刷新判 run 失败 | executor.ts:1673-1676, :2420-2424, :2524-2527 |
| 10 | 工件 | `<id>.md/.jsonl/.json`；`agent://<id>` + JSON 路径/嵌套点号 id；500 KB/5000 行截断 | task/types.ts:29-32; output-manager.ts:6-11; docs/tools/task.md:89-94 |
| 11 | 并发上限 | 会话级 Semaphore，`task.maxConcurrency` 默认 32，就地伸缩，跨调用统一 | task/index.ts:639-643; task/settings.ts:235-239; parallel.ts:131-135 |
| 12 | 防自锁 | provider 流按单槽托架，spawn 树深度不再死锁 | provider-concurrency.ts:8-11, :74-78 |
| 13 | 预算 | 200 请求软预算，1.5× 强停逼 yield；`maxRuntimeMs` 默认关 | settings.ts:337-346; executor.ts:1630-1632 |
| 14 | 取消 | `proc://<id>/kill` / call signal / 硬中止=aborted 墓碑 / 预算软停=idle 可复活 | docs/tools/task.md:158; executor.ts:3246-3281 |
| 15 | wait | 无参、只等自有 job/service；30 min 安全帽；消息/steering 即醒；结果自动投递，禁止轮询 | tools/wait.ts:25, :43-48, :136-144; docs/tools/wait.md:16-17, :20 |
| 16 | 生命周期 | running→idle→parked(TTL 7min)→revive；aborted 终态；Main 永不 park；重启后转录恢复 parked 树 | agent-hub-types.ts:7; task/settings.ts:324-327; agent-lifecycle.ts:1-21; persisted-agents.ts:472-474 |

---

## 7. 移植注意（与 #28/#33 裁定衔接）

- **hybrid 拆缝再确认**：编排面（spawn/job/信号量/注册表/yield 收账）是纯会话态 + 进程内原语，DO 可承载；`isolated`、`tools`（父内核回桥）、隔离 git 操作（capture/merge/stash/cherry-pick）三类执行体绑宿主 fs/git，属 daemon 半（#70 §3 拆缝规则：控制/状态面归 DO，执行体归 daemon）。
- **yield-supersession 链是移植必抄语义**：后台结果注入使 stale yield 失效并强制重 yield——这是"父代理永不拿过期结论行动"的保证；漏抄则异步回灌与结构化输出会静默不一致。
- **owner-scoped wait**：wait 只认自己启动的 job——语义上是"债务等待"不是"消息等待"；消息唤醒靠 steering/IRC 轨道独立完成。移植时若把 wait 做成全局栅栏会引入互等死锁（wait.ts:43-48 头注明言此坑）。
- `docs/tools/task.md:74` 自认死点：`task-follow-up.md` 模板仍把 isolated run 标注为不可恢复，与实际保留工作区生命周期不符——引用时以实现为准。

> AGENT GENERATED: by zhipu-coding-plan/glm-5.3-flash:max (research subagent, #78)
