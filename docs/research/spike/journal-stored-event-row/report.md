# Spike #554: journal→StoredEventRow 物化器 + bb thread-view 直引——timeline 移植层退役可行性（W6）

状态：**可行——判"直引 + 物化器"**（三选一中的第一项），附带一份必须保留/迁移的
cap delta 面（语义等价清单 §4）。原型物化器 + 双路 diff harness 在本目录，可复跑。

- 原型：`materializer.ts`（ux 窗口 → bb `ThreadEventRow`，纯函数 ~460 行）
- 对照：`fixture.ts`（覆盖全部 14 个 ux 事件类型、7 个 item kind 的代表性窗口，
  经 `@cap/protocol buildThreadEvent` 构造，形状与 `ux-projection.ts` 产出一致）
- harness：`harness.ts`（A 路 = 现 `apps/server-worker/src/services/timeline.ts`；
  B 路 = `materializer` → `decodeThreadEventRow` → `buildThreadTimelineFromEvents`）
- diff 证据：`diff-output.json`（逐行对照，两路同输入）
- 复跑：`bun harness.ts`（本机 bun 1.3.14；`node_modules/` 内是工作区符号链接 +
  zod@4，均 gitignored）

---

## 1. 前提核验（Workers 直引面）

- `bb/packages/thread-view` deps = `@bb/domain` + `@bb/server-contract` + `zod` ✓
  （package.json 实读）。
- 三包 src 共 **133 个 TS 文件，`node:`/`bun:` 内建导入 = 0**（本 spike 全量扫描；
  thread-view 57 / domain 59 / server-contract 17）。
- `@bb/db`（drizzle + better-sqlite3）**不在** thread-view 依赖里；投影输入是
  `ThreadEventRow`（domain 纯类型 + zod 校验，`stored-thread-event.ts`），物化器
  在内存产出行即可，无需任何 SQLite 面。
- 用户质询链的判决修正成立：`buildThreadTimelineFromEvents` 是**同步纯函数**（输入
  已物化的行窗口，CPU-only），不触碰 JS 同步等待死锁问题；异步只发生在 DO 存储读
  （与现状相同）。

## 2. 覆盖度表：ux 事件 × bb StoredEventRow（问题一）

ux 面 = `@cap/protocol` 14 个类型；bb 面 = `@bb/domain` provider(31)+system(12)。
逐类型（"全"= 字段直映或超集收敛；"部分"= 需合成/卸载；"缺"= bb 无槽位）：

| ux 类型 | bb 映射 | 覆盖 | 说明 |
|---|---|---|---|
| `client/thread/start` | 同名 | —（无 producer） | ux 投影从不产出（`ux-projection.ts` case 缺席）；raw `thread.created` 才是源 |
| `client/turn/requested` | 同名 | 部分（合成） | ux 面无此事件；物化器从 `item/started{userMessage}` 合成对（见 §3.1） |
| `turn/started` | 同名 | 全 | turnId→scope；合成 providerThreadId |
| `turn/phase` | **缺** | 缺→跳过 | bb 无此类型；现 `timeline.ts` 同样忽略（default 分支）→ 零行差 |
| `turn/completed` | 同名 | 全 | `error{category,message}`→`error{message}`（category 丢弃）；providerThreadId→null |
| `item/started` | 同名 | 全/部分 | 分 kind 见下 |
| `item/agentMessage/delta` | 同名 | 全 | turnId→scope |
| `item/reasoning/textDelta` | 同名 | 全 | 同上 |
| `item/completed` | 同名 | 全/部分 | 分 kind 见下 |
| `item/backgroundTask/progress` | 同名 | 全 | thread scope 双方一致 |
| `item/backgroundTask/completed` | 同名 | 全 | 同上 |
| `thread/contextWindowUsage/updated` | 同名 | 全 | ux 双成员非空 → bb nullable 超集 |
| `thread/compacted` | 同名 | 部分 | bb 同名事件**无 payload**；`hideThroughSeq/tokensBefore/tokensAfter/method` 无 bb 槽位（投影本就不消费，#309 语义在 journal 侧）；同 seq 的 estimated usage 行 1:1 |
| `system/error` | 同名 | 全 | message 直映；`category` 无 bb 槽位（bb schema 非严格，解析即剥） |

