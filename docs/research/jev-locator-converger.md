# jev 定位器/收敛器：PM 验收辅助原语的设计空间研究（非验收导向）

- 工单：#231（research 阶段）；标签 track:acceptance
- 裁决链（权威性随时间递增，后覆盖前）：
  1. #178 K2 KILL（2026-10-04，判决门限语境，本票的历史输入）
  2. #231 评论 04:55「架构重裁」：jev=分类器，验收判决=预登记代码断言，goal_achieved 降级为回路终止启发式——**仍然有效**（判决剥离这半边未被后续推翻）
  3. #231 评论 05:02:13「能力面修正」：jev 零生成、纯分类器；给出「枚举→逐项分类→装配」示例管线——其**性质判断**有效，作为钦定设计已被下条覆盖
  4. #231 评论 05:02:58「研究框架修正」（本文锚点）：**研究不变量只有一条——jev 闭集输入 / 逐项概率输出 / 零生成**；枚举策略、分类问题形状、装配逻辑均为开放设计空间，研究应探索该空间（含证伪示例管线的可能），而非照单实现
- 检索日期：2026-10-05
- 依据：本仓一手材料（`scripts/accept/jev-loop.ts` L177 内核、`scripts/pm-autopilot.ts` 接送面、PR #198 / #220 / #230 实测记录、#177/#178/#231 票面）、`docs/research/jev-browser-loop.md` §1（TypeSafe 官方文档事实快照，2026-10-04）
- 方法论纪律：凡无出处数字标注 [INFERENCE]；K178 数字一律标注其判决语境（该语境已剥离，数字不可直接搬用，见 §5.2）

---

## 0. 结论先行

1. **jev 在本工具里只剩一个身份：对代码确定性枚举出的候选做闭集概率分类。**判决、回路、验收语义、goal_achieved 终审全部出局。工具 = 一次调用返回「接地清单 + 状态探查收敛视图」，单进单出。
2. **示例管线（枚举→逐项分类→装配）反映的正确特性是：清单由代码枚举、判断是逐项概率、装配归代码。**但照单实现会在三处翻车，本文逐一证伪（§2.2）：
   - 「逐组件分类」若实现为每组件一次请求 → N×RTT 纯浪费；正确形状是同一 state + N 问 + 1 RTT（jev fan-out 近零边际，L177 六问一往返已实证）；
   - 逐项分类若剥掉页面语境（只给 role:name 元数据）→ 接地退化成猜谜；#178 修订已论证满内容态消灭部分可观察接地错误类，定位器必须同样吃满内容 state；
   - 「收敛建议」若理解为 jev 自由文本 → 零生成下不可实现；只能落为逐区域闭集分类 + 代码排序。
3. **实测面足够定位器用途。**满内容态（staging 线程页 1002 tok）下 jev RTT P50 279–304 ms / P95 378 ms；单次调用（至多两段）<1 s，对照基线（#149 手工走查 8 PM 回合）是量级差。输入免费（$42/Btok ⇒ 单调用 ~$0.00004），fan-out 让 N 问不增 RTT。
4. **装配层的真问题不是「调阈值」而是「阈值跨形状不可比」。**choice confidence 公式的均匀基线随选项数 n 移动：逐项固定词汇表（n 恒定）的概率跨页可比，整页接地 choice（n=页面 refs 数）的概率跨页不可比——这直接决定两形状的分工（§2.2、§2.3）。
5. **设计票建议单票**（§6）：落位 `jev-locate.ts`（复用 L177 接送面）+ 枚举召回审计 + 新页逐项分类分布实测（预登记）+ 两消费者输出契约冻结。回路/判决/LLM lane 实现均明确不做。

---

## 1. 唯一不变量与其硬推论

