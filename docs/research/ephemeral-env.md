# R ephemeral 验收环境机制事实清单：Version URLs × Previews × 每 PR 独立 worker（wayfinder #244）

> 状态：**事实清单**（2026-10-05，research/ephemeral-env 分支）。只陈列事实、官方文档锚（URL + 页面 "Last updated" 日期）与本仓 file:line；**不做**选型裁决——供 #243 destination 消费。未经工具验证的推断标注 `[INFERENCE]`，文档未覆盖处列入 §8 未决。
>
> 官方文档均以抓取当日（2026-10-05）页面内容为准，每节标注来源页与其 last-updated。

## 0. 问题（#244 原文拆解）

我栈（ComposedAgentDO+D1+KV+Assets 单 worker）实现每 PR 临时在线验收环境的机制面：

1. `wrangler versions` preview URL 的能力边界（DO/绑定/数据是否随版本隔离）？
2. 每 PR 独立部署名（`cap-server-pr-<n>`）+ 独立 D1/KV 实例的配额与成本？
3. 种子数据（threads/fixtures）怎么灌？
4. teardown 时机与自动化？

## 1. 我栈事实（repo 锚点）

- 组合单 worker：`apps/server-worker/src/index.ts` 导出 6 个 DO 类（ComposedAgentDO、ComposedHostOrchestratorDO 为组合类，NotificationHubDO、LeaseStoreDO 本地，DaemonServiceDO/HostOrchestratorDO/ManagerDo 来自 workspace 库）（docs/research/deployable-units.md:21）。
- staging 配置 `apps/server-worker/wrangler.staging.jsonc`：name `cap-server-staging`（:9）；assets `run_worker_first: true` + binding `ASSETS`（:13-18）；D1 双绑定同一库 `cap-control-plane` id `4e823d64-…`（:19-31）；6 DO 类 + legacy `migrations` v1 `new_sqlite_classes`（:33-55）；KV `DAEMON_EDGE_KV` id `5b39e87d…`（:56-64）；cron `*/5 * * * *`（:65-67）；`ACCESS_CHECK_ENABLED: "false"`（:68-74）。
- DO 访问走 env 绑定（`env.HUB`/`env.AGENT_DO`/…，wrangler.staging.jsonc:33-42 的 6 个 binding；组合类构造处 apps/server-worker/src/index.ts:44-65，deployable-units.md:21）。
- D1 schema 唯一源 `apps/server-worker/migrations/0001_control_plane.sql`（172 行）；测试侧 `apps/server-worker/test/migrate.ts` 应用；部署侧无任何 `wrangler d1` 步骤（deployable-units.md:30，今日仍成立——scripts/deploy-staging.sh 无 d1 步骤，:43-47）。
- CD：`deploy-staging` workflow，push→main 触发，跑 `scripts/deploy-staging.sh`（.github/workflows/deploy-staging.yml:14-16,50-54）；脚本核心 `pnpm exec wrangler deploy -c wrangler.staging.jsonc --secrets-file`（SERVER_VERSION=<sha> 随部署盖章，scripts/deploy-staging.sh:41,45）；worker URL `https://cap-server-staging.dai-samuel.workers.dev`（deploy-staging.yml:63）。取代了旧 `wrangler versions secret put` 预盖章（deployable-units.md U1 缺口 3 已闭环，deploy-staging.sh:10-15）。
- wrangler 钉版 `^4.147.0`（apps/server-worker/package.json:28），lockfile 实锁 `wrangler@4.147.0`（pnpm-lock.yaml:2227）。
- KV namespace `5b39e87d…` 被 4 处配置共享（server-worker ×2、daemon-service、agent-do hookup）（deployable-units.md:67）——dev rig 与 staging 同 namespace。
- 账号在 Workers Paid（$5/mo 起，CD 用 repo secrets 已跑通，gh run list deploy-staging=success 2026-10-05）[OBSERVED: run 37267228347]。

## 2. `wrangler versions upload` / Version URLs（preview URL）能力边界

