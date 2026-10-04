# omp 工具中断/重试/幂等语义考古（#71，喂 #24/#25）

研究对象与方法：omp 内嵌工具文档（本机安装版，`omp://tools/*.md` 及 `bash-tool-runtime.md`、`non-compaction-retry-policy.md`、`natives-rust-task-cancellation.md`、`blob-artifact-architecture.md`、`provider-streaming-internals.md`、`rpc.md`；文档随版本走，引用格式 `omp://<path> §节`）；loop 层语义复用 `docs/research/omp-engine-portability.md`（#28，源码锚 `d4d49e71`）；dispatch seam 用我们自己的 `docs/design/unified-turn-state.md`（#23）§2.4/§4/§8 与 `packages/agent-do`、`packages/daemon-service` 实现；bb 对照引 `docs/research/bb-daemon-protocol.md`（下称「bb 研究」）。本文只陈述证据，不做设计决定；映射建议见 §7。

---

## 0. 结论速览

| 问题 | 一句话结论 |
| --- | --- |
| 工具级重发安全性 | 只读类（read/glob/grep/find/web_search）天然安全；覆盖写（write 普通文件）幂等；bash/task/eval 重发=副作用重复或重复工作，omp 无任何工具级幂等机制 |
| 部分输出如何回传 | 统一走 OutputSink：内存尾窗（bash/eval 默认 50KiB）溢出即镜像到会话域 artifact，`artifact://<id>` 可反复读；超时/失败也 finalize sink，已产出的部分不丢 |
| 取消/超时后清理 | 分层：run 级 abort 不杀工具，side-effecting 前台工具只看外部 signal；原生工具靠协作取消（heartbeat / Tokio token + TERM/KILL 波）；bash 持久会话超时会被隔离；不可协作的子进程可能残留（文档明示的 pitfall） |
| 模型流中断重发（#24） | omp 从不重放已提交的部分流：重试=continue（保留历史），由 replay-veto 把关；只有带 `details.executed === false` 合成结果的调用才被重发；首字节后一律 seal 不重调 |
| 桥/传输层 | omp RPC 无 per-request 超时、无 SSE 续传；stdin EOF 时已接受命令跑完、pending host-tool 请求被拒——桥必须自带 deadline 与 executed 标记 |
| 我们 seam 的对应物 | executionId 全链路幂等键 + journal 先行 + 服务端去重（完成即答缓存结果），保护的是「同一执行不二次 spawn」；不保护「重跑命令本体」——这正是 #25 白名单的对象 |

---

## 1. 分层模型：幂等责任在哪一层

| 层 | 幂等原语 | 证据 |
| --- | --- | --- |
| 模型流层 | replay-veto + seal（绝不重放已提交文本；首字节后封口） | `non-compaction-retry-policy.md` §Replay safety；`provider.ts:75-77`（`afterFirstByte` → seal，never re-call） |
| 工具 dispatch 层 | executionId 全链路唯一键 + 服务端 journal 去重 | `ids.ts:3-9`；`unified-turn-state.md` §4.1；`service-do.ts:189-193`（I16） |
| 工具本体层 | 各工具自身副作用形状（本文 §2 矩阵） | 各 `omp://tools/*.md` |

平台研究的先验约束（`do-turn-lifecycle-safety.md` §6 表）：DO 崩溃时「执行到一半的外部副作用无法回滚……必须幂等工具」——工具本体层不幂等时，安全重发只能靠 dispatch 层去重或显式白名单。

---

## 2. 工具矩阵（逐工具：重发安全 / 部分输出 / 取消与超时）

### 2.1 只读类

