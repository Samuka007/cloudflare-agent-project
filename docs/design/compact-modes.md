# Compact 模式分类学——soft / remote / snap（#547）

> 正本锚：omp pi-coding-agent@18.6.0 `session/compaction-methods.d.ts`
> （COMPACTION_METHOD_CHOICES / DEFAULT_COMPACTION_METHOD_ORDER）与 cli bundle
> 内 `/compact` 命令定义（allowArgs + 首 token 模式匹配 + snapcompact
> rejectsFocus），2026-10-08 提取。本仓不引 omp 库（线程上下文在 edge DO，
> SessionManager 摸不到），只抄分类学与语义形状。

## 1. 三模式语义

| 模式     | omp 正本语义                                                                   | 本仓落地                                                                                                                                                                                                          | 模型调用                   |
| -------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| `soft`   | "Summarize in place with a compaction model"                                   | #309 现行为：线程钉住的模型走 relay 出摘要，摘要以 compact turn 自身历史行 rides 后续请求                                                                                                                         | 1 次（线程自己的模型）     |
| `remote` | "OpenAI server compaction"，endpoint/model 来自 `RemoteCompactionConfig`       | 摘要委托给部署指名的 relay 模型：**remote 端点 = 行配置**（provider_configs 行既是 endpoint 也是凭据源），只指名 selection；#351 execution 机制钉在 compact turn 上，dispatch 与 replay 同一条 fail-closed 解析链 | 1 次（指名的 remote 模型） |
| `snap`   | "Archive history onto dense bitmap images … no LLM call"（snapcompact 独立包） | **快照式 checkpoint，无模型调用**：marker 的 `hideThroughSeq` = snap turn 自身 directive 行的 seq——包括 directive 在内全部离开活动上下文；journal 一行不删（#116），log 即归档；`tokensAfter = 0`（诚实空上下文） | 0 次                       |

**与 omp 的两处显式分歧**（均为环境约束，非偷懒）：

1. snap 不渲染位图：edge DO 无 canvas/pi-natives，bitmap archive 不可达；
   归档面由 journal 本体承担（可重放、时间线 UI 仍全量可见），语义收敛为
   "清空工作上下文 + 归档可回溯"，即 omp snapcompact 在无图读回能力下的极限
   形状。omp 的 snapcompact 图像门（model input 含 "image"）因此不适用——
   本仓 snap 恒可用。
2. remote 不是 OpenAI server-side compaction API：本仓 compact 引擎在 DO 侧
   自研，relay 正本链没有 server-compaction 端点；"另一模型端点"的最短诚实
   形状 = 同一 relay 链上钉另一个模型 selection（omp `remote` 的
   methodOrder fallback `["remote","soft"]` 的"不可用则降级"面由 route 的
   eligibility 门承担，见 §3）。dispatch 失败落 `turn.failed`（诚实 journal），
   不静默重跑 soft。

## 2. methodOrder 偏好（部署级 seat）

- **正本**：D1 单行 seat `compaction_settings`（`tool_capabilities`/
  `permission_mode` 先例），`GET/PUT /api/v1/system/compaction-settings`。
  零 env fallback（#502 裁决姿态）。compact face 每次读，写后即热生效。
- **形状**：`{ methodOrder: ("soft"|"remote"|"snap")[], remote: {providerId?,
model} | null }`。`remote.model` 必填、providerId 缺省走目录 defaultProvider；
  PUT 时按 #351 语义对 live catalog fail-closed 422（`model_unknown` /
  `provider_unknown`）。
- **absent-row 姿态 = `["soft"]`**：裸 `/compact` 按钮与 #546/#309 已交付行为
  逐字节不变。omp canonical order（`["remote","snap","soft"]`，本仓导出常量
  `DEFAULT_COMPACTION_METHOD_ORDER`）是**操作员写进 seat 的 opt-in 序**，不是
  运行时默认——新部署绝不静默把手动 compact 换成快照/委派。
- **解析**（omp `resolveCompactionMethodOrder`/`resolveCompactMode` 语义）：
  - 显式 mode（`POST body {mode}` / `/compact <mode>`）恒胜出；
  - modeless 走序取**首个 eligible**：remote 仅当 seat 指名 summarizer 且
    仍能对 live catalog 解析（漂移 seat 对序遍历视为 ineligible，下一项接手）；
    snap/soft 恒 eligible；
  - 序空/全 ineligible → `soft` 兜底（omp "portable summary last" 面）。
  - 显式 remote 而未配置 → 409 `invalid_request{reason:"remote_not_configured"}`；
    显式 remote 而 catalog 漂移 → #351 命名 422——永不静默降级。

