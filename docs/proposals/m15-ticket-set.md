# M1.5 工具集完备：实现票提案（PROPOSAL，待 PM 审阅发布）

> 状态：**PROPOSAL**。本文只做切片，不写 tracker；PM 逐票向用户过堂后发布并分配正式票号。
> 输入裁决：#74（shape=bb verbatim / semantics=omp verbatim / 同 host subagent 即刻进 M1.5、跨 host 派发归 M1）、#33（umbrella）、ROADMAP M1.5 行。
> 输入研究：[omp-tool-execution-classification.md](../research/omp-tool-execution-classification.md)（下称「分类表」，33 工具=15 host/11 edge/7 hybrid + 拆缝规则 + schema 双资产来源）、[tool-retry-idempotency-matrix.md](../research/tool-retry-idempotency-matrix.md)（下称「矩阵」，逐工具重发/部分输出/取消基线）、[omp-task-semantics.md](../research/omp-task-semantics.md)（下称「task 语义」，#78）、[control-plane-layer.md](../design/control-plane-layer.md) §1/§4（注册面 + 工具无关帧）、[bb-fleet-shape.md](../research/bb-fleet-shape.md)（bb 子代理形状）。
> 切片纪律：每票=垂直 tracer-bullet（schema 照抄 → 注册 → 派发 → 执行 → 结果回灌 → L1/L2），尺寸 ≤1 个新上下文窗。
> 提案编号 T1…T26 为本文局部编号；发布时 PM 分配 tracker 号并替换引用。

---

## 0. 范围与裁决基线

- **目标集**：omp 内建 33 工具（锚点 omp `d4d49e71`）。**主干 P0 = essential 13**（8 host：read/write/bash/edit/glob/find/eval/manage_skill；2 hybrid：task/learn；3 edge：wait/context_notes/new_context）；discoverable/hidden 21 件为 P1 或显式裁决点。
- **接口总约束（每票必须遵守，control-plane §1.1/§1.2/§4）**：
  - 工具注册表是 **AgentDO 编译期静态模块**，行形状 `{ name, schema(ArkType 照抄), descriptionTemplate(prompts/tools/*.md 照抄), class: host|edge|hybrid, backend }`；wire 装配按启用策略取集。**不做 daemon 能力协商**（bb `providerOwnsRuntimeSurface` 先例；协商=运行时 DO 请求量，注册表零请求）。
  - **daemon 派发帧永久工具无关** `{tool, arguments, executionId, machineId, timeoutMs}`（`packages/agent-do/src/daemon.ts:17-26`）；一条 daemon 链承载全部 host 工具按名分派（分类表 §3.1，ida broker 同族先例）。**任何 M1.5 票不得改 daemon 协议**。
  - 拆缝规则（分类表 §3.3）：控制/状态面归 AgentDO，执行体（fs/进程/natives）归 daemon；后端可插拔类选 HTTP/DO-storage 后端即整体边缘化。
  - 照抄双资产纪律：schema 与 description 模板同级照抄；运行时注入的 `i` intent 字段不抄（分类表 §6.6）。
- **界外（显式非目标）**：xdev 设备降级面（改 wire 呈现不进注册表语义，M1.5 不做）；`browser`/`computer`（ROADMAP M3）；跨 host task 派发（M1 #14 fleet 面）；`goal` 立票（先补实读，见 §4 裁决点 5）。
- **ROADMAP 修正提示（PM 发布时一并处理）**：M1.5 行「subagent 工具等 M1 fleet」已被 #74 终裁（2026-10-04 10:14Z，晚于该行落笔）推翻——同 host task 不依赖 M1，仅跨 host 派发归 M1。

## 1. 每票默认约束（正文只写增量，默认项不重复）

| 项 | 默认值 |
| --- | --- |
| 验收 | L1（`@cloudflare/vitest-plugin`，MSW mock 出站；含 **replay 一致性断言**：同 executionId 重问=journal 应答、零二次 spawn/执行，驱逐重放后工具面语义不变）+ L2（staging 协议面冒烟：真 daemon 链路跑通该票 demo） |
| DO 请求预算（实践 11） | host 类：每执行=目标 machine service DO dispatch/ack ×2（既有链路预算，control-plane §2.3），注册表/装配零新增请求；edge 类：执行在本 DO 消化（journal 追加=DO storage 写，非跨 DO RPC） |
| 效率预算 | ≤1 个新上下文窗；schema/模板零手抄重复（单源摘自 omp 文档，禁二次转写）；复用列明的既有基建 |
| 上游化形态（实践 10） | bb 面零改动——工具 wire 形状经 `providerOwnsRuntimeSurface` 透传（分类表 §5），上游即无害；例外票在票卡单列 |
| 失败语义（实践 3） | dispatch at-least-once + executionId 去重；结果回灌 ack 后 tombstone；工具本体幂等性按矩阵逐行，不在接缝发明工具级幂等 |

## 2. 波次总览

