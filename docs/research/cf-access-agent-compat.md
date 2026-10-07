# CF Access × agent 自动化共存性 + IP 过滤路线评估

- 工单：Samuka007/cloudflare-agent-project#55（M0 staging 门禁前置考古）
- 检索日期：2026-10-04
- 依据：一手来源为 developers.cloudflare.com 官方文档（2026-08~10 更新版本）+ 我们账号的 CF API 只读实测（`cfat` token，账号 `99646ce7…cae0`）+ 仓库代码逐行核对。二手来源无。API 实测值标注（live 2026-10-04）。
- 关联：#17（Access 前置 + Worker 内 JWT 校验裁决）、#31（staging 组合部署）、#34（daemon face）、#36（边缘闸门）、docs/engineering.md 横切实践 7/11/12、docs/research/bb-daemon-protocol.md §5（hostKey 形状）、#412/#435（2026-10-06 单 root app 收敛与残留清理，实测结论见 §9）

---

## 0. 结论先行

**Access 是正确的主门禁，但只能用「hostname 型 self-hosted app」形态；IP 过滤只配当第二层，且必须走 WAF custom rules（Zone Lockdown 在 Free 套餐不可用；mTLS 需要 Enterprise/PAYG，出局；worker 级 Access 因 WebSocket 403 限制出局）。** 具体判定：

1. **主门禁**：在 `staging.samuka007.top`（custom domain，前置条件）上建 hostname 型 Access app：主 app 覆盖全站（Allow：owner 邮箱，浏览器 SPA + CDP 走 `CF_Authorization` cookie，默认 24h、全局会话有效期内自动续发）；daemon 缝合路径（`/enroll`、`/session/open`、`/agent/*`、`/agent-sink/*`、`/ws` attach）建**第二个更具体 path 的 Access app** 挂 Service Auth 策略（service token 头），Service Auth/Bypass 策略先于 Allow 评估是文档保证的顺序。hostKey 照旧只在缝合内验（engineering.md 规则 7 不动摇：Access 是围墙，hostKey 是门锁，两层各司其职）。（**2026-10-06 手术否决**：path app 拆面实测致 SPA CORS+WS 拒连——root 登录 cookie 过不了 path app 的门，生产已收敛单 root app，见 §9。）
2. **出局项**：worker 级 Access（`worker` destination）文档明示 WebSocket 升级一律 403，而我们 `/ws` 是核心信道；Access mTLS「Enterprise 与 PAYG Zero Trust 套餐可用，Free 不含」；Zone Lockdown「Free 套餐 0 条规则」。
3. **IP 过滤 = 第二层网络闸**：单条 WAF custom rule（Free 套餐限 5 条，够用）`http.host eq "staging.samuka007.top" and not ip.src in {家庭出口, VPS}` → Block。只在 custom domain 落地后才生效（workers.dev 主机名不在我们 zone，zone WAF 够不着）。CI 不受影响：今日 ci.yml 零 CF 流量，未来 wrangler deploy 只走 `api.cloudflare.com` 控制面，永不碰 app-plane；GH 托管 runner 出口 7,078 条 CIDR（live 实测 api.github.com/meta），做 allowlist 不现实，也无需做。
4. **应用内中间件照旧**：`ACCESS_CHECK_ENABLED=true` 的 `middleware/access.ts` 保留为纵深防御（它还能覆盖 workers.dev 直连面），与 edge 侧 Access 互补而非重复—— Access 在 edge 挡流量省钱，中间件防 Access 配置漂移。

---

## 1. 现状盘点（live API 只读实测 + 仓库证据）

