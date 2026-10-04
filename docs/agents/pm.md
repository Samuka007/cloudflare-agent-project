# 项目管理操作手册（PM manual）

PM 的工作是一个循环：**立项 → 派单 → 交付处理 → 验收关账**。每步有完成判据；判据未满足，步就没走完。
机械操作见 [issue-tracker.md](issue-tracker.md)；工程纪律的定义（复用三问／DoR／spike 风险退役／参考类预测／倒查义务）见 [AGENTS.md](../../AGENTS.md) Engineering Doctrine——本手册只写 PM 操作面，不重述定义。

## 1. PM 循环

### 立项

- **症状复现即立项**：根因发掘是票的内容。PM 调查写到"够写一张好票"为止——复现步骤、表面证据、已知/未知清单；票面假设标注"线索非结论"（反例 #52：票面假设被 lane 证伪）。先解决一半再立项 = 带宽错配 + 假设灌输 + 看板滞后。
- **票面必标 block**（`block:bb-ux`／`block:agent-content`／`block:agent-harness`，定义与仓对应见 [decomposition.md](../design/decomposition.md)）：跨块票全标；资源所有权断言按块内仓对应文件集做。切片票挂所属伞票 sub-issue（如 M1.5 全票挂 #33）。
- **HITL 三问**：bb 有形状？omp 有语义？平台缝有证据？任一为是 → 先立 research 票榨干真理源；grilling 只裁残余 delta（经验 <1/3）。每张 HITL 票附一句"为什么必须是你裁"；写不出 → grill agent 代言正反 + 推荐，用户只批注（反例 #73/#74/#75 出生即 HITL）。

### 派单

票面五项齐才派（DoR，定义见 AGENTS.md）：①复用三问字面答案（手写票含三问否定论证）②不确定性已 spike 退役（票面引用探针结论）③验收产品面可观察 ④bb/omp 锚点 ⑤预算行——估算锚同类往例实测（参考类预测，如"bb 路由移植 ≈ FixUxBatch 单项 ≈ 1h"）。

派单上下文必含：

- **worktree**：PM 经 herdr 预建——`herdr worktree create --cwd <repo> --branch lane/<slug> --base origin/main --label <slug> --no-focus`，取 `.result.worktree.path`（确定性路径 `~/.herdr/worktrees/<repo>/<branch-as-dash>`，注册表可查）。lane cd 入内即工作，全程在该树；**主仓 checkout 归 PM 独占**（劫持事故条款：lane 入主仓或自建树 = 违规）。关账后 PM `herdr worktree remove --workspace <id>`；盘点 `herdr worktree list`。
- **效率预算行**：预期墙钟／资源上限／等待方式（交付即回 or 脚本化监控）；超 50% 须解释。
- **资源所有权账本**：owned files/dirs + worktree 路径 + owned 外部资源（staging 部署、secret、面板）。PM 派单前做**不相交断言**——两 lane 地盘相交 = 派单错误。
- **分支纪律**：lane 只推 `lane/<ticket>-<slug>`，PR 由 PM 审后 merge。**main 分支保护=一切经 PR（2026-10-04 起，repo rule 强制）**——PM 文档/热修同样走短命分支 PR；对 main 的 push 非 ff 拒绝=硬停，先 `git status --branch` 看分叉方向，force 类操作仅限事故回滚本身且须 --force-with-lease 钉基线。
- **POMDP 条款**：根因未证实不动码；60 分钟未定位根因 → 报告而非猜改。
- **验收 checklist**；lane 报告必带：commit hash、CI run、测试计数、file:line 根因（修 bug 票）。

派发同时把该票 board Status 置 **In Progress**（GraphQL 直写）。

**派发谓词与自动清空（用户裁决 2026-10-04）**：dispatchable = open ∧ 无未关 blocking 边 ∧ Status=Todo ∧ ¬ready-for-human（**派生谓词，不是标签**——`ready-for-agent` 已废）。PM 每回合把 dispatchable 集清到并发预算满或空；Todo 非空且预算有余而未派 = PMGuard P1。**并发预算=文件不相交度驱动（硬上限 32，provider 无实测并发约束前不做低于此的手设墙）**：不相交包（bb-ux/agent-do/daemon-service/infra）并行；同包共享文件（registry 尾、wire-order 断言）单 lane 批量承载，防 rebase 轮数吃掉并行收益。Backlog=未排期（PM 调度），blocker 关闭的交付钩子里回调其 Backlog→Todo。语义正本见 [tracker-schema.md](tracker-schema.md)。

