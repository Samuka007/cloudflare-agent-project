# M1.5 收官记录：工具面 replay 一致性回归矩阵 + 对照差距清单收窄（T26 / #116）

> 正本票卡：docs/proposals/m15-ticket-set.md §3 T26。本文是该票的差距清单收窄记录 +
> 关票门证据；矩阵本体在 `packages/agent-do/test/t26-replay-matrix.test.ts`（表驱动，
> 完备性由测试强制——注册表新增行而无矩阵条目时套件红）。
>
> AGENT GENERATED: by lane-116-m1-5-t26-replay-p0（zhipu-coding-plan/glm-5.3-flash）

## 1. 回归矩阵（交付一：全注册工具 × 重放/驱逐注入）

**口径对齐**：分类表的「33 工具」是 omp 宇宙（15 host / 11 edge / 7 hybrid，
omp-tool-execution-classification.md §2）；ROADMAP 行的「28 工具面」是票集发布时的
目标面（含 learn/记忆族，后被 #103 裁决移出，关账口径=essential 12）；**本阶段注册面
=21 行**（10 host：bash/read/edit/glob/grep/find/security_scan/write/eval/manage_skill；
11 edge：ask/checkpoint/rewind/context_notes/new_context/task/wait/todo/web_search/
think/yield）。票卡规格的验收对象是「**全注册工具**」——矩阵以 `TOOL_REGISTRY` 为唯一
驱动源，行数漂移时矩阵自动跟随、缺条目即红。

**逐行断言面**（每注册行四格，锚点 tool-retry-idempotency-matrix.md §1/§6）：

| 格           | 断言                                                                                                                                                         | 证据锚                                               |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------- |
| dispatch 面  | 实走 agent loop：`tool.call` 先落盘（I4），executionId=`${threadId}:${seq}` 派生                                                                             | agent-do.ts:2011-2014（dispatchExecution 守卫注释）  |
| 驱逐面       | `abortAllDurableObjects()`（整 worker 硬杀）+ `evictDurableObject()`（定点，SQLite 存活）两种注入动词都用上：journal 逐字节重放一致（seq/type/id 指纹）      | 矩阵 §1「重放即真相」                                |
| 去重面       | 同 executionId 重问：host=服务端 `completed_cached` 应答（spawn_ack 计数恒 1，跨复活以 journal 为证）；edge=`dispatchExecution` 终态守卫 no-op（零二次执行） | daemon.ts:28-35；service-do.ts:213-225；矩阵 §6      |
| non-power 面 | bash/eval 另加 outcome-unknown 格（见 §2）；task 另加 spawn-plan readopt 格（见 §2）                                                                         | 矩阵 §6 边界（tool-retry-idempotency-matrix.md:123） |

**host 行中跑驱逐的精确形状**：log 只增不改（前缀逐字节相同），恰好追加一条
`tool.dispatch` attempt=2 的恢复动词行（I15/I16 形状）——不是恒等快照，是
append-only 加单条恢复动词。

**edge 行 DO 预算格**（提案 §1 默认约束）：零 `tool.dispatch` 事件、service journal
恒空——edge 执行全程在本 DO 消化。

**专项驱动行**：ask=阻断中硬杀后裁决回流仍落 journal（T4 锚）；web_search=MSW 出站
fetch 计数为重执行可观测量（一次 fan，重放零二次 fetch，T12 锚）；task/yield=真子
AgentDO 后台链（T16/T17 锚）：task 终态重问走 readopt 应答 registration receipt
（plan 恒 1、零二次 spawn，executor.ts:601-604），yield 在**子 DO** journal 上做同套
重放/重问断言。

**face 数**：注册面 21 行 + 注册表形状/wire 渲染/表面投影 3 项 = **26 用例全绿**。
运行：`cd packages/agent-do && npx vitest run test/t26-replay-matrix.test.ts`。

## 2. non-power 工具 outcome-unknown 暴露语义逐票核对（矩阵 §6 边界）