| 票 | 标题 | 波 | 优先级 | blocker（前置→本票） | 一句话交付 |
| --- | --- | --- | --- | --- | --- |
| T1 | 注册表骨架 + edge 路由 + context_notes/new_context/think | 1 | P0 | — | 注册表行形状冻结 + edge 执行路由 demo：journal 条目跨驱逐重放存活 |
| T2 | wait（edge essential） | 1 | P0 | T1 | JobRegistry 接口冻结；唤醒竞速/30min 帽/owner 过滤全语义 L1 |
| T3 | 会话树簇 todo/checkpoint/rewind | 1 | P1 | T1 | DO storage 会话树操作三件套，语义逐条对照 omp 文档 |
| T4 | ask（SPA 交互通道） | 1 | P1 | T1 | DO↔SPA pending-interaction 注册 + 裁决回流，对齐 bb interactive-request |
| T5 | read | 2 | P0 | T1 | 宿主 fs/URL/专项读取器全读面 + OutputSink 截断 artifact 语义 |
| T6 | write + manage_skill | 2 | P0 | T5 | 覆盖写/归档原子写/SQLite 目标 + SKILL.md 独占管理 |
| T7 | glob + grep | 2 | P0 | T5 | native 遍历/gitignore + PCRE2 分页行帽，超时=成功截断语义 |
| T8 | edit | 2 | P0 | T5 | EditStore/hashline 防双 apply + 快照恢复失败安全 |
| T9 | bash 全语义对齐（M0→omp 完整面） | 2 | P0 | — | async/ready、看门狗隔离、patterns deny、timeout 夹紧 delta 清单清零 |
| T10 | eval | 2 | P0 | T5,T9 | 宿主保留式内核 framed IPC + artifact sink + IdleTimeout |
| T11 | find | 2 | P0 | T5,T7,T8 | jfind 宿主索引级联 + judge 经 provider 通道，失败不抛错语义 |
| T12 | web_search 边缘化 | 3 | P0 | T1 | DO 原生 fetch provider 面；配置层显式排除三个 browser-backed 引擎 |
| T13 | 记忆后端选型（决策票） | 3 | P0 | — | HTTP vs 本地 SQLite/文件 裁决，回写注册表 backend 取值 |
| T14 | learn + retain/recall/reflect/memory_edit | 3 | P0 | T13 | 随 T13 裁决整体边缘化（HTTP）或落 daemon 半（SQLite） |
| T15 | security_scan（整体归 daemon） | 3 | P1 | T9 | native 指纹半 + cloud OAuth 凭据宿主保管 |
| T16 | task 同 host：单派发 + 子会话骨架 + 结果回灌 | 4 | P0 | T1,T2 | bb 双轴子代理 + AgentDO-per-subagent + async-result 回灌 + yield 最小闸 |
| T17 | yield 全语义 + agent:// 工件族 | 4 | P0 | T16 | ≤3 提醒梯/强制收尾门/工件三件套/agent:// 解析面 |
| T18 | task batch + Semaphore/预算 + 投机预启动 | 4 | P0 | T16,T17 | batch 形校验/context 必填/maxConcurrency 32/软预算 1.5× 强停逼 yield |
| T19 | 子代理生命周期四态 + 复活 + wait 协作 + kill | 4 | P0 | T16–T18 | running/idle/parked/aborted + TTL park + write agent:// 复活 + photo-finish |
| T20 | task isolated 隔离后端（daemon 半） | 4 | P1 | T16 | PAL 后端降级链 + 基线 1 GiB + patch/branch 回收 + #78 死点核对 |
| T21 | github | 5 | P1 | T9 | gh 子进程 + git worktree 半，REST 不重投影死点遵守 |
| T22 | lsp | 5 | P1 | T9 | server 子进程管理 + per-action 超时 + rename 非幂等标注 |
| T23 | ast_grep + ast_edit | 5 | P1 | T8 | natives 扫析配/改写 + staged resolve/reject 裁决流 |
| T24 | debug | 5 | P1 | T9 | DAP adapter 传输 + action 分派 |
| T25 | ida（PM 裁剪点） | 5 | P1 | T9 | omp 自身 daemon-broker 同族先例的宿主执行半 |
| T26 | 收官：replay 一致性全量回归 + 对照差距清单收窄 + 关票门 | 6 | P0 | 全部 P0 | 33 工具面回归矩阵 + 差距清单收窄记录 + practice 12 关票 |

优先级口径：**P0 = essential 13 完备 + 注册/帧约束落地 + 收官门**；P1 = discoverable/hidden 补全与可选执行体，随 PM/用户裁剪。

---

## 3. 票卡

### 波 1：edge 先行（纯 DO，零 daemon 变更）

#### T1 注册表骨架 + edge 执行路由 + context_notes/new_context/think（P0）
- **需求**：M1.5 全部工具票的共同地基——AgentDO 内编译期注册表（行形状见 §0）+ `edge` 类执行路由（会话态落 DO storage）；用最简 essential edge 三件（context_notes、new_context、think）打通「schema→注册→派发→DO 本地执行→结果回灌→L1」全链。约束：零 daemon 触碰。
- **规格**：注册表为模块常量（control-plane §1.1：M0 `wire.ts:77-98,237` 的 BASH_TOOL 硬编码迁入注册表成为首行，bash 类标签=host、路由不变）；edge 后端=注册表自持路由策略直调 DO 本地执行器；context_notes=journal 追加 `experimental_context_notes`（16 KiB 上限、整本替换写、超限先失败后追加，omp `docs/tools/context-notes.md` §Flow/§Retry semantics）；new_context=空参 turn-local rollover 信号，由 turn 生命周期消费；think=私有 scratchpad 零 I/O。理由：edge 三件副作用全在进程内会话态（分类表 §2.2），是注册表+路由形状的最小无风险验证面。
- **交付/验收**：demo=模型调用 context_notes → 注销 DO → 重放 → 条目仍在、seq 连续；L1 断言注册表行形状/类标签、16 KiB 拒写、replay 后无重复条目。
- **锚点**：control-plane §1.1/§1.2；分类表 §2.2（context_notes/new_context/think 行）；`T:context-notes.ts`+`P:context-notes.md`/`P:new-context.md`/`T:think.ts`。
- **DO 预算（实践 11）**：注册表=编译期常量零请求；三工具执行=本 DO journal 读追加；wire 组装零请求。
- **效率预算**：≤1 窗；注册表行与 M0 BASH_TOOL 合并迁移，不新增第二处 schema 权威。
- **上游化（实践 10）**：bb 面零改动（providerOwnsRuntimeSurface 透传）。
- **blocker**：无（地基票）。

