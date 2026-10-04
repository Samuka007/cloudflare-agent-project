# omp 工具面执行语义分类（#33 M1.5 前置研究）

研究对象：omp 内建工具 33 个（30 内建 + 3 隐藏，考古清单见 [omp-engine-portability.md](./omp-engine-portability.md) §6，commit 锚点 `d4d49e71bef3ac1420d45febf215b951decf5ae9`）。本文回答 #70 三问：①每个工具按执行语义归入 **host（必须宿主执行）/ edge（纯边缘可离线）/ hybrid（混合）**；②每类给出接缝归属建议（daemon 链路 vs AgentDO 本地）；③schema 的照抄来源。

方法：逐工具实读 omp 仓内工具文档（`docs/tools/*.md`，本会话经 `omp://tools/*.md` 镜像可读，与锚点同源）+ 考古文档 §1.9/§6 已付的源码行级证据，交叉定类。本文只做分类与接缝裁定，不复述工具全文。

---

## 0. 结论速览

| 类         | 定义                                                                   | 工具数 | 接缝归属                                                                                                    |
| ---------- | ---------------------------------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------- |
| **host**   | 实现绑定 fs/进程/napi natives；workerd 无对等物                        | **15** | daemon 执行链（omp 自己的 ida broker / `set_host_tools` 回桥是同族先例）                                    |
| **edge**   | 只依赖会话内状态 + 出站网络（fetch/provider 通道）；workerd 可原样承载 | **11** | AgentDO 本地（会话态落 DO storage，出站走原生 fetch）                                                       |
| **hybrid** | 单工具内同时含边缘可承载面与宿主绑定面，需拆缝或选后端                 | **7**  | 拆缝规则：控制/状态面归 DO，执行体（进程/fs/natives）归 daemon；后端可插拔类选 HTTP/DO-storage 后端则边缘化 |

**Essential 13 的分布（M1.5 最关键事实）**：`read/write/bash/edit/glob/find/eval/manage_skill` = 8 host；`task/learn` = 2 hybrid；`wait/context_notes/new_context` = 3 edge。**essential 集合 ≠ 全宿主**——`wait`/`context_notes`/`new_context` 是 DO 原生可承载的，`task` 只有隔离后端一半需要宿主。

**xdev 降级与接缝的交互**：17 个 discoverable 工具在 xdev 开启时摘下 wire 面降为 `xd://` 设备、经 `read`/`write` 传输派发（`xdev.ts:61-67, :228-241`；`read`/`write` 永不摘除）。`write` 是 DO 本地工具 → 设备**派发**天然在 DO 侧；设备**处理器**落哪一侧由该工具的类决定：host 类设备的处理器实现进 daemon，edge 类设备的处理器就在 DO 内。降级机制不改变执行语义分类，只改变 wire 呈现。

---

## 1. 分类定义与判定标准

- **host**：工具体或其唯一实现路径触碰①文件系统（原子写/gitignore 遍历/快照）②子进程/PTY（shell、gh、LSP server、DAP adapter、语言内核）③napi natives（Rust 正则引擎、ast-grep、hashline EditStore、隔离 PAL）。判定依据是 omp 实现的执行面，不是理论可重实现性；`github` 能改写成纯 REST 但 omp 语义是 `gh` 子进程，仍归 host。
- **edge**：工具体的全部副作用是①进程内会话状态（消息树/任务表/journal 条目/作业登记）②出站 HTTPS（自带 fetch）。omp 在终端里跑它们，但没有任何 fs/进程依赖——workerd + DO storage 是同构替代。
- **hybrid**：单工具内两半并存，或后端可插拔导致类随后端漂移。拆缝规则（本文裁定）：**控制面/状态面归 AgentDO，执行体归 daemon 链**；对后端可插拔工具，M1.5 选 HTTP 服务或 DO-storage 后端即可整体边缘化。

provider/LLM 调用（judge、grounding、completion）不计入"执行体"——那是引擎自身的出站通道，任何工具类都一样经它走；只有当工具的**非 LLM 执行体**需要宿主资源时才归 host/hybrid。

---

## 2. 主分类表（33 工具）

