# staging D1 迁移（部署链的迁移一节）

- 工单：Samuka007/cloudflare-agent-project#295（#288 走查发现的事故修复）
- 日期：2026-10-05
- 关联：`scripts/deploy-staging.sh`、`apps/server-worker/migrations/`、docs/engineering.md 实践 12、docs/research/deployable-units.md U1

## 事故背景（#288 走查，2026-10-05）

`0001_control_plane.sql` 是早期手工应用到 staging 的；`#288` 的
`0002_environments.sql` 合并进 main 后部署链没有任何迁移步骤，staging 库缺
`environments` 表，`/api/v1/environments` 500。修复 = 把迁移变成部署链的
固定步骤（本文件）+ 幂等契约 + CD 冒烟防回归。

## 机制

`scripts/deploy-staging.sh` 在 `wrangler deploy` **之前**，按字典序把
`apps/server-worker/migrations/*.sql` 逐文件重放到 staging D1
（`cap-control-plane`）：

```bash
wrangler d1 execute cap-control-plane --remote -y \
  -c wrangler.staging.jsonc --file "migrations/<file>.sql"
```

- 任何一条失败 → `set -euo pipefail` 中止部署，worker 新版本不上线
  （fail closed）。
- 先迁移后部署：worker 代码永不面对"代码假设表存在但 DB 没有"的窗口。
- 新迁移文件只要落进 `migrations/` 即被部署链自动拾取（glob），无需改脚本。

## 幂等契约

迁移文件在**每次部署**都会全量重放，DB 状态可以从裸库到已完全迁移
（#295 之前 0001 就是手工应用的基线），因此**每个语句必须幂等**：

- DDL 一律 `CREATE TABLE / CREATE INDEX IF NOT EXISTS`；
- 种子数据用 `INSERT OR IGNORE`，且必须骑在唯一约束上（例：0001 的
  `projects_personal_singleton_idx` 部分唯一索引保证 `proj_personal`
  只种一次）；
- 需要非幂等步骤的迁移（ALTER、数据回填）必须自门控：先查
  `sqlite_master` / 目标行存在与否再执行。

**无账本表**：幂等重放天然吸收任何基线——重放已应用文件是 no-op，缺失的
文件被补上——无需维护"已应用记录"表，也就没有账本与实际 schema 漂移的
第二真相源问题。

## 如何加迁移

1. 新建 `apps/server-worker/migrations/<NNNN>_<name>.sql`（四位零填充序号，
   字典序 = 应用序），每个语句遵守幂等契约（文件头有契约注记）。
2. 在 `apps/server-worker/test/migrate.ts` 的 `MIGRATION_FILES` 注册（测试侧
   显式清单，防新文件漏应用）；需要读面时同步 `src/db/rows.ts` 与
   contract schema。
3. `pnpm --dir apps/server-worker test` 绿——
   `test/migrations-replay.test.ts` 在已迁移库上全量重放全部迁移文件，
   钉住幂等契约（重复种子/丢行即红）。
4. push → merge main → CD 自动重放；部署后冒烟含
   `GET /api/v1/environments` 200（deploy-staging.yml post-deploy smoke）。

## 本地验证（不碰远端库）

```bash
cd apps/server-worker
rm -rf /tmp/d1verify
pnpm exec wrangler d1 execute cap-control-plane --local --persist-to /tmp/d1verify \
  --file migrations/0001_control_plane.sql -y
# 依次重放 0002、再重放 0001/0002 各一遍——全部零错即幂等成立
```
