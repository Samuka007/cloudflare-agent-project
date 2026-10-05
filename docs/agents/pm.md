# 项目管理操作手册（PM manual）

PM 的工作是一个循环：**立项 → 派单 → 交付处理 → 验收关账**。每步有完成判据；判据未满足，步就没走完。
机械操作见 [issue-tracker.md](issue-tracker.md)；工程纪律的定义（复用三问／DoR／spike 风险退役／参考类预测／倒查义务）见 [AGENTS.md](../../AGENTS.md) Engineering Doctrine——本手册只写 PM 操作面，不重述定义。

## 1. PM 循环

### 立项

- **症状复现即立项**：根因发掘是票的内容。PM 调查写到"够写一张好票"为止——复现步骤、表面证据、已知/未知清单；票面假设标注"线索非结论"（反例 #52：票面假设被 lane 证伪）。先解决一半再立项 = 带宽错配 + 假设灌输 + 看板滞后。
- **票面必标 block**（`block:bb-ux`／`block:agent-content`／`block:agent-harness`，定义与仓对应见 [decomposition.md](../design/decomposition.md)）：跨块票全标；资源所有权断言按块内仓对应文件集做。切片票挂所属伞票 sub-issue（如 M1.5 全票挂 #33）。
- **HITL 三问**：bb 有形状？omp 有语义？平台缝有证据？任一为是 → 先立 research 票榨干真理源；grilling 只裁残余 delta（经验 <1/3）。每张 HITL 票附一句"为什么必须是你裁"；写不出 → grill agent 代言正反 + 推荐，用户只批注（反例 #73/#74/#75 出生即 HITL）。

### 派单

**PM 每拍先 audit 再派发（#181）**：`const rep = AP.audit(snapshot, { activeLanes })` → `AP.apply(rep.mutations, { confirm: true })` 一键消漂移，复拍读 `clean` 才继续派发。规则：①issue CLOSED 但 Status∉{Done,Canceled}（收敛写=补落 sync 漏写，wontfix→Canceled 其余→Done）②Status=In Progress 但 CLOSED（lane 死亡未收口）③活跃 lane 票 Status≠In Progress（lane(confirm) 翻转丢失→补翻）④dispatchable Todo 超 N 天未派（frontier 老化提醒，无 mutation，动作是派发）⑤浏览器租约（#240，传 `leases: AP.ledger().events` 才武装）：涉浏览器 lane 无租约登记／租约碰撞（同 tab／同线程前缀并发）／交付后未释放，均无 mutation（动作是 AP.lease/AP.release）。正本 `plugins/pm-harness/src/core.ts`（#270 起，原 scripts/pm-autopilot.ts）；omp 会话内同款操作 = `pm_audit`/`pm_apply`/`pm_ledger`/`pm_release` 工具（#270 插件，eval 内 `await tool.pm_audit({ activeLanes })` 直呼）。

票面三项齐才派（DoR 票门，#224 裁减为三项；工程纪律全定义仍见 AGENTS.md）：①复用三问字面答案（手写票含三问否定论证）②验收产品面可观察 ③bb/omp 上游锚点。预算行与参照往例不再是票门：预算仅作派单 packet 信息行（见下），往例估算（参考类预测）是人类纪律（AGENTS.md），均不进票门。

派单上下文必含：

