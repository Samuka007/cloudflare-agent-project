# Idle provider session release——bb 机制考古 + 我方架构对应物设计

> 工单：Samuka007/cloudflare-agent-project#306（W5 伞 #310）
> 日期：2026-10-06
> 考古对象：bb 上游 feature「Idle provider session release——Release restorable provider sessions after 30 idle minutes. A change can take up to five minutes.」（bb fork 本地检出 `/home/nixos/workspace/bb` @ `8473d8c337e258f3f5261a6060744587335c65e2`，2026-08-29；本仓 submodule pin `e04a0f14` 与该检出不同源系，pin 内是否含本 feature **未验证**——本仓主 src 零 bb import，pin 只喂 SPA，结论不受影响）
> 我方锚点：worktree `lane/306-w5-design-idle-provider-session-release` @ `1a7ae22`；平台语义引 Cloudflare 官方文档（DO pricing 页更新 2026-09-30，取读 2026-10-06）。
> 兄弟档案：pi-parity-matrix.md G6 行、omp-agent-core-loop.md §2.9（既有 reaper 锚 `runtime.ts:753-765`/`:2243+` 为旧 pin 行号，本文行号相对 8473d8c33 重标）、do-turn-lifecycle-safety.md（平台生命周期）。

## 0. 结论先行

1. **bb 释放的是什么**：不是数据、不是会话身份，而是**线程绑定的 provider CLI 子进程**（每线程数百 MB 量级的宿主 RAM）。连续性锚 `provider_thread_id` 存在 server 事件日志里，本就 content-free（compaction-two-source-map.md §3），释放零数据损失。恢复=下一 turn 提交时 daemon 用日志里的 id **重启进程并 resume**，全程不产生 timeline 消息；用户唯一可见效应是首 token 延迟与「被释放进程带走的未竟后台任务在恢复时落为 interrupted 任务行」。
2. **两个数字的语义**：30 分钟=空闲阈值（`turn/completed` 或非重试 `provider/error` 起算）；5 分钟=daemon 维护扫描周期，实验开关**每轮扫描前重读**，"A change can take up to five minutes" 即开关生效延迟 ≤ 一个扫描周期。
3. **我方裁决：不做 bb 式 reaper（不写新代码）**。我方 provider=无状态 relay（`apps/provider-app/src/harness.ts:1-20`，每 turn 全量装配，无进程、无跨 turn 会话句柄），**没有可释放的对象**；Agent DO 的内存态释放已是平台自动语义（hibernation/eviction），且「恢复=冷启动重放 journal」是本仓第 2 条铁律（`agent-do.ts:180-187`）并已有测试矩阵。bb 的 reaper 修的是「平台不帮你释放常驻进程」的世界的问题；Workers 平台替我们做了，且做得更彻底（eligible 即停表，见 §2.4）。
4. **要做的是两件小事**（防退化 + 记台账）：
   - **A. hibernation-eligibility 审计门**：CF 计费的关键事实是「idle 且**符合 hibernation 条件**的 DO 不计 duration——哪怕 runtime 还没真正 hibernate 它」（DO pricing，§2.4 锚）。因此正确的守护对象不是「释放动作」而是「eligibility 不被未来代码破坏」。落点：agent-do 包加 no-restricted-syntax lint 规则（禁 `setInterval`；`setTimeout` 出现处必须带 mid-turn 注释——现存 3 处全部 mid-turn，符合），写进 CI 即成本归零。
   - **B. 宿主残留物台账 + 重开触发器**（§3.3）：唯一真实的宿主侧常驻物是 eval py/js kernel（**无** idle 释放——omp 的 `IdleTimeout` 是 cell 执行期预算，`tools/eval.ts:897-902`，不是跨 turn reaper，已核）与用户自己的长跑命令（语义上必须保留）。台账记之，触发判据写死，命中再立实现票。
5. **上游化纪律（实践 10）**：bb 的 reaper 是 daemon 形态专属（子进程管理），SPA/协议面无投影；我方「不做」不产生任何 bb 面偏差，无需 ①②③ 判定。

---

## 1. bb 机制考古（survey pin 8473d8c33）

### 1.1 restorable provider session 是什么

bb 把每个 provider 跑成宿主上的**长驻 CLI 子进程**（codex app-server、claude-code bridge、pi、omp bridge、ACP agent），进程内会话经 `provider_thread_id` 绑到 bb thread。「restorable」是一个**能力声明**：进程可以杀掉，之后从持久化的 id（或文件）重建进程并接回同一段对话。