| 项                                                  | 实测值（live 2026-10-04）                                                                                                                                                                                                                                                   | 证据                                                                                   |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| zone `samuka007.top`                                | Free 套餐、active；`browser_check=on`、`security_level=medium`、托管 WAF `off`                                                                                                                                                                                              | GET /zones、/zones/{id}/settings                                                       |
| zone WAF custom rules / IP access rules / lockdowns | **全部为空**（无任何已配规则，IP 过滤是绿地）                                                                                                                                                                                                                               | rulesets 列表仅 managed；`firewall/access_rules/rules`、`firewall/lockdowns` 返回 `[]` |
| Access 组织                                         | `samuka007.cloudflareaccess.com`（2024-09-30 建）；`strict_service_token_auth=false`（2026-10-05 前建的组织可自选开关）；`service_token_inactivity` 关闭                                                                                                                    | GET /accounts/{id}/access/organizations                                                |
| Access apps                                         | 4 个，**无一是 `.top` zone**（cvat/langfuse-priv-3090 在 samuka007.com + warp + launcher）→ staging 目前完全不在 Access 后面                                                                                                                                                | GET /accounts/{id}/access/apps                                                         |
| Service tokens                                      | 1 枚 `omp`（2026-09-13 建，8760h，2027-09-13 到期，未挂 policy）                                                                                                                                                                                                            | GET /access/service_tokens                                                             |
| Workers                                             | `cap-server-staging` 存活（2026-10-04 修改），跑在 `cap-server-staging.dai-samuel.workers.dev`（subdomain `dai-samuel`）；`/health`、`/api/v1/hosts` 实测 200、无 Access 挑战；zone workers routes 为空、custom domains 列表无 staging → **`staging.samuka007.top` 尚未挂** | GET /workers/scripts、/workers/subdomain、/workers/domains、实测 fetch                 |
| DNS                                                 | `.top` 上 5 对 A/AAAA 指向 VPS `43.139.31.220`（dns-only）；无 staging 记录、无 DDNS 记录                                                                                                                                                                                   | GET /zones/{id}/dns_records                                                            |
| 家庭 WSL 出口 IP                                    | `103.155.37.8`（live 实测 ifconfig.me）；cvat app 的 Allow policy 里已钉 `ip: 103.155.37.8/32` —— **Access 侧 IP 钉制先例**                                                                                                                                                 | live fetch + GET cvat app policies                                                     |
| staging 开关                                        | `ACCESS_CHECK_ENABLED="false"`（vars 烧死在 wrangler.staging.jsonc:62）                                                                                                                                                                                                     | 仓库 wrangler.staging.jsonc                                                            |
| daemon face 旁路                                    | `DAEMON_ROUTE_PREFIXES = ["/enroll", "/session/open", "/agent/", "/agent-sink/"]` + 「`/ws` 且带 `authorization` 头」→ 直接派发 `daemonServiceWorker`，**先于** `createApp`，即 originGuard/accessGate/CORS 全部不经过                                                      | apps/server-worker/src/index.ts:67-78、87-108                                          |
| 中间件覆盖面                                        | accessGate 挂在 `/api/v1/*` 与 `/ws`（先 originGuard 后 accessGate 后 CORS）；`/health`、`/assets/*`、SPA fallback 无鉴权                                                                                                                                                   | apps/server-worker/src/app.ts:26-50                                                    |
| 中间件实现                                          | 接受 `Cf-Access-Jwt-Assertion` 头或 `CF_Authorization` cookie（bearerToken, access.ts:45-61）；RS256 + team JWKS（10min 缓存）+ `aud`==`ACCESS_AUD` + `exp` 校验；claims 只要求 `aud`/`exp` 两项                                                                            | apps/server-worker/src/middleware/access.ts                                            |
| CI                                                  | ci.yml 仅 checkout/pnpm/lint/typecheck/test，**零 CF 流量**；仓库无任何 wrangler 调用                                                                                                                                                                                       | .github/workflows/ci.yml:1-35                                                          |

---

## 2. 问题 1：Access × 非交互自动化（脚本/cron/daemon）

### 2.1 Service Token 是官方唯一自动化通道