| 工具 | 重发安全？ | 部分输出形状 | 取消/超时与清理 | 引用 |
| --- | --- | --- | --- | --- |
| read | 安全（只读；唯一副作用是会话 EditStore 快照与 seen lines） | 越界行返回说明文本不抛错；截断元数据 `details.meta.truncation`（range/total/next offset/artifactId） | 磁盘行读**不接 AbortSignal**（中断不产生误导性 "Operation aborted"）；URL/archive/sqlite 分支尊重 signal；无 per-call 超时 | `omp://tools/read.md` §Side Effects/§Errors/§Outputs |
| glob | 安全（不写文件） | 超时返回**成功的截断结果**；零匹配时只给 incomplete-scan 提示，绝不宣告「不存在」 | 本地 glob 超时固定 5000ms，超时=成功+提示而非抛错 | `omp://tools/glob.md` §Outputs/§Limits & Caps |
| grep | 安全（文件只读；archive 成员临时文件 `finally` 清理） | 20 文件/页 + skip 分页；每文件 20/200 行帽；超大文件只搜前导窗口并注明部分覆盖 | 30s 原生超时抛错（`SEARCH_GREP_TIMEOUT_MS`）；JS 侧 `untilAborted` 包装 | `omp://tools/grep.md` §Limits & Caps/§Errors |
| find | 文件只读但重发重烧 judge token（无去重） | judge 失败不抛错：失败请求留未判条目、footer 列 `E of R failed`；全部失败才报错 | 20s 总预算抛 `find timed out`；judge 单尝试 10s×3；调用 abort 原样重抛 | `omp://tools/find.md` §Limits & Caps/§Errors |
| web_search | 安全（只读；model-backed provider 重发会再次计费） | 无流式/无 artifact 回读；provider 失败以 `Error: …` 文本结果返回并推进链条 | 每 transport 60s（帽 300s），**非全链 deadline**；Public Web 5s 软/30s 硬收口，掉队者 abort；signal abort 用 `throwIfAborted` 重抛 | `omp://tools/web_search.md` §Timeout/§Cancel |
| lsp（读动作） | 安全；**rename_file/apply 类不幂等**（重试=再改名或失败） | 校验失败多以 `details.success:false` 文本返回；abort 抛 `ToolAbortError` | 每动作 20s 默认（5–300 夹紧）；abort 发 `$/cancelRequest`；server 发起的 `workspace/applyEdit` 在调用 abort 范围之外 | `omp://tools/lsp.md` §Inputs/§Flow/§Notes |

### 2.2 文件变更类

| 工具 | 重发安全？ | 部分输出形状 | 取消/超时与清理 | 引用 |
| --- | --- | --- | --- | --- |
| write | 普通文件覆盖写幂等；**三类目标不幂等**：SQLite insert 重复插行、`agent://<id>` 非空内容重复发消息、`proc://<id>` stdin 重复灌入 | 策略检查先于变更失败；批量冲突解决「部分成功→`isError:true`，成功 id 失效、失败 id 保留待重试」 | 无 per-call 超时；`untilAborted` 包装；普通文件走 `Bun.write()` **无 temp+rename**，仅 archive 写原子（临时兄弟文件+rename） | `omp://tools/write.md` §Modes/§Flow/§Side Effects |
| edit | 非幂等但有防双 apply：单段字节相同编辑=无变化诊断不写（第三次连续 no-op 报错）；stale 标签快照恢复仅在「快照链证明唯一安全结果」时应用，否则报 mismatch——失败安全，绝不写错内容 | 解析/锚点/no-op 失败全部发生在写入前=文件不动；仅 OS 写失败会留已落地前缀（多文件段按序写） | exclusive 并发（独占工具批次）；无 per-call 超时文档；新引入语法错误**不回滚**，只产警告或 autoRepair 修复注记 | `omp://tools/edit.md` §Limits and validation/§Output and side effects |
| context_notes | 整本替换写安全（失败留旧修订；超限「先失败后追加」）；清空=追加空修订不删历史 | 无部分写：分支变更发生在写盘准备中→拒绝，而非写到别的分支 | 取消检查前置，取消/持久化错误向调用方传播；无超时文档 | `omp://tools/context-notes.md` §Retry semantics/§Partial state |

### 2.3 进程/内核执行类

