# bb SPA UX 面调查：组件/页面/状态与 Access 接入改动面（#19 前置）

> 回答 #19（UX 线：bb SPA 接入 Access 并对假脑打磨基础面）开工前需要知道的 SPA 事实面。只覆盖 SPA 组件/页面/状态侧；wire API 清单由 #18 的契约考古线负责，本文不重复。源码：`/home/nixos/workspace/bb`（独立仓，read-only），调查基于 commit `8473d8c33`（2026-08-29）。所有行号以该版本为准。

## 0. 结论先行

1. **「bb SPA」= `apps/app`（`@bb/app`）**，React 19 + react-router-dom（BrowserRouter）+ TanStack Query v5 + Jotai + Tailwind v4 的 Vite 单页应用；`apps/web` 是营销/connect 站（TanStack Start on Workers），不是本票对象。
2. **SPA 完全没有用户身份逻辑**（无 token 存储、无 Bearer、无登录页）——它假设「同源可信服务端」。Cloudflare Access 前置后 **SPA 侧改动面为零或接近零**；要动的全在部署/边缘侧。
3. **流式渲染不是 SSE/WebSocket 推 token**：事件流落在服务端事件日志（`seq` 单调递增），浏览器靠 WS 上的 `events-appended` 失效信号触发 timeline 窗口的 **delta 重取**（`afterSequence=maxSeq`），流式文本由纯函数投影（`packages/thread-view`）在客户端拼出。假脑只要实现「事件追加 + changed 广播 + timeline delta」这个模型即可。
4. **同源假设是硬编码的**：API base = `window.location.origin`，WS = 同源 `/ws`，Vite `base` 未设（`/`），BrowserRouter 无 basename。Worker Assets 部署必须给深度链接配 SPA fallback（`not_found_handling`）。
5. **M0 裁剪走数据面不走构建面**：插件前端、机器列表、终端等表面全部由 `/system/config` 与服务端 inventory 驱动——假脑返回空 inventory 就等于裁掉了，不需要动 bundle。

## 1. 页面/路由结构与关键组件

### 1.1 路由表

路由常量集中在 `apps/app/src/lib/route-paths.ts`；装配在 `apps/app/src/App.tsx`（`AppRoutes`，216-330 行）：

| 路由 | 组件 | 说明 |
|---|---|---|
| `/` | `SplitWorkspaceRoute` → 新线程 compose | 应用根 = 新建对话（`ROOT_COMPOSE_ROUTE_PATH`） |
| `/threads/:threadId`、`/projects/:projectId/threads/:threadId` | `SplitWorkspaceRoute` → 线程详情 | 个人项目无线程归属前缀（`isProjectlessProjectId`） |
| `/plugins/:pluginId/:panelPath/*` | `SplitWorkspaceRoute` → 插件面板 | 插件自有 UI 挂载点 |
| `/settings`、`/settings/:section`、`/settings/providers/:providerId`、`/settings/plugins(/:pluginId)` | `SettingsView`（lazy） | 设置 |
| `/settings/machines/:hostId` | `MachineSettingsView`（lazy） | 多机 fleet 的单机页 |
| `/projects/:projectId/settings` | `ProjectSettingsView`（lazy） | 项目设置 |
| `/extensions…`（及 legacy `/tools/*` 重定向） | `ToolsView`（lazy） | 插件/技能管理 |
| `/auth/callback` | `AuthCallbackView` | 仅是「OAuth 弹窗完成，可关窗」提示页（`AuthCallbackView.tsx:15-35`） |
| `*` | `SplitWorkspaceRoute`（lazy） | 工作区兜底路由 |

关键结构事实（`SplitWorkspaceRoute.tsx:15-68`）：所有可进分屏工作区的 URL 都匹配同一个外层 `*` 路由，URL 变化只更新 `routeContent`（`new-thread | thread | plugin-panel` 三种 `PaneContent`），**不重挂载分屏树**——插件面板与 compose 状态在路由切换间存活。

### 1.2 状态栈与启动序列

