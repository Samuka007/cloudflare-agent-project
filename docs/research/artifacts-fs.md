# cloud-only fs 载体——Cloudflare Artifacts 文件系统研究（#307）

研究对象与版本锁定：

- **Cloudflare Artifacts**：developers.cloudflare.com/artifacts/ 全档抓取于 2026-10-06；各页 "Last updated" 逐节标注。产品 2026-04-16 私测、**2026-10-01 open beta**、Workers Paid 可用、**2026-10-14 起计费**（changelog 2026-10-01 条目）。
- 本仓基线 = `lane/307-w5-feature-cloud-only-fs-cloudflare-arti` @ `331d087`（main 合流点）。
- 语义参照：[omp-tool-execution-classification.md](./omp-tool-execution-classification.md)（#70 工具分类）、[workspace-host-path-gap-inventory.md](./workspace-host-path-gap-inventory.md)（#282 盘点）、[workspace-routing-two-source-map.md](./workspace-routing-two-source-map.md)（#80 两源地图）、CONTEXT.md（Cloud-only Failover/执行悬置/会话可携带性）。

结论先行：**可行，但有明确的能力天花板与两个未退役风险**。Artifacts 是 Git 兼容的版本化存储（repo=隔离 Git 服务，Workers binding + REST + Git 三面 API），天然覆盖 agent fs 工具的**文件半边**（read/write/edit/glob/grep/manage_skill 存储）；**进程半边**（bash/eval/find…）它给不了——那是 Sandbox SDK（Containers）的事。设计草案落成两层：**tier-0 云上 fs（edge 侧实现，恒可用）+ tier-1 云上算力（Sandbox 型 cloud daemon，按需冷启）**，两层以同一个 repo 为 workspace 正本。与 #288-#291 的整合点是给 environments 加一个 **cloud 载体 host**（合成宿主行），绑定链/覆盖语法/悬置语义零改动复用。今天（2026-10-06）距计费开始仅 8 天，tier-0 的**读操作计费口径未定**是切票前必须探针的第一个问题。

---

## 1. Artifacts 产品能力盘点

### 1.1 定位与模型（how-artifacts-works，页 updated 2026-04-25）

- Namespace 是 repo 的顶层容器；namespace 不需预建——首个 repo 用新 namespace 名创建时隐式建。`<namespace>/<repo>` 构成 repo 稳定地址，API 另回 repo id。
- **repo = 单一逻辑实例**，Cloudflare 可从任意 region 路由（文档自比 Durable Objects）。每个 repo 独享：Git 历史/refs、token 与 remote URL、生命周期与持久态。
- `import` 从外部 HTTPS git remote 导入（可 shallow）；`fork` 从既有 repo 历史派生新 repo（可 `default_branch_only`）。
- **持久性**：同步多数据中心复制 + 异步落对象存储与快照；无需自建复制/快照管道。
- token 是 **repo 域**的：scope ∈ `read`（clone/fetch/pull）/ `write`（+push）；`art_v1_<40hex>?expires=<unix秒>`，expiry 编码在 token 串里（git-protocol 页）。

### 1.2 API 三面

| 面 | 形状 | 写文件能力 | 锚 |
| --- | --- | --- | --- |
| **Workers binding** | wrangler ≥4.145.0 `[[artifacts]]` 绑定；namespace 方法 `create/get/list/import/delete`；repo capability `info/createToken/listTokens/revokeToken/fork/log/readCommit/readTree/readBlob/readFile` | **无写文件方法**——`readFile({ref,path})`/`readTree(hash)`/`readBlob(hash)`/`log`/`readCommit` 全是读 | workers-binding 页（updated **2026-10-01**） |
| **REST** | `https://api.cloudflare.com/client/v4/accounts/:id/artifacts/namespaces/:ns/...`，v4 envelope；内容路由 `GET .../file?ref=&path=`、`GET .../raw/:ref/:path`、`/tree/:hash`、`/blob/:hash`、`/log`、`/commit/:hash`；token 路由 `POST /tokens`（ttl 60–31,536,000s，默认 24h） | 同样**只有读**；变更面 = repo/token 管理（create/delete 202/fork/import） | rest-api 页（updated 2026-08-13） |
| **Git 协议** | smart HTTP remote `https://<ACCOUNT>.artifacts.cloudflare.net/git/<ns>/<repo>.git`；clone/fetch v1+v2（`ls-refs`/`fetch`/shallow）；**push 仅 v1**（不支持 v2 receive-pack；`filter`/`include-tag` 不支持）；Bearer header 或 Basic（密码位放 token secret） | **唯一的写路径**：`git push` | git-protocol 页（updated 2026-04-25） |