- 静态声明：`ProviderServerCapabilities.supportsSessionRestore`——「Whether a stopped provider session can resume from its persisted id」（`packages/agent-providers/src/catalog.ts:47-49`）。内置值：codex/claude/pi = true；**omp = false**，理由注释在 `catalog.ts:206-210`：「OMP allocates a session id before its first prompt materializes the session file. Until the bridge can report that materialization, advertising restore would make a blank thread look resumable after a host restart.」；ACP = false（占位），由 initialize 握手的 `agentCapabilities.loadSession` 动态给真值（acp `bridge.ts:1522-1523`）。
- 动态翻转：omp 逐会话经 `thread/identity` 事件携带 `ompRecovery` 描述符时翻 true（`packages/agent-runtime/src/runtime.ts:1060-1065`——仅 `providerId === "omp"` 分支）；ACP 在会话被设置变更替换时重报（`:1971-1985`，`sessionRestorable = session.supportsLoadSession`）。
- **该声明是活的，不是一次性的**：任何会话重建（reconfigure）后新会话重新上报，「An updated agent can drop loadSession, and a stale `true` would let the idle sweep release a session that can no longer resume」（`runtime.ts:1000-1024`）。

omp 描述符（`ompRecovery: {sessionId, sessionFile}`）是「materialized, idle session 的凭证」：

- 发布：仅静默期——`parentTurnQuiescent`、无 detached 任务、`get_state` 返回 `isStreaming === false && isCompacting === false`（`omp/bridge/bridge.ts:1077-1104, 1227-1230`）；失败被有意吞掉（「A failed proof is intentionally indistinguishable from no proof」，`:1377-1379`）。
- 失效：turn 开始或 detached 任务打开即 epoch bump + 清描述符（`:1106-1113, 1768-1769`）。
- 消费：resume 必须携带描述符且校验活 state 仍匹配（`--resume <sessionFile>` 无文件即抛「OMP resume requires a verified session file」，`:1027-1032`；identity 校验 `:1419-1424, 1743-1747`）。

### 1.2 释放路径（reaper sweep）——两个 timer 的精确语义

**daemon 侧 5 分钟扫描**（`apps/host-daemon/src/app.ts:69-70, 167-227`）：

- `IDLE_PROVIDER_SESSION_REAP_AFTER_MS = 30 * 60 * 1000`、`IDLE_PROVIDER_SESSION_REAP_INTERVAL_MS = 5 * 60 * 1000`（`:69-70`）。
- 每轮 `setInterval` 触发，`running` 标志防重入；**每轮先重读实验开关**（`resolveProviderSessionReapingEnabled()`，`:176-190`）——这就是「A change can take up to five minutes」的出处：开关生效延迟 = 距下一轮扫描的剩余时间。
- 释放结果只进 daemon 日志一行（`:192-208`），不进 timeline。

**runtime 侧逐线程判定**（`packages/agent-runtime/src/runtime.ts`）：

- fan-out：runtime-manager 逐 runtime 调 `reapIdleProviderSessions`，并传 `runThreadExclusive` 排他回调把释放动作塞进线程控制队列（`apps/host-daemon/src/runtime-manager.ts:601-609`）——释放与并发 turn 提交互斥。
- 候选判定 `findReapableIdleProviderSession`（`runtime.ts:722-768`）：①无 in-flight 操作、无 pending turn start、无 active turn（`:725-731`）；②能力门：实验开 → 必须 `sessionRestorable`；实验关 → 必须 **codex**（`:735-741`，注释明说「The experiment does not gate release: Codex idle sessions are released without it, which is the behavior BB shipped before this experiment」）；③`providerThreadId` 已注册（`:746-751`）；④`nowMs - idleSinceMs >= idleForMs`（`:758-760`）。
- 空闲时钟（`:686-720`）：`turn/completed` 或非重试 `provider/error` → `markHostedProviderSessionIdle`（起算）；`turn/started` → 清零。
- **open-work 守卫**（`reapIdleProviderSessions` 内 `:2271-2282`）：实验开 → 运行时级 `backgroundWorkState.hasOpenThreadWork` **加上** adapter 级 `hasOpenThreadWork`（7c33c816d 补的 codex 原生子代理面；claude 的 `running`/`requires_action`/cron 快照同属此类，cb899e52d）；实验关（codex 旧道）→ 仅 `isThreadScopedProviderProcess` 的进程可释放（共享进程不动）。docs/configuration.md:608-613 的表述：「Active turns, commands, agents, workflows, and monitors keep their sessions loaded.」
- **释放动作 = `stopThread`**（`:2040-2084`）：idle 线程的 `thread/stop` 命令对 adapter 是 noop 计划 → `forgetThreadRuntimeState`（`:665-684`：身份、执行配置、turn 态、后台工作、重放过滤全清）+ `shutdownThreadScopedProviderProcessIfIdle`（关停线程独占进程）。**不删任何事件、不动 `provider_thread_id` 存档**。
- 失败隔离（`:2286-2295`）：「One damaged session must not block every later candidate, so report the failure and let the next pass retry this thread.」——单线程释放失败只报 stderr，下轮重试。

