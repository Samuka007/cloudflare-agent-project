# Changelog

本仓以 GitHub milestone + 票面验收为里程碑权威记录；本文件是人类可读摘要。
格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [Unreleased]

### Added

- **#258 (P0) host onboarding 端到端**：执行 host 添加此前无门——AddMachineDialog
  开但 join-code mint 路由未移植（#193 走查实录 "Route not found"），也无任何
  用户文档。三件套补齐：① `POST /api/v1/hosts/join-codes`（bb 契约形状 201
  `{joinCode,hostId,expiresAt}`，15 分钟一次性码；铸码不建行——bb
  issuePersistentHostEnrollKey 幽灵规避；存储走 DAEMON_EDGE_KV 哈希键，兑码即
  焚）；daemon-service `/enroll` 双凭据梯（静态 env key 原语义 + join code 兑换，
  铸码 hostId 为身份权威）；② `GET /install.sh`——钉版对话框打印的
  `curl …/install.sh | sh -s -- --join-code … --host-id … --server …` 不再 404，
  脚本按对话框旗标契约校验后 `nix run …#cap-daemon`（新增 flake app 别名，修掉
  双动态 `apps.${system}` 的 Nix eval 错误）；cap-daemon 增 `--join-code`/
  `DAEMON_JOIN_CODE` 与 `--server` 别名。③ `docs/ops/host-onboarding.md` 用户
  视角全步骤。M1 key registry 维持 crop（#195 S7）：兑码交付部署级 hostKey，偏
  差记档于 onboarding 文档安全节。真机走查（wrangler dev + 真实 cap-daemon ×2
  + 钉版 SPA 真浏览器）：铸码→装命令渲染→倒计时→daemon 以铸码 hostId enroll→
  `session.ready`→对话框原地翻绿 "nixos connected"（截图录据），spent code/伪码
  均 401。L1/L2：daemon-service `l1-join-code-enroll.test.ts`（6）+ server-worker
  `join-codes-onboarding.test.ts`（6，契约形状/无幽灵行/enroll 落表/一次性/静态
  路不受扰/install.sh 旗标契约）。
- **#266 provider 只读投影面**（#255 方案 C：正本留部署 env，UI 只投影）。
  `GET /api/v1/system/provider-projections`：聚合 `projectHarness`（relay
  模式/baseUrl host/模型/key 存在性/thinking/权限模式/machine，复用既有无秘
  密投影）+ web_search 投影（`projectWebSearchConfig`：chain 序、各引擎凭据
  门 boolean、browser-backed 排除表、decodeError）——零秘密值出 env，decode
  失败丢弃错误文本；端点无任何写路径（`/system/config/reload` no-op 先例）。
  SPA：Settings→Providers→Server 新节（bb fork `lane/266-server-provider-
projection`）渲染只读投影 + 「编辑走部署 env」指针（对照 ops/staging-relay.md
  文案先例），零 PUT/零控件。docs：§3.1 表挂 `docs/ops/provider-config-points.md`
  为 provider 配置点唯一索引。daemon 侧投影（judge/security）随 #56 裁。
  L1：`system-provider-projections.test.ts` 7 例（含评审断言「never emits
  secret values」与 404 写路径）。
- **#257 CoT thinking 通路**：provider 原生 reasoning（Anthropic `thinking_delta`）端到端
  journal 面。relay 侧 thinking_delta 独立 chunk（`relay/anthropic-provider.ts`）；agent DO
  以 `model.thinking` 行落盘——与 `model.delta` 同 deltaFlushBytes/deltaFlushMs 刷盘纪律
  与 call guard（FSM 折叠零状态，answer 记账 `deltaChars` 不含 reasoning 字节），oversize
  行与 `model.delta` 同 `text` 字段 R2 blob-offload（读面透明解析，fetch 权威不变）；ux
  projection 1:1 投 `item/reasoning/textDelta`（`itm-rs-<turnId>:<callSeq>` item id，blob
  行/空行不出 UX 面）；server-worker timeline `activeThinking` 折叠供 SPA Thinking 指示器
  （test/compat/active-thinking.test.ts）；子代理 history:// 渲染 `thinking:` 转写行。
  **#150 配对语义修正**：forceReasoningOff 钉死从闸状态移到 wire——`anthropicRequestBody`
  在 RENDERED 工具面（experimentalGates ∧ supportsExternalThinking 过滤后的 finalNames）
  实际含 `think` 时才 pin `thinking:{type:"disabled"}`；DO 不知 relay model id，不再从闸
  推导（旧闸推导对 glm-5.3 类原生推理模型误杀原生 CoT——闸开≠`think` 上 wire）。显式
  `request.forceReasoningOff` 保留给上游决定配对的调用方。