关键不对称（可行性核心）：**读是一等 API（binding `readFile`/REST file 路由按 path 直读），写只有 git push 一条线**。isomorphic-git 示例页（updated 2026-05-21）原话："The Artifacts binding creates and manages repos, but it cannot read or write files inside them — for that, you need Git"——该页早于 10-01 的 binding 读方法扩充，写半句至今仍真。Worker 内写 = isomorphic-git（纯 JS）+ 内存 fs + `git.push`，官方示例给全了（init/add/commit/push，Basic auth 密码位 = token secret）。

### 1.3 配额与计费（limits/pricing 页，均 updated 2026-10-01）

| 项 | 值 |
| --- | --- |
| 控制面请求率 | 2,000 req / 10s / namespace |
| Git 请求率 | 2,000 req / 10s / repo |
| 单 repo 存储 | **1 GB** |
| 单文件/blob | **32 MB** |
| 账户存储 | 1 TB（可申请提升） |
| repo / namespace 数量 | 无限 |
| 可用性 | Workers Paid（本账号已在 Paid，ephemeral-env §1 [OBSERVED: run 37267228347]） |
| 计费起点 | **2026-10-14** |
| Operations | 首月 10,000 免费，之后 **$0.15 / 1,000 ops**；定义 = "repo operations, such as `create`, `push`, `pull`, `clone`" |
| Storage | 首 1 GB/月免费，之后 $0.50 / GB-mo（按日峰值均值计） |

**计费口径缺口（J1，切票前必须探针）**：定价页只列 create/push/pull/clone 为 operation 例举；binding `readFile`/`readTree` 与 REST file 读是否计入 operations **文档未写**。若计入，grep 全仓扫描 = 文件数 × 1 op，交互频率下成本放大 2-3 个数量级（§5 判据一）。

### 1.4 一致性与目录语义（Git 语义投影）

| fs 概念 | Artifacts（=Git）语义 | 对工具面的含义 |
| --- | --- | --- |
| 一致性 | ref 指向快照，读 = ref 一致性快照；分支历史线性；并发 push 同 ref = 后者 non-fast-forward 被拒 | 无文件锁；写冲突 = 显式 push 拒绝，需 fetch-重放或报错（诚实失败，无静默合并） |
| 空目录 | Git 树无空目录 | `write` 隐式建父目录 OK；"mkdir 空目录" 语义不存在 |
| mtime | 树对象无时间戳（commit 级才有） | 依赖 mtime 的语义（find 按新近度等）在 tier-0 不可用 |
| mode 位 | 100644/100755/120000(symlink)/160000(gitlink) | Unix 权限位退化；symlink 可存但 read 侧语义需裁定 |
| 目录列举 | `readTree(hash)` **只回直接子项**；无"递归列全仓"API | glob = 客户端递归走树（commit→根树→子树链）；每目录 1 次 readTree |
| gitignore | 树走查无 ignore 语义 | tier-0 glob/grep 与 omp 的 gitignore 行为**有偏差**，需文档化或手写 .gitignore 解析 |
| rename | = delete+add | edit/write 的 diff 呈现走 `log`/`repo.pushed` 事件的 before/after |

### 1.5 相邻面

- **ArtifactFS**（guides/artifact-fs，updated 2026-04-25）：Go 实现 `github.com/cloudflare/artifact-fs`，blobless clone + **FUSE** 挂载工作树，内容按需异步水合（manifest 类优先）。**需要宿主 FUSE**——这不是 edge 面，是 §2.2 tier-1 容器/沙箱里的挂载选项。
- **事件订阅**（guides/event-subscriptions，updated 2026-05-21）：`repo.created/deleted/forked/imported/pushed/cloned/fetched/token.*`；`repo.pushed` 载荷含 before/after/commit 列表——SPA 时间线外部变更提示与缓存失效的现成钩子。
- **Sandbox SDK 集成**（examples/sandbox-sdk-artifacts，updated 2026-09-29）：官方 `git-repo-per-sandbox` 模板——repo 与 sandbox 同 ID，write token 铸成 `ARTIFACTS_GIT_REMOTE` 环境变量注入 sandbox，容器内真 git clone/push。这就是 tier-1 的官方接缝。
- **错误面**（api/errors，updated 2026-05-21）：12 个码（`NOT_FOUND` 10200、`ALREADY_EXISTS` 10201、`INVALID_INPUT` 10100、`MEMORY_LIMIT` 10402…）——可映射到 ToolResultPayload 的 errorCode 词汇（host_offline 同款诚实失败语义）。