- `main.tsx:31-68`：QueryClient → BrowserRouter → App；错误边界在最外层（查询客户端/路由崩溃也要接住）。
- `App.tsx:332-369`：挂载时并行初始化 `useWebSocket`（实时失效）、主题同步、favicon、`usePluginFrontendBoot`。
- 首屏网络依赖：`/system/config`（`lib/system-config-atoms.ts:18-39` 定义了离线兜底默认值）与 `/sidebar-bootstrap`（`hooks/queries/sidebar-navigation-query.ts:28-34`，返回 `SidebarBootstrapResponse`：个人项目 + 项目列表 + 线程分组）。**假脑要能过第一屏，最少要实现这两个读接口。**

### 1.3 线程列表（侧栏）

- `components/sidebar/AppSidebar.tsx` + `components/sidebar/ProjectList.tsx`：项目分区、置顶树、分区（section）增删改（`ProjectList.tsx:1560-1700` 一带的 mutation）。
- 数据来自 `useThreads`（`hooks/queries/thread-queries.ts:344-363`，`sdk.threads.list`）与 sidebar bootstrap 缓存；订阅 `thread-list` 实时目标。
- 机器视图：`components/sidebar/machineThreadGroups.ts`（按 host 分桶）+ `useHosts`；更新徽标 `SidebarUpdatesBadge.tsx`（依赖 machine inventory）。**这些是 fleet 面，M0 可不喂。**

### 1.4 对话视图与输入框

- 详情壳：`views/thread-detail/ThreadDetailView.tsx`（二级面板/tab 状态机）+ `ThreadDetailHeader` + `ThreadDetailPromptArea`；分屏容器 `SplitThreadArea.tsx`。
- 时间线：`components/thread/timeline/useThreadTimelineController.ts`（加载窗口 + `olderCursor` 向前翻页 + 与最新窗口合并，`mergeLatestTimelineRows` 按 row 签名保身份）；行渲染 `ThreadTimelineRows.tsx` / `ThreadTimelineSurface.tsx`；行类型 fixtures 见 `components/thread/timeline/rows/*`（Turn、Tool、FileChange、Workflow、SystemErrors、UnreadDivider…）。
- 输入框：`components/promptbox/PromptBoxInternal.tsx`（富文本编辑器 + @提及 + 命令触发），`NewThreadComposer.tsx`（根 compose），banner 卡片（`promptbox/banner/*`：待办、prompt mode、workflow 进度、模型回退）。
- 目录小地图：`components/thread/timeline/toc/ThreadTableOfContents.tsx`，数据是 `useThreadConversationOutline`（不分页的全量 user/agent 消息轮廓，`thread-queries.ts:853-880`）。
- 事件→行投影是纯函数包 `packages/thread-view`（`build-thread-timeline.ts`、`assistant-stream-projection.ts`、`buffered-text-projection.ts` 等），CLI 与 Web 共用——流式文本的「拼字」逻辑在这里，不在网络层。

## 2. 数据形状假设：分页/游标/追加模型/乐观更新

### 2.1 线程列表：offset 分页 + 实时失效

- 查询 schema：`packages/server-contract/src/api/threads.ts:675-695`——`limit`/`offset`（字符串数字）+ 各过滤位（`archived`、`sectionId`、`hasParent`、`includeHidden`…）；响应是**裸数组**（`:348`，`threadListResponseSchema = z.array(threadListEntrySchema)`）。
- SPA 实际不滚动加载列表页：`useThreads` 一次拉取靠 `changed` 广播失效刷新（见 2.3）。假脑返回固定数组即可。

### 2.2 时间线：锚点向前翻页 + `afterSequence` delta