来源：developers.cloudflare.com/workers/versions-and-deployments/version-urls/（last updated Sep 22, 2026）；…/versions-and-deployments/（Sep 22, 2026）；…/deployment-management/（Jul 15, 2026）；…/previews/compare-workflows/（Sep 22, 2026）。

### 2.1 形态与开关

- URL 形态 `<version-prefix>-<worker-name>.<subdomain>.workers.dev`；aliased 形态 `<alias>-<worker-name>….workers.dev`（version-urls「URL format」）。
- 版本由 `wrangler deploy`、`wrangler versions upload`、dashboard 保存创建；启用时 URL 在版本创建后即公开可用（version-urls「Version URLs」）。
- 开关：config 字段 `preview_urls`（字段名仍是 preview_urls）；未显式设置时跟随 `workers_dev` 默认（version-urls「Enable or disable」）。
- 别名仅在 `wrangler versions upload --preview-alias <alias>` 时可创建；alias+worker 名 DNS label ≤63 字符；**只保留最近部署的 1000 个别名**，超限删最旧（version-urls「Limits」）。
- Version URLs 只能在 `workers.dev` 上，不能配到其他子域；**不能**用 Workers Logs / `wrangler tail` / Logpush 查看 Version URL 的日志（version-urls「Limitations」）。

### 2.2 DO 硬限制（对我栈是决定性事实）

> **"Version URLs are not generated for Workers that implement a Durable Object, including Containers and Sandbox Workers."**（version-urls「Limitations」第 1 条，2026-09-22 版页面原文）

我栈 worker 导出 6 个 DO 类（§1）→ `cap-server-staging` **不会生成任何 Version URL**。即"preview URL 检验收"这条路对我栈当前形态**不可用**（平台侧不生成，非配置可解）。

### 2.3 数据隔离：无

- Version URL「uses that Worker version's existing configuration and resources instead of creating a separate environment」（version-urls 首段）——版本只封装代码/资产/绑定/compat 设置，不封装数据。
- 「State changes for associated storage resources such as KV, R2, Durable Objects, and D1 are not tracked with versions」（versions-and-deployments「Versions」Note）。两条 Version URL（或 Version URL 与生产）共享同一 D1 行、KV namespace、DO namespace/存储。

### 2.4 versions upload 的其他边界（deployment-management「Limits」，Jul 15, 2026）

- 只能对**最近 100 个已上传版本**创建 deployment。
- 首次创建 worker 必须走 `wrangler deploy`（C3 或 deploy），`versions upload` 首传会失败。
- Service worker 语法不支持 versions upload（须 ES modules——我栈是 modules，无影响）。
- **DO 类生命周期变更（创建/删除/重命名/转移）不能经 versions upload**，必须 `wrangler deploy`。
- 官方现在明确：**"Do not use Version URLs for branch or pull request testing. Use Previews instead."**；aliased Version URLs 用于 PR 预览属被替代用法（compare-workflows「Version URLs」）。
- Version URL 生命周期：文档**未写自动过期**；URL 跟随版本存在（§8 未决 J1）。

## 3. Workers Previews（同 worker per-branch 隔离环境，2026-09 新产品）

来源：developers.cloudflare.com/workers/previews/（Sep 24, 2026）；…/previews/resources/（Sep 22, 2026）；…/previews/configuration/（Sep 22, 2026）；…/previews/examples/（Oct 1, 2026）；…/previews/compare-workflows/（Sep 22, 2026）。

### 3.1 基本机制

- `npx wrangler preview` 按当前 git 分支在同一 Worker 下创建/更新一个 Preview；`wrangler deploy` 照旧管生产（previews「How it works」）。
- **版本要求 Wrangler ≥4.135.0**（previews 首页 Note）；我栈实锁 4.147.0（§1）→ 满足。
- Preview **不继承生产设置**；由 config 的 `previews` 块定义（块必须存在，可为空 `{}`）；执行时以**当前分支的配置文件**为 source of truth（previews「Settings and isolation」、configuration「Setting your Previews Base configuration」）。
- URL 两类：Preview URL `<preview-name>-<worker-name>.<subdomain>.workers.dev`（恒指最新部署，workers.dev 域带 `X-Robots-Tag: noindex`）；Deployment URL `<deployment-id>-<worker-name>…`（指向单个部署不变）；custom domain 可选 `<preview-name>.app.example.com`（previews「URLs」）。
- 官方定位："For isolated branch or pull request testing, use Previews"（version-urls 首页导流）；compare-workflows 三者对照表：Previews=分支/PR 完整环境；Version URLs=生产资源上看单版本；Wrangler environments=独立命名 worker。

