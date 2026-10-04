# Context Awareness：水位暴露 × 确定性 Rollover × 强制 Checkpoint —— 事实差距矩阵（#200）

> **Ticket**: Samuka007/cloudflare-agent-project#200（idea→research）。上游锚：#75（compaction grilling 正本）、#79 研究档（`compaction-two-source-map.md`，本仓 main）。
> **Method**: 本仓源码考古 + #79 两源档复用；每条事实携带 `path:line`；未经源码验证的行标 `[INFERENCE]`。预算墙钟 ≤40min（实际 ≈15min 检索+写作）。
> **One-line**: 我们harness 装配上下文＝水位天然可知（`buildModelRequest` 每 call 全量重建），但词表里**零 token 事件**、relay **丢弃 provider usage**——两源先例（omp 内部持有水位、bb 彻底没有）也都没把水位暴露给 agent 本体；三方案的差距全是"从可知到可查可判"的接线工程，不是未知科学。

---

## 0. 问题面（#200 票面）

PM 实践痛点（2026-10-04）：agent 感知不到自身上下文水位 → compaction / new_context 只能被动或误判（无 handoff 自压；压后连环压）。候选三方案：

- **A 水位暴露**：装配时 token 计数入 journal 相位行（类比 `turn.phase`，新增 `context.gauge`），agent 可查。
- **B 确定性 rollover**：阈值触发的 `context_rollover` 成为 journal 一等事件，replay 一致。
- **C 强制 checkpoint**：rollover 强制伴随 checkpoint，不可重入窗口清零才允许。

## 1. 共同事实基座（本仓，全部亲验）

| # | 事实 | 锚 |
| --- | --- | --- |
| F1 | **装配单咽喉**：每次 model call 全量从 journal 重建请求（`readAllEvents` → `modelRequestFromEvents`），投影与 replay 测试共享（src/translate.ts）——水位在这一个函数里天然可算 | agent-do.ts:1586-1593 |
| F2 | **journal 不变量**：`(thread_id, seq)` 主键，seq 同步事务内连续 1..N 无洞无竞态；迁移版本化管理；超大字段 R2 旁路（行存 BlobRef 读时透明解引） | event-log.ts:4-16, 87-127 |
| F3 | **词表零 token 事件**：`agentEventDataSchemas` 全词表无任何 usage/token 字段；`model.call_completed` 只载 text+toolCalls；`model.call_sealed` 只载 prefixChars（字节） | fsm-events.ts:71-478, 116-122, 124-129 |
| F4 | **provider usage 被丢弃**：SSE 循环 default 分支忽略 `message_start`（Anthropic usage 就在这帧）；wire.ts 事件类型无 usage 字段；序列化后 payload 精确字节数已知（`JSON.stringify(body)`） | anthropic-provider.ts:188-191, 72 |
| F5 | **不可重入窗口存在且唯一**：`turnProgram` 循环里"上一轮执行终态已清 → 下一个 `model.call_started` 落盘前"是天然的非重入窗口；T18 预算梯（`budgetVerdict`/`task.budget_notice`）已经在这个窗口检查 | agent-do.ts:1250-1297, 1369-1377; 2711-2715 |
| F6 | **"harness 主动告知 agent"先例已在词表**：`task.budget_notice` / `task.yield_warning` 是 journal 一等行（软预算收尾通知）——gauge 行不是新范式 | fsm-events.ts:412-425 |
| F7 | **D3 相位行先例**：`turn.phase` 五相零 payload 标记行 ≤120B、append 点表、单写者 P1-P3（persist-then-mark / driver-only / replay 纯：fold 不反向决定 journal）、§14.2 收敛 oracle property test——gauge/rollover 行可整套继承 | streaming-contract.md §3, §3.3, §14.2 |
| F8 | **无 context-window 配置**：config 词表只有 call/exec/stream 旋钮（modelCallCapMs、deltaFlushMs…），无窗口/预算 token 位 | config.ts:79-115 |
| F9 | **append-only 无删除路径**：journal 无任何删除动词（对照 bb `deleteThreadEventSuffixInTransaction` 仅消息编辑用）——"原始事件永远留盘"免费获得 | event-log.ts 全文；#79 §Part 4 |

## 2. 两源先例压缩（详证见 #79 档，此处只取三方案相关行）

