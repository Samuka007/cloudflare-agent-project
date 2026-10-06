# c2-thread-list 间歇红——create 后立查 list 的一致性窗口根因

> 工单：Samuka007/cloudflare-agent-project#337（W5 伞）
> 日期：2026-10-06
> 复现环境：apps/server-worker L1 套件（@cloudflare/vitest-plugin + miniflare workerd，`vitest.config.ts` 单 worker 上下文 `maxWorkers:1 / isolate:false`）
> 修复面：`apps/server-worker/src/db/control-plane.ts` listThreads ORDER BY（读面，非测试面）
> 复现加固：`scripts/verify-c2-list-window.sh`（`nix run .#verify-c2-list-window`）

## 0. 结论先行

1. **不是一致性缺陷**：create 写面（`POST /threads` → `createThreadRecord` D1 INSERT）与 list 读面（`GET /threads?limit=50` → `listThreads` D1 SELECT）走同一个 D1 binding，本地 miniflare 与生产 D1 均为读己之写（read-after-write）强一致。证据：复现红时 12 次×250ms 只读重试（PR #340/#345 引入的兜底）全部落空（失败耗时 3161ms ≈ 12×250ms + 开销）——若是可见性滞后，3 秒窗口足够落定；只读重试永远看不到，说明行**确定性**不在返回窗口里，而非"还没到"。
2. **根因是读面排序缺陷**：listThreads 的 ORDER BY 把 bb 的 pinned 块内部 tie-break（`pin_sort_key ASC, id ASC`）从 CASE 作用域里"摊平"成了全局排序键。未 pin 行的 `pin_sort_key` 恒为 NULL（常量键），于是**全部未 pin 线程按 `t.id ASC` 排序**——而线程 id 是随机 31 字符后缀（`thr_` + `GENERATED_ID_SUFFIX_LENGTH=10`，`src/shared/ids.ts:15-22`）。等价于：返回窗口 = 全库 id 字典序最小的 50 条，新线程落点均匀随机。
3. **共享库放大成间歇红**：vitest 配置 `isolate:false`（DO+WS 测试需要共享 worker 上下文，见 `docs/research/testing-strategy-cloudflare-do.md` §4.4），42 个测试文件共享同一份 D1，线程行只增不减。实测 c2 运行时刻库内可见线程 **total=73**，新线程 **rank=59**，窗口 **window=50** → 必红。id 每轮随机 → rank 每轮随机 → **同一提交两次 run 结果互异**（绿概率 ≈ 50/73 ≈ 68%，与 CI 观测"3 红实例 + 绿实例若干"吻合）。测试面只读重试（#340）与重试加宽（#345，6×150ms→12×250ms）都治不了它——行不在窗口里，重试一万次也不在。
4. **这也是产品 bug，修读面**：bb 语义（`buildActiveProjectThreadOrderBy`，bb `packages/db/src/data/threads.ts:735-750` @ 8473d8c33）是 pinned 块在前、其余按 `createdAt DESC, id DESC` 倒序——新线程永远在侧边栏第一页。移植版排序下，线程数 >50 的部署里新线程会从侧边栏"消失"（落进 LIMIT 窗口外）。按工单"二选一"裁决：**修读面**（恢复 bb 字节语义），测试面回归单次读取并记录真实根因。
5. **修法**：ORDER BY 恢复 bb 的 CASE 作用域形态——`pin_sort_key`/`id` 仅对 pinned 行生效（CASE 无 ELSE 出 NULL），未 pin 行落空到 `created_at DESC, id DESC`。修复后新建线程 created_at 严格最大（套件串行，无同 ms 竞争；即便同 ms 平局也有 id DESC 破平，仍在窗口头部）→ 测试确定性绿。

## 1. 证据链

### 1.1 读面与写面（同一 D1，无投影层）

- 写：`src/routes/threads.ts:322-337` → `createThreadRecord`（`src/db/control-plane.ts:338-378`）D1 INSERT 后立即 `getThreadRow` 读回成功才返回 201。
- 读：`src/routes/threads.ts:176-192` → `listThreads`（`src/db/control-plane.ts:175-267`）纯 SELECT。
- 面装配 `toThreadListEntries`（`src/services/runtime-display.ts:153-182`）`rows.map` 一对一，不丢行。两个面之间没有缓存、没有 DO 投影、没有异步物化——不存在"投影滞后"。

### 1.2 排序缺陷（移植走样）

bb 原文（`/home/nixos/workspace/bb` @ 8473d8c33，`packages/db/src/data/threads.ts:744-750`）：