- 查询 schema：`server-contract/src/api/threads.ts:723-761`——`segmentLimit`（窗口大小）、`beforeAnchorSeq`+`beforeAnchorId`（**向前翻页锚点游标**，必须成对）、`afterSequence`（客户端已持有的 `maxSeq`）。
- 响应 schema（`:713-721, 862-877`）：`rows` + `maxSeq`（线程事件高水位，append 即 bump）+ `page { kind: "latest"|"older", segmentLimit, returnedSegmentCount, hasOlderRows, olderCursor }` + 可选 `delta`（仅当服务端还能重构客户端窗口时才给「变更行」）。
- 客户端用法（`hooks/queries/thread-queries.ts:767-851`）：`fetchThreadTimeline` 带上一次的 `maxSeq` 请求 delta，`mergeThreadTimelineDelta`/`applyTimelineDelta` 原地合并，**base 过期就整窗重取**；旧数据靠 `olderCursor` 经 `useAutoLoadOlderRows`（`timeline/useAutoLoadOlderRows.ts`，600px 预取余量）滚动预置。
- **append-only 假设的确切位置**：
  - 变更种类枚举含 `events-appended`、`history-rewritten` 等（`packages/domain/src/change-kinds.ts:8-25`）；
  - `events-appended` 只失效 timeline **窗口**与列表行状态，刻意排除「已完成 turn 的展开详情」——`sourceSeqStart..sourceSeqEnd` 是固定区间、完成后不可变（`hooks/cache-owners/cache-invalidation-groups.ts:120-124`；测试注释 `realtime-cache-effects.test.ts:990-992` 标注 W2）；
  - delta 语义成立的前提就是事件日志按 `seq` 只增不删；`history-rewritten`（编辑/compaction）是另一种广播，走全量失效。
- 面向 M0 的含义：**fake-edge 必须真的维护一个单调 `seq`**。给每条流式 token 发 `item/agentMessage/delta` 事件、bump `maxSeq`、广播 `events-appended`，SPA 的流式渲染就成立。

### 2.3 实时层：WS 只传失效信号，不传数据

- `lib/ws.ts:52-93`：同源 `/ws`，`partysocket/ws` 的 ReconnectingWebSocket（无限重连、指数退避 1s→30s）。
- 客户端按目标订阅（`subscribe { target }`），目标类型是九种判别联合：`thread-detail`/`thread-list`/`project-detail`/`project-list`/`environment-*`/`host-*`/`system`（`packages/domain/src/change-kinds.ts:67-117`）。
- 服务端推 `changed` 消息（entity + id + `changes: ChangeKind[]` + metadata）；客户端**宽松解析**（未知字段剥除、未知 change kind 过滤，`ws.ts:144-154`），再由 `hooks/realtime-cache-registry.ts` 的注册表把 change kind 映射到 query key 失效（`events-appended` 是 debounced flush，`:295-299`）。
- 另有三类**瞬态信号**（不失效缓存）：`thread-open`（跨窗打开文件）、`thread-pane-action`、插件 realtime（`ws.ts:108-142`）。
- 终端是独立 WS 通道 `/ws/terminals/:id`（`lib/dev-websocket-url.test.ts:57-60` 的用例即此路径），会话列表/生命周期走 REST + `terminals-changed` 失效。

### 2.4 乐观更新

- 统一模式在 `hooks/mutations/thread-runtime-mutations.ts` 与 `thread-state-mutations.ts`：每个 mutation `onMutate` 开启缓存事务（`begin*Transaction`），失败回滚（`rollback*`）。覆盖：发消息、排队消息增删改序、停线程、置顶/取消、归档、已读状态、分区管理等。
- 发消息的乐观行是**客户端专造 id**：`lib/optimistic-timeline-row.ts`——`optimistic-user-` 前缀，服务端真行到达的重取会自然替换；任何跨快照合并必须把乐观行当非持久（`useThreadTimelineController.ts:10` 引入此判定）。

## 3. 部署假设：base path / 同源 / 配置注入