### 1.6 与替代载体的对照（为何选 Artifacts 而非 R2/KV/D1/DO storage）

| 载体 | 版本化 | 目录/树语义 | git 客户端交接 | fork/merge | 裁定 |
| --- | --- | --- | --- | --- | --- |
| **Artifacts** | ref/commit 原生 | 树对象（读一等，写经 git） | 原生 remote URL | 原生 | **选它** |
| R2 | 无（需自建版本层） | 无树语义（flat key + list） | 无 | 无 | reject：目录语义与交接全自建 |
| KV | 无 | 无 | 无 | 无 | reject：同上 + 写速率 1 key/s |
| D1 表 | 无 | 自建 parent/child 行 | 无 | 无 | reject：行级 blob 无树遍历，迁移/导出自建 |
| DO storage | 无 | key-value | 无 | 无 | reject：会话态可用，**workspace 正本**不适合（计费按 DO 实例 128MB，ephemeral-env §4.2） |

决定性论据不是存储本身，是 **agents know git**（changelog 2026-04-16 原文）：用户/其他 agent/CI 可拿 remote URL 直接 clone；thread 产物天然可交接。这是 R2/KV/D1 都给不了的。

---

## 2. 与现有层的接缝：三条候选线

### 2.1 现状锚（repo @ 331d087）

- 工具分类（分类文档 §0）：essential 13 中 `read/write/bash/edit/glob/find/eval/manage_skill` = 8 host（本仓 `packages/agent-do/src/tools/registry.ts:704-931` 全部 `class: "host"`，read 经内嵌 omp 运行时在 daemon Node 侧执行）；`wait/context_notes/new_context` = 3 edge；`task/learn` hybrid。
- 派发链：`state.machineId`（轨迹冻结）→ `DaemonServiceClient.dispatch`（`packages/agent-do/src/daemon.ts:35-42`，outcome ∈ accepted/completed_cached/host_offline）→ DaemonServiceDO 找该 machineId 的 daemon WS 客户端会话；无会话 = `host_offline`（执行悬置）。
- per-call 覆盖（#289）：`packages/agent-do/src/tools/host-path.ts` `parseSshOverrideUrl`——`ssh://<machineId>/<path>` 语法，read/glob/grep 的 path 字段 + edit 的 hashline input 扫描，偏差落 `tool.dispatch.overriddenMachineId`。
- 绑定喂值（#288）：`apps/server-worker/src/services/thread-binding.ts` 优先链（thread 显式 → project 默认源 → 部署默认 `env.ORCHESTRATOR_HOST_ID ?? "local"`）；`environments` 行 = `(project_id, host_id NOT NULL, path)` 唯一（`migrations/0002_environments.sql:16-41`）。
- **workerd natives 全灭**（分类文档 §6.5）：grep PCRE2 降阶、ast-grep、hashline Rust EditStore、内嵌 shell/PTY、eval 子进程内核——Worker 里**没有对等物**，这是结构性约束不是工程偷懒。

### 2.2 三条线与裁定

| 线 | 内容 | 覆盖工具 | 裁定 |
| --- | --- | --- | --- |
| **A. edge 侧 fs 工具实现** | AgentDO/同址 DO 内实现 `ArtifactsFsExecutor`：读走 binding/REST，写走 isomorphic-git+push | read/write/edit/glob/grep/manage_skill 存储 | **tier-0 采纳**——cloud-only 下降级面恒可用，无冷启 |
| **B. provider 型 cloud daemon（Sandbox SDK）** | Sandbox 容器当"cloud 宿主"，官方 repo-per-sandbox 形状（§1.5），daemon 工具面原样跑在容器 Node 里 | bash/eval/find/github/lsp/debug/ida/ast_grep | **tier-1 采纳**——容器冷启换全量 host 工具；这是 CONTEXT.md「Cloud-only Failover」的算力半边 |
| **C. ArtifactFS FUSE 挂载** | 云宿主容器内 `artifact-fs` 挂 repo 成工作树，大仓免全 clone | tier-1 的大仓启动优化 | 备选，随 tier-1 票评估（FUSE 在容器内的可用性未验） |

