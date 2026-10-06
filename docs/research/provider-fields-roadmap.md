# 完整 LLM provider 字段面路线图：capabilities / flags / 特殊 auth（#305，#255 延续）

> 状态：**成档 v1**（2026-10-05，lane/305）。票：Samuka007/cloudflare-agent-project#305 · 前置裁决：#255 方案 C（正本留部署 env，UI 只投影）/#266（只读投影面零秘密值落地）。
> 方法：bb 上游源码直读（本仓 submodule pin `e04a0f1490eb9d489cd214ab5b61f642fe433f9d`，行号相对该 pin）+ 我方仓锚点复核 + pi-ai 字段集对照（pi-parity-matrix G1/G2/G3/C5 行既有锚不重考）。凡未经工具验证的推断标注 `[INFERENCE]`。
> 兄弟票：#306（idle provider session release）、#308（usage receipt，已交付）、pi 矩阵 C5（per-thread thinking 切换挂本票 flags 层）。

## 0. 结论先行

1. **capabilities 与模型目录是部署声明，不是运行时状态——不需要新存储**。#255 方案 C 直接延伸：正本继续住部署 env（新增一个**公开非秘密**的目录声明 JSON），投影进既有 `GET /system/execution-options` / `provider-projections` 两读面。#319 已示范同一裁决的双面投影模式（`supportsImageInput`：env 一处声明，harness 与 execution-options 同源），本路线图把它推广成目录层。
2. **layer-4（thread 执行选项）的存储缝已经打好，缺的是消费与校验**：threads 行已有 `provider_id/model_override/reasoning_level_override` 列（`apps/server-worker/src/db/rows.ts:90-93`），create/send 请求字段已进契约（`apps/server-worker/src/contract/api/threads.ts:103-127, 226-228`），但值既不校验也不分派——选了等于没选。补齐顺序：目录声明（#350）→ 真消费（#351）。
3. **特殊 auth 分两个信任域裁决，不可混**：宿主执行的 OAuth（security_scan 的 Codex Security，T15/#221）已裁「凭据宿主保管、整体归 daemon」，红线不迁移；edge 侧 OAuth 只为 **edge-native 通道**（relay 上游本身是 OAuth 订阅类服务）而设，形态是 Workers 回调路由 + KV 会话态（`packages/mcp/src/oauth` 的 PKCE 引擎存储无关、WebCrypto 原生，可直接复用）。这是新存储的唯一落点（KV state/token 缓存），先切设计票再切实现。
4. **切票 3 张**（§5，2026-10-05 已切）：#350 目录声明层 + 投影（implementation，W5）；#351 thread 选择真消费 + 多模型分派（implementation，W5，blocking 边 ← #350）；#349 edge OAuth 形态与凭据信任域裁决（decision，W5，产出 ADR 后另切实现票）。
5. **一处现存三面矛盾随 #350 修复**：default-execution-options 宣称 `reasoningLevel: "medium"`（`apps/server-worker/src/routes/projects.ts:365`），目录只开 `none`（`routes/system.ts:139-140`），harness 实跑 `none`（`apps/provider-app/src/harness.ts:98`）——三个 face 各说各话。

---

## 1. bb 上游 provider 字段全景考古（pin `e04a0f14`）

### 1.1 双字段面：wire 目录 vs 服务端内部能力

bb 把 provider 字段劈成两套，纪律是「client 可读的进 wire 契约，backend 私有的永不进 `ProviderInfo`」：

| 面                                  | schema                            | 字段                                                                                                                                                         | 锚                                               |
| ----------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------ |
| wire `ProviderInfo`                 | `providerInfoSchema`              | `id / displayName / logoUrl / capabilities / composerActions / available`                                                                                    | bb/packages/domain/src/provider-types.ts:65-73   |
| wire `ProviderCapabilities`         | `providerCapabilitiesSchema`      | `supportsArchive / supportsRename / supportsServiceTier / supportsUserQuestion / supportsFork / supportedPermissionModes[](min 1)`                           | 同上 :28-36                                      |
| wire `AvailableModel`               | `availableModelSchema`            | `id / model / displayName / routeProviderId? / description / supportedReasoningEfforts[{reasoningEffort, description}] / defaultReasoningEffort / isDefault` | 同上 :14-26                                      |
| wire composer 动作                  | `providerComposerActionSchema`    | discriminated `skills / plan / goal`（slash 命令 trigger + 名字）                                                                                            | 同上 :38-63                                      |
| 服务端 `ProviderServerCapabilities` | interface（**无 zod，不出后端**） | `supportsSessionRestore / supportsWorkflows / backsHostDaemonAiServices / reasoningLevels[]`（粗粒度回退阶梯）                                               | bb/packages/agent-providers/src/catalog.ts:36-67 |

