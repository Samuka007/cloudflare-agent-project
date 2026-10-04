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

派单上下文必含：

1. **效率预算行**：预期墙钟 / 资源占用上限 / 等待方式（交付即回 or 脚本化监控）。超预算 50% 要解释。
2. **资源所有权账本**：owned files/dirs + owned worktree 路径 + owned 外部资源（staging 部署、secret 注入、newapi 面板等）。PM 派单前做**不相交断言**——两 lane 地盘相交 = 派单错误。
3. **分支纪律**：lane 只推 `lane/<ticket>-<slug>`，PR 由 PM 审后 merge（origin/main 唯一写者 = PR 合并）。事故热修直推豁免须票面留 PM 亲验。
4. **POMDP 条款**：根因未证实不写码；先证据后动作（60 分钟未定位根因 → 报告而非猜改）。
5. 验收标准 = 票面 checklist，lane 报告必须带：commit hash、分支 CI run、测试计数、file:line 级根因（若是修 bug）。

## 4. PM 验收义务（收货先验再落盘）

1. 干净 worktree（非 lane 工作树）复跑关键测试/命令
2. 七条反模式清单过一遍（慢通道/重做/串行化/闲置占用/无账保守/轮询/retry-and-hope）
3. 关票评论必附证据（测试数、部署 URL、run 链接、file:line）；无证据不关票
4. staging 验证（若票面涉及）只经 `nix run .#staging-deploy`，只从 origin/main HEAD

## 5. 里程碑交付

- milestone 关闭 = tag `m<N>` + CHANGELOG.md 转正（Unreleased→版本段）
- infra 漂移（面板/渠道等无 git 面）当日入 `docs/ops/`
- 部署版本溯源：SERVER_VERSION=commit SHA（部署脚本注入，/api/v1/system/version 可查）

## 6. 制度变更流程

本手册改动 = PM 提案 + 用户裁决 + docs commit（决策记录豁免）。制度先于行为：新裁决生效即改本手册或 engineering.md 对应条目，不留在会话记忆里。