### 1.3 恢复路径与用户感知

- **恢复通道是常备的，不是 reaper 专属**：server 每次 turn 提交都携带 `resumeContext {providerThreadId, ompRecovery?, …}`（`packages/host-daemon-contract/src/commands.ts:242-249, 392-423`）；daemon 发现 `hasThread(threadId) === false` 就地 `resumeThread`（`apps/host-daemon/src/command-handlers/thread.ts:171-201`）。reaper 只是让这条路径**更常走**而已。
- `resumeThread`（`runtime.ts:1715-1855`）：确保进程 → 发 `thread/resume` 适配命令 → 各 provider 恢复：codex/pi 原生 resume、claude SDK `resume: <id>`（`claude-code/sdk-session.ts:210-260`）、omp `--resume <sessionFile>`（需描述符）、ACP `session/load`。完成后 `markHostedProviderSessionIdle` 重挂空闲时钟（`:1851`）。
- **用户可感知什么**：
  - 释放时刻：**无**。无 timeline 消息、无状态行；仅 daemon 日志。
  - 恢复时刻：**基本无**。恢复内联在下一 turn 首字节之前，用户看到的就是 turn 正常开始；代价 = 进程 spawn + resume 延迟打进 TTFT。
  - 唯一实质投影：被释放进程带走的未竟后台任务（workflow 等）在 resume 时由 adapter 结算为 `interrupted`/`stopped` 任务行，且幂等（`claude-code/task-translation.test.ts:404-457`「second resume has nothing left to settle」）。这是 open-work 守卫漏网（竞态、旧 CLI 回退）时的兜底，不是常态。
- 相邻件（区分清楚）：`1c3f3eff0` thread stop 释放 runtime（显式释放，非 idle）；`27ecae47e` `/reload` 手动换会话（成功「replaces the provider session without adding a timeline message」）——两者共用同一套 stop/resume 机制。

### 1.4 演进史与动机

| commit | 日期 | 内容 |
| --- | --- | --- |
| `e4358acd5` | 2026-06-13 | Reap idle Codex provider sessions（起点：codex 单 provider、thread-scoped 进程、无实验门） |
| `b42f9275c` / `aa9e239b6` | 2026-06 | reaper 竞态（turn submit 撞释放）与清理收紧 |
| `3bc9ce54b` | 2026-08-14 | `providerSessionReaping` 实验 + catalog/桥接 restorable 面（把释放从 codex 扩到一切 restorable provider） |
| `7c33c816d` | 2026-08-14 | Guard the sweep：codex 原生子代理守卫、失败隔离、ACP 恢复能力随会话替换刷新、文档措辞（实验是扩展不是门） |
| `cb899e52d` | 2026-09-02 | Preserve live Claude work during idle release（#2893：plugin 内 30s 级释放器的 residency 信号补全——`running`/`requires_action`/cron 快照） |
| `deab88c73` | — | Remove unused Claude idle process setting（旧设置退役，收敛到统一 sweep） |

动机单一：**宿主内存**。每线程一个常驻 CLI 进程（数百 MB RSS），空闲线程累积驻留；bb 的事件日志本就 content-free（compaction-two-source-map.md §3.2「bb is a control plane over provider sessions; it never summarizes anything itself」），所以释放进程零上下文损失——这是 bb 架构把上下文外包给 provider 之后**必须配套**的内存治理，不是可选优化。

---

## 2. 我方架构对应物映射

### 2.1 概念逐行映射

