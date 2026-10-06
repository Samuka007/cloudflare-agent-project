/**
 * Real ticket corpus for the #402 fixtures — the LIVE bodies exactly as the
 * GitHub transport delivers them (GraphQL `bodyText`, markdown rendered to
 * text: `## 验收` arrives as the BARE line `验收`). The #402 probe: every
 * markdown-anchored L1 fixture was green while AP.closeout(#387) sailed
 * through, because the gate reads bodyText and the old matcher only knew
 * `#{1,6}` headings. Corpus-driven discipline (禁再造假票): fixtures here are
 * byte-for-byte upstream bodies (fetched 2026-10-06), never hand-written
 * ticket shapes.
 */

export interface CorpusTicket {
  title: string;
  labels: string[];
  /** GraphQL bodyText — what fetchCloseoutTicket hands acceptanceFaceOf. */
  body: string;
}

/** #362 — [W5] provider configurable panel——D1 正本+CRUD API+面板写路径（用户裁决，撤 env-only 裁决） */
export const CORPUS_362: CorpusTicket = {
  title: "[W5] provider configurable panel——D1 正本+CRUD API+面板写路径（用户裁决，撤 env-only 裁决）",
  labels: ["type:implementation", "block:agent-harness"],
  body: `用户裁决（2026-10-06）
「我的 provider configurable panel 呢？不是说对齐 pi-agent 功能吗？你 config llm provider 的功能呢」——推翻 #255/#266 的 env-only+只读投影形状：要 pi/bb 式用户可配置 provider 面板（UI 增删改 provider：baseUrl/api/apiKey/模型目录，热生效）。env 降级为部署默认/seed。
倒查义务：pi-parity-matrix G7 行（✅ 正本=env）需随本票更新为新裁决。
复用三问

上游整库可搬？ 部分——bb 上游 Settings→Providers 面板组件+custom provider 数据模型（config.json customModels 字段族+skip-invalid-with-warning 纪律）可搬 UI 与 schema；pi models.json 用户面字段全集（provider 级 baseUrl/apiKey/oauth+模型级字段，model-config.ts:202-247，矩阵 147 行）为字段正本。
运行环境同构？ SPA 面=bb fork 同构可直接搬；服务面=我们 server-worker（D1+Routes），照 bb server 路由语义适配。
适配垫是否比重写薄？ 是——#350 catalog zod schema 是现成形状（provider-catalog.ts 单源），DB 行=同 schema+凭据列；#351 注册表/分派/422 校验链零改动消费。

设计草图（P0）

D1 表 provider_configs：provider 行（id/displayName/baseUrl/api/apiKeyEnc/models JSON——models 用 provider-catalog 同 schema 校验，坏行 skip-with-warning 永不静默删）；apiKey AES-GCM 加密存储（master key=Workers secret PROVIDER_CONFIG_MASTER_KEY，WebCrypto 原生）
CRUD API：GET/POST/PATCH/DELETE /api/v1/system/providers（鉴权阶梯；PUT 语义=整行替换；test-connection 端点：对 baseUrl 发 1 轮最小请求回真/假判词）
合并解析：env MODEL_RELAY_CATALOG（部署 seed）⊕ D1 行（同 id D1 覆盖）→ 单目录喂 execution-options/provider-projections/relay registry；凭据槽 MODEL_RELAY_PROVIDER_CREDENTIALS ⊕ D1 apiKeyEnc（D1 优先）
热生效：配置变更→既有 drift 分类器（#351 unchanged/live/session）走 live；无重部署
面板：bb fork Settings→Providers 恢复写路径组件对接我们 API（Server 节保留只读投影作部署面，用户面=可配置节）
审计：provider-config-points.md §1/§2 正本行改写（D1=用户面正本，env=部署 seed）

验收

面板新增 provider（openai-responses + anthropic 两型）→ execution-options 即刻出现 → thread 选择消费（#351 链）→ 真轮 turn 走通（mock 或真上游）
坏 JSON 行 skip-with-warning（日志+面板警示，永不静默删）
key 加密落库（D1 直读无明文断言）+投影面零秘密值纪律保持（#266 L1 断言扩展）
G7 矩阵行更新+倒查注记
CI 绿；staging 部分走查（配置面+mock turn 不依赖真模型）

切分

P0=本票（CRUD+合并+面板+加密）
P1=#349（OAuth 订阅流接入同一面板——同故事分支，裁决票顺延）

效率与成本预算

参考类预测：≈#351（journal+注册表+422 链，1 lane 日）；面板组件搬运用 ≈#303 的 bb fork 工作量系数；合计 1-1.5 lane 日
DO 请求量：无新增（配置读走 D1 直读+缓存）；token：e2e mock


AGENT GENERATED: by zhipu-coding-plan/glm-5.3:max`,
};