Schema 来源列：`T:<file>` = `packages/coding-agent/src/tools/<file>`（ArkType DSL）；`P:<file>` = `packages/coding-agent/src/prompts/tools/<file>`（description 模板）；`D:docs/tools/<file>` = 仓内工具文档（omp://tools/*.md）。schema 与 description 模板是同级资产（考古 §1.9），照抄纪律两者都抄。

### 2.1 host（15）——daemon 执行链

| 工具           | 层           | omp 执行面（证据）                                                                                                                                                                                                                  | schema 来源                                                     |
| -------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `read`         | essential    | fs + 归档/SQLite/二进制/PDF 专项读取器（natives `notebookToEditableText` 等）；URL/内部 URI 子路径为网络读但经宿主 fetch 管道+缓存。`D:docs/tools/read.md`；schema 仅 `path` 一字段，`read.ts:687-689`（考古 §1.9）                 | `T:read.ts` + `P:read.md`                                       |
| `write`        | essential    | fs 原子写（temp/rename）；归档成员/SQLite 行/conflict 解析/x-devices 派发传输。`D:docs/tools/write.md`                                                                                                                              | `T:write.ts` + `P:write.md`                                     |
| `edit`         | essential    | hashline 锚定走 Rust `EditStore`（`crates/pi-edit/`、`crates/pi-natives/src/edit.rs`）；apply_patch/replace 等变体同门。错误文案 "byte-identical" 语义是 Rust 侧资产，TS 祖先在 pi-mono 有底稿（考古死点7）。`D:docs/tools/edit.md` | `T:edit/schemas.ts` + `P:edit.md`（+`crates/pi-edit/prompts/`） |
| `bash`         | essential    | 持久 shell：natives 内嵌 shell/PTY（`natives-shell-pty-process`）；async/ready schema 变体按设置门控（`bash.ts:330-380`，考古 §1.9）。`D:docs/tools/bash.md`                                                                        | `T:bash.ts` + `P:bash.md`（含 `{{#if}}` 设置模板）              |
| `glob`         | essential    | native glob 遍历 + gitignore + fs-scan-cache。`D:docs/tools/glob.md`                                                                                                                                                                | `T:glob.ts` + `P:glob.md`                                       |
| `grep`         | discoverable | Rust regex→PCRE2 降阶引擎（`crates/pi-natives/src/grep.rs`；`docs/natives-text-search-pipeline.md`）；schema `pattern/path?/case?/gitignore?/skip?`（`grep.ts:60-66`，考古 §1.9）。`D:docs/tools/grep.md`                           | `T:grep.ts` + `P:grep.md`                                       |
| `find`         | essential    | jfind 级联：native 词汇索引/IDF（宿主 fs 扫描）+ judge 角色判定（LLM 出站，不计执行体）。判定=host：级联本体是宿主 fs+natives。`D:docs/tools/find.md`                                                                               | `T:jfind/index.ts` + `P:find.md`（+三个 question 模板）         |
| `eval`         | essential    | 保留式子进程内核（Python framed IPC / Bun worker VM）+ fs `%load`/artifact sink；workerd 无子进程/IPC 对等物。`D:docs/tools/eval.md`（§Execution flow/Side effects）                                                                | `T:eval.ts` + `T:eval-backends.ts` + `P:eval.md`                |
| `manage_skill` | essential    | 纯 fs：`<agent-dir>/managed-skills/<name>/SKILL.md` 独占创建/更新/删除 + symlink 逃逸检查。`D:docs/tools/manage_skill.md`                                                                                                           | `T:manage-skill.ts` + `P:manage-skill.md`                       |
| `github`       | discoverable | `Bun.spawn(["gh",…])`（5min 截止/8MiB 捕获）+ pi-natives git（worktree/branch）+ 临时文件。`D:docs/tools/github.md`（§Side Effects）                                                                                                | `T:gh.ts`（op 分派）+ `P:github.md`                             |
| `lsp`          | discoverable | LSP server 子进程 JSON-RPC + fs rename/WorkspaceEdit。`D:docs/tools/lsp.md`                                                                                                                                                         | `T:lsp/types.ts` + `P:lsp.md`                                   |
| `debug`        | discoverable | DAP adapter 进程/socket 传输。`D:docs/tools/debug.md`                                                                                                                                                                               | `T:debug.ts`（action 分派）+ `P:debug.md`                       |
| `ida`          | discoverable | **omp 自身的 daemon-broker 模式**：`omp.ida.<id>` daemon + Python idalib worker + 项目级 broker 共享（`D:docs/tools/ida.md` §Source）。M1.5 daemon 接缝的同族先例                                                                   | `T:ida.ts`（action 分派）+ `P:ida.md`                           |
| `ast_grep`     | discoverable | napi natives（`crates/pi-natives/src/ast.rs`）扫/析/配 + fs 遍历；workerd 不能加载 .node（考古死点7）。`D:docs/tools/ast-grep.md`                                                                                                   | `T:ast-grep.ts` + `P:ast-grep.md`                               |
| `ast_edit`     | discoverable | 同上 natives 改写引擎 + staged 预览（resolve/reject 经 `xd://` 设备）。`D:docs/tools/ast-edit.md`                                                                                                                                   | `T:ast-edit.ts` + `P:ast-edit.md`                               |