三线不是三选一：**同一 repo 是两层共用的 workspace 正本**。tier-0 写入的每个 commit 就是 tier-1 容器 `git pull` 即得的工作树——这也正是官方 sandbox 模板的形状。切缝关键在派发面：machineId 解析到 cloud 载体时不走 DaemonServiceDO 找 WS 会话，而是**直接进 DO 内执行器**（`DaemonServiceClient` 接口不变，实现换掉；`DispatchOutcome` 词汇原样复用，cloud 载体永不 `host_offline`）。

### 2.3 逐工具 tier-0 能力表（含复用三问）

| 工具 | tier-0 实现 | 复用三问 | 能力天花板 |
| --- | --- | --- | --- |
| `read` | binding `readFile({ref,path})` → Blob → 文本/行选择器处理 | 运行环境同构（纯 TS 文本处理可移 workerd）；omp read 的选择器/内部 URI 逻辑是 TS，可抽 | UTF-8 文本；归档/SQLite/PDF/notebook 专项读取器不做（natives）；单文件 ≤32MB；`read` 行为向 `ssh://` 1MiB 先例看齐（routing 地图 §2.2） |
| `write` | MemoryFS 暂存 + isomorphic-git add/commit/push | 官方示例即完整实现（§1.2） | 每写 = 1 commit + 1 push（计费 1 op）；push 冲突 = 显式 error |
| `edit` | hashline 锚定 → pi-mono TS EditStore 底稿移植（分类文档 §2.2：TS 祖先在 pi-mono 有底稿） | 上游有可搬底稿（问一成立）→ 移植而非重写；Rust 版不可用（workerd natives 全灭） | 与宿主 edit 的 byte-identical 语义需对拍测试 |
| `glob` | `log({limit:1})`→commit→递归 `readTree` 走查 | 纯 TS，模式匹配可复用 omp glob 语法层 | 无 gitignore（偏差文档化）；无 mtime 排序；树深×宽 = readTree 次数 |
| `grep` | 树走查 + 逐文件 `readFile` + JS RegExp | Rust/PCRE2 不可搬（问一否定）→ JS 正则重写（问三：omp pattern 语义到 JS 的降级映射） | 文件数×1 读请求；单请求 subrequest 上限约束 fan-out（Paid 1000/请求）；二进制跳过 |
| `manage_skill` | skill 根 = repo 内路径（或 DO storage） | 分类文档已裁定：skill 本体是文本包，存储重投影不违照抄纪律 | symlink 逃逸检查语义需重验 |
| `bash`/`eval`/`find`/`github`/`lsp`/`debug`/`ida`/`ast_grep` | **无 tier-0**：显式拒绝（诚实 error，宿主离线同款占位）或等 tier-1 | 子进程/PTY/natives 无 workerd 对等物（结构性） | — |
| `task` | 控制面本就在 DO；隔离执行半边随 tier-1 | 分类文档 §3.3 拆缝规则 | — |

---

## 3. workspace 语义整合点（#288-#291）

### 3.1 environment 的 cloud 形状：合成宿主行（裁定）

`environments.host_id NOT NULL`（0002 迁移）+ 绑定链（thread-binding.ts）都假设宿主存在。cloud-only 环境没有物理宿主。两案：

- **A. 合成宿主行（采纳）**：`hosts` 表落一行 `id='cloud'（或部署级常量）、type='cloud'`（0001 的 `type` 是自由 TEXT，无枚举约束，`:41`）。environment = `(project_id, 'cloud', 'artifacts://<ns>/<repo>@<branch>')`。thread 绑定照旧冻结 `machineId='cloud'`；#289 覆盖语法加一个 scheme 即可（`artifacts://<repo>/<path>` 或复用 host:path 形状）；执行悬置判定对 'cloud' 短路（永不离线）；SPA 徽章（#291 面）自动显示 Cloud 环境。**绑定链、覆盖、悬置、可见面四层零改动复用**——只有派发末端换执行器。
- B. `host_id` 可空 + 载体列（reject）：迁移手术大，`(project_id,host_id,path)` 唯一索引语义重定义，#289/#291 已落地面全部要跟改。违 boring-design 原则。

### 3.2 repo-per-thread 与 fork 基线（best-practices 锚形）

