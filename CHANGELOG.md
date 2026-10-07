# Changelog

本仓以 GitHub milestone + 票面验收为里程碑权威记录；本文件是人类可读摘要。
格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [Unreleased]

### Added

- **#350 (W5) provider 目录声明层——`MODEL_RELAY_CATALOG` env JSON 单源 + 三面投影同源化（#305 roadmap §2.2/§3 落地）**：
  ① 声明正本：`packages/agent-do/src/provider-catalog.ts`——公开非秘密的部署目录 JSON（providers × models ×
  capabilities × flags：id/name/api/reasoning/input/contextWindow/maxTokens/cost + description/
  reasoningLevels/defaultReasoningLevel + provider 级 displayName/baseUrl/serviceTier + defaultProvider），
  **model 级字段词典与 daemon `DAEMON_AGENT_AUTH.providers` 共用同一 zod 实例**（agent-auth.ts 改 import，
  roadmap §4.4「两边一份字段词典防第二正本漂移」）；schema strict——拼错字段/credential 字段（apiKey）
  直接拒绝，永不静默欠声明。② 同源解析：`apps/provider-app/src/catalog.ts` `resolveRelayCatalog`——内部跑
  `resolveHarness`，运行中模型的目录行由 harness 输出折叠（model/maxTokens/contextWindow/imageInput/
  thinking 阶梯默认档），三面（execution-options 投影 / provider-projections `catalog` 状态行 /
  projects default-execution-options）读同一解析，#319 双面模式推广成目录层；harness 三键总解析吃进目录行
  （env 标量显式覆盖仍优先，#308/#319 契约不变）。③ 三面矛盾修复（roadmap §2.3 矛盾 1/2）：thinking budget
  开启 → 目录/harness/default-execution-options 同报声明默认档（缺省 bb medium 档，声明 `reasoningLevels`
  可覆盖）；关闭 → 三面同报 `none`（声明的阶梯休眠——wire 只有一个 budget 旋钮，多档如实不报）；退休
  execution-options 的 "glm-5.3-anth" 孤例硬编码与 projects.ts 的 "medium" 恒报。④ 缺省回退：无声明/坏声明
  → env-only M0 合成（单 omp 单模型）+ `decodeError` 打点（web_search 先例），turns 不中断。测试：agent-do
  `provider-catalog.test.ts` 12 例（schema/strict/阶梯推导/查找序）、provider-app `catalog.test.ts` 5 例
  （多行投影/同源矩阵/缺行补前/坏声明回退）+ `harness.test.ts` 4 例（声明折叠/预算阶梯/totality/能力并集）、
  server-worker `system-execution-options.test.ts` 4 例 + `system-provider-projections.test.ts` 3 例
  （目录状态/零秘密/decodeError）+ c8 收敛钉。

- **#322 (W5) 图片 B2——generate_image edge 工具（依赖 B1；图像源 env 与 #305 交汇）**：
  agent-do 注册 `generate_image`（omp imageGenTool 18.6.0 verbatim 移植——schema
  /prompt/assemblePrompt/尺寸映射逐锚点；omp custom tool 位次：最后 builtin 之后、
  隐藏 yield 之前）并归类 edge do-local（分类表 §2 先例：图像 API 出站）。① 门：
  omp `generate_image.enabled`（默认 false）→ `AGENT_DO_GENERATE_IMAGE` env 闸
  （#150 第六闸）；图像源 `AGENT_DO_IMAGE_SOURCE` JSON {baseUrl, apiKey, model,
  timeoutSeconds?}——openai-images 传输族（/images/generations 与
  /images/edits `input_references` + 404 回落，omp openai-images.ts JSON 分支；
  OpenAI multipart 分支不移植——配置源面向 relay 型 JSON 端点），响应 b64_json/
  url 下载、media_type→魔数嗅探→png 兜底（pi-utils parseImageMetadata 的
  workerd 端口）。② 落盘：omp edge 即本机（写 OS tmpdir），本栈 DO≠宿主——
  新 host-rpc 命令 `host.write_file`（B1 `host.read_file` 的写孪生）：
  daemon 侧解析 `<sandboxRoot>/<threadId>/Generated/`（bb staging 纪律端口——
  文件名 sanitize、`-N` 去重、0600、threadId 单段断言、10MB 图上限、
  base64 完整性门），应答绝对路径。③ 事件链：EdgeToolResult.images →
  executeEdgeLocal 载入 ToolResultPayload → ingestResult 逐图落 imageView
  （parentToolCallId=call executionId，B1 链复用；timeline image-view 行 +
  host-files/content lightbox 即刻点亮）。`input[].path` 经 B1 读面解析
  （绝对路径/10MB/ENOENT→omp 同文）；`data` inline 与 data: URL 同 omp。
  取消走 web_search abort-as-cancelled 词汇；重放幂等由 edge 执行铁律承担。
  测试：agent-do `generate-image.test.ts` 16 例（verbatim 面、配置解码、传输
  分支、保存腿、imageView 折叠、重放零二fetch）、T26 矩阵行、daemon-service
  `host-files.test.ts` 写面 7 例 + socket glue。
