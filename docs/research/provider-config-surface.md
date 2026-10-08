# provider 配置面考古与形态建议：bb 插件面板 vs 独立 webpage vs 分层（#255）

> 状态：**事实清单 + 建议**（2026-10-05，lane/255）。回答 #255：agent 的 provider 配置（LLM 通道/web_search 引擎/未来 judge/security 模型等）以什么形态暴露给用户。bb 考古基于本仓 submodule pin `dc2778d0`（检读自本地 `ba4265453` checkout；两 pin 在 provider 相关路径 diff 零漂移，仅 pending-interaction 族 8 文件，`git diff ba4265453 dc2778d0 --stat` 验证 2026-10-05）。凡未经工具验证的推断标注 `[INFERENCE]`。

## 0. 结论（建议先行，裁决待用户）

**建议采纳「两者分层（读写分离）」；否决独立配置 webpage；bb 插件面板不承载 provider 配置正本。**

| 层                 | 承载物               | 内容                                                                                   | 形态                                                                 |
| ------------------ | -------------------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| 写路径（配置正本） | 部署 env（现状不变） | LLM 通道三键、web_search 引擎链、judge/security 模型 pin、实验闸                       | Worker vars/secrets + daemon env；编辑=重部署/daemon 重启            |
| 读路径（用户所见） | bb SPA 设置面一节    | provider 状态投影：relay 模式/模型/密钥存在性、web_search 链与引擎凭据门、来源指针文案 | 只读投影端点 + 只读 settings 节；零 PUT、零秘密值出 env              |
| 插件面板           | 不承载正本           | M3（#16）后仅承载**非秘密偏好**（如 per-project 默认引擎序）                           | bb settings 非 secret 分支                                           |
| 独立 webpage       | 否决                 | —                                                                                      | 若未来需要 ops 富面板，做进现有 U1 worker 的只读路由，不建新部署单元 |

三条硬约束支撑（§4 详）：①控制面层 §3.2 已裁「模型/中转/思考配置=部署 env，不进 app_settings；秘密与部署拓扑不落控制面 DB」；②bb 上游先例同构——provider 凭据从不进 bb 自己的 UI（CLI 自管 OAuth/登录，custom provider 走 config.json+refresh，插件 secret 走 0600 文件永不落 db/前端）；③插件 inventory 在本 port 是 M3 裁剪空态，插件 settings 的 secret 分支是宿主 fs 形状（0600 文件），Workers 侧无对应物。

## 1. 问题定义

三个候选形态：

- **A. bb 插件体系内面板**：provider 配置做成一个 bb 插件，用插件 settings/面板（`plugins/:id/settings` GET/PUT + 插件设置节/面板路由）承载。
- **B. 独立配置 webpage**：bb SPA 之外单独一个配置站点/应用（独立路由、独立部署单元）。
- **C. 两者分层**：配置正本与用户可见面分离——正本留部署面，UI 只做投影/选择；插件面板与独立页面都不是正本居所。

评估维度：秘密边界（值是否进控制面 DB/前端）、配置的信任域归属（edge worker vs 宿主 daemon）、可用时点（是否被 M3 插件面阻塞）、部署单元成本、与既有裁决一致性、与 bb 上游先例一致性。

## 2. bb fork 既有 provider 配置面考古（pin `dc2778d0`）

### 2.1 「provider」在 bb 里是什么

bb 的 provider = 驱动 thread 的 **agent CLI 后端**，不是 API key 通道：内建目录 `codex / claude-code / pi / acp-cursor`（`bb/packages/agent-providers/src/catalog.ts:10-15`），加已安装/自定义 ACP agent（`acp-<slug>`，`bb/apps/server/src/services/system/execution-options.ts:104-121`）。provider 的认证由 CLI 自身管理（各自 OAuth/登录态），bb 只消费其状态：认证/套餐标签进 onboarding/用量面（bb `services/system/onboarding.ts:161-165`；port 侧同名 schema `apps/server-worker/src/contract/api/system.ts:123-131`）。

### 2.2 配置正本全部在 UI 之外