- 官方最佳实践："Create one repo for each unit of autonomous work……If you have 10,000 agents, create 10,000 repos"；命名 `${agentName}-${sessionId}-${repoName}` 防撞（best-practices 页）。映射：**thread = repo**，名如 `thr_<id>`；写冲突随 repo 隔离自然消失（单写者）。
- 基线供给：项目基线 repo + thread 建时 `fork`（`default_branch_only`）= `managed-worktree` 的 cloud 类比；`workspaceProvisionType` 词汇表加第三值（如 `cloud-repo`）。注意 0001 的 `project_sources` CHECK 强制 `hostId/path` 非空——云基线要么加新行类型（additive 迁移）要么绕开该表用命名约定，留票 2 裁定。
- 环境 path 形状定为 URI：`artifacts://<namespace>/<repo>[@<branch>]`——namespace 可后缀环境隔离（`staging`/`prod` 分 namespace，best-practices 分区表），branch 省略 = default branch。

### 3.3 会话正本上 repo：顺手修掉 GAP（两源地图 §3）

#80 点名的两源共同空白「跨设备离线续聊」：provider 会话正本（omp session file）属地执行机。Artifacts 下 thread 的会话 JSONL 可作为 repo 内路径或 `refs/notes/*`（best-practices 明文推荐 git notes 装 prompts/model output）随 repo 走——**任何新宿主 clone 即续聊**。这是 #73 Q2「会话可携带性」的自然载体，也是 tier-1 容器接管半停 turn 时恢复 provider 会话的正解。本身不值一张票，搭车在写路径票里落。

### 3.4 与 CONTEXT.md 词汇的收敛

- 「Cloud-only Failover（纯云降级）」从 future 未排期变为有载体蓝图：tier-0 fs 面 = 本文；tier-1 算力面 = Sandbox cloud daemon（另票）。
- 「执行悬置」语义不变：宿主离线仍悬置；'cloud' 载体不悬置（它就是 always-on 的降级面本身）。
- 「Bound Host」定义外延：绑定对象从物理机扩展到「执行载体」（host 机 / cloud 载体）——轨迹真理源（`thread.created.machineId`）机制不变。

---

## 4. 设计草案（tier-0 ArtifactsFsExecutor）

```
AgentDO 派发 (machineId='cloud')
  └─ DaemonServiceClient 实现换型：ArtifactsFsExecutor（DO 内，与 AgentDO 同址）
       ├─ overlay：per-thread MemoryFS 写暂存（read-your-writes）
       ├─ 读：env.ARTIFACTS.get(repo) → readFile/readTree（ref=分支头）
       ├─ 写：overlay 上 isomorphic-git add/commit → push（v1）→ 成功后 overlay 即真相
       ├─ push 冲突：fetch 一次 → 无本地未落盘写则重放；有则显式 conflict error（无静默合并）
       ├─ token：server-worker 按 thread 生命周期铸短时 write token（best-practices：per-session 铸、最短时效）
       └─ 错误映射：10200→ENOENT 同款 / 10201→ALREADY_EXISTS / 10402→文件过大 …（errors 页 12 码 → ToolResultPayload.errorCode）
```

- **commit 粒度**：v1 = **每工具调用一 commit**（持久、可 diff、诚实）；turn 边界 squash 是优化票（push op 计费驱动，等 J1 探针数据）。
- **一致性**：ref 快照读 + 线性历史；thread 单写者消灭并发写冲突；跨端写（用户手动 push）由 push 拒绝显式浮出，`repo.pushed` 事件可作缓存失效与 SPA 提示钩子（§1.5）。
- **配额预算**：交互单 turn（10 次工具调用，glob+grep 树走查 ~100 readTree/readFile）≈ 100+ ops；2000 req/10s/repo 的速率面对单 thread 富余。月成本敏感性完全取决于 J1（§5）。
- **降级呈现**：tier-0 无 bash/eval，工具面在 thread 维度按载体裁剪（env 门控注册，#322 `AGENT_DO_GENERATE_IMAGE` 闸先例）；模型看到的能力面 = 载体能力，schema 照抄纪律不变。

## 5. 可行性判据与不可行触发器（票 1 spike 的预注册 kill test）

| # | 判据 | 不可行触发 | 探针方法 |
| --- | --- | --- | --- |
| K1 | **读操作计费口径** | `readFile`/`readTree` 计入 ops 且交互档 grep（≥500 文件）单调用成本 > $0.01 且无缓存可救 → tier-0 降级为 write-only 载体 + 显式只读缓存层 | 建 repo、读 1000 次、看次日账单口径（或工单问询） |
| K2 | **workerd 写路径** | isomorphic-git push 在真实 Artifacts remote 上失败/超时（p95 > 5s）→ 写 UX 不可用 | 官方示例原样跑通即退役；顺带验 commit metadata 是否暴露 tree hash（glob 走查入口，JOINT-UNKNOWN J2） |
| K3 | **subrequest 上限** | 单请求内文件级 fan-out 受限导致 grep 必须分片且分片延迟不可接受 | 500 文件仓 grep 实测延迟分布 |