| 工具 | 重发安全？ | 部分输出形状 | 取消/超时与清理 | 引用 |
| --- | --- | --- | --- | --- |
| bash | **不幂等**：重跑=整条命令副作用重复，无任何幂等机制；非零退出/超时已给 `isError` 结果，勿重跑验证 | stdout+stderr 合并单流；默认 50KiB 溢出即 spill 成 `artifact://<id>`（头尾窗 20KiB，完整输出可反复读）；流式更新尾窗 50KiB | 默认 300s、`timeout:0` 双双解除 deadline 与看门狗；非 PTY 路径 native run 拥有 deadline，host 看门狗 `max(1000,timeout)+5s` 兜底（赢了则警告输出可能不全并**隔离持久会话**）；取消=native run abort + PTY kill；持久会话里活着的后台子进程可拖住回收；job 级取消 `proc://<id>/kill`；`bash.patterns` deny/prompt 可挡破坏类，但**不覆盖 eval 内壳**（runtime 文档明示） | `omp://tools/bash.md` §Inputs/§Async/§Cancel/§Re-dispatch；`omp://bash-tool-runtime.md` §Operational caveats |
| eval | 内核状态跨调用持久：「一次调用=一个 cell，用多次调用只重跑失败步」；重跑重放该 cell 自身副作用 | sink 即使执行失败也 finalize=已产出部分保留；>8000 字节的 `display()` JSON 全量进 artifact；尾窗 100KiB/3000 行帽 | 默认 30s IdleTimeout（0=无看门狗），跨等待暂停、恢复即新窗口；**取消是破坏性的**：JS 终止 worker、托管内核 interrupt 可升级 shutdown；死内核可被执行器替换并重试一次 | `omp://tools/eval.md` §Timeout/§Cancel/§Re-dispatch |

原生工具的取消力学（bash/grep/glob/pty 底座）：`task::blocking` 靠协作 heartbeat——「不能提前打断不协作的工作」；`task::future` 与 `ct.wait()` 赛跑，取消路径通常连带取消下属机制、宽限后强杀；shell 取消=对 spawn 注册表做 TERM/KILL 波（2s，Windows 5s），**取消作为类型化结果**（`cancelled`/`timedOut`）而非 reject；resolve 前已置 abort 标志则成功结果仍 reject。明示 pitfall：外层 token 取消而内层 reader/子进程任务继续跑。`omp://natives-rust-task-cancellation.md` L69/L83-84/L135/L161/L175/L202-204。

### 2.4 编排/交互类

| 工具 | 重发安全？ | 部分输出形状 | 取消/超时与清理 | 引用 |
| --- | --- | --- | --- | --- |
| task | **重发=新子代理**（新 id、名字 per-session uniquify），零去重=重复工作；后续跟进应 `write agent://<id>` 而非重新 spawn | inline 摘要 5000 字符帽；全量原始输出落 `<id>.md`；单次投递 500KB/5000 行截断 | 无工具级 deadline（`task.maxRuntimeMs` 默认 0=不限）；软预算 200 个 spawn、1.5x 强停落**部分发现**仍投递；kill=`proc://<jobId>/kill`、父调用 abort（sync 经 call signal）、`proc://<agentId>/kill` | `omp://tools/task.md` §Timeout/§Async/§Cancel/§Re-dispatch |
| wait | 重发安全：消费语义使双 wait 不重复投递；已结算未投递的 job 直接返回不再等 | 首个结算 job/消息即返回；消息打断给 `details.interrupted=true` | owned job/service 等 30 分钟安全帽（不可调）；消息窗走 5/10/30/60/300s 阶梯（≥60s 间隔重置）；无等待对象=立即快照 | `omp://tools/wait.md` §Returns/§Cancel |
| ask | 可重问（超时自动选择已落 transcript，重问即恢复路径；`/tree` 可重开 schema 合法原题） | 阻塞交互、独占并发（单独占一个工具批次） | `ask.timeout` 默认 0=不超时；超时自动选推荐项并标 `details.timedOut`；用户取消抛 `ToolAbortError`；headless 直接 `ToolAbortError` | `omp://tools/ask.md` §Timeout/§Cancel |
| new_context | **不幂等**：两次调用=两个 rollover 请求（无去重）；成功 ack ≠ rollover 一定提交 | 同步 ack；真正 rollover 由 owner 在下个 provider 请求前处理 | 请求是咨询性的：能力消失则 stale 请求被丢弃；取消检查在返回前 | `omp://tools/new-context.md` §Async/§Cancel/§Re-dispatch |
| checkpoint | **不幂等**：active 时再调报 `Checkpoint already active.`；崩溃发生在成功的 `message_end` 前=无检查点 | 单发，不返回任何 id/句柄/restore token | 单发无流式、无超时文档；实现不调 git、不拍文件系统快照 | `omp://tools/checkpoint.md` §Errors/§Outputs/§Notes |
| rewind | 防双 apply：已有完成的 rewind 再调=错误并指回保留报告 | 工具结果只是请求（`Rewind requested.`）；实际分支/折叠延迟到 `turn_end`；缺 checkpoint 条目=警告+从根分叉，已完成的调用绝不事后失败 | 应用在 `turn_end`，无独立 job/取消句柄；非破坏性（追加 branch_summary，旧条目留在 jsonl）；不合并不回滚代码 | `omp://tools/rewind.md` §Errors/§Flow/§Notes |