| bb 概念 | 我方对应物 | 现状 |
| --- | --- | --- |
| provider CLI 子进程（要释放的对象） | **不存在**。provider=无状态 Anthropic relay，每 turn 全量装配发 HTTP（`apps/provider-app/src/harness.ts:1-20`；relay/provider.ts、relay/sse.ts） | 无可释放 |
| provider session 身份（`provider_thread_id` 存档） | `providerThreadId = pthr_<threadId>`，registry SQLite 行（`apps/provider-app/src/manager-do.ts:24-50, 56-72, 650-662`）——「bb 的 `host_daemon_sessions` + runtime-memory Map 折叠成一张表」 | 已建，驱逐零重建（行在 SQLite） |
| 进程内运行时状态（释放即丢） | Agent DO 内存态；铁律 2「replay is truth——memory holds no non-derivable truth」（`packages/agent-do/src/agent-do.ts:180-187`） | 平台自动释放（hibernation/eviction），重放重建 |
| 恢复 = daemon `resumeThread` 重启进程 | 恢复 = DO 冷启动 constructor + journal 重放；「An evicted agent DO replays from its own log」（manager-do.ts:49；t19-lifecycle、t26-replay-matrix、registry.test.ts 已测） | 已建，是被测不变量 |
| `ompRecovery` 描述符（指向宿主 session file） | 同名概念已移植，但指向**我方自己的 journal**：`agent-do://<pthr>/events.jsonl`（`apps/provider-app/test/adapter.test.ts:127-130`；poisoned session 必须 `ompRecovery` 才能 resume，`provider-app/src/manager-do.ts:372-378`、`daemon-worker/src/provider-adapter.ts:260-267`；registry 丢失可凭 daemon-held 描述符重附，registry.test.ts:184-199） | 已建；我们的「session file」就是 DO 事件日志本身（content-bearing，omp 语义） |
| open-work 守卫（`hasOpenThreadWork`） | 活动 turn/等待梯/后台 job 全部 journal 派生（`turn-state.ts` computeDueWork、job-registry.ts:8-15）；在途工具执行=未决 I/O，**天然阻止 DO 休眠**（平台条件②） | 平台语义覆盖 |
| idle 时钟 + 5min 扫描 + 实验开关 | **无对应物，也不需要**：释放者是 Workers runtime 自身，无扫描、无开关、无生效延迟 | 平台行为 |
| `thread/stop` noop 释放路径 | 同名命令逐字移植，「null（idle stop）must not invalidate the session；非空（打断活动 turn）可判 poisoned」（`apps/daemon-worker/src/provider-adapter.ts:124-129`）；我方 composed edge-agent 明确**不走** orchestrator thread/stop（会毒化注册表，CHANGELOG.md:453-455） | 已裁 |

### 2.2 daemon 侧（宿主）残留物台账

| 残留物 | 形态 | 量级 | idle 释放？ | 判定 |
| --- | --- | --- | --- | --- |
| bash 持久 brush shell | **进程内状态**（shell 就是 daemon 客户端进程本身，`/proc/$$/exe = bun`；`daemon-service/src/client/tool-runtime.ts:97-103, 504-508`），每线程 cwd/env | KB 级/线程 | 无（也无必要） | 不做；daemon 重启即失，等价于 bb 释放后 shell 态丢失 |
| exec.spawn 子进程 | 每 execution 一个 `bash -c`（`client/executor.ts:48-101`），完成/被杀即清，watchdog 表跟踪 | 命令期 | 语义上不可（用户命令=live work；bb 同规则「commands keep sessions loaded」） | 不做 |
| **eval py/js kernel** | 宿主持久进程，按 thread 键（`client/eval-kernel.ts:35-44, 345-346` sessionRegistry） | **每 kernel 一个解释器进程，最重的宿主残留** | **无**——omp `IdleTimeout` 是 cell 执行期预算（`oh-my-pi tools/eval.ts:897-902`，已核原文），跨 turn 不回收 | **台账项**：若实测 per-kernel RSS 构成压力，按 bb 30min 阈值 + 现有 kill/forget 通道立实现票（§3.3 触发器） |
| daemon 客户端进程本体 | 用户机器常驻 Bun 进程 + 5s 心跳/100ms flush timer（`client/connection.ts:224-234`） | 一台一份 | 永不（bb host-daemon 同） | 不做（机器的 daemon 在线是前提，非 per-thread 成本） |

### 2.3 「DO 计费优化」问题——数字核对

