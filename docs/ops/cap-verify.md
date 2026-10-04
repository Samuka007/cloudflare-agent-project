# cap-verify 远端 NixOS 事实底（PVE CT141）运维记录

2026-10-04 落地记录（#166）。远端 appliance 是 CAP verify 梯的反应面：后续部署票
的 `nixos-rebuild --target-host` 实机。本文件是 PVE 侧无 git 面的事实版本源；
宿主配置真身在 nix-personal-config-test 仓（见下）。

## 链路

```
workstation (NixOS WSL, ~/workspace/nix-personal-config-test)
  --build-host nixos-pve (CT119 pve-nixos, 192.168.1.119, 暖 store)-->
    nixos-rebuild switch --flake .#cap-verify --target-host root@192.168.1.141
      → CT141 只收闭包 + switch（thin-consumer，红线：CT 内不做 NixOS 评估/构建）
```

## CT141 参数（pct config 141 原文）

| 项 | 值 |
| --- | --- |
| VMID / hostname | 141 / cap-verify |
| 配额 | 2 cores / 4096 MB / swap 512 / rootfs 40G（local-lvm thin `vm-141-disk-0`） |
| net0 | veth@vmbr0，静态 `192.168.1.141/24`，gw `192.168.1.1` |
| features | `nesting=1`（systemd ≥257 ImportCredential 必需，warpgate CT140 同款教训） |
| 特权 | 未加 `--unprivileged`（与 CT140 相同宿主默认；wiki 已验证路径） |
| onboot / ostype | 1 / nixos |
| 系统 | NixOS 26.11.20260929.b4fd65b (Zokor)，stateVersion 26.11 |

## 宿主配置（nix-personal-config-test 仓）