- **#321 (W5) 图片 B1——imageView 事件链 + host-file content face（依赖 A3 通道，独立于 A4）**：
  ① journal additive `imageView` 事件（`fsm-events.ts`，G9 载体补齐）：`ingestResult`
  在 tool.result 落行前按结果载荷的 `images`（`ToolResultPayload.images` additive，
  daemon-service `toolResultPayloadSchema.images` 同形过线）逐图落 `imageView`
  {turnId, parentToolCallId=call executionId, path}——todo_phases
  journal-before-result 位序，executionTerminal 守卫即幂等。② ux 投影：一行折叠成
  bb 生命周期对（`item/started`+`item/completed` 同 seq——thread/compacted extraUx
  先例），item 形状 `imageViewItemSchema`（protocol union additive，bb
  threadEventImageViewItemSchema verbatim：无 status，生命周期在事件类型里）。
  ③ timeline `image-view` 行生产者（G7 断点补上）：`projectTimelineRows` 从
  item/started 立 pending 行（callId=item.id，bb web-activity-lifecycle
  callId 语义）、item/completed 收口（path 刷新 + completedAt），turn 扫尾
  pending 即封（tool 行同法）；SPA `ImageViewWorkRowBody` 图行 + lightbox
  由钉版 SPA 自带，src 即本 face。④ `GET /threads/:id/host-files/content`
  （README §1 files face 9 路由的最小子集，只开 content 读）：bb data.ts:660-682
  verbatim——宿主解析按本栈 #318 姿态（绑定 environment 宿主，缺省部署机），
  host-rpc `host.read_file`（#302 通道 additive；daemon 侧 bb readHostFile
  rootless 子集 verbatim：绝对路径断言、目录拒绝、图 10MB/非图 25MB 双上限、
  image base64/其余 utf8-else-base64、sha256/mtime；mime 为 mime-types 端口
  截断表，未中即 octet-stream）；响应侧 bb daemon-file-response 移植
  （ENOENT→404/invalid_path→400/file_too_large→413）。测试：agent-do
  `image-view.test.ts` 5 例（journal→ux→timeline 全链、重放稳定、producer
  幂等）、daemon-service `host-files.test.ts`（bun 真 fs 语义）+
  `l1-host-read-file.test.ts`（DO 线）、server-worker
  `timeline-image-view.test.ts` + `host-files-content.test.ts`。
- **#328 (W5) 矩阵 C3——工具批并行调度 + 同文件互斥（pi E2 对应物）**：
  agent-do 工具批此前无批内调度语义——`Effect.forEach` unbounded 并发派发，
  同文件 write/write、read/write 全部裸跑并发（比 pi 的两条语义都少）。新增
  `tools/batch-scheduler.ts` 纯函数调度器 + registry 行级 `schedule` 分类
  （`read`＝按 path 键控的只读面：read/glob/grep/find；`detached`＝与批内
  无共享面：think/web_search + 阻塞型 wait/ask——t19 的
  `[wait, write proc://<job>/kill]` photo-finish 批必须同波派发才收敛；
  `exclusive`＝变更面/未知面：同键冲突、无键（bash/task/eval/mcp 等全部
  无键尾）整批 barrier）。turnProgram 批循环改波次推进：冲突感知分波、
  波内并发派发、波间等全部终态再派下一波——只读批整波并行，同文件
  写写/读写冲突按模型 call 序串行化（pi agent-loop 默认 parallel +
  file-mutation-queue 同文件写互斥的调度层移植，锚
  badlogic/pi-mono agent/agent-loop.ts:514-529 + coding-agent
  tools/file-mutation-queue.ts）。键 = journaled 调用参数的词法归一
  （`./`/重复斜杠折叠、read 行选择器剥离、edit 取 hashline input 首行），
  纯确定性——重放/看门狗重问重算同一波次；DO 无 fs，归一不到的拼写给
  的是过度串行而非漏互斥。波间取消收敛：取消落在波间时未派发波在 DO 内
  补 `tool.result{cancelled}` 封账（未派发执行无 daemon 痕迹——kill 对未知
  id no-op、看门狗 re-ask 依赖 dispatch 行，不封账则永久悬空）。
  recovery Ruling E 同步走波序（`redispatchScheduled` 分离驱动：波内
  并发 re-ask、波间等终态，wait/ask 照旧分离派发）——互斥跨驱逐存活；
  稳态 at-least-once re-ask 语义不变（service journal 按 executionId
  去重）。测试：agent-do `batch-scheduler.test.ts` 24 例（分类/键提取/
  冲突表/波次布局）+ `batch-parallel.test.ts` 6 例（L1 只读批并行计时
  断言：波内 dispatch 与 settle 展布均 < 单个伪工具时延，串行计划下
  两者展布 ≥ 3×；同文件写写/读写串行化 seq 序断言；异文件写并行；波间
  取消封账；驱逐后 recovery 波序重问无双 spawn）+ registry 形状/分类
  2 例。
- **#320 (W5) 图片 A5——SPA 渲染面回接（依赖 #316-A4；SPA 零新码）**：
  timeline 投影喂上唯一断点——`projectTimelineRows` 的 userMessage 行
  `attachments: null` 三处硬编码中仅用户行是真缺口（assistant 行 upstream
  verbatim null，build-thread-timeline.ts:573），按 bb user-message-parsing
  `parsePromptInput` 计数 + `toConversationAttachments` 填充移植
  `conversationAttachmentsOf`：`image` 计 webImages 收 imageUrls、
  `localImage`/`localFile` 计数收 server 管理路径；无附件部件回 null（保留
  M0 存量行形状；upstream 的零计数对象 SPA 渲染等价
  ConversationAttachments.tsx:128 早退）。钉版 SPA 渲染面由此点亮：
  ConversationAttachments 缩略图/文件 chip + lightbox「点开见原图」走
  `toUserAttachmentImageSrc` → `GET /projects/:id/attachments/content`
  （#316 A1 读面，mime 回填），outline `attachmentSummary` 计数通路
  （#304 G7「已在」）随喂值自动生效。测试：server-worker
  `timeline-attachments.test.ts` 5 例（create/send 两面喂值、text-only null、
  绝对路径直通计数、outline 摘要派生）。