- **worktree + spawn 经 AP.lane（派发钩子，#171；#199 校准为纯 spawn 脚手架）**：派发 = `AP.lane(number | ticket, agentSpec)`（`plugins/pm-harness/src/core.ts`；传数字时自查 snapshot，票不在板上才抛）——唯一硬拒 = board 谓词（open ∧ Todo ∧ 无未关 blocking 边 ∧ ¬rfh）；DoR 三项表（①三问引用②验收面③上游锚点，#224）降为 **advisory**：表照打、缺项不拒派（假的严谨约束等于真的破坏推进），缺真锚点由 PM 派单前自行拦 → 确认后自动预建 worktree（`git worktree add ~/.herdr/worktrees/<repo>/<branch-as-dash> -b lane/<ticket>-<slug> origin/main`，dry-run 默认零写）→ 产出 `isolated: true` 的 task spawn 包（worktree 命令生成复用 `AP.dispatchPackets`）。lane cd 入内即工作，全程在该树；**主仓 checkout 归 PM 独占**（劫持事故条款：lane 入主仓或自建树 = 违规）。关账后 PM 回收 worktree（`git worktree remove <path>`）；盘点 `git worktree list` / `herdr worktree list`。**PM 会话启动两条路（#270）**：①插件的五工具（pm_lane/pm_apply/pm_audit/pm_release/pm_ledger）——装插件后零 import，模型直呼或 eval 内 `await tool.pm_lane(310, {}, { confirm: true })`；spawn 传输梯 = registerSpawn 覆盖槽 → eval 内核 `globalThis.agent`（#200 配方）→ 分离式 `omp -p --cwd <worktree>` 兜底（回执=pid+`.pm-lane.log`；`PM_LANE_NO_DETACH=1` 还原 transport-missing）；②全量 AP API（intake/cascade/file）仍 `%load scripts/pm-harness.ts`（#206 装载体，cache-bust 动态 import→globalThis.AP）。批量 `AP.lane([a, b])` / `pm_lane` 传数组同款。
- **效率预算行**：预期墙钟／资源上限／等待方式（交付即回 or 脚本化监控）；超 50% 须解释。
- **资源所有权账本**：owned files/dirs + worktree 路径 + owned 外部资源（staging 部署、secret、面板）。PM 派单前做**不相交断言**——两 lane 地盘相交 = 派单错误。
- **浏览器租约（#240）**：票面提及浏览器／CDP／Chrome 的派单由 `AP.lane` 自动登记租约——具名 tab `l<票号>`＋专属线程前缀 `l<票号>-`＋释放义务——并随 spawn 上下文携带；手工派发同款必填。台账 `AP.lease`／`AP.release`／`AP.ledger`（仓内 `.pm-leases.jsonl`，gitignored）。
- **分支纪律**：lane 只推 `lane/<ticket>-<slug>`，PR 由 PM 审后 merge。**main 分支保护=一切经 PR（2026-10-04 起，repo rule 强制）**——PM 文档/热修同样走短命分支 PR；对 main 的 push 非 ff 拒绝=硬停，先 `git status --branch` 看分叉方向，force 类操作仅限事故回滚本身且须 --force-with-lease 钉基线。
- **POMDP 条款**：根因未证实不动码；60 分钟未定位根因 → 报告而非猜改。
- **验收 checklist**；lane 报告必带：commit hash、CI run、测试计数、file:line 根因（修 bug 票）。

派发同时把该票 board Status 置 **In Progress**——#206 起 lane(confirm) 自动承担（管道拥有状态生命周期，不靠 PM 记性）：spawn 成功后经 AP.apply 守卫写翻转（带核验，竞态下 no-op 不重写）；dry-run/拒派/spawn 失败不翻（板面反映现实），statusFlipped/statusError 落报告。

**派发谓词与自动清空（用户裁决 2026-10-04）**：dispatchable = open ∧ 无未关 blocking 边 ∧ Status=Todo ∧ ¬ready-for-human（**派生谓词，不是标签**——`ready-for-agent` 已废）。PM 每回合把 dispatchable 集清到并发预算满或空；Todo 非空且预算有余而未派 = PMGuard P1。**并发预算=文件不相交度驱动（硬上限 32，provider 无实测并发约束前不做低于此的手设墙）**：不相交包（bb-ux/agent-do/daemon-service/infra）并行；同包共享文件（registry 尾、wire-order 断言）单 lane 批量承载，防 rebase 轮数吃掉并行收益。Backlog=未排期（PM 调度），blocker 关闭的交付钩子里回调其 Backlog→Todo。语义正本见 [tracker-schema.md](tracker-schema.md)。

### 交付处理（交付钩子——同回合四步，判据在每步末尾）

1. **亲验 → 验收 lane（#277 关账门）**：diff 对照 bb/omp 锚点抽查；lane 的指控类结论先在源头核实再立案。**代码面票（type:implementation/type:bug）merge 前必派验收 lane**（模板 [acceptance-lane.md](acceptance-lane.md)）：staging 面由验收 lane 真机勾票面验收框（证据三件套回填），纯代码面由 CI 勾（绿 run 即证据）——关账缺验收步骤 = REFUSE。判据：关键主张逐条有"属实"判定 + 验收证据已 `AP.closeout` 入账。
2. **集成**：PR merge → **核对 origin/main 实际移动**（"Everything up-to-date" 输出不可作准）→ 回收 lane worktree。判据：origin/main HEAD = 预期 commit。
   **级联前三问审计（用户裁决 2026-10-04，解锁枚举的闸门）**：
   ①**落盘**——交付物的操作知识已入档（票面/docs/notebook；notebook 每波次必刷；发现 doc 漂移同回合修）；
   ②**验收充分性（防 reward hacking）**——CI 绿≠验收：载荷测试 hunk 必亲读（抽查断言密度：关键主张有对应断言，空断言/删测过门=违规）；产品面可观察则**行为级验证**，不可验则票面记明验证边界；**auto-merge 只允许用于已亲读 hunk 的 PR**；
   ③**变动调节**——交付若改写口径（如闸控改变 essential 可见面），同回合调 ROADMAP/票面/下游边；**60% 节点不挂已关票**——另立 finalize 票或改边，半成品显式化。
