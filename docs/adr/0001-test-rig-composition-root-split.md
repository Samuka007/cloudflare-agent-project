# 测试组合根与生产组合根永久分离

生产入口（`apps/provider-app/src/worker.ts`）只做类导入与真实 runtime 装配，永不挂载 drive 路由、合成目录或任何测试面；rig 入口（`packages/agent-do/src/worker.ts` 及其 `wrangler.jsonc`，绑定 `TestDaemonServiceDO`/`RecordingHubDO`/`agent-do-rig` D1）是独立组合根，由 POC 自行部署到临时 workers.dev 验证后销毁。用户裁决 2026-10-08：测试不得假设生产内嵌后门；生产部署产物零测试面，staging 只以真面验证。

## Considered Options

- **守卫式 drive 路由留在生产入口**（否）：bearer 上锁的后门仍是后门——密钥泄露即任意建线程+配置注入端点，且 rig 绿灯证明的是测试装置、不是产品。
- **staging 管理面加注入端点**（否）：为测试便利给生产增加攻击面，方向相反。
- **独立 rig 组合根**（选）：同一 DO 核心、不同组合，全链验证在本地/临时部署上跑。

## Consequences

- rig 的 HUB 绑定是 `RecordingHubDO`（录制夹具）——rig 绿灯**天然不能**证明生产 hub 行为；关账证据必须标注信号来源（rig/合成 vs 产品面），只有后者支持产品主张。
