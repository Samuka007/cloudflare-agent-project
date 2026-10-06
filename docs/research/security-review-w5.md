# W5 Oracle Security Review（#389）

- 日期：2026-10-06
- 审计对象：`Samuka007/cloudflare-agent-project` @ `41a60f1`（= origin/main，lane 分支审查基线）
- 方法：omp `security_scan` 被 OAuth 凭据策略挡住（zhipu=key 型），按用户裁决自组织 oracle 评审：4 个只读 `security-reviewer` 分片按信任边界扫全仓（bb/ 子模块排除）+ PM 依赖面审计（pnpm audit）+ PM 对全部高危/中危发现逐条回读源码验证。
- 产出契约对齐 security_scan：发现清单（rule/title/severity/location/evidence/remediation）+ coverage 诚实声明 + PM validate（validated/rejected/partial）+ 高危修复票。

## Executive Summary

| severity | 数量 | ID |
|---|---|---|
| critical | 1 | 001 |
| high | 2 | 002, 003 |
| medium | 3 | 004, 005, 006 |
| low | 4 | 007, 008, 009, 010 |
| informational | 6 | 011–016 |

全部 16 条发现 **validated**（无 rejected；无 partial——每条的代码级证据均经分片引用，其中 8 条另经 PM 亲自回读源码复核，见 §Validation）。依赖面干净：pnpm audit（prod+dev）451 个依赖 0 advisory。

三个系统性根因（对应三张修复票）：

1. **#001 (critical) 控制面无鉴权**：`ACCESS_CHECK_ENABLED=false` 是两个 wrangler 配置的出厂值，`accessGate` 除字符串 `"true"` 外一律放行（fail-open）；origin guard 对无 Origin 头的客户端（curl/SDK/手搓 WS）完全无效。staging `cap-server-staging.dai-samuel.workers.dev` 按 deploy workflow 注释**明确运行在 Access off 状态**——匿名者可铸造 join code、领取部署级 hostKey、读任意线程时间线与宿主任意绝对路径文件、浏览宿主目录、CRUD provider 配置、订阅任意线程的实时模型流。
2. **#002 (high) 守护面凭据 fail-open 到仓库公开字面量**：组合入口在 secret 未设时回退 `poc-dev-enroll-key`/`poc-dev-host-key`（三处代码 + 两处 wrangler 配置）；daemon 客户端侧已修复为 fail-closed，服务端不对称。
3. **#003 (high) 存储凭据经 test/discover 面外泄**：PATCH 改 baseUrl 保留已存密钥（keep 协议），`/test` 与 `/discover-models` 服务端解密并把明文 key 发往该 baseUrl——配合 #001 即匿名外泄真实 provider API key。

## Findings

严重度判定标准：critical/high 必须有具体攻击路径（未鉴权可达、秘密暴露、注入、沙箱逃逸）；无凑数发现；informational 仅记录值得加固的事项。

### SEC-W5-001 · critical · `unauthenticated-control-plane`

- **Title**：`/api/v1/*` 与 `/ws` 全控制面未鉴权：Access gate 出厂关闭且 fail-open
- **Location**：`apps/server-worker/wrangler.jsonc:84`；`apps/server-worker/wrangler.staging.jsonc:81`；`apps/server-worker/src/middleware/access.ts:199-209`（gate 在 `ACCESS_CHECK_ENABLED !== "true"` 时直接 `next()`）；`apps/server-worker/src/middleware/origin-guard.ts:112-128`（无 Origin 头即通过）；`apps/server-worker/src/app.ts:37-61`（中间件装配）；`.github/workflows/deploy-staging.yml:55-58`（注释自证 staging "workers.dev with Access off"）
- **Evidence**：无任何路由注册 per-route auth（分片枚举全部 ~60 个注册）；具体匿名链：(a) `GET /threads`、`/threads/:id/timeline` 读全部线程内容；(b) `GET /threads/:id/host-files/content?path=<绝对路径>` 经 `host.read_file` 读宿主任意文件（`routes/threads.ts:814-888`）；(c) `GET /hosts/:id/directory?path=/` 浏览宿主目录；(d) `POST /hosts/join-codes`（`routes/hosts.ts:49-65`）铸造 join code → `/enroll` 返回部署级 hostKey → 可伪装任意宿主接 `/ws`；(e) provider CRUD + 存储凭据外泄（见 #003）；(f) 匿名 WS 订阅 `thread-detail:<id>` 收实时模型流 delta（`ws/hub.ts:53-74,110-134`）。JWT 校验器本身实现正确（RS256 强制、kid→JWK、exp、aud；`ACCESS_AUD` 未设时 fail-closed）——问题不在校验器，在 flag 把唯一的门整个关掉。CORS 同源策略使浏览器侧 CSRF 有限，暴露面是直接匿名 API 访问。
- **Remediation**：fail-closed——默认 enforcing（或 gate 关闭时拒绝 `/api/v1/*`，仅显式 local-dev 标记放行）；部署前把两个 wrangler 配置翻转并配齐 `ACCESS_TEAM_DOMAIN`/`ACCESS_AUD`；`deploy-staging.sh` 加部署期断言（gate 必须开启）。
- **Validate**：**validated**。PM 亲自回读 `access.ts:207-209`、`wrangler.jsonc:84`；`deploy-staging.yml:55-58` 注释证实 staging 实际 Access off（SHARD-2 定 critical、SHARD-4 定 high，取 critical：staging 活暴露 + 出厂 fail-open）。