- **#319 (W5) 图片 A4——模型消费 image block + 能力位 + 降级（依赖 #318 A3）**：
  ① relay 图块：`AnthropicImageBlock`（Anthropic vision source——`url` http(s) 直通 /
  `base64`（data: URI 解码，media type 限 jpeg/png/gif/webp））入 `AnthropicUserBlock`。
  ② 模型 seam：`ImageContribution{url|data|path}`——translate 按 journal content 分类
  （http(s)→url、合法 data:→data、其余（staged 路径/`file:` URI/非法 data:）→path；
  text/localFile 不产图），`ModelRequest.inputImages` / `PriorTurnHistory.images` /
  `SteerContribution.images` 三位随请求走；**image-only turn 合法化**——A2 时代
  `turn.input has empty text` 投影崩溃修复（text 投影跳过非 text 部件不再留空行占位，
  wire 不渲染空文本块——上游 400 面）。③ 消费分派：`WireCallOptions.supportsImageInput`
  （`RelayConfig` 透传）——支持视觉的 relay 收 url/data 真 image block；不支持的收降级
  文本（acp bridge.ts:1131-1153 锚形：`[image attachment on disk: path]` /
  `[image attachment: url]` / `[image attachment: inline <mime>]`）；path 类无论能力位
  一律降级（DO 无到 staging 宿主的字节通道）。④ 能力位 `supportsImageInput`：
  daemon-worker `ProviderCapabilities` 接口 + server contract zod schema + fake provider
  （true）；部署声明 env `MODEL_RELAY_IMAGE_INPUT`（1/true/on，默认关——误开会在首个
  图片 turn 吃上游 400，opt-in）；provider-app harness 解析、入 fingerprint/HarnessProjection
  （翻转→live drift）、`EdgeAgentProviderAdapter.capabilities` 镜像同一裁决；server
  `/system/execution-options` 同源投影。⑤ 历史图片管理（strip/clamp）评估：rewind/compact
  cut 折叠已让隐藏 span 的图片（随 turn.input）整体离开请求——M0 无需额外 per-image
  strip/clamp，观察真实用量后再议。测试：agent-do `image-consumption.test.ts` 12 例
  （fold 分类/image-only 合法/prior+steer 携图/wire 能力分派两侧/降级锚形精确/
  relay 透传/DO 端到端 image-only turn）+ provider-app harness/adapter 3 例 +
  server execution-options 1 例。
- **#318 (W5) 图片 A3——daemon 取件通道 + staging 落盘 + 失败清理（依赖 #316 A1、#317 A2）**：
  daemon-service 三件（bb `prompt-attachments.ts`/`server-client.ts`/`internal/session` 语义照搬，
  适配 #316 R2 存储面）。① 取件通道：daemon face 新路由
  `GET /internal/session/project-attachment-content`（Bearer hostKey 三级 auth ladder → DO
  `verifyAttachmentSession` 活会话绑定 → 部署桥 `readProjectAttachment`——组合入口以
  `projectAttachmentReader` 落 D1 thread→project / thread→bound-host 交叉校验（bb 403 判词
  verbatim）+ R2 读）；客户端 `project-attachments.ts`：HTTPS 强制（loopback 放宽）、
  content-length/字节流双重校验（bb server-client.ts:203-296/397-435 verbatim）。② staging：
  `prompt-attachments.ts` 移植——相对路径 `localImage/localFile` 落
  `<sandboxRoot>/<threadId>/Attachments/`（sanitize + `-2` 去重后缀 + 0600，限额图 10MB/文件
  25MB 与服务端同值，localFile `sizeBytes` 对账，逃逸 threadId → `invalid_path`）；成功后文件
  常驻（thread storage），仅 staging 失败 / execute 崩溃全量清理（bb cleanupAfterPostStagingFailure）。
  ③ 派发面：`tool.exec` 帧增 additive `attachments{projectId, items}` leg（#317 契约词汇子集，
  协议层抽出 `localImageContentSchema/localFileContentSchema` 成员复用），
  `dispatchToolExec` 在工具执行前 staging，取件失败回 `tool.exited` 业务 error
  （`attachment_unavailable` upstream 判词），拒绝-spawn 语义不背锅。测试：workerd
  `l1-attachment-pickup.test.ts` 6 例（401/422/403 会话绑定/桥字节/桥拒绝映射/无桥 500）+
  bun `l1-prompt-attachments.test.ts` 10 例（staging 路径+0600+去重+直通透传+失败清理+限额+
  尺寸对账+先验限额+逃逸 + 派发接线两态）+ server-worker `attachment-pickup.test.ts` 4 例
  （桥 D1/R2 端到端 + 两 403 判词 + A1 404 映射）。
- **#326 (W5) 矩阵漏项 C1——上下文溢出压缩重试（overflow compact-and-retry，依赖 #309）**：
  超窗不再裸失败。两个自动面共用 #309 的压缩数据面（同一个 `compact-` turn 形状、
  同一个 cut planner、同一条 `thread/compacted` checkpoint）：
  ① 反应面——provider 首字节前拒绝且报文点名上下文窗口（Anthropic
  `prompt is too long` / OpenAI `context_length_exceeded` / `maximum context length`
  三类锚定形状，`isContextOverflowFailure`）→ 该 turn 诚实落
  `turn.failed{reason: context_overflow}`，随后自动 compact turn（`method: "auto"`，
  复用 `runCompactTurnCore`）落 checkpoint，原输入以 `inputId#compact-retry`
  新 turn 重驱；cut 用 `planRetryCut` 阶梯（keepRecent → 半额 → 最小保留，
  应对估算器低估图片等盲区），全程 turn 边界切分、tool pair 不可分。
  ② 前摄面——turn 完成后 `shouldCompact` 门（pi compaction.ts:264-270 阈值，
  `projectedContextTokens` 以 usage 回执为锚、回执后行 bytes/4 估算、
  checkpoint 比 receipt 新时以其 `tokensAfter` 为锚防幻影重触发），跨
  window−reserve 即在两 turn 之间自动压缩。配置走 WatchdogConfig 补丁
  （`autoCompactionEnabled` 默认开 / `autoCompactionReserveTokens` 16384 /
  `autoCompactionKeepRecentTokens` 20000）；`turnFailedReasonSchema` 增
  `context_overflow`，journal/protocol `thread/compacted.method` 增 `"auto"`；
  compact 面派生移入 `translate.ts`（`compact-` inputId → `toolSurface:
  "compaction"`，replay 确定性，toolChoice 先例），DO 侧对 compact 调用跳过
  MCP tools/list；冷启动恢复对 queued compact turn 走 `resumeCompactTurn`
  （重推 cut→补 checkpoint，不再误入 agent turnProgram）。测试：
  `overflow-compact.test.ts` 17 例（反应面 campaign——失败原因/自动 marker/
  retry 完成对拍/隐藏 span 零泄漏/I11 计费守恒/ux 面、前摄面跨阈值触发与
  低阈值不触发、L1 配对不变断言——planner 阶梯与 marker journal 重投影
  双面、门禁两例——关闸保持裸 model_error、非溢出拒绝不劫持）。