矩阵 §6 边界的原文承诺（tool-retry-idempotency-matrix.md:123）：dispatch 去重保护
「不二次 spawn」，**不保护「重跑本体」**——本体已开跑而结局不可知时，outcome-unknown
负责**暴露而非掩盖**。逐票核对结果：

| 票     | 工具 | 核对结论                                                                                                                                                                                                                                        | 证据（测试为准）                                                           |
| ------ | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| T9/T5' | bash | new-boot kill-list 命中 → `tool.result` status=`outcome_unknown` 落盘为**持久终态**；UX 投影渲染 `interrupted`（不是假完成）；恢复动词（同 executionId 重问）被 agent 侧终态守卫 no-op，**零静默重跑**；硬杀重放后终态逐字保留（从不改写为 ok） | 矩阵 outcome-unknown 格（bash）；I18（invariants.test.ts:708-741）；l1-i28 |
| T10'   | eval | 同上（同一 kill-list 语义，帧工具无关）；内核本体半：DO 驱逐重放=host 持久内核 re-attach 不二次 spawn                                                                                                                                           | 矩阵 outcome-unknown 格（eval）；eval-kernel.test.ts:110-124/:213-226      |
| T16    | task | edge 无外部进程，outcome-unknown 不适用；non-power 面=重复子 spawn 防护：spawn plan 是 journal 真相，终态重问=readopt 应答 receipt（plan 恒 1）；settlement confirm-only（墓碑抗性）                                                            | 矩阵 task 格；task/executor.ts:601-606；task/lifecycle.ts:80-83            |

**残余边界（记录，不阻塞）**：service DO 层的 dispatch 去重点只缓存
COMPLETED/TOMBSTONE（service-do.ts:216-219），UNKNOWN 不在缓存集——但唯一派发方
（agent DO）对终态执行永不重派（agent-do.ts:2013-2014），铁律④在 agent 层闭合；
服务层若被外来派发方重问 UNKNOWN，行为未在 §3.5/E 承诺范围。M1 #25 白名单票接管
「本体重跑」的命令级白名单（矩阵 §7.3）。

## 3. 对照差距清单逐项收窄（交付二）

来源：M0 验收面的对照差距清单 = bb-ux-gap-matrix.md（#72/#45/#76 普查矩阵）的
M1.5 归桶项 + ROADMAP M1.5 验收列遗留。逐项处置：

| 项                            | M0 时点                                                                                                      | M1.5 处置                                                                                                                                                                                                                                                                            | 状态                            |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------- |
| C5 @-file mentions            | 🟡 thread/project/section 可提及；文件路径需 `GET /projects/:id/paths`（404），归「M1.5 随 host 文件工具链」 | **收窄**：数据生产半已交付（host read/glob/grep/edit/write 注册并在矩阵内全绿，宿主 fs 链真通）；REST 面（projects/paths 路由）属 bb app 面，M1.5 票集不含——显式转 M1 顺手修桶，不再挂在工具票上                                                                                     | 部分收窄（生产半✓，路由半转出） |
| D13 pending interactions      | ✅（合法空）「M1.5+ 随权限 prompt 面复活」                                                                   | **收窄**：生产者半已由 T4 交付——interaction.registered/resolved journal 行 + `/ws` pending-interaction push + resolveInteraction 回流全链 L1 绿（ask.test.ts；矩阵 ask 格=阻断中硬杀后裁决仍落账）；权限确认卡生产者（permission prompt）仍无（ceiling=full 自动批准），归 M1 权限面 | 生产者半✓（ask），权限半留 M1   |
| D11 Terminal                  | ❌「M3（或随 M1.5 daemon 工具链提前）」                                                                      | **前置收窄**：daemon 工具链（bash host 执行半）已全交付并在矩阵内；terminal 面板本身维持 M3                                                                                                                                                                                          | 前置达成，面板维持 M3           |
| #24/#25 重调政策（M1 决策票） | 「缝须在恢复实现冻结前留好」                                                                                 | **接口对齐核对完成**（见 §4）：缝已冻结成型，M1 决策票可在不动接口的情况下落政策                                                                                                                                                                                                     | 缝就绪                          |
| ROADMAP M1.5 行               | 「矩阵 28 工具面」                                                                                           | 关账口径随 #103 改写为 essential 12；本矩阵以注册面 21 行为验收对象（见 §1 口径对齐）——ROADMAP 行随本票更新为 21 注册面口径                                                                                                                                                          | 口径闭合                        |