**不变量：jev 闭集输入（state + questions）、逐项概率输出（choice 分布+confidence / score / noul）、零生成。**[来源：#231 评论 05:02:58；TypeSafe primitives/confidence 事实见 docs/research/jev-browser-loop.md §1]

任何候选设计必须过这五条硬推论（全部由不变量 + jev-1.13 已知缺陷直接导出）：

| # | 推论 | 依据 |
| --- | --- | --- |
| R1 | 「清单/建议」不可能由 jev 返回——只能代码枚举候选、jev 逐项打分、代码装配 | 零生成；#231 评论 05:02:13 |
| R2 | 意图匹配必须是闭集问题：criteria 模板代码所有，意图文本作为参数嵌入 criteria；不能问开放式问题（「这页有什么值得看」） | 闭集输入；literal reading（jaggedness #1：含糊措辞按字面答） |
| R3 | 计数、比较、精确文本匹配不能问 jev——组件数量、重复项、一致性全在代码 | jaggedness #2（不会数数/算术） |
| R4 | 任何 choice 形状必须乱序；跨页比较概率的形状必须固定选项数 | jaggedness #8（靠前选项偏置）；confidence 公式基线随 n 移动（§2.3） |
| R5 | 注入面纪律：页面正文只进 state 字段；questions/criteria 代码所有。组件元数据（role:name）天然是页面派生数据，只能以截断形态（L177 NAME_MAX=48）进 options 列表，配合乱序+复验 | L178 K4 实证未击穿（decoy 零点击，两轮一致）；jev-loop.ts:9-13 协议分离 |

**已作废、不得复活的东西**：验收回路（驱动+断言）、goal_achieved 终审、0.85/0.6 判决门限、「重校准门限」方向（调仪器迁就判决=反严谨）、driver-only 验收。GATE 常量（jev-loop.ts:87-95）在定位器语境下只剩历史参考价值。

---

## 2. 工具形态：三层设计空间探索

工具形状一句话：**给定页面 + 意图 → 单次调用返回「可交互组件清单（含语义接地概率）」+「状态探查收敛视图」**。内部三层——枚举（纯代码）、分类（jev）、装配（纯代码）——每层都是开放空间，逐层给候选与判定。

### 2.1 枚举层：交互候选怎么确定性抽出来（零 jev）

| 候选 | 机制 | 优点 | 弱点 | 判定 |
| --- | --- | --- | --- | --- |
| A. SEL 白名单抽取（现状） | CSS 选择器闭集：`a[href],button,input,select,textarea,summary,contenteditable` + ARIA role 白名单（jev-loop.ts:910-914）；可见性过滤 + 视口优先 rank + ref 注册表（gen 号，跨快照失效） | 确定性、便宜、L177/L178 全链实证；JevElementRec 已带 checked/expanded/value/disabled（jev-loop.ts:128-136） | 非标准交互元素召回缺口：`div onClick` 无 role、自定义组件缺 ARIA → 漏 | **主路**（复用，不重写） |
| B. AX 树抽取 | CDP `Accessibility.getFullAXTree`（opencli `browser state` 先例：budget-aware a11y 快照 [来源：jev-browser-loop.md §4]）；Chromium AX 节点带 focusable/clickable 信号 | 吃 computed role，能抓 A 漏掉的隐式交互 | 体积大、需二次确定性过滤、token 上浮 | 召回审计对照组 |
| C. 启发式补扫 | computed style `cursor:pointer` / `onclick` 属性 / `tabindex` | 抓 div-onClick 类 | 噪声大，误报多 | 只作 audit pass，不作主路 |

**开放点（不预设结论）**：A 的召回缺口在本 staging 面到底多大？设计票里用 2–3 个真实页面（线程页、Settings、ask 卡态）做 A vs B/C 对照审计，量「漏了几个真交互元素」，用数据决定是否升级主路。当前所有实测（L177/L178）都建立在 A 上，B/C 无实测数据。

### 2.2 分类层：逐项问什么（唯一受不变量约束的层）

两种候选形状，**不是二选一，按消费者意图分档**（§4）：

**形状 G：整页接地单问**（L177 `target_ref` 形状，已实证）
- 1 个 choice，options=本页全部 refs（乱序，jev-loop.ts:1186 `shuffled`），criteria=「哪个 ref 是〈意图〉」。
- 实证：L177/L178 的步进接地从未成为主要失败类——K2 失败在 goal 门与首写塌陷（判决语境），不在接地错；#149 流（Settings→开关→行断言）重放全程接地正确 [来源：PR #198]。
- 风险：概率跨页不可比（见 R4/§2.3）；顺序偏置必须乱序+双序复验压。

**形状 C：逐项语义分类**（#231 评论 05:02:13 示例的形状，加两条修正）
- 每候选一问，闭集词汇表固定，如 `{stop-button, ask-card, toggle, text-input, select, tab, link, menu-item, not-interactive}`（词汇表=代码常量，同 ACTION_VOCAB 先例 jev-loop.ts:58-68）；可附一问 score「与〈意图〉的相关度档位」。
- **修正 1（证伪点）**：「逐组件」≠「每组件一次请求」。jev 单请求 fan-out——「加问题通常几乎不影响响应时间」（官方 primitives/fan-out [来源：jev-browser-loop.md §1]），L177 六问一往返实测背书 ⇒ N 候选 = 同一 state + N 问 + **1 RTT**。实现成 N 请求是纯浪费，示例管线照字面实现会掉进这个坑。
- **修正 2（证伪点）**：逐项分类不得剥掉页面语境。若 state 只放候选元数据（role:name 几十字），语义接地退化成无上下文猜谜（「这个 switch 是什么开关？」答不了）；#178 修订（满可观察状态）正是为消灭这类部分可观察错误 [来源：#178 评论 16:20:51]。定位器同样吃满内容 state，逐项问题只是把「跨项竞争」换成「逐项独立打分」。
- 残余风险：无跨项竞争 ⇒ 多个组件可能同时拿高「stop-button」概率 ⇒ 装配层需去歧义策略（页内 argmax / 高概率短名单再走一轮形状 G）。

**形状 X：收敛面（状态探查「收敛建议」的唯一可实现形状）**
- 「哪些子树值得看」不能是自由文本（R1）。可实现形状：代码按确定性边界切区域——JevSnapshot 已带 `landmarks / headings / dialogs / alerts`（jev-loop.ts:143-146），区域=landmark 容器 + 标题分节 + 弹层 → jev 每区域两问（noul：「与〈意图〉相关？」noul：「含错误横幅/异常态？」）→ 代码按 p 排序取 top-k，附每区域近似 token 量（代码计数，R3）。
- 区域文本切片目前 snapshot 不做（pageText 是整页字符串）——区域→文本切片是设计票的实现项，不是开放问题。

**注入面注意（R5 落地）**：两形状的 criteria 均为代码模板+意图文本（PM 所有，可信侧）；页面派生信息只出现在 state（正文）与 options（截断 role:name）。L178 K4 在此暴露面上两轮未击穿（decoy 零点击、hijack=false），纪律原样继承。

### 2.3 装配层：概率怎么变成清单（零 jev）

- **阈值语义变化**：没有验收判决后，阈值不再是 gate，是**报告策略**——分档标注（示例：≥0.85 高信 / 0.6–0.85 中信 / <0.6 弃权=「无可信接地」），且永远输出概率原值，消费端自决。数字是占位，等设计票实测分布再定（预登记，非本票产出）。
- **跨形状可比性（本研究的核心新论点）**：choice confidence = $(p_{\max}-1/n)/(1-1/n)$，均匀基线 $1/n$ 随选项数移动 ⇒ **逐项形状（n=词汇表大小，恒定）的概率跨页可比，整页形状（n=本页 refs 数，逐页变）的概率只在本页内有意义**。推论：跨页/跨任务聚合（如 LLM lane 的命中率统计、回归对比）只能建在形状 C 上；形状 G 只做页内相对排序。这也修正了「选项多会压低 confidence」的直觉——公式上 n 增大反而抬高同 p_max 的 confidence 读数，真实风险是概率质量摊到多个似然项后 top-1 险胜仍读出高 confidence，所以整页形状必须配双序复验。
- **双序复验**：同请求内同 criteria 乱序两次（fan-out 成本≈0），top-1 一致才标 `orderStable`。比「重发一整个请求复验」（#177 曾用的 re-ask）便宜且同快照同 gen。
- **代码卫兵**（全部不请模型）：gen 校验（ref 注册表，跨快照失效即拒绝）、可见性复检、去重、计数、短名单构造（若走 C→G 两段）。
- **K178 分布数据的地位**：goal 天花板 0.81–0.82、首写塌陷 0.26–0.49 是**判决门限 + 动作选择语境**的实测 [来源：#178 评论 20:27:30]，判决语义剥离后不再是定位器的失败证据；作为「jev 置信分布对语境敏感」的先验提醒保留，**不**直接搬来定装配档位。新页逐项分类分布无实测——设计票预登记实测项。

### 2.4 开放点清单（设计票要裁的）

1. 枚举主路是否从 A 升级/混入 B/C（等召回审计数据）。
2. 词汇表闭集的具体条目（stop/ask-card/toggle/…）——从 staging 真实组件盘点出发，不是拍脑袋。
3. C 与 G 的分档边界：什么意图走逐项全量分类、什么意图走单目标接地（初判：PM「找 X」→ G，「这页有什么/收敛给 LLM」→ C+X；待两消费者实测反馈）。
4. 装配三档的数字（等新页分布实测，预登记）。
5. 区域切分粒度（landmark 级 vs heading 分节级）与区域 token 计数实现。

---

## 3. 接口形状：一次调用的输入/输出契约

落位：`scripts/accept/jev-locate.ts`，Eval 库形态（同 jev-loop.ts 先例，非生产代码、不动工具注册面）。**接送面复用不重定义**：`resolveJeapiKey / JEV_URL / JEV_MODEL`（pm-autopilot.ts:411-439 单一真理源）、`snapshot()`（jev-loop.ts:1080）、`askJev()`（jev-loop.ts:1140）、`shuffled()`（jev-loop.ts:1186）。无回路承诺：函数单进单出，不做 loop、不做 goal_achieved、不做断言。

```
locate(deps, input) → LocateReport            // 1 次 CDP 快照 + 1–2 次 jev 请求
input {
  http: string            // CDP endpoint，如 http://172.27.0.1:9222
  tab: {name} | {url}     // 既有 owned tab 或新开（复用 openTab）
  intent: string          // PM/ lane 文本，嵌入 code-owned criteria 模板
  mode: "ground" | "inventory" | "converge"   // 形状 G | C(+G 去歧义) | C+X
  maxElements?            // 默认沿 L177 ≤60 纪律
  tokenBudget?            // converge 模式的收敛包预算
}
LocateReport {
  components: [{ ref, role, name, class?, pClass?, pRelevant?, orderStable }]
  regions:    [{ id, path, pRelevant?, pAnomaly?, approxTokens }]
  packet?:    string            // 仅 converge 模式：预算内收敛包
  meta: { gen, url, title, stateTokens, rttMs, stateMode,
          counts: { elements, trimmed, regions }, questions: number }
}
```

- 输出纪律沿 L177：回流 PM 上下文的体积保持微小（~6k token 预算语义，jev-loop.ts:17-18）；报告不携带页面正文（PM 自己有页面），converge 模式的 packet 除外。
- ref 生命周期如实标注：ref 只在本次快照 gen 内有效，跨快照/跨 DOM 变更失效（jev-loop.ts:139-140 语义）。

---

## 4. 两消费者接口（同一报告，两种读法）

### 4.1 PM 手工门（现在时）

- 消费动作：1 个 Eval cell → LocateReport。省两类回合：**找元素**（此前 PM/lane 在页面里肉眼扫/选择器试错——#149 手工基线 8 PM 回合的主要构成）与**扫状态**（满页读正文找「该看哪」）。
- 读法：`components` 按 pRelevant 排序取头部即「要点的那个是哪个 ref」；`regions` 按 pRelevant/pAnomaly 排序即「先看哪块」。ground 模式（形状 G）单问最省，inventory/converge 模式一次 fan-out 全拿。
- 明确不做：PM 门不由 jev 判「页面对不对」——那仍是 PM 看着报告 + 预登记断言的事。

### 4.2 LLM 验收 lane（未来时，只冻结契约不实现）

- 消费动作：`converge(intent, tokenBudget)` → packet = top-k 组件（ref+role+name+概率）+ top-k 区域的渲染文本切片（按区域边界切、预算内确定性截断、代码计数）。
- **协议分离随包携带**：packet 内含不可信页面文本，交付为数据非指令——lane 侧必须把 packet 放进不受信数据槽（K4 实证的 state-only 纪律在消费者端的对应物）。
- 收敛比的诚实预期：staging 线程页满内容实测仅 ~1002 tok，本就很小，收敛增量有限；**长页/多区域页才是收敛器主战场**——设计票应含一个长页样本量收敛比（整页 tok → packet tok），无实测前不承诺比率 [INFERENCE]。
- ref 稳定性契约：lane 若要驱动交互，把 ref 交回同一 kernel 的执行面（jev-loop.ts 执行器），本工具不执行（无回路边界的另一面）。

---

## 5. 成本与能力面

### 5.1 实测数字（全部 staging + jev-1.13.0）

| 指标 | 实测 | 出处 |
| --- | --- | --- |
| jev RTT P50（满内容态） | **279 ms**（n=6：383/271/270/314/302/279） | PR #198（L177 结票记录） |
| jev RTT（#178 引述） | P50 288 ms | #178 评论 20:00:32 |
| jev RTT P50/P95（大样本） | **304 / 378 ms**（n=39，full state） | #178 评论 20:27:30（K1 判 PASS） |
| state 大小（满内容态） | **1002 tokens**（完整渲染文本+语义结构+闭枚举 refs；票面引述「接地 288ms/满内容态」落在此口径带内） | PR #198 |
| fan-out 边际成本 | 6 问 = 1 RTT；「加问题几乎不影响响应时间」 | 官方 fan-out + L177 实测 |
| 单调用成本 | 1002 tok × $42/Btok ≈ **$0.00004**，输出免费 | docs.models.md（jev-browser-loop.md §1） |
| 速率上限 | 100K tok/s + 80 req/s ⇒ 1–6k tok state 下十级并发无压力 [INFERENCE：并发数为除法估算] | docs.models.md Warning（官方注明动态调整，生产化前复查） |
| 基线对照 | #149 手工走查 8 PM 回合 vs jev 环全流程 ~7.1 s / 1 cell | PR #198 |

### 5.2 判定：够不够定位器用途——**够，且余量大**

- 定位器是**单次调用**（至多两段：C 全量分类 + 短名单 G 去歧义 ≈ 2 RTT < 0.9 s），无回路意味着 K1 预算（≤800 ms/步）的压力场景根本不出现；0.3 s 级 RTT 对「PM 省回合」目标（8 回合 → 1 cell）不构成敏感变量。
- K178 的 goal_achieved 失败（天花板 0.81–0.82 < 0.85 门）**与本工具无关**：那是「jev 终审回路终止」判决语义的失败，判决已剥离（#231 评论 04:55 裁定 + 05:02:58 框架确认）。同理 0.26–0.49 首写塌陷是动作选择语境，定位器不做动作。
- **剥离判决后仍真实的能力面残余**（设计票必须处理，清单非结论）：
  1. 整页形状概率跨页不可比（§2.3）→ 聚合统计只建在逐项形状上；
  2. 顺序偏置 → 乱序 + 双序复验必须，不可省；
  3. 计数/比较不能问 jev → 装配层代码做（R3）；
  4. **新页逐项分类分布零实测** → 设计票预登记实测（这是唯一决定装配档位的数字）；
  5. 非标准交互元素召回缺口（§2.1）→ 枚举审计对照；
  6. K4 注入不变式在定位器负载下的复验（去耦探针：伪指令引导接地指向 decoy）应进设计票回归——K4 只在驱动语境测过，定位器语境是同纪律不同问法。

---

## 6. 设计票建议（单票，research 后续）

**标题草案**：`[design] jev-locate 定位器/收敛器——三层定形 + 预登记实测 + 两消费者契约冻结`

| 块 | 内容 | 验收建议 |
| --- | --- | --- |
| 落位 | `scripts/accept/jev-locate.ts`（§3 契约），接送面复用 pm-autopilot/jev-loop，注入测试缝（fetch/page seam 沿 jev-loop.test.ts 先例） | 单元测试走 seam 无线；tsc 干净 |
| 枚举审计 | staging 2–3 页 A vs B/C 召回对照，量化缺口 | 数字入档；主路选型有据 |
| 分布实测（预登记） | 新页逐项分类 + 整页接地的置信分布，n≥30 问 | 冻结判据后跑；装配三档数字从分布推导，非拍脑袋；不调参迁就 |
| 契约冻结 | 两消费者输出形状（§4）+ packet 协议分离注记 + ref 生命周期 | #149 流页面人工核对：Stop/开关/ask 卡接地正确（PM 消费形状自己的门） |
| 明确不做 | 回路、判决、goal_achieved、LLM lane 实现、长页收敛比承诺（只测不承诺） | — |

依赖：无（staging 会话 + JEV key 已在，同 L177/L178 环境）。

---

## 附：证据索引

| 主题 | 来源 |
| --- | --- |
| 唯一不变量 + 开放设计空间裁定 | #231 评论 05:02:58；05:02:13；04:55（https://github.com/Samuka007/cloudflare-agent-project/issues/231） |
| K1–K4 实测（K2 KILL、goal 天花板、首写塌陷、K4 注入） | #178 评论 20:27:30 / 20:33:30 |
| L177 实测（RTT 279ms n=6、state 1002 tok、7.1s/1 cell、8 回合基线） | PR #198 body（https://github.com/Samuka007/cloudflare-agent-project/pull/198） |
| 288ms 引述 | #178 评论 20:00:32 |
| 内核可复用面（snapshot/askJev/shuffled/JevSnapshot/GATE） | `scripts/accept/jev-loop.ts:1080,1140,1186,128-159,87-95` |
| 接送面单一真理源 | `scripts/pm-autopilot.ts:411-439`（resolveJeapiKey/JEV_URL/JEV_MODEL）、`:329`（JudgeAnswer） |
| TypeSafe 官方事实（三原语/fan-out/confidence 公式/价格/限流/jaggedness 全表） | docs/research/jev-browser-loop.md §1（官方文档 2026-10-04 快照，本文不重复展开） |
| 满可观察状态修订论证 | #178 评论 16:20:51 |
| 驱动语境执行器（lane 复用边界） | jev-loop.ts 执行器段；PR #198/#220 |

> AGENT GENERATED: by zhipu-coding-plan/glm-5.3-flash (research subagent)
