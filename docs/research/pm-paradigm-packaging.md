# PM 范式业务无关化提炼与 omp 可安装件形态研究（matt-pocock skill 风格）

- 工单：Samuka007/cloudflare-agent-project#268（副产品；研究票，不写产品码）
- 检索日期：2026-10-05
- 依据：本仓范式正本（docs/agents/pm.md、tracker-schema.md、board-smith.md、AGENTS.md、scripts/pm-autopilot.ts、scripts/pm-harness.ts）；mattpocock/skills 仓库实读（tree/plugin.json/4 份 SKILL.md 全文）；omp harness 官方文档（omp://skills.md、marketplace.md、extension-loading.md、task-agent-discovery.md、rulebook-matching-pipeline.md、ttsr-injection-lifecycle.md）；本机活体探针（`omp plugin list`、`omp skill --help`、`~/.omp/marketplaces.json`、`~/.agents/.skill-lock.json`、目录枚举）。
- 结论先行：
  1. **范式可以整体业务无关化**。20 件组件里 14 件纯/纯-需锚，5 件半纯（模板纯、词汇实例化），仅 wave 终检 A 段与三轴词表携带产品词汇；bb 面在范式核心零依赖（只出现在实例化例句）。
  2. **matt-pocock 套件没有"多 lane 指挥层"**——他的 suite 覆盖 idea→spec→tickets→单票 implement（工人层），我们范式独有的是 conductor 层：板面对账、派发脚手架、租约台账、验收门、wave 终检。映射表显示我们应做成他形态的**补充层**而非仿制品。
  3. **omp 扩展面有四级安装件粒度**（实测证据见 §3）：单 skill 包（skills.sh，跨 agent 通用）→ skillshare 包（`omp skill install`，registry+lock）→ marketplace 插件（一件装 skills+rules+agents+commands+MCP，user/project 双 scope）→ TS 扩展模块（运行时 hooks/tools）。**没有任何机制写宿主 config.yml/models.yml/环境变量**——初始化流程只能由 setup skill（prompt-driven，matt-pocock 同款先例）承载。
  4. **建议 A+B 复合**：A（skill 族，skills.sh 仓库）为业务无关正本；B（omp marketplace 插件）为同内容的 omp 增强壳，附 TTSR 规则（给"散文≠机制"类纪律装强制牙）与 pm-guard agent 定义。最小切片 = 4-skill 家族（pm-setup/pm-dispatch/pm-audit/pm-final-check），票面草案见 §4.3，可直接派发。

---

## 1. 范式组件清单（纯度 + 依赖标注）

纯度分级：

- **纯**：文本/逻辑业务无关，可原样搬走（至多改名）。
- **纯-需锚**：逻辑纯，但需要外部锚（repo/project 标识、API key、tracker 端点）。AP 本体已 env 参数化（`REPO = process.env.PM_REPO ?? …`、`PROJECT_ID = process.env.PM_PROJECT_ID ?? …`，scripts/pm-autopilot.ts:345-346），证明"需锚"实际是配置面不是代码面。
- **半纯**：模式/模板纯，但携带实例化词汇，搬运时需换词表。

依赖域三分解：**GH**（GitHub API：gh CLI/GraphQL Projects V2）、**omp**（omp 工具面：task spawn、eval 内核、git worktree 由 bash 面）、**fs**（本地文件）、**jev**（typesafe System One judge API）、**无**（纯文本）。

