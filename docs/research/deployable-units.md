# R1 可部署单元盘点：单元 × 构建入口 × 缺口（wayfinder #163）

> 状态：**事实清单**（2026-10-04，research/deployable-units 分支 @ 6e08936）。只陈列事实与证据锚点（file:line），**不做**通道/打包选型裁决——供 #162 destination 细化与 R2（#164）分发通道事实对照。凡未经工具验证的推断一律标注 `[INFERENCE]` 或列入 §5 未决。

## 1. 单元总表

| # | 单元 | 产物形态 | 构建入口 | 部署面 | 实际部署状态 |
|---|------|----------|----------|--------|--------------|
| U1 | `cap-server-staging`（组合 server worker + SPA 资产） | wrangler bundle + static assets | flake `apps.staging-deploy` | `wrangler.staging.jsonc` → workers.dev | **唯一真实部署单元**（engineering.md:12） |
| U2 | bb SPA dist（前端资产） | vite 静态产物（含 gz/br 预压缩） | bb 子模块 `@bb/app` `pnpm build` | 无独立部署——staging 进 `apps/server-worker/public/` | 仅作为 U1 资产被消费 |
| U3 | daemon 客户端（宿主执行器 + vendored omp tool-runtime） | Bun 直跑 TS 源码，**无打包产物** | 无（源码即入口） | 手工 `bun src/client/index.ts` | POC 形态，无发布 |
| U4 | `cap-server-worker`（M0 占位目标） | wrangler 配置 | 同 U1 组合入口 | `wrangler.jsonc`，D1 id 全零占位 | 按票 #26 设计为**未部署**（wrangler.jsonc:17-19） |
| U5 | `cap-daemon-worker` / `provider-app`（#27/#28 独立期单元） | wrangler 配置 + workspace 库 | 各自 wrangler.jsonc（无流水线引用） | 无 | #31 组合后降级为库（U1 依赖），无部署引用 |
| U6 | `daemon-service` / `agent-do` / `agent-do-hookup`（包级 wrangler 目标） | dev/POC rig 配置 | 各自 wrangler.jsonc | 本地 wrangler dev / 测试 rig | 非部署单元 |
| U7 | `@cap/protocol` / `@cap/agent-do` / `@cap/daemon-service`(库侧) / `@cap/scripts` | TS 源码（workspace exports，无 build 产物） | typecheck/test scripts | — | 纯库/工具，wrangler 打包时内联进 U1 |

## 2. 逐单元事实

### U1 cap-server-staging — 组合 server worker

- **组合入口**：`apps/server-worker/src/index.ts` 是 #31 组合部署入口——imports `DaemonServiceDO`（@cap/daemon-service, :2-6）、`HostOrchestratorDO`（@cap/daemon-worker, :7）、`ManagerDo`/`createEdgeAgentAdapter`（@cap/provider-app, :8-15）、本地 `NotificationHubDO`/`LeaseStoreDO`（:18-19）；导出组合 DO 类 `ComposedAgentDO`（:44-51）、`ComposedHostOrchestratorDO`（:58-65）。
- **依赖声明**：`apps/server-worker/package.json:14-21` — `@cap/agent-do`、`@cap/daemon-service`、`@cap/daemon-worker`、`@cap/provider-app` 均 `workspace:*`。
- **wrangler 目标**（wrangler.staging.jsonc）：name `cap-server-staging`（:9）；compatibility_date 2026-09-29 + nodejs_compat（:10-11）；assets directory `public`、`run_worker_first: true`（:13-18）；D1 `DB`+`HOSTS_DB` 双绑定同一库 `cap-control-plane`，id `4e823d64-cc93-4922-b576-ec1a455c02aa`（:19-31）；6 个 DO 类 v1 sqlite migration（:33-54）；KV `DAEMON_EDGE_KV` id `5b39e87d559b424a8f6432e6a2bc9ff7`（:56-64）；cron `*/5`（:65-67）；vars 含 `ACCESS_CHECK_ENABLED: "false"`（:68-74）。
- **构建/部署入口（唯一）**：flake `apps.${system}.staging-deploy`（flake.nix:19-77），流程：source `.dev.vars`（CLOUDFLARE_API_TOKEN/ACCOUNT_ID 必在，:29-39）→ 构建 bb SPA 并 cp 进 `apps/server-worker/public/`（:49-55）→ 资产断言（index.html entry JS 存在 + assets ≥10，事故 #39 防回归，:57-66）→ `wrangler versions secret put SERVER_VERSION=<sha>`（:69-71）→ `wrangler deploy -c wrangler.staging.jsonc`（:73）。工具链 flake 钉 nodejs_22+pnpm_10（:11-14,23）；wrangler 本体走 pnpm devDeps `^4.147.0`（apps/server-worker/package.json:28）——**非 nix 钉版**。
- **制度锚**：staging 部署只经此入口 = engineering 实践 12（docs/engineering.md:42）；入口落地于 4329b20，ops 记录 fdc385d。
- **版本可见性**：`SERVER_VERSION` 为 runtime secret，消费点 `/system/version`（apps/server-worker/src/routes/system.ts:226-230，缺省 `0.0.0-dev`；env.ts:52-53）。
- **staging 滞后事实**：handoff 记录当前 staging=76a00b9（docs/ops/handoff-2026-10-04.md:26）；main 此后已前进（本分支 base=6e08936）。