### SEC-W5-002 · high · `fail-open-default-daemon-credentials`

- **Title**：daemon 面凭据在 secret 未设时静默回退到仓库公开的 poc-dev 字面量
- **Location**：`apps/server-worker/src/index.ts:134-135`（组合入口，`env.ENROLL_KEY ?? "poc-dev-enroll-key"`、`env.DAEMON_HOST_KEY ?? "poc-dev-host-key"`）；`packages/agent-do/src/worker.ts:168`（`/drive` 面 `?? 'poc-dev-host-key'`）、`:302-303`；`packages/agent-do/wrangler.hookup.jsonc:23-26`；`packages/daemon-service/wrangler.jsonc:27-36`（明文 vars）；`packages/daemon-service/scripts/poc-smoke-service.ts:35-36`
- **Evidence**：`POST /enroll` 带公开 enrollKey 即返回部署级 hostKey（`daemon-service/src/worker.ts:249,282`），随后 Bearer hostKey 开 session、接 WS、驱动 `/agent/*`。`deploy-staging.sh` secrets-file 只写 `SERVER_VERSION`，wrangler 语义是"文件里没有的 secret 沿用上一版本"——staging 是否曾 `wrangler secret put` 过无法从仓库证实（JOINT-UNKNOWN），但 fail-open 默认本身是确定缺陷。不对称：客户端侧已 fail-closed（`daemon-service/src/client/index.ts:32-36` 拒绝 dev 默认启动；`docs/ops/cap-verify.md:179` 记录此修复），服务端没跟。
- **Remediation**：删除组合入口与 agent-do rig 的回退字面量，非本地 env 缺 secret 即启动失败；`wrangler.hookup.jsonc`/`wrangler.jsonc` 的明文 vars 移除改 `wrangler secret put`。
- **Validate**：**validated**。PM 亲自回读 `index.ts:134-135`（逐字一致）；`deploy-staging.sh` 只含 SERVER_VERSION 亦经 PM 回读确认。

### SEC-W5-003 · high · `stored-key-exfil-via-test-probe`

- **Title**：test-connection/discover-models 面构成存储 provider 密钥的解密外泄 oracle
- **Location**：`apps/server-worker/src/routes/system.ts:641-687`（`/system/providers/:id/test`）、`:692-702`（`/discover-models`）、`:582-640`（PATCH baseUrl 独立可改）；`apps/server-worker/src/services/provider-config-test.ts:57-75,124-148`（把 key 放入 `authorization`/`x-api-key` 头发往 `target.baseUrl`）；`apps/server-worker/src/db/provider-configs.ts:48-60,158-194`（解密出明文；PATCH 改 baseUrl 不要求凭据重录）
- **Evidence**：PUT/PATCH baseUrl 且不带 apiKey 字段 → 存储密钥保留（credential 协议的 `keep`）；随后 `/test`（PM 亲读 `system.ts:680-685`：`apiKey: await readProviderConfigSecret(...)` 发往 `target.baseUrl`）把明文 key 送到攻击者控制的服务器；`/discover-models` 按 providerId 分支同构（`system.ts:832-836`）。无需响应内省，key 到达攻击者服务器即完成外泄。baseUrl 无 scheme/host 校验。repo 自身已有同型判例：`provider-app/src/relay-registry.ts:96-106` 禁止用户自填 baseUrl 落共享 relay key——探测面没有同等待遇。
- **Remediation**：baseUrl 变更即作废存储凭据的探测资格（只发往 key 录入时的 baseUrl，或要求变更后重录凭据/清空凭据）；baseUrl 加 https + 公网域校验；探测面限流。
- **Validate**：**validated**。PM 亲自回读 `/test` 与 `/discover-models` 路由体；PATCH-keep 与"无 scheme 校验"经 SHARD-2/SHARD-4 独立一致引用。严重度取 high（SHARD-4 high / SHARD-2 medium，取严：真实存储凭据外泄，且当前叠加 #001 即匿名可达）。