### 2.2 edge（11）——AgentDO 本地

| 工具            | 层           | omp 执行面（证据）                                                                                                                                                                                                        | schema 来源                                                |
| --------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `wait`          | essential    | 零参数；阻塞于进程内 async job manager + peer 注册表；无 fs/进程触碰。`D:docs/tools/wait.md`（§Input and availability/Behavior）。CF 语义同构物 = DO 内作业状态 + 跨 DO 消息，天然 DO 原生                                | `T:wait.ts`（无 schema 字段）+ `P:wait.md`                 |
| `context_notes` | essential    | 会话 journal 追加 `experimental_context_notes` 条目（16KiB 上限）；工具体无直接 fs 路径——journal 持久化属会话存储层，CF 侧即 DO storage。`D:docs/tools/context-notes.md`（§Flow）                                         | `T:context-notes.ts` + `P:context-notes.md`                |
| `new_context`   | essential    | 空参数；返回 turn-local rollover 请求，由会话维护生命周期消费；纯进程内生命周期信号。`D:docs/tools/new-context.md`（§Flow）                                                                                               | `T:context-notes.ts`（NewContextTool）+ `P:new-context.md` |
| `todo`          | discoverable | 工具体 **Filesystem: None**（文档明示）；内存相位数组 + 会话条目持久化，`storage: "session"\|"memory"`。`D:docs/tools/todo.md`（§Side Effects）                                                                           | `T:todo.ts`（op 分派 + 状态机）+ `P:todo.md`               |
| `checkpoint`    | discoverable | 会话树操作：消息计数 + journal entry id 边界标记；无 fs/git。`D:docs/tools/checkpoint.md`（§Flow）                                                                                                                        | `T:checkpoint.ts` + `P:checkpoint.md`                      |
| `rewind`        | discoverable | `sessionManager.branchWithSummary` 会话树分支 + 上下文重建；纯会话状态。`D:docs/tools/rewind.md`（§Flow 7-11）                                                                                                            | `T:checkpoint.ts`（RewindTool）+ `P:rewind.md`             |
| `ask`           | discoverable | 需要 prompt-capable UI 面（`context.ui.askDialog`/selector）；无 fs/进程。CF 语义同构物 = SPA 经 WS 的交互请求（bb `interactive-request` 先例：`session.ts:725-754`，见 bb-daemon-protocol.md §2）。`D:docs/tools/ask.md` | `T:ask.ts`（Question 形状）+ `P:ask.md`                    |
| `think`         | hidden       | 私有 scratchpad，外部思考模式（考古 §6）；无 I/O                                                                                                                                                                          | `T:think.ts` + `T:index.ts:194-196`                        |
| `yield`         | hidden       | 子代理终结交付：结构化结果投递给父（进程内 output-manager；CF 侧 = DO→父 DO 消息）                                                                                                                                        | `T:yield.ts` + `T:index.ts:194-196`                        |
| `goal`          | hidden       | goal 模式状态 [INFERENCE：注册面 `T:index.ts:194-196` + 考古 §6 一行描述；无独立工具文档，M1.5 若启用需先补实读]                                                                                                          | `T:goal.ts` + `T:index.ts:194-196`                         |