- **#317 (W5) 图片 A2——协议 image union + 422 门解锁 + 引用校验（依赖 #316 A1 keystone）**：
  ① 协议 additive：`promptContentSchema` 增 `image{url}/localImage{path}/localFile{path,name?,sizeBytes?,mimeType?}`
  （契约词汇镜像 `promptInputSchema`，去 HTTP 层 visibility 字段——journal 载运行时真值），
  ux 投影 `userMessage` content 原样穿透；`translate.ts`/`task/child-run.ts` 的
  模型可见文本投影按 bb timeline `textOfContent` 同款语义跳过非 text 部分。
  ② 422 门解锁：`POST /threads`（create-with-input）与 `POST /threads/:id/send` 的
  「Unsupported prompt input type for M0」门移除，union 成员 verbatim 入 DO journal。
  ③ 相对路径引用校验（`validatePromptAttachmentReferences` 移植，bb
  `pathLooksRuntimeReadable` 判直通）：`localImage/localFile` 相对路径＝服务器管理的
  附件引用——先 containment（逃逸家族 400 `escapes project directory`）、再存在性
  （R2 family head 未命中 400 `was not uploaded`）；绝对路径与 URI-like 值直通 runtime
  不校验。校验在 create 任意写入之前（4xx 零孤儿行）。④ 组合链同步：provider-app
  manager `textInputsOf` → `promptContentOf`（union 直通，空输入仍 invalid_input），
  daemon seam `sendMessage` content 类型放宽为 `PromptContent[]`。测试：协议 union
  parse/拒绝 3 例 + `prompt-attachment-input.test.ts` 6 例（带图 input 201 + journal
  落 union、URL/绝对/file:// 直通、localFile 呈现字段、逃逸 400、未上传 400、send 面
  同规则）。
- **#313 (W5) AgentDO×compaction 的 API 压测——context 行为真空补齐（本地先行）**：
  `packages/agent-do/test/compaction-stress.test.ts`（8 例，默认套件=CI 常设）：
  一条 12 turn / 20 model call 的确定性 mock 中继 API 压测campaign，跑通
  「上下文持续增长→压缩检查点→turn 连续性→journal 不变量→DO 驱逐重水化」
  全链——KB 级载荷先单调推高会话上下文（#228 priorTurns），中段
  checkpoint→exploration→rewind 落 cut A（#147 封印断言 + token 上限断言），
  后续 turn 断言 branch summary 武装且 hidden span 零泄漏；campaign 中段
  `abortAllDurableObjects()` 驱逐演练（journal 前缀指纹恒等、checkpoint/rewind
  状态机与 active-branch 分割跨重水化逐字段一致、驱逐后 cutB/sig/postB1 无断
  续跑）；cut B 重武装断言最新对取代语义（单活跃分支）；`new_context` 信号行
  journal 化且 replay 可导（T1 面，rolloverRequestedInTurn 仅信号 turn 为真）；
  逐 call 对拍 captured === final-log 重投影（#116 语义）。压测钉出多压缩对
  回放投影缺口（历史请求丢当时 armed cut、hidden span 经 priorTurns 回归）并
  pin 之（live 行为零影响），立项 #325；harness 即其回归门。
- **#291 (P1) workspace 绑定可见面 + 悬置呈现（盘点 #282 §2.D D1-D3，依赖票 1 #288）**：
  D1 读面（thread 详情 `environmentId` + `include=environment,host`、`GET
/environments(:id)`、`GET /hosts`、列表内联绑定四字段）由 #288 落地；本票落
  D2 悬置呈现 + D3 UI 词汇，钉死 bb SPA 零改动。① §9.3 行 4 诚实宿主面：
  `resolveThreadRuntimeStateAsync`——无活跃 turn（status ∉ {active, stopping}）
  ∧ 绑定宿主（environments.host_id）离线（daemon-service DO hostLiveness
  读时派生）→ bb `host-reconnecting`（expiry 恒 null）；`waiting-for-host`
  永不发出（该面锁 composer 到 stop-only，违反 #73 消息可发——host-reconnecting
  面 = 横幅 + 排队 composer，正是半停语义）。行 1-3 原样保持：active/stopping
  行恒回声、无横幅抢占（#148 thr_jk45qe4786 回归守卫延续）。② 读面全覆盖：
  详情（GET/PATCH/rebind/pin/read 全走 `toThreadResponseWithSpawnCheck`）、
  列表（`toThreadListEntries` 按 DISTINCT host 各一次 DO RPC，零 N+1）、
  搜索两组、项目详情 threads。③ 实时面：turn 结算既有 `status-changed`
  immediate-refetch 挂横幅（悬置 turn 结束即显）；host 恢复走 host-connected
  帧 + 下次读（bb 上游同款 eventual，零新帧词汇）。④ D3 词汇锚定：CONTEXT.md
  执行悬置词条补 SPA 呈现词汇行。测试：`thread-suspension-face.test.ts` 8 例
  （解析器四态/行 1-3 守卫/悬置 turn 结算后横幅/列表同面/attach 清面/绑定源）；
  server-worker 32 files/159 green，根 lint + typecheck 绿。