- **#270 pm-harness 插件化——AP 变 omp custom-tool 家族**。`plugins/pm-harness/`
  独立插件包（`package.json` `omp.tools` manifest，`omp plugin link` 即装）：
  `src/core.ts`（原 scripts/pm-autopilot.ts 整体迁入，纯函数+gh/jev 注入缝不变）+
  `src/tools.ts` 五件模型级原生工具——`pm_lane`（gate→worktree→spawn→守卫翻转，
  dry-run 默认）/`pm_apply`（唯一写路径：preflight diff→分批守卫写→逐批复核，
  漂移即扣留余批）/`pm_audit`（漂移对账，产出 pm_apply-ready mutations）/
  `pm_release`/`pm_ledger`（浏览器租约台账对）。装插件后 omp 会话零 import：
  模型直呼、eval 内 `await tool.pm_lane(...)`、`tools.xdev` 下挂 `xd://pm_*`。
  spawn 传输梯新增 #270 分离式兜底：registerSpawn 覆盖槽 → eval 内核
  `globalThis.agent` → 分离式 `omp -p --cwd <worktree>`（回执 pid+`.pm-lane.log`，
  会话落 `~/.omp/agent/sessions` 可 `omp --resume`；`PM_LANE_NO_DETACH=1` 还原
  transport-missing 契约）。附 `agents/pm-guard.md` task-agent def。
  scripts/pm-harness.ts（%load 装载体）与 jev-loop/jev-locate 全部改指新址；
  L1 随核心迁入 `plugins/pm-harness/test/`（core.test.ts 90 例）+ 新
  tools.test.ts 16 例（工厂面/漂移拒绝/守卫写/对账闭环/传输梯/台账对），
  共 106 通过。插件包入 pnpm workspace，typecheck/test 进 CI 门。
- **#242 jev-locate 定位器原语 + 枚举召回审计 + 预登记置信分布**（research
  jev-locator-converger.md §6 单票落地）。`scripts/accept/jev-locate.ts`：
  `locate(deps,input)→LocateReport` 单调用定位器——ground（形状 G，双序复验同请求）/
  inventory（形状 C，逐项 14 项闭集词汇表+pRelevant）/converge（C+X 单 fan-out，区域
  noul×2 + 预算内 packet，DATA 域协议头内嵌）；`converge()` 为未来 LLM lane 冻结入口，
  无回路/无判决/无 goal_achieved。criteria 用 `opt<ref>` 非整数键——整型键会被 JS/JSON
  数序重排、静默破坏 R4 乱序。`jev-recall-audit.ts`：staging 三页 A(SEL 白名单) vs
  B(CDP AX 树)/C(启发式) 召回对照——bOnly 均为标签形状差非真漏（人工复核），真 C 候选
  每页 ≈1，A 主路维持。`jev-locate-distribution.ts`：预登记 P1–P6（commit 顺序先于首跑），
  n=144 类问实测 jev-1.13.0：类置信 P50 0.96、≥0.85 占 74.3%；三分位规则机械推导三档
  高≥0.99/中[0.88,0.99)/低<0.88（零调参）；ground 整页形状三页 noneMatch（composer 被
  ≤60 截断纪律裁撤，jev 如实弃权而非硬猜）——形状 G 只做页内排序的预言被实测复现。
  归档 `docs/research/spike/jev-locate/`（审计/分布/两页 LocateReport 真用 + 契约冻结
  README）。L1：seam 单测 30 例（question 契约/R5 注入纪律/双序/gap 数学/带推导）。
- **#240 (P1) 浏览器租约台账**：CDP/thread 资源分配的结构化纪律（audit 规则 6，纪律语义源 #239 评论
  5988466175）。`AP.lease("browser", { lane, tabName, threadPrefix, number? })`／`AP.release`／`AP.ledger`：
  仓内 append-only `.pm-leases.jsonl`（gitignored，`PM_LEASES_PATH` 可改），同 tab／同线程前缀被他 lane
  持有时登记硬拒（零写入）。`AP.lane` 对提及浏览器／CDP／Chrome 的票自动生成租约计划（tab `l<票号>`、
  线程前缀 `l<票号>-`、roster lane id；`agentSpec.lease` 可覆写）：spawn 上下文携带租约段（具名 tab＋
  线程前缀＋释放义务），confirm 路径在 spawn 前登记、spawn 抛错自动回滚。`AP.audit` 新增规则 6（传
  `leases: AP.ledger().events` 才武装）：browserLeaseMissing（涉浏览器活跃 lane 无租约）／
  browserLeaseCollision（同 tab／前缀两 lane 并发）／browserLeaseUnreleased（票已交付租约未释放），
  均无 mutation——修复动作是 AP.lease/AP.release。pm.md 验收钩子同步（CDP 三层纪律＋空框不可关票）。
  L1：scripts/test/pm-autopilot.test.ts 租约台账／lane 自动携带／audit 规则 6 三组（含两 lane 并发
  无碰撞与无租约违规演示）。