### 3.2 资源隔离矩阵（resources「Binding reference」表，2026-09-22）

| 资源 | Preview 行为 | 隔离手段 |
| --- | --- | --- |
| Durable Objects | **每个 Preview 自动获得新 DO namespace + 新存储**（同 worker 内类，非 script_name 引用） | 自动 |
| Containers | 每个 Preview 自动新 container app + 实例 | 自动 |
| `kv_namespaces` | 按 `id` 绑定；同 id 共享数据 | 绑不同 namespace |
| `d1_databases` | 按 `database_id` 绑定；同 id **共享行** | 绑不同 database |
| `r2_buckets`/`queues.producers`/`vectorize`/… | 同名/同 id 共享 | 绑不同资源 |
| `assets` | 保持 top-level；`wrangler preview` 上传**当前分支**的资产 | 无需 previews 块 |

- DO 状态语义：「State persists across deployments within the same Preview and is deleted when the Preview is deleted」（resources「Durable Objects」）。
- **我栈注意**：`ctx.exports` 访问（需 `enable_ctx_exports` flag，compat date ≥2025-11-17 默认开；我栈 2026-09-29 → 默认开）时，空的 `previews` 块即获得自动隔离；但代码经 **env 绑定**（我栈形态，§1）访问时必须在 `previews.durable_objects.bindings` 声明绑定，否则 Preview 内绑定不存在、请求 **1101 错误**（resources「Use an env binding」Caution）。类与 migrations 留在 top-level。
- `previews` 块归属表（configuration「What goes in the previews block」）：`vars`、存储绑定、`define`、`tail_consumers` 需要进块；`compatibility_date/flags`、`assets` 只留 top-level；API 绑定（ai/browser/images…）按需进块。**Queue consumers、Cron Triggers、生产 routes 不得放进 previews——它们不指向 Preview**。

### 3.3 种子/迁移

- D1 官方模式（resources「D1 migrations」，六步）：base 分支 `previews.d1_databases` 指向共享 preview 库 → 另建 `wrangler.preview-migrations.jsonc`（top-level 指同一库）→ 需要隔离的分支改两处 `database_id` → `npx wrangler d1 migrations apply PREVIEW_DB --remote --config wrangler.preview-migrations.jsonc` → `npx wrangler preview --name <branch>`。多 Preview 共享同一 `database_id` 时迁移只跑一次。
- 对应我栈 schema：迁移源= apps/server-worker/migrations/0001_control_plane.sql（§1）——Previews 的 D1 迁移即对该文件跑 `d1 migrations apply --remote`（[INFERENCE]：需把 migrations_dir 对齐，属接线细节）。
- KV 种子：`npx wrangler kv key put <KEY> [VALUE] --namespace-id <id> --remote`（支持 `--path` 读文件、`--metadata`、`--ttl/--expiration`；kv/reference/kv-commands「kv key put」，Apr 21, 2026）；REST bulk API 每对 key-value 计 1 次写（kv/platform/pricing FAQ）。**wrangler/dashboard 的 KV 操作计费**（pricing FAQ）。同 key 写限 1 次/秒（kv/platform/limits）。
- D1 种子：`npx wrangler d1 execute <DATABASE> --remote --command <sql> | --file <f.sql>`；`--file` 导入上限 5 GB（经 R2 上传，d1/wrangler-commands「d1 execute」、d1/platform/limits fn5）；wrangler 发起的查询计费（d1/platform/pricing FAQ「Do queries I run from the dashboard or Wrangler count as billable usage?」Yes）。
- DO 种子：**无 CLI 直灌命令**（DO storage 只能从 DO 内部访问，durable-objects/platform/pricing「The Durable Objects Storage API is only accessible from within Durable Objects」）；Preview 的 DO namespace 自动创建为空 → 种子路径=驱动 worker 面（HTTP/RPC）让 app 自建实例 [INFERENCE：由上两句归因]。