（edge 表 10 行 + web_search 见 2.3 特例 = 11）

### 2.3 hybrid（7）——拆缝或选后端

| 工具                 | 层           | omp 执行面（证据）                                                                                                                                                                                                                                                                                                                                         | 拆缝裁定                                                                                                                                      | schema 来源                                                                                                                          |
| -------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `task`               | essential    | 子会话进程内 spawn + pi-natives 隔离 PAL（fuse-overlayfs/克隆/worktree）+ git + fs 产物（`D:docs/tools/task.md` §Side Effects）。spawn/编排本身无宿主依赖                                                                                                                                                                                                  | **控制面（spawn/编排/job 登记）→ DO**；**`isolated` 隔离后端（worktree/patch 捕获/merge）→ daemon**。M1.5 未启用 isolation 时 task 整体边缘化 | `T:task/index.ts` + `T:task/types.ts` + `P:task.md`                                                                                  |
| `web_search`         | discoverable | 多数 provider 纯 HTTPS（API/SSE/scraper-fetch）；**特例**：Google/Ecosia/Mojeek 反爬升级路径可拉起宿主共享 headless Chromium（`acquireBrowser`，`D:docs/tools/web_search.md` §Side Effects）。**归 edge（带条件宿主回退）**：M1.5 边缘 provider 集排除这三个 browser-backed 引擎即可整体边缘化；若必须它们，走 daemon browser（与 `browser` prelude 同缝） | DO 本地 fetch；browser 升级子路径→daemon                                                                                                      | `T:web/search/index.ts` + 统一 schema（`query/recency/limit/max_tokens/temperature/num_search_results`，§Inputs）+ `P:web-search.md` |
| `learn`              | essential    | 记忆后端三选：local fs `learned.md` / Mnemopi SQLite（均宿主 fs）；Hindsight HTTP 队列（网络）。managed-skill 写 = fs。`D:docs/tools/learn.md`（§Flow/Side Effects）                                                                                                                                                                                       | **记忆载荷 → HTTP 后端（Hindsight 类）则 DO 本地**；**managed-skill 写 → 随 skill 存储裁定**（见下 manage_skill 注）                          | `T:learn.ts` + `P:learn.md`                                                                                                          |
| `security_scan`      | discoverable | native preflight/start：git 仓指纹（内容/可执行位/symlink/HEAD SHA-256）+ fs 输出目录 + 后台 coordinator；cloud_*：Codex Security 控制面 HTTPS + OAuth 凭据。`D:docs/tools/security_scan.md`                                                                                                                                                               | **native 半 → daemon**；**cloud 半 → 理论 DO 可走，但 OAuth 凭据保管在宿主，M1.5 整体归 daemon**                                              | `T:security-scan.ts`（9-action 分派）+ `P:security-scan.md`                                                                          |
| `memory_edit`        | discoverable | Mnemopi 专属（后端门控）：本地 SQLite 行变更，无网络。`D:docs/tools/memory_edit.md`（§Side Effects：Network none）                                                                                                                                                                                                                                         | 后端=SQLite → **daemon**；若 M1.5 选 HTTP 记忆后端，此工具的 op 语义并进该后端 API                                                            | `T:memory-edit.ts` + `P:memory-edit.md`                                                                                              |
| `retain`             | discoverable | Hindsight：HTTP 队列（边缘可承载）；Mnemopi：同步 SQLite 写（宿主）。`D:docs/tools/retain.md`（§Outputs 按 backend 分叉）                                                                                                                                                                                                                                  | **选 Hindsight 类 HTTP 后端 → DO 本地**；SQLite 后端 → daemon                                                                                 | `T:memory-retain.ts` + `P:retain.md`                                                                                                 |
| `recall` / `reflect` | discoverable | 与 retain 同构的后端分叉（Hindsight HTTP 查询/reflect 合成 vs Mnemopi 本地）                                                                                                                                                                                                                                                                               | 同 retain：HTTP 后端 → DO 本地                                                                                                                | `T:memory-recall.ts`/`T:memory-reflect.ts` + `P:recall.md`/`P:reflect.md`                                                            |

