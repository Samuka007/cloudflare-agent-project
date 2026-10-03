# 工程约定：元选型与横切实践

> 本文件是 spec #17「工程底线」的展开。宪法级规则置顶。

## 决策路由（宪法）

| 决策类型 | 归属 |
|---|---|
| 上云相关（DO/驱逐/事务/协议接缝/栈选型） | 本项目自己裁 |
| agent 功能语义（提示/工具/steer/消息装配/记忆） | 抄 omp（github.com/can1357/oh-my-pi，MIT） |
| 产品形状（SPA/server/daemon 协议） | 抄 bb（结构保真移植） |

不重新决策别人已决策好的东西。观测纪律（POMDP）见 AGENTS.md。

## 元技术选型

| 层 | 选型 | 理由 |
|---|---|---|
| HTTP 框架 | Hono | bb 原生，Workers 一等公民 |
| Schema/校验 | zod | bb 原生；协议包已用 |
| 控制面数据 | drizzle（D1 驱动） | bb 形状保真 |
| 轨迹数据 | DO SQLite 裸 SQL + 显式事务 | 事件追加需显式事务控制（裁定 #6：events 不进 D1） |
| 状态机 | 显式 FSM（#23 形状），无状态机库 | 22 不变量可直测 |
| agent DO 内部 | **effect@4.0.0 精确钉版，混合采用**（详见 docs/research/effect-ts-adoption.md）：Stream/typed errors 用于 relay 消费，Fiber/interrupt 用于 turn 编排；事件日志/reducer/DO 壳/WS/alarm/R2/daemon 接缝朴素 TS。负面清单：effect/eventlog、Effect Cluster、@effect/ai、effect/workers（名近实非） | v4 单版本 lockstep + LTS≥2029-09；@effect/sql-sqlite-do@4.0.0 含 DO 事务死锁修复；Effect 不出包边界（protocol 零 effect 依赖） |
| L1 测试 | @cloudflare/vitest-plugin（--max-workers=1 --no-isolate） | 官方栈三层（docs/research/testing-strategy-cloudflare-do.md） |
| Lint | bb eslint 基底 + no-floating-promises | 异步纪律 |

## 横切实践（十条）

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

## 先验半衰期（速查）

月更生态（effect、GitHub API、CF API）按周衰减；稳定层（SQL、HTTP）按十年。落袋前必须有观测。
