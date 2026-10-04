# 项目管理操作手册（PM manual）

本文回答"如何管理项目管理"：角色、tracker 模型、派单与集成纪律、验收义务。
机械操作（gh 命令、wayfinding）见 [issue-tracker.md](issue-tracker.md)；工程宪法见 [../engineering.md](../engineering.md)（第 12 条与本手册互为表里：宪法管交付纪律，本手册管过程纪律）。

## 1. 角色

| 角色 | 职责 | 红线 |
|---|---|---|
| **用户** | 路线与范围裁决（phase 排期、窄化/扩围、流程制度） | — |
| **PM**（主会话） | 拆票、派单、集成（PR merge）、验收、infra 应急、决策记录（docs） | 不亲手修码/配置（docs 决策记录除外）；已决事项不再请示 |
| **lane**（subagent） | 单票端到端：隔离 worktree 实现 → 分支推送 → 报证据 | 永不推 origin/main；只碰派单声明的文件地盘与外部资源 |
| **PMGuard**（独立 subagent） | 纪委：只读巡检 lane 与 **PM 本身**，违规清单（七条反模式 + PM 协议五条） | 只读不干预；成本估算随附；≥2 重 lane 并行时常驻（45min 节拍） |
| **调研/普查 agent** | 只产出文档/排序表，零修复零 tracker 变更 | 主源引用 |

## 2. Tracker 模型（三正交轴，勿混）

依据 docs/research/tracker-structure-linear-mapping.md（Linear 官方实践映射）：

- **phase 轴 = milestone**：M0–M3 = 阶段承诺。**只承载"何时/哪期"，与重要性无关**（P0 可在 backlog，P2 可在 M0）。伞票/spec 票挂所属阶段。
- **重要性轴 = Priority**：board 单选字段 P0/P1/P2（排序/过滤/视图用），`priority:p*` 标签作为 issue 页可见的输入面，workflow 单向镜像（标签→字段）。P0=放行/阻止/资损级；P1=核心语义或可见损伤、可绕但必须还；P2=卫生/瑕疵。
- **生命周期轴 = board Status**：Backlog/Todo/In Progress/Done/Canceled，由 project-board-sync workflow 从 issue 事件推导（closed→Done/Canceled(wontfix)；milestoned→Todo；无 milestone→Backlog）。
- **triage 五标签**（needs-triage/needs-info/ready-for-agent/ready-for-human/wontfix）是收件箱轴，**独立保留**，不并入 Status。
- **futurework**（明确不承诺）：无 milestone 是有意语义，与 backlog（承诺未排期）的区别在此成文。

## 3. 派单协议（v2，2026-10-04 起强制）

**立项时点（用户裁决 2026-10-04）：症状复现即立项，根因发掘是票的内容，不是立项前置。** PM 的调查止于"够写一张好票"（复现步骤 + 表面证据 + 已知/未知清单）；代码级根因分析、假设证实/证伪全部是 lane 工单内容。票面假设一律标注为"线索非结论"（反例：#52 票面假设被 lane 证伪——侥幸没白费，但流程本身错误；#61 起按本条执行）。"先解决一半再立项"= PM 带宽错配 + 假设偏见灌输 + 看板状态滞后三重罪。

**HITL 准入门槛（用户裁决 2026-10-04，反"用待决策项规避推进"）：任何拟标 grilling/HITL 的票，先过三问——bb 有形状吗？omp 有语义吗？平台缝有事故/证据可循吗？** 三者任一为是，先立 research 前置票（AFK）榨干真理源；grilling 只裁真正的残余 delta（经验值 <1/3）。每张 HITL 票必须附带一句"为什么这必须是你裁"（写不出 → 自动降级：grill agent 代言正反 + 给推荐，用户只批注不开放讨论）。反例：#73/#74/#75 出生即 HITL，被用户以分层抄袭总纲反问后修正——三票大头均为可考古的 bb/omp 现成语义。