item kind 明细：

| ux item | item/started | item/completed | 备注 |
|---|---|---|---|
| userMessage | →合成 `client/turn/requested`+`item行不产` | —（无 producer） | bb 用户行只从 request 路径渲染；bb `userMessage` item 无任何 handler |
| agentMessage | 丢弃 | 直映 | bb `isIgnoredItemStartEvent` 忽略 start；行由 delta 聚合 |
| reasoning | **保留** | 直映 | bb Thought 生命周期从 `item/started{reasoning}` 开启（`assistant-event-projection.ts:75-79`）；丢弃会丢行（harness 实证） |
| toolCall | 直映 | 部分：`output`→`result`；`errorCode` 丢弃（bb 无 code 槽位，现 ux 行也未渲染） | |
| imageView | 直映* | 直映* | *归因只保留 delegation 父（§4-D5） |
| backgroundTask | —（无 producer） | —（走 thread-scoped family） | ux 投影只产 `item/backgroundTask/progress|completed` |
| commandExecution | 部分 | 部分 | 形状重塑：`cwd:string`（ux 可 null→""）、`output`→`aggregatedOutput`、`exitCode:number|undefined`（ux 可 null）、`approvalStatus:null` 必填补齐；**当前 ux 投影无 producer**（tool.call 只产 toolCall） |

缺口事件处置（问题一后半）：`turn/phase` 跳过（与现状同）；`client/thread/start`
永不出现；其余无缺口。**无需降级 system 行。**

## 3. 物化器设计要点（原型已验证）

1. **用户行来自 request 对**：`item/started{userMessage}` → 合成
   `client/turn/requested`（thread scope）+ `turn/input/accepted`（turn scope）。
   requestId 合成 `creq_`+seq 的 base-31 编码（满足 bb `clientTurnRequestIdSchema`
   正则）；`execution` 合成静态四元组（bb required，投影不消费）；steer 用
   `target:{kind:"steer",expectedTurnId}` → bb 行 `turnRequest:{kind:"steer"}` ✓。
   **顺序约束**：bb turn 分组要求 `turn/started` 先于 `turn/input/accepted`
   （`group-event-projection-turns.ts:289` 直接 throw），而 ux journal 把
   turn.input 写在首个 model.call_started 之前——物化器把新 turn 的 acceptance
   延迟挂到 `turn/started` 同 seq（stable sort 保持次序；用户行自身 bounds 仍取
   request 原 seq）。
2. **providerThreadId 合成**（`"ux-journal"`）：bb provider 事件全部 required；
   投影只在 provider-unhandled/provider 展示名读它，ux 面产不出该行家族，无害。
   `turn/completed` 存 null（bb 可空）。
3. **id 去重**：ux extraUx 对（reasoning 终端/estimated usage/imageView 对）共享
   journal id+seq；物化行 id 加 `#seq` 后缀（meta.id 非承载字段）。
4. **委托归因门**：预扫描全窗收集 spawnAgent 行 id 集合；imageView 的
   `parentToolCallId` 仅当父是 delegation 才透传（§4-D5 的丢行陷阱，harness 实证
   修复）。
5. **Sync/AI 面**：`materializeUxWindowToStoredEventRows` 纯同步 O(N) 单趟 +
   O(N) 预扫；零异步、零内建。

## 4. diff 报告：thread-view 输出 vs 现 timeline.ts 输出（问题二）

fixture（34 ux 信封）→ A=11 行 / B=10 行。逐族对照：