- **#289 (P2) host:path 参数级覆盖 + 偏差记录（盘点 #282 §2.B B1–B5，依赖票 1 #288）**：
  ① B1 覆盖语法与解析：`tools/host-path.ts` 纯解析器——host 类工具的 path 参数
  可写 `ssh://<machineId>/<path>`（read/write/find `path`、glob/grep `;` 分隔多段、
  bash `cwd`、edit `input` 内嵌扫描），一次调用整机换乘；`user@`/`:port` 显式拒绝
  （本系统目标是注册表机器身份，无 OpenSSH transport）；混合 host 显式报错不拆分。
  ② B2 单次派发换乘 + 偏差行：`dispatchExecution` 解析出覆盖时该次派发的
  `machineId` 换乘目标机（`daemonFor(machineId)`，帧 machineId 腿已有字段零协议
  变更），`tool.dispatch` 增 additive 可选 `overriddenMachineId` 偏差字段（绑定
  永不重写，下一次派发回到 `state.machineId`；重放 fold 忽略、旧 journal 兼容）；
  同机改写（`ssh://<bound>/…`）不算偏差。③ B3 显式失败不降级：目标 host 无行/
  已注销 → `unknown_host`，目标离线 → `host_offline`（结果文本具名目标机），
  永不静默回退绑定机；override 目标离线不再点亮 turn 级 `host_lost`（绑定机
  在线时诚实继续）。④ B4 权限档（远端强制 exec 档）：覆盖是 exec 类操作，门在
  TARGET host 的 `max_permission_mode` ceiling——非 `full` 在解析远端 DO stub
  之前 `exec_tier_required` 硬拒（连接前硬拒，永不触达目标）；registry 读失败
  `registry_unavailable` fail-closed；registry 未绑定的部署（rig/standalone）由
  目标 service DO 的 session/machineId 校验兜底。omp 按审批 UI 分工具（ungated
  tools 连接前硬拒）的差异点：本系统无 per-tool 审批 UI，ceiling 门在派发路径上
  统一生效，安全契约「read/write 档无 exec 授权永不连接远端」对全部工具按构造
  成立。⑤ B5 bash per-call `cwd` 逃生舱纳入统一语义：`cwd: "ssh://host/sub"` 整
  调用换乘，daemon 客户端零改动（统一语义住路由层共享解析器；目标机 sandbox
  钳制照旧生效，绝对 cwd 逃逸照旧拒绝）。测试：`host-path-override.test.ts`
  17 例（语法/逐工具字段映射/edit 扫描/换乘路由+偏差行+绑定存活/同机改写无偏差/
  混合 host 直错无 dispatch 行/unknown_host/exec_tier_required 不触达目标/
  registry fail-closed/override 离线偏差行且无 host_lost）；fake journal dispatch
  行增 machineId/tool/argumentsJson（镜像真 service DO 行，路由可断言）。
- **#288 workspace 绑定喂值链 + environments 数据模型（盘点 #282 §2.A 票 1）**：
  ① 数据模型：`0002_environments.sql` 落 bb 锚形 environments 表（`(project_id,
host_id NOT NULL, path)` 唯一 + workspace_provision_type + status，两源地图
  §1.1）；test/migrate.ts 按文件序应用全部迁移。② 解析函数：`resolveThreadBinding`
  （services/thread-binding.ts）在 server-worker 创建路径一次解析绑定来源链——thread
  显式 host/reuse 选择 > project 级默认源 checkout（`project_sources.is_default`，
  层文档 §6 留白的字段形状按既有 producer 落地）> 部署默认单机（§2.3 零 D1：
  `ORCHESTRATOR_HOST_ID ?? "local"`，不落行、不查 fleet 注册表）；managed-worktree
  显式 422（供给另票，盘点 §4 留注）。解析一次喂两半：environments 行
  find-or-create → `threads.environment_id`（createThreadRecord/rebind 落库）+
  `thread.created.machineId` 冻结轨迹（直接 DO 路径与组合路径 thread/start 均喂
  `command.machineId`，manager 优先取之、harness hostBinding 兜底——执行绑定与 D1
  绑定由同一次解析对账）。③ 显式换绑：`thread.rebound` 轨迹事件（fsm-events 词汇 +
  turn-state 重放迁移 `state.machineId` + AgentDO `rebindThread` RPC，同目标幂等），
  `POST /threads/:id/environment` 为 owner 操作面（更新行 + 事件 + hub
  environment-changed；ux 投影与 translate/task 家族按 thread-scoped 不渲染穿透）。
  ④ 喂值链读面：`GET /environments?projectId=`、`GET /environments/:id` 最小集；
  thread 详情 `include=environment,host` 真解析（bb buildThreadResponse 锚形）；
  线程列表 LEFT JOIN environments 带出 environmentHostId/Name/BranchName/display
  kind（bb threadWithPendingInteractionBaseQuery 锚形，替换 M0 硬编码 null）；
  protocol ThreadSummary 增 environmentId/环境/host 内联可选字段、
  createThreadRequestSchema 增 environment、HTTP_ROUTES 登记两条 environments 路由。
  ⑤ 协议漂移回迁（盘点 A5）：workspace/environment 绑定词汇（含 gitBranchNameSchema
  校验器）唯一定居于 @cap/protocol，server-worker shared.ts 改为 re-export。⑥ 帧
  字段协调（盘点 C1）：`tool.exec`/`exec.spawn` 增可选 `workspace` 标识，缺省回退
  sandbox（双帧方向向后兼容），票 3 在此之上落 per-workspace ToolHost。