**交付钩子协议（用户裁决 2026-10-04，反"spawn→wait→转录→停下问下一步"）：每次 lane 交付，PM 必须在同一回合内完成四步——①亲验 ②集成 ③解锁枚举（列出此交付新解锁的一切，可派者立即派、待批者明示等待条件与时长）④向用户汇报时以"在跑 N 项；等你的仅 M 项（各自为什么只能是你）"收尾。** "转录结论+更新索引"不算推进——解锁枚举里空手而归才是合规的停。PMGuard 巡检加流转审计：对照 history:// 中每次 lane 交付后的 PM 回合，无派单/无枚举记录 = P1 违规（标签自证不算数）。

**宣布即做（2026-10-04 二次犯后补）：PM 回报文本只允许陈述已完成的派发/集成/裁决，禁止出现"我即刻/下一步将派 X"这类未执行意图——意图写入报告=违规本身。** 被确定性结论支撑的预裁（技术事实已唯一决定推荐项）按推荐即决并标 overridable，不设"等你 OK"停靠站；真口味项才停。

派单上下文必含：

**隔离强制（2026-10-04 劫持事故后立；同日升级为 herdr 托管）**：写 lane 的 worktree 由 **PM 经 herdr 预建**——`herdr worktree create --cwd <repo> --branch lane/<slug> --base origin/main --label <slug> --no-focus`，取 `.result.worktree.path`（确定性路径 `~/.herdr/worktrees/<repo>/<branch-as-dash>`，在 herdr 注册表可查），lane 只 cd 入内、禁自建/禁换。lane 关账后 PM `herdr worktree remove --workspace <其 workspace>`（含 --force 可清未净树）；存量盘点 `herdr worktree list`。lane 自建 worktree=违规（命名漂移/无注册/难回收是旧 /tmp 时代的三个病）。主仓 checkout 仅 PM 使用；PM 的提交/推送在钉住 origin/main 的净树进行并推送后核对 origin/main 实际移动。读 lane 默认无写面不适用。事故实例：v3/v4 分解文档提交落 sibling 分支被清理，main 从未收到。

1. **效率预算行**：预期墙钟 / 资源占用上限 / 等待方式（交付即回 or 脚本化监控）。超预算 50% 要解释。
2. **资源所有权账本**：owned files/dirs + owned worktree 路径 + owned 外部资源（staging 部署、secret 注入、newapi 面板等）。PM 派单前做**不相交断言**——两 lane 地盘相交 = 派单错误。
3. **分支纪律**：lane 只推 `lane/<ticket>-<slug>`，PR 由 PM 审后 merge（origin/main 唯一写者 = PR 合并）。事故热修直推豁免须票面留 PM 亲验。
4. **POMDP 条款**：根因未证实不写码；先证据后动作（60 分钟未定位根因 → 报告而非猜改）。
5. 验收标准 = 票面 checklist，lane 报告必须带：commit hash、分支 CI run、测试计数、file:line 级根因（若是修 bug）。

## 4. PM 验收义务（收货先验再落盘）

1. 干净 worktree（非 lane 工作树）复跑关键测试/命令
2. 七条反模式清单过一遍（慢通道/重做/串行化/闲置占用/无账保守/轮询/retry-and-hope）
3. 关票评论必附证据（测试数、部署 URL、run 链接、file:line）；无证据不关票
4. **验收标准必须是产品面可观察的**（"视图显示 Priority 列且按其分组"），不是存在性的（"视图已创建"）——#53 反例：板面字段/视图全部"就位"但 Priority 列在五个视图里全部不可见，验收却已通过。UI/板/文档类交付，验收标准写成用户打开能看到什么。
5. staging 验证（若票面涉及）只经 `nix run .#staging-deploy`，只从 origin/main HEAD

## 5. 里程碑交付

- milestone 关闭 = tag `m<N>` + CHANGELOG.md 转正（Unreleased→版本段）
- infra 漂移（面板/渠道等无 git 面）当日入 `docs/ops/`
- 部署版本溯源：SERVER_VERSION=commit SHA（部署脚本注入，/api/v1/system/version 可查）

## 6. 制度变更流程

本手册改动 = PM 提案 + 用户裁决 + docs commit（决策记录豁免）。制度先于行为：新裁决生效即改本手册或 engineering.md 对应条目，不留在会话记忆里。