### SEC-W5-004 · medium · `hostid-not-bound-to-presented-key`

- **Title**：认证身份从不与目标 hostId 绑定：body/query hostId 无条件覆盖鉴权派生的 host
- **Location**：`packages/daemon-service/src/worker.ts:289-310`（`handleSessionOpen`：`const hostId = typeof parsed?.hostId === "string" ? parsed.hostId : hostIdHint`）、`:468`（`/agent/*` 取 body `machineId`）、`:574-581`（`?hostId=`）、`:591-612`（`authorize()` 只产出 hint）；`packages/daemon-service/src/service-do.ts:596-633`（session 替换原语：`close(1000,'replaced')` 顶掉受害 socket）、`:1703-1707`（`verifyAttachmentSession` 校验的是已被伪造的 session）；`apps/server-worker/src/services/attachment-pickup.ts:45-65`
- **Evidence**：当前部署级共享 DAEMON_HOST_KEY 下这是"key 持有者控制所有宿主"的设计（`join-codes.ts:15-20` 文档化偏差）；M1 引入 per-host key 后同一代码变成具体 A→B 接管：以 host A key 对 host B session/open（顶掉 B 活 socket）、`/agent/journal` 读 B 日志（泄漏 `/ws` attach 所需 sessionId）、派发 bash、杀 B 执行。
- **Remediation**：`authorize()` 产出非空 hostIdHint 时，body/query hostId 与之不符即 403（`handleSessionOpen` + `agentHostStubOrNull` 两处）；M1 per-host key 落地后删除 override。
- **Validate**：**validated**。PM 亲自回读 `worker.ts:301`（逐字一致）；SHARD-1 与 SHARD-4 独立发现同一根因。

### SEC-W5-005 · medium · `attachment-serve-back-content-type-xss`

- **Title**：附件回源按客户端声明的 content-type 原样回放，无 disposition/nosniff/CSP → 同源存储型 XSS
- **Location**：`apps/server-worker/src/services/attachments.ts:166-200`（上传按 `file.type` 原样落 R2 httpMetadata）；`apps/server-worker/src/routes/projects.ts:262-272`（回源仅回 `content-type: attachment.mimeType ?? octet-stream`，无其他头）
- **Evidence**：可上传者（当前任何人，见 #001；gate 开后任意面板 principal）放 `text/html`/`image/svg+xml` 到同源 URL，受害者导航即执行攻击者脚本。路径遏制与 sha256 key 派生本身扎实（`attachments.ts:74-111`），纯回源头姿态问题。
- **Remediation**：回源加 `content-disposition: attachment`（附文件名）、`x-content-type-options: nosniff`；content-type 白名单或内联类型套 CSP sandbox。
- **Validate**：**validated**。PM 亲自回读回源路由体（`projects.ts:266-271` 仅 content-type 一头）；上传侧按 SHARD-2 引用行号。

### SEC-W5-006 · medium · `tool-shell-inherits-daemon-secrets`

- **Title**：每个工具 shell 继承 daemon 完整进程 env，含 enrollment 凭据与 LLM provider 密钥
- **Location**：`packages/daemon-service/src/client/executor.ts:65-70`（`env: { ...process.env, DAEMON_EXEC_MARKER/EXECUTION_ID/SANDBOX_ROOT }`）；来源 `packages/daemon-service/src/client/index.ts:42-43,64-65`（enrollKey/joinCode/agentAuth/provider 凭据 JSON 均从 `process.env` 读入且从不清理）
- **Evidence**：agent 执行的任意命令（产品核心路径，可经 prompt injection 触达）`env` 或 `/proc/self/environ` 即可读出部署级 enrollment 凭据（可再 `/enroll` 铸新宿主）与 provider 凭据。hostKey 本身不入 env（0600 文件），不受影响。
- **Remediation**：子进程 env 改显式 allowlist（PATH/HOME/TMPDIR/LANG/SHELL + 三个 `DAEMON_EXEC_*` 标记）取代 spread；provider 凭据按需单传。
- **Validate**：**validated**。PM 亲自回读 `executor.ts:65-70`（逐字一致，且代码注释自认"verbatim"是有意的 PATH 契约——修复时需保留 host-profile PATH 基线语义）。

