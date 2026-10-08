# env + hard code 全量普查判决表（#497）

- 日期：2026-10-07 · 执行：lane 497-audit-hard-code · 预算内（census + 判决）
- 方法：只读普查（零码改，红线），每一项过四问——①本质（凭据/拓扑/产品配置/纯代码不变量/历史缝）②状态藏在哪（env=部署面快照 / D1=可热改数据 / 代码=编译期）③叠层检验（是否制造「一般/默认/特殊」三层心智）④重设计方向（归 D1 / 归常量 / 删除 / 保留部署期并说明为何必须）。
- 产出流：不合格项→立票 #500–#506（W5 内清）+ #507–#508（待用户裁决）；合格项本票记档免复审。

## 0. 总览

| 判决 | 数 | 项 |
| --- | --- | --- |
| 合格（保留，部署期/常量即正解） | 27 族 | §2、§3 合格行 |
| 不合格 → 重设计票（W5 内清） | 7 票 | #500 #501 #502 #503 #504 #505 #506 |
| 不合格 → 产品裁决待用户 | 2 票 | #507 #508 |
| N/A（本仓不存在） | 1 | IMAGE_GENERATION_ID_MARKERS（omp 上游词汇，§5） |

优先级队列（重设计实现票）：#500（P1，随 #496 窗）→ #501/#502（P2）→ #503/#504/#505/#506（P3 小票）。

## 1. Worker 绑定（env.ts 绑定半区，非 vars）

| 项 | 本质 | 判决 |
| --- | --- | --- |
| `DB`/`HOSTS_DB`/`HUB`/`LEASES`/`AGENT_DO`/`ORCHESTRATOR`/`MANAGER`/`DAEMON_SERVICE` DO/D1 绑定 | 基础设施拓扑（平台运行时寻址面；DO namespace 只能经 binding 可达） | **合格保留**。这不是注入配置，是平台接线；D1 行无法承载（无运行时写入者语义） |
| `DAEMON_EDGE_KV`（KV，可选） | 拓扑（#36 边缘盾缓存；镜像为 DO，缓存可选） | **合格保留**。可选性有诚实注释（env-key-only 部署无它） |
| `BLOBS`（R2）、`ASSETS`（Fetcher） | 拓扑 | **合格保留** |

## 2. Worker secrets（staging 现存 6 键）

| 项 | 本质 | 状态藏身处 | 叠层 | 判决 |
| --- | --- | --- | --- | --- |
| `ACCESS_TEAM_DOMAIN` / `ACCESS_AUD` | 凭据/拓扑（Access 应用身份，JWKS 源） | secret store=唯一正本 | 无 | **合格保留**（每部署一个 Access app，天然部署期；纪律「秘密不落控制面 DB」，docs/ops/provider-config-points.md §3.2） |
| `ENROLL_KEY` / `DAEMON_HOST_KEY` | 凭据（daemon 面认证根） | secret store；#398 起 fail-closed（`requireDaemonCredentials`，index.ts:149-152） | 无 | **合格保留**。凭据是状态根，必须活在它所保护的状态之外（D1 泄漏≠凭据泄漏） |
| `PROVIDER_CONFIG_MASTER_KEY` | 凭据（api_key_enc AES-GCM 根，#362） | secret store | 无 | **合格保留**。根密钥进 D1=自锁；加密列设计的前提 |
| `SERVER_VERSION` | 部署期构建元数据（git sha 盖章，deploy-staging.sh:41） | 部署流水线 | 无 | **合格保留**。版本即部署身份，天然部署期；`?? "0.0.0-dev"` 回落是诚实 null 标记。备注：它经 secret 通道存放但内容公开（/system/version），属机制 quirk 非叠层（deployable-units.md §5 JOINT-UNKNOWN 记录在案） |

## 3. Worker vars（env.ts vars 半区 + wrangler vars）