/** #382 — [W5] #362 收尾半——bb 插件面 port（server-worker 最小 plugins 服务）+panel 插件化交付+pin 前移+staging 走查 */
export const CORPUS_382: CorpusTicket = {
  title: "[W5] #362 收尾半——bb 插件面 port（server-worker 最小 plugins 服务）+panel 插件化交付+pin 前移+staging 走查",
  labels: ["type:implementation", "block:agent-harness"],
  body: `上下文
#380 已合（后端半：D1 正本/CRUD/加密/discover/热生效，051b3e2）。剩件=L362Continue 已核的阻塞事实：bb SPA 插件加载链依赖 server 的插件服务面，而我们 server-worker /api/v1/plugins 钉死空列表——零 core 触碰的插件化交付需先 port 最小插件服务面。
范围

server-worker 最小 plugins 面：bb 插件 manifest/资产服务语义对照（bb server plugins 路由锚点），够 cap-provider-config 插件加载即可（静态注册表，不走 BUILTIN_PLUGINS core）
bb fork：cap-provider-config 插件交付（app.settingsSection() 槽两个 section：Configured 可配置面+#266 Server 只读面迁移）；回退 21 行 core diff（settings-nav/SettingsView/query-keys pristine）
pin 前移 e04a0f1→新 fork commit
面板 thinkingBudgetTokens 字段（组件内）
staging 走查补录（#362 验收框）

验收

零 core 触碰（bb fork diff 对上游=0 行，或全部 upstream-facing 标注）
插件经 server-worker 面板加载，两个 settingsSection 渲染+CRUD 走通
staging 走查：面板增删 provider→execution-options 即刻反映→thread 选择消费
CI 绿

效率与成本预算
参考类：#362 后端半（1 lane 日）＋bb 组件搬运系数——预计 0.5-1 lane 日。

AGENT GENERATED: by zhipu-coding-plan/glm-5.3:max`,
};

/** #386 — [W5] 占位 cloud machine 升格为真实 hosts 行——bb primary 守护锚点，真实机器可删 */
export const CORPUS_386: CorpusTicket = {
  title: "[W5] 占位 cloud machine 升格为真实 hosts 行——bb primary 守护锚点，真实机器可删",
  labels: ["type:implementation", "block:agent-harness"],
  body: `用户裁决（2026-10-06）
「如果 bb 必须要一个 machine，你就建立一个虚拟的 cloud machine 作为占位符，不一定要能工作（那是 W6），但这样能容纳无实际机器的语义。」
问题（实证）
lxc-stg-01（host_7xykdvxmdk）remove 被拒：「this machine runs bb and can not be removed」——hosts.ts resolvePrimaryHostId 的孤行 primary 保护。#377 当时刻意让 placeholder 不做 hosts 行（防删不死），结果是最后一个真实机器反而删不掉（守护锚定在真机上）。
方案（修订 #377 的占位形状）

CLOUD_PLACEHOLDER_HOST_ID 升格为真实 hosts 行（type=placeholder/cloud，不可删但有明确占位语义+UI 标注「虚拟·W6 前不可执行」）——bb 的「必须有一台 machine」不变量由占位锚定
primary 守护锚点=占位行：真实机器数可以为零且全部可删（删空后回落占位，语义完整）
占位行不可删但不冒充在线（不 connected 不心跳，仅语义存在）；W6 cloud 执行就位后同一行升格为真执行（skill/sandbox/fs 线）
删除面：占位行 DELETE 拒绝带判词「placeholder holds empty-machine semantics」

验收

删光所有真实机器：/hosts 仅剩占位行（语义标注），线程绑定解析回落占位，host 工具诚实 host_offline
lxc-stg-01 可删可重 enroll（守护不再锚真机）
bb primary 守护语义对照（primary-host.ts 锚点行级引用）
CI 绿

效率与成本预算
参考类：#377 同面（0.5 lane 日）。

AGENT GENERATED: by zhipu-coding-plan/glm-5.3:max`,
};