#### T2 wait——JobRegistry 接口冻结（P0）
- **需求**：essential edge 第 3 件：无参阻塞等待，只等**自己启动的** job/service/peer 消息；为波 4 task 集群冻结 DO 内作业登记接口。
- **规格**：`JobRegistry`（登记 ownerId/job 句柄/结算投递）在本票以接口+合成 job 形式冻结——task/eval 后台路径后续只消费不重设计；唤醒=`Promise.race`（结算投递 / peer 消息 / 30 min 安全帽 `WAIT_MAX_MS` / call abort），owner 过滤（`wait.ts:83` 先例），photo-finish（消息赢则返回、job 仍走普通投递），纯 peer 等待梯 5/10/30/60/300s；「Nothing to wait for」立即返回。理由：omp 语义是债务等待非全局栅栏（`wait.ts:43-48` 头注明言互等死锁坑），本票只抄不创（task 语义 §4.3）。
- **交付/验收**：L1=合成 job 结算唤醒、消息竞速 photo-finish、owner 过滤拒绝外来 job、30min 帽由 DO alarm 承载（实践 4 权威定时器在边缘）；replay 后等待语义不重复投递。
- **锚点**：分类表 §2.2 wait 行；矩阵 §2.4；`T:wait.ts`+`P:wait.md`；task 语义 §4.3。
- **DO 预算（实践 11）**：等待全在本 DO（promise 竞速+alarm）；跨 DO 面仅 peer 消息经既有 relay 通道到达，无新增请求型路径。
- **效率预算**：≤1 窗；接口冻结一次，波 4 零返工。
- **上游化（实践 10）**：bb 面零改动。
- **blocker**：T1。**下游**：T16/T18/T19 消费 JobRegistry。

#### T3 会话树簇 todo/checkpoint/rewind（P1）
- **需求**：discoverable 会话态三件：相位 todo（`storage: session|memory`）、checkpoint 边界标记、rewind 会话树分支+上下文重建。
- **规格**：全部落 DO storage 会话条目模型（omp「会话条目模型」投影，分类表 §3.2）；工具体零 fs（omp 文档明示 Filesystem: None）；rewind 走 `branchWithSummary` 同构分支语义。**依赖统一 turn-state 的消息树结构；若 M1 turn-state 扩展未落地，本票顺延**。
- **交付/验收**：L1=checkpoint→rewind 后消息计数/journal 边界一致；todo op 分派状态机穷尽（实践 9）。
- **锚点**：分类表 §2.2；`T:todo.ts`/`T:checkpoint.ts`+对应 P 模板；矩阵 §2.4。
- **DO 预算（实践 11）**：本 DO storage，零跨 DO。
- **效率预算**：≤1 窗（三件共享会话树基建）。
- **上游化（实践 10）**：bb 面零改动。
- **blocker**：T1（+M1 turn-state 会话树面）。

#### T4 ask——SPA 交互通道（P1）
- **需求**：discoverable edge `ask`：模型发起结构化问询，经 SPA 由用户裁决回流。
- **规格**：DO 注册 pending interaction → SPA 经 WS 呈现 → 裁决回流解锁 turn。形状对齐 bb `/internal/session/interactive-request`（`session.ts:725-754`，分类表 §5）——**这是本票的上游化形态本身**：用 bb 自身语义实现即天然可上游。超时/取消按矩阵（ask 0=不超时；abort 传播）。
- **交付/验收**：L1=pending 注册/裁决回流/abort 三态；L2=staging SPA 真点选走通一轮 ask。
- **锚点**：分类表 §2.2/§5；`T:ask.ts`（Question 形状）+`P:ask.md`。
- **DO 预算（实践 11）**：pending 表在本 DO；SPA 轮询禁止（WS 推送），零新增 DO 读路径。
- **效率预算**：≤1 窗。
- **上游化（实践 10）**：bb interactive-request 同构（例外票，单列于此）。
- **blocker**：T1。

### 波 2：host essentials（现有 daemon 链，零协议变更）

#### T5 read（P0）
- **需求**：essential host 首票：全读面（本地 fs/URL/内部 URI/归档/SQLite/二进制/PDF/notebook）+ 行范围选择器 + 截断 artifact 回读。
- **规格**：注册表行照抄 `T:read.ts`+`P:read.md`；执行体=daemon 宿主侧实现（优先复用 omp MIT 工具实现与 natives，禁重写第二正本）；归档/SQLite 专项读取器随 omp 全集；截断元数据 `details.meta.truncation` + OutputSink 溢出 spill（50 KiB 阈值/16 MiB 帽/inline 8 MiB，blob-artifact 对齐）；URL 分支走宿主 fetch 管道+缓存。理由：host 类结构性必须宿主（workerd natives 全灭，分类表 §6.5）；read 是 write/edit/glob/grep 的共享基建供给方（artifact sink、fs 契约），故居波 2 首位。
- **交付/验收**：demo=wire 会话真读宿主工作区文件并经 artifact:// 回读溢出输出；L1=越界行返回说明不抛错、截断元数据、同 executionId 重问=journal 应答零二次读副作用。
- **锚点**：分类表 §2.1 read 行（`read.ts:687-689` 仅 path 一字段）；矩阵 §2.1 read 行；omp `docs/tools/read.md`。
- **DO 预算（实践 11）**：每执行 dispatch/ack ×2（既有链路）；OutputSink 溢出落本 DO storage artifact，回读同 DO。
- **效率预算**：≤1 窗（专项读取器按 omp 模块化逐个接入，禁本票内重写）。
- **上游化（实践 10）**：bb 面零改动。
- **blocker**：T1。**供给**：T6/T7/T8/T10/T11 共享其 artifact/输出基建。