| 配置                                           | 正本位置                                                                                                                                                          | 证据                                                                                                                                                             |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 自定义 ACP agent / 自定义模型                  | data-dir `config.json` 的 `customAcpAgents`/`customModels`；无 set/unset CLI，「edit the JSON and run `bb-app config refresh`」                                   | `bb/apps/server/src/services/system/builtin-skills/bb-cli/SKILL.md:320-324`；`bb-app-managed-config.ts:104-108`                                                  |
| 服务端辅助推理（标题/commit message/语音转写） | 配置键 `BB_INFERENCE`/`BB_INFERENCE_FALLBACK`/`BB_TRANSCRIPTION`（managed config，可热更）+ `OPENAI_API_KEY` env；或委派宿主 daemon（`codex.inference.complete`） | `bb/apps/server/src/start-server.ts:79-87`；`bb-app-managed-config.ts:111-124`；`services/ai/voice-transcription.ts:177-188`；`services/ai/inference.ts:275-281` |
| provider 认证                                  | CLI 自管（bb 不存凭据）；bb 只读状态：`connected/unauthenticated/expired/not_installed`、plan label、用量                                                         | `contract/api/system.ts` onboardingAgentSchema:127-131；`services/system/onboarding.ts:161-165`                                                                  |
| agent 请求的秘密                               | Secrets 插件：agent 带 purpose+fields 发起请求 → 用户填值 → 写入目标 dotenv 文件（单行、16KB 帽）                                                                 | `bb/plugins/secrets/src/contracts.ts:5-31`                                                                                                                       |
| 运行时热更                                     | `bb-app config`/`bb-app env` 重载运行时设置（startup-only 子集除外）；`POST /system/config/reload`                                                                | `bb-cli/SKILL.md:63-67`                                                                                                                                          |

### 2.3 UI 暴露了什么：状态与开关，不是凭据

- `/settings/providers/:providerId`（codex/claude-code 专属页）只有三组开关：memory、禁 provider 原生子 agent、（claude-code）禁 Workflow tool——无任何 key 输入（`bb/apps/app/src/views/SettingsView.tsx:962-1034`）。
- provider 目录/模型目录来自 `GET /system/execution-options`，由宿主上安装的 agent 探测组装（`execution-options.ts:395-491` 区段；`listConfiguredSystemProviderInfos` :104-121）。
- 机器级 provider CLI 状态走 `GET /hosts/:id/provider-cli-status`（gap matrix A6/E8 引用面）。
- 用量/认证状态（UsageLimits，含「Signed out, expired, uninstalled」态）是只读展示（`UsageLimitsSettingsSection.stories.tsx:201-204`）。

**考古结论**：即使在插件生态最完整的上游 bb，「provider 配置」的 UI 面也只做**状态展示 + 行为开关**；凭据与 provider 目录正本分别在 CLI 自身、config.json 与 env 里，从不进 bb 的 web 存储或前端。

### 2.4 插件体系设置面（选项 A 的承载物）的真实形状

- 插件用 `bb.settings.define` 声明设置；`secret: true` 字段**写 0600 文件，永不进 db 或前端**；其余进 `plugin_settings` 表（`bb/apps/server/src/services/plugins/plugin-settings.ts:114-116`「secrets to files, the rest to plugin_settings」；authoring SKILL.md:341-343）。
- 面向用户的读写动线：Extensions 插件详情设置节 + `plugins/:id/settings` GET/PUT（routes/plugins.ts:484-490）+ CLI `bb plugin config <id>`；未配置时插件可置 `bb.status.needsConfiguration`（SKILL.md:734-738）。
- 即：插件 settings 天然支持「非秘密值进 DB + 秘密值进宿主文件」的二分——**秘密分支是宿主 fs 形状**。

### 2.5 对 #251 修的 pin 的适用性

本仓 submodule pin 已从 `ba4265453` 前进到 `dc2778d0`（#251）。两 pin 在 §2 所引全部路径（SettingsView、execution-options、start-server、plugin-settings、agent-providers/catalog、secrets 插件）零差异——本文引用对两 pin 均有效（diff 实测，见头部状态行）。

## 3. 本仓（Workers port）provider 配置面现状

### 3.1 全 provider 配置点盘点（LLM 通道自 #362 起为 D1 用户面正本、#450 起 env seed 退役；实验闸自 #502 起为 D1 `tool_capabilities` seat；其余为部署 env）