非注册面设备（`xd://*`）：`ast_edit` 天然两阶段（匹配先 staged，`resolve`/`reject` 定夺）；`github pr_checkout` 用独立 worktree 不碰工作树；memory 三件套/retain 的幂等由后端合并去重承担；debug/browser/generate_image 文档未陈述重发语义——按非幂等默认对待。跨工具横切事实：**防双 apply 守卫只在 edit（字节相同 no-op）与 rewind（已完成即错）两处有文档**；文档化的原子写原语只有 archive 的 temp+rename；已知的中途部分状态=edit 多文件段 OS 失败前缀、write 批量冲突的跨文件部分成功。

---

## 3. 部分输出的统一回传通道（OutputSink / artifact）

- 触发：内存尾缓冲超过 spill 阈值（默认 50KB）即标记 truncated 并开始 artifact 镜像；工具结果附 `artifact://<id>`，完整净化输出（至 artifact 帽 16MiB，头尾保留 + `ARTIFACT TRUNCATED` 告示与 `artifactElidedBytes`）落会话域文件。`omp://blob-artifact-architecture.md` §Why two storage systems/L131/L139/L141。
- 耐久性：artifact 写「临时兄弟→校验字节数/大小/可读→原子发布」；resume 不覆盖既有 artifact（先扫描再分配）；artifact 是按会话目录键控的磁盘文件，**跨重试、跨 compaction 存活**，经 `read artifact://<id>`（8MiB inline 帽）回读。同上 L72/L76/L162/L196-219。
- 会话持久化的截断：普通字符串 >500,000 字符截断存储；渲染产物已 spill 的 MCP `structuredContent` 从持久副本剥离。同上 L92-93。
- 不可恢复点：artifact 分配失败→无回引，输出丢失（bash/eval 文档各明示一次）。`omp://bash-tool-runtime.md` L315、`omp://tools/bash.md` L241。

---

## 4. 模型流中断与工具重发（喂 #24）

omp 侧事实链：

