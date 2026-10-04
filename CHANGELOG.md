# Changelog

本仓以 GitHub milestone + 票面验收为里程碑权威记录；本文件是人类可读摘要。
格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [Unreleased]

### Fixed

- **#226 (P0) Stop request 无效**：`POST /threads/:id/stop` 是 no-op 存根——SPA
  Stop 打进死路由，turn 永不落终态；ask pending（DO 有意挂起看门狗的「用户即
  deadline」态）彻底挂死。路由现在从 agent DO 原始 journal 折出活动 turn
  （`activeTurnIdFromEvents`：input/steer 立指针、终态行清指针，ask pending 保持
  可取消），直连 DO `cancelTurn` 完成取消（T19 面：`turn.cancel_requested` →
  abort driver → kill 非终态执行，含 ask interrupt）；不走 orchestrator
  thread/stop——该面会毒化 provider session 注册表，而 composed edge-agent 的
  journal 折叠本就干净、无恢复消费者。L2：agent-do ask.test.ts 停止路由 fold
  断言（ask pending = 可取消活动 turn，cancel 落 `turn.cancelled` 后清空）；
  L1：server-worker thread-stop.test.ts（静默 no-op、完成后 no-op、404）。

## [m1.5] — 2026-10-04 · 工具集完备（omp 33 工具面边缘化）

Milestone `M1.5` 收官（票集 #91–#116，正本 docs/proposals/m15-ticket-set.md 六波次；
关账口径=essential 12，#103 用户裁决——记忆族列未来功能移出）。T26 收官门
（#116）：全注册工具面 replay 一致性回归矩阵全绿 + 对照差距清单收窄
（docs/ops/m15-closeout.md）。

### 注册面与执行路由（T1–T4，#120/#129/#132/#140）

- AgentDO 编译期工具注册表（单 schema 权威，行形状冻结
  `{name, schema, descriptionTemplate, class, backend, intent}`）；edge 类 DO 本地
  执行路由——journal 先行、驱逐重放存活
- edge 三件套先行：context_notes/new_context/think；wait + JobRegistry 接口冻结
  （唤醒竞速/30min 帽/owner 过滤）；会话树三件 todo/checkpoint/rewind（DO-local）；
  ask 走 DO↔SPA pending-interaction 通道（bb interactive-request 对齐）
- #150 五闸：think/context_notes/new_context/checkpoint/rewind 默认 OFF（omp 姿态），
  env 开闸（AGENT_DO_EXTERNAL_THINKING / _CONTEXT_NOTES / _CHECKPOINT）

### host 工具全语义（T5'–T11/T15，#135/#138/#141/#143/#144/#153/#221）

- 嵌入式 omp 运行时 bring-up（vendored runtime，Settings/auth 隔离）+ read/glob/
  grep/edit/write/manage_skill/find 激活与逐工具语义 L1；bash 全语义对齐
- eval：宿主持久内核 seam（framed-IPC py + js worker VM + IdleTimeout），DO 驱逐
  重放 re-attach 不二次 spawn（T10'，#139）
- web_search 边缘化：DO 原生 fetch provider 面，browser-backed 引擎配置层显式排除
  （T12，#144）；find judge 经 provider 通道（#145）；task isolated 隔离后端 daemon 半
  （T20，#153）；security_scan 整体归 daemon（凭据宿主保管，T15，#221）

### task/子代理族（T16–T19，#137/#146/#179/#213）

- task 同 host：单派发 + 子 AgentDO + yield 闸 + 结果回灌；yield 全语义 +
  `agent://` 工件族；task batch + 会话级 Semaphore + 预算梯（投机预启动按票面记录裁切）；
  子代理生命周期四态（running/idle/parked/aborted）+ TTL park + 复活 + kill

### 收官门（T26，#116）

- 表驱动 replay 一致性回归矩阵（`packages/agent-do/test/t26-replay-matrix.test.ts`）：
  全注册 21 行 × 驱逐注入（`abortAllDurableObjects`/`evictDurableObject`）× 去重
  （同 executionId 重问=journal 应答、零二次 spawn）+ bash/eval outcome-unknown 暴露格
  - task readopt 格；完备性由测试强制（注册表新行无矩阵条目即红）
- 对照差距清单收窄记录（docs/ops/m15-closeout.md §3/§4）：C5/D13 逐项处置、
  #24/#25 重调政策接口对齐核对（executed 标记制缝冻结就绪）

## [m0] — 2026-10-04 · bb 云端重建（边缘个人 agent）

Milestone `M0` 已关账（#31 用户签收：演示跑通，kill criteria 成立——M0 是 bb 的
云端重建，不是 omp 的替代）。staging 遗产：cap-server-staging@ece470f，
SERVER_VERSION=commit SHA 注入。

### 架构落地（#18–#30）

- 全栈 Cloudflare Workers 化：bb SPA（verbatim dist）→ server-worker（Hono API 面）→
  agent DO（per-thread 轨迹 + turn FSM，22 不变量）→ daemon-service（DO + 无状态 front）
  → daemon client（WS 长连，host 工具执行）；provider-app/daemon-worker 面就位
- 协议主权：`packages/protocol` 唯一 wire/事件形状源；scheme A 零版本号变更
- 事件日志：DO SQLite 追加式（裁定 #6：events 不进 D1），无快照表，compaction 即检查点
- effect@4.0.0 精确钉版、混合采用（Stream/Fiber 进 relay 与 turn 编排，负面清单见
  docs/research/effect-ts-adoption.md）

### 模型中转（#28/#34）

- Anthropic Message 协议 relay（glm-5.3，thinking disabled）
- 链路：agent DO → newapi（channel 10 直连 zhipu 原生 Anthropic 端点，绕开面板
  oai→anthropic 转换截断 bug）→ 真模型 turn 端到端打通（ACK-M0 实证）

### 事故与加固（2026-10-04）

- DO 免费档配额烧穿事故 → 三修：#35 client 统一协商退避（1s→5min 指数+抖动+
  Retry-After）、#36 front 边缘防护（KV 鉴权梯/负缓存/令牌桶，DO 请求量 ≈98% 削减，
  engineering.md 横切实践 11 "DO 请求量预算"入宪）、#38 服务端断 WS 自愈
- SPA 白屏事故 → #39 部署流程纳入 dist 构建与资产断言（flake app `nix run .#staging-deploy`，
  工具链钉版 + shellcheck 门）
- hosts 生命线修复（#62）：daemon 心跳 → 注册表 last_seen_at 投影（SQL 端 30s 节流，
  防 D1 写配额烧穿；bb markHostSeen 语义），/hosts status 弃路由钉死 disconnected、
  改读时派生（per-host service DO hostLiveness：现役会话 + 活 socket，bb
  entity-lookup toHostStatus 语义），SPA "Host disconnected" 横幅与真值一致

### 工程实践

- eslint strictTypeChecked + prettier 全仓（#37/#43），CI 三门（lint/typecheck/test）
- 版本管理：commit SHA 注入 SERVER_VERSION（部署溯源）；bb 子模块钉 ba4265453；
  infra 漂移入档（docs/ops/）；M0 关票打 tag
