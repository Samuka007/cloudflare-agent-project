# Tracker Schema（板面声明式正本）

BoardSmith 章程（board-smith.md）的正本。板面任何结构性变更先改此文档（预检 diff→分批应用→终验），后动板。

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

## 结构关系

- 伞票 sub-issue 层级（如 M1.5 #33 → #91-#116+#128）
- blocking 边=正本提案 DAG 的投影；票集落地时同步补边
- blocker 关闭≠自动解锁语义变化（sync 不动 Status 除事件派生；PM 在交付钩子里回调被挡票 Backlog→Todo）

## 不变量

1. workflow 只写 Status；禁止任何"无输入→清字段"逻辑（事故源 2026-10-04）
2. 替换类 API（singleSelectOptions 等）必须预检全量项值不悬空
3. 词表封闭：新标签/字段/选项先入本文档
4. 每轴单源；标签与字段不得互为镜像（缓存方向单一且可重放）