1. **无 SSE 续传**：「providers do not resume from an individual malformed chunk… does not replay a stream from the failed chunk」；重试=fresh attempt，**去重不是事件级的**，安全性全靠重试政策的 replay-veto。`omp://provider-streaming-internals.md` §Malformed chunk/L164-171。
2. **replay-veto**：「committed non-whitespace visible text, images, tool calls… normally prevent replay. Thinking-only and whitespace-only partials are safe to discard and retry.」`omp://non-compaction-retry-policy.md` §Replay safety (L52)。
3. **proven-unexecuted-tool exception**：每个已发射调用必须有后置合成结果 `details.executed === false` 才允许重发——「Recovery preserves these assistant/result pairs so continuation can reissue the unexecuted calls」。同上 L54。omp 不盲重发最后一个 tool call。
4. **preserve-and-continue**：中断 turn 的工具调用已有结果→「the failed assistant/tool-result sequence is preserved so completed side effects are not replayed」；纯文本部分 turn 无法不重复地重放→保留部分+developer 提醒继续，每 prompt 至多 3 次。同上 L68。
5. **配对不变量**（loop 层）：abort/error 只保留 `toolcall_end` 完成的调用；aborted assistant 补占位 toolResult；「a completed tool already ran its side effects, so the model must see what actually happened」——已完成工具保留真实结果。`omp-engine-portability.md` §1.5（agent-loop.ts:1520-1555/:2758-2760/:3656-3663）。
6. **重试形态**：重试是 `agent.continue()`，不是重发请求；退避 `min(500ms×2^(n-1), 8s)×(75–100% jitter)`、默认 10 次、`retry-after` 头覆盖；永久停机清单含用户 abort。`omp://non-compaction-retry-policy.md` L85/L90-91/L110-114/L257-269。
7. **取消分层**：abort signal 进 provider→错误路径 `stopReason="aborted"`；loop 在处理每个 provider 事件前查 `signal.aborted`，可从最新部分合成 aborted assistant；**工具取消与流取消分离**——side-effecting 前台工具只看外部 abort，steering 走协作 `steeringSignal` 不硬杀；截断的工具参数 delta 不炸流处理，`toolcall_end` 终重解析是权威。`omp://provider-streaming-internals.md` §Cancellation boundaries/L175-186/L127-138。
8. **看门狗**：首事件与空闲默认 300,000ms；看门狗本地 abort 落 `"error"`。同上 L158/L189-198。
9. **恰一次结算信号**：`prompt_result` 每个被接受 prompt 恰好一帧；`error.retryable` 是 omp 唯一可重试信号；计费/结算钩子挂 `sessionSettled`。`omp-engine-portability.md` §2.3（rpc-prompt-results.ts:38-111）。

与我们 seam 的对齐：`provider.ts:75-77` 的「首字节后 seal，绝不重调」= 事实 2+5 的我们侧表述；`agent-do.ts:443-462` 冷启动恢复序（A seal → I 重挂 kill → E 同 executionId 重发非终态执行）与事实 3+4 同构；`translate.ts:196-198` 首字节前失败调用被重试替换进历史 = replay-veto 通过的合法重放。

---

## 5. RPC 桥的传输层事实（重发的边界条件）

- 帧契约：换行 JSONL（非 JSON-RPC）；v1 出帧帽 1MiB，v2 `rpc_chunk` 256KiB/片、重组帽 64MiB，客户端 MUST 校验 chunkId/index/count/byteLength、拒绝交错的序列。`omp://rpc.md` §Transport and Framing/L38/L58-75。
- 关联与并发：客户端 MUST 按 `id` 匹配响应而非发射顺序——bash 等命令并发派发。同上 §Bash L214-219。
- **无 per-request 超时**：协议层无心跳/超时，宿主自行实现 deadline；唯一的 timeout 提及与请求无关。同上 §Startup 注记；`omp-engine-portability.md` §2.5。
- 断连语义：stdin EOF→pending 的 extension/host-tool/host-URI 请求被 **reject**、已接受命令 drain 跑完、pending stdout 投递后正常退出——「断连后已接受的在途命令会跑完；宿主要打断必须显式发 abort」。`omp://rpc.md` §Startup L33；`omp-engine-portability.md` §2.5（rpc-mode.ts:2471-2487）。死点 #8：该「跑完再死」语义在 Workers 无对应信号，DO 侧必须显式定义 abort 策略。`omp-engine-portability.md` §7.8。
- bb 对照：bb 桥自有 30s 请求超时与三类显式错误（timeout/host offline/daemon error，无挂起等待路径）；`thread.stop` interrupt=等 runtime 优雅 settle。bb 研究 §4.1/§4.3。

---

## 6. 我们 dispatch seam 的幂等证据（executionId 机制）