### Fixed

- **#226 (P0) Stop request 无效**：`POST /threads/:id/stop` 是 no-op 存根——SPA
  Stop 打进死路由，turn 永不落终态；ask pending（DO 有意挂起看门狗的「用户即
  deadline」态）彻底挂死。路由现在从 agent DO 原始 journal 折出活动 turn
  （`activeTurnIdFromEvents`：input/steer 立指针、终态行清指针，ask pending 保持
  可取消），直连 DO `cancelTurn` 完成取消（T19 面：`turn.cancel_requested` →
  abort driver → kill 非终态执行，含 ask interrupt）；不走 orchestrator
  thread/stop——该面会毒化 provider session 注册表，而 composed edge-agent 的
  journal 折叠本就干净、无恢复消费者。L2：agent-do ask.test.ts 停止路由 fold
  断言（ask pending = 可取消活动 turn，cancel 落 `turn.cancelled` 后清空）；
  L1：server-worker thread-stop.test.ts（静默 no-op、完成后 no-op、404）。
- **#225 (P0) ask 不弹前端**：agent 调 `ask` 前端不弹交互卡（staging 真机）。
  两处缝：① DO→hub 帧面——`interaction.*` journal 行落进 notifyHub 通用
  `events-appended` 桶（#197 只做了 model.delta/turn.phase），而 SPA interactions
  query 只在 `interactions-changed` 上 refetch；现特殊分支推送
  `["interactions-changed", {latestSeq, hasPendingInteraction}]`（bb
  buildInteractionChangeMetadata 同形），弹卡/横幅消失/侧栏徽标一次到位，T4 的
  DO 私有 `pending-interaction` push 保持 I3 内部面。② 控制平面 REST 面——
  `GET /threads/:id/interactions` 是 `[]` 桩、single/resolve 面缺失；现由 DO
  journal fold（`listInteractions` RPC + `projectInteractionRows`）供行，bb
  providerPendingInteractionSchema 校验出站，resolve 走既有 `resolveInteraction`
  RPC；D1 `pending_interactions` 升级为 thread-list EXISTS 探针的镜像（读面
  自愈）。bb 子模块零改动（fork 消费 hub bb 方言帧 + 上述 REST 面）。
- **#228 派发链断点**：模型请求投影（translate.ts）按 turn 过滤——同一会话的
  第二个 turn（子代理 yield 提醒梯的 reminder turn、主线程的用户追发消息）完全
  丢失此前所有 turn 的上下文，真机上子代理在 reminder turn 里 yield 出"未收到
  任务内容"。现按 omp §1.5 全日志折叠：每个已完成 turn 的 input + 调用史作为
  `priorTurns` 进请求（#147 rewind 截断的 pre-boundary turn 仍由 branch summary
  替代、不回流）；L2 断言钉 child reminder turn 上下文含派发 task 原文
  （task-chain.test.ts）+ 纯投影四格（translate.test.ts）。

## [m1.5] — 2026-10-04 · 工具集完备（omp 33 工具面边缘化）

Milestone `M1.5` 收官（票集 #91–#116，正本 docs/proposals/m15-ticket-set.md 六波次；
关账口径=essential 12，#103 用户裁决——记忆族列未来功能移出）。T26 收官门
（#116）：全注册工具面 replay 一致性回归矩阵全绿 + 对照差距清单收窄
（docs/ops/m15-closeout.md）。

### 注册面与执行路由（T1–T4，#120/#129/#132/#140）

- AgentDO 编译期工具注册表（单 schema 权威，行形状冻结
  `{name, schema, descriptionTemplate, class, backend, intent}`）；edge 类 DO 本地
  执行路由——journal 先行、驱逐重放存活
- edge 三件套先行：context_notes/new_context/think；wait + JobRegistry 接口冻结
  （唤醒竞速/30min 帽/owner 过滤）；会话树三件 todo/checkpoint/rewind（DO-local）；
  ask 走 DO↔SPA pending-interaction 通道（bb interactive-request 对齐）
- #150 五闸：think/context_notes/new_context/checkpoint/rewind 默认 OFF（omp 姿态），
  env 开闸（AGENT_DO_EXTERNAL_THINKING / _CONTEXT_NOTES / _CHECKPOINT）