### 3.4 Secrets

- Secret 不进配置文件；Base 配置（发给每个新建 Preview）：`npx wrangler preview base-config secret put SECRET_NAME`；单 Preview：`npx wrangler preview secret put SECRET_NAME --name <preview>`（`--name` 缺省取当前 git 分支）；Base secret 后续变更只作用于**新** Preview，活跃 Preview 不变（configuration「Secrets」表）。
- dashboard 可配 Previews Base 并从生产导入变量（secret 需手输），生成的配置需拷回 wrangler 文件（configuration「Dashboard configuration」）。
- 我栈现状：staging 无 `MODEL_RELAY_*`（relay mock 模式，wrangler.staging.jsonc:5-8）——Preview 侧按"不继承生产"规则，同样需要显式 base-config 化或保持 mock [INFERENCE]。

### 3.5 Teardown 与自动化

- 手动：`npx wrangler preview delete --name <preview> --skip-confirmation`（previews「Limits」；resources §Containers cleanup 同命令）。
- 官方 GHA 模板（examples「GitHub Actions」，2026-10-01）：`pull_request: [opened, synchronize, reopened, closed]` 四事件触发 → 非 closed 建/更新 `wrangler preview --name "pr-${{ github.event.pull_request.number }}" --json`、`jq` 取 `.preview.urls[0]`、`gh pr comment` 贴 URL（可 `--edit-last --create-if-none` 免刷屏）→ closed 事件 cleanup job：`wrangler preview delete --name "pr-N" --skip-confirmation`。
- Fork PR 警告（原文）：repo secrets 默认对 fork PR 不可用；暴露凭据前须验证 `github.event.pull_request.head.repo.full_name == github.repository`（examples「Add repository secrets」）。
- 验收探针/截图：`curl --fail "$PREVIEW_URL/api/health"`（examples「Probe the Preview」）；playwright 截图上传 artifact（examples「Capture a screenshot」）。
- 自动淘汰上限（previews「Limits」表）：**Previews per Worker：Free 100 / Paid 500；Deployments per Preview：100/100**；超限时自动删"最久未部署"的 Preview / Preview 内最旧部署。
- 容器残留：删 Preview 后容器 app 可能残留在 `wrangler containers list`，需按 `<worker>_<preview>_<class>` 前缀匹配清理（resources「Container application cleanup」）——我栈无 Containers，不适用 [FACT: 我栈无 containers 配置]。

### 3.6 Preview 限制面（resources「Limitations」+ configuration 末注）

- Service binding：Preview 的 service binding 只指向被绑 worker 的**生产**部署；同 worker 内调用改用 `ctx.exports` 可留在 Preview 内。
- Workflows：绑定已有 Workflow，不建 Preview 专属实例。
- Queue consumers：Preview 不能成为消费者（一队列一消费者）。
- **Cron Triggers：目标是生产；「Previews do not create separate scheduled invocations, and the scheduler does not call a Preview's `scheduled()` handler today.」**——我栈 cron `*/5`（§1）在 Preview 形态下不跑；文档给的替代=把逻辑放函数，从 `scheduled()` 与测试路由双入口调用。
- Routes/生产 custom domains 不被 Preview 接管；HTTP 流量只走 Preview URL。

## 4. 每 PR 独立 worker（`cap-server-pr-<n>`）+ 独立 D1/KV 实例