- 铁律（`packages/agent-do/src/agent-do.ts:47-55`）：①journal 先于一切出站副作用；②重放即真相；③唯一恢复动词=同 executionId 重发/重问，去重在 service journal 与 agent DO；④不确定就大声失败——outcome-unknown 是持久终态，恢复机器**从不静默重跑工具**。
- 幂等键：`executionId = ${threadId}:${callSeq}` 由日志派生、永不铸造；驱逐/重放/重发重构出同值；threadId 前缀自路由。`ids.ts:3-9`。`requestId` 只是传输配对 id，**明确不是幂等键**；`tool.dispatch` 事件记 attempt 数。`fsm-events.ts:135-143`。
- 投递保证：dispatch at-least-once 且服务端去重；结果 at-least-once 且 agent 侧去重；ack 只在 `tool.result` 落盘后发。`daemon.ts:11-14`。执行超时由 service DO 到期 kill 兜底（`timeoutMs`，`daemon.ts:24-25`）；kill 是幂等业务取消（§2.4）；结果保留到 ack 才 tombstone，未 ack 的 COMPLETED 可重问。`daemon.ts:56-69`。
- 服务端去重点：COMPLETED/已 ack tombstone 的二次 dispatch 从 journal 应答缓存结果——「the client never spawns twice (I16)」。`service-do.ts:189-193`；测试锚：完成后重发=journal 应答、零二次 spawn（`l1-exec-roundtrip.test.ts:82-83`）、真链单 spawn 帧（`smoke-hookup.test.ts:203-204`）。
- 取消与收尸：无通用 cancel 帧，取消=业务命令 `exec.kill`+模型流中止；SIGTERM→5s→SIGKILL 进程组；未知 executionId=no-op ack（`unified-turn-state.md` §2.4；`constants.ts:71-72`）。kill-list 按 pid+/proc 启动时间核验防 pid 复用（I22，`client/executor.ts:108-128`）；断连不自杀在跑进程（`client/index.ts:15-16`）；租约失效判定树以 service DO 为唯一裁决点（§8.5），孤儿标 `orphan_suspect`（`journal.ts:64`）。
- 输出续传：合并单流+绝对 offset；重挂由 `exec.resume{ackedOffset}` 协商，缓冲被挤出先发 `exec.output_gap`——「缺口永远显式，绝不静默」；重复字节落 `output_dup_dropped`；ack 严格后于落盘且单调（I25/I26）。`unified-turn-state.md` §8.3；`journal.ts:50-51`；`client/buffers.ts:3-8`（1MiB 环、裁剪不超 ackedOffset、forget 前不丢任何字节）；serial 命令队列显式 busy 错误（`client/connection.ts:219-236`）。
- 结果闭环：`exec.exited` 先落 journal→转发→agent DO 落 `tool.result`→ack 回流→tombstone→`exec.forget`；丢失的 forget 由下次 announce 的 ended 重报自愈、零 journal delta（I27）。§8.4；`service-do.ts:278-294`、`:662-673`。
- **边界**：以上保证「同一 executionId 不二次 spawn、输出不静默丢」；bash 命令**本体**的重跑（agent 或恢复逻辑选择重新执行一条已部分生效的命令）不在保护范围内——tool.call 落盘前的驱逐（断点 B）会二次下发同一 executionId，dedup 挡住重复 spawn，但若第一实例已在 client 侧开跑过（进程状态未知），outcome-unknown 语义负责暴露而非掩盖。这正是 #25 白名单要管的层面。

---

## 7. 对 #24/#25 的证据映射（仅陈述，不拍板）

