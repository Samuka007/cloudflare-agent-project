# pi 测试生态考古——compaction/session 首批移植（#314）

> 状态：**成档 v1 + 首批落地**（2026-10-05，lane/314）。伞 #310 · 兄弟票 #312（功能对齐矩阵 §L5 即本票依据行）/ #313（DO 压测链，出运行时）/ #309（compact 集成，消费本票内核）。
> 方法：pi 源码直读（浅克隆 `github.com/earendil-works/pi` @ `98d2e1947aa9`，v1.0.3，本地 `/tmp/pi-research`；行号相对该提交）+ 首批场景移植进 `packages/agent-do` vitest。用户教导：抄实现更要抄生态、抄兼容、抄鲁棒性——本档把 pi 的回归资产变成我们的。

## 0. 总量

pi `packages/coding-agent/test/` 共 **206 个 test 文件**；compaction 族 **11 个**（复验矩阵 L5 计数 ✓）；两份重量级 fixture：`fixtures/before-compaction.jsonl` **2,370,492 B**、`fixtures/large-session.jsonl` **974,011 B**。根 `test.sh:39-79` 用 `env -i` 空环境 + 隔离 HOME/TMP 跑全套，**无 API key**（LLM 集成测试 `describe.skipIf(!API_KEY)` 自跳过；Windows 侧 `pi-test.bat/.ps1` 同构）。核心引擎纯函数化程度高：compaction 判定/切点/投影重建全部是无宿主依赖的纯函数（`src/core/compaction/compaction.ts`），这是可移植性的根源。

## 1. 测试资产清单（file:line 锚）

### 1.1 Compaction 族（11 文件）

| 文件                                                         | 形状                                                                                                                                                                                  | 依赖                    | 关键锚                                                                                                                                     |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `test/compaction.test.ts`（655 行）                          | **引擎单元测试正本**：token 计量、usage 锚定、shouldCompact、findCutPoint、buildSessionContext、prepareCompaction、2.3MB/951KB 真实 fixture 集成、LLM 摘要（skipIf）                  | 纯函数 + fs fixture     | 计量 :193-272；触发 :274-295；切点 :297-412（#9740 回归 :377-411）；投影重建 :414-498；prepare :500-565；大 fixture :571-597；LLM :603-655 |
| `test/agent-session-compaction.test.ts`（209 行）            | AgentSession 手动 compact E2E（真实 LLM）：compact() 生效/会话有效/persist 进 session 文件/无 session 模式/事件发射                                                                   | 真实 API key            | :24 skipIf(!API_KEY)；五用例 :84-208                                                                                                       |
| `test/agent-session-auto-compaction-queue.test.ts`（449 行） | **自动压缩队列鲁棒性**：阈值压缩后队列消息恢复、overflow 恢复后不重复压缩、陈旧 usage 不参与判定、error 消息借用最后成功 usage                                                        | mock model + 真 session | :59 恢复；:135 overflow 一次；:190 陈旧 usage；:247/:320/:368 error 消息三分支                                                             |
| `test/compaction-extensions.test.ts`（416 行）               | 钩子语义：before_compact 可取消/可自定义、compact 事件携带条目、扩展抛错回退默认、多扩展按序                                                                                          | 扩展系统（我方无）      | :124/:160/:173/:210/:231/:278/:353/:391                                                                                                    |
| `test/compaction-extensions-example.test.ts`（152 行）       | 示例扩展端到端                                                                                                                                                                        | 同上                    | 全文件                                                                                                                                     |
| `test/compaction-nested-calls.test.ts`（27 行）              | codemode 嵌套调用的文件清单归并（readFiles/modifiedFiles）                                                                                                                            | 纯函数                  | :5-26                                                                                                                                      |
| `test/compaction-serialization.test.ts`（79 行）             | 摘要序列化：tool result 2000 字符截断、user/assistant 不截断                                                                                                                          | 纯函数                  | :5-26/:28-45/:47-78                                                                                                                        |
| `test/compaction-summary-reasoning.test.ts`（301 行）        | 摘要调用形状：thinking 级透传、failure 判定（error/length 拒入库）、拒绝 toolCall 响应、fresh routing session 无缓存、重试 choke point（completeSummarization 共用于 branch summary） | mock completeSimple     | :24-42 model 构造；:70-123 透传/缓存；failure/重试见 :124-301                                                                              |
| `test/settings-manager-compaction.test.ts`（192 行）         | compaction 设置覆盖面（reserve/keepRecent/enabled）                                                                                                                                   | settings                | 全文件                                                                                                                                     |
| `test/trigger-compact-extension.test.ts`（60 行）            | 阈值过线才 auto-compact（95k 否/105k 是/120k 否）                                                                                                                                     | 扩展系统                | :27-59                                                                                                                                     |
| `test/interactive-mode-compaction.test.ts`                   | TUI 渲染：压缩成本渲染、恢复后 working state、abort 路由（#9340）、steer flush                                                                                                        | **宿主 TUI**            | :10-107/:200/:232/:249                                                                                                                     |