| # | 组件 | 今日载体（锚） | 纯度 | 依赖 |
|---|------|----------------|------|------|
| 1 | PM 循环骨架（立项→派单→交付处理→验收关账） | docs/agents/pm.md:3,6 | 半纯（骨架纯；例句含 bb-ux/block:* 词汇） | 无 |
| 2 | 每拍板面对账五规则 + 消漂移 | pm-autopilot.ts:1838 `audit()`；pm.md:16 | 纯-需锚 | GH |
| 3 | 派发谓词 dispatchable（open ∧ Todo ∧ 无未关 blocking ∧ ¬rfh） | pm-autopilot.ts:616-617；tracker-schema.md:48 | 纯 | 无 |
| 4 | 派发脚手架 AP.lane（worktree 预建→isolated spawn→Status 翻转→packet） | pm-autopilot.ts:1017 `lane()`、:664 `dispatchPackets()`；pm-harness.ts:96-115 | 纯-需锚 | omp spawn + GH + bash |
| 5 | 资源租约台账（lease/release/ledger，`.pm-leases.jsonl`） | pm-autopilot.ts:1628/1682/1724；pm.md:25 | 纯（浏览器实例是可选特化） | fs |
| 6 | DoR 票门/建议表（三项门 #224 + 五项纪律定义） | pm-autopilot.ts:762 `dorChecklist()`；AGENTS.md:21 | 纯 | 无 |
| 7 | 交付钩子四步（亲验→集成→解锁枚举→汇报，判据内嵌） | pm.md:34-43 | 纯 | 无 |
| 8 | 级联前三问审计（落盘/验收充分性防 reward hacking/变动调节） | pm.md:38-41 | 纯 | 无 |
| 9 | 解锁级联 planCascade/cascade（blocker 关闭→解锁+Backlog→Todo 回调） | pm-autopilot.ts:1469/2621 | 纯-需锚 | GH |
| 10 | 立项 intake + jev 闸门（INTAKE_QUESTIONS→judge→gateOf 0.8/0.5 三档→file） | pm-autopilot.ts:3029/3115/3129/3185/2806 | 纯-需锚 | jev + GH |
| 11 | 三轴 tracker 模型（milestone/Priority/Status 派生）+ 单源不变量 | tracker-schema.md:23-64 | 半纯（轴模型纯；词表 W*/P*/block:* 实例化） | GH（sync workflow） |
| 12 | BoardSmith 迁移纪律（声明→预检 diff→分批应用→终验→留痕） | board-smith.md:7-13 | 纯 | GH |
| 13 | PMGuard 效率审计（代价问句 + 七反模式 + 45min 只读巡检） | pm.md:93；skill://stateless-pm-discipline | 纯 | 无 |
| 14 | Stateless lane 契约（subagent 即纯函数：自包含票进/实体产物出/上下文即弃） | skill://stateless-pm-discipline；pm.md:16 | 纯 | omp spawn |
| 15 | 装载体 pm-harness（`%load`→cache-bust import→`globalThis.AP`+spawn 织入） | pm-harness.ts:96-115；pm.md:22 | 纯-需锚 | omp eval 内核 |
| 16 | wave 终检三段模板（A 走查/B 动线/C 回放抽验）+ 证据三件套范式 | pm.md:61-84 | 半纯（三段结构与证据范式纯；A 段"六表现"是产品词汇） | 产品 staging 面 |
| 17 | 签收票范式（commit hash · CI run · 测试数 · file:line 根因） | pm.md:28,55；工单 Report 节 | 纯 | 无 |
| 18 | 工程铁律五件套（复用三问/DoR/spike 风险退役/参考类预测/倒查义务）+ POMDP 观察纪律 | AGENTS.md:11-41,77-84 | **纯**（票面已声明"可直接搬"） | 无 |
| 19 | 信念审计（OBSERVED/ASSUMED 台账；elementFromPoint 教训：探针让假设变红） | omp 会话规则活体（本 harness belief-ledger） | 纯 | 无 |
| 20 | 鉴别诊断 H1-H3（竞争假设并列、逐个证伪） | 会话实践沉淀（omp 诊断类 skill 群通用） | 纯 | 无 |
| 21 | 用户三类决策清单（G1 产品边界/tag 签收/overridable 预裁；其余 PM 自决） | pm.md:120 | 纯 | 无 |
| 22 | 发令三段观察（送达 spawn-ack/回执限时/远端核验，缺一段=开环） | pm.md:128 | 纯 | 无 |

统计：纯 12、纯-需锚 6、半纯 4（#1 半纯指例句层，其步骤骨架可直接抽象）。**bb 面依赖：0**——bb 只出现在实例化例句（如 HITL 三问"bb 有形状？"），抽象化后消失。