```ts
function buildPinnedThreadOrderBy() {
  return [
    asc(sql`CASE WHEN ${threads.pinnedAt} IS NOT NULL THEN 0 ELSE 1 END`),
    asc(sql`CASE WHEN ${threads.pinnedAt} IS NOT NULL THEN ${threads.pinSortKey} END`),
    asc(sql`CASE WHEN ${threads.pinnedAt} IS NOT NULL THEN ${threads.id} END`),
  ];
}
// buildActiveProjectThreadOrderBy(): [projectId, ...pinned, desc(createdAt), desc(id)]
```

`pinSortKey`/`id` 两键被 CASE 包住：未 pin 行取 NULL，排序落到 `createdAt DESC, id DESC`。

移植版（修复前 `src/db/control-plane.ts:221-224`）：

```sql
CASE WHEN t.pinned_at IS NOT NULL THEN 0 ELSE 1 END ASC,
t.pin_sort_key ASC, t.id ASC,          -- ← CASE 壳被摊平，对未 pin 行变成常量键 + 生效键
t.created_at DESC, t.id DESC
```

未 pin 行：键 1 恒 1、键 2 恒 NULL、键 3 `t.id ASC` **全面生效**——随机 id 字典序决定整个列表顺序。

### 1.3 复现与定量（2026-10-06 本地，与 CI 同构场景）

全量套件（42 文件）单轮内对 c2 打点（临时探针，已撤）：

| 量 | 值 |
| --- | --- |
| 库内可见线程 total | 73 |
| 读窗口 window | 50（`?limit=50`） |
| 新线程 rank | 59（findIndex，0 起） |
| 12×250ms 重试结果 | 全部落空 → 必红 |

- 修复前两轮全量套件：一红（rank 59）一绿（同机制、随机 rank 落进窗口）——间歇性直接可见。
- 修复后全量套件连跑全绿（见 §3 验收）。

### 1.4 为什么 CI 观测是"间歇"而非"必红/必绿"

id 每轮随机重生成 → 新线程 rank 在 [0, total] 均匀分布 → 绿概率 ≈ min(1, 50/total)。total 随测试文件增删缓慢漂移（73 ≈ 68% 绿），故同一提交能同时出现红/绿实例；`#333 旧基`（测试文件更少、total 更小）与 `#335 PR run` 差异同理——**红率由 total 漂移决定，与提交内容无关**。

## 2. 修法裁决（工单"二选一"）

- **修测试（轮询到出现）被否**：最终一致语义在这里不存在——行要么在窗口里要么不在，轮询只是把必红变成必红多等 3 秒。#340/#345 两轮加宽重试已被复现证伪（3s 预算全部落空）。
- **修读面（采纳）**：恢复 bb `buildPinnedThreadOrderBy` 的 CASE 作用域。这不是绕过测试的补丁，而是修复侧边栏"新线程 >50 条时不可见"的真实产品缺陷（§0.4）。测试回归单次读取（读己之写强一致，无需重试），注释记录真实根因防复发。

## 3. 复现加固与验收

- 脚本：`scripts/verify-c2-list-window.sh`（flake 入口 `nix run .#verify-c2-list-window [-- --rounds N]`，默认 20 轮）。场景 = CI verify 对本缺陷的红面（apps/server-worker 全量 vitest run，isolate:false 共享 D1），逐轮日志落 `.c2-verify-logs/`（gitignored），首红即停并保留现场。
- **验收（2026-10-06）**：修复后 50 轮全量套件（round 01-50）+ 2 次 CI verify（runs 37414340068 / 37414309379，push 与 PR-sync 各一，即历史上互异的同提交双实例场景）——**c2-thread-list 零红（54 次全量场景全绿）**。修复前对照：全量套件 4 轮中 1 红（rank 59 实录）。
- **50 轮中浮现的两个他票间歇红（非本缺陷，均不触 c2）**：round 20 `test/unit/lease-do.test.ts`（50ms TTL 墙钟竞速，单文件 10 连跑全绿 → 负载依赖）；round 21 `test/compat/join-codes-onboarding.test.ts`（mint/enroll 500 ×2）。两者与 listThreads 排序零交集（leases/join-codes 不读 threads 列表面），各有独立日志为证，另立票处理。
- 防复发知识：任何给 `listThreads` 加排序键/加窗口的改动，先跑 `nix run .#verify-c2-list-window -- --rounds 20`。

> AGENT GENERATED: by zhipu-coding-plan/glm-5.3-flash