#### T6 write + manage_skill（P0）
- **需求**：覆盖写面（普通文件/归档成员/SQLite 行）+ skill 独占管理（SKILL.md 创建/更新/删除）。
- **规格**：write 照抄 `T:write.ts`+`P:write.md`：普通文件覆盖写幂等（omp Bun.write 语义）；归档写=临时兄弟文件+rename 原子；批量冲突解决「部分成功→isError、失败 id 保留待重试」；`agent://`/`proc://` 目标本票**显式 unknown-target 失败**，随 T16/T19 接缝启用（分类表：写安全随目标形态变化，矩阵 §2.2）。manage_skill 照抄 `T:manage-skill.ts`：`<agent-dir>/managed-skills/<name>/SKILL.md` 独占 + symlink 逃逸检查；skill 根存储位置随 T13 裁决可重投影（分类表 §2.3 注），schema 不变。
- **交付/验收**：L1=覆盖写幂等重放零重复副作用、归档原子性、SQLite insert 重发去重靠 executionId（工具本体不幂等须显式标注，实践 3）、symlink 逃逸拒绝。
- **锚点**：分类表 §2.1/§2.3 注；矩阵 §2.2；omp `docs/tools/write.md`/`manage_skill.md`。
- **DO 预算（实践 11）**：同 T5 形（dispatch/ack ×2）；文件/归档/SQLite 落宿主 fs，零 DO。
- **效率预算**：≤1 窗（两件同缝纯 fs）。
- **上游化（实践 10）**：bb 面零改动；skill 存储重投影若选 DO/R2 属新物种组件，文档化标准等同 bb（实践 10 前半）。
- **blocker**：T5。**下游**：`agent://`/`proc://` 写目标→T16/T19。

#### T7 glob + grep（P0）
- **需求**：只读搜索对：模式文件发现 + 内容正则搜索。
- **规格**：glob 照抄 `T:glob.ts`：native 遍历+gitignore+fs-scan-cache，**5s 固定超时=成功+截断提示而非抛错**、零匹配只给 incomplete-scan 提示绝不宣告不存在；grep 照抄 `T:grep.ts`：Rust regex→PCRE2 降阶引擎（`crates/pi-natives/src/grep.rs`）、20 文件/页 skip 分页、每文件行帽、超大文件前导窗口部分覆盖注明、30s 原生超时抛错。理由：两者共享 fs 扫描与输出分页基建，合票不超窗。
- **交付/验收**：L1=超时语义（glob 成功截断 vs grep 抛错，按矩阵分叉）、gitignore 尊重、分页 skip 幂等、重发安全（只读）。
- **锚点**：分类表 §2.1；矩阵 §2.1 glob/grep 行；omp `docs/tools/glob.md`/`grep.md`。
- **DO 预算（实践 11）**：同 T5 形。
- **效率预算**：≤1 窗。
- **上游化（实践 10）**：bb 面零改动。
- **blocker**：T5。

#### T8 edit（P0）
- **需求**：essential host 写改面：hashline 锚定编辑 + apply_patch/replace 变体。
- **规格**：照抄 `T:edit/schemas.ts`+`P:edit.md`（+`crates/pi-edit/prompts/`）；执行体=Rust EditStore natives（`crates/pi-edit`、`pi-natives/src/edit.rs`）宿主侧复用；防双 apply（单段字节相同=无变化诊断，第三次连续 no-op 报错）、失败安全（解析/锚点/no-op 全部发生在写入前=文件不动）、stale 快照恢复仅在链证明唯一安全结果时应用、exclusive 并发批、新语法错误不回滚只注记。理由：错误文案 "byte-identical" 语义是 Rust 侧资产，禁 TS 重写第二权威（分类表 §2.1 edit 行）。
- **交付/验收**：L1=防双 apply 三态、mismatch 拒写、多文件段 OS 写失败前缀语义按矩阵、exclusive 批与 read 快照链互斥。
- **锚点**：分类表 §2.1；矩阵 §2.2 edit 行；omp `docs/tools/edit.md`。
- **DO 预算（实践 11）**：同 T5 形。
- **效率预算**：≤1 窗。
- **上游化（实践 10）**：bb 面零改动。
- **blocker**：T5。**下游**：T23 共享 natives 管线。

#### T9 bash 全语义对齐（M0→omp 完整面）（P0）
- **需求**：M0 bash 是链路基本元件（#28 裁定），本票把执行语义对齐 omp 完整面，消除工具类内的半成品。
- **规格**：delta 清单以实测为准、验收正本=omp 文档：async/ready/schema 变体按设置门控（`bash.ts:330-380`）、timeout 夹紧 `1..3600`×`tools.maxTimeout`、看门狗 `max(1000,timeout)+5s` 兜底与**持久会话隔离**、自动后台 60s 阈值、`bash.patterns` deny/prompt（并显式标注不覆盖 eval 内壳，矩阵 §2.3 已知旁路）、取消=TERM/KILL 波+类型化 `cancelled/timedOut` 结果、输出合并单流+50 KiB spill。理由：M1.5 验收是「工具面 replay 一致性」，bash 半成品会污染逐工具基线。
- **交付/验收**：L1=delta 清单逐项断言（含重发=副作用重复的显式 isError 语义、持久会话超时隔离）；L2=staging 真 shell 一轮。
- **锚点**：矩阵 §2.3 bash 行+附录常量表；omp `docs/tools/bash.md`+`bash-tool-runtime.md`。
- **DO 预算（实践 11）**：同 T5 形；后台 job 状态投影在本 DO（复用 T2 JobRegistry）。
- **效率预算**：≤1 窗（delta 清单驱动，禁全量重写 M0 已对齐部分）。
- **上游化（实践 10）**：bb 面零改动。
- **blocker**：无硬前置（T1 完成即可入，因 bash 行已在注册表迁移中落位）。**供给**：T10/T15/T21-T25 的进程基建参照。