| 项 | 位置 | 本质 | 叠层检验 | 判决 / 票 |
| --- | --- | --- | --- | --- |
| `ACCESS_CHECK_ENABLED` | env.ts:54; wrangler*.jsonc:87/92; assert-staging-gate.mjs | 部署姿态开关——但门态实由凭据组决定，开关是冗余自由度 | 开关+凭据+local-dev 三层；断言脚本存在=旋钮会被忘掉的自供 | **不合格 → #505**：门态=TEAM_DOMAIN∧AUD 双键在场推导，fail-closed 不变；ACCESS_LOCAL_DEV 保留（SEC-W5-001 具名逃逸，语义单一） |
| `ACCESS_LOCAL_DEV` | env.ts:60 | 本地开发显式标记（#397 SEC-W5-001） | 单层具名 | **合格保留**（产品裁决已入安全文档；语义唯一、不可上生产——deploy 脚本已管） |
| `APP_EXTRA_ORIGINS` | env.ts:66; middleware/origin-guard.ts | 产品配置（可调 API 的浏览器来源） | 同源推导+env 附加名单双层；名单生命周期≠部署周期 | **不合格 → #506**：归 D1 app_settings 行，热改+写面 422 |
| `DATA_DIR`（worker） | env.ts:70; system.ts:138; seam/agent-do.ts:261 | **历史缝**——bb 形状假旋钮，Worker 无 fs，纯显示值 | var + `?? "/data"` 字面 + 消费方解读三层 | **不合格 → #504**：env 删，`"/data"` 内联具名常量 |
| `HOST_DAEMON_PORT` | env.ts:72; system.ts:134 | 历史缝（bb 形状，恒 null） | 假旋钮 | **不合格 → #504**（同窗删） |
| `DAEMON_NEGATIVE_CACHE_MS` / `DAEMON_RATE_LIMIT_CAPACITY` / `DAEMON_RATE_LIMIT_REFILL_PER_SEC` | env.ts:32-34; daemon-service edge.ts:73-75,141-143; wrangler(daemon):35 | 安全调参常量的 env 覆盖口——生产零部署设过，唯一用户是 L1 rig（workerd 无法 fake-time） | 常量默认+env 覆盖+rig 特值 1500 三层；intVar 垃圾输入静默回落 | **不合格 → #503**：env 面删（含 server-worker/agent-do 三处转发），常量即正本；rig 改测试注入 |
| `MODEL_RELAY_BASE_URL_ANTHROPIC/_API_KEY/_MODEL/_CONTEXT_WINDOW/_MAX_TOKENS/_THINKING_BUDGET_TOKENS/_IMAGE_INPUT` | env.ts:95-105; provider-app/harness.ts:49-77; wrangler.staging:100 | 产品配置+重复凭据（#450 起 D1 provider_configs 是目录与凭据唯一正本；此族只剩 legacy 通道标量） | **全仓最重叠层**：env 通道 + D1 行 + envConfigured 显示门（system.ts:289-315，9 变量空白判定）+ mock/anthropic 键在场翻转，四层互相解释 | **不合格 → #500**（P1）：API_KEY/BASE_URL 随通道死；预算/窗/图像输入 → D1 行词汇；#496 已裁通道退化为纯投影，本票删投影本身 |
| `DAEMON_MACHINE_ID` | env.ts:90; harness.ts:74,188,212 | 拓扑残留（#377 后 honest 默认=cloud 占位） | 通道叠层成员 | **不合格 → #500**（随通道死） |
| `HARNESS_PERMISSION_MODE` | env.ts:115; harness.ts:121-163 | 产品配置（权限姿态，安全相关），默认 full | env 单层，但姿态该热改+审计 | **不合格 → #500**：归 D1 app_settings；mode→scope/reviewer/escalation 映射表本身=纯不变量，保留常量 |
| `AGENT_DO_WATCHDOG` | agent-do/config.ts:95-123（DEFAULT_WATCHDOG_CONFIG 24 参）; agent-do.ts:536,1811-1814 | 产品配置（运行时调参） | **三层读序**：代码默认→env patch→KV 持久 patch；env 层生产零使用 | **不合格 → #501**：单热改正本（KV 行，缺省=默认播种）；env 层删；rig 测试注入 |
| `AGENT_DO_EXTERNAL_THINKING/_CONTEXT_NOTES/_CHECKPOINT` | config.ts:202-219; agent-do.ts:203-205,537 | 产品配置（#150 实验闸，omp 姿态默认 off） | 闸 flag+注册条件+配对条件联动，env 层是多余解释层；#448 已立 D1 seat 先例（generate_image 闸已删） | **不合格 → #502**：归 D1 工具能力行（seat 同构推广）；行缺省=五闸 off |
| `AGENT_DO_MCP_SERVERS` | agent-do.ts:213; tools/mcp.ts:82-86 | 拓扑+声明（部署桥接的 MCP 端点表；OAuth 会话态已裁 KV，provider-fields-roadmap.md 判据表） | 单层，fail-loud 解码 | **合格保留**（#255 §3.2 在案裁决：公开声明→env 公开册；多服务器真实需求出现时再议 D1 化） |