## 2. matt-pocock skills 调研与映射表

### 2.1 仓库事实（2026-10-05 实读 mattpocock/skills）

- 规模与分发：276,524 stars；`skills/<category>/<name>/SKILL.md` 布局（engineering 20 + productivity 7 + misc 4 + in-progress/deprecated 缓冲区）；四条分发通道并存——aihero.dev 文档站、`npx skills add mattpocock/skills`（skills.sh CLI，落 `~/.agents/skills/`）、`.claude-plugin/{marketplace,plugin}.json`（Claude 插件市场，plugin.json v1.3.1 列 27 个 skill 入口）、changesets+release.yml 版本化。
- 每 skill 附 `agents/openai.yaml`（Codex 侧 UI 元数据/隐式调用开关）——同一内容多 harness 适配靠**外围清单文件**，SKILL.md 本体不动。
- 本仓活体证据：`~/.agents/.skill-lock.json` 里 37 个 skill 经 skills.sh 安装（ask-matt/grill-with-docs/to-tickets/…），AGENTS.md:100-102 的 ask-matt 路由即该安装的消费面；docs/agents/{issue-tracker,triage-labels,domain}.md 三件正是他 setup skill 的产物形状。

### 2.2 指令风格要点（4 份 SKILL.md 全文归纳）

1. frontmatter 三件套：`name`/`description`（一句话 = 做什么+何时用）/`disable-model-invocation: true`（全部 user-invoked 流程 skill 如此，防模型乱触发）。
2. 正文 = 祈使句散文 + **bold 关键词** + 编号 Process；每步内嵌完成判据（与 pm.md"判据未满足步就没走完"同构）。
3. 同目录相对链接参考文件做 progressive disclosure L3（triage→AGENT-BRIEF.md/OUT-OF-Scope.md；ask-matt→PHASE-BOUNDARIES.md；domain-modeling→ADR-FORMAT.md）。
4. 正文内嵌 XML-ish 模板块（`<vertical-slice-rules>`、`<issue-template>`、`<local-ticket-template>`）。
5. 组合方式：skill 按名互调（triage 两次 Skill tool 调 grilling+domain-modeling；implement 内驱 /tdd、收尾 /code-review）；**router skill**（ask-matt）做情境分流；**vocabulary 层**（domain-modeling/codebase-design，model-invoked）垫底做单一真相源。
6. 前置指针惯例：缺配置时指令写死"tell the user to run `/setup-matt-pocock-skills`"——setup skill 是 prompt-driven 探测+确认+写 `docs/agents/*.md`，不是脚本。
7. 机器可执行部分 = skill 目录内 `scripts/`（wizard/template.sh、diagnosing-bugs/hitl-loop.template.sh、git-guardrails/block-dangerous-git.sh），由模型 bash 执行，无任何运行时（与 agent-skills-core.md §5 结论一致）。
8. 纪律性细节：triage 每条评论带 AI 披露行；resumable session 段（读旧笔记不重问）；`.out-of-scope/` 拒绝知识库防重复立项。

### 2.3 映射表：我们的件 ↔ 他的 skill 形态