### SEC-W5-007 · low · `join-code-kv-replay-window`

- **Title**：join-code 单次使用存在 KV 最终一致回放窗口
- **Location**：`packages/daemon-service/src/join-codes.ts:82-107`（redeem-先于-delete，delete 失败被吞 `.catch(() => undefined)`）
- **Evidence**：Workers KV 最终一致，15 分钟 TTL 内另一 PoP 二次 redeem 同一 code 仍可能读到记录并铸出宿主身份。code 为 128-bit、哈希键控，爆破不可行。
- **Remediation**：返回成功前先写 consumed 墓碑值，或单次状态挪进 D1。
- **Validate**：**validated**（证据行号引用 + KV 一致性语义公开文档化；代码注释自认 POC 模型可接受残留）。

### SEC-W5-008 · low · `plaintext-secret-comparison`

- **Title**：secrets 用非常数时间字符串等值比较
- **Location**：`packages/daemon-service/src/worker.ts:249`（enroll key）、`:597`（hostKey 阶梯第一档）
- **Evidence**：V8 字符串比较非常数时间；Workers 边缘远程计时利用今天不现实，修复近零成本（`sha256Hex` 已在同文件使用；Workers 亦有 `crypto.subtle.timingSafeEqual`）。
- **Remediation**：比较 SHA-256 摘要或 double-HMAC。
- **Validate**：**validated**（SHARD-1 与 SHARD-4 独立引用同一两行）。

### SEC-W5-009 · low · `origin-guard-trusts-forwarded-headers`

- **Title**：origin guard 的信任锚含客户端可设的 forwarded 头
- **Location**：`apps/server-worker/src/middleware/origin-guard.ts:46-70,87-105`
- **Evidence**：请求目标集合取自 Host + 首个 `x-forwarded-host`、协议取自 `x-forwarded-proto`——非浏览器客户端可三者配套伪造过闸。浏览器无法设这些头，无浏览器 CSRF 路径；仅对本来就绕过 guard 的无 Origin 流量再降一档。
- **Remediation**：从信任锚剔除 forwarded 头（或只收 Cloudflare 注入值），保留 Host + request URL。
- **Validate**：**validated**（证据引用明确，防护定位诚实）。

### SEC-W5-010 · low · `relay-sse-unbounded-buffer`

- **Title**：relay SSE 解析器无单事件字节上限，敌意上游可撑爆 DO isolate 内存
- **Location**：`packages/agent-do/src/relay/sse.ts:18-64`（`buffer` 与 `dataLines` 无上限累积）；消费方 `relay/anthropic-provider.ts:171` 及 responses/completions 孪生
- **Evidence**：对照 `packages/mcp/src/transports/transport.ts` 已有 `DEFAULT_MAX_MESSAGE_BYTES` 每消息上限；模型 relay baseUrl 本部署就是经销商网关，敌意/被攻陷上游是现实威胁模型。r2BypassBytes 只限日志存储，不限峰值内存。
- **Remediation**：`parseSseStream` 内加每消息字节上限 + 累计流上限，超限抛 `ModelProviderError(afterFirstByte: true)`。
- **Validate**：**validated**（同仓对照引用有力）。

### SEC-W5-011 · informational · `do-ws-no-authentication`

- **Title**：AgentDO `/ws` 在 fan-out 前无鉴权（当前潜伏）
- **Location**：`packages/agent-do/src/agent-do.ts:1683-1721`
- **Evidence**：`acceptWebSocket` 先于任何凭据检查；`webSocketMessage` 的 threadId 等值检查在 `this.threadId === null` 时整体跳过；`pushToSubscribers` 随后推全量 journal delta。grep 证实现无生产调用方代理 socket 到该 DO（RPC-only）——纯 defense-in-depth 缺口，任何未来 fronting 一旦直连即泄漏。
- **Remediation**：acceptWebSocket 前要求部署域 token（host-key proof 或签名订阅授予），或删 DO 级 `/ws` handler 保留唯一鉴权属主（前置 hub）。
- **Validate**：**validated**。

### SEC-W5-012 · informational · `hub-no-per-socket-authz`