#### T10 eval（P0）
- **需求**：essential host 最重一件：保留式子进程内核（Python framed IPC / Bun worker VM）。
- **规格**：照抄 `T:eval.ts`+`T:eval-backends.ts`+`P:eval.md`；内核常驻**宿主**（daemon 侧），AgentDO 只持句柄——DO 驱逐不杀内核，恢复经既有 announce/resume 重挂；跨调用状态持久（一 cell 一调用，重跑只重放失败 cell 自身副作用）；`%load`/artifact sink 落宿主+会话域 artifact（>8000 字节 display JSON 全量进 artifact；尾窗 100 KiB/3000 行）；IdleTimeout 30s（0=无看门狗）、跨等待暂停；取消破坏性（JS 终止 worker/interrupt 升级 shutdown）、死内核替换重试一次。理由：workerd 无子进程/IPC 对等物（分类表 §2.1），控制面（cell 登记/句柄）归 DO、执行体归 daemon 正是拆缝规则投影。
- **交付/验收**：L1=驱逐重放后句柄重挂且不二次 spawn 内核、sink 失败也 finalize、IdleTimeout 看门狗；L2=staging 真 Python/Bun 内核各一轮。
- **锚点**：分类表 §2.1 eval 行；矩阵 §2.3 eval 行；omp `docs/tools/eval.md` §Execution flow/§Timeout/§Cancel。
- **DO 预算（实践 11）**：每 cell dispatch/ack ×2；内核输出流经既有 exec.resume 增量通道，零新增轮询。
- **效率预算**：≤1 窗（本票是波 2 最重票，禁止捎带其他工具）。
- **上游化（实践 10）**：bb 面零改动。
- **blocker**：T5（artifact sink）、T9（进程基建/看门狗形状）。

#### T11 find（P0）
- **需求**：essential host 收尾：语义文件发现（jfind 级联）。
- **规格**：照抄 `T:jfind/index.ts`+`P:find.md`（+三个 question 模板）；级联本体=宿主 fs+natives 词汇索引/IDF（host 类，分类表 §6.3）；judge 角色判定走引擎 provider 通道（LLM 出站不计执行体）；`find.enabled=auto` 的 judge 角色解析要求照抄；20s 总预算、judge 单尝试 10s×3、失败不抛错（留未判条目+`E of R failed` footer）、全部失败才报错。
- **交付/验收**：L1=judge 失败降级语义、重发重烧 judge 的显式成本标注（矩阵：无去重）、预算超时类型化。
- **锚点**：分类表 §2.1/§6.3；矩阵 §2.1 find 行；omp `docs/tools/find.md`。
- **DO 预算（实践 11）**：同 T5 形；judge 走 provider 通道零新增 DO。
- **效率预算**：≤1 窗。
- **上游化（实践 10）**：bb 面零改动。
- **blocker**：T5、T7、T8（索引/编辑基建）；provider judge 角色配置可用（M0 已有）。

### 波 3：hybrid 接缝

#### T12 web_search 边缘化（P0）
- **需求**：discoverable hybrid 的边缘化样板：DO 原生 fetch 承载搜索 provider 面。
- **规格**：照抄 `T:web/search/index.ts` 统一 schema（`query/recency/limit/max_tokens/temperature/num_search_results`）+`P:web-search.md`；**配置层显式排除 Google/Ecosia/Mojeek 三个 browser-backed 引擎**（分类表 §6.1 红线：不排除则 edge 静默变 hybrid）；per-transport 60s（帽 300s）、Public Web 5s/30s 收口、provider 失败以 `Error:…` 文本结果推进链条；浏览器升级子路径归 M3 daemon browser（非本票）。
- **交付/验收**：L1=排除集配置生效（禁用引擎被拒而非静默回退）、超时收口、abort 重抛；MSW mock provider。
- **锚点**：分类表 §2.3/§6.1；矩阵 §2.1 web_search 行；omp `docs/tools/web_search.md`。
- **DO 预算（实践 11）**：出站 fetch 边缘消化；无 DO 状态（除 journal 条目）。
- **效率预算**：≤1 窗。
- **上游化（实践 10）**：bb 面零改动。
- **blocker**：T1。

#### T13 记忆后端选型（决策票，P0）
- **需求**：裁定 learn/retain/recall/reflect/memory_edit + manage_skill 存储半的后端归属——这决定 6 个工具整体边缘化还是落 daemon 半（分类表 §2.3「后端可插拔类随选型漂移」）。
- **规格**：候选 A：HTTP 服务化后端（Hindsight 类队列/查询）→ 全部 DO 本地；候选 B：本地 SQLite/文件（Mnemopi/learned.md 同构）→ daemon 半。产出：注册表 `backend` 字段取值回写（control-plane §1.2 预留的回写点）+ 凭据/部署拓扑归属（实践 7 两把钥匙口径）。理由单列：这是纯选型裁决，实施票（T14）依赖其结论，先行可避免波 3 阻塞波 4。
- **交付/验收**：裁决记录（评论区）+ backend 取值表；无代码。
- **锚点**：分类表 §2.3/§3.3；control-plane §1.2。
- **DO 预算（实践 11）**：两候选各自的请求量对比表入裁决记录。
- **效率预算**：≤半窗。
- **上游化（实践 10）**：随裁决记录部署形态。
- **blocker**：无。**下游**：T14。