3. **解锁枚举**：列出此交付新解锁的一切；过 DoR 闸者本回合派出，gated 者注记等待条件。判据：枚举非空，或写明唯一等待条件——"转录结论+更新索引"不算推进（spawn→wait→转录→停 = PMGuard P1 违规）。
4. **汇报**：只陈述已执行事实，收尾"在跑 N 项；待决见 board"。待决项在聊天里枚举 = 违规（二次账本必漂移）。

**宣布即做**：回报文本只含已执行动作；"我即刻／下一步将派 X"写入报告 = 违规本身。确定性预裁按推荐即决并标 overridable（关账评论留翻转指引）；真口味项才挂 `ready-for-human`（决策评论含预裁与批准方式）——用户队列 = board 按 `ready-for-human`／Status `Wait for user` 过滤。

**内容/机制分离（用户裁决 2026-10-04）**：PM 可亲为文档**内容**起草（章程类 pm.md/tracker-schema）；分支**机制**（checkout -b/commit/push/PR 流转）永不主 checkout 亲为——派发 lane 或 herdr worktree 承载。实例：2026-10-04 PM 亲开 4 分支。

**派发契约（用户裁决 2026-10-04）**：subagent 派发必须自带隔离地盘——AP/lane 预建 worktree 或 task spawn `isolated:true`；裸 spawn 共享主 repo = 移动主 HEAD。实例：R1Units 曾把主 checkout 停在 research/deployable-units，其"恢复"到死分支 docs/handoff-wayfinder 又犯一次——**subagent 完成后主 checkout 也不许碰**，主 checkout 只停 main。

### 验收关账

1. 干净树复跑关键测试/命令。
2. 七反模式过一遍：慢通道／重做／串行化／闲置占用／无账保守／轮询／retry-and-hope。
3. 关票评论附证据（测试数、部署 URL、run 链接、file:line）；**无证据不关票**。**关账序列（#277 固化）**：实现 lane 交付 → 验收 lane 出证据（staging 面）或 CI 出证据（纯代码面）→ `AP.closeout` 入账（证据三件套：证据/日期/部署版本）→ 才可 merge/close；PM 抽验不再作为关账输入——降为 wave 终检抽样（第 8 条）。漏网兜底：`AP.audit` 规则 7 `closeoutNoEvidence`（已关无账 = `AP.closeout` 回填——#266 为首例回填——或重开票）。
4. 验收判据 = 用户打开能看到什么（反例 #53：字段全部"就位"但 Priority 列五个视图全不可见，验收却已通过）。
5. staging 验证经 `scripts/deploy-staging.sh` 两条调用面（#175）：merge→main 由 GHA `deploy-staging` workflow 自动部署；任意 commit 手动经 `nix run .#staging-deploy`。
6. **CDP 三层纪律（用户裁决 2026-10-05，#240 audit 规则 6）**：①每 lane 具名 tab（`l<票号>-<用途>`），禁默认 tab 与他人 tab；②**staging thread=抢占资源**（一 thread 一在飞 turn）——交互测试一律新建专属线程（前缀 `l<票号>-`），禁用共享线程（`thr_jk45qe4786`=PM 保留），只读观察可访现有线程但零发送；③用毕关闭——交付关账前 `AP.release("browser", { lane })` 释放租约。涉浏览器 lane 无租约登记／租约碰撞／交付后未释放 = `AP.audit` 规则 6 漂移清单。
7. **空框不可关票（#239，用户裁决 2026-10-02；#277 起勾选权归验收 lane）**：bb-ux 面票 `staging 真机／手验` 验收框为空 = **不可关票**——验证空转（框开着但没验到行为）视同未验收；"移交后续走查"不再是合法关票态。脊柱落地后（#243/#277）：关票前**验收 lane** 真机过 staging，结果（证据+日期+部署版本）回填原票勾框与评论并入 `AP.closeout` 台账；PM 不再逐张亲操（wave 终检抽样，第 8 条）；脊柱前欠账票逐张回扫回填清偿后才算验收闭环。

