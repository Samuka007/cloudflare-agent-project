# Tracker Schema（板面声明式正本）

BoardSmith 章程（board-smith.md）的正本。板面任何结构性变更先改此文档（预检 diff→分批应用→终验），后动板。

## 分类心智模型（2026-10-04 定案，用户裁决——防似是而非）

三个正交轴，各自语义封闭，不互烹：

|轴|载体|语义|寿命|关闭|
|---|---|---|---|---|
|批次|milestone（W0 规划（已关）/W1 骨架（已关）/W2 工具集完备（在收）/W3 端到端真实体验（当前））|交付门：验收面全绿+tag|周-月|走查绿即关|
|阶段|`phase:m1/m2/m3` label + roadmap 伞 issue（#14/#15/#16）|章程叙事弧|季度+|章程阶段出口|
|线索|`track:pm-scaffolding/infra-cd/acceptance/research` label|横切连续关切|无限|无（永不成批）|

规则：
1. milestone 字段只放批次；新票默认入当前批次（W1）。
2. 阶段不占 milestone（历史 M2/M3 milestone 内开放票已迁 label；M0=冻结历史分组，合法存在）。
3. 开放票归属=批次 milestone XOR phase/track label；PR 不在管理域（不占 milestone 为规约）。
4. 无「冻结里程碑收新票」态——批次要么在跑要么是历史；阶段叙事/裁决沉淀在伞 issue，不在 milestone。
5. 编号陷阱：milestone number 3=M2 存量迁移（勿当 M1.5；M1.5=7，W1=8）。
6. 意图平面（phase/M 系列）≠排期：phase 是应然竖切（约束集/地图），不规定开发顺序；开发顺序唯批次（W*）论，按相对完整度与体验组织。编号陷阱更新：milestone 编号已重排：9=W0、10=W1、7=W2、8=W3（旧编号 1-6 已删/退役）。

## 轴×真相源（每轴恰一）

| 轴          | 真相源                                                                                | 派生/缓存                                                 |
| ----------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| phase       | milestone（原生）                                                                     | 无                                                        |
| importance  | **Priority 字段**（PM/用户直写；无标签双胞胎）                                        | 无                                                        |
| lifecycle   | issue 事件 + ready-for-human 标签                                                     | Status 由 project-board-sync 派生（workflow 只写 Status） |
| inbox       | triage 标签：`needs-triage`（PM 收件箱：未过 DoR/未接线）、`needs-info`（等外部信息） | 无                                                        |
| human-queue | `ready-for-human` 标签                                                                | → Status `Wait for user`（sync 派生）                     |
| territory   | `block:bb-ux`/`block:agent-content`/`block:agent-harness` + `scope:infra`（横切）     | 无                                                        |
| process     | `wayfinder:map`/`grilling`/`research`/`prototype`/`task`                              | 无                                                        |
| work-type   | `type:implementation`/`research`/`decision`                                           | 无                                                        |

**已废除**（2026-10-04，双胞胎清理）：`stage:*`↔milestone、`status:awaiting-user`/`agent-ready`↔triage/Wait for user、`scope:bb`/`worker-agent`↔block、`type:map`↔wayfinder:map、`priority:*` 标签↔Priority 字段、`ready-for-agent`（可派生，见下）。

## Status 语义与派生

| 值              | 语义                                                                       | 谁写                                        |
| --------------- | -------------------------------------------------------------------------- | ------------------------------------------- |
| Backlog         | **未排期**：收容/承诺但未进当前执行波次（PM 调度决定——与 blocking 无关）   | sync 派生（open 无 milestone）+ PM 排期调整 |
| Todo            | **已排期**：进入当前执行波次的票（被挡与否由 blocking 轴表达，不映入本轴） | sync 派生（open+milestone）+ PM 排期调整    |
| In Progress     | lane 在跑                                                                  | PM 派发时直写                               |
| Wait for user   | 等用户裁决                                                                 | sync 派生（open+ready-for-human）           |
| Done / Canceled | 关闭 / wontfix                                                             | sync 派生                                   |

**派发谓词（用户裁决 2026-10-04）**：`ready-for-agent` 不是标签——dispatchable 是**跨轴派生谓词**：`open ∧ Status=Todo ∧ 无未关 blocking 边 ∧ ¬ready-for-human`。各轴只存自己的正交事实，一切决策（派发/解锁/预警）从轴组合**推导**，任何单轴不得烘焙另一轴的语义（如"被挡→Backlog"=轴污染，2026-10-04 已纠）。PM 每回合把 dispatchable 集清到并发预算满或空；PMGuard 审计"dispatchable 非空且预算有余而未派"=P1。

**In Progress 计票不计人（2026-10-04）**：薄激活票可由 lane 批量承载（一 lane 多票、一 PR 分 commit 关多票）——In Progress 语义=「此票正被某 lane 加工」，非「一票一进程」。lane↔票映射在派发 packet（AP.dispatchPackets）中显式生成；票集成完成（merge+close）即收敛 Done；批量 lane 的每张票独立走交付钩子四步。

## 结构关系

- 伞票 sub-issue 层级（如 M1.5 #33 → #91-#116+#128）
- blocking 边=正本提案 DAG 的投影；票集落地时同步补边
- blocker 关闭≠自动解锁语义变化（sync 不动 Status 除事件派生；PM 在交付钩子里回调被挡票 Backlog→Todo）

## 不变量

1. workflow 只写 Status；禁止任何"无输入→清字段"逻辑（事故源 2026-10-04）
2. 替换类 API（singleSelectOptions 等）必须预检全量项值不悬空
3. 词表封闭：新标签/字段/选项先入本文档
4. 每轴单源；标签与字段不得互为镜像（缓存方向单一且可重放）
5. **REST 建票的 labels 数组会自动创建未知标签**（事故：priority:\* 两度复活 2026-10-04）——建票模板禁含未注册标签名；priority 一律建票后 AP.apply 字段直写
