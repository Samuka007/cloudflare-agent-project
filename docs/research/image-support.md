# 图片支持差距盘点：用户发图 / agent 产图两线（#304）

目的：bb 上游图片管线从未盘点过（W2 工具面清单无产图工具、SPA 附件面无消费路径记录），本档补上：上游两线全图 → 本仓逐层现状 → 差距清单 → 切票建议。代码基线 = 本 lane 分支 `lane/304-w5-research-agent`，bb submodule @ `d2ab40f0`。上游形状核对：`git diff d2ab40f ba42654`（新克隆 `/tmp/bb`）对 `packages/server-contract`、`packages/domain`、`packages/thread-view`、`apps/server` **零漂移**，引文即钉版现状。

裁决输入（不重复论证）：`packages/protocol/README.md` §1（files/previews 9 路由 face 全 deferred；projects 组 attachments 计入 ~25 未冻结）；`docs/research/bb-ux-gap-matrix.md` D9（thread-storage files 面休眠，M2「随存量迁移评估 attachment 语义」）；`docs/research/bb-daemon-protocol.md` §2/§4.2（`turn/start` 输入含图片、`/internal/session/project-attachment-content`）；`docs/research/omp-engine-portability.md` §omp 映射（`prompt {message, images?}` / `steer {message, images?}`）。

---

## 1. bb 上游管线全图（两线）

### A 线：用户发图（upload → store → validate → stage → consume → render）

| 环节 | 机制 | 锚点（bb） |
| --- | --- | --- |
| 上传 | `POST /projects/:id/attachments`，multipart 单字段 `file`，201 回 `UploadedPromptAttachment{type:localImage\|localFile, path, name, mimeType?, sizeBytes}`；类型由 mime sniff（`image/*` 前缀）判定 | `apps/server/src/routes/projects.ts:855-884`、`server-contract/src/api/projects.ts:551-560`、`public-api.ts:498-504` |
| 存储 | 服务器本地盘（注释自认「might move to R2/S3」）：`dataDir/attachments/<projectId>/<stem>-<ts>-<rand><ext>`；限额 **图 10MB / 文件 25MB**；文件名 sanitize | `apps/server/src/services/projects/attachments.ts:1-2,21-22,35-50,140-170` |
| 读回/复制/删除 | `GET /projects/:id/attachments/content?path=`（防穿越 resolve，mime 回填）；`POST /projects/:id/attachments/copy`（换项目时搬运草稿附件）；`deleteProjectAttachments` | 同上 `:48-85,172-227`、`routes/projects.ts:886-913` |
| 输入语义 | prompt input `localImage/localFile{path}`：**绝对路径/URI 直通 runtime；相对路径 = 服务器管理的附件引用** | `packages/domain/src/shared-types.ts:306-329`（同形已移植本仓） |
| 发送校验 | server 端 `validatePromptAttachmentReferences`：相对路径引用必须已上传（404 → 400 `attachment ... was not uploaded`）；workspace 相对路径不是合法引用 | `attachments.ts:87-138`（`pathLooksRuntimeReadable` 判直通） |
| server→daemon 取件 | 内部路由 `GET /internal/session/project-attachment-content`，Bearer hostKey + 强制 HTTPS（loopback LAN 明示放宽），content-length/expected 双重字节校验 | `apps/host-daemon/src/server-client.ts:397-424`、`:232-263`；`bb-daemon-protocol.md` §4.2 |
| daemon 落地（staging） | 落到 `<threadStorageRoot>/<threadId>/Attachments/`：sanitize 文件名 + 去重后缀 + 受限 mode；**失败/异常路径全量清理**；错误码 `attachment_unavailable`；image/file 限额与 server 同值 | `apps/host-daemon/src/command-handlers/prompt-attachments.ts:87-97,149-156,216-316`、`command-handlers/thread.ts:66-166,213-252,386-427` |
| runtime 消费（按 provider 分派） | **pi**：readFileSync → base64 + mimeType → 真 vision 输入（`pi/bridge/bridge.ts:920-924`）。**acp**：`session.supportsImageInput` 门——支持则 base64 image block，不支持降级 `[image attachment on disk: path]` 文本（`acp/bridge/bridge.ts:1131-1153`）。**claude-code**：`localAttachmentMarker({kind:"image", path})` 注入带 staging 路径的 marker（CLI 自读盘，`claude-code/bridge/bridge.ts:1979-1981`）。**codex**：原生透传 `{type:"localImage", path}`（`codex/adapter.ts:685-687`；协议原生类型见 `generated/codex-app-server/schema/v2/UserInput.ts`）。**omp 桥**：提取文本+图片 → `prompt{text, images}`（`bb-daemon-protocol.md` §2；omp 原生 `images?` 参数，`omp-engine-portability.md` §映射） | 各 bridge 已列 |
| SPA 捕获 | composer 两入口：剪贴板 paste（clipboard file items → `attachFiles`）+ 文件选择 `input[type=file]`；`useComposerAttachmentUploads` 按草稿管理上传态；换项目自动 `attachments/copy` | `apps/app/src/components/promptbox/PromptBoxInternal.tsx:1763-1773`、`thread/embedded-chat/useComposerAttachmentUploads.ts`、`plugin/PluginNewThreadComposer.tsx:752-756` |
| SPA 预览/渲染 | 草稿缩略图与 timeline 附件图统一走 `toUserAttachmentImageSrc`：http/data/blob 直通 → 项目相对路径 → `GET /projects/:id/attachments/content`；绝对路径 → `file://`（桌面 webview 场景） | `apps/app/src/lib/user-attachment-images.ts:3-25`、`promptbox/AttachmentPreview.tsx`、`thread/timeline/ConversationAttachments.tsx:75-96` |
| timeline 投影 | user 行带 `timelineConversationAttachmentsSchema{webImages,localImages,localFiles,imageUrls[],localImagePaths[],localFilePaths[]}`；outline 小地图带 `attachmentSummary{imageCount,fileCount}`；web 图片（`{type:"image", url}`）直通 URL 渲染 | `server-contract/src/thread-timeline.ts:75-81`、`thread-view/src/build-thread-timeline.ts:387-393`、`threads.ts:867-898` |