### host 工具全语义（T5'–T11/T15，#135/#138/#141/#143/#144/#153/#221）

- 嵌入式 omp 运行时 bring-up（vendored runtime，Settings/auth 隔离）+ read/glob/
  grep/edit/write/manage_skill/find 激活与逐工具语义 L1；bash 全语义对齐
- eval：宿主持久内核 seam（framed-IPC py + js worker VM + IdleTimeout），DO 驱逐
  重放 re-attach 不二次 spawn（T10'，#139）
- web_search 边缘化：DO 原生 fetch provider 面，browser-backed 引擎配置层显式排除
  （T12，#144）；find judge 经 provider 通道（#145）；task isolated 隔离后端 daemon 半
  （T20，#153）；security_scan 整体归 daemon（凭据宿主保管，T15，#221）

### task/子代理族（T16–T19，#137/#146/#179/#213）

- task 同 host：单派发 + 子 AgentDO + yield 闸 + 结果回灌；yield 全语义 +
  `agent://` 工件族；task batch + 会话级 Semaphore + 预算梯（投机预启动按票面记录裁切）；
  子代理生命周期四态（running/idle/parked/aborted）+ TTL park + 复活 + kill

### 收官门（T26，#116）

- 表驱动 replay 一致性回归矩阵（`packages/agent-do/test/t26-replay-matrix.test.ts`）：
  全注册 21 行 × 驱逐注入（`abortAllDurableObjects`/`evictDurableObject`）× 去重
  （同 executionId 重问=journal 应答、零二次 spawn）+ bash/eval outcome-unknown 暴露格
  - task readopt 格；完备性由测试强制（注册表新行无矩阵条目即红）
- 对照差距清单收窄记录（docs/ops/m15-closeout.md §3/§4）：C5/D13 逐项处置、
  #24/#25 重调政策接口对齐核对（executed 标记制缝冻结就绪）

## [m0] — 2026-10-04 · bb 云端重建（边缘个人 agent）

Milestone `M0` 已关账（#31 用户签收：演示跑通，kill criteria 成立——M0 是 bb 的
云端重建，不是 omp 的替代）。staging 遗产：cap-server-staging@ece470f，
SERVER_VERSION=commit SHA 注入。

### 架构落地（#18–#30）

- 全栈 Cloudflare Workers 化：bb SPA（verbatim dist）→ server-worker（Hono API 面）→
  agent DO（per-thread 轨迹 + turn FSM，22 不变量）→ daemon-service（DO + 无状态 front）
  → daemon client（WS 长连，host 工具执行）；provider-app/daemon-worker 面就位
- 协议主权：`packages/protocol` 唯一 wire/事件形状源；scheme A 零版本号变更
- 事件日志：DO SQLite 追加式（裁定 #6：events 不进 D1），无快照表，compaction 即检查点
- effect@4.0.0 精确钉版、混合采用（Stream/Fiber 进 relay 与 turn 编排，负面清单见
  docs/research/effect-ts-adoption.md）

### 模型中转（#28/#34）

- Anthropic Message 协议 relay（glm-5.3，thinking disabled）
- 链路：agent DO → newapi（channel 10 直连 zhipu 原生 Anthropic 端点，绕开面板
  oai→anthropic 转换截断 bug）→ 真模型 turn 端到端打通（ACK-M0 实证）

### 事故与加固（2026-10-04）

- DO 免费档配额烧穿事故 → 三修：#35 client 统一协商退避（1s→5min 指数+抖动+
  Retry-After）、#36 front 边缘防护（KV 鉴权梯/负缓存/令牌桶，DO 请求量 ≈98% 削减，
  engineering.md 横切实践 11 "DO 请求量预算"入宪）、#38 服务端断 WS 自愈
- SPA 白屏事故 → #39 部署流程纳入 dist 构建与资产断言（flake app `nix run .#staging-deploy`，
  工具链钉版 + shellcheck 门）
- hosts 生命线修复（#62）：daemon 心跳 → 注册表 last_seen_at 投影（SQL 端 30s 节流，
  防 D1 写配额烧穿；bb markHostSeen 语义），/hosts status 弃路由钉死 disconnected、
  改读时派生（per-host service DO hostLiveness：现役会话 + 活 socket，bb
  entity-lookup toHostStatus 语义），SPA "Host disconnected" 横幅与真值一致

### 工程实践

- eslint strictTypeChecked + prettier 全仓（#37/#43），CI 三门（lint/typecheck/test）
- 版本管理：commit SHA 注入 SERVER_VERSION（部署溯源）；bb 子模块钉 ba4265453；
  infra 漂移入档（docs/ops/）；M0 关票打 tag