#### T14 learn + retain/recall/reflect/memory_edit（P0）
- **需求**：essential hybrid `learn` + discoverable 记忆四件按 T13 裁决落地。
- **规格**：schema 照抄各自 `T:*.ts`+`P:*.md`；候选 A（HTTP）：五件全 DO 本地（出站 fetch），managed-skill 写随 T6 skill 存储裁定；候选 B（SQLite/文件）：执行半落 daemon 按工具名分派（帧不变）。memory_edit 后端门控语义照抄（Mnemopi 专属门）。
- **交付/验收**：L1=按裁决路线的全工具 op 矩阵断言 + 重发语义（矩阵 §2.4 retain 行：HTTP 幂等队列 vs SQLite 同步写）。
- **锚点**：分类表 §2.3 记忆行族；矩阵 §2.4；omp `docs/tools/learn.md`/`retain.md`/`recall.md`/`reflect.md`/`memory_edit.md`。
- **DO 预算（实践 11）**：候选 A=出站 fetch 边缘消化；候选 B=dispatch/ack ×2/操作。
- **效率预算**：≤1 窗（五件共享后端客户端）。
- **上游化（实践 10）**：bb 面零改动。
- **blocker**：T13；T6（managed-skill 写路径）。

#### T15 security_scan（整体归 daemon）（P1）
- **需求**：discoverable hybrid：native 指纹半（git 仓内容/可执行位/symlink/HEAD SHA-256）+ cloud 控制面半。
- **规格**：M1.5 整体归 daemon（分类表 §2.3：OAuth 凭据宿主保管，不做半迁）；照抄 `T:security-scan.ts` 9-action 分派+`P:security-scan.md`；fs 输出目录+后台 coordinator 在宿主。
- **交付/验收**：L1=native preflight 指纹断言+后台取消；凭据不出宿主的接缝断言。
- **锚点**：分类表 §2.3；omp `docs/tools/security_scan.md`。
- **DO 预算（实践 11）**：同 T5 形。
- **效率预算**：≤1 窗。
- **上游化（实践 10）**：bb 面零改动。
- **blocker**：T9（进程基建）。

### 波 4：task/subagent（同 host；#74 裁决：shape=bb verbatim，semantics=omp verbatim）

#### T16 task 同 host：单派发 + 子会话骨架 + 结果回灌（P0）
- **需求**：essential hybrid `task` 的边缘半：同 host 子代理派发/编排/登记/yield 最小收尾门；**跨 host 派发（--machine 面）显式界外（M1 #14）**。
- **规格**：形状=bb verbatim（#74）：子代理=独立 AgentDO，`parentThreadId` 层级轴 × `sourceThreadId` 溯源轴 XOR、hidden side-chat fork、`sendToMain`=queued 消息带 senderThreadId（bb-fleet-shape 锚）；同 host 构造性默认=子代理 machineId 继承父绑定（bb 构造默认，control-plane §2 冻结语义不破坏）。语义=omp verbatim（#74）：flat 单派发先行（batch 形归 T18）、per-item 执行模式（blocking 内联/后台 job 走 T2 JobRegistry）、`name` uniquify（重名 `-2`/嵌套 `Parent.Child`）、`solutionSpace`→auto 思考分级、模型有序偏好不回落父模型；结果回灌=同步 SingleResult 合并 + 后台 `async-result` follow-up 注入（task 语义 §0 行 8）；yield 最小闸（收到终态结果必需一次 yield，全语义归 T17）。PI_BLOCKED_AGENT 防环照抄。隔离（`isolated`）字段本票**不启用**（omp 门控 `task.isolation.enabled` 默认关；启用归 T20）。
- **交付/验收**：L1=spawn→子 AgentDO running→yield→回灌父会话全链；executionId 语义延伸到 spawn 计划（重发=新子代理的 omp 零去重语义**显式保留**并文档标注，矩阵 §2.4：跟进应 `write agent://<id>` 非重新 spawn）；跨 DO 消息去重。
- **锚点**：#74 终裁；task 语义 §1/§3/§7；bb-fleet-shape.md；分类表 §2.3 task 行；`T:task/index.ts`+`T:task/types.ts`+`P:task.md`。
- **DO 预算（实践 11）**：每 spawn=子 AgentDO 创建/续用 + 父↔子消息/yield 投递（跨 DO RPC ×O(消息数)）——票内须给单 spawn 请求量上界表（含 500 KB/5000 行投递截断不经 DO 全量转发，inline 摘要 5000 字符帽）。
- **效率预算**：≤1 窗（batch/生命周期/isolation 显式切出）。
- **上游化（实践 10）**：子代理形状=bb 同构（双轴/fork/sendToMain 逐字），上游化形态即 bb fleet 形状本身。
- **blocker**：T1、T2。**下游**：T17-T20。

#### T17 yield 全语义 + agent:// 工件族（P0）
- **需求**：子代理唯一收尾门 + 工件读取面——「父代理永不拿过期结论行动」的保证面。
- **规格**：yield 照抄 `T:yield.ts`：增量 `type:string[]` 分节累积 + 终态两形态；缺失 yield 恢复梯（≤3 提醒，末次强制 `toolChoice=yield`，仍无则注入 SYSTEM WARNING）；连续 3 次空结果 abort；schema 连续 3 次失败放行带 `schemaOverridden`；**yield-supersession**：后到 async-result 作废 stale yield 强制重 yield（task 语义 §7 点名必抄，漏抄则异步回灌与结构化输出静默不一致）。工件族=子代理 DO storage `<id>.md/.jsonl/.json` sidecar；`agent://<id>` 解析 + JSON 路径后缀抽值 + 嵌套点号 id + `agent://all` 只写广播；`history://<id>` 简洁转录渲染；500 KB/5000 行投递截断。
- **交付/验收**：L1=提醒梯三档、supersession 强制重 yield、sidecar 无效 schema 也写、agent:// 抽值矩阵。
- **锚点**：task 语义 §3；矩阵 §2.4；`T:yield.ts`+`P:task.md` §Result。
- **DO 预算（实践 11）**：工件落子代理 DO storage；父读取经 `agent://` 跨 DO 读 ×1/次（不缓存进父 DO，重复读重复计——预算表注明）。
- **效率预算**：≤1 窗。
- **上游化（实践 10）**：bb 面零改动（agent:// 是 omp URI 面，bb 经 provider 透传）。
- **blocker**：T16。