1. **同源 API 硬编码**：`lib/sdk.ts:4-10` —— `BASE_URL = window.location.origin`（SSR 兜底 `http://localhost`），所有 SDK 调用打同源 `/api/v1/*`（`packages/sdk/src/browser.ts` 只包 transport）。Worker Assets 同源部署与现状完全一致。
2. **根路径 base**：`apps/app/vite.config.ts` 未设 `base`（默认 `/`），`index.html` 资源引用全是绝对路径（`/assets/...`、`/favicon-*.png`）；`main.tsx:62` 的 `<BrowserRouter>` 未传 `basename`。⇒ **必须部署在域名根**；深度链接（如 `/threads/:id` 直开）要求 Assets 配 `not_found_handling = "single-page-application"`（Workers Assets 语义）。
3. **生产静态服务现状**：bb 自己的服务器在生产直接静态服务 `apps/app/dist`（`apps/server/src/start-server.ts:64-68`；launcher 侧 `packages/bb-app/src/launcher.ts:1266-1268` 解析 dist 目录）。换成 Worker Assets 后这个职责整体移交，API 面由 Worker 路由到 fake-edge。
4. **构建产物形态**：`vite build` 后跑 `scripts/precompress-app-dist.mjs` 生成 `.gz`/`.br` 旁车文件（`apps/app/package.json:10`）。Workers Assets 自带压缩，旁车文件无害但可直接不上传。
5. **配置注入点几乎为零**：运行时无环境变量读取；仅 `import.meta.env.DEV` 布尔（favicon 变体，`lib/favicon-color-preference.ts:182-191`）与 dev 专用编译期常量 `__BB_DEV_WS_BROWSER_HOST_PORT__`/`__BB_DEV_APP_BROWSER_HOST_PORT__`（`lib/dev-websocket-url.ts:27-38`，只影响 dev WS 直连 vs Vite 代理；HTTPS/非 dev 端口下一律回退同源 `/ws`）。**没有需要按部署改的 runtime config。**
6. **请求标记头**：所有 SDK fetch 带 `x-bb-app-surface: web|desktop`（`lib/app-surface.ts`，浏览器恒为 `web`；`window.bbDesktop` 存在才 desktop）。fake-edge 可忽略，但做请求指纹对照时要记得它存在。
7. **PWA 资产**：图标/manifest 由构建脚本生成（`generate-pwa-icons.mjs`，八种配色），纯静态，随 dist 一起走。

## 4. 登录/鉴权现状与 Access 最小改动面

### 4.1 现状：零用户身份逻辑

- 全 SPA 无 token 存储、无 `Authorization`/`Bearer`、无登录/登出 UI（`grep` 验证：`sign in` 命中的全部是外部 agent CLI 的引导文案，如 `components/onboarding/OnboardingFlow.tsx:229-231`「bb deliberately does not drive another tool's login」、`UsageLimitsSettingsSection.tsx:45-63`）。
- 唯一鉴权沾边的路由 `/auth/callback` 只渲染「认证完成，可关窗」卡片，供 provider OAuth 弹窗收尾（`AuthCallbackView.tsx:15-35`），不涉及 bb 自身会话。
- 401/403 的处理只有错误文案映射：HTML 响应体 + 401/403 → `"Authentication failed"`（`lib/api.ts:74-77`）；`BbHttpError` 携带 `status`（`packages/sdk/src/response.ts:70-84`）。**没有全局 401 拦截、没有登录跳转**——错误以 toast/行内态呈现。

### 4.2 接入 Cloudflare Access 的最小改动面

结论：**SPA 代码改动为零；全部工作在边缘部署侧**（与 #17/#19 的「Access 前置、Worker 内仅校验 JWT」设计吻合）：

1. Access 应用罩住「整个 origin」：静态资产与 `/api/*`、`/ws` 同一策略。未登录浏览器访问任何页面 → 302 到 Access 邮箱 OTP → 回跳后带 `CF_Authorization` cookie，此后 fetch/WS 自动携带同源 cookie。SPA 感知不到这一层。
2. Worker 侧只需在 API 路径校验 `Cf-Access-Jwt-Assertion`（#18 契约面），SPA 不需要任何配合代码。
3. 两个已验证的兼容细节：
   - WS 握手拿不到 302 渲染——未过 Access 时 socket 直接失败，但 `ReconnectingWebSocket` 无限重连（`ws.ts:62-68`），认证完成后自然连上，无需前端处理。
   - fetch 撞上 Access 登录页 HTML 时，`api.ts` 的 HTML 文档检测把它降级成 "Authentication failed" 文案（`:17, 74-77`），不会把 HTML 当 JSON 解析崩溃。