- 形态：Client ID + Client Secret 一对，请求头 `CF-Access-Client-Id` / `CF-Access-Client-Secret`；Secret 仅创建时显示一次；2026-08-26 起新 Secret 为 `cfast_[40位][8位校验和]` 格式（便于凭据扫描器识别）。[来源：Service tokens — https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/ ]
- 创建可全 API 化：`POST /accounts/{id}/access/service_tokens`（权限 `Access: Service Tokens Write`），`duration` 如 `8760h`；到期前 **Refresh +1 年** 或改 duration 延长。[来源：同上 ]
- 授权入口：app 的 policy action 必须是 **Service Auth**（文档原文：不设 Service Auth「Access will prompt for an identity provider login」）；selector 可选 `Service Token`（指定某枚）/ `Any Access Service Token`（账号内任意枚）/ `IP ranges`（IPv4/v6 + CIDR，可作 Include/Require）/ `Common Name` / `Valid Certificate`（mTLS）。[来源：Service tokens 同页；Access policies — https://developers.cloudflare.com/cloudflare-one/access-controls/policies/ ]
- **策略评估顺序是文档保证**：Bypass 与 Service Auth 策略先于 Block/Allow 评估（「Service Auth C > Bypass D > Allow A > Block B > Allow E」）。[来源：Access policies §Order ]
- 计费/席位：**「Service tokens do not consume seats」**（glossary、seat-management、device-registration 三处一致）；Zero Trust Free 层即可用 service token。[来源：https://developers.cloudflare.com/cloudflare-one/glossary/ ；https://developers.cloudflare.com/cloudflare-one/team-and-resources/users/seat-management/ ]
- 轮换：Rotate 只换 Secret、Client ID 不变，可设 1 小时~30 天宽限期双 Secret 并行（API `POST …/service_tokens/{id}/rotate` + `previous_client_secret_expires_at`）。[来源：Service tokens §Rotate ]
- 审计：strict 模式下失败返回 401/403（不再 302 重定向登录页）；「已识别 token 的失败请求进 Access authentication logs（非身份认证日志）」——过期/停用 token、错 Secret、未授权 app 都记录；**畸形头与未知 Client ID 不记录**。Bypass 策略则「requests are not logged」——这是 Service Auth 优于 Bypass 的决定性理由。[来源：Service tokens §Strict ；Access policies §Bypass ]

### 2.2 strict_service_token_auth 的行为契约（建议开启）

开启后（组织 2024-09-30 建，目前 `false`，可开；2026-10-05 后新建组织强制开且不可关；CF 官方建议所有旧组织开启）：

- 失败一律 401/403，不 302（自动化客户端可编程判定）；
- **只认 Service Auth 策略**：忽略 Allow 策略与请求携带的任何 `CF_Authorization` cookie；
- **认证成功后不再返回 `CF_Authorization` cookie**，后续请求必须继续带头 —— 即「头换 cookie 引导浏览器会话」这条历史歧路被正式封死（§3.3）。

[来源：Service tokens §Strict service token authentication ；changelog 佐证 https://developers.cloudflare.com/cloudflare-one/changelog/access/ ]

### 2.3 mTLS 选项：出局

「Access mTLS is available with **Enterprise and pay-as-you-go Zero Trust plans. It is not included in the Free plan.** Free customers can use service tokens.」mTLS 认证成功会回 `CF_Authorization` Set-Cookie（可引导浏览器），但套餐门槛直接否决。[来源：Mutual TLS — https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/mutual-tls-authentication/ ]

### 2.4 程序化获取 JWT：哪些路通、哪些路不通

- **通**：service token 头 → edge 校验 → 转发请求携带 `Cf-Access-Jwt-Assertion`（app token JWT，service token 形态的 claims 为 `common_name`=Client ID、`sub=""`、`aud`/`exp`/`iat`/`iss`）。我们中间件的 `accessClaimsSchema` 只要求 `aud`+`exp`，**与 service token JWT 完全兼容**（live 对照 middleware/access.ts:19-26 与文档 claims 表）。[来源：Application token — https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/ ]
- **通**：`GET https://<team>/cdn-cgi/access/get-identity`（带 `CF_Authorization`）取完整身份，含 `service_token_id`/`service_token_status`/`common_name`——审计归属用。[来源：同上 §User identity ]
- **不通（email OTP 不可脚本化）**：OTP 单次有效、10 分钟过期，为「人从邮箱抄码」设计；官方给自动化留的唯一路就是 service token。[来源：Troubleshoot Access — https://developers.cloudflare.com/cloudflare-one/access-controls/troubleshooting/ （OTP 时效）；Service tokens 定位原文「You can provide automated systems with service tokens…」]
- **不通（API token 登录）**：`cfat_*` 这类 Cloudflare API token 只作用于控制面（api.cloudflare.com），不产生 Access 会话/JWT，两套体系无交集。[INFERENCE：全部 Access 文档中 API token 仅以「管理 Access 配置的凭据」身份出现；无任何「API token 换 Access JWT」端点]

---

## 3. 问题 2：Access × 真实浏览器（CDP Chrome）

### 3.1 cookie 生命周期与自动续期

- Access 发两枚 JWT：全局会话 token 存 team domain（`<team>.cloudflareaccess.com`），application token 存被保护域（`staging.samuka007.top`）。时长链：policy session > application session > global session > 默认 24h（global 可设 15 分钟~1 个月）。[来源：Authorization cookie — https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/ ；Session management — https://developers.cloudflare.com/cloudflare-one/access-controls/access-settings/session-management/ ]
- **自动续发有文档保证**：「When the application token expires, Cloudflare will automatically issue a new application token if the global token is still valid」——即 CDP Chrome 只要全局会话活着，app cookie 过期无感续期；全局过期才需要重新走一次 IdP 登录。[来源：Session management §Session durations ]
- cookie 属性：`HttpOnly` 默认开（脚本读不到，但浏览器自动携带，SPA 无需任何 token 逻辑——与我们 access.ts 头注释的设计一致）；SameSite 可配；可选 `CF_Binding` 防重放（对 SSH/RDP 类非浏览器工具官方建议不开）。[来源：Authorization cookie §Access cookies / §HttpOnly / §Binding cookie ]

### 3.2 CDP Chrome 实操面

- 一次性人工登录（IdP/OTP）后，profile 里的 cookie 全程自动工作：导航、`fetch`、同源 WebSocket 升级都带 `CF_Authorization`（第一方 cookie，无跨站问题）。
- 过期会话下的 AJAX：默认 302 到登录页（HTML），会污染 `fetch` JSON 解析；加 `X-Requested-With: XMLHttpRequest` 头可让 Access 对过期会话回 401。我们的 SPA 已把 401 降级为 "Authentication failed" + ReconnectingWebSocket 重试（access.ts:13-15 注释，bb-spa-ux-surface §4.2），**值得在 SPA fetch 上补这个头作为后续硬化项**（见 §8 checklist）。[来源：Session management §AJAX ]

### 3.3 service token 能否在浏览器语境用？——不能，且不要试

- 浏览器导航/WS 无法设自定义头 → 无法出示 service token 头；
- strict 模式明文：对带 service token 头的请求忽略 cookie，且**成功后不回 Set-Cookie** → 「头换 cookie」自举浏览器会话这条路被官方封死（§2.2）；
- 正确姿势：CDP Chrome 走真人登录流（每次全局会话过期一次），service token 只归机器。**裁决：两套凭据、两类消费者，不互通、不混用。**

### 3.4 Static Assets 组合的官方背书

「Workers with Static Assets execute behind an internal router Worker. **Access still protects the application and its assets.** However, the router does not pass `ctx.access` to the user Worker.」→ 我们 `run_worker_first: true` + assets 绑定的组合部署在 Access 后面是官方支持形态；代价只是 `ctx.access` 不可用——无所谓，我们本来就在 `middleware/access.ts` 里自验 JWT。[来源：Workers Cloudflare Access §ctx.access limitations — https://developers.cloudflare.com/workers/configuration/cloudflare-access/ ]

---

## 4. 问题 3：IP 过滤路线（WAF custom rules vs IP access rules vs lockdown）

### 4.1 三个工具在 Free 套餐的可用性

| 工具                 | Free 可用          | 配额                                   | 关键语义                                                                               | 判定     |
| -------------------- | ------------------ | -------------------------------------- | -------------------------------------------------------------------------------------- | -------- |
| **WAF custom rules** | **是**             | 5 条（无 regex、除 Log 外全部 action） | rules 语言表达式，`ip.src in {…}` 原生支持；CF 官方推荐的 IP allowlist 载体            | **采用** |
| IP Access rules      | 是                 | 50,000 条（zone/account 级）           | Allow 动作会**绕过 custom rules**（顺序陷阱）；CF 自己建议「Use custom rules instead」 | 备选不用 |
| Zone Lockdown        | **否（0 条规则）** | Pro 3 / Business 10 / Enterprise 200   | URL 粒度 allowlist，语义最贴需求但 Free 无门                                           | 出局     |

[来源：Custom rules — https://developers.cloudflare.com/waf/custom-rules/ §Availability ；IP Access rules — https://developers.cloudflare.com/waf/tools/ip-access-rules/ §Availability/§Recommendation ；Zone Lockdown — https://developers.cloudflare.com/waf/tools/zone-lockdown/ §Availability ]

### 4.2 适用范围：custom domain 是前提

- Custom Domain = zone 内路由、Worker 即源站（「A Worker running on a Custom Domain is treated as an origin」），DNS/证书自动管理 → **zone 的 WAF/Security 产品串在请求前面**。[来源：Custom Domains — https://developers.cloudflare.com/workers/configuration/routing/custom-domains/ ]
- `workers.dev` 主机名不在我们 zone → custom rules 够不着（hostname 型 Access app 则明确支持保护 workers.dev 主机名，见 §5.1）。**IP 层只在 `staging.samuka007.top` 挂上后才存在。**
- Access app 侧也能钉 IP（policy selector `IP ranges`，cvat 先例：`{"ip":{"ip":"103.155.37.8/32"}}` live 实测）——IP 约束有两个可选落点（WAF 层全站粗筛 vs Access policy 精确到消费者），§7 推荐 WAF 层。

### 4.3 出口 IP 清单与自动化

| 消费方                            | 出口                                                                              | 动态性                                                                                                                               | 允许名单策略                                                                                             |
| --------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| 家庭 WSL（PM smoke/CDP/本地脚本） | `103.155.37.8`（live 2026-10-04）                                                 | 动态（工单口径；ticket 载明 lighthouse 已跑 cloudflare-ddns 更新本 zone 的先例；今日 `.top` DNS 实测尚无 DDNS 记录，接入时需建记录） | WAF 表达式里的 IP 集合随 DDNS 记录值经 API 重写（一条 PUT，占 5 条配额之一）；先例：cvat policy 钉 `/32` |
| VPS `43.139.31.220`               | 静态（`.top` 上 5 条 A 记录在案）                                                 | 静态                                                                                                                                 | 直接写死                                                                                                 |
| GitHub Actions 托管 runner        | **7,078 条 CIDR**（v4 5,555 + v6 1,523，live 实测 api.github.com/meta `actions`） | 高度动态                                                                                                                             | **不做 allowlist，也不需要**（§4.4）                                                                     |

### 4.4 CI 为什么天然免疫

- 今日 ci.yml 零 CF 流量（§1 表）。
- 未来加 wrangler deploy：CI 里 wrangler 用 `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` 对 **api.cloudflare.com 控制面**认证并上传部署，不产生任何对 app 主机名的请求；官方 GH Actions 指南全程只有控制面凭据。[来源：GitHub Actions — https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/ §Authentication ]
- 唯一陷阱：若未来 CI 增加对 `staging.samuka007.top` 的部署后 smoke（engineering.md 规则 12 的「资产断言」目前是本地 `nix run .#staging-deploy` 做的），那属于 app-plane 流量，会被 IP 层/Access 挡 → 保持 smoke 在本地或自托管 runner，**不要**搬进 GH 托管 runner。

---

## 5. 问题 4：混合分层 + daemon 缝合交互

### 5.1 三种 Access 形态的取舍（本次最重要的一条文档约束）

| 形态                                        | 覆盖面                                                              | WebSocket                                                                                                                                     | 判定                                                                                                          |
| ------------------------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| 账号级 protect-all-Workers（`all_workers`） | 账号内所有 Worker 的全部域名含 previews                             | **「Worker-level Access policies do not currently support WebSocket connections. WebSocket upgrade requests … will fail with a 403 error.」** | 出局（连坐所有 Worker，且 kills `/ws`）                                                                       |
| 单 Worker 级（`worker` destination）        | 该 Worker 的 routes + custom domains + workers.dev + previews       | 同上 403                                                                                                                                      | 出局（`/ws` 是核心）                                                                                          |
| **hostname 型 self-hosted app**             | 精确 hostname/path（含 workers.dev 主机名、custom domain、单 path） | 限制只明文写在 worker 级形态上；cvat 等 app 先例均在 hostname 型上跑浏览器流量                                                                | **采用**；`/ws` 放入其中 [INFERENCE：hostname 型无 WS 禁令，升级请求按普通 HTTP 评估，service token 头可携带] |

[来源：Workers Cloudflare Access §Choose what to protect / §WebSocket limitation — https://developers.cloudflare.com/workers/configuration/cloudflare-access/ ]

### 5.2 daemon 缝合的共存设计

> **2026-10-06 手术修订**：本节「path 粒度双 app」方案被实测否决（root cookie 过不了 path app → XHR 302→CORS 报错、WS 升级 302→拒连）；生产形态为单 root app + 三策略，见 §9。下方「Access 是围墙、hostKey 是门锁」的分层裁决保留不动摇。

仓库现状（§1 表）：daemon face 在 `index.ts` 入口分发，先于 Hono app —— hostKey Bearer 是缝合内唯一凭据（`edge.ts` authKeyOf + 鉴权阶梯）。Access 上线后的接法：

- **path 粒度双 app**：主 app `staging.samuka007.top`（path 空 = 全站）挂 Allow(owner 邮箱)；第二个 Access app 用更具体的 path（`/enroll`、`/session/open`、`/agent/*`、`/agent-sink/*`、`/ws`）挂 Service Auth 策略（`Any Access Service Token`，可加 `IP ranges` require）。Access 文档保证「更具体的 path 规则优先，不继承」+「Service Auth 先于 Allow 评估」→ 机器走 token、人走登录，同域名同 path 树无冲突。[来源：Application paths — https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/ §Policy inheritance ；Access policies §Order ]
- **`/ws` 的双消费者**：浏览器 hub 升级（无 authorization 头）落主 app 的 Allow（cookie）；daemon attach（带 `authorization: Bearer <hostKey>`）同时加两个 service token 头即可命中第二个 app 的 Service Auth。WS 客户端设头没有障碍（bb daemon 现状就带 `authorization` + `Sec-WebSocket-Protocol` 双头，docs/research/bb-daemon-protocol.md §2.1）。[INFERENCE：Access 对升级请求的头评估与普通请求一致]
- **hostKey 仍是缝合权威**：Access 只是围墙（挡非名单流量、免 Worker 计费请求），过墙之后 `daemonServiceWorker` 的 hostKey 阶梯原样运行——符合 engineering.md 规则 7「两把钥匙各守各的门」，也符合规则 11 的边缘消化原则（Access 在 edge 挡掉的请求 0 Worker 调用）。
- **Bypass 不采用**：daemon path 用 Bypass 策略虽更省事，但「requests are not logged」且官方明示「does not recommend using Bypass to grant direct permanent access」；Service Auth 同样免登录、有日志、有策略校验（IP/证书可加），成本相同。[来源：Access policies §Bypass ]

### 5.3 与 `ACCESS_CHECK_ENABLED` 中间件的关系

- 覆盖面：`/api/v1/*` + `/ws`（app.ts:26-50）；daemon face 因入口分发天然豁免；`/health`、静态资产、SPA fallback 不设防（静态内容无秘密）。
- 它与 edge 侧 Access **不重复**：① workers.dev 直连面没有 Access app，只有中间件能挡（旗开时）；② Access 配置漂移/误删时中间件兜底；③ 中间件校验 `aud==ACCESS_AUD` + `exp` + RS256 + team JWKS，是「Access 真的放行了正确的 app」的自证。旗子当前 `false`（wrangler.staging.jsonc:62），开启前置条件 = custom domain + Access app + `ACCESS_TEAM_DOMAIN`/`ACCESS_AUD` 两个 secret（代码 requireTeamDomain 已会 500 提示，access.ts:179-189）。
- 中间件已兼容 service token JWT（§2.4），所以 ACCESS_CHECK_ENABLED=true 后 PM 脚本/daemon 的 token 流无需改中间件一行。

---

## 6. 消费者 × 选项矩阵

判定：✅ 直接可用；🟡 可用但需改造/有陷阱；❌ 不可用/反指示。

| 消费者 ↓ / 选项 →                                         | Access service token（Service Auth）                              | Access 浏览器 cookie（Allow）                | WAF custom rule（IP 层）           | hostKey-only（现状缝合）           | worker 级 Access | Access mTLS     |
| --------------------------------------------------------- | ----------------------------------------------------------------- | -------------------------------------------- | ---------------------------------- | ---------------------------------- | ---------------- | --------------- |
| PM smoke 脚本（家庭 WSL，curl/CLI）                       | ✅ 双头直带，401/403 可编程；IP 层再钉 `/32`（cvat 先例）         | 🟡 需人工 OTP 登录保活，脚本化不可行（§2.4） | ✅ 出口 IP 入集合（DDNS 联动重写） | ✅（现状即此）                     | ❌ WS 403 连坐   | ❌ Free 无 mTLS |
| CDP Chrome（SPA + WebSocket hub）                         | ❌ 浏览器无法设头；strict 下封死换 cookie                         | ✅ 一次性登录 + 自动续发（§3.1）             | ✅ 同上（出口 IP）                 | ✅（现状即此）                     | ❌ WS 403        | ❌ 同上         |
| daemon client（`/enroll`、`/session/open`、`/ws` attach） | ✅ 升级请求带头即可；hostKey 照旧在缝合内验（两层不打架）         | ❌ 非浏览器                                  | ✅（VPS/家庭 IP 入集合）           | ✅（现状即此，仍保留为第二把钥匙） | ❌ WS 403        | ❌              |
| CI（GH 托管 runner）                                      | 🟡 仅当未来 CI 需 app-plane 时（今日不需要）                      | ❌                                           | ❌ 7,078 CIDR 无法 allowlist       | ❌                                 | ❌               | ❌              |
| 未来 M1 soak（Worker 内 cron / VPS cron）                 | ✅ Worker 内 cron 无入站流量天然免疫；VPS cron 走 token + 静态 IP | ❌                                           | ✅ VPS 静态 IP                     | 🟡 仅限缝合内路径                  | ❌               | ❌              |
| wrangler deploy（CI 未来项）                              | — 不适用（控制面流量，api.cloudflare.com，zone 产品无关）         | —                                            | — 不受影响                         | —                                  | —                | —               |

---

## 7. 推荐组合

**主门禁（身份层）：hostname 型 Access 双 app + service token；第二层（网络层）：单条 WAF custom rule；纵深：现有 `ACCESS_CHECK_ENABLED` 中间件保留。**（2026-10-06 手术修订：「双 app」被实测否决，生产为**单 root app「cap-staging」+ 三策略 OR**，见 §9。）具体：

1. `staging.samuka007.top`（custom_domain routes）→ cap-server-staging —— 一切 zone 级产品的前提。
2. Access app A「cap-staging」（domain `staging.samuka007.top`，path 空）：Allow(owner 邮箱集，照 cvat 模板)，session 24h 默认。
3. Access app B「cap-staging-daemon」（同 domain，paths `/enroll`、`/session/open`、`/agent/*`、`/agent-sink/*`、`/ws`）：Service Auth + `Any Access Service Token`（可再 require 家庭/VPS IP）。
4. Service token `cap-daemon`（8760h + 日历刷新提醒）；daemon client（M1 落地时）在现有 `authorization` 头之外追加两个 CF 头；hostKey 阶梯零改动。
5. WAF custom rule×1：`(http.host eq "staging.samuka007.top") and not ip.src in {103.155.37.8 43.139.31.220 …}` → Block；家庭 IP 变更由 DDNS 记录驱动的 API PUT 重写（lighthouse 先例）。
6. 组织级 `strict_service_token_auth=true`。
7. workers.dev 主机名可选加 hostname 型 app（平台支持）或保持现状由中间件覆盖——建议保持现状（staging workers.dev 仅内部直连调试用）。

**排序理由**：Access 在前解决「谁」（含自动化与人的双轨、审计、免 Worker 计费），IP 层在后做廉价粗筛与攻击面收缩；IP 层单独扛不住动态 IP 与 CI，Access 单独扛不住 workers.dev 面与 5 条规则外的成本——叠加后互相补位且互不阻塞（矩阵全列 ✅/🟡）。

## 8. 迁移 checklist（有序，每步可独立回滚）

1. [ ] wrangler.staging.jsonc 加 `routes: [{ pattern: "staging.samuka007.top", custom_domain: true }]` → 部署（回滚：删 routes 重部署）。
2. [ ] 建 Access app A（Allow owner 邮箱）；浏览器冒烟：登录 → SPA 加载 → WS hub 连通（回滚：删 app）。
3. [ ] 建 service token `cap-daemon`，Secret 入密库；curl 双头打 `/health` 确认 200（回滚：revoke）。
4. [x] ~~建 Access app B（daemon paths，Service Auth）~~——已随 #412 收敛作废：单 root app 下 daemon 服务令牌与人同门（svc 策略 decision=`non_identity`），无独立 path app。
5. [ ] daemon client 增加 CF 双头（与 hostKey 并行发送）；L1 冒烟：enroll→open→ws attach 全链（回滚：去头）。
6. [ ] 设置 secrets `ACCESS_TEAM_DOMAIN=samuka007.cloudflareaccess.com`、`ACCESS_AUD=<app A 的 AUD>`，`ACCESS_CHECK_ENABLED=true` 重部署；验证 workers.dev 直连 `/api/v1/*` 401（中间件生效）、custom domain 正常（回滚：flag 置 false）。
7. [ ] `PATCH /access/organizations {"strict_service_token_auth": true}`；回归步骤 3/5（回滚：置 false）。
8. [ ] 建 WAF custom rule（Block + IP 集合）；外部视角验证（手机流量应 Block，白名单 IP 应过）（回滚：删规则）。
9. [ ] lighthouse DDNS → 规则重写自动化接线（如采纳 IP 层）；把「IP 集合重写」登记进 docs/ops/。
10. [ ] SPA fetch 补 `X-Requested-With: XMLHttpRequest`（过期会话得 401 而非 302 HTML，bb-spa 已有 401 处理路径）。
11. [ ] CHANGELOG + 本文件收尾（ticket #55 关单引用）。

---

## 9. 实测结论附录（2026-10-06 活体手术实录；#435 收残留）

§0/§5.2/§7/§8 成文于 2026-10-04 设计期，推荐的「主 app + daemon path app」双
app 拆面当晚落地 7 app 后被实测否决。生产正本以本节为准（来源：#412 comment
手术实录 + #435 活体复验）：

1. **单 root app 是唯一可行形态**。path app 各持独立 aud，而浏览器登录 cookie
   只认发它的那个 app——root 登录后 `/api/v1` XHR 与 `/ws` 升级被 302 到
   cloudflareaccess.com（控制台呈现为 CORS Missing Allow Origin + WS 拒连，
   用户实报）。6 个 path app 已删：`cap-staging` 单 root app 覆盖
   bb-staging.samuka007.com 整域，单一 aud（`084987b3…`），一次登录全路径生效。
2. **三策略 OR 共存**（单 app 内）：`allow-owner`/`allow-owner-me`（人，email
   规则）+ `svc-daemon`（服务令牌）；session_duration 730h（全对象 PUT 改，
   部分字段 PUT 被静默忽略）。
3. **服务令牌策略 decision 必须是 `non_identity`**（现行 API 枚举）：`allow`
   不授权服务令牌——请求 302 到登录页（活体复现实证）；`service_auth` 不是
   合法 API 值（12130 unrecognized）。
4. **unknown Client ID 不入 Access 认证日志**（GET /access/logs/access_requests
   排障判据）：令牌请求 302 且日志无记录 = Client ID 层面就错了（先查凭据
   转录完整性）；有 failed 记录 = ID 对、secret 或策略授权层错。
5. **worker secret `ACCESS_AUD` 为单值**（root app aud；#435 退役多 app 时代的
   双 aud 形态，`.staging-access.env` 的 `ACCESS_AUD_API_V1` 行同删）。中间件
   的逗号列表解析保留为遗留容忍（middleware/access.ts），生产值不再含逗号。

---

> AGENT GENERATED: by zhipu-coding-plan/glm-5.3-flash (research subagent)