- `hosts/nixos/cap-verify/default.nix`，commit `21c16a2`（"cap-verify: add CT141
  verify-ladder appliance host (#166)"）。discovery 自动挂 `nixosConfigurations.cap-verify`。
- root 授权键 = `modules/shared/ssh-keys.nix` 声明式清单（落在
  `/etc/ssh/authorized_keys.d/root`，`~/.ssh/authorized_keys` 是陈旧手工文件，别查错地方）；
  sshd :22，PasswordAuthentication off。
- 最小工具链：git（nix-core 共享）+ nodejs_22；node/pnpm 其余全部由 CAP 仓 flake 的
  `nix develop` 按需进 store（nixos-25.05 input，nodejs_22 + pnpm_10）。
- **origin push 现状**：远端 `samuka@100.64.0.83:~/nix-personal-config-test` 是
  minisforum 活工作区（main 有未提交改动，updateInstead 拒收）。commit 已备份为
  origin 分支 `lane/166-cap-verify`；等那台工作区收干净后再 fast-forward main。

## 一次性建机（已完成 2026-10-04，重建设才需要）

镜像在 CT119 构建（勿在 CT141 内构建）：

```bash
rsync -a --delete --exclude .git ~/workspace/nix-personal-config-test/ \
  samuka@nixos-pve:~/nix-personal-config-test/
ssh samuka@nixos-pve 'cd ~/nix-personal-config-test && \
  nix build .#nixosConfigurations.cap-verify.config.system.build.images.proxmox-lxc \
  --out-link ~/result-cap-verify'
```

CT119→PVE 宿主无 ssh 信任，tarball 经工作站中转（本次 323,360,612 B，
sha256 `cca19bf6…ac43ea` 三端一致）：

```bash
ssh samuka@nixos-pve 'cat ~/result-cap-verify/tarball/<tarball>.tar.xz' > /tmp/cap-verify-image.tar.xz
scp /tmp/cap-verify-image.tar.xz root@192.168.1.107:/var/lib/vz/template/cache/nixos-cap-verify-<ver>.tar.xz
```

pct create（**lvmthin 陷阱**：显式 `--rootfs local-lvm:vm-141-disk-0,size=40G` 报
`no such logical volume`；必须 size-only 让 PVE 自命名）：

```bash
pct create 141 /var/lib/vz/template/cache/nixos-cap-verify-<ver>.tar.xz \
  --hostname cap-verify --cores 2 --memory 4096 --swap 512 \
  --rootfs local-lvm:40 \
  --net0 name=eth0,bridge=vmbr0,gw=192.168.1.1,ip=192.168.1.141/24,type=veth \
  --features nesting=1 --onboot 1 --ostype nixos --start
```

销毁重建：`pct destroy 141` 后重跑以上两步（先 `pct unmount`/`pct unlock` 清锁）。

## 日常重建（配置变更）

workstation 上改 `hosts/nixos/cap-verify/default.nix` + commit，然后 rsync 到 CT119
（同上）并：

```bash
cd ~/workspace/nix-personal-config-test
nixos-rebuild switch --flake .#cap-verify --target-host root@192.168.1.141 --build-host nixos-pve
```

root 目标，无需 `--use-remote-sudo`。socket 单元改动 switch 不重启（sshd.socket 等），
必要时 `systemctl restart <socket>`。

## CAP 仓读取（deploy key）

- 只读 deploy key `cap-verify-readonly`（ed25519，GitHub deploy key ID 165354055，
  read-only；随创建它的 gh token 授权吊销而消失）。私钥工作站 `~/.ssh/cap_verify_deploy`，
  CT 内 `/root/.ssh/cap_verify_deploy`（600）+ `/root/.ssh/config` 钉
  `Host github.com → IdentityFile`。
- CT 内 github.com:22 / cache.nixos.org:443 直连可达（2026-10-04 实测）。
- 克隆：`git clone git@github.com:Samuka007/cloudflare-agent-project.git /root/cap`
  （`bb` 子模块不需要——eslint ignores `bb/**`，typecheck/test 全部 workspace 包）。

## verify 梯（复验命令）

```bash
ssh root@192.168.1.141
cd /root/cap && git pull --ff-only
nix develop -c bash -c 'pnpm install --frozen-lockfile'
nix develop -c bash -c 'NODE_OPTIONS=--max-old-space-size=3584 pnpm lint'
nix develop -c bash -c 'pnpm typecheck'
nix develop -c bash -c 'pnpm test'
```

### 首次落地证据（2026-10-04，repo @ main `2ffbbf8`，CT141 26.11.20260929）

- `pnpm install --frozen-lockfile` → exit 0
- `pnpm typecheck` → exit 0（7 个 workspace 包，零 error）
- `pnpm test`（vitest，7 包）→ exit 0：**449 passed / 4 skipped**（453 tests），
  62 test files —— protocol 9、scripts 39+1skip、daemon-worker 36、daemon-service 49、
  agent-do 211+1skip、provider-app 22、server-worker 83+2skip
- `pnpm lint` → exit 0，**但必须 `NODE_OPTIONS=--max-old-space-size=3584`**：
  默认 V8 堆（~2GB）在 eslint type-aware 全仓跑 OOM（exit 134，
  `Ineffective mark-compacts near heap limit`）；4G 配额下 3.5G 堆 92s 跑完。
  CI（7G runner）不受影响，无需改 package.json。
- `systemctl is-system-running` = running，无 failed unit；`ss -tln` 仅 ：22 业务口。

## 注意

- CT141 配额 2C/4G/40G 是 thin-consumer 红线的一部分（map #162 用户裁决）；让它在
  CT 内跑 nix build / 评估 NixOS 主机配置 = 票面违例。`nix develop` 消费 dev shell
  属验收明确要求，不在违例面。
- local-lvm thin pool 已 96.6% 超分（house 全局已知态）；pct create 的
  thin overcommit WARNING 属预期噪音。
- vitest 的 workers pool 在 LXC 内靠 nesting=1 才能起 workerd；agent-do 的
  smoke-real-model 无 `.dev.vars` 时自跳过（fresh clone 干净跑通的原因）。

## Appendix: daemon 闭包打包与部署（#176，2026-10-04）

### 产物

- flake output：`packages.x86_64-linux.daemon` —— **wrapper 闭包**形态：
  nixpkgs-unstable bun（1.4.2；25.05 的 1.2.x 不满足 omp 18.6.0 的 engines
  `bun>=1.3.14`）+ TS 源码直跑 + `pnpm --filter '@cap/daemon-service...'` 的
  offline prod node_modules 子图 + pi-natives 原生 addon。
  **不是** `bun build --compile`：编译产物在 NixOS 上 SIGSEGV（构建本机
  hello-world 即崩，2026-10-04 实测），目标机 CT141 是 NixOS，wrapper 是唯一
  双端可跑形态（选型理由入 PR）。
- 闭包尺寸（`nix path-info -Sh`）：**582.2 MiB / 13 store paths**
  （cap-verify 端到端验收时记录；repo @ lane/176-daemon-pkg 打包 diff）。
  闭包自查要点：`node_modules/.modules.yaml` 内嵌 fetch store 路径会把 ~3.5G
  的 `pnpmDeps` 拖进闭包（installPhase 已 `rm`）；wrapper 经 makeWrapper
  烙印本输出路径（`placeholder "out"` 在 writeShellScript 子 derivation 内
  会解析成脚本自身路径，曾致旧输出被拖入闭包，4.8G→582M 的两个教训）。
- 体积治理：按"daemon 从不 import"物理剪除 omp 可选依赖子图
  （onnxruntime-node/web、@huggingface/transformers、sharp/libvips、
  lucide-react、chromium-bidi、react 系、sherpa-onnx），dangling symlink 一并
  清除（fixup 的 noBrokenSymlinks 门禁会拒绝有意 dangle）。
  **保留 `@oh-my-pi/pi-catalog`**：omp task settings 在 client boot 即急切
  import（2026-10-04 实测缺它启动即死）。pi-natives 只带 x86-64 **baseline**
  变体（全 x86-64 可跑；AVX2 机损失原生 grep 类速度，不损失功能——loader 候选
  列表自动回落）。被剪包如未来被 import，启动会响亮失败，staging smoke 把门。
- bin 面：
  - `cap-daemon [--version] [--url U] [--dataDir D] [--sandbox S]` —— env：
    `DAEMON_SERVICE_URL`、`DAEMON_ENROLL_KEY`（**必填**，无 dev 缺省）、
    `DAEMON_DATA_DIR`（缺省 `~/.local/state/cap-daemon`）、
    `DAEMON_SANDBOX_ROOT`（缺省 `/tmp/cap-sandbox`）。
  - `cap-daemon-smoke --url U [--dataDir D | --hostKey K]` —— staging 工具
    回环驱动：poll `/agent/session` → `POST /agent/dispatch`（bash，走客户端
    内嵌 omp tool host，T9 #99）→ 轮询 `/agent/journal` 的 exited op
    （exit 0 + 输出含 marker）→ `/agent/unacked` + `POST /agent/ack` 收口。
    鉴权用 daemon 自己 dataDir 里 0600 的 auth.json。

### env 改名清单（POC_* → 正式命名）

| 旧（POC） | 新（正式） | 缺省变化 |
| --- | --- | --- |
| `POC_SERVICE_URL` | `DAEMON_SERVICE_URL` | 不变（`http://127.0.0.1:8790`） |
| `POC_DAEMON_DATA` | `DAEMON_DATA_DIR` | `/tmp/poc-daemon-data` → `~/.local/state/cap-daemon`（identity 不再随 /tmp 清理而丢、静默重注册） |
| `POC_SANDBOX_ROOT` | `DAEMON_SANDBOX_ROOT` | `/tmp/poc-sandbox` → `/tmp/cap-sandbox`；executor 传给子进程的同名 env 一并更名 |
| `POC_ENROLL_KEY` | `DAEMON_ENROLL_KEY` | **dev 缺省 `[REDACTED-staging-secret]` 移除**——未设置即启动失败（fail-closed；研究文档 U3 缺口里点名的安全隐患） |
| `POC_DAEMON_MARKER` | `DAEMON_EXEC_MARKER` | executor 子进程孤儿标记（exec.kill 名单 / 本地 smoke 用） |
| `POC_EXECUTION_ID` | `DAEMON_EXECUTION_ID` | 同上 |

消费点同步更名：`scripts/poc-full-chain.ts`、
`packages/daemon-service/scripts/poc-smoke-service.ts`（spawner 与 /proc 扫描）。
`.staging-daemon.env`（gitignore 凭据引用）已换新键。

### 通道 A 部署（workstation → CT141）

```bash
cd <repo worktree>
nix build .#daemon --print-out-paths          # 本机构建闭包
nix copy --to ssh://root@192.168.1.141 "$(nix build .#daemon --print-out-paths)"
scp -o 600 .staging-daemon.env root@192.168.1.141:/root/.staging-daemon.env
```

CT 内以 transient unit 常驻（staging 是单 host 身份 `hostId=local`——本机与
CT 同时跑会互抢会话，二选一）：

```bash
ssh root@192.168.1.141 'systemctl stop cap-daemon-staging 2>/dev/null; \
  systemd-run --unit=cap-daemon-staging \
    -p EnvironmentFile=/root/.staging-daemon.env -p Restart=on-failure \
    <out>/bin/cap-daemon'
```

冒烟（CT 内跑，回环证据 = journal exited op 的 exit 0 + marker 输出；亦可用
`journalctl -u cap-daemon-staging` 看 client log）：

```bash
ssh root@192.168.1.141 'set -a; . /root/.staging-daemon.env; set +a; <out>/bin/cap-daemon-smoke'
```

### 首次落地证据（2026-10-04，CT141）

- `nix copy` 推送 4 条路径（bun-1.4.2 + 两个 wrapper inner 脚本 + 包本体），
  LAN 数秒；CT 侧包本体占盘 498M，rootfs 40G 用 15%（5.4G）。
- `systemd-run --unit=cap-daemon-staging`（EnvironmentFile=/root/.staging-daemon.env，
  Restart=on-failure）启动：client log（journalctl）依次 `boot` →
  `native addon gate: current`（baseline addon 在 CT 加载成功）→
  `enrolled as hostId=local (credentials persisted 0600)` → `session.ready` →
  `sync.complete generation=1`。
- `cap-daemon-smoke`（CT 内执行）：executionId `thr_stg_smoke_muu3jkgj:1` ——
  session live（bootId=7349f023…，CT 自己的 boot）→ `dispatch accepted (tool=bash)`
  → exited op `status=ok exitCode=0`，输出含 `cap-verify-smoke-ok-muu3jkgj x86_64`
  → result acked at journal seq 198 → PASS。CT 侧 journal 交叉证据：
  `tool thr_stg_smoke_muu3jkgj:1 acc…`（接单）与 `forget thr_stg_smoke_muu3jkgj:1`
  （ack 后缓冲丢弃，§3.5 收口）——回环确实发生在 CT 上。

### 运维教训（本轮实测）

- **staging 是单 host 身份（hostId=local，服务端 env 决定）**：同一部署同时跑
  两个 daemon 会互踢会话（client log `ws closed (code 1000: replaced)` 死循环，
  冒烟结果落在"最后连上者"身上）。首次 CT 冒烟就踩了：workstation 残留 daemon
  抢走 session，导致第一轮 PASS 实际执行在 workstation——kill 残留、确认
  smoke 报告的 bootId 与 CT 单元 journal 的 boot 一致后才算数。**判据：smoke 的
  `session live: … bootId=` 必须等于目标机 client journal 里的 boot id。**