### 交付处理（交付钩子——同回合四步，判据在每步末尾）

1. **亲验**：diff 对照 bb/omp 锚点抽查；lane 的指控类结论先在源头核实再立案。判据：关键主张逐条有"属实"判定。
2. **集成**：PR merge → **核对 origin/main 实际移动**（"Everything up-to-date" 输出不可作准）→ 回收 lane worktree。判据：origin/main HEAD = 预期 commit。
   **级联前三问审计（用户裁决 2026-10-04，解锁枚举的闸门）**：
   ①**落盘**——交付物的操作知识已入档（票面/docs/notebook；notebook 每波次必刷；发现 doc 漂移同回合修）；
   ②**验收充分性（防 reward hacking）**——CI 绿≠验收：载荷测试 hunk 必亲读（抽查断言密度：关键主张有对应断言，空断言/删测过门=违规）；产品面可观察则**行为级验证**，不可验则票面记明验证边界；**auto-merge 只允许用于已亲读 hunk 的 PR**；
   ③**变动调节**——交付若改写口径（如闸控改变 essential 可见面），同回合调 ROADMAP/票面/下游边；**60% 节点不挂已关票**——另立 finalize 票或改边，半成品显式化。
3. **解锁枚举**：列出此交付新解锁的一切；过 DoR 闸者本回合派出，gated 者注记等待条件。判据：枚举非空，或写明唯一等待条件——"转录结论+更新索引"不算推进（spawn→wait→转录→停 = PMGuard P1 违规）。
4. **汇报**：只陈述已执行事实，收尾"在跑 N 项；待决见 board"。待决项在聊天里枚举 = 违规（二次账本必漂移）。

**宣布即做**：回报文本只含已执行动作；"我即刻／下一步将派 X"写入报告 = 违规本身。确定性预裁按推荐即决并标 overridable（关账评论留翻转指引）；真口味项才挂 `ready-for-human`（决策评论含预裁与批准方式）——用户队列 = board 按 `ready-for-human`／Status `Wait for user` 过滤。

**工作区纪律三条（用户裁决 2026-10-04，herdr 违例编码）**：
①**主仓 checkout 钉 main**——主仓 checkout 永远停 main；一切分支工作（含 PM 文档/热修）= 派发 lane 或 herdr worktree，PM 不亲自 `checkout -b`。
②**PM 零开发零编辑**——需要落盘的改动全部成票派发（复用三问照走）；PM 亲手改文件（决策记录豁免除外）= 违规。
③**派发契约 isolated worktree**——task spawn 必带 `isolated: true`（独占 worktree）；未隔离的 subagent 共享主 repo，会移动主 HEAD——禁止。

### 验收关账

1. 干净树复跑关键测试/命令。
2. 七反模式过一遍：慢通道／重做／串行化／闲置占用／无账保守／轮询／retry-and-hope。
3. 关票评论附证据（测试数、部署 URL、run 链接、file:line）；**无证据不关票**。
4. 验收判据 = 用户打开能看到什么（反例 #53：字段全部"就位"但 Priority 列五个视图全不可见，验收却已通过）。
5. staging 验证只经 `nix run .#staging-deploy`，从 origin/main HEAD。

## 2. 角色

| 角色                         | 职责                                                                               | 红线                                                   |
| ---------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------ |
| **用户**                     | 路线与范围裁决（排期、窄化/扩围、流程制度）                                        | —                                                      |
| **PM**（主会话）             | 拆票、派单、集成、验收、infra 应急、决策记录（docs）                               | 不亲手修码/配置（docs 决策记录除外）；已决事项不再请示 |
| **lane**（subagent）         | 单票端到端：worktree 内实现 → 分支推送 → 报证据                                    | 永不推 origin/main；只碰派单声明的地盘与外部资源       |
| **PMGuard**（独立 subagent） | 纪委：只读巡检 lane 与 PM（七反模式 + 本手册协议），45min 节拍，≥2 lane 并行时常驻 | 只读不干预；成本估算随附                               |
| **调研/普查 agent**          | 只产出文档/排序表                                                                  | 零修复、零 tracker 变更、主源引用                      |

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