4. SPA fallback（深度链接）路径同样过 Access，不存在绕行面。
5. 若验收要求「未过 Access 拿不到任何 API 响应」，测试点是直接 `curl` API 路径（无 cookie → 302 到 Access 域），而非 SPA 行为。

## 5. M0 范围外表面的削减清单

削减原则：**SPA 是一个 bundle，App.tsx 全量装配路由；干净的做法是数据面裁剪（假脑返回空集合），不是删代码。**

| 表面 | 驱动数据 | M0 假脑做法 |
|---|---|---|
| 插件系统（Extensions/ToolsView、插件面板路由、`usePluginFrontendBoot`、marketplace） | `/system/config` 的插件 inventory + `plugins-changed`；前端 bundle 由服务端 inventory 过滤后按需加载（`usePluginFrontendBoot.ts:13-19`） | inventory 返回空 ⇒ 不加载任何插件 bundle，面板路由自然无入口 |
| 机器/fleet（`MachineSettingsView`、侧栏机器分组、`SidebarUpdatesBadge`、host-daemon 访问） | `useHosts`、host inventory、`host-changed` | hosts 返回空数组 ⇒ 机器分区消失（`machineThreadGroups.ts:35-57` 对空 hosts 直接无分组） |
| 终端面板（xterm、`/ws/terminals/*`） | `terminals` REST + 独立 WS | 不暴露入口即可；面板仅在二级面板打开时查询（`ThreadDetailView.tsx:643-645` `enabled: isSecondaryPanelOpen`） |
| 语音输入 | `/system/config.voiceTranscriptionEnabled`（`system-config-atoms.ts:37`） | 配 false ⇒ 入口隐藏 |
| Onboarding 引导 | experiment flag（`OnboardingHost` 自门控，`App.tsx:362-364`） | 配置不带 flag ⇒ 不出现 |
| 桌面壳同步（`useDesktopThemeSync`、`bb-desktop` 全局、窗口状态） | `window.bbDesktop` | 浏览器里全部惰性无操作，零成本保留 |
| settings 内的 providers/machines/plugins 分区 | 各自查询 | 不影响核心对话面，留着无害（lazy chunk 不点不加载） |

不需要削的：`apps/web`（营销站）根本不在 SPA 构建里；landing/blog 资产不会进 Worker Assets。

## 6. 对 #19 的开工建议（事实性准备项）

1. **构建管线**：`pnpm --filter @bb/app build` 产出 `apps/app/dist`（含预压缩旁车）；直接把这个目录喂给 Workers Assets 即可，无需改 vite 配置——前提是 Worker 站点部署在域名根且 Assets 配 `not_found_handling = "single-page-application"`。
2. **fake-edge 必须实现的最小读面**（过首屏）：`/system/config`、`/sidebar-bootstrap`、`/api/v1/threads`（列表，数组响应）、`/api/v1/threads/:id` 与 timeline（`rows`+`maxSeq`+`page`，支持 `afterSequence` delta 或老实回全量）、`conversation-outline`。
3. **fake-edge 必须实现的最小写面/实时面**：`threads.spawn/send`（产生事件）、事件日志单调 `seq`、`changed { entity:"thread", changes:["events-appended"...] }` 的 WS `/ws` 广播（宽松 schema，多余字段会被剥除）。流式体验 = delta 事件追加 + debounced timeline 重取，不需要逐 token 的 SSE 通道。
4. **验收路径**：换浏览器重开能看到历史 ⇔ 假脑有持久化（或至少跨请求内存态）且 Access cookie 独立于数据面；「未过 Access 无 API 响应」用无 cookie curl 验证。
5. **注意 x-bb-app-surface 头**与 WS `subscribe` 目标协议（九种 target）要与 #18 契约对齐，SPA 侧会原样发出。
6. 双设备打磨（票内第 4 条）关注点已在 SPA 侧就绪：viewport/safe-area 适配（`index.html` 的 `viewport-fit=cover`）、移动端 recents（`RootComposeMobileRecents.tsx`）、coarse-pointer 尺寸（`shared-ui/coarse-pointer-sizing.ts`）。

> AGENT GENERATED: by zhipu-coding-plan/glm-5.3-flash