### B 线：agent 产图（runtime 事件 → 投影 → 渲染）

| 环节 | 机制 | 锚点（bb） |
| --- | --- | --- |
| imageView 事件 | codex `item/started\|item/completed` 携 `imageView{id, path}` → 域事件 `ThreadEventImageViewItem{type:"imageView", id, path, parentToolCallId?}` | `codex/adapter.test.ts:2630-2684`、`codex/event-translation.ts:695-703`、`domain/src/provider-event.ts:172-180` |
| 投影 → 行 | thread-view 投影出 `image-view` 消息 → `timelineImageViewWorkRowSchema{workKind:"image-view", callId, path, completedAt}`；turn 摘要计 `imageViews`（「Viewed N images」），探索面计数含 imageViews | `thread-view/src/event-projection-message.ts:201-204`、`server-contract/src/thread-timeline.ts:328-336`、`thread-view/src/timeline-view.ts:276-277,560-567` |
| 渲染 | `ImageViewWorkRowBody`：`<img>` + lightbox + 失败降级；src 默认 `buildThreadHostFileContentUrl` → `GET /threads/:id/host-files/content?path=`（server 经 daemon 代理宿主盘文件——**agent 产图落宿主盘，渲染走 host-file face**） | `apps/app/src/components/thread/timeline/TimelineRowDetails.tsx:50-107`、`lib/file-content-urls.ts:60-70` |
| 原生产图（codex `imageGeneration`） | 协议原生 `imageGeneration{id, status, revisedPrompt, result, savedPath?}` ThreadItem 与 `image_generation_call` response item 均在 schema，但**不在** `codexHandledThreadItemSchema` → 翻译为 unhandled 事件——上游自己也尚未渲染原生产图结果 | `generated/codex-app-server/schema/v2/ThreadItem.ts:101`、`codex/schemas.ts:434-462,662-666,686-701`、`event-translation.ts:569-573` |
| 插件/工具产图 | 插件 SDK 输入侧 `localImage/localFile` 带 `visibility` 枚举；插件可带 staged-attachments UI（`plugins/tasks/components/staged-attachments.tsx` 在钉版树内）。omp 侧 `generate_image` 为 **edge 类 xd 设备**：图像 API 出站、产物写盘走 write/daemon——产物以文件面（host-file/storage face）呈现，非 journal 图片事件 | `plugin-sdk/bundled-types/bb-plugin-sdk.d.ts:594-598`；omp 侧 `omp-tool-execution-classification.md:118` |