**语义等价（family+text+status+seq 区间全同）**：user×2（steer 语义保留、
attachments 计数一致）、assistant×2（文本、seq 区间一致）、tool×2（输出、
completedAt 一致）、delegation（subagentType/description/output/childRows=2 全同）、
compaction op 行（title/status/completedAt 全同）、error 行（title=消息、status
"error" 同）、`contextWindowUsage` tail 态（值全同）、`activeThinking` 双 null
（idle 门）一致。

**结构差（cap delta 面）**——保留/迁移清单：

- **D1 行 id 命名空间**：`{thr}:user-seed:{seq}` / `{thr}:tool:{callId}` /
  `{thr}:op:compaction:{turnId}` … vs ux 的裸 item id / `assistant:`/`syserr:`/
  `compact:` 前缀。SPA 展开态/锚点一次性重置；分页 cursor 自洽（anchor 校验
  id+seq 成对）。**无行为损失，属一次性迁移噪音。**
- **D2 行序（thread-scoped error）**：bb 把 turn 外的 system/error 渲染在所属
  turn 之后（turn 窗口序列连续原则）；ux 按 seq 插在 turn 中间。bb 语义更正确，
  接受。
- **D3 tool 行增强**：bb 恢复 `activityIntents`（read/list_files 结构化意图）与
  `toolArgs` 恒填；ux M0 恒 `[]`。超集，接受。
- **D4 Thought 行（#303）为 cap 扩展**：**现 pin（423ae3da1）的 thread-view 不
  物化 "Thought for Ns" op 行**——reasoning 只喂 live `activeThinking`
  （`reasoning-lifecycle-projection.ts` 全文 212 行无行创建；#3250 移植提交
  e04a0f149 只改了 SPA/timeline-view 消费侧）。ux timeline 的 materializeReasoningRow
  是本栈自有扩展。**处置：物化器侧保留（合成 reasoning op 行）或升级 pin 后跟进
  上游实现。这是三处需要"cap 侧代码继续存在"之一。**
- **D5 父行抑制陷阱**：bb `normalize-event-projection.isRootSuppressedContext`
  把带 `parentToolCallId` 且父非 delegation 的行**从根删除**（不是回退到顶层）。
  ux B1 imageView 归因指向 producing toolCall → B 路直接丢行（harness 实证）；
  物化器已修（归因门限 delegation 父）。同机制适用于**批量 spawn 的 `#i` 后缀锚**：
  ux `delegationTargetFor` 有前缀回退，bb 精确匹配——物化器需同法重写批量子行的
  parentToolCallId（roadmap 项，机制与 imageView 门相同）。
- **D6 steer 行 seq 位移**：B 用户行（steer）sourceSeq 取 acceptance 行 seq
  （=turn/started seq）而非请求 seq（±1）。显示顺序不变，接受。
- **D7 provider-unhandled debug 行**：ux 有（raw−ux 集合差，Debug 开关）；bb 无
  ux 等价词汇。**处置：cap 侧保留**（或后续把差集投影为 bb `provider/unhandled`
  行，恢复单引擎）。
- **D8 turn 汇总行**：本 fixture 未触发 `kind:"turn"` 包裹（bb 按内容分组）；
  上线后 SPA 将收到 turn 行（契约双方均含 `TimelineTurnRow`，pinned SPA 即 bb SPA
  谱系）——按 bb 行为接受。

## 5. 物化成本与 128MB 核算（问题二后半）

**现基线**（`routes/threads.ts:902`）：每请求 `getEvents({sinceSeq:0, project:"ux"})`
→ DO SQL 读全 journal（默认上限 **10,000 行**）→ 每行 JSON.parse + R2 blob 解析 +
`parseAgentEvent` zod 校验 → `projectToUxEvents` O(N) 折叠（产出行同样每行 zod 校验
`parseThreadEvent`，`ux-projection.ts:894`）→ `projectTimelineRows` O(N)。

