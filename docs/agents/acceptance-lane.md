# 验收 lane 操作手册（acceptance lane manual，#277 模板化）

#243 验收体系的验收件：#239 首用范式的可复用工单化。PM 在实现票交付后、merge/close 前按本模板派发验收 lane；证据入 `AP.closeout` 台账后才可关账（[pm.md](pm.md) §验收关账 第 3 条关账序列）。契约正本：grill 契约 #245（评论 5988966856 + 修正 5989008155）、ephemeral 机制事实 #244、浏览器纪律 #460（取代 #240/#239 租约纪律）、定位原语 #242。

## 1. 触发与勾选权（关账门分面）

| 票面验收面                          | 勾选权                     | 证据形态                           |
| ----------------------------------- | -------------------------- | ---------------------------------- |
| staging 真机／手验框                | **验收 lane** 真机操作后勾 | 证据三件套（§4）+ 截图             |
| 纯代码面（L1 回归／断言／契约测试） | **CI** 勾                  | 绿 run 链接（run id 即部署版本锚） |

- PM 抽验**不是**勾选权：wave 终检抽样（#246）是抽样复核，不替代验收 lane 出证。
- 验收 lane 判定与实现 lane 自报冲突时，以验收 lane 真机证据为准；仍冲突 → 立项（线索非结论），不阻塞证据落档。
- merge 按钮权在 PM（统一串行，防冲突）；验收 lane 只出证据，无按钮权。

## 2. 派发（PM 侧）

- 派发时机：实现 lane 交付报告落地、PR 已推、staging 面已随 CD 部署（`SERVER_VERSION` 经 `/api/v1/system/version` 可查）之后。
- 浏览器面（2026-10-07 修订，取代 #240 租约）：验收 lane 用自管 headless Chromium（omp browser facade `browser.open({ name: "l<票号>" })`），无租约义务（租约制废止见 pm.md §验收关账 6）；staging thread 前缀 `l<票号>-` 约定保留。
- dispatch packet 用 §3 模板实例化：靶面清单逐项来自票面 Acceptance 框，逐框标注 staging/CI 归属。

## 3. 可复用工单模板（PM 实例化后随 spawn 下发）

```markdown
# 验收工单：#<票号> <票题>

## 靶面（票面 Acceptance 逐框，标注归属）

- [ ] <验收框 1>（staging 面 / CI 面）
- [ ] <验收框 2>（…）

## 环境事实（#244 ephemeral 引用，按需）

- staging 部署：cap-server-staging @ <SERVER_VERSION>（/api/v1/system/version）
- 本栈为 ComposedAgentDO 单 worker：Version URL 不适用（docs/research/ephemeral-env.md
  §2——官方明示 DO worker 不生成 Version URL；Previews 的 scheduled 不跑），
  staging 验收一律走 CD 部署面或 `nix run .#staging-deploy` 手动面（#175）。

## 浏览器卫生（2026-10-07 修订，租约制已废止）

- 实例：自管 headless Chromium（`browser.open({ name: "l<票号>" })`），并行互不干扰
- thread prefix: l<票号>-（staging thread=抢占资源，一 thread 一在飞 turn；
  交互测试一律新建专属线程；只读观察零发送）
- 报告必须回报 thread 使用情况；用毕 `browser.close({ all: true })` 关闭自家实例

## 义务

1. 逐靶真机操作，按 §5 报告格式留证；截图为强证据（验收 lane 有视觉能力）。
2. 不修码、不 merge、不改他人 tab/线程；判定如实，带不确定度声明。
3. 定位辅助：页面元素定位可用 jev-locate（#242，scripts/accept/jev-locate.ts），
   LocateReport 入报告附件；工具不改变判定权（判定仍是 lane）。