来源：workers/platform/limits/（Sep 5, 2026）；workers/platform/pricing/（Oct 2, 2026）；d1/platform/limits/ + pricing/（Apr 21, 2026）；kv/platform/limits/ + pricing/（Apr 21, 2026）；durable-objects/platform/pricing/（Sep 30, 2026）；durable-objects/reference/durable-objects-migrations/（Sep 28, 2026）；durable-objects/reference/durable-object-class-migrations-legacy/（legacy 迁移页）；kv/reference/kv-commands/（Apr 21, 2026）；d1/wrangler-commands/（Apr 21, 2026）。

### 4.1 账户配额（每 PR ×N 并发的约束面）

| 配额项 | Free | Paid（我栈所在档） | 锚 |
| --- | --- | --- | --- |
| Number of Workers（脚本数/账户） | 100 | **500** | workers/platform/limits「Account plan limits」 |
| Cron Triggers per account | 5 | **250** | 同上 |
| D1 databases per account | 10 | **50,000**（可申请提到百万级） | d1/platform/limits 表 + fn1 |
| D1 单库容量 / 账户总容量 | 500 MB / 5 GB | **10 GB / 1 TB** | 同上 |
| KV namespaces per account | 1,000 | **1,000** | kv/platform/limits 表 |
| KV 同 key 写速率 | 1/s | 1/s | 同上 |
| 单 worker 可绑 D1 数 | ~5,000（≈150 B/绑定，脚本 metadata ≤1 MB） | 同左 | d1/platform/limits fn3 |
| D1 每次调用查询数 / KV 操作数 | 50 / 1000 | 1000 / 1000 | d1 limits / kv limits fn1 |

- 6 个 DO 类=每 worker 6 个 DO namespace；账户级 DO namespace 数量上限**未在 limits 页列出**（§8 J2）。
- 独立 worker 的 workers.dev host：`cap-server-pr-<n>.dai-samuel.workers.dev`（wrangler environments 生成独立命名 worker，compare-workflows「Wrangler environments」：`wrangler deploy --env <name>`；`env.staging.previews` 也可在 env 下开分支 Preview）。
- Cron 形态事实：每 PR worker 若复制 `*/5` → 每 worker 288 次/天 ≈ 8,640 次/月 cron 调用；cron 调用计为 Workers requests（pricing「Example 3」：hourly cron=720 requests/month 入账）；cron CPU 上限 15 分钟（pricing「Standard」表、limits「CPU time」表）。**账户 250 条 cron 上限**下，约 250 个带 cron 的并发 PR worker 即到顶（每 worker 1 条 cron [INFERENCE：按我栈单条 */5 算]）。

### 4.2 计费数字（Workers Paid / Standard）

| 维度 | 含量 | 超额单价 | 锚 |
| --- | --- | --- | --- |
| 账户底价 | $5/月 | — | workers/platform/pricing 首段 |
| Workers requests | 10M/月 | $0.30/百万 | pricing「Workers」表 |
| Workers CPU time | 30M CPU-ms/月 | $0.02/百万 CPU-ms | 同上 |
| 静态资产请求 | **免费无限** | — | pricing fn3 |
| WebSocket 连接 | 每次 Upgrade 计 1 request；worker 侧转发的消息不计 | — | pricing fn2 |
| DO requests | 1M/月 | $0.15/百万 | durable-objects/platform/pricing「Compute billing」 |
| DO duration | 400,000 GB-s/月 | $12.50/百万 GB-s | 同上 |
| DO duration 计费口径 | 每 DO 实例按 **128 MB** 计（不论实际用量；同 isolate 共享也按满额计） | — | pricing fn5 |
| DO 免计费面 | idle 且可 hibernate 不计 duration；`setWebSocketAutoResponse` 不计 wall-clock | — | pricing 正文+fn3 |
| DO SQLite 存储行读写（2026-01-07 起计费） | rows read 25B/月 + $0.001/百万；rows written 50M/月 + $1.00/百万；存储 5 GB + $0.20/GB-月 | — | pricing「SQLite storage backend」表+Note |
| DO alarm | 每次 `setAlarm()` 计 1 行写（SQLite 后端）/1 write RU（KV 后端） | — | pricing fn3（SQLite）/fn4 附近 |
| KV reads | 10M/月 | $0.50/百万 | kv/platform/pricing 表 |
| KV writes / deletes / lists | 各 1M/月 | 各 $5.00/百万 | 同上 |
| KV 存储 | 1 GB | $0.50/GB-月 | 同上 |
| D1 rows read | 25B/月 | $0.001/百万 | d1/platform/pricing 表 |
| D1 rows written | 50M/月 | $1.00/百万 | 同上 |
| D1 存储 | 5 GB | $0.75/GB-月 | 同上 |
| D1 空库 | ≈12 KB 存储（仍计入） | — | pricing FAQ「Does a freshly created database…」 |
| Previews 本身 | Workers pricing 页**无独立 Previews 价目行**（截至 2026-10-05 抓取） | — | [FACT-OF-ABSENCE：全页无 previews 计费条目] |

