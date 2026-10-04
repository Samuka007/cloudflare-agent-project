# Changelog

本仓以 GitHub milestone + 票面验收为里程碑权威记录；本文件是人类可读摘要。
格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [Unreleased] M0 — bb 云端重建（边缘个人 agent）

Milestone: GitHub `M0`。收官状态见 #31 报告；kill criteria：M0 是 bb 的云端重建，
不是 omp 的替代。

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
