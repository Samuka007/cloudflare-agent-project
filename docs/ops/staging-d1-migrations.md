# staging D1 迁移（部署链的迁移一节）

- 工单：Samuka007/cloudflare-agent-project#295（#288 走查发现的事故修复）→
  #591/#594（drizzle 账本制换代）→ #601（T9 contract 收缩，旧装置退役）
- 日期：2026-10-05（账本制本文：2026-10-20）
- 关联：`scripts/deploy-staging.sh`、`apps/server-worker/drizzle/`、
  `apps/server-worker/src/db/schema.ts`、docs/engineering.md 实践 12、
  docs/research/deployable-units.md U1

## 机制（账本制，#594 起）

控制面持久层 = D1 `cap-control-plane-v2`（binding `DB_V2`）：

- **schema 单源**：`apps/server-worker/src/db/schema.ts`（drizzle 定义）。
- **迁移单源**：`drizzle/` 账本（drizzle-kit 从 schema 生成 + 每迁移一条
  `meta/_journal.json` 记录）；ALTER 合法，座表成因消失。
- **apply 单源**：`scripts/deploy-staging.sh` 在 `wrangler deploy` **之前**
  跑 `wrangler d1 migrations apply DB_V2 --remote` ——
  `d1_migrations` 表是唯一应用记录，每迁移恰好一次，重放即跳过
  （second run is a tracked no-op）。任何一条失败 →
  `set -euo pipefail` 中止部署（fail closed，#288 的教训不变：worker 代码
  永不面对"代码假设表存在但 DB 没有"的窗口）。
- **种子**：数据不进 schema——`drizzle/0001_control_plane_seed.sql`
  （`INSERT OR IGNORE`）是唯一 sanctioned 手写文件。
- **漂移守卫**：`test/migrations-ledger.ts` 在模块加载时校验静态导入清单
  与 journal 完全一致（含顺序），漂移即硬错误；旧重放链的
  "0011 文件未注册"缺陷类结构性消失。
- **测试侧**：`test/migrate.ts` 的 `ensureMigrations` 复放同一 apply 语义
  （miniflare 无法调 wrangler CLI，harness 见 `test/migrations-ledger.ts`）；
  fresh-apply / re-apply-no-op / ledger-count 契约由
  `test/migrations-ledger.test.ts` 钉住。

### 如何加迁移

1. 改 `src/db/schema.ts`；
2. `pnpm --dir apps/server-worker run db:generate`（drizzle-kit 生成
   `drizzle/NNNN_*.sql` + journal 条目；种子类数据走
   `drizzle-kit generate --custom`，文件头注记裁决）；
3. `pnpm --dir apps/server-worker test` 绿（账本计数/幂等测试）；
4. push → merge main → CD 自动 apply。

## T9 退役记录（#601，contract 收缩）

旧装置已于 T9 全部删除：

- **旧 db 层**：`src/db/{rows,control-plane,settings,hosts,environments,
thread-tabs,provider-configs,project-sources,web-search,tool-capabilities,
origin-allowlist,permission-mode,compaction-settings,image-source}.ts`
  （手写 SQL/mapper，原 ~2,453 行）——控制面数据访问唯一正本是
  `src/db/repositories/`（drizzle 藏在实现内）。
- **旧重放迁移链**：`migrations/0001…0011_*.sql`（14 文件全量重放、无账本）
  连同其注册清单（旧 `test/migrate.ts` MIGRATION_FILES）一起删除。
- **旧表 DROP**：部署链每次跑一遍对 `cap-control-plane`（旧库，binding 已
  随 `DB` 移除）的幂等 `DROP TABLE IF EXISTS` 清单（含
  `pending_interactions` 镜像表与 `host_daemon_sessions` 孤儿表）——staging
  走查确认后随战役收口删除该块与库本身。
- **回放语义退役**：`migrations-replay.test`（全量重放钉幂等）由
  `migrations-ledger.test`（fresh apply / no-op re-apply / ledger count）
  替代。

## 历史档案（#295–#500 时代的重放契约）

旧机制（2026-10-05 起，#601 止）：部署链按字典序把 `migrations/*.sql`
全量重放到 `cap-control-plane`，幂等契约 = `CREATE … IF NOT EXISTS` +
骑唯一约束的 `INSERT OR IGNORE`、无账本表。事故背景：`0001` 早期手工应用，
`#288` 的 `0002` 合并后部署链无迁移步骤，staging 缺 `environments` 表、
`/api/v1/environments` 500 —— 修复即"迁移成为部署链固定步骤"。该契约的
两个实际缺陷（清单漂移：0011 未注册；禁 ALTER 逼出 9 张单行座表）由
#591 持久层第一性重构整体退役。