**U1 缺口**：
1. **D1 schema 不在任何流水线**：`apps/server-worker/migrations/0001_control_plane.sql` 全仓唯一 schema 源（bb schema 8473d8c33 手工移植，:3-4）；测试侧经 test/migrate.ts 应用（test/migrate.ts:4-8），部署侧 staging-deploy **无任何 `wrangler d1` 步骤**（全仓无 `wrangler d1` 引用，仅 bb 子模块内部自有 CI 有）。远端库 schema 现状=手工一次性应用 `[INFERENCE: 由上两事实归因]`。**（#295 已闭环：deploy-staging.sh 在 deploy 前幂等重放 `migrations/*.sql`，runbook docs/ops/staging-d1-migrations.md。）**
2. **手动部署**：无 CD workflow（.github/ 仅 ci.yml + project-board-sync.yml），merge→deploy 无钩子。
3. **SERVER_VERSION 机制 quirk**：经 `versions secret put`（version-scoped）先于 `wrangler deploy` 盖章（flake.nix:71,73）；version-scoped secret 与后续普通 deploy 的交互**未验证**（JOINT-UNKNOWN，§5）。
4. **staging relay mock 模式**：MODEL_RELAY_* secret 缺席，live glm-5.3 挂起问题 #34 未决（wrangler.staging.jsonc:5-8 注释记录）。
5. **Access 前门未启用**：`ACCESS_CHECK_ENABLED: "false"`（staging:69），#56 落地前 daemon face 鉴权靠 hostKey 阶梯。
6. **双配置漂移面**：wrangler.jsonc（U4）与 wrangler.staging.jsonc 结构重复（DO/migration/KV/cron 块两份维护），compatibility_date/vars 已各自演化。

### U2 bb SPA dist

- **pin**：submodule `bb` @ `ba4265453888d6aa926fb1326f2de02db9a13bb4`（main 树 `git ls-tree origin/main bb`），describe=`desktop-nightly-2-gba4265453`，remote=Samuka007/bb。
- **构建入口**：`bb/apps/app/package.json:10` — `pnpm build` = PWA icon 生成 + `vite build` + `precompress-app-dist.mjs dist`（gz/br 预压缩）→ `bb/apps/app/dist`。
- **消费路径两条**：① flake staging-deploy 全量 cp（含 gz/br，flake.nix:52-54）；② CI 构建后 tar 复制**排除** `*.gz *.br`（ci.yml:27-32，`--ignore-scripts` 因 node-pty 桌面依赖在 runner 上失败，:25-26）。两条路径的产物集不同（部署含预压缩、CI 测试不含）。
- **staging 位置**：`apps/server-worker/public/` 在 .gitignore（.gitignore:9）——**SPA 无版本化产物**，唯一版本溯源=submodule pin + 部署时 echo（flake.nix:50）。
- **bb 消费边界**：主仓 src 零直接 import bb 路径（apps/、packages/ grep 无命中）；bb 的 schema 仅作移植出处被引用（migrations/0001_control_plane.sql:3）。bb 自身 web/connect 两个 wrangler 部署（bb/.github/workflows/deploy-web.yml, deploy-connect.yml）是 **bb 内部产品面**，与本仓无关。