| 我们的件 | 形态判定 | 他的对应物 | 差异/白区 |
|---|---|---|---|
| ask-matt 路由（已装） | router | ask-matt 本尊 | 直接复用；我们需自建 pm 路由（ask-pm）分流 conductor 层 |
| pm.md PM 循环（#1,#7,#8） | 主流程 skill | **无对应**——他的 implement 是单票工人层 | **白区 1：conductor 层**（多 lane 指挥、交付钩子、级联） |
| AP.audit 板面对账（#2）+ 派发谓词（#3） | 状态机纪律 | triage（角色×状态机） | 他的状态机靠人驱动；我们的漂移规则 1-6 可机械断言 |
| AP.lane 派发脚手架（#4,#15） | 流程+脚本 | implement（fresh context per ticket）× wizard（template.sh 脚本） | **白区 2：worktree 预建/isolated spawn/状态翻转自动化** |
| stateless lane 契约（#14）+ 签收票（#17） | 契约模板 | triage 的 AGENT-BRIEF.md + implement 的 per-ticket fresh | 语义同构，可合并成一票模板 |
| 工程铁律（#18-#20） | vocabulary/reference 层 | domain-modeling / codebase-design（model-invoked 单一真相源） | 同构；照搬他的"垫底层"定位，不做成流程 |
| wave 终检三段（#16） | 清单式评审 | code-review（两轴评审）+ retro | 他评 diff，我们评真机行为；证据三件套是我们的独创范式 |
| docs/agents/{pm,tracker-schema,board-smith}.md | setup 产物 | setup-matt-pocock-skills 写 docs/agents/*.md | 我们的 = 他模式超集（多了 schema 正本与章程） |
| 立项 intake jev 闸门（#10） | 人工/裁判环节 | wizard（human-only steps）方向互补 | 他生成 HITL 脚本；我们用 judge 模型预裁+三档闸 |
| 三轴 tracker 模型（#11）+ BoardSmith（#12） | tracker 配置正本 | setup skill 的 issue-tracker.md（一页惯例） | **白区 3：声明式 schema+迁移纪律**，他的 setup 没有这层 |

结论：他的套件是**工人层 + 入口层**（grill→spec→tickets→implement + triage/wayfinder 入口 + 词汇垫底）；我们范式的独有价值恰是他缺的**指挥层**（对账/派发/租约/验收/终检）。打包定位应是"conductor layer that drives his worker skills"，与他 suite 正交可叠加。

## 3. omp 扩展面实测（结论全部有证据）

### 3.1 安装件粒度谱系（粗→细）

| 粒度 | 载体 | 可携带 | 作用域 | 证据 |
|---|---|---|---|---|
| ① 单 skill 包 | skills.sh 仓库 `skills/<name>/SKILL.md` | SKILL.md+参考文件+scripts | 跨 agent（30+ 采用方，agentskills.io） | `npx skills add` 实装 37 件（~/.agents/.skill-lock.json）；skill://skills-sh-publish-and-install 全流程 |
| ② skillshare 包 | `omp skill install @scope/pkg` | 同上，registry+semver+lock | omp 用户/项目 `.omp/skills.lock.json` | `omp skill --help`（publish/version/tag/yank/token 全套，omp://skills.md:92 skillshare provider priority 95） |
| ③ marketplace 插件 | `.omp-plugin/marketplace.json`（或 `.claude-plugin/` 兼容）目录 | **skills + rules + agents + commands + hooks + tools + MCP + LSP + DAP** | user（~/.omp/plugins）与 project（.omp/plugins）双 scope，project 遮蔽 user | omp://marketplace.md:18-19；本机 `omp plugin list` 实装 context7+superpowers@claude-plugins-official、~/.omp/marketplaces.json 在案 |
| ④ TS 扩展模块 | `omp.extensions` manifest / `.omp/extensions/` | 运行时：自定义 tools、事件 hooks（tool_call/before_subagent_spawn/ttsr_triggered…）、commands、模型注册 | 同进程非沙箱 | omp://extension-loading.md 全篇；task-agent-discovery.md:153-158（扩展包 `agents/` 子目录进 task-agent 发现，优先级高于 bundled） |

### 3.2 关键面逐项判定

- **skills**：11 个 provider（native 100 → skillshare 95 → omp-plugins 90 → … → omp-managed 5），同名高优先级保裸名、低优先级加命名空间（omp://skills.md:89-104）。**"managed-skills"（~/.omp/agent/managed-skills，本机 754 件）是 auto-learn 自动习得区，不是人工 skill 的安装位**——人工家族应装 authored 位（native/skillshare/plugin），managed 恒让位（omp://skills.md:102）。
- **rules（TTSR）**：provider 含 **omp-plugins（priority 90，读扩展包根 `rules/*.{md,mdc}`）**与 native（`~/.omp/agent/rules/`、项目 `.omp/rules/`、sticky RULES.md）（omp://rulebook-matching-pipeline.md:61-79）。带 `condition` 正则/AST 即为强制拦截（中断+注入），带 `question` 走 jev judge 事后判定（omp://ttsr-injection-lifecycle.md:286-304，judge 解析到 System One/TypeSafe jev；本机 AP 的 jev = `https://api.typesafe.ai/v1/systemone`、model `jev-latest`，scripts/pm-autopilot.ts:463-465——同一供应商两条用法）。⇒ **插件可给纪律装强制牙**，例：拦"无 `isolated:true` 的裸 task spawn"。
- **agents**：`~/.omp/agent/agents/*.md`（本机现存 designer/oracle）、项目 `.omp/agents/`、**扩展包 `agents/`、Claude 市场插件 `agents/`** 四路并入 task-agent 发现，first-wins（omp://task-agent-discovery.md:145-163）。⇒ pm-guard/board-smith 这类角色 def 可随插件分发。
- **初始化流程（GitHub 项目/标签/文件脚手架 + jev key + modelRoles）**：**没有任何安装机制写宿主 config.yml/models.yml/env**——marketplace 安装只落缓存+注册表（omp://marketplace.md:228-246），skill/插件均无 postinstall 钩子。初始化唯一 sanctioned 形态 = **setup skill**（prompt-driven 探测→确认→写 `docs/agents/*.md`+跑 `gh project create`/label 播种），matt-pocock setup-matt-pocock-skills 是成熟先例，且本仓 docs/agents/ 三件即其产物。jev/GitHub 凭据走 env 约定（PM_REPO/PM_PROJECT_ID/JEV_API_KEY 已参数化，scripts/pm-autopilot.ts:345-346,437-441），由 setup skill 校验而非安装器写入。
- **AP harness 脚本**：pm-harness.ts 是 eval 内核 TS（依赖 `globalThis.agent` 传输，pm-harness.ts:99-115），不属于任何 hook/tool 运行时 ⇒ 随包分发为 skill 目录 assets，正文指示 `%load <skill-dir>/scripts/pm-harness.ts` 装载；重写为扩展模块（自定义工具）是 B+ 增强项，非首版必需。
- **上下文成本对照**：skill 目录注入 ~100 token/skill（agent-skills-core.md §1.2）；Codex 侧目录预算 2% 窗口。⇒ 家族应控制在 ≤8 件 + 1 router，vocabulary 层用 model-invoked（disable-model-invocation 反向：只让模型拉）。

## 4. A/B 对照、建议与最小切片

### 4.1 对照

| 维度 | A：skill 族（skills.sh 仓库，matt-pocock 形态） | B：omp marketplace 插件 |
|---|---|---|
| 可安装件内容 | SKILL.md+参考+scripts（文本层） | skills+**rules（TTSR 强制）**+**agents（角色 def）**+commands+MCP 一件装 |
| 生态半径 | 30+ agent 通用（agentskills 标准）；本仓已消费此通道 | omp+Claude 系；本机已实装 2 插件证明链路通 |
| 纪律强制力 | 无（纯文本纪律） | rules 条件拦截（散文≠机制可部分机械化） |
| 初始化 repo/issue/project | setup skill（gh 命令清单进正文） | 同左 + 插件可带 MCP server（无 postinstall 写配置，与 A 同限） |
| 版本化/回滚 | git tag + skills lock | 目录锁 `installed_plugins.json` + scope 遮蔽 + `/reload-plugins` |
| 维护面 | 单仓库单格式 | 同仓库加 `.omp-plugin/`+plugin 目录，增量小 |
| 主要风险 | 无强制力，纪律靠模型自觉 | 生态绑定；marketplace catalog 校验细节（命名规则/版本解析） |

### 4.2 建议

**A 为正本、B 为增强壳的复合方案**：

1. 建 `pm-skills` 仓库（或本仓 `skills/pm/` 目录起步）：`skills/<name>/SKILL.md` matt-pocock 布局，组件按 §1 纯度归位——纯件直接成文，纯-需锚件正文只写逻辑+env 约定，半纯件把实例词汇抽成"词表参数段"（setup 时替换）。
2. 同仓库加 `.omp-plugin/marketplace.json` + 插件目录：`skills/` 软链复用同一内容，`rules/` 放 2-3 条 TTSR 强制规则（裸 spawn 拦截、主仓 checkout 直写拦截），`agents/` 放 pm-guard 只读巡检 def。
3. 明确不做：postinstall 写 config（平台不支持）；把 AP 重写为扩展模块（列为后续票）。
4. 装载契约写进 pm-setup 产物：`%load <skill-dir>/scripts/pm-harness.ts` + env 三项（PM_REPO/PM_PROJECT_ID/JEV_API_KEY）+ `omp ttsr list` 验证规则注册。

### 4.3 最小切片（4-skill 家族，可直接派发）

**票面草案**（按 stateless 契约）：

- **Target**：新建 `skills/pm/`，产出 4 skill：`pm-setup`（探测 gh auth/remote→写 docs/agents/{pm,tracker-schema,issue-tracker,triage-labels}.md 参数化版本→`gh project create`+标签播种清单→env 校验单）；`pm-dispatch`（循环骨架 #1+派发谓词 #3+AP.lane 包 #4+#15：装载体、worktree 命令、spawn 包、DoR 建议表 #6、租约 #5、发令三段 #22）；`pm-audit`（对账五规则 #2+交付钩子四步 #7+级联三问 #8+PMGuard 七反模式 #13+用户三类决策 #21）；`pm-final-check`（wave 终检三段模板 #16 抽象版+证据三件套 #17+空框不可关）。工程铁律 #18-#20 做成第 5 件 model-invoked vocabulary（`pm-doctrine`），router 可选第 6 件。
- **Change**：每件 SKILL.md 按 §2.2 风格（frontmatter 三件套/祈使句/判据内嵌/模板块/相对链接参考文件）；AP 源码以 assets 随 `pm-dispatch` 分发；词汇表抽为各 skill 头部 `<!-- vocab -->` 段。
- **Acceptance**（产品面可观察）：`npx skills add <repo> --list` 可发现；`npx skills-ref validate` 过；从安装位置（非工作区）走查 pm-setup 在空仓产出 docs/agents/ 四件+项目创建 dry-run；pm-dispatch 正文含可直接粘贴的 AP.lane 调用；TTSR 规则 `omp ttsr test` 正反例过（B 壳票）。
- **边界**：不写产品码、不动 AP 本体行为；bb 面零引用（词表段除外）。

### 4.4 验收对照

- [x] 组件清单 ≥10 件带纯度标注 → §1（22 件）
- [x] matt-pocock 映射表成文 → §2.3
- [x] omp 扩展面结论有实测证据 → §3（omp:// 文档 + 本机探针：plugin list/marketplaces.json/skill CLI/skill-lock/目录枚举）
- [x] A/B 建议+最小切片可派发 → §4.2/§4.3（含票面草案）

---

**参考来源汇总**：mattpocock/skills（repo tree、.claude-plugin/plugin.json v1.3.1、skills/engineering/{to-tickets,triage,setup-matt-pocock-skills}/SKILL.md、ask-matt 本地副本 ~/.agents/skills/ask-matt/SKILL.md，均 2026-10-05 实读）；omp harness 文档 omp://skills.md、omp://marketplace.md、omp://extension-loading.md、omp://task-agent-discovery.md、omp://rulebook-matching-pipeline.md、omp://ttsr-injection-lifecycle.md；本机探针 `omp plugin list`、`omp skill --help`、`~/.omp/marketplaces.json`、`~/.agents/.skill-lock.json`、`~/.omp/agent/{agents,managed-skills,rules}` 枚举；本仓正本 docs/agents/{pm,tracker-schema,board-smith}.md、AGENTS.md、scripts/{pm-autopilot,pm-harness}.ts、docs/research/agent-skills-core.md。

> AGENT GENERATED: by zhipu-coding-plan/glm-5.3-flash (research subagent)
