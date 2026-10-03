# ROADMAP：Cloudflare 边缘个人 agent

> 本文档是项目的常设计划书。规划期的全部裁定已从 issue 迁移至此；issue 只承载增量讨论与执行跟踪。

## 项目是什么

把个人 agent 的工作方式从"本地 omp 进程"迁到 Cloudflare 边缘：大脑（agent loop）常驻边缘 Durable Object，每台机器跑一个 daemon（外连 WebSocket，零 SSH/零 NAT 穿透），trajectory 统一存边缘，任何设备打开网页接着聊。

## 四步阶梯

| 里程碑 | 内容 | 验收 | 状态 |
|---|---|---|---|
| M0 骨架 | bb 全栈移植（spec #17 v2）：server 控制面（#26）→ daemon worker（#27）→ provider 应用（#28）∥ agent DO（#29）∥ daemon service+client（#30）→ 合龙换设备验收（#31） | 原版 bb SPA 不改一行跑通全流程 + 双设备演示 | 进行中 |
| M1 可用性硬化 (#14) | 多 daemon、fleet、skills 加载、compaction 基础、崩溃恢复 | 全部用模拟对象验收（对照演练 / 故障注入 / 一周舱内 soak），不碰真实工作 | 计划中 |
| M2 存量迁移 (#15) | 19G 会话 + skills 语料（副本操作，源数据不动） | 抽样比对条数/条目/序列号 | 计划中 |
| M3 生态扩展 (#16) | browser（CF Rendering/camofox）、分享/ACL、自动化面 | 随做随定 | 计划中 |

## 已裁定（规划期结论，票据在 milestone「规划（Charter）」）

| 决定 | 内容 | 票 |
|---|---|---|
| 立项 | 建边缘个人 agent；kill criteria 见下 | #8 |
| MVP | 上述 S0–S3；明确不做 fleet/skills/browser/多机路由/迁移/ACL | #9 |
| trajectory 锚点 | 每 thread 一个 DO；只存 append-only 事件日志（bb 形 `(threadId, seq)` 唯一索引）；无快照表；冷启动重放重建（业界五家同构，见 #7） | #5 |
| bb 底座 | bb 全栈移植进 Workers（server 控制面、daemon 编排、provider 应用、agent DO），2026-10-03 由「薄自建+组件复用」升级（#17 grill）；host 侧仅薄 daemon client；协议版本纪律 scheme A 冻结 | #2 |
| 阶梯 | M0–M3 切分；M1 验收全用模拟对象 | #10 |

## 拓扑不变式

- ThreadDO（loop + 事件日志）与 GatewayDO（每台机器一只，接 daemon 外连）分离；daemon 永远外拨，DO 永不拨号
- 大负载走 R2 旁路，日志只存引用；区域固定 AU；远端读直接回源；分享 = Worker 层签名 token

## 硬约束

1. 里程碑验收不消耗真实工作；生产机器（scitrace/sub2api VPS、chenyizi-4090、hpc2、任何 prod 栈）不入任何里程碑——生产入编是用户逐台、可撤回的决定
2. kill criteria：M0 超 4 个周末没跑通 → 停；日常仍回本地 omp → 停；CF 平台撞死墙 → 缩范围重议
3. 交流用标准普通话与具体指代；人机交流 ≠ subagent 工单语言 ≠ 项目文档语言

## 票据治理

- 里程碑即阶段：规划（Charter，已归档）、M0–M3
- 标签：`type:map/decision/research/implementation` × `status:awaiting-user/agent-ready`
- **sub-issue 仅表达包含分解；时序一律用 blocking 边**（当前：#14 ← #3, #6；#15 ← #14；#16 ← #15）