担心的两个面，按官方计费页（developers.cloudflare.com/durable-objects/platform/pricing/，2026-09-30 版）核对：

- **duration**：「Durable Objects that are idle and **eligible for hibernation** are not billed for duration, **even before the runtime has hibernated them**」+「inactive objects receiving no requests do not incur any duration charges」。Agent DO 空闲期（无活动 turn、无未决 I/O、hibernation-API WS、无 pending setTimeout）已 eligible → **duration=$0，reaper 无东西可省**。计 duration 的形态只有：活动 turn（本该计）、pending I/O 钉住（≤15min/操作，定价页脚注与 lifecycle 文档一致）、以及**违规的 idle 常驻 timer/Standard WS**——后者正是 §3.1 审计门要堵的。
- **请求**：请求含 WS 消息且 incoming 按 **20:1 折算**（「100 WebSocket incoming messages would be charged as 5 requests」）；出站消息与协议 ping 免费。最坏常驻源=DaemonServiceDO 的 5s 心跳：每连接 daemon `86,400/5 = 17,280` 条/天 → 折算 **864 请求/天/台**（≈2.6 万/月/台，1M/月免费额度内可容 ~38 台；超出部分 $0.15/M ≈ 每台每月 **$0.004 量级**）；duration 每次唤醒毫秒级 × 0.128GB ≈ 11 GB-s/天/台，淹没在 40 万 GB-s/月额度里。**结论：心跳成本是噪声，不是火**；且这是「daemon 在线」的 liveness 语义成本（bb heartbeat 5s 的移植对价，`daemon-service/src/constants.ts:31-43`），与线程空闲与否无关——reaper 改不了它。

**反事实预算表（实践 11）**：若强行移植 bb 式 reaper——无论「协调 DO cron 扫全量线程」（每 5min 一轮 × N 线程次 DO 请求：N=100 线程 → 28,800 请求/天，纯开销）还是「每 DO 自设 alarm 自杀式检查」（alarm invocation 也计请求，288 次/天/DO）——买到的收益都是零（duration 本就为 0），还要新增「释放后注册表一致性」这类 bb 用了四个 commit 才修稳的竞态面（b42f9275c、7c33c816d、cb899e52d、#2893）。**负收益，不做。**

### 2.4 平台语义与 bb 语义的对照总结

| 维度 | bb（宿主形态） | 我方（Workers 形态） |
| --- | --- | --- |
| 释放对象 | CLI 子进程（RAM） | DO isolate 内存（平台回收） |
| 触发者 | daemon 定时扫描（5min 重读开关） | Workers runtime（条件满足 ~10s 后 hibernate；70–140s 驱逐） |
| 「30 分钟」 | 可调阈值常量 | 无对应——平台即时回收，比 30min 激进得多 |
| 「5 分钟」 | 开关生效延迟 | 无对应（无可开关） |
| 守卫 | hasOpenThreadWork + restorable 门 + 排他队列 | hibernation 条件天然排除在途工作；恢复正确性由 journal 不变量保证 |
| 恢复 | 下一 turn 携带 resumeContext 重启进程+resume | 下一请求冷启动+重放；descriptor（`agent-do://…/events.jsonl`）与 bb 的 ompRecovery 同构 |
| 用户感知 | 无 timeline 消息；TTFT + interrupted 任务行 | 无 timeline 消息；冷启动重放延迟 + journal 里早已落盘的事实（无「带走未竟任务」问题——在途执行走 §8.4 重问/孤儿判定，不靠恢复兜底） |

---

## 3. 裁决

### 3.1 主裁决：不移植 reaper；立「hibernation-eligibility」为受审计不变量

**裁决**：#306 按设计关闭，不立实现票。bb 语义在我方的对应物**已经以更强形态存在**：

1. restorable 声明 ↔ journal 重放不变量（agent-do.ts:180-187 四铁律 + t26 replay matrix）；
2. resume 通道 ↔ provider-app registry 的 poisoned-requires-descriptor / lost-registry-reattach 路径（manager-do.ts:372-447）；
3. open-work 守卫 ↔ hibernation 条件（在途 I/O 阻止回收=工作永不丢）+ DO 计费「eligible 即停表」；
4. 释放动作 ↔ 平台 eviction（无 shutdown hook 语义早在 do-turn-lifecycle-safety.md §1 固化为本仓设计前提）。

