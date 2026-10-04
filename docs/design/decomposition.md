# 分解（decomposition）——两级结构

**定位**：架构总索引。两级：**块**=所有权/验证风格边界（3 块，用户裁决 2026-10-04）；**模块**=设计单元（藏一个秘密、一窗可懂）。

**切分纪律**（可移植到任意项目）：①模块藏一个易变决策（Parnas 秘密切分）②深模块：接口窄行为多（Ousterhout）③单一变化理由 ④一窗可懂 ⑤依赖无环、绕接口摸状态=违规（import 可 lint）。命名按藏的什么用域内名词，禁跨域类比名。

## 三块

| 块                | 藏的秘密                                            | 变化理由                  | 验证风格                                             | 仓对应                                                                                              |
| ----------------- | --------------------------------------------------- | ------------------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| **bb ux**         | 用户看到与操作什么（bb 语义面）                     | bb 上游演进（跟随不发明） | SPA 零改动 + 路由契约对照（实践 10）                 | `bb/`（submodule）+ `apps/server-worker`                                                            |
| **agent content** | 对话内容如何表示/裁剪/组装/留存                     | 内容策略变                | 纯函数 + replay 一致性（同输入同装配、驱逐重放不变） | `packages/agent-do` 内容半                                                                          |
| **agent harness** | 对话如何被驱动与执行（事件编排/工具/provider/宿主） | 执行语义变                | 注入/混沌（断流/宿主离线/驱逐/并发）                 | `packages/agent-do` 驱动半 + `apps/provider-app` + `packages/daemon-service` + `apps/daemon-worker` |

块间依赖单向：harness 驱动 content；ux 投影 content、命令进 harness。bb ux 永不反向感知其余两块内部。

**归置已确认（用户 2026-10-04）**：回合循环归 harness（"事件编排"），content 块整体纯函数+replay 验证成立。块间局部模糊按 Linux file/socket 先例视为常态——模糊处记台账，不为消模糊强造边界。

## 模块台账（10 模块 × 块归属）

| 模块              | 块      | 藏的秘密                                                                         | 接口（入口数）                               | 独占状态                 | 失败域            | 成熟度                                                                                                            |
| ----------------- | ------- | -------------------------------------------------------------------------------- | -------------------------------------------- | ------------------------ | ----------------- | ----------------------------------------------------------------------------------------------------------------- |
| **投影**          | bb ux   | 事件→用户所见（bb UX 语义）                                                      | project(log)→view（1）                       | 无                       | 无                | 🟢 M0 已通                                                                                                        |
| **事件日志**      | content | 存储与重放格式（schema/seq/overlay 合成）                                        | append/replay/tail（3）                      | ThreadDO SQLite          | 驱逐（日志幸存）  | 🟢 M0+安全研究                                                                                                    |
| **压缩**          | content | 窗口何时/how 裁剪（触发/保留/**方法阶梯 DEFAULT_COMPACTION_METHOD_ORDER**/链深） | shouldCompact/apply（2）                     | CompactionEntry          | 崩溃→旧窗口可重放 | 🟢 #79（M1 实现）                                                                                                 |
| **上下文装配**    | content | 提示如何组装（布局/工具注入/翻译/token 会计）                                    | assemble(events,overlay)→messages（1，最深） | **无（纯函数，已确认）** | 无                | 🟡 #147 装配消费 checkpoint/rewind 切口（translate 活动分支折叠+summary overlay）；布局/工具注入/token 会计未设计 |
| **回合循环**      | harness | 一个 turn 如何推进（排队/交织/中断/恢复/**重试级联 TurnRecovery**）              | enqueue/interrupt/当前态（3）                | 活动回合与队列           | 驱逐→日志重建     | 🟡 FSM 已设计；排队/中断/重试级联未                                                                               |
| **Provider 会话** | harness | 上游调用如何存活（句柄/流规范化/断流恢复/退避）                                  | start/stream/settle（3）                     | 会话句柄+重试态          | 断流→续跑非重放   | 🔴 未设计                                                                                                         |
| **工具派发**      | harness | 工具集如何存在与路由（注册表/类路由/edge 执行）                                  | dispatch(call)→result（1）                   | 注册表（编译期）         | 拒绝无副作用      | 🟢 #91 在跑                                                                                                       |
| **工作区解析**    | harness | 路径→宿主映射（绑定/host:path/覆盖）                                             | resolve(path)→target（1）                    | 无（绑定在轨迹）         | 无                | 🟢 已设计；**浅模块折叠候选**（M1.5 裁）                                                                          |
| **宿主链路**      | harness | 宿主如何在线（租约/会话/协议/退避/公告）                                         | 帧收发+在线态（2）                           | 租约会话                 | 宿主离线→执行悬置 | 🟢 M0+#68                                                                                                         |
| **子代理**        | harness | 派生代理如何派发与汇合（spawn/yield/工件/生命周期）                              | spawn/message/wait（3）                      | 派发表+信号量            | 子死→父收尸       | 🟢 #77/#78（#106-109）                                                                                            |

**记忆/技能资产**（learn/recall 数据面、M2 skills 语料）：content 块未来模块（#103/#104）。

## 空洞（设计未做）

回合循环半边（排队/中断/重试级联）、上下文装配、Provider 会话。考古已落（docs/research/omp-agent-core-loop.md，PR #117）：装配五件套（buildSystemPrompt 分块序/project-context 恒尾保缓存稳定/JSONL 单一物化/WeakMap 身份缓存）、Provider 会话（TurnRecovery 级联=同模退避→用量腿→模型链→Fireworks→终局；重试仅在 replay-safe 窗口内）、回合循环两层（Agent+agentLoop 机制层 vs AgentSession 策略层；steer/followUp 双 FIFO；无墙钟 idle）。设计票据此起草。