### U3 daemon 客户端 + vendored omp tool-runtime（宿主侧）

- **入口**：`packages/daemon-service/src/client/index.ts` — "plain Bun/Node process on the user's machine"（:2-4），argv `--url/--dataDir/--sandbox` + env `POC_SERVICE_URL/POC_DAEMON_DATA/POC_SANDBOX_ROOT/POC_ENROLL_KEY`（:30-37），缺省值全是 poc-dev 形态（`poc-dev-enroll-key`、/tmp 沙箱）。
- **实际启动方式**：从 TS 源直跑 `bun src/client/index.ts --url …`，cwd=packages/daemon-service——scripts/poc-full-chain.ts:295-297、packages/daemon-service/scripts/poc-smoke-service.ts:139-141 两处一致。**无 package.json bin/script、无 flake app、无编译产物**。
- **tool-runtime**：vendored omp 经 npm 精确 pin `@oh-my-pi/pi-coding-agent` 18.6.0 + `@oh-my-pi/pi-natives` 18.6.0（package.json:17-18）；"omp executes ONLY under Bun"（raw TS + bun built-ins，Node 仅过 tsc 类型面）——client/process 必须以 Bun 启动（src/client/tool-runtime.ts:20-26）；vendoring=依赖钉版而非拷贝树（:11-18）。
- **CI 门**：`pnpm --dir packages/daemon-service test:runtime`（package.json:12，五套 Bun-only 语义件）在 setup-bun@v2 下跑（ci.yml:36-42）。
- **env 面**：`DAEMON_TASK_ISOLATION`（#110）、`DAEMON_AGENT_AUTH`（#145）已进入口（client/index.ts:35-36）；`.staging-daemon.env` 在 .gitignore（:7）但**全仓无任何脚本/文档消费它**。

**U3 缺口**：零打包（无 bin、无版本戳、无 release 产物）；env 命名仍 POC_* 且缺省密钥是 dev 值；omp 为 native addon（pi-natives）→ 未来若产出二进制则**天然平台相关**（[INFERENCE]：pi-natives 为原生模块性质，未验证具体分发形态）；staging 对接的鉴权 env 面（CF Access service token，cf-access-agent-compat.md:184-188 规划）未落地进任何入口。

### U4-U6 wrangler 目标全量清点（7 个配置，1 条部署路径）

| 配置 | name | 性质 | 证据 |
|---|---|---|---|
| apps/server-worker/wrangler.jsonc | `cap-server-worker` | M0 占位，D1 id `00000000-…` 显式未部署 | wrangler.jsonc:3,17-19 |
| apps/server-worker/wrangler.staging.jsonc | `cap-server-staging` | **唯一部署目标** | :9,23 |
| apps/daemon-worker/wrangler.jsonc | `cap-daemon-worker` | #27 独立期单元；#31 后作为库被 U1 消费，无部署引用 | :3；git log（dc94125 后无部署相关变更） |
| apps/provider-app/wrangler.jsonc | `provider-app` | #28 独立期单元；同上降级为库（compat date 2026-10-01 与 sibling 不齐） | :2-4 |
| packages/daemon-service/wrangler.jsonc | `daemon-service` | dev/POC rig（TestAgentSinkDO 顶替 AgentDO；vars 内嵌 poc-dev 密钥） | :11-18,27-34 |
| packages/agent-do/wrangler.jsonc | `agent-do` | dev/POC rig（TestDaemonServiceDO） | :3-13 |
| packages/agent-do/wrangler.hookup.jsonc | `agent-do-hookup` | 本地 E2E rig——poc-full-chain.ts:9 的 wrangler dev 目标（真 DaemonServiceDO 组合） | :3-14 |

- KV id `5b39e87d559b424a8f6432e6a2bc9ff7` 被 4 处配置共享（server-worker ×2、daemon-service、agent-do hookup）——dev rig 与 staging 共用同一 namespace。
- provider-app/daemon-worker 降级为库的证据：apps/server-worker/package.json:15-19 依赖二者；src/index.ts:7-15 import。

