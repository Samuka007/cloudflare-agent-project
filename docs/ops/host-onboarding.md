# Host Onboarding——把一台机器接入 cap 执行面（用户视角）

> 面向"想让 cap 在我的另一台电脑上跑任务"的使用者。服务端 = cap-server-worker
> （bb SPA + API），执行端 = cap-daemon（Nix 闭包，`flake.nix packages.daemon`）。
> 本文步骤在 2026-10-05 真机走查逐条验证（证据：#258 close-out 报告；部署版本
> `lane-258-e3a93e6`，`GET /api/v1/system/version` 可查）。

## 链路总览

```mermaid
flowchart LR
  A[Settings → Machines<br/>Add a machine] -- "POST /api/v1/hosts/join-codes" --> B[join code<br/>一次性 · 15 分钟]
  B --> C[curl …/install.sh | sh<br/>--join-code --host-id --server]
  C -- nix run …#cap-daemon --> D[cap-daemon<br/>--server --join-code]
  D -- "POST /enroll（兑码）" --> E["hostId/hostKey<br/>（dataDir 0600 持久化）"]
  E -- "POST /session/open + /ws" --> F[会话建立]
  F -- host-connected 广播 --> G[对话框原地翻绿<br/>"nixos connected"]
```

## 前置条件

1. **目标机器装有 Nix**（任何发行版；NixOS 天然满足）。cap-daemon 以 Nix 闭包
   分发（bun 1.4.2 + TS 源 + 生产 node_modules，约 582 MiB，见 `docs/ops/cap-verify.md`
   Appendix #176）。没装 Nix：`sh <(curl -L https://nixos.org/nix/install) --daemon`。
   没有 Nix 的机器暂时无法接入——上游 bb 的 npm 安装器（S9）不在本部署范围。
2. **能打开服务的 Web UI**（owner 身份），知道服务的 URL（下称 `<server>`）。
3. 网络上目标机器可达 `<server>`（公网 worker 域名或内网地址均可；daemon 只
   出站连接，不需要入站端口）。

## 步骤

1. 打开 **Settings → Machines → Add a machine**。对话框会自动铸造一个 join
   code（一次性、15 分钟有效），显示一行安装命令：
   ```
   curl -fL --progress-meter --connect-timeout 10 --max-time 60 --retry 2 \
     <server>/install.sh | sh -s -- --join-code <code> --host-id <hostId> --server <server>
   ```
   倒计时走完显示 "Code expired"，点 **Generate a new code** 重新铸造即可。
2. 把这行命令原样跑在**目标机器**上。它会：
   - 校验目标机有 `nix`（没有就报错并给安装指引，exit 1）；
   - `nix run github:Samuka007/cloudflare-agent-project#cap-daemon`（首次会构建
     约 600 MiB 闭包，之后走 store 缓存）；
   - 用 join code 向 `<server>/enroll` 兑换身份。**`--host-id` 在本部署是提示性
     的**——身份以兑码时服务端铸的 hostId 为准（bb 语义：key 元数据决定身份）。
   - daemon 前台运行，日志依次出现：
     ```
     boot <uuid> sandbox=… dataDir=…
     native addon gate: current
     enrolled as hostId=host_xxx (credentials persisted 0600)
     session sess_xxx opened (heartbeat 5000ms)
     session.ready sess_xxx
     sync.complete generation=1
     ```
     `session.ready` 即接入完成。
3. 回看浏览器：对话框底部的观察位会在几秒内翻成 **"<机器名> connected"**（WS
   广播实时推送，无需刷新），并给出 "Set up a project on it →"。机器名是目标机
   的 hostname（enroll 时自报）。`/hosts` 列表同步出现该机器，`status: connected`。
4. （可选）Ctrl-C 结束前台 daemon 后，用 systemd 常驻（参照 cap-verify.md 先例，
   `<out>` 换成 `nix build` 输出路径或保持 `nix run` 形态自管）：
   ```bash
   systemd-run --user --unit=cap-daemon \
     -p Restart=on-failure \
     nix run github:Samuka007/cloudflare-agent-project#cap-daemon -- \
     --server <server> --dataDir ~/.local/state/cap-daemon
   ```
   注意 enroll 只在**没有已持久化身份**时发生；常驻进程直接复用 dataDir 里的
   `host-id` + `auth.json`（0600），断电重启不重铸。

### 容器形态（#425，本地测试 rig）

不想在宿主上留 systemd 单元（WSL 测试环境同款）时，daemon 以 docker 容器跑。
镜像 `packages.cap-daemon-image` 与 `packages.daemon` 同闭包（bun + client 源 +
生产 node_modules），entrypoint 即 `bun run src/client/index.ts`，`--help` 直达
用法面：

```bash
nix build github:Samuka007/cloudflare-agent-project#cap-daemon-image \
  --out-link result-cap-daemon-image
docker load < result-cap-daemon-image        # → cap-daemon:0.1.0-<rev>

# 一次性接入（join code 走上节 Add a machine 流程；--hostname 决定 enroll 自报
# 机器名——不指定则是容器 id）
docker run --rm --name cap-daemon-test \
  --hostname "$(hostname)" \
  -v ~/.local/state/cap-daemon-container:/data \
  -e DAEMON_SERVICE_URL=<server> \
  -e DAEMON_JOIN_CODE=<code> \
  cap-daemon:0.1.0-<rev>
```

