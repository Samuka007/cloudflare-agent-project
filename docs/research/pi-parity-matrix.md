# pi-agent 功能对齐矩阵——启发式需求发现的机制化（#312）

> 状态：**成档 v1**（2026-10-05，lane/312）。W5 起每波开波先刷本矩阵（固定仪式，见 §5）。
> 票：Samuka007/cloudflare-agent-project#312 · 伞 #310 · 兄弟票 #313（DO 压测）/ #314（pi 测试生态移植）。
> 方法：pi 源码直读（浅克隆 `github.com/earendil-works/pi` @ `98d2e1947aa9`，2026-10-05，v1.0.3；行号相对该提交，上游前进后漂移）+ 我方仓锚点复核。pi 侧证据由四条并行读源 lane 产出（coding-agent / agent+ai+protocol+server+client+telemetry / mcp+codemode+env+durable+evals+chord / 我方锚点图），关键结论均有 file:line 锚。

## 0. 血缘定位与判定图例

三源分层（docs/engineering.md:5-13）：**产品形状抄 bb**（bb 是 omp RPC 的宿主编排层，非 pi 后代）；**agent 语义抄 omp**；**omp 是 pi 的后代**（can1357/oh-my-pi fork 自 badlogic/pi-mono，docs/research/compaction-two-source-map.md Provenance；#314：「omp 扩展层逐字重写 @earendil-works/\*」）。故本矩阵的差分对是「pi 全景 ↔ 我栈（bb 形状 × omp 语义）」，凡我栈标「omp 语义」处，血缘上就是 pi 的增强后代。

pi @ HEAD 一处重大结构变化（影响旧档案）：harness 已从 `packages/agent`（pi-agent-core）拆出——`packages/agent/CHANGELOG.md:15` 移除 AgentHarness/session storage/compaction/skills/telemetry schemas；compaction 现居 `packages/coding-agent/src/core/compaction/`（`packages/coding-agent/docs/compaction.md:6-9`）。本仓既有档案引 omp `packages/agent/src/compaction/*`（compaction-two-source-map.md §1）对应的是 omp 侧布局，pi 侧已前移——刷新矩阵时注意两仓目录不再同形。

| 判定 | 含义 |
| --- | --- |
| ✅ 已对齐 | 我栈已有等价物（带票号/锚点）；「同构不同源」注明 |
| 🟡 部分 | 主路径在、子能力缺；差距与归票写明 |
| ❌ 缺失 | 我栈无对应物；给切票建议（§4 汇总） |
| ⚪ 刻意不做/空置 | 有理由的不做：surface 判定法空置、W5 排除、平台缝自裁等 |

---

## 1. 功能全景 × 差分矩阵（52 项）

### A. 会话与轨迹

| # | 功能项 | pi 侧（锚点） | 我方现状 | 判定 |
| --- | --- | --- | --- | --- |
| A1 | 会话持久化（append-only + 条目树） | JSONL session file，首行 header `{type:"session",version,id,cwd,parentSession}`，`CURRENT_SESSION_VERSION=3`；entry 带 `id/parentId` 构成树（coding-agent/src/core/session-manager.ts:41-62） | 每 thread 一个 AgentDO + DO SQLite append-only 事件日志，`(thread_id,seq)` 主键、seq 连续（packages/agent-do/src/event-log.ts:29-37；#5 裁决 docs/ROADMAP.md:25「无快照表、冷启动重放重建」） | ✅ 机制同构（append-only+树/序号）；载体异构（本机 JSONL ↔ 边缘 SQLite） |
| A2 | 会话恢复/切换/列表 | `--continue/-c`、`--resume/-r` 选择器、`--session <path\|id>`（cli/args.ts:111-135） | SPA thread 列表/切换（bb 形状 A2/B1，bb-ux-gap-matrix）+ `events?afterSeq` 补拉与 ws 失效提示（packages/protocol/src/realtime-ws.ts:5-14；change-kinds.ts:170-174） | ✅（bb 形状） |
| A3 | 分支/树导航（/tree /fork /clone + branch summary） | `/tree` 树内移动、`/fork` 从旧 user message 开新会话、`/clone` 复制分支；离开分支可生成 BranchSummaryEntry（docs/sessions.md:22-32；session-manager.ts:106-116） | journal 分支 seam 已备：packages/agent-do/src/tools/session-tree.ts:13-15（注明 rollover/compaction 家族 #79 共享此 cut seam）；SPA 树导航面无（gap matrix D8「fork/per-thread 执行选项按需复活」归 M2） | 🟡 缺 SPA 面（已有归期 M2 桶 D8，不新立） |
| A4 | 会话导出/分享（/export HTML/JSONL；/share gist/Radius） | docs/sessions.md:56-58；session-export.ts:32-41；export-html/ 模板 | 无；ROADMAP 拓扑不变式已裁「分享 = Worker 层签名 token」（docs/ROADMAP.md:32，M3 #16） | ❌ 已有归期 M3，不新立 |
| A5 | 会话元信息面（路径/消息数/token/成本） | `/session` 显示文件路径、ID、消息数、token 用量、成本（docs/sessions.md:16） | thread 头仅有标题/状态；token 面归 #308 | 🟡 挂 #308（数据面同源） |