hybrid 净额：task、security_scan 两行是真拆缝；learn + 记忆四件的类由后端选择决定——**M1.5 选 HTTP/服务化后端即整体边缘化（6 个），选本地文件/SQLite 后端则落 daemon**。

> **manage_skill / skill 存储的连带裁定**：omp 语义是宿主 fs SKILL.md；但 skill 本体是文本包（catalog 行 + body，[agent-skills-core.md](./agent-skills-core.md) §6：存储=容器、无隔离边界）。M1.5 可把 skill 根放 DO storage（R2/KV），`manage_skill`/`learn` 的 skill 半随之边缘化，schema 照抄不变。这是 storage 重投影，不违反照抄纪律（纪律管 schema/description 语义，不管存储后端）。

---

## 3. 接缝归属建议（按类）

### 3.1 host 类 → daemon 执行链

- **形态**：AgentDO 持有工具 schema 与调用裁决权，执行帧下发宿主 daemon，daemon 返回结构化结果（omp `set_host_tools` 工具回桥 + ida broker 是 omp 官方同构形态——"工具执行体放宿主、引擎内核放别处"是 omp 支持的一等拓扑，考古 §5.2-1）。
- **帧契约来源**：`packages/wire` + `wire/rpc-wire.schema.json`（JSON Schema 2020-12 codegen 源，6224 行）是 DO↔daemon 帧的照抄底稿；工具调用面的 wire 形状 = `Tool`（`packages/ai/src/types.ts:1463-1499`：name/description/parameters/strict/customWireName/native/examples）。
- **粒度建议**：一条 daemon 链承载全部 host 工具（bash/read/write/edit/glob/grep/find/eval/github/lsp/debug/ida/ast_grep/ast_edit/manage_skill），按工具名分派；不按工具拆多条链。ida 文档证明 omp 自己就是"一个 broker 多工具共享"的形状。

### 3.2 edge 类 → AgentDO 本地

- 会话态工具（wait/todo/checkpoint/rewind/context_notes/new_context/think/yield/goal/ask）全部落 DO storage + DO 内调度；它们是 omp "会话条目模型"（考古 §1.7）的投影，照抄 `SessionEntry`/journal 语义即可，无需宿主。
- 出站网络工具（web_search 及 hybrid 类的 HTTP 后端半）用原生 fetch；provider 通道与引擎共用。

### 3.3 hybrid 类 → 拆缝规则

- **控制/状态面归 DO，执行体归 daemon**（task 隔离、security_scan native 半、web_search browser 升级半）。
- **后端可插拔类随选型漂移**（learn/retain/recall/reflect/memory_edit + manage_skill 存储半）：M1.5 建议全部选 HTTP 服务/DO-storage 后端 → 整体边缘化；SQLite/本地文件后端是自托管重部署场景，落 daemon。

---

## 4. 相邻面（不在 33 清单、但 #70 的 hybrid 语义直接涉及）

| 面                                            | 类           | 说明                                                                                                                                                                                                                                       | schema 来源                                                                                        |
| --------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| `browser`（eval prelude，非 AgentTool）       | hybrid       | 宿主 Chromium/Electron/CDP/relay/tern/cmux 后端 + tab-supervisor；控制面在 eval 内核。**relay/tern/cmux = 远程 CDP 先例：omp 已把"浏览器执行体在哪"做成可插拔**。CF 形态：DO 发 CDP 指令给宿主 browser 服务（daemon 链），或远程浏览器服务 | `T:tools/browser.ts` + `browser/prelude.{js,py}` + `P:tools/browser.md`；`D:docs/tools/browser.md` |
| `computer`（eval prelude）                    | host         | 原生桌面后端（`crates/pi-natives/src/desktop/`），严格宿主                                                                                                                                                                                 | `T:computer.ts` + `D:docs/tools/computer.md`                                                       |
| `generate_image`（xd 设备）                   | edge         | 图像模型 API 出站调用；产物文件写走 write/daemon                                                                                                                                                                                           | `D:docs/tools/generate_image.md`                                                                   |
| `xd://resolve\|reject\|report_issue\|propose` | edge（派发） | 固定设备：staged 编辑裁决流；派发经 `write`（DO 本地），落点随目标工具类                                                                                                                                                                   | `T:resolve.ts`；`D:docs/resolve-tool-runtime.md`                                                   |
| `mcp__<server>_<tool>`                        | 随传输       | stdio transport → host；HTTP/SSE transport → edge 可承载。xdev 下挂为设备且剥 `i` 字段（`tool-bridge.ts:108-127`，考古 §6）                                                                                                                | 各 server 自带 schema；omp 只做传输/审批包装                                                       |
| vibe 系 5 工具（spawn/send/wait/kill/list）   | edge（编排） | 持久 worker 编排；同 task 控制面裁定                                                                                                                                                                                                       | `D:docs/vibe-mode.md`                                                                              |