| provider 类            | 配置正本                                                                                                                                                                                                     | 形状与生效时机                                                                                                                                                                                                                                  | 用户当前可见面                                                                                                                                                                                                                                 |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| LLM 通道（relay）      | **D1 表 `provider_configs`（#362 用户面正本；#450 起 env seed——`MODEL_RELAY_CATALOG`/`MODEL_RELAY_PROVIDER_CREDENTIALS`——已删除，D1 行是目录与凭据的唯一正本）**；部署标量 env/secret `MODEL_RELAY_BASE_URL_ANTHROPIC`/`MODEL_RELAY_API_KEY`/`MODEL_RELAY_MODEL`/`MODEL_RELAY_MAX_TOKENS`/`MODEL_RELAY_THINKING_BUDGET_TOKENS`（+`DAEMON_MACHINE_ID`/`HARNESS_PERMISSION_MODE`）只喂 deployment channel（`provider-app/src/harness.ts` 三键总解析；#450 起 `api` 恒 anthropic-messages、effort 恒 none） | 秘密只存 D1 加密列（`api_key_enc` AES-256-GCM，`PROVIDER_CONFIG_MASTER_KEY` 派生）；快照仅 key 存在性投影（`projectHarness`）；漂移分类 unchanged/live/session；坏行 skip-with-warning 永不静默删；无 key/baseUrl 的行 dispatch fail-closed（#434 point ⑦）        | 模型/推理选择器（C4 ✅）：`GET /system/execution-options` 投影 D1 行目录（`resolveOverlayCatalog` 单解析——无 env seed、无 "omp" 合成行；无显式 provider 的选择 fail-closed 422）；面板写路径 Settings→Providers→Configured（CRUD/发现/test）；staging secret 缺席 → mock 模式（#34，deployable-units.md U1 缺口 4） |
| web_search 引擎        | D1 表 `web_search`（#449 起唯一正本，`AGENT_DO_WEB_SEARCH` env 路径已删除——零 env 回落）：`chain`/`timeout_seconds`/`engines` 非秘密半 + `secrets_enc` AES-GCM 秘密半 + `secrets_meta` 存在性            | 写面 `GET/PUT /api/v1/system/web-search`（chain 整序替换、引擎字段三态、`resolveWebSearchConfig` 单一校验路径）；AgentDO 经 `applyWebSearchConfig` 于 `refreshProviderOverlay` 回合边界热应用（`packages/agent-do/src/agent-do.ts`）；browser-backed 引擎结构化拒绝（`tools/web-search.ts` 配置层红线）；wire schema 无 engine 字段——模型与用户都不能按调用选引擎 | Settings→Providers→Server 可编辑（#449）：链序开关+排序、timeout、brave/searxng 凭据写入式输入；聚合只读投影保留（chain 序+凭据门 boolean）                                   |
| find judge 模型（原 judge/security 模型行，#522+#523 退役） | **无独立配置点**——daemon agent-auth env 通道（`providers`/`runtimeKeys`/`judgeRole`/`securityModel` JSON）已整删（#523；#522 先删 `securityModel` 腿），宿主零模型注册表。判相模型=线程 pinned selection 经 D1 `provider_configs` 正本链（`resolveTurnModel` → `provider.completeText`），与主 turn 同一目录正本 | 判相在 edge `AgentDO`（`tools/find-judge.ts`）：宿主 find=纯执行相（`find-exec.ts` 回 find-protocol v1 候选载荷），判相腿走 D1 正本链折叠；「部署期输入、模型不可达、unset=agentDir 自带为准」的 env 形态随通道退役——判相模型即用户线程选择，面板写即热生效 | 无独立配置面——选择随线程 pinned selection（#499 picker） |
| security_scan cloud 半 | Codex Security OAuth 凭据，宿主保管                                                                                                                                                                          | T15/#221（CHANGELOG.md:92-94；分类表 §2.3）                                                                                                                                                                                                     | 无                                                                                                                                                                                                                                             |
| 实验闸（#150；#502 起 D1 正本）         | D1 表 `tool_capabilities`（#502 起，迁移 `0007_tool_capabilities.sql`，单行 id='tool_capabilities'：external_thinking/context_notes/checkpoint 0/1 列；env 闸对已删除——零 env 回落）                                                                     | 写面 `GET/PUT /api/v1/system/tool-capabilities`（三布尔整行替换）；AgentDO 经 `applyToolCapabilities` 于 `refreshProviderOverlay` 回合边界热应用（`packages/agent-do/src/agent-do.ts`）                                                                                                                             | 面板 Settings→Providers→Tool Capabilities 三开关写式（#502）；未配置=全 off 空态                                                                                                                                                                                                     |
| 版本                   | `SERVER_VERSION` runtime secret                                                                                                                                                                              | `GET /system/version` 只读（routes/system.ts:223-230）                                                                                                                                                                                          | 只读 ✅                                                                                                                                                                                                                                        |