`reasoningLevels` 的定位值得抄：它是「per-model 精确集合不可得时的粗阶梯回退」——Codex 的 app-server 才是权威，目录里的阶梯只为 custom models 与缺失 catalog 兜底（catalog.ts:169-174 注释）。pi 侧无中列；`routeProviderId` 解决「模型挂在 A provider 名下但走 B 通道」（pi 内嵌 provider 场景，provider-types.ts:18-20）。

### 1.2 内建目录与加 provider 纪律

- 内建枚举四家：`codex / claude-code / pi / acp-cursor`（catalog.ts:10-16），动态 `acp-<slug>` 前缀识别（:19-33）。
- 每家声明：wire capabilities（codex 独有 `supportsServiceTier: true`；claude 独有 `supportsUserQuestion`；ACP 最小集 + fork 需 agent 逐 session 协商，:93-160）、composerActions（codex 多 plan/goal 命令，:123-141）、serverCapabilities 与粗阶梯（codex `low..max,ultra`；claude `low..ultracode,max`；pi 含 `none`=thinking-off 级；ACP 单一合成 `medium`——reasoning effort 编码在 Cursor 的模型 id 里由 bridge 解析，:169-204）。
- **加 provider checklist**（catalog.ts:206-220）：新条目必须声明五件——id 枚举值、wire capabilities、composerActions、serverCapabilities、agent-runtime 的 adapter+factory。宿主局部事实（CLI 可执行性、注入 skill 根布局）留在 daemon，按 id 键控（:214-219 注释）。
- 默认模型表 `PI_DEFAULT_MODEL_PER_PROVIDER`：11 家模型供应商各一默认（anthropic/openai/openai-codex/amazon-bedrock/google/google-gemini-cli/google-vertex/openrouter/vercel-ai-gateway/xai/mistral，:275-291）——这是 **模型供应商**（pi-ai 的 KnownProvider 子集）与 **agent provider**（CLI 后端）两层的缝合点：pi provider 的模型走 `routeProviderId` 下探。
- fork/手动 compaction 是函数而非字段：`supportsNativeFork` / `supportsManualCompaction`（codex/claude-code/pi/acp-opencode 白名单，:393-410）。
- claude-code 精确目录：版本钉死的 curated 表（`ClaudeCodeCatalogEntry{id, model, displayName, description, supportedReasoningEfforts, defaultReasoningEffort}`，claude-code-models.ts:13-20, 36-91）——daemon 按账号探针过滤，server 侧在探针失败前后照常显示（provisional catalog）；「More models/退役别名」刻意不入表，`selectedOnlyModels` 只为标注已存选择（:45-48）。

### 1.3 目录装配：探测、自定义模型、加载错误

`GET /system/execution-options` 装配链（bb/apps/server/src/services/system/execution-options.ts:395-491）：

1. provider 列表 = 内建四家 + config.json `customAcpAgents` + 宿主上已安装的 known ACP agents（去重，:104-121）。
2. 模型列表按 `providerId` 经宿主在线 RPC `provider.list_models` 探测（:493-569），失败折叠为 `modelLoadError{providerId, code}`，code ∈ `missing_executable / auth_required / timeout / failed`（server-contract/src/api/system.ts:17-33）。
3. `customModels`（config.json 用户注册）追加在探测结果之后：`id=model`、`displayName ?? model`、描述固定「Custom model from config.json」、**阶梯取 provider 粗阶梯**（per-model 支持不可知，picker 与用户对账）、`defaultReasoningEffort: "medium"`、`isDefault: false`；按 model id 去重，命中 `selectedOnlyModels` 的晋级为可选（:325-341, :351-393）。
4. 响应 schema：`{providers, permissionCeiling, models, selectedOnlyModels, modelLoadError}`（server-contract/src/api/system.ts:35-61）。

