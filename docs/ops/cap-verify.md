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