配置变更语义：edge 侧=重部署（`POST /system/config/reload` 是刻意 no-op——「Worker config source is env vars, so there is nothing to reload」，routes/system.ts:217-221）；daemon 侧=拓扑/enroll/CF Access 凭据 env 保留（provider/judge 配置零 env——agent-auth 通道 #523 整删，宿主零模型注册表）。

### 3.2 设置面/插件面现状（选项 A/B 的地基）

- bb 四族设置 app 单行已移植（`app_settings`/`system_experiments`/`app_theme`/keybinding），general/keyboard/experiments/appearance PUT 可用（gap matrix A5/E1 ✅）。
- **providers 设置子节 = E8 永久裁剪**：`GET /hosts/:id/provider-cli-status` 未移植（404），且它是外部 CLI provider 管理面，与服务端 provider 模型无关（gap matrix E8；`apps/server-worker/src/routes/hosts.ts:46-47`「providers face permanently cropped, matrix E8」）。SPA 路由 `/settings/providers/:providerId` 因 bb 逐字移植而存在（bb-spa-ux-surface.md:24），但无数据面。
- **插件 inventory 恒空 = A8/A10/E5 裁剪**：`/plugins` 返回 `{plugins:[]}` 合法空态，marketplace/catalog 未移植，M3（#16）才回来（gap matrix A8/A10）。插件面板路由在，但今天没有任何插件能挂面板。
- usage limits = E2 永久裁剪（无用量源：服务端 relay 不透出配额）。

### 3.3 与 omp 原生面的关系

omp 原生 provider 配置=用户可编辑的 `~/.omp/agent/models.yml`（provider/baseUrl/apiKey/models 表）。本仓现只以一种方式对账它：edge 侧经 #364 `POST /import-models-yml` 粘贴导入 D1 `provider_configs` 行（omp models-config-schema 正本语义）；daemon 侧的 env JSON 物化覆盖路径（原 agent-auth.ts:123-136，不设 env 回落 agentDir 自带文件）已随 #523 通道整删——宿主零模型注册表。即：本仓没有继承 omp 的「手编 YAML」用户面，替代 UI=#362 D1 可配置面板（#255 之问的落地答案）。

## 4. 硬约束（既有裁决，形态选择必须遵守）

1. **§3.2 设置归属表**（control-plane-layer.md:143-149）：「模型/中转/思考配置 → 部署 env（harness 三键），**不进 app_settings**——秘密与部署拓扑不落控制面 DB」。web_search 链同属「部署拓扑+凭据」类，同理适用 `[INFERENCE: 由同表工具开关/xdev 行的归属逻辑外推，表未逐字列名]`；原 judge/security pin 例已随 #523 通道退役失效（判相模型归 D1 正本链的线程选择）。
2. **§1.2 注册面不归设置面管**（control-plane-layer.md:80）：设置面长出第二裁决点=违规。provider 配置 UI 不得变成工具/引擎启停的第二权威。
3. **四层优先级链**（control-plane-layer.md:128-137）：部署 env → app 单行 → host ceiling → thread 选项 → 单次参数。provider 正本锁在第 1 层。
4. **E8 先例**：外部 CLI provider 管理面已裁；#255 若引入 provider UI，必须是「服务端 provider 模型」语义，不是复活 E8。
5. **部署单元现实**（deployable-units.md §1）：唯一真实部署单元 U1（组合 worker+SPA）；独立 webpage=新建部署单元，成本真实存在。
6. **bb 上游先例**（§2）：provider 凭据不进 UI 可编辑存储，是上游既成事实，跟随不发明（decomposition.md bb ux 块纪律「跟随不发明」）。

## 5. 三选项对照