关联面（两线共用的历史管理）：omp context 管线对历史图片做 strip/clamp/snapcompact 图预算（`compaction-two-source-map.md` §3.1/§3.8）——只有当图片真进入对话历史后才成为本仓议题。

---

## 2. 本仓现状逐层盘点

### 已就位（无需重做）

| 层 | 证据 |
| --- | --- |
| contract 词汇已整包移植：`image/localImage/localFile` prompt input、`imageView` 域事件、`image-view` timeline 行、`uploadedPromptAttachmentSchema`、outline `attachmentSummary` | `apps/server-worker/src/contract/domain/shared-types.ts:270-292`、`provider-event.ts:141-148,164-167`、`contract/thread-timeline.ts:67-74,276-282`、`contract/api/projects.ts:236,511-515`、`contract/api/threads.ts:829-833` |
| daemon seam 的 `PromptInput` 全 union（含 image/localImage/localFile + visibility）与 `input/inputGroups` 载荷位已移植 | `apps/daemon-worker/src/provider-types.ts:132-150`、`provider-adapter.ts:76,108-122`（bb 的翻译钩子明确留在 provider 应用层，`provider-adapter.ts:217-222`） |
| R2 大负载旁路先例（W2-era）：字符串字段超 `r2BypassBytes` 落 R2、行存 `BlobRef{__blob__:{key,size,sha256}}`、读时透明解析、缺绑定显式报错；provider-app 已配 `BLOBS` binding | `packages/agent-do/src/event-log.ts:42-55,135-167`、`fsm-events.ts:20-37`、`apps/provider-app/wrangler.jsonc:13`、`apps/provider-app/src/worker.ts:16-18` |
| outline 数据通路已会消费 attachments（`imageCount/fileCount` 由 `row.attachments` 派生）——只缺生产者 | `apps/server-worker/src/services/timeline.ts:799-820` |

### 缺口清单（按层）

| # | 缺口 | 证据 | 归线 |
| --- | --- | --- | --- |
| G1 | **协议 M0 子集锁死纯文本**：`promptContentSchema` 仅 `text`；send/create 的 `input` 同源 | `packages/protocol/src/events.ts:46-50,60` | A |
| G2 | **server 422 门**：create/send 对非 text 输入显式 `Unsupported prompt input type for M0` | `apps/server-worker/src/routes/threads.ts:331-341,510-519` | A |
| G3 | **agent-do journal 侧纯文本**：`SendMessageRequest.content: {type:"text"}[]`；`turn.requested/steer` content 复用 G1 的 promptContentSchema | `packages/agent-do/src/agent-do.ts:303-306`、`fsm-events.ts:148-156` | A |
| G4 | **附件存储面不存在**：projects 路由组未注册任何 attachments 路由；uploadedPromptAttachmentSchema 是死类型；无对象写路径——现有 R2 旁路仅限**事件字符串字段**（key=`blob/<threadId>/<sha256>`），无 mime/原名/项目域、无按路径取回、无副本/删除语义 | `apps/server-worker/src/app.ts:63-70`、`routes/projects.ts:52-205`（无 attachments）；`event-log.ts:43-50,144-152` | A |
| G5 | **daemon 无取件/落地语义**：daemon-service 帧协议零 attachment/file/blob 面；bb 的 internal 取件（HTTPS/Bearer/字节校验）与 `<threadStorageRoot>/<threadId>/Attachments/` staging（清理、`attachment_unavailable`、限额）全未移植 | `packages/daemon-service/src/protocol.ts`（grep attachment/file/blob 零命中）；上游锚形见 §1 A 线 | A |
| G6 | **模型消费层纯文本**：relay 用户块仅 `AnthropicTextBlock`，无 image block（base64/url source）；`ProviderCapabilities` 无 `supportsImageInput` 位；provider-app adapter 零 image 处理 | `packages/agent-do/src/relay/wire.ts:22-25,154-235`、`apps/daemon-worker/src/provider-types.ts:202-209`、`apps/provider-app/src/adapter.ts`（grep image 零命中） | A |
| G7 | **渲染/取回 face 缺失**：`GET /projects/:id/attachments/content` 与 `GET /threads/:id/host-files/content`（files face 9 路由，README §1 整组 deferred）都无实现；timeline 投影 `attachments: null` 三处硬编码、无 imageView 生产者——上游 SPA（钉版自带 composer 附件 UI + `ImageViewWorkRowBody`）对本仓 server 双双 404/空态 | `services/timeline.ts:281,317,342`；`packages/protocol/README.md:30`；上游 SPA UI 见 §1 | A+B |
| G8 | **工具面无产图工具**：agent-do 工具注册表（ask/edge/host-path/job/registry/session-tree/task/todo/wait/web-search/yield）无 generate_image；M1.5 票集 T1-T26（关账 33 工具面）亦无；omp `generate_image` 是 edge 设备先例（产物写盘 → 文件面呈现） | `packages/agent-do/src/tools/`（目录清单）；`docs/proposals/m15-ticket-set.md:26,61`；`omp-tool-execution-classification.md:118` | B |
| G9 | **journal 事件词汇无 imageView 载体**：`fsm-events.ts` 全集无对应类型（contract 层的 imageView schema 是bb 形状移植，非本仓事件）；即使 G7 的 face 补齐，也没人发 `image-view` 行 | `packages/agent-do/src/fsm-events.ts`（事件类型全集） | B |