**物化器增量**：ux 窗口 → ThreadEventRow（一次浅映射 + 预扫）→
`decodeThreadEventRow` 每行一次 `threadEventSchema.parse`。即每事件**两次** zod
校验（ux 一次 + bb 一次）vs 今天一次；CPU 约 +1 次 parse/事件，同数量级。

**内存**（128MB isolate 上界）：体积驱动是 journal 行字符串与逐层派生对象。
量级模型：10k 事件 × 平均 ~1KB（delta 行 ~200-400B；tool.result 内联输出可到
R2 bypass 阈值前的大字符串）≈ 原始 JSON ~10MB；管线内同时存活的派生层
（parsed raw → ux envelope → materialized row → bb parsed event → messages）
按 4-6× 计 ≈ **峰值 40-60MB**——能装进 128MB 但余量不奢侈，大输出线程是尾部风险。
缓解与 bb 对齐的现成杠杆：
- bb 同名机制 `maxInlineOutputChars`（读时截断，`truncatedEventDataColumn`）与
  字节预算窗（`findStoredTimelineWindowByteBudgetFloor`）：在 DO SQL 读层做
  `substr(data)` 等价截断即可，物化器与投影无感。
- **窗口定界**（照搬 `timeline.ts:21-67` 分页/缓存语义——`buildTimelinePage` +
  `TimelineLatestRowsCache` 已是 bb 分页语义的移植，保留不动）：投影输入从
  "全 journal" 收窄为"窗口内 ux 行"，`sinceSeq` 游标已有。
- delta 体量治理：bb 有 `pruneResolvedItemDeltas`（completion 后删 delta 行）；
  ux journal 因重放语义保留全部 delta——窗口读 + 仅最新页需 delta 全量，旧页读
  completion 聚合，即可对齐 bb 的读放大而不动 journal。
- LRU 缓存（`timelineLatestRowsCache`，64 entries）语义不变；行对象比 ux 更小
  （无逐 delta 信封滞留）。

## 6. 结论与路线图

**结论：直引 + 物化器可行。** 现役 1153 行 `apps/server-worker/src/services/
timeline.ts` 的投影职责（projectTimelineRows/buildActiveThinking/
buildContextWindowUsage）可由 `materializer + @bb/thread-view` 替换；分页/缓存/
outline 层（buildTimelinePage/TimelineLatestRowsCache/buildConversationOutline）
保留。#543/#530 类投影修复回归 bb 上游一处修两处用的前提成立（前提：pin 含对应
上游修复；D4 表明现 pin 落后于 ux 已移植的部分上游能力，**升级 pin 是路线图第一步**）。

迁移路线（每步独立可验）：
1. **升级 bb pin** 至含上游 #3250 行创建侧（消除 D4）。
2. **落物化器**于 `packages/agent-do`（或 server-worker 服务层），输入 ux 视图；
   上线路线图项：改从 **raw journal** 物化（消除 id 前缀嗅探与 requestId 合成，
   `turn.input.inputId` 直接映射，client/turn/requested 免合成）。
3. **cap delta 面收编**：Thought 行合成（D4）、provider-unhandled 差集行（D7）、
   批量锚重写（D5 同法）——三处保留为物化器后处理，其余 delta 全部接受。
4. **读放大对齐**：DO SQL 层加 inline-output 截断 + 窗口预算（bb 同名语义）。
5. 退役 `timeline.ts` 投影函数（契约文件 `contract/thread-timeline.ts` 保留，
   与 `@bb/server-contract` 本就逐字同源，diff 见 spike 过程记录）。

## 7. 验证记录

- `bun harness.ts` 通过：34 ux 信封 → 35 物化行 → B 路 10 行，与 A 路 11 行逐族
  对照（`diff-output.json`）；A−B = Thought 行（D4，cap 扩展），B−A = 无。
- 中途实证并修复的两个丢行陷阱已固化在物化器 + 注释：reasoning start 丢弃
  （§2 item 表）、imageView 非 delegation 归因（§4-D5）。
- 纯度扫描：133 文件 0 内建导入（§1）。