## 3. 触发面

| 面                                         | 形状                                                                                                                                |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `POST /threads/:id/compact`                | body **可选**（bb noRequest wire 保持：空体 = modeless）；`{mode}` 强制单模式                                                       |
| send 面 `/compact [mode]`（#546 通路延续） | omp `allowArgs` 语义收敛：mention 跨 `/compact` 前缀，尾 token 大小写不敏感匹配 `soft                                               | remote | snap`（omp 本名 `snapcompact`为 snap 别名）；空尾 = modeless；未识别 token = 422`unknown_compact_mode`（omp 的"余文 = summarizer focus instructions"面本仓无 plumbing，fail-closed 拒绝而非静默忽略） |
| 内建命令行                                 | `argumentHint: ""`（bb 正本 `BUILT_IN_PROVIDER_COMMANDS` 现为 null），description 列三模式——面板 typeahead 的语义说明面             |
| timeline op row                            | 标题分模式：`Context compacted` / `Context compacted (remote)` / `Context compacted (snapshot)`（SPA 渲染 title 原文，零 SPA 改动） |

omp 未移植的模式：`handoff`（handoff 文档即摘要）、`shake`（无 LLM 丢弃可重建
重内容）——票 #547 只交付 soft/remote/snap 三模式；序常量已按 omp 序预留扩展位。

## 4. Journal 形状（协议 additive，scheme A 零版本号变更）

- `turn.input` 增 `compactMode?: "soft"|"remote"|"snap"`——mode 归属的**唯一
  正本**（replay-is-truth；resume 从该字段重派驱动，无 inputId 前缀解析）。
  `execution` 钉 remote selection（snap 不钉——它永不 dispatch）。
- `thread/compacted` 增 `mode?: "soft"|"remote"|"snap"`，与 `method`（触发面
  manual/auto）正交；#326 auto face 照跑 soft 并显式落 `mode:"soft"`。
  缺失 = #547 前的历史行（soft 语义）。
- resume：snap turn 冷启动重放 `runSnapCompactTurn`（纯 journal append，无
  模型调用）；soft/remote 走原 `runCompactTurnCore`（remote 的 selection 已
  在 turn pin 上，dispatch 与 replay 同链）。
- cut 规划互作用：`turnSlices` 跳过 snap 输入切片——快照簿记行永不作为后续
  soft cut 的 kept material（否则 directive 文本会以无回答 user 行重回上下文）。

## 5. 验收对照

| 票面验收                                              | 落点                                                                                                                                                                    |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/compact remote` → 摘要由 remote 模型出（wire 证据） | journal：turn.input.execution = remote selection + marker `mode:"remote"`；wire：出站 relay POST body `model` = 指名模型（thread-compact.test.ts captureRigWireBodies） |
| `/compact snap` → 快照式                              | marker `mode:"snap"`、`hideThroughSeq` = snap turn.input seq、`tokensAfter` 0、零 model.call；timeline 标题 `(snapshot)`；后续请求重建 priorTurns 为空                  |
| `/compact`（modeless）→ methodOrder 首选              | seat 序遍历 + eligibility 门（order-walk 测试：`["snap","soft"]` → 裸 compact 落 snap）                                                                                 |
| 面板可选偏好序                                        | GET/PUT `/system/compaction-settings`（system-compaction-settings.test.ts：absent 姿态/whole-replace/422 校验/手编 JSON 容错解码）                                      |

测试落点：`packages/agent-do/test/compact-modes.test.ts`（DO 级 snap/remote
campaign + 分类学单元 10 例）、`apps/server-worker/test/compat/thread-compact.test.ts`
（wire/route 面 5 例新增）、`system-compaction-settings.test.ts`（seat 面 6 例）、
`project-commands.test.ts`（argumentHint/description 面）。

## 6. 范围外（显式）

- auto faces（#326 前摄/反应面）不改走 methodOrder——照旧 soft；
  methodOrder 接管 auto 触发面需要独立的触发语义票。
- omp focus instructions（`/compact <mode> <instructions>` 的余文）不移植。
- omp `handoff`/`shake` 模式不移植（见 §3 尾注）。

> AGENT GENERATED: by lane-547-design-compact-omp-soft-remote-snap-met (#547)
