# CoT（thinking）渲染顺序/稳定性：复现 + 机制定位 + 修复（#543）

症状（用户报 2026-10-08）：「bb 的 CoT 渲染并不是很顺序/很稳定」。本文是段 1
（复现+机制定位）与段 2（修复钉）的合订证据。staging 真机复现
（glm-5.3-flash，openai-responses 面，线程 `thr_bwcjzpvg9p`，
`bb-staging.samuka007.com`，server 版本 `d21bca9`）。

## 0. 结论速览

| # | 结论 | 位置 |
|---|------|------|
| A | **顺序颠倒（主诉）**：Thought 行按 `item/completed` 的 seq 排序（完成位），不按首条 thinking delta 的 seq（流位置）。completion 与 answer 的 completion 同 journal seq，所以每条 Thought 都沉到自己 answer 的下方——与流式期间用户看到的全局顺序矛盾 | `apps/server-worker/src/services/timeline.ts:475`（修复前 `__order: event.seq`） |
| B | **不稳定（双显/卡显）**：`buildActiveThinking` 只在 `item/agentMessage/delta` 关生命周期（M0 pin 语义偏差）。completion→首条 answer delta 的窗口内，一次 refetch 同时出现持久 Thought 行 + 指示器同文；tool-call-only 的调用（永远没有 answer delta）整个工具执行期指示器卡着已完成 thinking | `apps/server-worker/src/services/timeline.ts:287-339`（修复前） |
| C | **已知形状（未修，非本 bug 直接因）**：`model.call_completed` 的 extraUx 与主行同 seq 发两个 envelope（reasoning + agentMessage 的 item/completed），ux 事件面出现重复 seq [11, 26]（live 证实）。这是回放合同（I3：seq 必须能在 raw log 重放）下的既定折衷，ux-projection 内有先例注释；events 消费方按 seq 去重时需知道这点 | `packages/agent-do/src/ux-projection.ts:392-410, 884-897` |
| D | **PM 探针澄清**：`GET /threads/:id/events?afterSeq=0` 参数形状正确（exclusive 游标，默认 limit=100），复探返回全部 30 事件。当时的空结果是探针瞬态（DO 冷启动/线程 id 手误），非参数 bug | `apps/server-worker/src/routes/threads.ts:1083-1103` |

## 1. 复现路径（可重放）

凭据：仓库根 `.staging-access.env` 的 `CF_ACCESS_CLIENT_ID` /
`CF_ACCESS_CLIENT_SECRET` 作 `CF-Access-Client-*` 头（workers.dev 面已死
#480，唯一活面 bb-staging.samuka007.com）。

```
GET  /api/v1/system/version                      # d21bca9 @ 2026-10-08
GET  /api/v1/system/providers                   # newapi / glm-5.3-flash (reasoning, effort)
POST /api/v1/threads {projectId, origin:"sdk",
     providerId:"newapi", model:"glm-5.3-flash",
     input:[{type:"text", …}]}                  # 201, create-with-input 直接起 turn
POST /api/v1/threads/:id/send {mode:"auto",
     input:[…]}                                 # 缺 mode=422
GET  /api/v1/threads/:id/events?limit=500       # ux 面（seq 有序）
GET  /api/v1/threads/:id/timeline               # 行投影 + activeThinking
WS   wss://…/ws  subscribe {kind:"thread-detail", threadId}
```

轮询纪律：timeline 3s 一拍足够；`delta` 帧（Tier-A）只有 answer 有，
thinking 只发 `events-appended` 指针（SPA 忽略 delta 帧 → 全靠 refetch）。

## 2. 三方对照（live 数据）

**事件面（seq 有序，journal 忠实）** — turn 2：

```
20 item/reasoning/textDelta  "3 + "        ← thinking 先
22 item/agentMessage/delta   "3 + 2×"
23 item/agentMessage/delta
24 item/agentMessage/delta   " 12 = 15\n\n15"
25 item/reasoning/textDelta  "12 = 15"     ← glm 的 thinking 与 answer 交错
26 item/completed reasoning  ┐ 同 seq 26
26 item/completed agentMessage ┘（结论 C）
```

**WS**：thinking → `events-appended {eventTypes:["model.thinking"]}`；
answer → `delta {seq}` + `events-appended {eventTypes:["model.delta"]}`；
无乱序帧（DO→DO at-least-once，客户端按 seq 对账——合同见
`packages/protocol/src/realtime-ws.ts:106-110`）。

**timeline 行（修复前）**：

```
conv/assistant       [22-26]   ← 先渲染 answer
operation/reasoning  [20-26]   ← Thought 沉底（排序键=完成位 seq）
```

thinking 在流里先于/穿插于 answer（seq 20 < 22），渲染却在 answer 之后。
流式期间（指示器在行尾、先于 answer 出现）→ refetch 后 Thought 跳到
answer 下方 → 「不顺序」；每次 refetch 全量重投影（merge 等价由构造保证，
`computeTimelineRowDelta` 带 `rowOrder`），所以 live 与 reload 一致地错。

## 3. 机制（file:line）

管线：`model.thinking`（journal，seq 有序，flush 节流
`packages/agent-do/src/agent-do.ts:2600-2611`）→ ux `item/reasoning/
textDelta`（`packages/agent-do/src/ux-projection.ts:356-379`）→
`item/completed` reasoning（同文件 :381-410，与 agentMessage completion
同 seq :884-897）→ server-worker 行投影。

- **A** `materializeReasoningRow` 的 `__order` 取 `event.seq`
  （`item/completed` 位）；assistant 行的 `__order` 取首条 delta seq
  （`ensureAssistantRow`）。turn/completed 兜底封印的 interrupted Thought
  同病（排序键=turn 终端 seq，沉到全 turn 末尾）。
  修：`__order: lifecycle.firstSeq`。
- **B** bb 正典在 reasoning completion 关生命周期（thread-view
  `assistant-event-projection.ts:174-187`）；M0 移植时保留 pin 语义
  （answer delta 关）。修：`item/completed` reasoning 关闭生命周期；
  answer-delta 扫尾保留作未完成流（abort 无 completion）的兜底。

## 4. 修复钉（段 2）

`apps/server-worker/src/services/timeline.ts`：

1. Thought 行按流位置排序：交错流（thinking→answer→thinking→completion
   同 seq 对）断言 Thought 行先于 answer 行（`reasoning-rows.test.ts`
   "renders the Thought row before the answer it precedes…"）。
2. interrupted 封印按流位置：Thought 先于其后启动的 tool 行。
3. completion 关生命周期：`active-thinking.test.ts` 三钉（completion 即
   关 / 多 call 只关已完成的 / 非 reasoning completion 不动）。

验证：`apps/server-worker` vitest 58 文件 / 417 通过 / 2 skip（含新钉 5
条），tsc 干净；真实复现线程事件流重放进修复后投影，输出
`[Thought(5-11)] [assistant(7-11)] … [Thought(20-26)] [assistant(22-26)]`，
`activeThinking=null`（settled 门）。

## 5. 未做/边界

- 结论 C（同 seq 双发）不动：回放合同优先，SPA 行合并按 row id 不按
  event seq，无实害；后续若做 events 面 seq 去重消费方需知此形状。
- SPA 子模块零改动：行序修复在服务端投影，SPA（含 delta `rowOrder`
  应用，`thread-queries.ts:782-786`）原样受益。
- `afterSeq=0` 空结果不复现（D），不改路由。

> AGENT GENERATED: by zhipu-coding-plan/glm-5.3-flash:max (#543 lane)