- Scale-to-zero：D1 不查询不计费（d1 pricing 首段）；DO 无请求不计 duration（pricing「Compute billing」首段）；HTTP 无 duration 计费（workers pricing「Duration：No charge or limit」）。

### 4.3 资源生命周期命令（per-PR 建/拆）

| 动作 | 命令 | 锚 |
| --- | --- | --- |
| 建 D1 | `npx wrangler d1 create <NAME>`（`--location` hint、`--update-config`） | d1/wrangler-commands「d1 create」 |
| 拆 D1 | `npx wrangler d1 delete <NAME> --skip-confirmation` | 同「d1 delete」 |
| 建 KV | `npx wrangler kv namespace create <NAMESPACE>`（`--update-config`） | kv/reference/kv-commands「kv namespace create」 |
| 拆 KV | `npx wrangler kv namespace delete --namespace-id <id> --skip-confirmation` | 同「kv namespace delete」 |
| 部署 worker | `npx wrangler deploy --name cap-server-pr-<n>`（或 `-c <config>` / `--env <name>`） | compare-workflows；wrangler commands |
| 拆 worker | `npx wrangler delete --name <name>`（wrangler commands「delete」） | wrangler/commands/workers/#delete |
| schema 应用 | `npx wrangler d1 migrations apply <DB> --remote --config <cfg>` / `d1 execute --remote --file` | d1/wrangler-commands；previews/resources「D1 migrations」 |

### 4.4 DO 数据销毁语义（per-PR worker 的 DO 面）

- 新版 declarative `exports` 流（Sep 28, 2026 页）：`state: "deleted"` tombstone → 「Deleting a class removes its namespace and **all of its stored data permanently** — this is not a soft delete」；前置=类不在代码里、无其他 worker 绑定（否则 `tombstone_delete_blocked_by_external_bindings`）。
- legacy `migrations` 流（我栈当前形态，wrangler.staging.jsonc:43-55）：`deleted_classes: [...]` 迁移指令删除类（durable-object-class-migrations-legacy「Delete migration」）；两流互斥、一 worker 同时只能用一种（durable-objects-migrations「Looking for the legacy migrations array?」）。
- **删除整个 worker 脚本（`wrangler delete`）是否连带销毁其 DO namespace 数据：已抓取页面未写**（§8 J3）；文档化的销毁路径=tombstone/`deleted_classes`。
- SQLite-backed DO 支持 30 天 point-in-time recovery（durable-objects-migrations「Define a Durable Object class」段内；d1/platform/limits Time Travel 30 天同源）。

## 5. 三机制 × 四问题的对照事实（纯陈列）