引擎源（测试对象）锚：默认设置 `compaction.ts:126-130`（reserve 16384/keepRecent 20000）；计量 `:140-142`（totalTokens 优先、分量和回退）、`:196-224`（usage 锚定 + 尾部估算）、`:298-349`（chars/4，图像 4800）；触发 `:267-270`；切点 `:351-379`（角色资格表）、`:446-501`（倒序预算走查 + #9740 兜底）；摘要 `:507-593`（结构化 prompt/failure 判定）、`:619-639`（重试 choke point）；prepare `:872-936`。投影重建在 `session-manager.ts:439-466`（entry→context 消息）、`:476-512`（最新 compaction 胜出 + firstKeptEntryId 保留区）、`:543-583`（projection/context）。序列化 `utils.ts:94/:100-104/:114-155`。

### 1.2 Session/切换族（摘要）

| 文件族                                                                                                                                                                           | 形状                                                                                                                                          | 锚                                                                  |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `agent-session-branching.test.ts`（156 行）/ `agent-session-tree-navigation.test.ts`（323 行）/ `tree-selector.test.ts`                                                          | /tree /fork /clone 树导航、branch summary 生成                                                                                                | 会话树 = entry id/parentId（`session-manager.ts` buildSessionPath） |
| `session-context-edit.test.ts`（364 行）                                                                                                                                         | context_edit 投影族：编辑遮蔽、最新编辑胜出、**pre-edit usage 失效**（:195-243）、切点与编辑互作（:267-347）、edited 内容上做 prepare（:348） | 我方无 context_edit 条目类型（映射见 §2）                           |
| `session-selector-{search,rename,path-delete}.test.ts` + `session-share/file-invalid/id-readonly/info-modified-timestamp/cwd` + `sdk-session-manager` + `experimental-session-*` | 会话列表/恢复/元信息面（bb 形状对应物在 SPA 侧）                                                                                              | 矩阵 A2/A4/A5 已裁形状源                                            |
| `agent-session-concurrent/retry/runtime-events/stats.test.ts`                                                                                                                    | 并发、重试、runtime 事件、统计面                                                                                                              | #313 压测链相关                                                     |

### 1.3 上下文计量 / Approval 族

- 计量：`compaction.test.ts:193-272`（usage 优先/估算回退/图像 4800——**#308 数据面判据蓝本**）+ `agent-session-stats.test.ts` + `cache-stats.test.ts` + `interactive-mode-compaction.test.ts:10-107`（成本渲染）。
- Approval：pi 刻意不做 per-tool 审批（矩阵 D1 立场一致）；权限面测试只有 `trust-manager.test.ts`（项目信任门）。**无独立 approval 测试族可抄**——我方 exec 档 ceiling + journal 审计的对应断言在 `agent-do/test/host-path-override.test.ts`、`fsm-events` tool.dispatch/result 审计。

## 2. 映射到我们契约（journal/event log/投影语义）