### 1.4 config.json 字段集（`~/.bb/config.json`，managed config）

| 字段                | schema                                                                                                                                                                                  | 说明                                                                                            | 锚（bb/packages/config/src/bb-app-managed-config.ts）            |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `config` 值         | strict 五键                                                                                                                                                                             | `BB_APP_URL / BB_INFERENCE / BB_INFERENCE_FALLBACK / BB_LOG_LEVEL / BB_TRANSCRIPTION`           | :40-48                                                           |
| `customModels[]`    | strict `{providerId: 内建枚举 ∪ acp-* 正则, model(min1), displayName?}`                                                                                                                 | 用户注册 picker 模型；坏条目**跳过+警告**，永不因重写文件被静默删除（写流程携带 raw JSON 穿透） | :53-69；:233-255；bb-app/src/launcher.ts:172-181                 |
| `customAcpAgents[]` | strict `{id(slug), displayName, command, logo?(svg/png/webp), args[], env{}, cwd?, modelCli?{listArgs, selectFlag, primaryModels}, reasoningCli?, nativeReasoning?, nativeSkillRoots?}` | 用户注册 ACP agent，id 派生 `acp-<id>`，禁撞内建枚举，禁重复                                    | :84-148                                                          |
| 其余                | `sharedSkillRoots / machineCredential / connectMachineId / serverUrl`                                                                                                                   | 机器凭据与连接指向                                                                              | :150-160                                                         |
| 合并语义            | `managedConfig ?? baseConfig` 逐字段                                                                                                                                                    | bb-app 托管配置覆盖基础配置                                                                     | apps/server/src/services/system/bb-app-managed-config.ts:106-111 |

`BB_INFERENCE / BB_INFERENCE_FALLBACK` 是宿主 AI 服务（语音转写/结构化推理 `*.voice.transcribe` / `*.inference.complete`）的 provider/model 指向——bb 服务端另一处「多 provider 并存」的活体，消费面是 `backsHostDaemonAiServices` 能力位（catalog.ts:52-60）。

### 1.5 auth 面：bb 服务端零 auth 写路径

bb 的 provider 认证**全部由 CLI 自持**（各自 OAuth/登录态），服务端只消费状态、从不写入或代刷：