- **Title**：NotificationHubDO 无 per-socket 授权（设计如此，单租户 bb 对等）
- **Location**：`apps/server-worker/src/ws/hub.ts:36-50,53-74,110-134`
- **Evidence**：升级无自身检查、订阅键客户端任选（含任意 `thread-detail:<id>`）；遏制完全依赖升级前的中间件对。未来任何绕过中间件代理到 HUB 的路径或 gate 回退即成跨线程内容通道。与 #001 绑定的 defense-in-depth 记录。
- **Remediation**：升级时把 Access claims 盖进 socket attachment，DO 内校验订阅目标。
- **Validate**：**validated**。

### SEC-W5-013 · informational · `enroll-unauthenticated-kv-amplification`

- **Title**：未鉴权 `/enroll` 每请求一次 KV 读且无限流
- **Location**：`packages/daemon-service/src/worker.ts:99-101`；`packages/daemon-service/src/join-codes.ts:87`（凭据检查前先 KV read）
- **Evidence**：唯一未鉴权变更路由；`negotiateGuard` 只护 `/session/open` 与 `/ws`。code 爆破不可行，但攻击者可驱动无上限 KV 读量（成本/配额放大器）。
- **Remediation**：`/enroll` 前置 per-IP token bucket（复用 `edge.ts` 的 `takeToken`）。
- **Validate**：**validated**。

### SEC-W5-014 · informational · `cwd-only-sandbox-documented`

- **Title**：宿主执行边界为 cwd 级，读取面按设计宿主全局（文档化 POC 范围）
- **Location**：`packages/daemon-service/src/client/executor.ts:12-14`（自述"not a security boundary"）；`client/tool-runtime.ts:731-747`（bindWorkspace 收任意已存在目录）；`client/host-files.ts:109-148`（任意绝对路径读）
- **Evidence**：全部在 daemon-seam 鉴权之后；真正的逃逸原语是持有共享 hostKey（#001/#002/#004 链）。记录为生产前 scoping 事项，不算逃逸发现。
- **Remediation**：生产前上真实围栏（bubblewrap/landlock/systemd ReadWritePaths）；`host.read_file`/`browse_directory` 限定注册工作区根。
- **Validate**：**validated**（PM 亲读 executor.ts:12-14 注释）。

### SEC-W5-015 · informational · `provider-crypto-hardening-notes`

- **Title**：provider 配置加密核心健全，三处加固空间
- **Location**：`apps/provider-app/src/provider-config-crypto.ts:20-85`；`apps/server-worker/migrations/0003_provider_configs.sql`（密文列）
- **Evidence**：健全面：AES-256-GCM、每写新鲜随机 12 字节 IV（无复用）、WebCrypto 解密强制验签、D1 只存密文、逐行警告 fail-visible。缺口：(1) AES key = master secret 的单轮无盐 SHA-256（无 KDF 拉伸，仅高熵 secret 下可接受）；(2) 无 AAD 绑定 provider id——行间密文移植不可检测（身份混淆非直接泄露）；(3) 无 key-version/轮换机制（全局单 master key，轮换需全行重存）。
- **Remediation**：下次触及时 HKDF/PBKDF2 加盐、AAD 绑定 config id、1 字节 key-version 前缀。不紧急。
- **Validate**：**validated**（与 WebCrypto 语义一致）。

### SEC-W5-016 · informational · `arbitrary-baseurl-probe-face`

- **Title**：probe/discover 面可对任意 baseUrl 发起服务端请求（公网扫描/出口 oracle）
- **Location**：`apps/server-worker/src/services/provider-config-test.ts:47-55,124-148`
- **Evidence**：inline 分支 fetch 完全调用方控制的 URL，回显解析 model ids + 512 字节有界错误文本。Workers 出口无法达 RFC1918/link-local，经典内网 SSRF 受限；剩余价值是匿名公网扫描/代理跳板（叠加 #001）。带存储凭据的分支已归 #003。
- **Remediation**：暴露到 operator 边界之外时按 principal 限流 + https/公网域校验；保留现有 512 字节有界回显。
- **Validate**：**validated**。

## Validation 记录

PM 对 16 条逐条 validate，证据层级：PM 亲读源码（8 条：001/002/003/004/005/006/014 代码 + 002 的 deploy 脚本）> 双分片独立一致引用（003/004/008）> 单分片明确行号引用 + 公开语义（其余）。**无 rejected、无 partial**：抽样复核 8/8 与分片证据逐字一致，未见夸大攻击路径或幻觉行号。严重度仲裁两处取严：001（critical vs high→critical，staging 活暴露）、003（high vs medium→high，真实凭据外泄）。