**M0 遗留中显式不在本阶段处置的**（维持原归桶，无漂移）：M1 补验清单（A3/A4/B2/B3/
C9/D3/D4/D5/D14/E1/F7）、M1 顺手修（B4/F8/B6/C6/D7/D12/E9）、M2/M3/永久裁剪桶——
bb-ux-gap-matrix.md §差距汇总为准，本票不改桶。

## 4. 与 #24/#25 的重调政策接口对齐核对（executed 标记制衔接）

矩阵 §7 的证据映射要求：omp 的工具重发先例是**显式标记制**（只有带 `executed:false`
合成结果的调用可重发）。核对结论：**M1.5 的恢复接口已按同构缝冻结，M1 落政策无需改
接口**——

1. **标记的持久基底已存在**：`tool.call` journal 行在任何执行前落盘（铁律①，
   agent-do.ts:2011-2014），每次派发记 1-based `attempt`（fsm-events.ts:174-181）。
   #24 的 executed 标记可直接以「该 executionId 的 tool.call 行 + attempt/终态行」
   派生，不需要新表。
2. **唯一恢复动词=同 executionId 重发/重问**（铁律③）：服务端去重
   COMPLETED/TOMBSTONE→`completed_cached`（daemon.ts:32-33；service-do.ts:213-225），
   agent 侧终态守卫 no-op——重发的边界已被幂等键圈死，政策层只决定**谁**有权发起。
3. **不可知结局永不静默重跑**（铁律④）：`outcome_unknown` 是 zod 枚举成员 + 持久终态
   （fsm-events.ts:39；turn-state.ts:36-45 TERMINAL_EXECUTION_STATUSES；
   service-do.ts:1305-1307），UX 渲染 `interrupted`（ux-projection.ts:192-197）——
   #25 白名单的「暴露」半已在协议与投影两层就位。
4. **矩阵逐行回归锁死该缝**：21 行 × 去重/重放/暴露格全绿意味着任何未来改动若破坏
   executed 标记制的基底（tool.call 先行、终态守卫、UNKNOWN 持久化）即刻红。

## 5. 关票门（practice 12）状态

| 步               | 状态           | 说明                                                                                                           |
| ---------------- | -------------- | -------------------------------------------------------------------------------------------------------------- |
| 回归矩阵全绿     | ✅ 本 lane     | 26 用例；agent-do 全套 289 passed/1 skipped（真模型 smoke 无凭据自跳）、daemon-service 49 passed               |
| 差距清单收窄记录 | ✅ 本 lane     | 本文 §3                                                                                                        |
| CHANGELOG        | ✅ 本 lane     | `[m1.5]` 段已备（随 lane PR 入 main）                                                                          |
| 打 tag `m1.5`    | ⏳ merge 后 PM | PR 合入 main 后按 practice 12 打 tag                                                                           |
| staging 部署     | ⏳ merge 后    | `nix run .#staging-deploy`（GHA deploy-staging 自动面）                                                        |
| PM 亲验证据      | ⏳ merge 后 PM | 双设备/真实 daemon 链路 demo：ask 弹窗、task 子代理呈现、eval 跨消息状态（handoff-2026-10-04.md 用户签收动线） |

**DO 预算（实践 11）**：零生产路径变更——本票只新增测试文件与文档；测试面自身请求
量不计。**效率预算**：矩阵表驱动、零临时发挥。**上游化（实践 10）**：验收面非 bb 面，
bb 零改动。