4. 交付物 = 验收报告（挂票评论）；PM 据此 `AP.closeout` 入账后 merge/close。
```

## 4. 证据三件套（#239 范式，缺一不算走查）

1. **证据**：验收评论／截图锚／run 链接／file:line——审者可打开复核的锚点。
2. **日期**：验收实际运行日（ISO 8601）。
3. **部署版本**：`SERVER_VERSION` 短 sha（staging 面）或 CI run id/ref（纯代码面）。

空框=未验收（[pm.md](pm.md) 第 7 条）；"移交后续走查"不是合法关票态。

## 5. 报告最小格式（#245 契约①）

- **高层复现序列**：如何走到验收面（几步即可，足够他人复现）。
- **截图**：每靶至少一图（强证据——除非睁眼说瞎话违反诚实性，否则图在谎难圆）。
- **逐项判定**：靶面清单逐框 pass/fail/blocked。
- **不确定度声明**：未复现的边界、环境受限面、误报可能（如 #194 掉线两态需 daemon 断连未复现的诚实档先例）。

## 6. PM grill 三靶（#245 契约②③，验收报告落地后盘问）

1. **似是而非防御**：把你判定所依赖的那段原样输出逐字引给我（破开发 subagent 貌似合理输出的转述链）。
2. **目标偏移**：这 PR 的票面核心意图是什么？你的证据打的是这个还是邻面？（任意维度错位——优雅性/边界/规模/语义/重点皆可能错位）
3. **只留一条证据**：若这 PR 的验收只准留一条证据，票面作者会说必须是哪一条？你验的是那一条吗？

对齐判据：三靶通过 + 证据重锚（lane 能指出其证据与票面意图的映射）。三靶不过 = 证据退回，关账 REFUSE 维持。

## 7. 台账与兜底（#277 机制）

- PM 收报告后 `AP.closeout(<票号>, "acceptance-lane"|"ci", { evidence, deploymentVersion })` 入账（`.pm-closeouts.jsonl`，gitignored；`PM_CLOSEOUTS_PATH` 可改）；三件套不全硬拒（零写入）。
- **判面前置闸（#390）**：入账前 `AP.closeout` 自读票面验收字段（不听调用方转述）。验收节含产品面关键词（面板/走查/真机/截图/UI…）＝product 面：`source: "ci"` 直接拒（报错指向 walk 证据要求）；`source: "acceptance-lane"` 必须附表面证据（console 错误/截图/选择器断言＋目标 URL＋时间戳——证据格式约定，不指定浏览器实现）。独立 `acceptance-type: code|product` 字段双向覆盖关键词扫描。台账行带 `evidenceType`（walk|run）列；旧行由 `AP.migrateCloseoutLedger()` 按 source 回填（读路径内存归一，不迁移也不影响 audit）。
- `AP.audit` 规则 7 `closeoutNoEvidence`（传 `closeouts: AP.closeoutLedger().events` 武装）：type:implementation/type:bug 票已交付而无 accepted 项 = 关账门被跳过 → 回填或重开。**纪元边界（#421）**：closedAt 早于台账首行 recordedAt 的已关票静默（台账存在前的关票无法事后补证）。
- CI 面票：绿 run 即证据，`source: "ci"`，evidence=run 链接，deploymentVersion=run id/ref。

## 8. 欠账回填台账（追溯，脊柱前人工门的还账记录）

| 票                     | 面                                   | 状态                                                                                                                                                                                |
| ---------------------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #266 provider 投影面   | staging（Settings→Providers→Server） | **首例回填**：PR #273 解冲突重推合并 → CD 部署后 PM 抽验补走（PM 自纠评论 5993272433；教训：merge 前 checklist 必含票面验收框状态核对）                                             |
| #257 CoT thinking 通路 | staging 实机走查                     | **挂 #34 保持记录**：staging 真模型腿被 #34 mock 阻塞（票外前置），代码面就绪（MODEL_RELAY_THINKING_BUDGET_TOKENS+AGENT_DO_EXTERNAL_THINKING 姿态 OFF）；#34 解除后自动真实化再回填 |