| pi 概念（锚）                                                              | 我方对应物（锚）                                                                                                                                                  | 同构度                                                         |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| SessionEntry append-only JSONL，entry id/parentId 树（session-manager.ts） | DO SQLite 事件日志，`(thread_id, seq)` 主键、seq 连续 1..N（event-log.ts:29-37；I1 不变量 invariants.test.ts:10-16）                                              | 机制同构；载体异构；树→线性序                                  |
| CompactionEntry{summary, firstKeptEntryId, tokensBefore/After}             | 尚无压缩事件类型（#309 落地）；**cut seam 已备**：checkpoint/rewind 状态机 session-tree.ts:26-57 + branchCut 摘要覆盖 relay/wire.ts:197-207                       | 形状差：firstKeptEntryId ↔ checkpointResultSeq（seq 单调边界） |
| buildSessionContext 摘要先 + 保留尾（session-manager.ts:476-583）          | wire 装配 `[branch-summary]` 前缀覆盖（wire.ts:202-207；translate.test.ts:405-418 已验顺序）；activeBranchAfterRewind kept/hidden 划分（session-tree.ts:158-168） | 语义同构（summary-first 已是共同形状）                         |
| findCutPoint「绝不切 tool result 对」（compaction.ts:351-364, :394-406）   | 我方 tool.call/tool.result 经 executionIdFor 配对（ids.ts）；journal 级不变量首批落地（compaction-pi-scenarios.test.ts）                                          | **#309 验收即此断言**（矩阵 B4）                               |
| usage 锚定计量（compaction.ts:140-298）                                    | #308 数据面三选一判据；首批已移植纯函数（estimateContextTokens）                                                                                                  | 直引级                                                         |
| 自动压缩队列/overflow 恢复（auto-compaction-queue.test.ts）                | 我方 turn FSM（turn-state.ts replayEvents；§7 22 不变量）                                                                                                         | #313 出运行时场景；引擎在 #309                                 |
| 序列化 2000 字符截断（utils.ts:94）                                        | 我方 summary-capped 教义（fsm-events.ts:73-79 subagent units「summary-capped, never journal oversize」）                                                          | 教义同源                                                       |

## 3. 适配层设计：三类清单

### 3.1 可直引（协议同构，纯函数零宿主依赖）

| 资产                                                                       | pi 锚                              | 备注                               |
| -------------------------------------------------------------------------- | ---------------------------------- | ---------------------------------- |
| calculateContextTokens / getLastAssistantUsage / estimateContextTokens     | compaction.ts:140-224              | #308 判据蓝本，已移植              |
| shouldCompact + 默认 reserve/keepRecent                                    | compaction.ts:126-130, :267-270    | 已移植                             |
| findCutPoint 全套（资格表/倒序走查/#9740 兜底/元数据尾扫）                 | compaction.ts:351-501              | 已移植（entry 形状）               |
| buildSessionContext（最新 compaction 胜出/firstKept 保留区/summary-first） | session-manager.ts:476-583         | 已移植                             |
| prepareCompaction（split-turn/previousSummary 链）                         | compaction.ts:872-936              | 已移植（去 fileOps）               |
| serializeConversation + truncateForSummary                                 | utils.ts:94-155                    | 已移植                             |
| 大 fixture 集成法（真实会话跑切点/重建）                                   | compaction.test.ts:34-40, :571-597 | 方法可抄；fixture 拷贝随 #309 决定 |

### 3.2 需改写（形状差：pi entry 流 ↔ 我方 (thread,seq) journal）

