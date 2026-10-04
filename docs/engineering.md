# 工程约定：元选型与横切实践

> 本文件是 spec #17「工程底线」的展开。宪法级规则置顶。

## 决策路由（宪法）

| 决策类型                                        | 归属                                       |
| ----------------------------------------------- | ------------------------------------------ |
| 上云相关（DO/驱逐/事务/协议接缝/栈选型）        | 本项目自己裁                               |
| agent 功能语义（提示/工具/steer/消息装配/记忆） | 抄 omp（github.com/can1357/oh-my-pi，MIT） |
| 产品形状（SPA/server/daemon 协议）              | 抄 bb（结构保真移植）                      |

不重新决策别人已决策好的东西。观测纪律（POMDP）见 AGENTS.md。

## 元技术选型

| 层            | 选型                                                                                                                                                                                                                                                                                           | 理由                                                                                                                           |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| HTTP 框架     | Hono                                                                                                                                                                                                                                                                                           | bb 原生，Workers 一等公民                                                                                                      |
| Schema/校验   | zod                                                                                                                                                                                                                                                                                            | bb 原生；协议包已用                                                                                                            |
| 控制面数据    | drizzle（D1 驱动）                                                                                                                                                                                                                                                                             | bb 形状保真                                                                                                                    |
| 轨迹数据      | DO SQLite 裸 SQL + 显式事务                                                                                                                                                                                                                                                                    | 事件追加需显式事务控制（裁定 #6：events 不进 D1）                                                                              |
| 状态机        | 显式 FSM（#23 形状），无状态机库                                                                                                                                                                                                                                                               | 22 不变量可直测                                                                                                                |
| agent DO 内部 | **effect@4.0.0 精确钉版，混合采用**（详见 docs/research/effect-ts-adoption.md）：Stream/typed errors 用于 relay 消费，Fiber/interrupt 用于 turn 编排；事件日志/reducer/DO 壳/WS/alarm/R2/daemon 接缝朴素 TS。负面清单：effect/eventlog、Effect Cluster、@effect/ai、effect/workers（名近实非） | v4 单版本 lockstep + LTS≥2029-09；@effect/sql-sqlite-do@4.0.0 含 DO 事务死锁修复；Effect 不出包边界（protocol 零 effect 依赖） |
| L1 测试       | @cloudflare/vitest-plugin（--max-workers=1 --no-isolate）                                                                                                                                                                                                                                      | 官方栈三层（docs/research/testing-strategy-cloudflare-do.md）                                                                  |
| Lint          | bb eslint 基底 + no-floating-promises                                                                                                                                                                                                                                                          | 异步纪律                                                                                                                       |

## 横切实践（十一条）

0. 跨 lane 依赖（事故规则，2026-10-03 夜）：**禁止 import 不在 origin/main 上的包**——兄弟 lane 工作树里的未提交产物是隐形耦合（案例：server-worker 消费未提交的 agent-do 导致 main CI 红 40 分钟）。需要跨包消费时：要么等目标包先落地，要么本地声明接口类型隔离，push 前确认 `pnpm -r typecheck` 在干净 checkout 等价面上可通过
1. 契约单一源：wire/事件形状只出自 packages/protocol；形状争议 bb 源码裁决
2. 错误在接缝归一：原生错误出边界前翻译进协议错误分类；裸错误字符串不过接缝
3. 失败语义显式标注：跨组件调用声明 at-least-once / at-most-once / 幂等键位置（#23 §4）
4. 时间归属：权威定时器只在边缘（DO alarm/租约）；时长全部来自协议包命名常量
5. 状态变更先事件：扛驱逐的变更先 append；纯内存态可重放重建（22 不变量强制）
6. 日志带相关性三元组 (threadId, seq|executionId, requestId)；断言测事件不断言日志
7. 两把钥匙各守各的门：Access JWT 只在 Worker 前门；hostKey 只在 daemon 接缝；内部不重复验权
8. 幂等写：D1 用 CAS（bb 形状）；DO 写用显式事务
9. FSM 穷尽匹配：switch 禁 default，新增断点编译期红
10. 移植保真：bb 已有之物逐字保真；新物种组件（daemon client）文档化标准与 bb 等同
11. DO 请求量预算（#36 事故规则，2026-10-04）：跨 DO 接缝的设计必须附请求量预算表——哪些路径**必碰 DO**、哪些在**边缘消化**。DO 是按请求计费的热路径，边缘能消化的量（鉴权、拒绝、缓存、限流）不进 DO；DO 只留真状态。事故基线：#36 前 daemon-service front 是纯透传，每个协商请求 ≥1 次 DO RPC（hostKey 校验也走 DO），无负缓存、无限流，单 client 故障即可无限放大 DO 请求量。
12. 版本与交付纪律（2026-10-04）：staging 部署只经 `nix run .#staging-deploy`（SPA 构建→资产断言→SERVER_VERSION=commit SHA→deploy；工具链由 flake 钉版）；milestone 关票打 tag 并更新 CHANGELOG；面板/基础设施侧变更（无 git 面）当日入 `docs/ops/`。M0 后 lane 改 **PR-per-lane**（直推 main 仅限事故热修，且票面必须留 PM 亲验证据）。

daemon-service front 预算表（#36 实测形状，边缘闸门序：鉴权 → 负缓存 → 令牌桶 → DO）：

| 路径                   | 必碰 DO？           | 边缘消化                                                 | 说明                                                                                                                                                         |
| ---------------------- | ------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/health`              | 否                  | 100%                                                     | 无状态探活                                                                                                                                                   |
| `/enroll`              | 是（mirror RPC ×1） | KV 缓存写入                                              | 低频管理面；顺序 mirror（权威）→ KV（缓存）；mirror 写失败 fail-closed，KV 写失败由回填自愈                                                                  |
| `/session/open` 鉴权段 | 否（例外见下）      | env 比较 → KV hash → KV miss 才 1 次 DO `authCheck`+回填 | #36 前每请求 1 次 DO；鉴权决定可缓存                                                                                                                         |
| `/session/open` 协商段 | **是**              | 负缓存窗口内 429 零 DO；令牌桶超限 429 零 DO             | open 是 §8.5 唯一裁决点 + I17 顶替发生地，**成功结果不可边缘缓存**（缓存 sessionId 会跳过 reconcile 与 replace close——#36 允许降级为只缓存鉴权决定，已照办） |
| `/ws` attach           | **是**              | 同上两道闸                                               | socket 归 DO 所有（hibernation/租约）                                                                                                                        |
| `/agent/*` smoke 面    | 是                  | 无                                                       | 本地 smoke 驱动面；M1 由 agent DO 直连 RPC 取代                                                                                                              |
| DO 配额/过载故障       | —                   | 负缓存 30s：窗口内该 host 全部 429+Retry-After，零 DO    | 事故主放大器被切除；L1 实测 51 请求 1 次 DO 触碰（≈98% 削减）                                                                                                |

语义红线（写入实现注释与测试）：负缓存只键基础设施类失败（配额/过载），**业务失败**（`protocol_version_mismatch`、`host_offline`、`invalid_session`）不进负缓存——§8.5 恢复依赖 client 重连时反复 open 打到 DO。

## 先验半衰期（速查）

月更生态（effect、GitHub API、CF API）按周衰减；稳定层（SQL、HTTP）按十年。落袋前必须有观测。