### wrangler vars 本体

| 项 | 判决 |
| --- | --- |
| `ACCESS_CHECK_ENABLED: "true"`（两份） | 随 #505 消失 |
| `DATA_DIR: "/data"`（两份） | 随 #504 消失 |
| `MODEL_RELAY_THINKING_BUDGET_TOKENS: "4096"`（staging） | 随 #500 归 D1 |
| daemon-service wrangler `DAEMON_NEGATIVE_CACHE_MS: "1500"` | 随 #503 消失（rig 改注入） |

## 4. daemon-service 宿主侧 env 面（cap-daemon 客户端）

| 项 | 位置 | 本质 | 判决 |
| --- | --- | --- | --- |
| `DAEMON_SERVICE_URL` | client/index.ts:87-91（默认 `http://127.0.0.1:8790`） | 基础设施拓扑（控制面地址） | **合格保留**。拓扑是部署期本分；本地回环默认=开发便利（enroll 仍需凭据，不会静默上生产）。备注：若求极简可改 fail-closed，非必改 |
| `DAEMON_ENROLL_KEY` \| `DAEMON_JOIN_CODE`（二选一） | client/index.ts:69-82 | 凭据（#258 一次性码 / 静态键；#378 有身份则免凭据） | **合格保留**。fail-closed 已落地（POC 字面缺省已死，cap-verify.md 换代表） |
| `DAEMON_DATA_DIR`（缺省 `~/.local/state/cap-daemon`）、`DAEMON_SANDBOX_ROOT`（缺省 `/tmp/cap-sandbox`） | client/index.ts:71-74,93 | 宿主拓扑（该机器自己的文件系统位置） | **合格保留**。宿主侧路径天然部署期；XDG 缺省合理。备注（安全观察，非本票产物）：可预测 `/tmp` 沙箱根在多用户宿主有 pre-create/symlink 面，建议将来随 workspace 多根改造（#472 关联）收进 `/var/lib` 或 per-user 根 |
| `DAEMON_CF_ACCESS_CLIENT_ID/_SECRET` | client/cf-access.ts:16-36 | 凭据对（both-or-neither，启动期拒绝单腿） | **合格保留** |
| `DAEMON_AGENT_AUTH`（providers/runtimeKeys/judgeRole） | client/agent-auth.ts:11-95 | 产品配置+凭据（daemon 侧模型注册表→物化 models.yml） | **待用户裁决 → #507**：与 edge D1 正本构成两台注册表；单源化 vs 本地自治（#378 同构取舍）三方向待裁。2026-10-08 处置（#522）：security_scan 宿主面禁用，`securityModel` 腿删除（enablement pin 已删，omp 默认关=工具不在 map；残留 env 值被 schema 剥除不拒收） |
| `DAEMON_TASK_ISOLATION` | client/task-isolation.ts（#110） | 拓扑（宿主隔离后端能力选择） | **合格保留**（宿主知道自己有什么，控制面不知道） |
| `DAEMON_EXEC_MARKER` / `DAEMON_EXECUTION_ID` | executor.ts:65-70 | 运行时管道标记（孤儿识别/kill 名单），非配置 | **合格保留**（内部协议；SEC-W5-006 env 继承面已由安全审记录） |

## 5. hard code 业务值全量