| 维度               | A 插件面板承载                                                                                                          | B 独立 webpage                                                                 | C 分层（建议）                                                                                                  |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| 秘密边界           | ❌ 插件 secret 分支=宿主 0600 文件（bb/plugin-settings.ts:114-116），Workers/D1 侧无对应物；强行移植=发明第二个秘密存储 | ❌ 编辑面必然要把写通到某个存储：D1 违反 §3.2；daemon 侧则跨信任域             | ✅ 正本留 env，UI 只投影 key 存在性（投影函数已有：projectHarness/decodeWebSearchConfig/decodeAgentAuthConfig） |
| 信任域             | ❌ provider 配置横跨 edge（relay/web_search）与宿主（judge/security）；插件活在一个运行时里，跨界                       | ❌ 同左，且独立站点还要另解决对两个域的鉴权                                    | ✅ 写路径本来就是两处 env；读路径聚合投影即可                                                                   |
| 可用时点           | ❌ 被 M3（#16）阻塞；provider 是 bootstrap 关键路径，不可挂在可 disable 的插件生命周期上                                | ⚠️ 可即建，但=第二个前端+第二个鉴权面+第二个部署单元（U8），违反最小部署面现实 | ✅ 投影端点+settings 节随 U1 走，无 M3 依赖                                                                     |
| bb 先例一致性      | ⚠️ bb 插件 settings 机制支持第三方插件带配置面板，但 bb 自家 provider 面恰恰不用它                                      | ❌ bb 无独立配置站先例；connect/web 部署都是同一 SPA                           | ✅ 与 bb「状态+开关上 UI、正本在文件/env」同构                                                                  |
| 用户体验           | 面板入口深（Extensions→插件→面板）                                                                                      | 入口独立清晰，但与 bb UX 割裂（同一操作者两个后台）                            | 设置节入口常规；与模型选择器（C4）同域                                                                          |
| 「暴露」的真实语义 | 把**编辑**暴露给用户——但没有可写的安全存储                                                                              | 同左                                                                           | 把**事实与选择**暴露给用户（什么通道、哪个模型、哪些引擎有凭据、judge/security 用什么、去哪改），编辑留在部署面 |

**结论**：A 与 B 的共同致命点是它们都默认「provider 配置应该有一个用户可写存储」，而三条硬约束（§4.1/§4.5/§2.4）说没有——正本只能是 env。一旦接受这一点，A/B 的增量价值只剩「编辑 UI 壳」，成本却是新存储面/新信任边界/M3 阻塞或新部署单元。C 把问题还原为它本来的形状：**正本不动，补一个只读投影面**。

## 6. 采纳后的落地切片（供排票，非本票范围）

1. **投影端点（edge 侧，小）**：聚合 `projectHarness`（mock|anthropic、baseUrl host、model、key 存在性）+ web_search 投影（chain 序、各引擎凭据门 boolean、browser-backed 排除策略）成 `GET /system/provider-projections`（或并入 execution-options 响应旁的只读对象）。零秘密值。
2. **daemon 侧投影（已闭，#523）**：原开题「judge/security pin 与宿主凭据存在性投影通道」随 agent-auth env 通道整删而失效——宿主零模型注册表、零 auth 形状配置面，edge 投影面无 daemon 项可投影；本切片无需执行。
3. **SPA 只读节**：设置面复用 `providers` 节位（路由已在，bb-spa-ux-surface.md:24）渲染只读投影+「编辑走部署 env」指针文案（对照 ops/staging-relay.md 先例）；不提供 PUT。
4. **非秘密偏好（M3 后可选）**：per-project 默认引擎序/默认模型偏好可用插件 settings 非 secret 分支或 app 单行——过 §3.2 判据表再立票。
5. **文档**：本文 §3.1 表即 provider 配置点的唯一索引，随 slice 1 一起挂 docs/ops。
   已挂：`docs/ops/provider-config-points.md`（#266，随实现更新锚点与读路径行）。

## 7. 未决 / JOINT-UNKNOWN

- ~~daemon 侧投影通道（§6.2）选型未裁~~——已随 #523 通道退役闭题（见 §6.2）。
- staging `MODEL_RELAY_*` 缺席（mock 模式）何时补齐（#34 挂起）——影响投影端点的真实数据源。
- 用户是否需要**非秘密**的运行时可改配置（如 web_search 链热调）——若需要，那是「app 单行收窄型偏好」新裁决，走 §3.2 判据表，不在本票。
- per-thread/per-call 引擎覆盖：wire schema 无 engine 字段是刻意设计（T12），开放它=动 §2.2 裁定，本文不提。

> AGENT GENERATED: by zhipu-coding-plan/glm-5.3-flash:max