---

## 5. bb 对照（形状比较）

- **bb 对 OMP provider 不投影自己的工具 schema**：`thread-runtime-config.ts:186-189` 走 `providerOwnsRuntimeSurface` 分支（"provider 拥有工具面"）——工具面形状由 provider（omp）单方定义，bb 只透传。**结论：照抄 omp 即完备，无 bb 侧工具 schema 需要对齐。**
- bb 自己的宿主工具语义走 daemon RPC 命令面（`host-rpc.request` + 54 commandType，`session.ts:415-472`；`host.exec` 语义见 bb-daemon-protocol.md §1.3）——这是 M1.5 daemon 链的工程参照系（命令分派/超时/取消/进度四件套），但工具 schema 本体仍以 omp 为唯一正本。
- `ask` 的交互回路 bb 侧先例：`/internal/session/interactive-request` 注册 pending interaction + UI 裁决回流（`session.ts:725-754`）——DO↔SPA 的 ask 通道可直接对齐此形状。

---

## 6. 死点与注意

1. **web_search 的"纯边缘"有例外子路径**：三个 browser-backed scraper（Google/Ecosia/Mojeek）可拉起宿主 Chromium。边缘 provider 集必须在配置层显式排除它们，否则 edge 类静默变 hybrid。
2. **`github` 的 REST 重投影**：read/search 半可改纯 fetch（边缘化），但 pr_checkout/pr_push 绑定本地 git worktree 与分支元数据，不可重投影。照抄纪律下整体留 daemon，不做半迁。
3. **`find` 的 judge 依赖**：`find.enabled=auto` 要求 judge 角色解析到原生 System One 模型（`D:docs/tools/find.md` §CLI 段）；边缘化 find 时 judge 调用走引擎 provider 通道，但词汇索引半仍需宿主 fs——find 整体留 host 类。
4. **`goal` 无工具文档**：分类基于注册面+考古一行描述 [INFERENCE]；M1.5 若启用 hidden 三件中的 goal，先补实读。
5. **workerd natives 全灭**（考古死点7）：grep PCRE2 降阶、ast-grep、hashline EditStore、隔离 PAL、内嵌 shell 全部无 Worker 对等物——这 15 个 host 类不是"暂时放宿主"，是**结构性必须宿主**，除非未来重写对应纯 TS/WASM 实现（超出口径，本文不规划）。
6. **`i` intent 字段是运行时注入**（`normalizeTools`，考古 §1.9），不写进工具作者 schema——照抄 schema 时不要把 `i` 手抄进去，注入逻辑属于引擎层。

---

## 7. 证据基线

- omp 工具文档：仓内 `docs/tools/*.md`（本会话经 `omp://tools/*.md` 全文实读，与锚点 `d4d49e71` 同源）；源码行级证据沿用 [omp-engine-portability.md](./omp-engine-portability.md) §1.9/§6/§7（五 lane 原始笔记收编）。
- bb 侧：[bb-daemon-protocol.md](./bb-daemon-protocol.md)、[bb-server-port-inventory.md](./bb-server-port-inventory.md)（`providerOwnsRuntimeSurface` @ `8473d8c33`）。
- skill 存储：[agent-skills-core.md](./agent-skills-core.md) §5-6。

> AGENT GENERATED: by zhipu-coding-plan/glm-5.3-flash (research subagent, #70)