### B. Compaction（W5 主线；pi 侧算法与我方两源地图逐条对上）

| # | 功能项 | pi 侧（锚点） | 我方现状 | 判定 |
| --- | --- | --- | --- | --- |
| B1 | 手动 compact（可带自定义保留指令） | `/compact`（slash-commands.ts:40；docs/sessions.md:42） | 无。#309：上下文指示内嵌 compact 按钮 + journal 检查点式压缩（#116 replay 语义延续） | ❌ → #309 |
| B2 | 阈值自动 compact | `shouldCompact = contextTokens > contextWindow − reserveTokens`，默认 `reserveTokens:16384, keepRecentTokens:20000`（compaction/compaction.ts:126-130, :267-270）；agent_end 后/下条 prompt 前检查（agent-session.ts:2933-3069） | 无压缩实现（anchor 图 §2 grep 证据：仅 rollover 信号面 tools/edge.ts:120-124）。omp 增强版语义（百分比阈值/方法级联 remote→snapcompact→handoff→shake→soft）见 compaction-two-source-map.md §1——语义正本 | ❌ → #309（压缩语义抄 omp/pi）+ #314（测试场景移植） |
| B3 | overflow 触发（compact-and-retry） | context-overflow 错误/截断响应 → 移除失败消息、compact、重试一次（agent-session.ts:2912-2932, :3026-3031） | 无；我方 relay 直连 Anthropic Messages，超长=400 裸失败 | ❌ **新漏项** → 切票 C1（§4） |
| B4 | 切点/保留语义（summary + keepRecent，绝不切在 tool result 中间） | `findProjectedCutPoint` 从尾回累计，切点限 user/assistant 边界（compaction.ts:430-500, :805-869）；原 session 条目不删（docs/sessions.md:40-41） | #309 落地时按此抄；omp 侧同语义机器化保证（配对不变量/firstKeptEntryId，compaction-two-source-map.md §2.2） | ❌ → #309（验收应含「不切 tool result 对」断言，#313 压测链） |
| B5 | 摘要生成（结构化 prompt + 文件清单 + 重试 choke point） | 固定 `SUMMARIZATION_SYSTEM_PROMPT` + `<read-files>/<modified-files>` XML 清单，TOOL_RESULT_MAX_CHARS=2000 截断（compaction/utils.ts:74-94, :161-163）；compaction 与 branch summary 共用 `completeSummarization` 重试（compaction.ts:613-638） | 无；#309 数据面同源。omp CompactionEntry（summary/shortSummary/firstKeptEntryId/tokensBefore/After/method/preserveData）是记录形状正本（compaction-two-source-map.md §2.1） | ❌ → #309 |
| B6 | compaction 钩子（before_compact 可取消/自定义 summary） | `session_before_compact`/`session_compact(_failed)`（agent-session.ts:3110-3128；extensions/types.ts:764-792） | 无扩展系统（⚪ 见 K2）；「压缩前 HITL 准入门」是两源共同残差（compaction-two-source-map.md Part 5.3，#75 未决） | ⚪ 残差归 #75 裁决，不切票 |

### C. 上下文管理

| # | 功能项 | pi 侧（锚点） | 我方现状 | 判定 |
| --- | --- | --- | --- | --- |
| C1 | token 计数（usage 优先、估算 fallback、图像计价） | provider `usage.totalTokens` 优先，否则 input+output+cacheRead+cacheWrite；无 usage 时 chars/4 启发式，图像按 4800 chars（compaction.ts:140-142, :196-298） | 无任何 token 计数（anchor 图 §2 grep 证据） | ❌ → #308（三选一判据：journal 累计/模型用量回执/估算——pi 的「usage 优先+估算 fallback」即判据蓝本） |
| C2 | 上下文用量指示 | footer 常显当前 context 用量（docs/sessions.md:38-40；footer-data-provider.ts） | 无；#308 = 线程级百分比（数据面+投影+SPA） | ❌ → #308 |
| C3 | system prompt 分节组装 + 缓存前缀设计 | `buildSystemPromptSections`：preamble→tools→rules→docs→addendum→project_context→skills→cwd→自定义（system-prompt.ts:127-192） | daemon 侧由 omp runtime 承担（语义正本 omp system-prompt.ts:631-1050，缓存前缀=产品设计，omp-engine-portability.md §1.8）；edge 侧 relay 单 provider 无自组提示 | ✅（语义抄 omp，经 daemon 运行时） |
| C4 | context files 发现（AGENTS.md/CLAUDE.md 族，祖先目录上溯） | `AGENTS.override.md → AGENTS.md → … → CLAUDE.MD`，先全局 agentDir 再 cwd 祖先链（resource-loader.ts:184-269） | 宿主侧同由 omp runtime 装配；thread 的 workspace 绑定喂值链 #288（thread-binding.ts）决定 cwd | ✅（经 omp runtime + #288 绑定） |
| C5 | thinking 级别切换与持久化 | `/thinking <level>`；级别变化落 ThinkingLevelChangeEntry；`thinkingLevelMap` 模型映射（slash-commands.ts:23；session-manager.ts:69-72；model-config.ts:205） | thinking budget 仅部署 env 级（harness.ts，apps/provider-app/src/harness.ts:1-47）；无 per-thread 切换 | 🟡 挂 #305（flags 层：per-thread thinking budget/级别属 thread 选项层，control-plane-layer.md 四层链第 4 层） |