| 维度 | omp（自有 transcript） | bb（provider 控制面） |
| --- | --- | --- |
| 触发策略 | token 阈值驱动：threshold=window−reserve（默认≈85%）；mid-turn overflow 强制；speculative async 预备；idle 默认关。决策输入 = max(provider usage, 本地估算)，**内部持有，不暴露** | **无自动触发**；manual `/compact` 转发且按 provider 门控 |
| 水位记录 | `CompactionEntry.tokensBefore/tokensAfter` —— 事后 display metadata，**非装配时可查**；`compact_boundary.pre_tokens` 被解析后**落盘即弃** | 无任何 token 真值 |
| checkpoint 形状 | content-bearing：summary + `firstKeptEntryId` + method + preserveData；journal 永不截断，replay = summary 前缀叠加 + kept 尾巴 | content-free 标记 `thread/compacted {threadId, providerThreadId}`；上下文连续性外包给 provider session |
| 已知残差（#79 Part 5） | 摘要保真 prompt 级无校验（gap2）、无 pre-compaction 审批钩（gap3）、summary 链无界（gap5）、无便携 checkpoint 契约（gap1） | provider session 失效即上下文不可重建（gap4） |

**共同差距（本票核心命题，对照 #79 Part 4 证成）**：两家都把水位留在触发器内部或事后展示，**没有任何一条通路让 agent 本体在装配/运行时读到"我还剩多少上下文"**。omp 的 `compactionContextTokens()` 是触发器私有；bb 干脆没有。#200 三方案全部围绕这一条缝隙展开。

---

## 3. 三方案事实 × 差距矩阵

图例：✅=事实已足（有锚）；⚠=真差距（PM spec 需裁定）；→=依赖。

| 维度 | **A 水位暴露**（`context.gauge`） | **B 确定性 rollover**（`context.rollover` 一等事件） | **C 强制 checkpoint**（rollover ⟹ checkpoint） |
| --- | --- | --- | --- |
| 触发/取值输入 | ⚠ **A1 计量单位**：provider usage（input_tokens）与本地估算（omp max() 规则）还是诚实字节数？本地无 tokenizer，字节数是唯一精确值（F4） | ⚠ **B1 触发输入必须 journal 可导**：replay 一致性要求决策输入在重放时可复得——provider usage 不可重算，**入了触发器就必须先入 journal**（→A）；纯本地估算可重算但估计误差进决策 `[INFERENCE]` | ✅ 摘要生成本身是 LLM call——输入=被 rollover 的 journal 前缀（F1/F9 在盘） |
| journal 载体行 | ✅ 词表有先例（F6）、D3 零 payload 标记行模式整套可继承（F7）；⚠ **A2 写点与频率**：每 call 一行（前窗估算行 + call 后 usage 行？）还是每 turn 一行；写序须 persist-then-mark（P1） | ✅ 一等事件 = 词表增补（F2/F7 同构）；⚠ **B2 位置语义**：只许在 F5 非重入窗口（pre-call）触发？mid-turn overflow 与 ruling-A seal（首字节后永不重call，fsm-events.ts:131-138 `afterFirstByte` 语义）冲突，overflow 路径只能 turn.failed(sealed) 后续窗 rollover `[INFERENCE]` | ⚠ **C1 checkpoint schema**：content-bearing（summary+边界 seq+tokensBefore/After+method+provenance）对 bb 反例已是定论（#79 gap4）；边界锚用**连续 seq**（F2）比 omp entry-id 命名空间更便携——#79 gap1 可部分作答 |
| 重放一致性 | ✅ gauge 行是纯记录，参与 fold 不决定 fold（P3 同款）——天然一致 | ⚠ **B3 fold 语义**：rollover 后装配跳过边界前事件（omp `firstKeptEntryId` 同构）；`modelRequestFromEvents` 须习得边界感知，投影与 replay 测试共享（F1）所以可 property-test（§14.2 收敛 oracle 同法） | ⚠ **C2 摘要 call 的 journal 归属**：摘要生成 ride 同 turn（新 modelCallId）还是旁路？不 journal 就 replay 不纯——必须落 journal 或确定性可重导 |
| 原子性/不可重入 | ✅ 单行 append，事务内 seq（F2） | ⚠ **B4 触发窗口原子性**："不可重入窗口清零才允许"= 判定+rollover 行+checkpoint 行须单同步事务成组落盘（event-log 同步事务已具备能力，F2）——否则 crash 在两行之间留半态 | ⚠ **C4 强制耦合的执行序**：checkpoint 先于 rollover 行（摘要失败则不 rollover，omp method cascade 先例 #79 §1.3）还是同事务成组？恢复语义要裁定 |
| agent 侧消费面 | ⚠ **A3 读面**：agent 中途无法 poll RPC；现实消费=下次装配注入自认知行（prompt 可见水位）或 gauge 工具。今日无任何 agent-facing 读面越过 journal `[INFERENCE]` | ✅ rollover 事实经 journal/帧自然到达 SPA 与 agent（D3 §5/§6 投影链现成） | ✅ checkpoint 即 journal 行，replay/导出/跨端（#75 跨设备一致性）免费获得 |
| 阈值/策略输入 | ⚠ **A4 window 从哪来**：config 无窗口位（F8）；百分比阈值需要 per-model window 注册表或 config 旋钮 | ⚠ **B5 阈值策略**：omp 默认 85% 是存在性证明非规范；reserve 数学（#79 §1.2）可搬但须配 window（→A4）；summary 链深界（#79 gap5）宜 day-one 定界 | ⚠ **C3 cut-point 有效性**：omp 规则——永不切在 tool call/result 之间（#79 §2.2）；本仓 journal `tool.call`/`tool.result` 成对（fsm-events.ts:146-179），切点选择须同规则；保留语义（什么进摘要）归 #75 HITL 残差 |
| 依赖 | 无（可先行） | A（B1 硬依赖）+ spec 裁 B2-B5 | B + spec 裁 C1-C4；保留语义挂 #75 |