## Coverage（诚实声明）

| 分片 | 范围 | 结论 |
|---|---|---|
| SHARD-1 SecDaemonService | `packages/daemon-service` 全部 src + `apps/daemon-worker` 全部 src + 双 wrangler + staging smoke 脚本 | 完成 |
| SHARD-2 SecServerWorker | `apps/server-worker` 全部 src（~60 路由全枚举）、中间件、db、migrations、lease-do、hub、install-sh、deploy 脚本 | 完成 |
| SHARD-3 SecAgentDoMcp | `packages/agent-do`、`packages/protocol`、`packages/mcp` src | 完成 |
| SHARD-4 SecCryptoD1Chain | `apps/provider-app` src、D1 migrations、env/凭据链跨包、全仓 secret 卫生 grep | 完成 |
| PM | 依赖面（pnpm audit prod+dev）、`.github/workflows`（3 文件）、全部高/中危发现回读验证 | 完成 |

**明确排除/未审**：
- `bb/` 子模块（工单裁决排除；gitlink 1 行）。
- 构建产物 `apps/server-worker/public/**`（SPA bundle）、`worker-configuration.d.ts`（生成类型）。
- 测试脚手架（各包 `test/`、`testing/`、`packages/mcp/conformance`）仅 grep 秘密/sink 模式，未逐行审。
- `packages/daemon-service/src/client/eval-kernel.ts`、`task-isolation.ts` 内核内部（vendored omp 三方内部；只审出入口 seam）。
- 部署态事实从仓库不可证：staging worker secrets 是否曾设置（#002 的利用前提）、域名是否另有人工 Access app（deploy workflow 注释否定）、`APP_EXTRA_ORIGINS` 生产值。

## 干净面（负面结果同样入档）

- **SQL 注入**：全仓无用户输入插值进 SQL；动态片段均为固定字面量，值一律绑定（SHARD-2/SHARD-4 双独立确认）。
- **提交秘密**：阴性全仓 sweep（私钥块、sk-/ghp-/AIza/xox token、.dev.vars、console.log 凭据材料）——无真实密钥；仅 poc-dev 字面量（已归 #002）与 dummy JWT。
- **D1 schema/查询**：provider_configs 无明文 key 列；投影面一律 `hasApiKey` presence-only；decrypt 失败逐行警告不泄材料。
- **models.yml 导入**：yaml 库解析（无代码执行）、512 KiB 请求上限、key 单程进 AES-GCM 或 422 拒绝、omp 凭据占位符键导入告警。
- **附件路径遏制**：sha256 key 派生 + 路径包含检查 + 大小上限扎实（#005 仅回源头姿态）。
- **install.sh**：静态、无查询插值、no-store。
- **DO id 派生**：`idFromName` + 服务端生成 id，无键遍历。
- **MCP oauth**：SDK v1.29 忠实移植，PKCE S256 强制、256-bit state、loopback 回调 state+path 校验、RFC 9207 iss 校验；scope 内无 OAuth token 落盘。
- **agent-do 事件完整性**：event-log append-only + zod 双向校验 + 参数化 SQL；rewind/cut 为 DO 侧投影标记，客户端不可追加/回写；跨线程结构排除（appendEvent 恒用 `this.threadId`）。
- **FSM**：journal 写入内部 + binding 门控；`onExecutionUpdate` 幂等 + 终态/offset 去重防双花。
- **relay 密钥在途**：仅入请求头，不入 URL/journal；错误体 512 字节有界且不回显请求头。
- **CI**：`ci.yml` push/pull_request（非 pull_request_target）、无 secret；`deploy-staging.yml` permissions read-only、凭据缺失 fail-closed；`project-board-sync.yml` PAT 仅用于 issue 生命周期状态写（无不可信输入进 script）。
- **依赖**：`pnpm audit`（prod+dev，451 依赖，2026-10-06 advisory DB）0 advisory。

## 高危修复票

| 发现 | 票 |
|---|---|
| SEC-W5-001 控制面无鉴权 | [#397](https://github.com/Samuka007/cloudflare-agent-project/issues/397) |
| SEC-W5-002 daemon 凭据 fail-open | [#398](https://github.com/Samuka007/cloudflare-agent-project/issues/398) |
| SEC-W5-003 存储凭据外泄 oracle | [#399](https://github.com/Samuka007/cloudflare-agent-project/issues/399) |

medium（004/005/006）建议随 M1 per-host key 与面板上传面批次切票；low/informational 留档于本报告，按批次带入。