### U7 库与脚本

- `@cap/protocol`/`@cap/agent-do`/`@cap/daemon-service`/`@cap/provider-app`：全部 `private: true`，exports 直指 TS 源（如 protocol/package.json:5-8），无编译产物——wrangler/esbuild 在 U1 打包时内联。
- `@cap/scripts`（scripts/）：poc-full-chain.ts（#34 全链 E2E 驱动，:24 `bun scripts/poc-full-chain.ts`）+ pm-autopilot.ts；typecheck/test only，非部署单元。

## 3. 构建面全景

1. **flake.nix**（2 outputs）：`devShells.default`（nodejs_22+pnpm_10，:10-15）；`apps.staging-deploy`（:19-77）。
2. **pnpm**：workspace=packages/*、apps/*、scripts（pnpm-workspace.yaml:1-4；bb 是独立 workspace 不在内）；root scripts lint/format/typecheck/test（package.json:8-13）；typecheck 穷举 7 个成员（:12）；特殊脚本：daemon-service `test:runtime`（Bun-only）、agent-do `test:hookup`/`smoke:poc`、server-worker/daemon-worker `gen:types`（wrangler types）。engines node ≥22.19.0（:5-7）。
3. **GHA**（2 workflows）：ci.yml=verify 单 job（submodules recursive :12-14 → frozen-lockfile :22 → bb SPA build :27-32 → lint/typecheck/test :33-35 → Bun test:runtime :36-42）；project-board-sync.yml=看板自动化（:11-13，非构建面）。**无 deploy workflow**。
4. **wrangler 目标**：7 个（§2 表）。
5. **bb 子模块 pin**：`ba4265453888`（唯一被消费路径 bb/apps/app 的 SPA dist）。
6. **工具链双钉版面**：本地=flake（node/pnpm）；CI=actions（pnpm@10, node 22, bun 1, ci.yml:15-21,39-41）——两套钉版各自维护，wrangler 版本随 pnpm lock 两侧一致。

## 4. 跨单元缺口汇总（供 #162 destination 消费，非裁决）

1. **发布产物不存在**：所有单元的"构建入口"终点都是 `wrangler deploy`（CF 侧拉源码自打包）或 Bun 直跑源码；仓内无任何版本化 artifact 可被远端机器消费——与 #162 "本机构建 nix 打包+远端薄消费" 的目标面之间目前是**零产物**状态。
2. **唯一部署入口是手工命令** `nix run .#staging-deploy`（engineering.md:42），且要求构建机有 node_modules + bb submodule + .dev.vars（flake.nix:29-44）——即隐含"repo checkout 全量环境"，非闭包消费形态。
3. **D1 schema 无流水线位**（U1 缺口 1；#295 已闭环——部署链幂等重放）。
4. **daemon 客户端零打包零版本**（U3）——远端 NixOS（cap-verify）若要跑 daemon，现有入口形态不可直接消费。
5. **6/7 wrangler 配置无部署路径**：2 个降级库的配置残留 + 3 个 dev rig + 1 个 M0 占位；只有 staging 一条活路。清理与否则是打包选型时的输入事实。
6. **版本溯源三点分离**：worker 版本=runtime secret（SERVER_VERSION）、SPA 版本=submodule pin（部署时 echo）、daemon=无。无统一 release 号。
7. **staging 落后 main**（handoff:26 记录 76a00b9），手工部署节奏所致。

## 5. 未决（JOINT-UNKNOWN，留给 destination/R2）

- `wrangler versions secret put SERVER_VERSION` 与后续 `wrangler deploy` 的版本交互（version-scoped secret 是否在普通 deploy 后仍生效）——未验证。
- staging D1 远端 schema 当前真实形态（migrations 链是否与 0001 一致）——未连 CF 查询。
- pi-natives 的实际分发形态（native addon 平台矩阵）——未验证，影响 U3 未来二进制化。
- provider-app/daemon-worker 的 wrangler 配置是否有任何历史部署记录（CF 侧 workers 列表未查）。

AGENT GENERATED: by zhipu-coding-plan/glm-5.3-flash