配置全走容器环境变量（`-e`/`--env-file`）：`DAEMON_SERVICE_URL`、
`DAEMON_ENROLL_KEY`|`DAEMON_JOIN_CODE`（二选一）、CF Access 双键
`DAEMON_CF_ACCESS_CLIENT_ID`/`_SECRET`（过 Access 的 face 才要，成对）、
`DAEMON_DATA_DIR`（镜像缺省 `/data/data`）、`DAEMON_SANDBOX_ROOT`（缺省
`/tmp/cap-sandbox`）。身份卷：`-v <host-dir>:/data` 后 `host-id`/`auth.json`
落在 `<host-dir>/data/`（0600）；同卷重启即身份恢复，不再要求凭据（#378 门）。
镜像内自带基线工具集（bash/coreutils/git/grep/sed/find/ps）替代宿主 profile
PATH（#254）——容器里没有宿主工具，工具 turn 的能力边界以镜像为准。

对本地 `wrangler dev` 走查（无 Access 墙，E2E 最短路径）：

```bash
# 服务端（另一终端）
cd apps/server-worker
wrangler d1 migrations apply cap-control-plane --local
printf 'ENROLL_KEY=dev-enroll-key\nDAEMON_HOST_KEY=dev-host-key\n' > .dev.vars
wrangler dev                                  # :8787

# 容器侧（Linux docker 需 host-gateway 才有 host.docker.internal）
docker run --rm --add-host host.docker.internal:host-gateway \
  -e DAEMON_SERVICE_URL=http://host.docker.internal:8787 \
  -e DAEMON_ENROLL_KEY=dev-enroll-key \
  cap-daemon:0.1.0-<rev>
```

日志序列同第 2 步：boot → native addon gate → enrolled as hostId=… →
session opened → session.ready → sync.complete。

## 身份与重来

- 身份只有一份：`<dataDir>/host-id` + `<dataDir>/auth.json`（0600）。dataDir 缺省
  `~/.local/state/cap-daemon`，可用 `--dataDir` 改。
- 换身份/重新接入：停掉 daemon，删掉 dataDir，重新走 Add a machine（旧 code 若
  已用掉/过期都会 401，重铸即可）。
- **一台机器 = 一个 dataDir = 一个 hostId**。同一台机器要扮演两个 host，给两个
  dataDir；反过来，两个进程共用一个 dataDir 会互踢会话（同 hostId 顶替语义，
  `ws closed (code 1000: replaced)` 死循环——cap-verify.md 教训）。

## 排障

| 症状 | 原因与处理 |
| --- | --- |
| 对话框显示 "Couldn't create a join code." | 服务端铸码失败。仅当部署缺 `DAEMON_EDGE_KV` 绑定时发生（503 `join_codes_unavailable`）——找部署者补绑定 |
| enroll 401 | code 已被用掉/过期/拼错。回对话框 **Generate a new code**；注意 curl 的引号与换行（复制按钮拿的是单行） |
| `install.sh` 报 "'nix' is required" | 目标机无 Nix。按提示安装后重跑，或见前置条件 1 |
| `nix run` 构建失败/极慢 | 首次构建 ~600 MiB；确认 `cache.nixos.org` 可达。构建问题与本服务无关 |
| 对话框一直 "Waiting for the machine to connect…" | 看目标机日志：没到 `session.ready` 就还没接上。`/api/v1/hosts` 里没有该机器 = enroll 没成功（401 类）；有机器但 `status: disconnected` = WS 没建立（查网络到 `<server>`） |
| 本地 `wrangler dev` 走查时 `/api/v1/hosts` 500（no such table: hosts） | 本地 D1 未迁移：`wrangler d1 migrations apply cap-control-plane --local`（生产部署流水线自动迁移，不受影响） |

## 安全边界（与 bb 的偏离，M1 收口）

- join code **一次性、15 分钟**（bb `ENROLL_KEY_TTL_SECONDS`），兑一次即焚；KV 中
  只存哈希。兑码成功把**部署级共享 hostKey**（POC 模型，env 下发）交给接入机——
  这与静态 `DAEMON_ENROLL_KEY` 分发同信任级别，但不再需要把长期 env 塞给对方。
  per-host key 签发/吊销/轮换 = M1 key registry（#195 S7 维持 crop）。
- `GET /install.sh` 公开无鉴权（同上游 bb）：capability 是 join code 本身，脚本
  不承载任何秘密。
- 删除机器（Machines 页 Remove）只软删行 + 关会话；共享 hostKey 不吊销——幽灵
  重连不复活行、不再列出，凭据收口同样等 M1（#195 S4 记档）。
- 对话框底注 "This installs bb…" 是钉版 SPA 的上游文案；本部署装的是 cap-daemon
  （同协议、不同发行形态），以本文为准。