### D. Approval / 权限

| # | 功能项 | pi 侧（锚点） | 我方现状 | 判定 |
| --- | --- | --- | --- | --- |
| D1 | per-tool 审批弹窗 | **pi 刻意不做**（无 per-tool 确认、无 yolo flag；README「Permissions & Containerization」节：外置容器化） | 同立场不做：host-path.ts:21-23「no per-tool approval UI: the exec-tier grant is the TARGET HOST's permission ceiling」 | ✅ 立场一致（双方均外置） |
| D2 | 权限替代机制 | 项目信任门 trust.json（trust-manager.ts:210-246）+ 工具级 gating 走扩展 `tool_call {block:true}`（extensions/types.ts:1415-1418） | exec 档 ceiling（hosts.max_permission_mode，agent-do.ts:2292-2336 fail-closed）+ journal 审计（tool.dispatch/result，fsm-events.ts:135-143） | ✅ 同构不同源（信任门→宿主 ceiling；扩展 block→exec 档） |
| D3 | 审批交互通道（人审问询） | 无内建 ask；扩展可自造 | ask 工具 + pending-interactions 面（packages/agent-do/src/tools/ask.ts；protocol/src/pending-interactions.ts）；两枚 P0 缺陷在账：#225（ask 不弹前端）、#226（调用中无弹窗时无法取消） | 🟡 机制在，P0 未关（#225/#226） |
| D4 | 工具 allowlist/denylist | `--tools/-t`、`--exclude-tools/-xt`、`--no-builtin-tools`（args.ts:313-317；agent-session.ts:270-273） | 注册表编译期固定（registry.ts:4-11）；无运行时 per-thread allowlist | 🟡 差距记录，不独立切票（并入 #305 thread 选项层讨论） |

### E. 工具面

| # | 功能项 | pi 侧（锚点） | 我方现状 | 判定 |
| --- | --- | --- | --- | --- |
| E1 | 内置工具集 | 8 个：read/bash/powershell/edit/write/grep/find/ls（tools/index.ts:95-105）；默认 prompt 只声明 read/bash/edit/write（system-prompt.ts:64） | omp 33 工具面为正本：essential 12 关账口径（#103）+ discoverable；注册表 15 host/11 edge/7 hybrid（registry.ts:24-32；m15-ticket-set.md） | ✅（目标集是 omp 33 面 ⊃ pi 8 面） |
| E2 | 工具批并行执行 + 同文件互斥 | 默认 parallel，`executionMode:"sequential"` 任一存在则整批串行（agent/agent-loop.ts:516-522）；file-mutation-queue 同文件写互斥（tools/file-mutation-queue.ts） | daemon 派发面=单流串行命令队列（daemon-service client/connection.ts:219-236）；DO 侧无批内并行调度语义、无同文件互斥对应物 | 🟡 **新漏项** → 切票 C3（§4） |
| E3 | 工具事件面（start/update/end + 渲染器） | `tool_execution_start/update/end`（extensions/types.ts:1056-1083）；按工具 TUI 渲染器（tools/renderers/） | journal→ux envelope 纯函数投影（ux-projection.ts:22）+ SPA tool 行（bb 形状） | ✅ |
| E4 | 工具产出截断/续传 | read DEFAULT_MAX_BYTES/LINES（index.ts:64-73）；bash 输出截断 truncate.ts | omp OutputSink 50KiB spill → `artifact://<id>` + daemon 环形缓冲 `exec.resume{ackedOffset}` 显式缺口（tool-retry-idempotency-matrix.md §6） | ✅（omp 形状） |
| E5 | codemode（沙箱 JS 编排，嵌套调用不进上下文） | 独立包 pi/codemode：QuickJS(WASM) VM，仅可调注入 tools；扩展版嵌套调用仍走完整 pipeline（extensions/codemode/tool.ts:8-10） | 对齐物=eval 工具（omp kernel vendor，M1.5 T10'）；codemode 形态无 | ⚪ 阶段性：eval kernel 覆盖同需求域；pi/codemode 零依赖可直接搬（§3 排名 2），future 备选 |
| E6 | MCP | 独立包 pi/mcp：stdio + Streamable HTTP 传输、OAuth(PKCE/动态注册/refresh 合并)、`mcp.json`（global+trusted project 覆盖）、`mcp__<server>__<tool>` 命名空间、conformance 测试套件（mcp/README.md:118-136；coding-agent/src/extensions/mcp/index.ts:8；test/mcp-conformance/） | 全仓无 MCP（anchor 图 §9 grep 零命中） | ❌ **新漏项** → 切票 C2（§4；伞票「除 skill 外一切常见 agent 功能」应收编） |