8. **wave 终检（#246，用户裁定 2026-10-05）**：PM 唯一亲操的 staging 面 = 每 wave 收官／阶段交付一次的整体 E2E 终检（固定清单见下节）；单票级 staging 手验由验收 lane 与第 7 条人工门承载，PM 不逐票亲操（#243 架构）。终检报告未落伞票 = 伞票 Wave 完成判据不得打勾。

### wave 终检清单（#246 固定模板——每 wave 实例化进当轮走查报告）

**时机**：wave 收官（伞票 Wave 完成判据打勾前）与阶段交付（milestone tag 切换前，见 §4）各一轮；一轮过全清单，不与单票验收混流。

**清单（三段固定；每行按 #239 范式取证——真机过 + 证据/日期/部署版本三件套，空框=未走查）**：

| #   | 段             | 走查项                     | 判据（staging 真机）                                                                                                     |
| --- | -------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| A1  | 六表现（#186） | 工具正常用                 | essential 工具真跑一轮：宿主类与 edge 类各至少一条执行落 journal                                                         |
| A2  | 六表现         | 界面/调用正常渲染          | 消息/工具调用/结果投影无渲染缺陷（#148/#161 族回归）                                                                     |
| A3  | 六表现         | 事件正常返回               | fold 透明：turn 结束后事件投影与操作一一对应                                                                             |
| A4  | 六表现         | 流式传输正常流动           | token 增量实时呈现，无整段跳变/滞留（m-stream 线）                                                                       |
| A5  | 六表现         | Host disconnected 不再持续 | 在线宿主无滞留横幅；离线走执行悬置占位（相位诚实）                                                                       |
| A6  | 六表现         | bb host 概念端点映射       | /hosts 列表/详情/AddMachine 状态实时翻面（#193/#194 族）                                                                 |
| B   | 签收动线       | 全动线无断点               | 新建线程→发消息→流式→工具调用→ask/Stop→宿主状态→reload 端到端走通；动线上本 wave 涉及的已关面票为固定点位，逐点回填原票  |
| C   | 回放一致性抽验 | reload/重进后一致          | 抽 ≥2 个本 wave 触达的工具面：reload/重进线程后 transcript 与操作时一致、零重复执行/重复条目；不一致即立项（线索非结论） |

**固定点位与范式（#239 七项=子集范式）**：七项（ask 弹窗／Stop／task content／流式+Working／AddMachine 翻面／横幅三态／debug 回归）既是 B 段动线上的固定点位，也是全清单逐行取证回填原票的范式——证据+日期+部署版本三件套齐才算走查完成。

**产物**：走查报告以评论挂本 wave 伞票（W1=#186 先例）——每行结论+证据+日期+部署版本（`SERVER_VERSION` 经 `/api/v1/system/version` 可查）；伞票 Wave 完成判据打勾必须引用该报告。报告内发现的缺陷走正常立项，不阻塞报告落档。

**边界**：jev-locate（#242）是 PM 走查的定位辅助原语，不改变 PM 亲操口径；终检不替代 CI 的 L1 replay 全量回归（#116 收官门照跑，抽验只覆盖 staging 用户可见回放面）。

## 2. 角色

| 角色                                  | 职责                                                                                                                                                 | 红线                                                             |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| **用户**                              | 路线与范围裁决（排期、窄化/扩围、流程制度）                                                                                                          | —                                                                |
| **PM**（主会话）                      | 拆票、派单、集成、验收、infra 应急、决策记录（docs）                                                                                                 | 不亲手修码/配置（docs 决策记录除外）；已决事项不再请示           |
| **lane**（subagent）                  | 单票端到端：worktree 内实现 → 分支推送 → 报证据                                                                                                      | 永不推 origin/main；只碰派单声明的地盘与外部资源                 |
| **验收 lane**（lane 特化，#243/#277） | 独立验收：按模板（[acceptance-lane.md](acceptance-lane.md)）真机过 staging 面 → 勾票面验收框 → 回填证据三件套 → `AP.closeout` 入账 → 应答 grill 三靶 | 无 merge 按钮权（PM 统一串行 merge）；不修码；报告带不确定度声明 |
| **PMGuard**（独立 subagent）          | 纪委：只读巡检 lane 与 PM（七反模式 + 本手册协议），45min 节拍，≥2 lane 并行时常驻                                                                   | 只读不干预；成本估算随附                                         |
| **调研/普查 agent**                   | 只产出文档/排序表                                                                                                                                    | 零修复、零 tracker 变更、主源引用                                |

## 3. Tracker 模型（三正交轴）

依据 [tracker-structure-linear-mapping.md](../research/tracker-structure-linear-mapping.md)：