K1-K3 全绿 → 按 §6 切票推进；任一红 → 载体裁剪到对应半边（读缓存层/write-only/降频批处理），红线记录进票面。三条都红 → 判「Artifacts 作交互式 fs 不可行」，降级为「制品交接仓库」用途（非 fs 载体）——这就是明确的不可行判据。

## 6. 切票建议

| 票 | 面 | 优先级 | 依赖 | 预算（参考类） |
| --- | --- | --- | --- | --- |
| 1 **Spike：edge 侧 Artifacts 探针（K1-K3）** | spike | P1 | 无（本文即 DoR 论证） | ≈ #125 spike 往例，1 lane 日；DO/ops 消耗 <2,000 |
| 2 **cloud 载体建模**：hosts 合成行 + environments `cloud-repo` 型 + 绑定喂值 + SPA 徽章流 | 控制面 | P1 | 票 1 绿 | ≈ #288 往例（一个 lane 日） |
| 3 **ArtifactsFsExecutor tier-0 读面**：read/glob/grep + 降级注册闸 + 错误映射 | agent-do | P2 | 票 1+2 | ≈ #290（纯代码面一个 lane 日） |
| 4 **tier-0 写面**：write/edit（pi-mono EditStore 移植）+ per-call commit + 会话 JSONL 入 repo（§3.3 搭车） | agent-do | P2 | 票 3 | ≈ #322 B2 往例（一个 lane 日） |
| 5 **tier-1 算力（Sandbox cloud daemon）**：bash/eval 全量工具 + ArtifactFS 挂载评估 | daemon | 未排期 | 票 3；并入 CONTEXT.md Cloud-only Failover 伞 | 另立研究/票面后再估 |

显式延后（有依据，不切票）：managed-worktree 云基线供给（票 2 留注）；gzip/二进制富读取器（natives，结构性不做）；grep 的 gitignore 全语义（偏差文档化先行）。

## 7. 未决（JOINT-UNKNOWN）

- **J1 读操作计费口径**（=K1）：定价页 op 例举不含读；文档未写即未决，探针/工单前不得当事实引用。
- **J2 commit 元数据是否含 tree hash**：binding `readCommit`/`log` 返回 `ArtifactsCommitMetadata` 字段文档未枚举；glob 走查的入口依赖它（否则需 isomorphic-git fetch 侧读树）。票 1 一并探。
- **J3 单请求 subrequest 配额与 binding 并发**：Paid 1000/请求的实测行为、binding 方法是否受同一限制，官方页未写。
- **J4 open beta → GA 的 API 稳定性**：binding 读方法是 2026-10-01 才出现的新面；票面引用须带「beta 期形状，GA 可能漂移」注记。

## 8. 证据来源清单

官方（developers.cloudflare.com，抓取 2026-10-06）：artifacts/index（Oct 1, 2026）· artifacts/concepts/how-artifacts-works（Apr 25, 2026）· artifacts/concepts/best-practices（Apr 25, 2026）· artifacts/api/workers-binding（Oct 1, 2026）· artifacts/api/rest-api（Aug 13, 2026）· artifacts/api/git-protocol（Apr 25, 2026）· artifacts/api/errors（May 21, 2026）· artifacts/guides/artifact-fs（Apr 25, 2026）· artifacts/guides/event-subscriptions（May 21, 2026）· artifacts/examples/isomorphic-git（May 21, 2026）· artifacts/examples/sandbox-sdk-artifacts（Sep 29, 2026）· artifacts/platform/limits（Oct 1, 2026）· artifacts/platform/pricing（Oct 1, 2026）· artifacts/platform/changelog（条目至 Oct 1, 2026）

本仓：CONTEXT.md · docs/research/omp-tool-execution-classification.md · docs/research/workspace-host-path-gap-inventory.md · docs/research/workspace-routing-two-source-map.md · docs/research/ephemeral-env.md §1/§4 · packages/agent-do/src/tools/registry.ts · packages/agent-do/src/tools/host-path.ts · packages/agent-do/src/daemon.ts · apps/server-worker/src/services/thread-binding.ts · apps/server-worker/migrations/0001_control_plane.sql · apps/server-worker/migrations/0002_environments.sql

> AGENT GENERATED: by zhipu-coding-plan/glm-5.3-flash (research subagent, #307)