### F. 子代理

| # | 功能项 | pi 侧（锚点） | 我方现状 | 判定 |
| --- | --- | --- | --- | --- |
| F1 | 子代理/task | **pi 核心刻意不做**（README:19「skips features like sub-agents and plan mode」）；仅 experimental/durable 有 `subagent` tool（experimental/durable/subagent.ts:24-31） | 超越 pi：task.* journal 家族 + 委派行投影 #275 + parentToolCallId #274 + 子代活动回父 #276（omp task 语义移植，omp-task-semantics.md） | ✅（按 omp 有，pi 无） |
| F2 | 子代理生命周期/取消/预算 | durable Subagent 仅基础派发（README.md:413-458） | 四态 lifecycle + 三级取消 + spawn/settle/aborted journal 语义（omp-task-semantics.md §5）；预算/墙钟面随 M1 fleet（#14） | ✅（预算深化归 M1，不新立） |

### G. Provider 面

| # | 功能项 | pi 侧（锚点） | 我方现状 | 判定 |
| --- | --- | --- | --- | --- |
| G1 | 多 provider 统一 API | pi-ai：42 KnownProvider / 10 KnownApi，每 provider 一工厂（ai/types.ts:39-81, :17-27；providers/all.ts） | 单 provider relay（Anthropic Messages 中继，relay/wire.ts + sse.ts）；execution-options 静态目录（routes/system.ts:87-111） | ❌ 有意收窄 → #305（路线图） |
| G2 | OAuth 订阅流 | 9 provider OAuth（anthropic/openai-codex/openai/github-copilot/kimi-coding/meta/openrouter/radius/xai；providers/*.ts；auth/oauth/pkce.ts 等） | 无；Workers 侧 OAuth 回调形态待裁 | ❌ → #305（特殊 auth 线） |
| G3 | 模型元数据 schema（contextWindow/maxTokens/reasoning/input/cost tiers） | `BaseModel/Model` 全字段 + `ModelCost` 分层计价（ai/types.ts:1099-1146, :1058-1073）；models.dev 目录 v6 | MODEL_RELAY_MODEL 单值，无模型目录；capabilities 是公开数据非秘密（#305 背景语） | ❌ → #305 |
| G4 | usage/成本计量回执 | `Usage{input,output,cacheRead,cacheWrite,reasoning,cost}` + `calculateCost()`（ai/types.ts:429-450；models.ts:1198-1218） | journal 有 model.* 事件族；usage 未投影为用户可见面（anchor 图 §2 grep 无 token 计数） | 🟡 → #308（数据面选「模型用量回执」即此行的消费） |
| G5 | 供应商错误重试政策 | `RetryPolicy{maxRetries:3, baseDelayMs:2000, maxAgentDelayMs:60000}` 指数退避（ai/utils/retry.ts:114-194；durable/docs/spec.md:413）；无 fallback 链 | omp relay 侧有（500ms×2^n、10 次、8s/300s 帽，tool-retry 附录）；AgentDO relay 侧重试/中断政策=决策票 #24/#25（M1 规划） | 🟡（#24/#25 落地后转 ✅） |
| G6 | idle provider session release | pi 无此名；最近似=durable 每 conversation 持久 UUIDv7 provider session id（prompt-cache/session affinity，durable/README.md:113）+ AgentDO 的 DO 驱逐 | 已裁（#306 设计文档 idle-provider-session-release.md）：bb 释放的是宿主 CLI 子进程，我方 provider=无状态 relay 无可释放对象；Agent DO 内存释放=平台 hibernation/eviction（eligible 即停表），恢复=journal 冷启动重放（t19/t26 已测）。不移植 reaper；立 hibernation-eligibility 审计不变量 + 宿主残留物台账（eval kernel 无 idle 释放是唯一台账项） | ✅（按本仓裁决承接；重开触发器见文档 §3.3） |
| G7 | provider 配置面分层（正本 vs 投影） | auth.json（api_key 含 $ENV/`!command` 插值）+ models.json 热重载（auth-storage.ts:232-266；model-config.ts:202-247） | **倒查改判（#362，2026-10-06 用户裁决，撤 #255/#266 env-only 形状）**：用户面正本=D1 `provider_configs`（CRUD API `/api/v1/system/providers` + Settings→Providers→Configured 面板写路径；apiKey AES-GCM 加密落库 `PROVIDER_CONFIG_MASTER_KEY`；坏行 skip-with-warning 永不静默删；变更热生效走 overlay 指纹门，无重部署——pi models.json 热重载的对应物）；env `MODEL_RELAY_*` 降级为部署 seed（同 id D1 整行覆盖）。pi models.json 用户面字段全集（provider 级 baseUrl/apiKey + 模型级字段，model-config.ts:202-247）已按 #350 zod 词典落成面板行编辑座位 | ✅（#362 落地；pi-parity G7 断点补上） |

### H. 遥测

| # | 功能项 | pi 侧（锚点） | 我方现状 | 判定 |
| --- | --- | --- | --- | --- |
| H1 | 运行时遥测 | **pi 不做运行时上报**：仅安装统计（PI_TELEMETRY，core/telemetry.ts:8-13）+ 本地 crash-log + `/bug` 打包（bug-report.ts:98-121 凭据 redact） | 无 Langfuse/OTel hook（grep 零命中）；可观测性=结构化日志三元组 + journal replay（engineering.md 实践 6） | ✅ 立场一致（双侧均极简）；若未来要 span 面，pi/telemetry 契约包零依赖可直搬（§3 排名 3） |

### I. 键位 / TUI / SPA 呈现

| # | 功能项 | pi 侧（锚点） | 我方现状 | 判定 |
| --- | --- | --- | --- | --- |
| I1 | 键位系统 | keybindings.json 命名 action（docs/keybindings.md:3-32；core/keybindings.ts）；/hotkeys | bb SPA keybinding app 单行 PUT 已移植（gap matrix A5/E1） | ✅（形状=bb SPA） |
| I2 | 主题 | system/dark/light + 自定义 JSON 热重载（docs/themes.md:3-68） | appearance PUT + theme sync（F4 ✅） | ✅ |
| I3 | 流式呈现 | TUI renderer/chat-viewport 流式渲染 | bb SPA 流式投影（F2 ✅；streaming-contract.md §4/§6） | ✅ |
| I4 | markdown/mermaid 渲染 | markdown-transform.ts + mermaid.ts | bb SPA 上游资产逐字（含 vendor marked/highlight） | ✅ |
| I5 | CoT 呈现 | thinking blocks + `/thinking` + thinking_level_select 事件（§C5 锚）；TUI 内嵌 | ux `item/reasoning/textDelta` 已闭环（#257），终局行/可展开=上游 #3250 移植 | 🟡 → #303（J6 档 2） |

### J. 自动化 / 分发面

| # | 功能项 | pi 侧（锚点） | 我方现状 | 判定 |
| --- | --- | --- | --- | --- |
| J1 | headless 自动化（print/json/RPC/SDK 四模式） | `--print/-p`、`--mode text\|json\|rpc`、RpcClient、进程内 SDK（args.ts:98-175；docs/rpc.md:1-95；sdk.ts:47-188） | 无 agent RPC/CLI 自动化面；唯一 RPC=内部 server↔DO seam（agent-do.ts:429-537）；M3 已立前置（#51 队列语义 → #16 自动化面） | ❌ 已有归期 M3（#51/#16），不新立；届时 pi RPC 帧契约（JSONL/id 关联/优雅关停）与 omp RPC 合同（omp-engine-portability.md §2）同为对照物 |
| J2 | 包分发（npm/git/URL/本地四源，版本 pin，trust 门） | package-manager.ts + package-manager-cli.ts（docs/packages.md:9-38） | ⚪ 无扩展系统；对应物=bb 插件面 M3 裁剪空态（A8/A10） | ⚪（M3 随插件面回评） |

### K. 扩展 / Skills / 模板

| # | 功能项 | pi 侧（锚点） | 我方现状 | 判定 |
| --- | --- | --- | --- | --- |
| K1 | 扩展系统（30+ 事件钩子 × registerTool/Command/Provider/Renderer） | extensions/types.ts:1558-1685 全 API 面；jiti loader；扩展状态可持久化进 session custom entry（session-manager.ts:118-127） | 无（omp 扩展层是 omp 自己的重写面，我栈不内嵌扩展运行时；宿主工具经 daemon embed omp runtime 而非扩展机制） | ⚪ 刻意不做（平台缝自裁：Workers 侧无可装载代码面；对应物=bb 插件 M3） |
| K2 | Skills | SKILL.md（name/description/disable-model-invocation，core/skills.ts:67-341）；system prompt 目录注入 + 模型自读文件激活（skills.ts:358-375）；无独立 Skill 工具 | **W5 显式排除**（AGENTS.md:4 伞票措辞）；manage_skill 工具行已列（m15-ticket-set.md T6）；只读发现面已有（projects.ts:404-442）；语义研究=agent-skills-core.md（skill=纯文本注入，无执行器） | ⚪ 刻意不做（本波排除；回归归期 M2 随 19G 语料迁移 #15） |
| K3 | Prompt 模板/slash 命令（$@ 参数替换） | prompts/*.md → slash 命令 + `${1:-default}` 替换（docs/prompt-templates.md:42-59） | 无；bb SPA composer 无此入口 | ⚪ 空置（surface 判定法 ①：web 形态无调用面，路由缺失即正确；M3 后随需求回评） |

### L. 执行环境 / 持久运行时

| # | 功能项 | pi 侧（锚点） | 我方现状 | 判定 |
| --- | --- | --- | --- | --- |
| L1 | 图片支持（用户发图） | `@file` 图片 MIME 识别 + autoResizeImages + 剪贴板粘贴 + EXIF 修正（cli/file-processor.ts:24-88；utils/clipboard-image.ts）；模型 `input:["text","image"]` 能力声明；compaction 序列化保留图像块（compaction.ts:278-292） | 无（从未立票直至 #304） | ❌ → #304（用户发图线） |
| L2 | 图片生成（agent 产图） | pi 无产图工具（image api 仅 provider 侧类型，provider-composer.ts:291-292） | 无 | ❌ → #304（产图线；omp 侧有 generate_image 设备可对照） |
| L2b | cloud-only fs 载体 | pi 假设宿主 fs（工具直读 fs）；**pi-env**=SSH 远程 ExecutionEnv（Rust daemon 帧协议 + 语义对照文档 docs/semantics.md，env/docs/protocol.md:12-26）——「执行体在远端、harness 在本地」与我们 daemon 缝同构 | #307 研究票（Cloudflare Artifacts 作 fs）；pi-env 的 ExecutionEnv 抽象与语义对照法是 #307 的现成先例输入 | ❌ → #307（引用 pi/env 先例） |
| L3 | durable 运行时（先落盘再展示、resume、submission 幂等、task graph） | pi-durable：Harness/Conversation/Commit/Document/Task 概念模型（durable/README.md:78-122）；`harness.resume()`；幂等 requestId 去重（README.md:115-122） | AgentDO journal-first + FSM + executionId 全链幂等（engineering.md 实践 5/8；tool-retry §6）——同构且更早落地 | ✅ 同构不同源 |
| L4 | chord 组合运行时（replicated state/services/plugins） | 零依赖通用运行时（chord/README.md:3-7）；pi RPC 新栈（protocol v8 CBOR + server/client）构建其上 | 不需要：DO+hub 是平台原生 replicated runtime（平台缝自裁） | ⚪（但注意：pi 的 RPC 面已从 omp 式 JSONL 分叉为 chord+CBOR——RPC 语义对照时 pi 新栈≠omp 上游形状，见 §3 附注） |
| L5 | 测试生态（compaction/session 场景族） | coding-agent ~200 test 文件；compaction 族 11 个 + session 族（fixtures before-compaction.jsonl 2.3MB/large-session.jsonl 951KB）；根 test.sh 无 API key 全套跑（test.sh:39-79） | 我方三层 vitest（L1 CF plugin）；pi 场景移植进行中 | ❌ → #314（首批 ≥5 场景进我方套件）+ #313（DO 压测链） |

**计数**：52 项（A5+B6+C5+D4+E6+F2+G7+H1+I5+J2+K3+L6）；✅ 18 · 🟡 9 · ❌ 18（其中 14 项已有在账票、2 项已有归期不新立、2 项新漏项 B3/E6）· ⚪ 7（另有 1 项 🟡 带新切票：E2）。每项均有 pi 侧锚 + 我方锚或切票。

---

## 2. W5 首批八票对进矩阵

| 票 | 矩阵行 | pi 侧对应物 | 对进备注 |
| --- | --- | --- | --- |
| #302 Add project Route not found | —（bb 形状面，pi 无直接对应） | E1（pi `ls` 工具=宿主目录列举的同族语义） | 矩阵不收 bb-shape bug 票；daemon 列目录实现可参考 pi tools/ls.ts 的列表/权限过滤形状 |
| #303 CoT 界面呈现 | I5 | thinking blocks/TUI 内嵌（core/defaults.ts:3-7；thinking-selector） | pi 的「thinking 级别持久化进 session」（C5）在我方对应 #305 flags；#303 只移植呈现行（上游 #3250），与 #257 activeThinking 合并语义见 cot-subagent-spa-surface.md J6 |
| #304 图片支持差距盘点 | L1+L2 | `@file`/剪贴板/resize/能力声明/compaction 保留（file-processor.ts:24-88 等） | pi 侧锚可直接进 #304 差距清单；pi 无产图线——产图对照物是 omp generate_image 设备（本会话工具面活体） |
| #305 provider 字段路线图 | G1+G2+G3+C5+D4 | pi-ai 42 provider/10 api、OAuth 9 家、Model 元数据 schema（ai/types.ts:39-81, :1099-1146） | pi 的 models.json 用户面（provider级 baseUrl/apiKey/oauth + 模型级字段，model-config.ts:202-247）是 #305 分层建议的现成字段全集；正本问题已由 #362 改判（D1 `provider_configs` 用户面，env 降级 seed——G7 倒查注记），#305 剩余=多 provider 工厂/ OAuth 订阅流（#349）与字段面继续延伸 |
| #306 Idle provider session release | G6 | durable provider session affinity（durable/README.md:113）+ AgentDO 驱逐语义 | pi 无同名 feature；考古对象是 bb 上游 + 我方 DO；durable 的 session-affinity 持久化可作恢复语义参照 |
| #307 cloud-only fs 载体 | L2b | pi-env 远程 ExecutionEnv（Rust daemon + semantics.md 语义对照） | #307 应引 pi/env 为先例：执行体远端化 + 语义等价对照文档的写法 |
| #308 上下文长度指示 | C1+C2+A5+G4 | footer 用量指示（footer-data-provider.ts）+ calculateContextTokens（compaction.ts:140-298） | pi 的「usage 优先/估算 fallback/图像 4800 chars」即 #308 数据面三选一的判据蓝本 |
| #309 compact 按钮集成 | B1+B2+B4+B5 | /compact（slash-commands.ts:40）+ shouldCompact（compaction.ts:267-270）+ findProjectedCutPoint（:430-500） | 压缩语义抄 omp/pi（omp 方法级联见 compaction-two-source-map.md §1.3）；验收断言「不切 tool result 对」；与 #313（压测链）、#314（场景移植）三角互补 |

八票全部有矩阵落位；无「票在账而矩阵无行」的悬空。

---

## 3. 血缘清单：omp 重写 @earendil-works/\* 的兼容层——哪些资产可直接搬

omp（can1357/oh-my-pi）fork 自 pi-mono，包名同形（`@oh-my-pi/pi-*` ↔ `@earendil-works/pi-*`），omp 在 fork 上大幅前进（steer/aside/live-steering、task 子代理、五方法 compaction、RPC 增强等，omp-engine-portability.md §1）。我栈消费 omp 的已实证通道=daemon 侧 host-runtime embed（omp-runtime-embedding.md：五工具经 omp `execute()` 跑通、123 LoC adapter、Bun 运行时裁决）。

### 3.1 包级血缘对照

| pi 包 | omp 对应物 | 分叉状态 | 我方消费 | 可直搬性 |
| --- | --- | --- | --- | --- |
| pi-agent (core) | @oh-my-pi/pi-agent-core | omp 大幅前进；**pi @HEAD 反向把 harness/compaction 拆去 coding-agent**（agent/CHANGELOG.md:15） | 语义经 journal/FSM 抄写 omp；loop 不直引 | 以 omp 为准，pi 侧不搬 |
| pi-ai | @oh-my-pi/pi-ai | omp 增强版 | relay 只用 Anthropic Messages 形状（relay/wire.ts） | 字段 schema 参考（#305），代码不搬 |
| pi-coding-agent | @oh-my-pi/pi-coding-agent | omp 同名包=我方 embed 对象 | **已整嵌**（omp-runtime-embedding.md Q1-Q5） | ✅ 已落地（经 omp） |
| pi-natives | omp 同名推进 | 版本快进（checkout 陈旧坑，embed §2） | 宿主工具引擎（glob/grep/edit/ast） | ✅ 版本钉死纪律下可用 |
| pi-tui | omp pi-tui | TUI 形状 | 不消费（SPA 形状源=bb） | — |
| pi-protocol/server/client + chord | **omp 无对应**（omp 仍是 pi-wire JSONL 单包，omp-engine-portability.md §1.1） | pi @HEAD 把 RPC 拆成 chord+CBOR 新栈（PROTOCOL_VERSION 8） | 无 | ⚠️ 分叉警示：RPC 语义对照正本是 omp `--mode rpc`，不是 pi 新栈 |
| pi-mcp | omp 无独立包（omp 经扩展层接 MCP） | — | 无 | ✅ 零 pi 依赖可直搬（下方排名 1） |
| pi-codemode | omp 无（omp 用 eval kernel） | — | 无 | ✅ 零依赖（排名 2） |
| pi-telemetry | omp 无独立契约包 | — | 无 | ✅ 零依赖（排名 3） |
| pi-durable | omp 无（omp session JSONL 自带持久） | — | journal-first 语义已同构 | 设计参考级（排名 4） |
| pi-env | omp 无 | — | daemon 缝同构先例 | 文档级参考（排名 6） |
| pi-evals | omp 无 | — | 无 | 方法论参考（排名 5） |

### 3.2 可直接搬资产排名（对另一 TS agent 栈的可移植价值；四 lane 调研汇裁）

1. **pi/mcp**：deps 仅 `cross-spawn`（mcp/package.json:53-55），自带 OAuth(PKCE/动态注册/refresh)、stdio+Streamable HTTP+in-memory 三传输、conformance 测试套件（test/mcp-conformance/）。接任何 AgentTool 抽象 ~30 行；**切票 C2 的首选底座**（edge 侧走 streamable-http=fetch 可行；daemon 侧 stdio 需进程语义）。
2. **pi/codemode**：deps 仅 `quickjs-wasi`；QuickJS 沙箱（interrupt flag/heap cap/store/TS declarations 渲染）成熟自足（codemode/README.md:47-184）。future eval/codemode 形态备选。
3. **pi/telemetry**：零 workspace 依赖的 span 契约 + schema 类型化校验 + conformance 框架（telemetry/src/index.ts:14-357）。未来可观测面选型时的现成契约层。
4. **pi/durable 的 storage facade + compaction task**（src/storage/*、src/harness/compaction.ts）：设计文档级参考（storage 三后端 facade、compaction 作为 durable task 用 pi-ai 的 token 估算/重试）；代码与 chord/pi-ai 耦合，只抄设计。
5. **pi/evals 的 docs-lift 方法**（docker 双臂 without_docs vs with_docs 对照 + StructuredOutputJudge，evals/README.md:7-18, :113-127）：我方未来对 relay/provider 文档做行为评测的方法论蓝本。
6. **pi/env 的语义对照法**（env/docs/semantics.md「RemoteExecutionEnv 与本地 NodeExecutionEnv 语义等价」+ 16MiB 帧协议 protocol.md:12-26）：#307 cloud-only fs 与 daemon 缝论证的文档先例。
7. **pi 测试生态**（compaction 族 11 测试 + session 族 + 2.3MB/951KB fixtures；根 test.sh 无 API key hermetic 跑法）：#314 的移植正本。

---

## 4. 漏项与切票建议（发现漏项即补票；票由 PM/用户裁决入板）

| # | 建议标题 | 依据行 | 依据锚 | 建议标签 |
| --- | --- | --- | --- | --- |
| C1 | overflow 触发的 compact-and-retry（一次）——#309 的失败路径延伸 | B3 | pi agent-session.ts:2912-2932（移除失败消息→compact→重试一次） | type:implementation, block:agent-harness；依赖 #309 |
| C2 | MCP client 接入——pi/mcp 直搬评估（edge streamable-http 先行，daemon stdio 评估） | E6 | pi/mcp 零依赖包（§3.2 排名 1）；我方 grep 零命中 | type:research→implementation, block:agent-harness |
| C3 | 工具批并行调度与同文件互斥语义（file-mutation-queue 对应物） | E2 | pi agent-loop.ts:516-522 + tools/file-mutation-queue.ts；我方 daemon 单流串行（client/connection.ts:219-236） | type:design, block:agent-harness |

已有归期不新立：A3（M2 桶 D8）、A4（M3 #16）、J1（M3 #51/#16）。残差不切票：B6（#75 HITL 残差）。

---

## 5. 维护仪式：每波开波先刷（W5 起固定）

开波 checklist（PM 或 research lane 执行，产出追记本档版本行）：

1. **pi 前进 delta**：重浅克隆（或 `git fetch`）+ 扫 `CHANGELOG.md`（root + packages/coding-agent）自上次锚 `98d2e1947aa9` 起的新条目；新 feature 进矩阵新行或改判定。
2. **判定防漂移**：✅ 行抽点（我方锚点仍指向在账代码；上游 bb pin 前移可能翻转 ⚪/🟡）。
3. **切票列复核**：§4 表逐行问「该切了吗」；新漏项即补票，已切票的行把票号回填矩阵行。
4. **在账票回填**：上一波关账票在本档的行（如 #308/#309/#303/#304）由 ❌/🟡 翻 ✅ 并带 commit 锚。

版本历史：
- v1（2026-10-05，#312 初档）：45 项基线，pi 锚 `98d2e1947aa9`（v1.0.3），W5 八票 #302-#309 对进。