- **#290 (P1) daemon 多工作区——`tool.exec`/`exec.spawn` 帧携带 workspace 绑定 +
  per-workspace ToolHost 键控表 + path 漂移显式失败（盘点 #282 §2.C C1–C4）**：
  daemon 此前一进程一工作区（`--sandbox` 单例 ToolRuntime）。① C1 帧语义：
  `workspaceRefSchema{id,path}` 可选字段进 `tool.exec`/`exec.spawn` 帧与
  `ToolDispatchRequest` seam（生产者是绑定喂值链 keystone #282 §2.A，未落地前恒
  缺省＝回退 sandbox，向后兼容独立可落）；service DO journal `dispatch` 行增
  `workspaceJson`（replay-is-truth：spawn watchdog 重发从 journal 重建同一帧，
  旧 journal 行缺字段 fold 时 `?? null` 钳制）。② C2 键控表：`ToolRuntime`
  内 `workspaces: Map<id, {path, hostPromise}>`——每 workspace 一个完整
  `createToolHost`（各自 `Settings.loadIsolated({cwd})`，per-project settings，
  不同于 T20 viewFor 同项目 worktree 共享 base settings 的粒度）；隔离管理器仍
  sandbox 作用域（isolationOp 无 workspace 腿），workspace 帧绕行。③ C3 漂移：
  已注册 id 携不同 path → 结构化错误结果 `workspace_type_mismatch`（bb
  `ensureEnvironment` 锚形，双 path 具名），永不静默改道；未注册 id 仅在 path
  存在且为目录时注册（unmanaged 语义：只验证不 provision），失败不粘连 id。
  错误走 tool.exited error-result（同 mis-route 守卫形状）——service waiter 只在
  tool.exited 上 resolve，rejected dispatch 会把 run 挂到超时。④ C4 单例审计：
  host 构建进程级串行链（base + 各 workspace 共用——`installAgentAuth` 写共享
  models.yml、`setAgentDir` 全局重钉均值幂等但并发会交错写文件）；omp resolver
  冻结无碍（每 host 构建先重钉同一 daemon-private agentDir）；eval kernel 模块级
  注册表按 (cwd, sessionId, interpreter) 键控——workspace 各自 cwd 天然隔离，
  `EvalKernelRuntime` 仍每进程一个、确定性从 sandbox root 播种（`Settings.init`
  全局单例 first-wins）。Executor spawn 增可选 root 参数（cwd 钳制按帧根）。
  测试：Bun `l1-workspace-semantics.test.ts` 8 例（同相对路径三根各归其位/
  缺省回退/写落位/bash per-workspace cwd/漂移显式失败且原绑定存活/ghost path
  失败不粘连/Executor root 覆写+逃逸拒绝）；Workers `l1-workspace-relay.test.ts`
  4 例（forward 带 ref/journal 记录/缺省 null/watchdog 重发重建+journal 逐字节
  过驱逐重放）。
- **#276 J5 子代活动/CoT 回父——`task.subagent_event` 包装行（journal-first）+ CoT
  终局行档 1**：#256 G4 的 journal-first 臂。① journal 化：`task.subagent_event`
  包装行（omp `subagent_event` 帧同构：child 事件摘要 unit + 外层 spawn 锚），由子 DO
  的 turn 边界 flush（`advanceChildRunOnce` 门处，`tools/task/activity-flush.ts`
  journal 纯折：thinking 按模型调用累积、message 按 call_completed、tool 派发/结果成对，
  统一 INLINE_SUMMARY_CAP_CHARS 截断）经 `reportSubagentActivity` RPC 落到父 journal，
  携带 #274 J1 `parentToolCallId`；幂等三重——子侧 `task.subagent_flush` 游标行
  （RPC 成功后才落，崩溃重派生）、父侧 (spawnId, kind, sourceSeq) 去重、pre-J1 无锚
  不 flush。单一读面、重放稳定、无跨 DO 读穿。② ux 投影：包装行就地展开成归父 ux 行
  （toolCall 派发/完成、per-call CoT 终局、per-call 回答文本，全部 `parentToolCallId`
  挂锚），server J4 `childRows` 聚合即得委派行展开子代活动流——零 server/SPA 改动。
  ③ J6 档 1：`model.call_completed` 落 `item/completed` + `reasoning{summary:[],
content:[累积 thinking]}`（`itm-rs-<turnId>:<modelCallId>` 跨完成身份；blob 行不产），
  pin SPA 忽略（零 SPA 改动），上游 #3250 行渲染移植=档 2 另票另裁。回放一致：投影为
  journal 纯函数，全量重投逐字节相等。
- _*#275 J2+J3+J4 委派行投影——task.* 折 spawnAgent 合成行 + backgroundTask 事件族 +
  childRows 聚合_*：ux 投影把 task journal 家族折成委派呈现。① ux-projection：`task.spawn_planned`
  → 合成 `toolCall{spawnAgent}` 委派行（`arguments{senderThreadId, receiverThreadIds,
description, subagent_type}`——徽章数据进合成参数，#229 S1+S3）；`task.spawn_settled`
  blocking（jobId null）走 turn 作用域 `item/completed`，background 走线程作用域终局；
  `task.subagent_aborted` kill/call_signal/wall_clock/internal → interrupted 终局
  （budget 是唯一可复活 abort，行保持 pending），首终局胜出（墓碑抗性）；transport 折叠
  ——native task 工具行不再上 ux 面（#229 §2.3-1，双行即噪音；非 ok tool.result 保留为
  取消防线）；pre-J1 journal（无归父锚）维持旧面。② protocol 增 `backgroundTask` item 与
  线程作用域 `item/backgroundTask/progress|completed`（bb 同名同形：payload 带全量 item
  状态、无 turnId；scope 裁定 thread-event-scope.ts:102-111 既有）；item id 沿 bb 代际
  scheme `task:<spawnId>#<gen>`；parked/revived → progress（paused/running），按 bb
  `CLAUDE_TASK_PROGRESS_THROTTLE_MS` 500ms 节流（journal 时间戳保证重放确定）。③ server
  `projectTimelineRows` 增 delegation 分支：合成行物化为契约 `TimelineDelegationWorkRow`
  （subagentType/description 抽自合成参数），family 终局按 `parentToolCallId` 折入
  output/status（batch 共享裸锚时按 plan 序封首个 pending 行）；#274 J1 归父行
  （toolCall/agentMessage）聚入 `childRows` 不再上顶层；委派行不注册 turn-pending——
  background 行跨 turn 存活，turn/completed 清扫不误封。回放一致：投影为 journal 的纯
  函数，全量重投逐字节相等。