| 项 | 位置 | 本质 | 叠层检验 | 判决 / 票 |
| --- | --- | --- | --- | --- |
| `HARNESS_DEFAULTS`（bigmodel endpoint/glm-5.3/8192/200K/cloud） | provider-app/harness.ts:109-119 | 历史缝（上游死端点+假目录的合成默认） | 部署零 env 时合成假 provider 行（#484 认定无产品意义） | **不合格 → #496 承接**（W5 内清：全删，通道退化为纯投影）；本票不重复立票 |
| `DEFAULT_RELAY_API`（"anthropic-messages"） | agent-do/provider-catalog.ts:136; harness.ts:173 无条件钉死 | 历史缝（"incumbent anthropic face" 只因通道残留而存在） | catalog 折叠终端回落（catalog.ts:184） | **不合格 → #500**（随通道退役；D1 行自带 api 字段后词汇仅存 enum） |
| `SYNTHETIC_RELAY_PROVIDER_ID`（"omp"） | provider-catalog.ts:434; routes/system.ts:920-926,1124-1132 | 历史缝守墓人（sentinel 时代 journal 保留 id；写入面具名拒绝） | 用户点名的「熟名特殊例」：每个 provider 写入面都要绕开它 | **待用户裁决 → #508**：永续墓碑（零工程）vs 随 #496 迁移窗洗数删除。**处置（#508 已执行，2026-10-08 用户裁决=净删，无墓碑无 legacy 标记）**：两处写入面墓碑分支（CRUD 409 / import reserved_id skip）连测试删除；常量降级 rig 入口词汇（agent-do/src/worker.ts 顶部，共享导出面零存活）；0009 迁移净删 D1 全部 omp 引用行（pending_interactions/thread_tabs/threads/provider_configs；谓词永续=反复活数据政策，复用 id 需显式退役该文件）；staging 旧 thread 经既有删除面清（scripts/purge-omp-threads.mjs）；per-thread DO journal 随 thread id 失址成不可达存档（thr_ 随机 id 永不复用，零活词汇引用） |
| `CLOUD_PLACEHOLDER_HOST_ID`（"cloud"） | protocol/environments.ts:204; migration 0004; daemon-service/worker.ts:301-306 具名拒绝; hosts.ts:255-265 删除保护; thread-binding.ts:130,162,167 默认绑定 | 产品不变量+schema 可见行（cloud 载体 ≠ 机器，是产品概念本身） | 单常量单源；特殊化由 migration 行（type:"placeholder"）承载，非散落字面量 | **合格保留**。#386 已把它做成真实 hosts 行，默认绑定（personal→cloud）是 #377 在案产品裁决，非 env 叠层 |
| `IMAGE_SOURCE_API_FAMILY`（"openai-images"） | provider-catalog.ts:342; catalog.ts:154; relay-registry.ts:85; system.ts:348,658,684 | 纯代码不变量（协议族 enum 成员+seat 过滤词） | 单 zod 词典单源；seat 机制（#448）是 D1 正本设计的一部分 | **合格保留** |
| `RESERVED_URL_HOST_SUFFIXES`（11 后缀） | contract/api/system.ts:488-500 | 安全策略不变量（SEC-W5-003 SSRF 写面拒绝名单） | 单验证器单消费者；**不得**热改（可改的 SSRRF 名单=可攻破的 SSRF 名单） | **合格保留**（安全边界必须是常量） |
| probe 限流参数（60s 窗/30 次/1 万剪枝） | services/probe-rate-limit.ts:14-17 | 安全策略不变量（攻击面节流） | 单层；per-isolate 最佳努力已注释 | **合格保留** |
| `SEND_EVENT_TYPES`（["client/turn/requested"]） | routes/threads.ts:131（两消费点） | 协议不变量（bb hub 记录型 fan-out 元数据语义） | 单定义双引用 | **合格保留** |
| 超时族·协议/存活层（HEARTBEAT 5s/LEASE 30s/DISCONNECT_GRACE 5s/COMMAND 30s/SPAWN_ACK 30s/ACTIVE_WORK_GRACE 30s/TOMBSTONE 7d/OMP_RPC 30s+帧预算） | daemon-worker/constants.ts + frame-budget.ts; daemon-service/constants.ts; ws/hub.ts:355 | 协议不变量（bb 语义冻结，wire 变更必 bump protocol version 的纪律载体） | 单层；env 化=部署漂移对抗协议版本契约，反向操作 | **合格保留**。备注：`HOST_COMMAND_TIMEOUT_MS` 在 host-files.ts:21 与 host-rpc.ts:17 孪生定义（注释自认）、超时族在 daemon-worker/daemon-service 两包重复——待 constants 归位时合并，非叠层缺陷，不立票 |
| 超时族·产品层（CLONE 20min/INSPECT 30s/PROBE 10s+512B 帽/WEB_SEARCH 60s→300s 帽/IMAGE 180s/timeline 20,100/watchdog 24 参默认值/publicDeadlines soft 2s hard 8s） | projects.ts:507-508,566-567; provider-config-test.ts:27-28; web-search.ts:129-132; generate-image.ts:29; threads.ts:127-128; config.ts:95-123 | 产品配置，今日以常量形态存在 | 单层常量=用户判词里的「纯代码不变量」正确归所；无 env 层无 D1 层即无叠层 | **合格保留**（出现真实热改需求时随 #501 正本化路径走，不预切） |
| `DEFAULT_WEB_SEARCH_CONFIG`（brave→public/60s） | web-search.ts:129-132 | 裁定缺省链（#449：无 D1 行=裁定缺省，非 env 回落） | 单一回退层；D1 行是唯一正本 | **合格保留** |
| `DEFAULT_AGENT_AUTH_CONFIG`（全空） | agent-auth.ts:76-80 | 中性默认（unset=agentDir 自带为准，omp 先例） | 单层 | **合格保留**（值正本归属见 #507 裁决） |
| `DEFAULT_CODE_THEME_DARK/LIGHT`、`DEFAULT_ENV_SETUP_SCRIPT_NAME`（".bb-env-setup.sh"）、`DEFAULT_CLAUDE_CODE_MOCK_CLI_TRAFFIC_ENDPOINT`、`DEFAULT_HOST_DAEMON_LOCAL_*`、`OMP_MINIMUM_SUPPORTED_VERSION`（"17.0.9"） | contract/domain/code-theme.ts:10-11; setup-script.ts:5; shared-types.ts:104; hdc/local.ts:14-18 | 产品默认+bb 兼容常量+兼容性版本钉 | 单层 | **合格保留**（版本钉天然常量；主题默认将来随用户偏好面走 bb app 单行，今日无写入者不预切） |
| `FLAKE_REF_FALLBACK`（github:Samuka007/cloudflare-agent-project#cap-daemon） | install-sh.ts:14,53 | 分发拓扑（daemon closure 分发源）+ CAP_FLAKE_REF 覆盖 | 单常量+显式覆盖，安装器惯例 | **合格保留** |
| `defaultFeatureFlags`（placeholder:false 等） | contract/domain/feature-flags.ts:34 | 产品默认（只读投影，无写入者） | 单层 | **合格保留**（#502 落地时工具闸词汇并入此面，届时一行一正本） |
| `envConfigured`/`deploymentChannelEnvConfigured`（9 变量空白判定） | routes/system.ts:289-315 | meta 层（为 cope 通道叠层而生的显示门） | 它就是叠层的产物 | **不合格 → #500**（随通道删除；#496 验收已含面板块联动） |

