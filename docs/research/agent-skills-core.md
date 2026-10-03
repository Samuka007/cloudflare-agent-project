# Agent Skills 的核抽象：它到底是什么

- 工单：Samuka007/cloudflare-agent-project#3（"skills 迁移到 worker agent 的形状与执行语义"，隶属 #1）
- 检索日期：2026-10-03
- 依据：Anthropic 官方文档/工程博客、agentskills.io 开放标准、OpenAI Codex 官方文档（一手来源），加本机 omp harness 活体标本（`~/.omp/`）。待检验命题：**"skill 说到底只是文本注入；环境/执行问题是另一层的事，与 skill 框架解耦；per-host isolation 即可"**。
- 结论先行：命题成立，但有两处精确化（见 §5、§6）。

---

## 1. Anthropic Agent Skills 规范：SKILL.md 的完整机制

### 1.1 格式本体

一个 skill 就是一个目录，最少只含一个 `SKILL.md`：

```text
skill-name/
├── SKILL.md          # 必需：YAML frontmatter + Markdown 正文
├── scripts/          # 可选约定：可执行代码
├── references/       # 可选约定：补充文档
└── assets/           # 可选约定：模板、静态资源
```

frontmatter 必填字段只有两个：`name`（≤64 字符，小写字母/数字/连字符，须与目录名一致）、`description`（1–1024 字符，非空，"描述做什么 + 何时用"）。可选字段：`license`、`compatibility`（≤500 字符，声明环境要求，如 "Requires git, docker, jq"）、`metadata`（任意 string→string map）、`allowed-tools`（实验性，预批准工具列表）。正文无格式限制。[来源：Agent Skills Specification — https://agentskills.io/specification ]

### 1.2 Discovery 怎么发生：description 是唯一触发索引

启动时，agent 把**每个**已安装 skill 的 `name + description` 预载进 system prompt（约 100 token/skill）。`description` 是 Claude 判断是否触发 skill 的**唯一匹配依据**，官方因此要求它必须同时写"做什么"和"何时用"，并建议写得"pushy"以防 undertrigger。触发前，skill 正文不占任何上下文。[来源：Agent Skills 概述 "Level 1: Metadata (always loaded)" — https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview ；skill-creator SKILL.md "the primary triggering mechanism" — 本机标本，路径见 §3]

### 1.3 Progressive disclosure 的三个层级

| 层级 | 何时加载 | token 成本 | 内容 |
| --- | --- | --- | --- |
| L1 元数据 | 启动，恒载 | ~100/skill | frontmatter 的 name + description |
| L2 指令正文 | 触发时（模型认为相关） | 建议 <5k | SKILL.md body |
| L3+ 资源 | 正文引用到时才读 | 未访问前为零 | references/、assets/ 读进上下文；scripts/ **执行** |

关键句："When you request something that matches a Skill's description, Claude reads SKILL.md **from the filesystem using bash**. Only then does this content enter the context window." 触发机制就是模型自己调一次文件读取——没有独立触发引擎。[来源：同上 overview 页]

### 1.4 scripts/templates 的官方定位：是文件，不是运行时

官方对 bundled code 的定位毫不含糊：脚本由 Claude **用 bash 运行**，"the script code itself never enters context"，只有输出进上下文——脚本是"确定性操作"的效率手段，不是 skill 框架的执行组件。"Skills run in a code execution environment where Claude has filesystem access, bash commands, and code execution capabilities"——执行环境是**前置条件**，写在架构描述里而不是 skill 格式里。API 侧同样：skill 通过 `container` 参数 + code execution tool 使用，skill 本体只是上传的目录包。[来源：同上 overview 页 "The Skills architecture" + "Claude API" 节]

工程博客的类比更直接：skill 像"给新员工的 onboarding 手册"——文件夹里是说明、脚本和参考资料，没有运行时语义。设计原则就是 progressive disclosure，"the amount of context that can be bundled into a skill is effectively unbounded"。[来源：Equipping agents for the real world with Agent Skills — https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills ]

## 2. Claude Code 的实际实现

### 2.1 注入的是什么、何时注入

- **目录注入**：每个 turn 的 system prompt 里携带全部可见 skill 的 name + description（官方承认这是持续成本，提供了 `/skill-doctor` 报告每个 skill 的上下文开销）。
- **正文注入**：匹配到任务后，Claude 经 Skill 工具（或直接读文件）加载 body；"Claude Code adds the skill's content to the conversation **when the skill is invoked and doesn't re-read the file on later turns**"——正文是**一次性**注入会话的文本，之后与任何用户消息无异，压缩后只保留开头部分（官方因此要求把最重要的指令放文件头部）。
- **用户显式调用**：`/skill-name`（custom commands 已合并进 skills）同样只是把 skill 文本注入 prompt，不改变语义。

[来源：Extend Claude with skills — https://code.claude.com/docs/en/skills （"skill content lifecycle"、"Skill descriptions are cut short"、"Claude stops following a skill" 各节）]

### 2.2 有没有 skill 执行器/运行时？——没有

Claude Code 对 skill 的全部"执行"支持都是**宿主侧的文本预处理或权限门**，不是 skill 运行时：

| 机制 | 实质 | 归属层 |
| --- | --- | --- |
| `` !`cmd` `` 动态上下文注入 | harness 在渲染时跑一次 shell，把输出**替换进文本**再给模型（"Claude receives actual data, not the command itself"）；失败则整个 skill 调用中止 | 宿主预处理；禁用后占位符原样透传，skill 退化为纯文本 |
| `context: fork` + `agent` | 把 skill 正文作为 prompt 交给一个 subagent——"The subagent receives the skill content as its prompt" | 仍是文本注入，只是注入目标换成隔离子代理 |
| `allowed-tools` | 调用该 skill 的那一 turn 内预批准若干工具，"the grant clears when you send your next message" | 宿主权限策略，不是 skill 能力 |
| `disable-model-invocation` / permission 规则 `Skill(name)` | 控制目录可见性与模型调用权 | 访问控制 |
| `hooks` frontmatter | skill 被调用时注册事件拦截器 | 宿主 hook 系统，与 skill 正文正交 |

官方文档把 Claude Code 扩展字段与标准字段分表列出，并明确：claude.ai/API 上传路径只接受标准的 6 个字段，多余字段直接报错——**标准核不含任何执行语义**。连 `!` 注入在 synced skill / 终端会话中都被禁用或原样透传（"reaches Claude as literal text"）。[来源：同上 skills 页（frontmatter reference、"Using skill frontmatter outside Claude Code"、"Inject dynamic context"、"Run skills in a subagent" 各节）]

## 3. 本机活体标本：omp harness

### 3.1 目录事实

- `~/.omp/agent/managed-skills/`：**726 个** skill，每个是 `<name>/SKILL.md` 单文件（抽查 `bifrost-upgrade-window`、`omp-ttsr-rule-authoring`、`wayfinder-ticket-governance` 均无附属目录）——纯 markdown + frontmatter。
- 富标本 `skill-creator`（claude-plugins-official marketplace 缓存）：`scripts/`（9 个 Python 文件）、`references/schemas.md`、`agents/`（3 个 subagent 定义）、`assets/`、`eval-viewer/`。其 SKILL.md 对脚本的用法是正文里的 bash 命令（如 `python -m scripts.aggregate_benchmark ...`），没有任何自动执行机制——与 §1.4 的规范定位完全一致。
- `~/.omp/agent/skill-descriptions.db`：SQLite 表 `skill_descriptions`，779 行，key 为哈希 → description——**目录（catalog）的缓存**，服务于 system prompt 注入，进一步证明 omp 对 skill 的第一公民操作就是"取 description 拼目录"。

### 3.2 omp 文档对处理方式的陈述

omp 官方文档（`omp://skills.md`，指涉 `packages/coding-agent/src/extensibility/skills.ts` 等实现）：

- 暴露方式三条：system prompt 里的**轻量元数据（name + description）**；按需经 `read` 工具读 `skill://...`；可选 `/skill:<name>` 命令。
- `/skill:<name>` 的实现：读文件、**剥掉 frontmatter**、把正文包上 skill 目录路径后**作为普通消息注入**（"injects it as a custom message"）——与 Claude Code 同构。
- 概念对照表（原文）：skills vs custom tools = "documentation/workflow content loaded through **prompt context** and `read`" vs "executable tool APIs callable by the model with schemas and **runtime side effects**"；skills vs hooks = "**passive content**" vs "event-driven runtime interceptors"。——skill 在 harness 自己的分类里就是被动文本。
- 无任何 skill 执行器：脚本、模板一律靠模型用既有 bash/read 工具按正文指示操作。

### 3.3 `skill://` URI 的语义

`skill://<name>` → 该 skill 的 `SKILL.md`（供 read）；`skill://<name>/<relative-path>` → skill 目录内文件；bash 语境下 `skill://<name>` 解析为 skill **目录**（正文里"resolve the skill's relative paths (scripts, templates) against it"）。安全护栏：拒绝绝对路径、拒绝 `..`、解析结果必须落在 `baseDir` 内。它的作用是**给文本里的相对引用一个可解析的命名空间根**，让"skill 目录"成为模型寻址文件的稳定锚点——本质仍是文件读，不是进程接口。[来源：omp://skills.md "`skill://` URL behavior" 节；路径解析与包装逻辑同]

活体旁证：本会话 system prompt 的 `<skills>` 块列了约 700 条 name + "Use when…" 描述，并指示 "Matching skill → MUST read `skill://<name>` first"——§3.2 三条暴露机制的现场运行态。

## 4. 跨实现对比：开放标准与其它生态

Anthropic 于 2025-12-18 把 Agent Skills 发布为开放标准（agentskills.io），采用方包括 Gemini CLI、Cursor、GitHub Copilot、VS Code、OpenCode、OpenHands、Amp、Letta、Goose、Factory、Spring AI、ChatGPT/Codex、JetBrains Junie 等 30+ 家。[来源：https://agentskills.io/home （client 列表）；https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills （更新注记）]

### 4.1 标准的客户端实现指南 = 最小共同核的白皮书

agentskills.io 的《How to add skills support to your agent》把集成归结为四步，每步都是纯文本操作：

1. **Discover**：扫目录找含 `SKILL.md` 的子目录；每条 skill 记录最少三个字段：`name`、`description`、`location`（SKILL.md 绝对路径）。
2. **Parse**：切 frontmatter；宽松校验——description 缺失才跳过，name 超长等只警告。
3. **Disclose**：把目录放进 system prompt（或注册工具的 description 里），附一段"何时读"的行为指令。
4. **Activate**：两种模式——模型直接用文件读取工具读 SKILL.md（file-read activation，"No special infrastructure needed"），或注册 `activate_skill` 工具返回正文；两者都只是把 markdown 文本送进上下文。

指南明确主张"model-driven activation"：触发判断交给模型读目录自行决定，**不需要** harness 侧的触发引擎或关键词匹配。对无文件系统的云端 agent，指南的替代方案仍是文本通道：API、registry、web UI 上传——"Once skills are available to the agent, the rest of the lifecycle — parsing, disclosure, activation — works the same"。[来源：https://agentskills.io/client-implementation/adding-skills-support ]

### 4.2 OpenAI Codex：同构实现的旁证

Codex 采用同一标准：目录 + `SKILL.md`（name/description 必填）；启动目录 = name + description + 文件路径，**预算上限为上下文窗口的 2%（未知窗口时 8,000 字符）**，超预算先缩短 description、再省略 skill；显式调用 `$skill`，隐式调用靠 description 匹配；选中后"reads the full SKILL.md instructions"。可选 `agents/openai.yaml` 只管 UI 元数据与 `allow_implicit_invocation` 开关。注意 2% 预算这个细节：目录注入是唯一被工程化约束的上下文成本——再次印证"skill 框架管的就是文本注入经济学"。[来源：Build skills — https://learn.chatgpt.com/docs/build-skills ]

### 4.3 最小共同核

跨实现（Anthropic 全家桶、omp、Codex、标准指南）逐项对照，共同点收敛为四件事：

1. 一个带 `name + description` frontmatter 的 markdown 文本包；
2. 目录（name+description）进 system prompt；
3. 模型判断相关后全文加载正文（一次性注入）；
4. 正文引用的附属文件用**模型既有的普通工具**读/执行。

差异全在外围：目录预算策略（Codex 2% vs Claude Code 无硬预算但有 skill-doctor）、名字冲突处理（omp 的 namespace 后缀 vs Claude Code 的位置优先级 vs Codex 的并存）、分发容器（plugin/zip/repo）、权限钩挂（allowed-tools/Skill(name) deny）。**没有一家在 skill 层引入执行器、进程模型或独立 API。**

## 5. 结论：skill 的核抽象（10 行内）

1. **Skill 是什么**：一个带 name+description 索引的 markdown 文本包，按 metadata → body → 链接文件三级 progressive disclosure 注入模型上下文。
2. **Skill 不是什么**：不是运行时、不是进程、没有执行器、没有 API 契约；harness 官方分类里它是 "passive content"，与有 "runtime side effects" 的 tool 正交。
3. **"用"一个 skill = 读完照做**：触发是模型对目录的自我匹配，激活是一次性文本注入，之后它就是会话里的普通指令文本。
4. **scripts/templates 是参考资料**：官方定位是"模型用 bash 跑的文件"，代码不进上下文、只有输出进——执行发生在**模型工具面**，不在 skill 框架。
5. **环境/执行问题确实在另一层**：`compatibility` 字段的存在本身就承认 skill 文本对环境只做**声明**（"Requires git, docker"），满足与否由宿主工具面决定；缺环境时文本退化为文档，不报错、不挂起。
6. **两处精确化**：① harness 侧存在少量文本预处理（Claude Code 的 `!`cmd 渲染期执行、omp 的 frontmatter 剥离/路径包装），但它们是**可禁用的便利层**，禁用后 skill 仍完整成立；② 权限面（allowed-tools、Skill deny 规则）触及执行，但那是宿主策略作用于工具面，不是 skill 机制的一部分。
7. **per-host isolation 在核上的含义**：就是**目录可见性过滤**——官方指南明说对不可用 skill 要"Hide filtered skills entirely from the catalog rather than listing them and blocking at activation time"。host 标签决定哪些 (name, description) 进哪个会话的目录、body 从哪里解析；格式本身没有提供任何隔离边界，也不需要。

## 6. 对 #3 的映射

命题"skill 只是文本注入；环境/执行解耦；per-host isolation 即可"**成立**。推论：

- **边缘侧 skill 系统的最小实现 = 一个带过滤的文本目录服务**：
  - **存储**：`{name, description, body, 附属文件}`——D1 行（name/description/body/标签/版本）+ R2 对象（附属文件），或整体 R2 + D1 索引。779 行 description 缓存（§3.1）就是生产系统里目录表的样子。
  - **服务**：两个读路径——(a) 会话装配时按 host 标签过滤出 catalog 行，拼进 system prompt；(b) 会话中按 `skill://name` 语义取 body/附属文件（返回文本即可，路径解析规则照抄 §3.3）。
  - **不需要发明**：触发引擎（模型自己匹配 description）、执行器（没有这东西可发明）、skill 级沙箱（隔离属于宿主工具面）。
- **`host.exec` 是否进 daemon 工具面与 skill 无关**：#3 里"很多 omp skill 假定能跑 bash"的观察正确，但其正确读法是这些 skill 的正文含有**条件性指令**——工具面有 bash 就执行，没有就当作 runbook 参考文本。skill 框架对此唯一的标准动作是 `compatibility` 声明。因此 `host.exec` 的去留应由 worker agent 的任务需求决定，**不应由 skill 系统倒逼**；skill 系统对工具面的全部假设可以压缩为"会话里有 read 工具"（标准指南对无文件读取能力者的建议也只是换成一个返回文本的激活工具）。
- **暂定心智模型（D1/R2/DO 存储 + host 标签路由）与标准同构**：host 标签 = catalog 可见性过滤器（§5 第 7 行），存储 = 文本包的容器。唯一建议的精确化：把"host 标签路由"明确为**注入侧目录过滤 + 解析侧 baseDir 锚定**两件事，不要引入更强的"隔离"概念——格式层不存在它。

---

**参考来源汇总**：agentskills.io Specification / Adding skills support（https://agentskills.io/specification 、https://agentskills.io/client-implementation/adding-skills-support ）；Anthropic 平台文档 Agent Skills overview（https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview ）；Anthropic 工程博客（https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills ）；Claude Code skills 文档（https://code.claude.com/docs/en/skills ）；OpenAI Build skills（https://learn.chatgpt.com/docs/build-skills ）；omp harness 文档（`omp://skills.md`，本机）；标本文件：`~/.omp/agent/managed-skills/*`（726 个）、`~/.omp/plugins/cache/marketplaces/claude-plugins-official/plugins/skill-creator/`、`~/.omp/agent/skill-descriptions.db`。

> AGENT GENERATED: by zhipu-coding-plan/glm-5.3-flash (research subagent)
