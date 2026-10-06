# edge OAuth 回调形态与凭据信任域裁决：订阅类 relay 上游的 Workers 落法（#349）

> 工单：Samuka007/cloudflare-agent-project#349；类型：decision（ADR，零生产代码）。
> 脊柱输入：[provider-fields-roadmap.md](../research/provider-fields-roadmap.md) §4（两域划分与 §4.2 形态底稿，2026-10-05）、§1.5（bb 服务端零 auth 写路径）、§5 票 3 行。
> 既定裁决输入：#221/T15（security_scan 凭据宿主保管、派发帧零 auth 面）；#255 方案 C（配置正本在部署侧、UI 只投影）；#266（只读投影面零秘密值）；#351（providerId 键控 relay 注册表 + 每 provider 秘密槽，2026-10-06 落地）；#362（provider_configs D1 行 + AES-GCM `api_key_enc` + `PROVIDER_CONFIG_MASTER_KEY`，2026-10-06 落地）。
> bb 对照：host-daemon-contract/src/commands.ts「credentials exist but the token expired; the CLI must refresh it (**we never refresh another tool's tokens here**)」（bb @ 8473d8c33 :1486-1487；roadmap pin `e04a0f14` 记 :1456，行号随 pin 漂移，引用以句子文本为准）。
> 消费者：roadmap §4.1 表（本票已回填）；未来实现票（本文 §2–§5 即其规格，开出后在 §0 增补票号）；provider-config-points.md（实现时新增 auth/providers 配置点行）。

## 0. 裁决先行

1. **边界裁决（永久，不随实现状态变化）**：特殊 auth 两个信任域互不迁移——宿主执行的 OAuth（security_scan → Codex Security）凭据宿主保管、整体归 daemon，红线不动；edge 侧 OAuth 仅为 **edge-native 通道**（relay 上游本身是 OAuth 订阅类服务）而设。见 §1。
2. **实现裁决：搁置，不立实现票**。触发条件成文于 §6（满足任一即重开，实现票照本文 §2–§5 施工，无需二次裁决）。设计本文定案冻结。
3. **形态裁决（冻结规格）**：回调路由 §2；存储与加密 §3（对 roadmap §4.2 的 KV/Secrets Store 底稿有一处**修订裁决**：token cache 落 D1 密文列，理由与被否备选见 §3/§6）；引擎复用 §4；刷新与投影 §5。

## 1. 两域边界

| 域                                                 | 凭据住哪                        | 谁刷新                       | 裁决                     |
| -------------------------------------------------- | ------------------------------- | ---------------------------- | ------------------------ |
| 宿主执行的 OAuth（security_scan → Codex Security） | 宿主 daemon-private authStorage | 宿主自己的 CLI/工具栈        | **不迁移**（红线）       |
| edge-native OAuth（relay 上游是 OAuth 订阅服务）   | edge（本文 §3 的存储）          | edge Cron Trigger（本文 §5） | 设计冻结、按触发条件实现 |

- 宿主域锚：#221 裁决「整体归 daemon——OAuth credentials stay in the host's daemon-private authStorage, no half migrates, the DO never sees credential material」（packages/agent-do/src/tools/registry.ts:826-836 注释原文）；派发帧零 auth 面有 L1 钉死（packages/daemon-service/test/l1-security-scan.test.ts:418-434——agnostic 五字段帧，`credential_id` 只是 host 侧账号选择器，帧上不新增 auth 形字段）。
- 两域不混的推论（实现票的硬约束）：① edge OAuth 凭据永不进 daemon 派发帧；② daemon 工具凭据永不进 edge 的 KV/D1；③ 同一家订阅若同时被两域消费（如既当 relay 上游又被宿主工具用），是**两个独立凭据、两个独立授权、两个独立信任域**，不合并不共享 token——否则 edge 就成了「代刷别家 token」的一方，正撞 bb 纪律句。
- 判别规则：凭据的信任域跟**执行域**走。执行在宿主机器上的工具，凭据留宿主；执行在 edge Worker 上的通道（relay fetch 出站），凭据留 edge。

## 2. 回调路由形态

- 路由对（roadmap §4.2 底稿照抄，冻结）：
  - `GET /api/v1/auth/providers/:id/start`：校验 `:id` 是已声明 OAuth 通道的 providerId → 生成 state + PKCE verifier → 会话态落 KV（§3）→ 302 到 IdP authorize 端点。
  - `GET /api/v1/auth/providers/:id/callback`：state 一次性对账 → `code` + verifier 换 token（引擎 `exchangeAuthorizationCode`，flow.ts:267）→ 密文落 D1（§3）→ 渲染最小静态确认页（「authorization complete, you may close this window」形状，非 SPA 路由）。
- `:id` 键空间 = #351 注册表/catalog 的 providerId。未声明 OAuth 通道的 providerId 命中两面 → 422 具名错误（沿用 #351 `provider_unknown` 语法，fail-closed）。
- redirect URI = Worker 公网 URL（`https://<worker-host>/api/v1/auth/providers/:id/callback`）。**IdP 侧预注册逐家核对**：支持动态注册（RFC 7591，引擎 `registerClient` flow.ts:238）的 IdP 免预注册；消费订阅类 IdP（ChatGPT/Claude 形态）通常只支持静态注册，需在其开发者控制台预先登记 redirect URI——这是触发条件点火后实现票的第一个外部依赖步骤 `[INFERENCE: 各 IdP 注册流程不同，实现票逐家核对]`。
- 鉴权边界：start/callback 是 IdP 浏览器跳转面，**不吃 Access JWT**，是 edge 仅有的两个免 JWT 面。约束（实现票执行）：start 只能由已认证管理面会话发起（携带面板现有的同一凭据面，具体机制——header 还是顶级导航 cookie——按 Access 配置现实定）；callback 的防 CSRF/fixation 完全靠 state 一次性对账，不引入第二机制。Access zone 的 route 豁免规则要写进 runbook。
- 错误落点：IdP error 回参（`error`/`error_description`）→ 投影 `unauthenticated` + 错误摘要进一次性 KV 记录（start 轮询可见）；**不把 IdP 错误原文透传到浏览器页**（信息面最小化，SEC-W5-003「探测面不泄上游 oracle」同型纪律）。

## 3. 会话态与凭据存储（新存储唯一落点）

两件套，各归其位：

1. **流程会话态（state + PKCE verifier + providerId + createdAt + IdP 错误摘要槽）→ KV**。key `oauth:flow:<state>`，`expirationTtl ≈ 600s`（≈10 分钟，授权窗口宽裕），**一次性消费 = get→delete**（delete-on-read）。并发缝：KV 最终一致，同 state 双 callback 存在竞态窗口；本流程是单管理员、单浏览器驱动的管理动作，竞态面可接受 `[INFERENCE: 多管理员并发对同一 providerId 授权时升级为 DO 计数强一次性——记为触发条件，不预建]`。实现时用独立 namespace（如 `AUTH_FLOW_KV`），不复用 `DAEMON_EDGE_KV`（那是 daemon edge shield 的 auth 缓存，职责不同）。
2. **token cache（access_token / refresh_token / expires_in / scope）→ D1 `provider_configs` 同行扩展列族（`oauth_*`，AES-GCM 密文）**。**这是对 roadmap §4.2「KV 或 Workers Secrets Store」底稿的修订裁决**（底稿成文于 #351/#362 落地前一日；不变量不动，落点修订）：
   - 不变量原样保住：密钥本体仍是 Worker Secret（L1，沿用 `PROVIDER_CONFIG_MASTER_KEY`），存储只存密文——信任属性与 store 名无关；
   - 单一正本：#362 后 `provider_configs` 行就是 provider 配置正本（overlay 压 env seed）；OAuth token 是该行的凭据态，同表同行免第二存储 join，relay 注册解析与凭据读取同库；
   - Secrets Store 一票否决：它是部署期静态秘密的形状（绑定即部署），装不下「每 provider 一行、运行期 cron 刷新 UPDATE」的动态行——形状不符，不是安全与否的问题；
   - KV 只配 TTL 会话态这类「写后即焚」；投影面（§5）要按 providerId 列表出 status，D1 行直读，KV 得二次往返且无法 join；
   - 刷新写路径（§5）= 运行期 UPDATE，D1 常规操作。

- 加密细节沿用 #362 现成件：`encryptProviderSecret`/`decryptProviderSecret`（apps/provider-app/src/provider-config-crypto.ts:47,70，AES-GCM，master key SHA-256 派生，WebCrypto，Workers 原生）；refresh_token 与 access_token 同列族同密级。`accountEmail`/`planLabel` 是非秘密投影字段，**明文列**直读（投影面免解密）。
- client 形态裁决：优先 **public client + PKCE**（消费订阅 IdP 的 CLI 先例即此形态，引擎零 client_secret 依赖）；仅当 IdP 强制 confidential 才引入 client_secret，届时进密文列族。
- 目录纪律不变：`MODEL_RELAY_CATALOG` 公开册仍零凭据（provider-catalog.ts:281-284 严格 decode 拒绝任何凭据字段）；OAuth 通道的 authorize/token 端点、client_id、scope 是**公开非秘密**配置，进目录行或 provider_configs 可见面。

## 4. 引擎复用面

三瓣切分（roadmap §4.2「KV-backed provider + 路由壳」的落地形状）：

| 瓣     | 归属                            | 内容                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------ | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 引擎瓣 | **零改动复用**（vendored 纪律） | `packages/mcp/src/oauth`：PKCE（flow.ts:160-165，`crypto.getRandomValues` + `crypto.subtle.digest`，Workers 原生）、discovery（RFC 8414，discovery.ts:89-171）、issuer 校验、动态注册（flow.ts:238）、token 交换（flow.ts:267）、刷新（flow.ts:283）、`authorizeMcp` 编排（flow.ts:415）。vendored src byte-identical 纪律（packages/mcp/README.md:143-160，eslint/prettier ignore 同步豁免）意味着此瓣缺什么在 repo-owned 层补，不改引擎 |
| 存储瓣 | 新写（repo-owned）              | 实现 `OAuthClientProvider`（flow.ts:47-68——`tokens()/saveTokens()/state()/saveCodeVerifier()/codeVerifier()/clientInformation()/saveClientInformation()/invalidateCredentials()` 就是存储缝）：KV-backed 流程态 + D1-backed token cache 的 provider 实现；参考缝是 `McpOAuthStateStore`（provider.ts:21-24，`MemoryOAuthStateStore` 为参考实现）的注入点形状                                                                              |
| 路由壳 | 新写（repo-owned）              | `apps/server-worker/src/routes/auth.ts`：§2 两面 handler。start = `startAuthorization`（flow.ts:167）→ 302；callback = `exchangeAuthorizationCode` → saveTokens → 确认页                                                                                                                                                                                                                                                                  |

- 明确**不复用**：`OAuthCallbackServer`（packages/mcp/src/oauth/callback.ts:1 `import ... from "node:http"`——本地 listener 等回调的 Node 形状；Workers 是路由不是监听）。照 `src/http.ts` 剥 `StdioTransport` 的移植先例：Node 形状不进 edge 面。
- Buffer 注记：PKCE 的 base64url 走 `Buffer.from(...)`（flow.ts:162,164）——server-worker 已开 `nodejs_compat`（wrangler.jsonc:6），可用；若未来关闭该 flag，在 repo-owned 层换 helper，不动 vendored 瓣。

## 5. 刷新与投影

- **刷新**：Cron Trigger 定期扫 oauth 行，`expires_in` 邻近（如 <10min）时 `refreshAuthorization`（flow.ts:283）→ UPDATE 密文列。现有 trigger 已是 `*/5 * * * *`（wrangler.jsonc:76-80），实现票直接挂进去，不加新 trigger。刷新失败（`invalid_grant` 等）→ 清密文列内容 + 投影 `expired`——**不重试到死、不静默代刷**。纪律句源头即 bb：「we never refresh another tool's tokens here」；我方语境反面重申：edge 只刷**自己发起的授权**（edge-native 通道）的 token，宿主侧工具凭据永不入 edge 的刷新视野（§1 推论③）。
- **投影**：`GET /system/provider-projections`（apps/server-worker/src/routes/system.ts:204 起，#266 只读面）provider 行增加 oauth 子形状 `{status: connected/unauthenticated/expired, accountEmail?, planLabel?}`——bb `ProviderUsage` 的 ok/unauthenticated/expired 三态子集（roadmap §4.2 既有裁决，冻结）。**零 token 透传**（#266 零秘密值延伸）。
- **error 态收窄裁决**：bb 还有 `error{message}` 四态；我方收窄为三态 + 每行可选 `statusHint`（非秘密、人工可读短语），避免投影面变成上游错误原文透传面（SEC-W5-003 同型教训：探测/投影面不泄上游 oracle）。网络失败时投影保持上一已知态 + `statusHint`，不发明第四态。
- 线程选择面（#351）不动：OAuth 通道的 providerId 进入注册表后，thread 级选择/校验/分派语义照旧——本文只新增「凭据从哪来」，不改「选了怎么跑」。

## 6. 裁决记录（做/搁置）

**裁决：搁置，不立实现票。** 本文 §2–§5 为冻结设计；触发条件如下，满足任一即重开（实现票照本文施工）：

1. 第一个 OAuth 订阅上游确定进入 edge relay 目录（catalog 行或 provider_configs 行声明 oauth 通道）；
2. 某订阅 IdP 不提供任何网关可暴露的 API-key 面，edge 直连成为唯一通路；
3. 多租户/多账号面出现（面板用户要求自助连接自己的订阅账号）。

搁置理由：

1. **触发条件未点火**：当前 edge relay 目录/凭据槽/面板配置中不存在任何 OAuth 订阅上游。staging 链路是 newapi API-key → zhipu coding plan key（docs/ops/staging-relay.md），订阅类上游一律经网关（newapi/atcd/sub2api）暴露 API-key 面，edge 视角是静态 key——网关代理正是现状答案，edge-native OAuth 无真实消费者。
2. **形态依赖首个具体 IdP**：redirect URI 预注册、client 形态（public+PKCE vs confidential）、scope 逐 IdP 而定；无具体 IdP 时只能对假想 IdP 施工，端到端不可验证。
3. **仓库纪律**：不预切无消费者的面（roadmap §4.4 多协议 wire 同判例：「依赖真实需求出现，不预切」）。

被否决的备选：

- **现在就立实现票**：无真实 IdP 不可端到端验证；KV/加密/回调三面全是无人消费的攻击面与运维面。
- **永久不做、只走网关代理**：否——触发条件 1/3 是现实可能（roadmap §4.1 即点名「Codex 订阅当 relay」），本文正是为此留的合法通路；永久关门会把未来的合法需求逼进「凭据进派发帧」的破线捷径。
- **Secrets Store 存 token cache**：部署期静态秘密的形状，装不下运行期动态行（§3）。
- **token 明文进 KV**：违反密钥本体 L1 不变量（§3）。

## 7. 维护

- roadmap §4.1 表已回填本裁决（2026-10-06）；实现票开出后在本文 §0.2 增补票号，并在 provider-config-points.md 增补 auth/providers 配置点行。
- bb pin 前进后 commands.ts 纪律句行号随 pin 漂移，引用以句子文本为准；roadmap §1.5 同规则。

---

> AGENT GENERATED: by lane/349-w5-edge-oauth-relay-workers-305（#349 decision, 2026-10-06）