- **#277 验收 lane 接入关账门（#243 图收账）**：PM 循环固化「实现票交付→验收 lane 出证据→才可
  merge/close」序列。`AP.closeout(number, "acceptance-lane"|"ci", { evidence, date?, deploymentVersion })`／
  `AP.closeoutLedger`：仓内 append-only `.pm-closeouts.jsonl`（gitignored，`PM_CLOSEOUTS_PATH` 可改），
  证据三件套（证据锚/日期/部署版本）不全硬拒（零写入，无证据不关票）；勾选权分面——staging 面=验收 lane
  勾票面验收框，纯代码面=CI 勾，PM 抽验降为 wave 终检抽样（#246）不再作为关账输入。`AP.audit` 新增规则 7
  （传 `closeouts: AP.closeoutLedger().events` 才武装）：closeoutNoEvidence——type:implementation/type:bug
  票已交付而无 accepted 台账项=关账门被跳过，修复动作是 `AP.closeout` 回填（#266 首例）或重开票，无 mutation。
  #239 首用范式模板化 `docs/agents/acceptance-lane.md`（grill 三靶 #245＋ephemeral 事实引用 #244＋租约登记
  #240＋证据三件套）。L1：scripts/test/pm-autopilot.test.ts 关账台账／audit 规则 7 两组 11 例。
- **#274 J1 子代理呈现地基——delegation 归父字段 `parentToolCallId`**：protocol 事件面五处
  增补可选 `parentToolCallId`（toolCall/agentMessage/reasoning item 与 `item/agentMessage/
delta`、`item/reasoning/textDelta`）——bb 三家先例的 item 级挂链字段，子代理活动/CoT
  未来挂进委派行的锚点；additive，旧 journal 原样可解析，scheme A 版本常量不动。agent-do
  侧 task 族 journal 同步携带：`task.spawn_planned` 派发处填充（值=task 工具调用的 UX
  item id，即裸 call executionId——batch 逐项 dedup key 带 `#index` 后缀，本字段不带）；
  `task.spawn_settled`/`task.async_result` 从 plan 随行（终局行免 join 归父）；
  `task.subagent_identity` 经 spawn 请求镜像到子 journal（子面自归父，bb child-side
  语义）。L1：protocol schema 解析+往返测试；agent-do task-chain 全链断言（plan/settled/
  async_result/child identity 四行同锚点）。
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
  - 钉版 SPA 真浏览器）：铸码→装命令渲染→倒计时→daemon 以铸码 hostId enroll→
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

- **#496/#500 (W5) 部署通道整尸退役——"\*" 回退缝+HARNESS_DEFAULTS+九 env 标量族全灭
  （用户裁决 2026-10-07/08：no special case、厨房期不兼容借口）**：#496 剥物化纯删——
  无 selection 续跑=422 具名（selection_missing），harness 零 env=诚实 unconfigured（零合成
  默认），FixedReplyProvider 退役为测试夹具；#500 harness.ts 整文件删除（−323 行），残余=
  execution-posture.ts（权限映射常量表+wire 安全兜底 8192/200K）；预算/窗口/图像输入归 D1
  行字段（models 条目 thinkingBudgetTokens 等），权限默认归 permission_mode 单行 seat
  （0008 迁移+GET/PUT /system/permission-mode 热改），机器绑定归 #377 cloud 占位——四层
  叠层各归一个正本，envConfigured 显示门随通道终死。staging：投影 keys=webSearch,catalog、
  permission seat 热改线程面即时、老线程 send 422 具名零 mock 回退。

- **#497 (W5) env+hard code 全量普查——逐项四问判决表**（docs/research/env-hardcode-census.md）：
  27 族合格记档（凭据/拓扑/纯不变量各归所）；7 重设计票（#500-#506）+2 待裁（#507/#508）
  立票全清。方法论=用户哲学「编译/部署期必要性？为何不是无状态解耦单元？禁止一般/默认/特殊
  三层心智叠层」。

- **#501/#502/#503/#504/#505/#506 (W5) census 六清**：#501 watchdog 三层读序→KV 单热改正本
  （env patch 层删）；#502 实验工具闸 env→tool_capabilities D1 seat（0007 迁移+三开关面板
  热应用）；#503 edge-shield 调参 env 面退役（常量即正本，rig 改测试注入）；#504 bb 形状假旋钮
  （DATA_DIR/HOST_DAEMON_PORT）退役（BB_DATA_DIR_LABEL 具名常量）；#505 ACCESS_CHECK_ENABLED
  消除——门态=TEAM_DOMAIN∧AUD 双键在场推导（部署断言升级为退役旗缺席+活 secret 在场双检）；
  #506 APP_EXTRA_ORIGINS→origin_allowlist D1 seat（0008 迁移+25 例矩阵+CORS echo 热改）。

- **#499 (W5) 不可用/缺失模型统一 UX+派发源统一（两半）**：UX 半（PR #510）——发送门前置拦发
  （Submit 置换禁用 "Model unavailable — select a model"）+bb ThreadModelFallbackCard unavailable
  形一键回退（点击=显式改写）+picker 灰显+PATCH /threads/:id 显式改写面（fail-closed）；缺陷半
  （PR #514）——model-less follow-up 派发源从 journal pin（旧 turn 历史回响）统一为线程存档
  override（与 composer 显示同门），死行 422 具名零派发——显示=派发由构造保证。

- **#494 (W5) files/mkdir 移植+族面八裁决**：POST /files/mkdir bb-verbatim 端到端（daemon
  host.mkdir 新命令+真机目录实证），read/write/list/paths/move/remove/previews 八面显式
  501 not_implemented（各有理由）；CT142 daemon 重建半步闭环（house flake update cap→CT119
  构建→CT142 switch）。

- **#450 (W5) env 目录腿退役——D1 provider_configs 成为 LLM provider 唯一正本（用户裁决
  2026-10-07「零 env 回落」）**：`MODEL_RELAY_CATALOG`/`MODEL_RELAY_PROVIDER_CREDENTIALS`
  全链删除（provider-app catalog/relay-registry/harness/manager-do + server-worker
  env/routes/execution-selection + wrangler.staging 播种行），目录=overlay 单源投影
  （`resolveOverlayCatalog`）；零行=诚实空目录（picker 空、无选择 create 422
  provider_default_undeclared，#434 nothing-synthesized），行凭据恒 standalone（部署
  凭据永不回落，防外泄）；`defaultProviderId` 恒 null、`decodeError` 恒 false 保契约形。
  测试面同构收口：rig 从 env binding 改 D1 行播种（真加密凭据+转发式 wire 桩+holdRigWire
  确定性 in-flight 门），15+ 裸 create 站点补显式 rig 选择。staging 实证：零配置空态
  诚实+面板配行（newapi/glm-5.3-flash，AES-GCM 密钥）→ 真 turn 端到端（DOGFOOD-450-OK）；
  PM ops 同窗删三死 secret（MODEL_RELAY_PROVIDER_CREDENTIALS/AGENT_DO_IMAGE_SOURCE/
  AGENT_DO_GENERATE_IMAGE）。