- **phase 轴 = milestone**（M0–M3）：只承载"何时/哪期"，与重要性无关。伞票/spec 票挂所属阶段。
- **重要性轴 = Priority**：`priority:p*` 标签是唯一真相与输入面（P0=放行/阻止/资损；P1=核心语义或可见损伤；P2=卫生），board Priority 字段是**缓存**（镜像标签，换 board 分组/排序/内联编辑）——缓存模式非双写：字段从不手设，漂移即以标签回改。词表三档封顶（p3 已废）。
- **生命周期轴 = Status**：project-board-sync 从 issue 事件推导——closed+wontfix→Canceled；closed→Done；open+`ready-for-human`→**Wait for user**；open+milestone→Todo；open 无 milestone→Backlog。**In Progress 由 PM 派发时直写**，PR 合并关票后自然收敛 Done。
- triage 五标签是收件箱轴，独立保留；**futurework**（无 milestone）与 backlog（承诺未排期）的区别在此成文。
- **标签词表已清沉积（2026-10-04）**：双胞胎家族全删——`stage:*`（↔milestone）、`status:awaiting-user`/`status:agent-ready`（↔triage 五标签）、`scope:bb`/`scope:worker-agent`（↔block:*）、`type:map`（↔wayfinder:map）、`priority:p3`（越档）。存留 `scope:infra`（横切环境面，无 block 对应物）。

## 4. 里程碑交付

- milestone 关闭 = tag `m<N>` + CHANGELOG.md 转正（Unreleased→版本段）。
- infra 漂移（面板/渠道等无 git 面）当日入 `docs/ops/`。
- 部署版本溯源：SERVER_VERSION=commit SHA，`/api/v1/system/version` 可查。

## 5. 制度变更

本手册改动 = PM 提案 + 用户裁决 + docs commit（决策记录豁免）。新裁决生效即改本手册或 engineering.md 对应条目，不留在会话记忆里。

## PM meta 裁决清单（2026-10-04 定案速查）

散场一天里定的 PM 层原则，正本索引（详文在各引用处）：

1. **角色终裁**：PM 担风险、推交付、自纠不过用户。用户决策清单仅三类：产品边界裁决（G1 类）、交付签收（tag 类）、预裁复裁（overridable 类）。其余一切 PM 自决并留理由。
2. **内容/机制分离**（#170 已入交付钩子）：PM 可起草文档内容；分支机制（checkout -b/commit/push/PR 流转）永不主 checkout 亲为。
3. **派发=保证型脚手架**（#171/#199）：AP.lane 的产品=四保证（worktree 预建/隔离 spawn/状态同步/派发记录）。DoR 三项=建议性仪表盘（打印永不拒派）；预算退出要求位=packet 信息行不进门（#224）；唯一拒派=板面谓词（闭票/非 Todo）。
4. **散文≠机制**（三连事故档：Banner/L197/L199）：派发承诺的隔离必须在 spawn 参数里（isolated:true）或派发前 bash 预建 worktree——上下文散文里的 "automatic" 一文不值。手工 spawn 无 isolated:true = 禁止。
5. **假严谨=真破坏**（用户引四渡赤水）：约束检测面对齐真实书写语言；词形级误拒真票=修工具（detector），不是改票面喂正则（hack）。同理：工具限制把 PM 逼回裸 spawn=丢全部保证=工具 bug。
6. **票=正本，spec 落盘非必要**：契约钉票链+研究文档+修订评论即可冷启动；"已知即所得"，.scratch spec 文件是仪式不是保险。
7. **上下文工具禁则**：self new_context 禁用，直至可靠上下文感知存在（两类死法：无 handoff 自压/压后连环误压）。如启用：拍边界+notebook 检查点已落=唯一安全翻转点；拍中禁。产品侧补法= #200（harness 水位暴露+确定性 rollover）。
8. **板面对账每拍**（#181 起 AP.audit 自动化）：snapshot→`AP.audit(snap, { activeLanes })`→`AP.apply(rep.mutations, { confirm: true })` 消漂移→复拍 clean。坑档：REST milestone 写可重置 status（写后复查=audit 再拍）；AP 模块变更后内核需带 ?t= 重 import；lane() 收 Ticket 对象（#199 修）。
9. **发令三段观察**：送达（spawn-ack）/回执（5 分钟限时，超时催办）/核验（远端地面真值，不信自报）——缺一段=开环指挥。
10. **PR 不在管理域**：Issue=管理域（归属规则见 tracker-schema.md 三轴模型）；PR=交付机制，不占 milestone 为规约。