### 真差距清单（PM spec 票须逐条裁定）

- **A1** 计量单位：provider usage / 本地估算 / 字节数——三档诚实度与成本（relay 解析 `message_start` 是 usage 档前置）。
- **A2** gauge 写点/频率/写序（pre-call 估算行 vs call 后 usage 行，或双行）。
- **A3** agent 消费面：自认知注入 vs 工具 vs 只投 SPA。
- **A4** window 来源（config / per-model 表）。
- **B1** 触发输入的 journal 可导性红线（usage 入触发 ⟹ usage 必入 journal）。
- **B2** rollover 只许非重入窗口；overflow/seal 冲突路径归属。
- **B3** rollover fold 语义与 `modelRequestFromEvents` 边界感知。
- **B4** 判定+rollover+checkpoint 的成组原子性与半态恢复。
- **B5** 阈值策略与 summary 链深界。
- **C1** checkpoint schema（content-bearing；连续 seq 作边界锚）。
- **C2** 摘要 call 的 journal 归属。
- **C3** cut-point 成对规则；保留语义→#75。
- **C4** 耦合执行序与摘要失败级联（omp method cascade 先例）。

---

## 4. PM 切片建议（spec 票 + 实现票）

依赖链 **A → B → C**：B 的确定性以 A 的 journaled 输入为前提（B1）；C 的"强制伴随"在 B 的窗口原子性上才有落点（B4）。先例窗宽参照 streaming-contract.md §16（S1 ≤2h、单文件改造 ≤半窗、整面移植 1 窗）。

| 切片 | 内容 | 依赖 | 验收 | 窗宽 |
| --- | --- | --- | --- | --- |
| **S-spec**（PM，先行） | context-awareness 契约 spec：裁 A1-A4/B1-B5/C1-C4，产 streaming-contract.md 同构契约文档（schema/append 点表/P1-P3/property test 清单） | 本档 | 每条差距有裁定；D3 词表对齐表 | 半窗 |
| **R1**（P0） | usage 管道：relay 解析 `message_start.usage`/`message_delta.usage`；wire.ts 类型；`model.call_completed` 增 usage 字段（additive，旧 journal 宽松解析） | 无 | strict round-trip；旧日志回放不炸；usage 数字与 provider 账单面对照 | ≤半窗 |
| **R2**（P0） | `context.gauge` journal 行 + F5 窗口 append 点 + ux 1:1 直投（`turn/phase` 同法）+ A3 自认知注入选项 | R1（或 A1 裁纯字节数则可并行） | append 点矩阵单测；persist-then-mark；fold 不反向决定 journal（P3） | ≤半窗 |
| **R3**（P1） | rollover 触发器（B2 窗口绑定 + B5 阈值）+ `context.rollover` 一等行 + `modelRequestFromEvents` 边界感知（B3） | S-spec, R2 | §14.2 同法收敛 oracle：随机 journal × rollover 边界 → 装配 ≡ fold 不变性；半态注入不产半 rollover | 1 窗 |
| **R4**（P1） | checkpoint schema（C1）+ 摘要 call journal 归属（C2）+ 成组原子落盘（B4/C4）+ cut-point 成对规则（C3） | S-spec, R3 | 成组性 property test（任意 crash 点重放后无裸 rollover）；切点合法性矩阵单测 | 1 窗 |
| **R5**（P2，条件票） | summary 链深界执行 + 便携 checkpoint 摘要（跨 harness，#79 gap1 完整作答）+ 保真校验 observable（#79 gap2） | R4 落地后观测 | #75 grilling 裁定输入就绪 | 半窗 |

**PM 备注**：R1/R2 与流式契约 S1/S2 落同一文件族（fsm-events/protocol/ux-projection/agent-do），若流式 spec 先过 grilling，建议同窗合并切票避免双改 `agentEventDataSchemas`。保留语义（什么进摘要）不在本档裁定，正本在 #75。