- **#477 (W5) idle 线程永久 "Working..." 指示器——coarse status flip 无守卫复活 active +
  detail 面读 stale 行**：create/send 的 dispatch flip 在瞬封 turn（DO 终局结算先落）后
  重写 active 盖掉 idle，GET /threads/:id（SPA bootstrap 正本）照读 stale 行，而结算广播
  与新页 WS subscribe 竞速丢失（hub 纯易失 fan-out）→ 永久 Working。修复：flip 加
  `expectedStatus`/`expectedUpdatedAt` CAS（sealed turn 永不复活）；detail 面读时结算
  （#52 timeline 面同构，仅 starting/active/stopping 行付 journal 读，幂等+广播）。
  回归：thread-477-detail-settlement 5 例（修复前全红）；staging 三线程真机复验零指示器。

- **#478 (W5) ask 载荷 schema 发散 fail-closed**：omp-verbatim 行 schema 是 DO 载荷 schema
  的真超集（空白串/非整 recommended 过行不过 DO），分歧载荷此前打进 journal 追加的 zod
  parse 抛出 executor → turn driver fiber 中波死 → alarm 重问循环永抛（卡死而非诚实失败，
  违 #436）。修复：`runAskTool` 注册前用与 journal 追加**同一** `pendingInteractionPayloadSchema`
  校验投影载荷，分歧=显式 error tool result（模型可自纠、turn 收敛）——单一 schema 权威，
  未来投影漂移自动被同一道门拦下。纯层 5 形状+DO 集成（空白 id 全 turn 收敛、零注册）双测。

- **#484 (W5) provider 面板 harness 遗像块——envConfigured 门+重标注（用户报）**：#450
  退役部署通道后，投影区残留 "Relay mode: mock / open.bigmodel.cn / glm-5.3" 死通道
  如实投影（零 env=HARNESS_DEFAULTS 合成），被读作"我的 provider 是 mock"。修复：投影
  harness 行增 `envConfigured`（9 变量空白判定），面板块重标注 "Deployment relay
  channel"+legacy 归属文案；**零 env 部署整块不渲染**（测试钉死）。每块正本归属文案
  （provider=D1 行 hot-applied/web_search=D1 可编辑/harness=legacy env）一并理顺。

- **#486 (W5) 线程模型漂移——选 glm-5.3-flash 进线程显 glm-5.3（显示+派发双漂移，用户报）**：
  根因链：bb composer 以 `GET /threads/:id/default-execution-options` 为存档选择种子而
  Worker 端从未实现该路由 → 种子空 → 选择器静默落目录 isDefault 行（#450 后=harness
  glm-5.3）→ follow-up 不带模型 → send 无 ride → 按部署默认派发。修复：新增
  default-execution-options 存档面（存档行过同一合并目录；目录漂移时读面信任存档原文
  返回、无存档返 null——bb 读面 parity，派发半保持 fail-closed 422）；execution-options
  增 selectedOnlyModels 池（存档 override 目录已不含者投影为池行，空目录保持真空 #434）；
  bb picker 池行统一 "Model unavailable" 标注。显式选择永不静默漂移；显示=派发由构造保证。

- **#480 workers.dev 旧域残留清理（1042）**：#412 自定义域接管后
  cap-server-staging.dai-samuel.workers.dev 已死——deploy-staging.yml 探活正本切
  bb-staging.samuka007.com，匿名断言 401→302（edge Access 门在场语义；worker 级 401
  留待 CI Access token 流）；JEV 脚本默认 host/fixture/ops+research 活态文档同步；
  历史记录性提及保留（实测快照/审计记录/spike 数据不改写）。

- **#325 (W5) 多压缩对回放投影丢当时 armed cut——rewindContextCut 补 as-of-call 时间锚**：
  `checkpointRewindState` 增 `beforeSeq` 独占上界（只折 `seq < beforeSeq` 的行），
  `rewindContextCut` 签名增 `modelCallId` 锚（translate.ts 调用点传入当前
  call_started seq）：回放早先 call 的请求按 call 时点选对——更晚的对（仅
  checkpoint、已 rewind、或 rewind turn 未 terminalize）既不武装也不解除当时
  已 armed 的对；cutB 自身 turn 内 completed(A)→active(B)→completed(B) 的状态
  演化在锚下逐 call 精确重建。call 时点锚是无操作（call_started 之后的行尚不
  存在），live 投影零变化。compaction-stress shadow 集清零（20/20 captured ===
  final-log 重投影），pin 测试翻转为正断言（postA1/postA2/cutB#1 重投影
  branchCut = cutA）；session-tree 增双对 as-of 锚单测。
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
- **#295 (P1) staging 部署链缺 D1 迁移步骤——0002 从未应用（#288 走查发现，
  `/api/v1/environments` 500）**：`deploy-staging.sh` 在 `wrangler deploy` 前按
  字典序幂等重放 `apps/server-worker/migrations/*.sql`（`wrangler d1 execute
--remote --file`，任一失败即中止部署；无账本表，幂等 DDL 重放天然吸收 0001
  手工应用基线）；0001/0002 全语句 `IF NOT EXISTS` / 种子 `INSERT OR IGNORE`
  化（幂等契约注记入迁移文件头）；CD 冒烟增 `GET /api/v1/environments` 200
  防回归；迁移 runbook `docs/ops/staging-d1-migrations.md`；测试侧
  `ensureMigrations` 改为与部署相同的全量重放语义，新增
  `migrations-replay.test.ts` 钉幂等契约（已迁移库上重放零错、重复种子/丢行即红）。

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