#### T18 task batch + Semaphore/预算 + 投机预启动（P0）
- **需求**：omp 派发默认形（batch）与并发/预算治理。
- **规格**：batch 照抄（`task.batch` 默认 on）：`{context, tasks[]}`、context 必填渲染进子代理 CONTEXT 节、校验五拒绝（空 tasks/缺 context/项缺 task/重名/顶层并存）、batch 容器 `model` 直接拒绝；flat 兼容收（lenient）；会话级 Semaphore `task.maxConcurrency` 默认 32 就地伸缩跨调用统一；软预算 200 请求→notice、1.5× 强停逼终局 yield 仍投部分发现；`maxRuntimeMs` 默认 0；防自锁 provider 流按单槽托架（task 语义 §4.1）；投机预启动照抄默认 on（流式逐项闭合即 SpawnRun、dispatch 收养或全弃）——若流式 toolcall 解析基建使其超窗，可裁为尾随子票（§4 裁决点 4）。
- **交付/验收**：L1=校验五拒绝、Semaphore 就地伸缩、预算梯三段（notice/强停/部分发现投递）、收养不匹配全弃。
- **锚点**：task 语义 §1/§4；omp `docs/tools/task.md` §Async/§Timeout。
- **DO 预算（实践 11）**：编排/Semaphore 在父 DO 内；并发 spawn 的跨 DO 面=T16 上界表 × 并发数，票内给峰值合并预算（32 并发上界）。
- **效率预算**：≤1 窗（投机预启动若切出则 ≤半窗）。
- **上游化（实践 10）**：bb 面零改动。
- **blocker**：T16、T17。

#### T19 子代理生命周期四态 + 复活 + wait 协作 + kill（P0）
- **需求**：子代理注册表生命周期与取消/协作面，task 集群闭环票。
- **规格**：四态 `running|idle|parked|aborted` 照抄：完成（成功/失败）→idle+adopt（可追问）、TTL 7 min（`agentIdleTtlMs=420000`，≤0 关）→park（释放 session、保留 ref+sessionFile）、`write agent://<id>` 复活（从转录重建）、`aborted` 终态墓碑不可逆、**budget 中止是唯一可复活 abort**（不对称语义照抄）、Main 永不 park、注册 CAS（`registerIfAvailable`）；取消三入口（`proc://<id>/kill`、父调用 signal——后台 job 已 detach 不受影响、墙钟）；wait 协作（T2 JobRegistry 消费：owner 过滤、photo-finish、steering 即醒）。
- **交付/验收**：L1=四态迁移全图断言、park 后复活收据 `revived`、墓碑抗延迟回调、kill 幂等（业务取消语义，§2.4）。
- **锚点**：task 语义 §4.2/§5；omp `docs/tools/task.md` §Lifecycle。
- **DO 预算（实践 11）**：park=本 DO 状态写；复活=消息触发零轮询（TTL timer 用子代理 DO alarm，实践 4）。
- **效率预算**：≤1 窗。
- **上游化（实践 10）**：bb 面零改动（生命周期字面量随 provider 语义透传）。
- **blocker**：T16-T18。

#### T20 task isolated 隔离后端（daemon 半）（P1）
- **需求**：task 的 hybrid 执行半：`isolated:true` 工作区隔离——M1.5 内 hybrid 拆缝规则的收口演示。
- **规格**：隔离执行体=daemon 侧（宿主 fs/git/natives PAL）：`parseIsolationBackend`→PAL 候选降级链（overlay→克隆→递归拷贝兜底）、基线快照 ≤1 GiB 超限 spawn 前失败、patch/branch 两式回收合并（`repo.canApplyPatch` 预检、`omp/task/<agentId>` cherry-pick、失败救援 `<id>.patch`）、apply 门默认开、keep-alive 隔离代理跨 park 保留工作区、显式 release 才捕获合并；**随票核对 #78 死点**：`task-follow-up.md` 模板「isolated 不可恢复」与保留工作区生命周期的矛盾，以实现为准并记录（#74 裁决第 4 条）。派发帧仍工具无关（executor 实现 task 宿主半）。
- **交付/验收**：L1=后端降级链、基线超限失败、patch/branch 回收矩阵、apply 门关=只捕获；#78 死点核对结论入票。
- **锚点**：task 语义 §2/§7；分类表 §2.3 task 行；omp `docs/tools/task.md` §Isolation。
- **DO 预算（实践 11）**：每隔离操作 dispatch/ack ×2；快照/合并审计入既有 journal，无新增事件族。
- **效率预算**：≤1 窗。
- **上游化（实践 10）**：bb 面零改动。
- **blocker**：T16（+daemon 宿主 git 基建）。

### 波 5：discoverable host 补全（P1，随裁剪）

#### T21 github（P1）
- 需求/规格：`Bun.spawn(["gh",…])`（5min 截止/8MiB 捕获）+ pi-natives git（worktree/branch）+ 临时文件，宿主执行；**REST 不重投影**（pr_checkout/pr_push 绑本地 worktree，分类表 §6.2 死点：整体留 daemon 不做半迁）。schema 照抄 `T:gh.ts` op 分派+`P:github.md`。
- 验收：op 分派矩阵 + 超时/捕获帽 + worktree 隔离（pr_checkout 走专用 worktree）。
- 锚点：分类表 §2.1/§6.2；omp `docs/tools/github.md` §Side Effects。
- DO 预算（实践 11）：同 T5 形。效率预算：≤1 窗。上游化（实践 10）：bb 面零改动。
- blocker：T9。