- 探测失败码 `auth_required` 与 executable 缺失同列（§1.3）。
- onboarding 状态机 `agentState ∈ connected / signed_out / none`（server-contract/src/api/system.ts:169-185）。
- 用量/订阅面 `GET /system/usage-limits` → `ProviderUsage` 判别联合（host-daemon-contract/src/commands.ts:1426-1489）：`ok{accountEmail?, planLabel?, windows[]}` / `not_installed` / `unauthenticated` / `expired` / `error{message, planLabel?, accountEmail?}`；窗 `{label, usedPercent(0-100), resetsAt, cost?}`。**纪律句**：「credentials exist but the token expired; the CLI must refresh it (**we never refresh another tool's tokens here**)」——bb 宁可显示 expired 也不碰别家 token。

---

## 2. 我方协议栈现状与缺口

### 2.1 已在的（复用，不重建）

| 资产                            | 内容                                                                                                                                                                                                                                                                                            | 锚                                                                                                     |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| 目录 face                       | `GET /system/execution-options`——#350 后为 `MODEL_RELAY_CATALOG` 声明正本的多 provider/多模型/阶梯投影；无声明时回退单 provider `omp`、单模型 `MODEL_RELAY_MODEL`、`permissionCeiling: "full"`；响应 schema bb-verbatim                                                                         | apps/server-worker/src/routes/system.ts（buildExecutionOptions）                                       |
| relay env 三键+flags            | `MODEL_RELAY_BASE_URL_ANTHROPIC / _API_KEY / _MODEL / _MAX_TOKENS / _THINKING_BUDGET_TOKENS / _CONTEXT_WINDOW(#308) / _IMAGE_INPUT(#319)`                                                                                                                                                       | apps/provider-app/src/harness.ts:34-63, 82-89                                                          |
| 只读投影                        | `GET /system/provider-projections`：harness（模式/host/model/key 存在性/thinking/权限/machine）+ web_search；零秘密值 L1 钉死                                                                                                                                                                   | routes/system.ts:149-202；test/compat/system-provider-projections.test.ts「never emits secret values」 |
| layer-4 存储                    | threads 行 `provider_id / model_override / reasoning_level_override` 列已建；create/send 契约字段已进                                                                                                                                                                                           | apps/server-worker/src/db/rows.ts:90-93；contract/api/threads.ts:103-127, 226-228                      |
| daemon 侧多 provider 元数据词汇 | `DAEMON_AGENT_AUTH.providers{name → {baseUrl, api?, apiKey?, auth?(apiKey\|none), headers?, models[{id, name?, api?, reasoning?, input(text\|image)?, contextWindow?, maxTokens?, cost{...}}]}}` + `runtimeKeys` + `judgeRole` + `securityModel`——omp models.yml 全字段，部署期输入、模型不可达 | packages/daemon-service/src/client/agent-auth.ts:11-30, 32-57                                          |
| OAuth 引擎（edge 可用）         | `packages/mcp/src/oauth`：PKCE（WebCrypto）、发现、动态注册、client metadata document、回调校验、discovery state——`OAuthClientProvider` 接口存储无关                                                                                                                                            | packages/mcp/src/oauth/flow.ts:47-68（+ discovery/callback/errors/types）                              |
| 宿主 OAuth 先例                 | security_scan cloud 半：Codex Security OAuth 凭据宿主保管，plan fingerprint 钉凭据，**派发帧零 auth 面**                                                                                                                                                                                        | packages/agent-do/src/tools/registry.ts:790-806；daemon-service/test/l1-security-scan.test.ts:419-430  |

### 2.2 缺口（对照 §1 逐字段）

| bb 字段面                                                      | 我方现状                                                                                                                                                                                            | 缺口定级                                                                                                                                                                |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 多模型目录（AvailableModel 行 + 精确/粗阶梯）                  | `MODEL_RELAY_CATALOG` 声明正本（公开册，零秘密 strict schema）+ execution-options 多行投影 + provider-projections 目录状态行（#350）                                                                | **已落（#350）**：目录有声明正本，投影同源可读；thread 级选择消费仍属票2                                                                                                |
| capability 位（serviceTier/fork/userQuestion/archive/rename…） | `serviceTier`（provider 级声明）与 `supportsImageInput`（#319 env flag ∪ #350 目录 `input` 并集）已进声明正本                                                                                       | **已随 #350 目录化**（有声明语义的位）；fork/userQuestion/archive/rename 仍静态 false——它们是 bb agent-provider（CLI 后端）语义，relay 无此语义，真值随需求出现再进声明 |
| flags（max_tokens / thinking budget / 上下文窗）               | thinking budget/image input/model/maxTokens/contextWindow 全部进 harness+目录同源投影（#350）；env 标量显式覆盖仍优先                                                                               | **已修（#350）**：budget 开启 → 目录如实开阶梯（缺省 medium 档，声明 `reasoningLevels` 可覆盖）；budget 关 → 仅 `none`，声明的阶梯休眠                                  |
| per-thread providerId/model/reasoningLevel                     | create/send fail-closed 校验（422 具名）+ threads 行 override 列真消费 + journal 三态（thread.created / thread.execution_updated / turn.input pin）+ providerId 键控 RelayConfig 注册表分派（#351） | **已落（#351）**：选择语义 = 显式值严格命中目录行；未设成员解析部署默认（"omp" 哨兵 = 默认 provider）；重放（驱逐重放）经 journal pin 与现投递一致                      |
| 多 provider 并存                                               | edge 注册表化（providerId 键控，同 schema 多行）+ `MODEL_RELAY_PROVIDER_CREDENTIALS` 每 provider 秘密槽（#255 C；无槽行落部署单 relay 槽，key 缺席行级 mock 降级）                                  | **已落（#351）**；**协议级多 API 形状分派**（OpenAI Responses vs Anthropic Messages）不在本路线图——relay wire 是 Anthropic 形状单实现，多协议另立                       |
| 自定义模型注册（bb customModels）                              | 无                                                                                                                                                                                                  | 并入票1目录 JSON（我方部署者=用户，「声明即目录」，无需独立注册面）                                                                                                     |
| auth 状态面（auth_required / signed_out / usage windows）      | key 存在性 boolean（#266）                                                                                                                                                                          | edge 单 key 无「登录态」语义；OAuth 订阅通道引入后才需要——**#349 已裁搁置**，通道落地时随 ADR 引入三态投影（docs/design/edge-oauth-relay-auth.md §5）                   |
| key 轮换                                                       | 单 key env，换 key = 改 env 重部署                                                                                                                                                                  | ops 级即可（见 §4.3），不单独立票                                                                                                                                       |
| modelLoadError / usage 订阅窗                                  | 无（无宿主可探、无订阅通道）                                                                                                                                                                        | 有意收窄：探测的前提（宿主上装着 CLI）在我方不成立，目录改为部署自声明                                                                                                  |

### 2.3 现存矛盾（修复归属票1）

1. **reasoning 三面不一**：default-execution-options 报 `medium`（routes/projects.ts:365）vs 目录仅 `none`（routes/system.ts:139-140）vs harness 实跑 `none`（harness.ts:98）。
2. **能力欠声明**：`MODEL_RELAY_THINKING_BUDGET_TOKENS` 开启时目录仍只开 `none`——#319 的「同一部署声明、两面同源」纪律（routes/system.ts:100-103 注释）只推广到了 image input。
3. **写路径无校验**：`payload.providerId ?? "omp"` 直落 DB（routes/threads.ts:307），未知 model/reasoning 值无 422 具名错误。

> **修复记录（#350，2026-10-06）**：矛盾 1/2 已消除——default-execution-options / 目录 / harness 三面改读同一 `resolveRelayCatalog` 解析（provider-app catalog.ts，内部调 resolveHarness，默认行由 harness 输出折叠）；budget 关 → 三面同报 `none`，budget 开 → 三面同报声明默认档（缺省 medium）。
>
> **修复记录（#351，2026-10-06）**：矛盾 3 已消除——create/send 携带的 providerId/model/reasoningLevel 对目录投影 fail-closed 校验（`resolveRelaySelection`，agent-do provider-catalog.ts），未知值 422 具名错误（provider_unknown / model_unknown / reasoning_level_unknown），目录为空态（omp 合成）同样关闭；选择进 threads 行 override 列 + `thread.created`/`thread.execution_updated`/`turn.input` journal 三态，分派经 providerId 键控的 RelayConfig 注册表（provider-app relay-registry.ts），漂移走 `classifyExecutionSettingsChange` 三值（live 骑下一 turn，session 不因选择触发）。

---

## 3. 分层建议（#255 裁决 C 延伸）

四层链正本：`部署 env → app 单行 → host ceiling → thread 选项 → 单次参数`（docs/design/control-plane-layer.md:128-137）。逐字段落层：

| 字段组                                                                              | 建议层                              | 载体与理由                                                                                                                                                 | 新存储？                                |
| ----------------------------------------------------------------------------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| 凭据（API key / OAuth token / refresh token）                                       | **L1 env/secret 正本**              | #255 C 不动摇：秘密只存 env，投影只出存在性 boolean                                                                                                        | 否（OAuth token cache 见票3，唯一例外） |
| capability 声明（image input / thinking / serviceTier / fork / compaction…）        | **L1 env 正本（公开 JSON）→ 投影**  | 目录是「部署买了什么」的声明，部署期已知、运行时不变；公开非秘密，与 key 不同册。bb 放代码是因为 bb 的目录跟产品走；我方目录跟部署走（哪家中转、哪个模型） | **否**——声明非状态，投影两读面即可      |
| 模型目录行（model 列表 / reasoning 阶梯 / contextWindow / maxTokens / displayName） | **L1 env 正本（同一 JSON）→ 投影**  | bb 的 daemon 探测形态前提不成立（无宿主 CLI），改为部署自声明 + 上游文档对账（人工，一次性）；「探针对账」语义留待真宿主探测需求出现再议                   | 否                                      |
| flags（max_tokens / thinking budget / 上下文窗）                                    | **L1 env 正本 → 投影**              | 已在 env；缺的只是目录/投影同源化（§2.3 矛盾 2）                                                                                                           | 否                                      |
| per-thread providerId / model / reasoningLevel / serviceTier                        | **L4 thread 选项**                  | 链上第 4 层已裁（control-plane-layer.md:135-136）；列与契约已在，票2补校验+消费；漂移分类复用 `classifyExecutionSettingsChange` 三值语义                   | 否（列已在）                            |
| 权限                                                                                | **L3 host ceiling 不动**            | 操作上限语义，向下收敛；`supportedPermissionModes` 随目录投影                                                                                              | 否                                      |
| app 级偏好（默认 provider/model）                                                   | **L2 app 单行（M3 后可选）**        | #255 §6.4 既有建议：非秘密偏好过判据表再立票；default-execution-options 现以 env 硬编码兜底（projects.ts:361-367）                                         | （app 单行已存在，非新存储）            |
| OAuth 会话态（state/verifier/token cache）                                          | **新存储：Workers KV（TTL）**       | 运行时状态，env 存不了；仅 edge-native 通道需要（票3 裁决）                                                                                                | **是（唯一）**                          |
| 多 provider 注册表                                                                  | **L1 env 正本（同目录 JSON 多行）** | daemon 侧 `DAEMON_AGENT_AUTH.providers` 已示范「env JSON 多 provider」形状；edge 对齐同构，秘密仍在各自 key 槽                                             | 否                                      |

**判据复述**（#255 §3.2 沿用）：秘密 → env/secret，投影出 boolean；公开声明 → env 公开册，投影出全值；运行时状态 → KV/DO；人对 app 的偏好 → app 单行。**本路线图新增存储仅一处**（OAuth 会话态 KV），capabilities 明确不进 D1——它没有运行时写入者，进库只会制造第二正本。

---

## 4. 特殊 auth 流的形态（Workers 环境）

### 4.1 两个信任域，分开裁决

| 域                                                                             | 现状                                                                                                         | 裁决方向                                                                                                                                                      |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 宿主执行的 OAuth（security_scan → Codex Security）                             | T15/#221 已裁「凭据宿主保管，整体归 daemon」；派发帧零 auth 面有 L1 钉死（l1-security-scan.test.ts:419-430） | **不迁移**。bb 同构（§1.5「we never refresh another tool's tokens」）——服务端不碰工具的凭据是两仓共同红线                                                     |
| edge-native 通道的 OAuth（relay 上游是 OAuth 订阅服务，如 Codex 订阅当 relay） | 无                                                                                                           | **已裁（#349，2026-10-06）：搁置不立实现票，设计定案冻结于 docs/design/edge-oauth-relay-auth.md；触发条件见其 §6（首个 OAuth 订阅上游进入 edge 目录即重开）** |

### 4.2 edge OAuth 回调形态（若票3 裁「做」）

> **#349 已裁（2026-10-06）**：搁置不立实现票；本节底稿经 ADR 修订定案——token cache 落点由 KV/Secrets Store 修订为 D1 `provider_configs` 密文列（#362 先例，底稿成文早于其落地），会话态仍 KV。详见 [edge-oauth-relay-auth.md](../design/edge-oauth-relay-auth.md) §3/§6。

- **路由**：`GET /api/v1/auth/providers/:id/start`（生成 state+PKCE verifier，302 到 IdP authorize 端点）→ IdP 回调 `GET /api/v1/auth/providers/:id/callback`（state 对账 + code 换 token）。redirect URI = Worker 公网 URL，需在 IdP 侧预先注册 `[INFERENCE: 各 IdP 注册流程不同，设计票逐家核对]`。
- **会话态存储**：state + verifier 进 KV（TTL ≈10 分钟，一次性消费）；token cache 加密落 KV 或 Workers Secrets Store——密钥本体仍是 Secret（L1），KV 只存密文。
- **引擎复用**：`packages/mcp/src/oauth` 的 `OAuthClientProvider` 接口就是存储缝（`tokens()/saveTokens()/state()/saveCodeVerifier()...`，flow.ts:47-68），PKCE 全程 WebCrypto（无 Node crypto 依赖，Workers 原生兼容）；做一个 KV-backed provider 实现 + 路由壳即接通。discovery（RFC 8414）/issuer 校验/动态注册都在包内。
- **刷新**：Cron Trigger 定期 refresh（`invalidateCredentials` 语义对齐）；刷新失败投影 `expired` 态——**照抄 bb 纪律：投影态可显示，绝不静默代刷第三方凭据**。
- **投影纪律**：#266 零秘密值延伸——OAuth 面只出 `{status: connected/unauthenticated/expired, accountEmail?, planLabel?}` 形（bb ProviderUsage 的 ok/unauthenticated/expired 三态子集），永不透传 token。

### 4.3 API key 轮换

bb 无此面（CLI 自轮）。我方最小形态：轮换 = 换 env 重部署（现有 deploy 流已零停机），补一段轮换 runbook 进 `docs/ops/`（staging-relay.md 先例）；「双 key 槽 + `rotationPending` 投影 boolean」仅在多账号/多租户出现后才有真实消费者——**不立票，记为后续触发条件**。

### 4.4 多 provider 并存

- edge：目录 JSON 多 provider 行 + relay 注册表按 `providerId` 键控（票2）；**同 API 形状（Anthropic Messages）多上游**先行，多协议形状（OpenAI Responses 等）是 relay wire 的新实现族，另立票（依赖真实多协议需求出现，本路线图不预切）。
- daemon：`DAEMON_AGENT_AUTH.providers` 词汇已齐（agent-auth.ts:32-57），与 edge 目录 JSON 保持**字段同构**（baseUrl/api/apiKey/auth/headers/models[{...,contextWindow,maxTokens,cost,reasoning,input}]）——两边一份字段词典，避免第二正本漂移。judge/security pin（judgeRole/securityModel）已是 daemon 侧「角色选 provider/model」的活体，多 provider 化后语义不变。

---

## 5. 切票（2026-10-05 已切：#350 / #351 / #349，milestone W5）

| 票   | 标题                                                                                                        | 类型                                     | 依赖               | 验收要点                                                                                                                                                                                                                       |
| ---- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| #350 | provider 目录声明层——`MODEL_RELAY_CATALOG` env JSON 单源，execution-options/投影多模型多能力化（#305 延续） | type:implementation, block:agent-harness | 无                 | 目录 schema（providers×models×capabilities×flags，零秘密）；harness 与 execution-options 同源解析（#319 模式推广）；thinking budget 开启→目录反映；修复 §2.3 三面矛盾；目录 JSON 进 provider-config-points.md 配置点索引表     |
| #351 | thread 级 provider/model/reasoningLevel 选择真消费——目录校验 + relay 注册表多模型分派（#305 延续）          | type:implementation, block:agent-harness | blocking 边 ← #350 | 未知 provider/model/reasoning → 422 具名错误（fail-closed）；RelayConfig 注册表化（worker.ts 单行注册 → 按 thread 选择解析）；DB 既有 override 列消费；漂移分类 unchanged/live/session 贯通；多 provider = 注册表多行同 schema |
| #349 | edge OAuth 回调形态与凭据信任域裁决——订阅类 relay 上游的 Workers 落法（#305 延续）                          | type:decision, block:agent-harness       | 无                 | ADR 成档：§4.1 两域边界（security_scan 红线不迁移）+ KV 会话态/加密/token cache 形态 + mcp/oauth 引擎复用面 + 投影三态 + 刷新 Cron；裁「做」后另切实现票，裁「不做」记录触发条件                                               |

已在账不新立：#308（usage receipt）、#306（idle session release）、pi 矩阵 C5 的 per-thread thinking 级别切换（=#351 的 reasoningLevel 消费面）、#24/#25（relay 重试/中断政策，M1 决策票）。

## 6. 维护

- bb pin 前进后刷新 §1 行号锚（catalog.ts / provider-types.ts / bb-app-managed-config.ts 三处是漂移热点）。
- #350/#351 交付时回填 §2.2 缺口表判定列；#349 已裁（搁置，2026-10-06）回填 §4.1——无实现票号，实现票开出后在 ADR §0 增补。