### 空值合并回落全仓清点说明

`??`/`||` 业务回落逐族过筛后只有四类形态，全部有归属：①诚实 null 标记（SERVER_VERSION "0.0.0-dev"、HOST_DAEMON_PORT null）②bb 形状回落（DATA_DIR "/data"——#504 删）③裁定缺省链（web_search、watchdog 默认、catalog 折叠——单层合格）④叠层回落（HARNESS_DEFAULTS 族——#496/#500 删）。测试/rig 文件（poc-*、staging-smoke）里的 `/tmp` 与随机凭据属测试夹具，不进业务判决面。

## 6. N/A 记录

- **IMAGE_GENERATION_ID_MARKERS**：本仓零存活（全仓大小写不敏感检索无匹配）。它属 omp 上游（vendored pi runtime 的产图 id 识别标记清单，#485 讨论脉络）。本仓对应物已是 D1 `image_source` seat（#448，env 闸对已删）。无需本仓立票；若未来 omp 侧清洗该清单，随 vendoring 钉版升级自然跟随。

## 7. 红线自检

- 普查零码改：本分支唯一交付物=本判决文档（docs/research/），无 src/wrangler/flake 改动。
- 重设计实现票 #500–#506 单独派发，本票不含实现。
- #507/#508 挂 `status:awaiting-user`，等用户裁决后转实现或记档。
- 交叉引用：#496（HARNESS_DEFAULTS/"*" 缝）、#450/#449/#448/#377/#362/#150（在案裁决）、provider-fields-roadmap.md §3.2 判据表、provider-config-points.md 配置变更语义表。

AGENT GENERATED: by zhipu-coding-plan/glm-5.3:max