/** #387 — [P0][W5] cap-provider-config 插件 staging crash——用户真机实证，面板面未验收缺口 */
export const CORPUS_387: CorpusTicket = {
  title: "[P0][W5] cap-provider-config 插件 staging crash——用户真机实证，面板面未验收缺口",
  labels: ["block:agent-harness", "type:bug"],
  body: `用户实证（2026-10-06）
staging 面板 cap-provider-config 插件 crash（用户真机）。#382/#364 关账时产品面走查被 PM 挂到终检批未执行——本票即该缺口的偿还。
任务
复现（staging 真实加载：拉 /api/v1/plugins+registry.json+app.js，hash 对账，bun 转译/加载找顶层异常，对照 bb plugin-sdk 入口/manifest 约定）→定位→修→真机验收（插件两个 settingsSection 渲染+CRUD 走通，PM 复核）。
验收
staging 插件加载零 crash+两 section 可用+PM 真机走查记录。CI 绿。

AGENT GENERATED: by zhipu-coding-plan/glm-5.3:max`,
};

/** #390 — [W5] pm-harness closeout 门禁——票面验收含产品面时拒绝 source:ci（M1 修） */
export const CORPUS_390: CorpusTicket = {
  title: "[W5] pm-harness closeout 门禁——票面验收含产品面时拒绝 source:ci（M1 修）",
  labels: ["type:implementation", "block:agent-harness"],
  body: `违规事实（2026-10-06 终检复盘）
#362/#382/#364（UI 交付物）以 source:ci 关账，面板真机 crash 未被拦截——AP.closeout 台账不校验票面验收类型，给偷懒验收发通行证。
修法
closeout 前置闸：读票面验收字段，含产品面/UI/走查关键词（或独立 acceptance-type 字段）→ source:ci 直接拒绝（报错文案指向 walk 证据要求）；source:walk 必须附表面证据（CDP console/截图/API face 对账引用）。台账 schema 加 evidence-type 列。倒查：闸门上线后对当日以 ci 关账的 UI 票重审（#362/#382/#364 三票重开走 walk 路径——由 #387/#388 修完后的真机验收补）。
验收

UI 票 ci 关账被拒的 L1 断言+walk 证据链落账断言
台账新列迁移+既有行回填
CI 绿


AGENT GENERATED: by zhipu-coding-plan/glm-5.3:max`,
};

/** #391 — [W5] 废除无主「终检批」——挂账走查必须票+期限落账（M2 修） */
export const CORPUS_391: CorpusTicket = {
  title: "[W5] 废除无主「终检批」——挂账走查必须票+期限落账（M2 修）",
  labels: ["type:implementation", "block:agent-harness"],
  body: `违规事实
「终检批」为 PM mid-wave 发明的缓冲概念：无票、无期限、无审计——被 security_scan 阻塞挤掉后照样汇报「走查批全过」。
修法

pm.md 增文：走查挂账=票面字段（walk-due）+期限；到期未跑板面翻红（Wait for user 或专用标记）
pm-harness：closeout/apply 支持挂账登记（append ledger：ticket/due/face），到期检查入 pm_audit
本票落地后立即倒查：现存所有「归终检批」措辞的挂账逐条登记或当场执行

验收

挂账登记/到期红/审计输出三面 L1
现存挂账清单落票面
CI 绿


AGENT GENERATED: by zhipu-coding-plan/glm-5.3:max`,
};