#### T22 lsp（P1）
- 需求/规格：LSP server 子进程 JSON-RPC + fs rename/WorkspaceEdit 宿主执行；per-action 20s（5–300 夹紧）、abort 发 `$/cancelRequest`、server 发起 applyEdit 在调用 abort 范围外；**rename/apply 类非幂等显式标注**（矩阵 §2.1）。
- 验收：server 生命周期管理 + 超时夹紧 + cancel 传播。锚点：分类表 §2.1；omp `docs/tools/lsp.md`。
- DO 预算：同 T5 形。效率预算：≤1 窗。上游化：bb 面零改动。
- blocker：T9。

#### T23 ast_grep + ast_edit（P1）
- 需求/规格：napi natives（`pi-natives/src/ast.rs`）扫/析/配/改写宿主执行 + staged 预览（resolve/reject 裁决流落点随目标工具类，xd 设备派发面本票不涉及——xdev 界外）；与 T8 共享 natives 管线集成经验。
- 验收：pattern 匹配等价性（`$A==$A` 同节点约束）+ staged resolve/reject 两路。锚点：分类表 §2.1；omp `docs/tools/ast-grep.md`/`ast-edit.md`。
- DO 预算：同 T5 形。效率预算：≤1 窗。上游化：bb 面零改动。
- blocker：T8。

#### T24 debug（P1）
- 需求/规格：DAP adapter 进程/socket 传输宿主执行；action 分派照抄 `T:debug.ts`；会话独占（单 active session）语义照抄。
- 验收：launch/attach/断点/续跑最小环。锚点：分类表 §2.1；omp `docs/tools/debug.md`。
- DO 预算：同 T5 形。效率预算：≤1 窗。上游化：bb 面零改动。
- blocker：T9。

#### T25 ida（P1，PM 裁剪点）
- 需求/规格：omp 自身 daemon-broker 同族先例（`omp.ida.<id>` daemon + Python idalib worker + 项目级 broker 共享）——本票价值一半在验证「一条 daemon 链多工具共享 broker」形状，一半在功能面；若用户无逆向需求可裁出 M1.5（§4 裁决点 3）。
- 验收：broker 共享 + worker 生命周期。锚点：分类表 §2.1 ida 行；omp `docs/tools/ida.md` §Source。
- DO 预算：同 T5 形。效率预算：≤1 窗。上游化：bb 面零改动。
- blocker：T9。

### 波 6：收官

#### T26 工具面 replay 一致性全量回归 + 对照差距清单收窄 + 关票门（P0）
- **需求**：ROADMAP M1.5 验收面的收口：「工具面 replay 一致性 + 对照差距清单收窄」。
- **规格**：全注册工具 × 重放/驱逐注入矩阵（`evictDurableObject`/`abortAllDurableObjects`）跑一致性断言；non-power 工具（bash/task/eval 命令本体非幂等）的 outcome-unknown 暴露语义逐票核对（矩阵 §6 边界：dispatch 去重保护「不二次 spawn」，不保护「重跑本体」）；对照差距清单逐项收窄记录（M0 验收遗留项→本阶段处置）；与 #24/#25（M1 决策票）的重调政策接口对齐核对（executed 标记制衔接）。
- **交付/验收**：回归矩阵全绿 + 差距清单收窄记录 + milestone 关票（practice 12：打 tag + CHANGELOG；PR-per-lane）。
- **锚点**：ROADMAP M1.5 行验收列；矩阵 §1/§6/§7；engineering practice 12。
- **DO 预算（实践 11）**：零生产路径变更；测试面自身请求量不计。
- **效率预算**：≤1 窗（矩阵表驱动，禁临时发挥）。
- **上游化（实践 10）**：验收面非 bb 面。
- **blocker**：全部 P0 票（T1/T2/T5-T14/T16-T19）。

---

## 4. PM 裁决点清单（发布前过堂）

1. **P1 范围**：T3/T4/T15/T20/T21-T25 是否全入 M1.5，还是 essential 主干（P0）先行关票、P1 转 M1.5 后续批？（ROADMAP 写「33 内建/13 essential」双口径，需一刀。）
2. **记忆后端（T13）**：HTTP 服务化（整体边缘化，5+1 件 DO 本地）vs 本地 SQLite/文件（daemon 半）——涉及自托管部署拓扑与凭据面。
3. **ida（T25）**：用户有无逆向工作流需求；无则裁出（broker 形状验证价值可由 T20 部分替代）。
4. **投机预启动（T18 内）**：omp 默认 on；若流式 toolcall 逐项解析在 M1.5 超窗，允许裁为尾随子票（默认关闭发布，追随上游默认的偏差须在票面记录）。
5. **goal（hidden）**：分类表 §6.4 无工具文档，不立票；是否授权先补实读（omp `T:goal.ts` + 注册面）再定。
6. **ROADMAP 修正**：M1.5 行「subagent 工具等 M1 fleet」按 #74 终裁改为「同 host subagent 即刻、跨 host 派发归 M1」（发布时随票更新）。

## 5. 关票门（practice 12）

T26 通过 → M1.5 关票：打 tag、更新 CHANGELOG、staging 部署经 `nix run .#staging-deploy`；票据逐票留 PM 亲验证据（双设备/真实 daemon 链路 demo）。

> AGENT GENERATED: by zhipu-coding-plan/glm-5.3-flash:max (proposal draft, #33 M1.5 slicing)