| 资产                                                  | pi 锚                                                        | 改写方向                                                                                      | 状态                                          |
| ----------------------------------------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------- | --------------------------------------------- |
| 「multiple compactions only latest matters」          | compaction.test.ts:448-469                                   | → 两轮 checkpoint→rewind 后 checkpointRewindState/activeBranchAfterRewind 只认最新对          | **已落地**（compaction-pi-scenarios.test.ts） |
| 「原条目不删、append-only」（docs/sessions.md:40-41） | 同上                                                         | → cut 后 journal 行数只增、seq 连续、首轮 hidden 行仍在                                       | **已落地**（同上）                            |
| 「不切 tool result 对」#9740                          | compaction.test.ts:377-411                                   | → journal 级预算走查：tool.result 永非切点，切点落 tool.call 且配对结果同侧（executionIdFor） | **已落地**（同上）                            |
| estimateProjectedContextTokens 的 context_edit 失效   | compaction.ts:227-262 + session-context-edit.test.ts:195-243 | 我方无 context_edit 类型；随 #309/编辑票设计 journal 形状后移植                               | 未移植                                        |
| fileOps 嵌套调用归并                                  | compaction-nested-calls.test.ts:5-26                         | 依赖 pi 工具名语义（read/write/edit args.path）；我方任务子代理 tool.subagent_event 形状不同  | 未移植                                        |
| settings-manager-compaction                           | settings 覆盖                                                | 我方 env gate 层（config.ts:161-174 omp 姿态），设置面随 #309 flags                           | 未移植                                        |

### 3.3 不可引（依赖宿主/TUI/扩展系统/真实 key）

| 资产                                                               | pi 锚                                      | 障碍                                                  |
| ------------------------------------------------------------------ | ------------------------------------------ | ----------------------------------------------------- |
| interactive-mode-compaction / tree-selector / thinking-selector    | interactive-mode-compaction.test.ts 全文件 | 宿主 TUI（我方形状源=bb SPA，另有验收链）             |
| compaction-extensions(-example) / trigger-compact-extension        | compaction-extensions.test.ts:124-391      | 我方无扩展系统（矩阵 ⚪K2；#75 残差裁 HITL 门）       |
| agent-session-compaction E2E / compaction.test.ts:603-655 LLM 摘要 | skipIf(!API_KEY)                           | 真实 key；我方等价物走 smoke-real-model 通道          |
| branch-summarization 的 UI 侧断言                                  | branch-summarization.test.ts               | 与 TUI 渲染耦合； choke point 语义已在 3.1 prepare 内 |

## 4. 首批移植记录（≥5 场景，全绿）

**交付物**：

- `packages/agent-do/test/pi-port/compaction-kernel.ts` — pi compaction 语义内核 vendored 移植（纯函数，函数级 pi file:line 锚；测试所有，生产禁引；#309 晋升或重写）
- `packages/agent-do/test/compaction-pi-port.test.ts` — **26 个场景**，每个 test 名带 `pi:<pi 测试行号>` 锚：计量 8、触发 2、切点 6（含 #9740 对保持）、投影重建 4、prepare 3（含 previousSummary 链两分支）、序列化 3
- `packages/agent-do/test/compaction-pi-scenarios.test.ts` — **3 个场景**（需改写级，跑在我方 journal 形状 + 真 src 函数上）：最新 cut 胜出、append-only 保持 + seq 连续、tool 对不拆的 journal 预算走查

**证据**：`vitest run test/compaction-pi-port.test.ts test/compaction-pi-scenarios.test.ts` → 2 files / **29 tests passed**；`tsc --noEmit` 绿；eslint/prettier 绿（2026-10-05）。

**对后手**：

- **#309**：切点/重建/触发语义直接消费 kernel（或按其锚回 pi 抄写）；验收必含 `compaction-pi-scenarios.test.ts` 的对保持断言的引擎版；`firstKeptEntryId` 在我方落成 seq 边界（同 checkpointResultSeq 先例）。
- **#313**（DO 压测链）：`agent-session-auto-compaction-queue.test.ts` 五场景（恢复/overflow 一次/陈旧 usage/error 三分支）是压测运行时的现成场景单；fixture before-compaction.jsonl（2.3MB）可作重放大输入。
- **#308**：`estimateContextTokens`（usage 锚定 + 尾部估算 + 图像 4800）即数据面判据蓝本，已在 kernel。