**#24（模型流中断重调政策）**：
1. omp 从不重放已提交的部分流；重发原语=保留历史的 continue，由 replay-veto 把关（§4.2/4.4）。
2. 工具调用重发的 omp 先例是**显式标记制**：只有带 `executed:false` 合成结果的调用可重发（§4.3）——可平移为 dispatch 层的 executed 标记，而不必发明新机制。
3. 首字节后 seal 不重调在 omp（retry 政策+配对不变量）与我们（§4.2、`provider.ts:75-77`）双侧一致，无分歧待裁。
4. 桥/传输层无 per-request 超时、无 SSE 续传（§5）→ 桥的 deadline 与中断标记必须自建；bb 的 30s/24h 两档超时+三类显式错误是现成形状。
5. omp 的 stdin-EOF「已接受命令跑完」与 DO 断连语义错配（死点 #8）：边缘侧不能等 drain，必须显式 abort——bb `thread.stop interrupt`（等优雅 settle）是可对齐先例。

**#25（非幂等命令白名单）**：
1. 白名单的证据基底=§2 矩阵的工具本体级分类：只读/覆盖写安全；bash/task/eval 重发=重复副作用或重复工作；checkpoint/rewind/ask/new_context 各有显式防重入或「可重问」语义。
2. `write` 的三类非幂等目标（SQLite insert/agent 消息/proc stdin）说明「工具安全」随目标形态变化，白名单粒度需到「工具+目标」级（§2.2）。
3. bash 命令本体**无工具级幂等可依**：dispatch 层 executionId 去重只保护「同一执行不二次 spawn」（§6 边界）；白名单只能按命令类构建。
4. 已知旁路：`bash.patterns` deny 不覆盖 eval 内壳（§2.3）——白名单若只挂 bash 一层，eval 路径不受控。
5. artifact 的 50KiB 溢出语义与「非幂等 side-effect 命令输出不可再生」纪律（仓 AGENTS.md §Shell Output Discipline）互为印证：重发安全的前提是首次执行的输出已被保全（§3）。

---

## 附：关键常量

| 常量 | 值 | 出处 |
| --- | --- | --- |
| bash 默认超时 / `timeout:0` / 夹紧 | 300s / 双解除（deadline+看门狗） / `1..3600`×`tools.maxTimeout` | `omp://tools/bash.md` §Inputs |
| bash 看门狗裕量 | `max(1000, timeoutMs)+5000ms` | 同上 L220 |
| bash 自动后台阈值 | 60s，帽 `max(0, timeoutMs-1000)` | 同上 L219 |
| eval 默认超时 | 30s（IdleTimeout，0=无） | `omp://tools/eval.md` §Timeout |
| glob / grep / find / lsp 超时 | 5s 固定 / 30s / 20s / 20s（5–300 夹紧） | 各工具文档 §Limits |
| web_search per-transport | 60s 默认、300s 帽 | `omp://tools/web_search.md` §Timeout |
| ask / wait / task | 0=不超时 / 30min 帽 / `maxRuntimeMs` 默认 0 | 各工具文档 |
| OutputSink spill 阈值 / artifact 帽 | 50KiB / 16MiB（inline 回读 8MiB） | `omp://blob-artifact-architecture.md` L131/L141/L162 |
| task 投递截断 | 500,000 字节 / 5000 行；inline 摘要 5000 字符 | `omp://tools/task.md` §Partial output |
| 重试退避 / 次数 / 封顶 | 500ms×2^(n-1)×jitter(75–100%) / 10 次 / 8s 单次、300s 总 | `omp://non-compaction-retry-policy.md` L85/L110-114 |
| 流看门狗（首事件/空闲） | 300,000ms | `omp://provider-streaming-internals.md` L158 |
| RPC 帧帽 / 分片 / 重组帽 | 1MiB / 256KiB / 64MiB | `omp://rpc.md` §Transport and Framing |
| 原生 shell 取消 TERM/KILL 波 | 2s（Windows 5s） | `omp://natives-rust-task-cancellation.md` L135 |
| 我们 KILL_ESCALATION_MS | 5s（SIGTERM→SIGKILL） | `packages/daemon-service/src/constants.ts:71-72` |
| bb COMMAND_TIMEOUT / LIVE | 30s / 24h | bb 研究 §附 |

> AGENT GENERATED: by zhipu-coding-plan/glm-5.3-flash (research subagent)