结论：**词汇层（contract 类型、daemon seam 类型）已整包移植，「喂值链」从协议到存储到消费到渲染逐层断裂，与 #259 workspace 盘点同构；两条线各自 2-4 张票可成型。**

---

## 3. 切票建议

### A 线：用户发图（依赖顺序即管线顺序）

| 票 | 面 | 内容 | 优先级 | 依赖 |
| --- | --- | --- | --- | --- |
| A1 | R2 附件存储面 | `POST /projects/:id/attachments`（+`copy`/`content` 读回）：对象键项目域（如 `attachment/<projectId>/<sha256>`）、mime/原名/size 元数据、bb 同值限额（图 10MB/文件 25MB）、防穿越 resolve 语义照搬；复用 `BlobRef` 先例但走独立对象族（非事件字符串旁路） | P1 | 无（keystone） |
| A2 | 协议 + 喂值链解锁 | `promptContentSchema` additive 增 `image/localImage`（README §1 additive 原则）；G2 两处 422 门改为按类型放行 + 相对路径附件引用校验（`validatePromptAttachmentReferences` 移植）；agent-do journal additive | P1 | A1 |
| A3 | daemon 取件 + staging | daemon-service 内部取件路由（Bearer/HTTPS/字节校验）+ `<threadStorageRoot>/<threadId>/Attachments/` 落地/清理/`attachment_unavailable` | P2 | A2 |
| A4 | 模型消费 | relay image block（Anthropic vision source）+ `supportsImageInput` 能力位 + 按层降级语义（acp 锚形：不支持 → `[image attachment on disk: path]`）+ 历史图片管理（strip/clamp）评估 | P2 | A3 |
| A5 | SPA 面回接验收 | 零新码预期：钉版 SPA composer/paste/预览/缩略图与 timeline 附件渲染自带，服务端 face 齐后点亮；`resolveUserAttachmentImageSrc` 的 `file://` 分支为桌面场景，本仓 web 部署明确不适用；真 SPA 走查归验收 | P2 | A1-A3 |

### B 线：agent 产图

| 票 | 面 | 内容 | 优先级 | 依赖 |
| --- | --- | --- | --- | --- |
| B1 | imageView 事件链 + host-file face | journal additive `imageView` 事件（含 `parentToolCallId`）→ timeline `image-view` 行生产者 → `GET /threads/:id/host-files/content` 宿主文件代理（README §1 deferred 的 files face 最小子集，只开 content 读） | P2 | 无硬依赖（A3 的 daemon 通道可复用） |
| B2 | 产图工具（可选） | `generate_image` 作 edge 工具：图像模型出站、产物写 thread storage、发 imageView 事件；真实图像源（provider-app relay 路由 / CF AI）是外部前置 | P3 | B1 + 图像源 |
| B3 | codex `imageGeneration` 处理 | 上游自身 unhandled（§1 B 线）；仅当接入 codex 原生 runtime 时立项跟踪上游 | P3 | 观望 |

**不在本档切票**：语音转写（`contract/api/system.ts:108` 的 `SystemVoiceTranscriptionForm` 是移植死类型，属另一 face）；图片进历史后的 compaction 图预算（A4 落地后再评估）。

---

## 4. 验收对照（本票）

- 差距清单成档：本文档 §1（上游全图）+ §2（逐层现状与 G1-G9）。
- 切票建议：§3（A 线 5 张 / B 线 3 张，含优先级与依赖）。