**唯一真实风险**是退化：未来有人在 Agent DO 里加 idle 期 `setTimeout`/`setInterval`、或把内部 WS 换成 Standard `ws.accept()`、或留一根未关的出站连接——eligibility 破掉，空闲 DO 开始按 128MB 全额计 duration，且**没有任何报错**（静默回归）。bb 用 reaper 买内存，我们必须用审计门保 eligibility。

**落地（小，成本归零）**：
- agent-do 包（可推广至全部 DO 包）ESLint `no-restricted-syntax` 禁 `setInterval`；`setTimeout` 允许但每处必须带「mid-turn 依据」注释（现存 3 处：`agent-do.ts:762` 重试退避、`:3824` exec waiter、`tools/web-search.ts:1196` 搜索超时——全部活动期内，合规，作为注释范本）。此项随下一个触碰 agent-do 的实现票捎带落地，不单独立票；若 W5 内无顺路票，则作为 W6 首个 chore 票（参照类预测：bb/omp lint 规则单条 ≈ 15min）。
- 复核锚：`server-worker/src/ws/hub.ts:210-214` 的事件等待 `setTimeout(waitMs)` 是**有界停车**（parked waiter 期间 DO 不 eligible、计 duration）——现状是刻意的长轮询面，允许；若未来 waitMs 变长或常驻，改 alarm 语义并入台账。

### 3.2 判据（本裁决的验收面）

1. `grep -r "setInterval" packages/agent-do/src` 零命中（现状已满足，核实于本文写作时）；新增 lint 规则后由 CI 保障。
2. 驱逐恢复语义测试存在且绿：t19-lifecycle、t26-replay-matrix、`apps/provider-app/test/registry.test.ts`（「The intact agent DO still owned the thread — restorable」，:199-201）。
3. 文档面：pi-parity-matrix.md G6 行由「❌ → #306」转「✅（裁决：平台语义承接，不移植 reaper——本文档）」。

### 3.3 重开触发器（任一命中即按 bb 语义立实现票）

| 触发器 | 判据 | 预期形态（届时照抄 bb） |
| --- | --- | --- |
| eval kernel 宿主压力 | 实测单 kernel RSS × 活跃 thread 数构成宿主压力（`ps` 采样进台账；无数字不立票） | 30min 空闲阈值 + kernel 注册表 forget + 下次 eval 冷启动（对应 bb「释放进程、保留身份」） |
| provider 引入有状态会话（#305 路线若引入 OAuth/会话型 provider 或 relay 侧 previous_response_id 链） | harness.ts 三键之外出现跨 turn 会话句柄 | 需要 restorable 门 + resumeContext 通道——bb 1.2/1.3 全套语义成为必抄清单 |
| 出现新的宿主常驻形态（daemon 插件/长驻 worker） | 台账新增行 | 同 bb：open-work 守卫 + 5min 扫描 + 失败隔离 |
| Agent DO 出现无法消除的 anti-hibernation 形态（如长等待面必须 Standard WS） | lint 审计发现且无 alarm 等价改写 | 量化 duration 损失，裁「接受成本」或「改造等待面」（hub.ts waitMs 面是先例） |

### 3.4 与上游面纪律的关系（实践 10）

bb 的 reaper 是 host-daemon 形态专属（子进程治理），不触碰 SPA、协议、wire 形状——我方「不做」在 surface 三层判定法下**连①空置都算不上**（没有可空置的面），零上游化偏差。若上游未来把释放投影进协议（如 thread 状态行新增「session released」事件），届时按三层法从①起步重裁。

---

## 4. 维护

- 本文是**裁决文档**：§1 考古锚相对 bb `8473d8c33`；§2-3 锚相对本仓 `1a7ae22`。bb 上游前进后行号漂移，结构结论稳定（stop/resume、sweep、实验门三件套除非上游重构否则不动）。
- 重开触发器=§3.3 表；命中后新票必须引本文对应行作为 DoR 锚点（上游锚已备）。
- 计费数字的半衰期：CF DO pricing 页 2026-09-30 版（20:1 WS 折算、eligible 停表）；月更生态按周衰减——引用数字做决策前复核该页。
- 关联阅读：do-turn-lifecycle-safety.md（平台生命周期五状态）、pi-parity-matrix.md G6、omp-agent-core-loop.md §2.9、compaction-two-source-map.md §3（content-free 与 content-bearing 的分野，本裁决的根因）。

> AGENT GENERATED: by zhipu-coding-plan/glm-5.3-flash