| 问题 | Version URLs | Workers Previews | 每 PR 独立 worker |
| --- | --- | --- | --- |
| DO 支持 | **不生成**（有 DO 即无 URL） | 自动隔离 namespace+存储；env 绑定须写入 `previews.durable_objects.bindings`（否则 1101） | 天然独立（每 worker 各自 namespace） |
| 绑定/数据隔离 | 无（共享生产资源） | KV/D1/R2=同 id 共享，隔离须绑独立资源；DO/Container 自动 | 全套独立资源，手动建/绑 |
| 种子 | —（数据即生产） | D1 迁移六步模式；KV `kv key put`；DO 经 app 面 | `d1 execute/migrations apply --remote`；`kv key put --namespace-id`；DO 经 app 面 |
| teardown | URL 随版本存在；aliases 保留最近 1000 | `preview delete`；PR closed 事件 GHA 模板；500/100 上限自动淘汰 | `wrangler delete` + `d1 delete` + `kv namespace delete`；无官方自动淘汰，须自建清理 |
| cron/定时 | — | Preview 的 `scheduled()` **不跑** | 跑（计费为 requests；账户 cron 总量 250） |
| 版本前置条件 | 首传须先 deploy；DO 迁移变更不能走 versions upload | wrangler ≥4.135.0 | 无 |

## 6. 我栈接入点事实（机制 × repo 现状，不裁决）

- CD 已单点化：`scripts/deploy-staging.sh` 是 CD/手动共用的唯一部署流（deploy-staging.sh:4-8）；新增 per-PR 流会新增并行部署入口（与 engineering.md:42 的"staging 只经此入口"制度面的事实关系待裁决，非本票范围）。
- KV namespace 共享面：`5b39e87d…` 被 dev rig 与 staging 共用（§1）——任何 per-PR 隔离方案都要决定该 namespace 的归属（事实陈列）。
- D1 schema 无流水线位（deployable-units.md:30）——per-PR 库的 schema 应用没有现成管道步骤可复用。
- `compatibility_date` 2026-09-29（wrangler.staging.jsonc:11）→ `enable_ctx_exports` 默认开（≥2025-11-17，previews/resources「Use ctx.exports」）→ Previews 的 DO 自动隔离对我栈可用，但 env 绑定声明坑（§3.2）仍适用（我栈 6 个绑定全是 env 形态）。

## 7. 未决（JOINT-UNKNOWN）

- **J1 Version URL 生命周期**：官方页未写自动过期/保留期；仅写"创建后可用"与 alias 1000 保留（§2.1）。版本本身无上限条款（deployment limit=最近 100 可部署）。对我栈失效——DO 限制（§2.2）使 J1 无当前裁决价值。
- **J2 DO namespace 账户级数量上限**：limits 页未列；Previews 的"每 Preview 一 namespace"是否受同一上限约束未写。
- **J3 `wrangler delete` 对 DO 存储的连带语义**：已抓取文档页未写；只有 tombstone/`deleted_classes` 的显式销毁语义（§4.4）。
- **J4 Previews 计费口径**：无独立价目行（§4.2 FACT-OF-ABSENCE）；Preview 调用是否走同一 Workers requests/CPU 计量未在 pricing 页显式声明。
- **J5 Workers Builds 路径**：Workers Builds 的 Preview Builds（build-branches 文档）是 GHA 之外的官方 CI 替代，本票未展开（#244 范围以 wrangler 机制为准；examples 页仅锚定存在性）。

## 8. 证据来源清单

官方（developers.cloudflare.com，抓取 2026-10-05）：
workers/versions-and-deployments/ · workers/versions-and-deployments/version-urls/ · workers/versions-and-deployments/deployment-management/ · workers/previews/ · workers/previews/resources/ · workers/previews/configuration/ · workers/previews/examples/ · workers/previews/compare-workflows/ · workers/platform/limits/ · workers/platform/pricing/ · d1/platform/limits/ · d1/platform/pricing/ · d1/wrangler-commands/ · kv/platform/limits/ · kv/platform/pricing/ · kv/reference/kv-commands/ · durable-objects/platform/pricing/ · durable-objects/reference/durable-objects-migrations/ · durable-objects/reference/durable-object-class-migrations-legacy/

本仓：wrangler.staging.jsonc · .github/workflows/deploy-staging.yml · scripts/deploy-staging.sh · apps/server-worker/package.json · pnpm-lock.yaml · apps/server-worker/migrations/0001_control_plane.sql · apps/server-worker/test/migrate.ts · docs/research/deployable-units.md

AGENT GENERATED: by zhipu-coding-plan/glm-5.3-flash
