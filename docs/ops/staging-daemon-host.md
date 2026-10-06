# staging 常驻宿主——PVE LXC `lxc-stg-01`（CT142）运维记录

2026-10-06 落地（#378）。staging 的执行宿主从 CT141（cap-verify）上的 transient
`systemd-run` 单元（幽灵身份 `local`，#377 拔除后的残余）迁移到专用 appliance
CT142：daemon client 以**声明式 systemd service 常驻**（`Restart=always`），
身份走 #258 join-code 一次性码 enroll，真实机器身份非 `local`。宿主配置真身在
nix-personal-config-test 仓（house flake，CT140 warpgate 模子）；本文件是板面
与 handoff 的事实正本。

## 链路

```
CT142 (lxc-stg-01, 192.168.1.142, house flake hosts/nixos/lxc-stg-01)
  -- cap-daemon systemd service, Restart=always, 出站 WS/HTTPS only -->
    cap-server-staging.dai-samuel.workers.dev  (staging worker, D1 hosts 表)

workstation (NixOS WSL, ~/workspace/nix-personal-config-test)
  --build-host nixos-pve (CT119, 192.168.1.119, 暖 store)-->
    nixos-rebuild switch --flake .#lxc-stg-01 --target-host root@192.168.1.142
      → CT142 只收闭包 + switch（thin-consumer，红线：CT 内不评估/构建）
```

WSL/工作站不参与运行面：daemon 在 CT142 上，工具 turn 的执行环是
浏览器/API → CF edge → CT142（出站 WS 回环）。WSL 关机不影响 staging。

## CT142 参数（pct config 142 原文）

| 项 | 值 |
| --- | --- |
| VMID / hostname | 142 / `lxc-stg-01`（= hosts 表 name，enroll 时自报） |
| 配额 | 2 cores / 2048 MB / swap 512 / rootfs 20G（local-lvm thin） |
| net0 | veth@vmbr0，静态 `192.168.1.142/24`，gw `192.168.1.1` |
| features | `nesting=1`（systemd ≥257 ImportCredential 必需，CT140/141 同款教训） |
| 特权 | 未加 `--unprivileged`（本宿主 pct 默认路径，wiki 已验证） |
| onboot / ostype | 1 / nixos |
| 系统 | NixOS 26.11，stateVersion 26.11 |

## 身份（bb 语义，非 local）

- **enroll 走 join-code（#258 一次性码）**：`POST /api/v1/hosts/join-codes`
  铸一次性 15 分钟码；daemon 首启以 `DAEMON_JOIN_CODE` 兑换身份。
- **hostId 服务端铸造**（`host_<suffix>`，bb byte-compat）——daemon 永不
  自报身份（bb machine-auth 语义：key 元数据决定身份）。票面「hostId 如
  lxc-stg-01」落地为：**hostId=铸码产物，name=hostname `lxc-stg-01`**
  （hosts 表按 enroll 自报 hostname 命名，等价于 Add-a-machine 对话框的
  机器名）。身份持久化在 CT 内 `/var/lib/cap-daemon/data/`
  （`host-id` + `auth.json`，0600）。
- 票面裁决（#377 先行已合）：env-key 不再塌缩部署身份；幽灵 `local` 行由
  本票收尾（CT141 daemon 退役 + ghost 行删除，见下「cutover 记录」）。

## 宿主配置（nix-personal-config-test 仓）

- `hosts/nixos/lxc-stg-01/default.nix`：common.nix + proxmox-lxc.nix，
  `manageNetwork = false`（PVE net0 供静态 IP），sshd :22 only，root 授权
  键 = `modules/shared/ssh-keys.nix` 声明式清单（落在
  `/etc/ssh/authorized_keys.d/root`；`~/.ssh/authorized_keys` 是陈旧手工
  文件，别查错地方）。
- **daemon systemd 单元**（声明式，非 transient）：
  `ExecStart=${inputs.cap.packages.x86_64-linux.daemon}/bin/cap-daemon`、
  `EnvironmentFile=/var/lib/cap-daemon/staging-daemon.env`、
  **`Restart=always`**（RestartSec 5）、`wantedBy=multi-user.target`。
  dataDir=`/var/lib/cap-daemon/data`（env 文件指定），无额外沙箱 hardening
  （工具 shell 需宿主 profile PATH——#254 wrapper 已注入
  `/run/current-system/sw/bin`——与 /tmp sandbox、出站网络）。
- **cap flake input**：`github:Samuka007/cloudflare-agent-project/...`，锁
  在 lane 分支 rev（PR 合并后 `nix flake update cap` 切回 main）。daemon
  更新 = CAP 仓合入后 house 仓更新锁 + CT119 rebuild；CT142 永不自行构建。
- house 仓提交位置（2026-10-06）：workstation 本地 `main`
  （`e090d5f` 建机 + `04b5359` 单元简化 + `6954062`/`3aa9755` cap 锁
  两跳）；origin（minisforum 100.64.0.83）连接超时未推——cap-verify
  （CT141）同款先例：workstation 工作区即构建源，origin push 待那台
  工作区可达后补推 `lane/378-lxc-stg-01`。
- 凭据**永不进镜像/flake**：`/var/lib/cap-daemon/staging-daemon.env`
  （root 0600，scp 推送，gitignore 仓外物）。首启含 `DAEMON_JOIN_CODE`，
  enroll 成功后即剥除（码一次性，留着只会在 dataDir 丢失时产生 401 死循环）。

## 一次性建机（已完成 2026-10-06，重建设才需要）

镜像在 CT119 构建（勿在 CT142 内构建）：

```bash
rsync -a --delete --exclude .git ~/workspace/nix-personal-config-test/ \
  samuka@nixos-pve:~/nix-personal-config-test/
ssh samuka@nixos-pve 'cd ~/nix-personal-config-test && \
  nix build .#nixosConfigurations.lxc-stg-01.config.system.build.images.proxmox-lxc \
  --out-link ~/result-lxc-stg-01'
```

tarball 经工作站中转到 PVE 宿主（CT119→PVE 无 ssh 信任，cap-verify 同款）：

```bash
ssh samuka@nixos-pve 'cat ~/result-lxc-stg-01/tarball/<tarball>.tar.xz' > /tmp/lxc-stg-01.tar.xz
scp /tmp/lxc-stg-01.tar.xz root@192.168.1.107:/var/lib/vz/template/cache/nixos-lxc-stg-01-<ver>.tar.xz
```

pct create（**lvmthin 陷阱**：size-only 让 PVE 自命名；nesting=1 必带）：

```bash
pct create 142 /var/lib/vz/template/cache/nixos-lxc-stg-01-<ver>.tar.xz \
  --hostname lxc-stg-01 --cores 2 --memory 2048 --swap 512 \
  --rootfs local-lvm:20 \
  --net0 name=eth0,bridge=vmbr0,gw=192.168.1.1,ip=192.168.1.142/24,type=veth \
  --features nesting=1 --onboot 1 --ostype nixos --start
```

enroll（铸码→推 env→等 session.ready→剥码）：

```bash
curl -fsS -X POST https://cap-server-staging.dai-samuel.workers.dev/api/v1/hosts/join-codes \
  -H 'content-type: application/json' -d '{}'
# → {joinCode, hostId, expiresAt}；15 分钟一次性

cat > /tmp/staging-daemon.env <<'EOF'
DAEMON_SERVICE_URL=https://cap-server-staging.dai-samuel.workers.dev
DAEMON_JOIN_CODE=<code>
DAEMON_DATA_DIR=/var/lib/cap-daemon/data
DAEMON_SANDBOX_ROOT=/tmp/cap-sandbox
EOF
scp /tmp/staging-daemon.env root@192.168.1.142:/var/lib/cap-daemon/staging-daemon.env
ssh root@192.168.1.142 'chmod 600 /var/lib/cap-daemon/staging-daemon.env && \
  journalctl -u cap-daemon --no-pager | tail -20'
# journal 依次：boot → native addon gate → enrolled as hostId=host_xxx →
# session.ready → sync.complete generation=1
```

enroll 成功后**剥除 join code**（编辑 env 文件删 `DAEMON_JOIN_CODE` 行）并
`systemctl restart cap-daemon`——常驻进程复用 dataDir 身份，不重铸。

## 日常重建（daemon 更新 / 配置变更）

```bash
# CAP 仓合入 main 后：house 仓更新锁
cd ~/workspace/nix-personal-config-test && nix flake update cap
rsync -a --delete --exclude .git ~/workspace/nix-personal-config-test/ \
  samuka@nixos-pve:~/nix-personal-config-test/
nixos-rebuild switch --flake .#lxc-stg-01 \
  --target-host root@192.168.1.142 --build-host nixos-pve
# switch 会 restart cap-daemon 单元；WS 连接闪断自动重连（backoff）
```

## 冒烟（工具 turn 回环，#254 marker 门）

smoke 与 daemon wrapper 同闭包（从 systemd unit 的 ExecStart 运行时解析，
不记 store 路径）。CT142 上已放置 `/root/ct142-smoke.sh`，内容：

```sh
#!/usr/bin/env sh
set -eu
. /var/lib/cap-daemon/staging-daemon.env
bin=$(systemctl cat cap-daemon | sed -n 's/^ExecStart=//p')
smoke="${bin%bin/cap-daemon}bin/cap-daemon-smoke"
exec "$smoke" --url "$DAEMON_SERVICE_URL" --dataDir "$DAEMON_DATA_DIR" \
  --command 'hostname && uname -m && nix --version && id -un'
```

```bash
ssh root@192.168.1.142 'sh /root/ct142-smoke.sh'
```

判据（cap-verify 教训）：smoke 报告的 `session live: … bootId=` 必须等于
CT142 `journalctl -u cap-daemon` 的 boot id——回环确实落在 CT142 上，
不是同身份的别机进程。注意 switch/reboot 后 daemon 重连的窗口里
dispatch 可能瞬时 `host_offline`（旧 DO 会话视图未落新 socket），等几秒重跑。

## cutover 记录（2026-10-06，本票收尾动作）

1. CT142 enroll 完成、`/hosts` 见 `lxc-stg-01` connected（证据见下）。
2. CT141 老 daemon 退役：`ssh root@192.168.1.141 'systemctl stop
   cap-daemon-staging; systemctl reset-failed cap-daemon-staging'`——CT141
   回归纯 verify-ladder 用途；其 dataDir 的 `local` 身份不再上线
   （cap-verify.md 的 staging 段落自此作废，以本文件为准）。
3. 幽灵行清理（staging `/api/v1/hosts` DELETE）：`local`（CT141 残余）、
   `host_6je2m3mn5u`、`host_z7zsq4g7sn`（#377 测试期 env-key 铸码的孤儿
   机）——bb primary 保护在 CT142 connected 后放行。删除只软删行，共享
   hostKey 不吊销（M1 key registry 收口，#195 S4 记档）。

## 注意

- CT142 配额 2C/2G/20G 是 thin-consumer 红线：CT 内跑 `nix build`/NixOS
  评估 = 票面违例；agent 工具 shell 里 `nix --version` 类**只读**命令属
  宿主工具消费，不在违例面（#254 边界同款）。
- `EnvironmentFile` 缺文件时单元 fail-loop（Restart=always + RestartSec 5）
  ——首次开机先推 env 文件再等 enroll，属预期序列而非故障。
- staging worker 每次 deploy 会闪断所有 daemon WS（`ws closed (code 1006)`
  → backoff 重连）；`Restart=always` 只管进程级，WS 级重连是 client 内建
  backoff，两者不要混淆。
- local-lvm thin pool 已 96.6% 超分（house 全局已知态）；pct create 的
  thin overcommit WARNING 属预期噪音。

## 首次落地证据（2026-10-06，#378 验收）

CAP 闭包链：lane 分支三提交——`022e480`（flake：剪除 agent-do 悬空
@cap/mcp 工作区链接；#350 引入的 noBrokenSymlinks 红灯，github:…#daemon
实机构建复现）、`cc1ca7b`（client：已 enroll 机器重启不再要求 enroll
凭据——凭据门移到 enroll 面，与 host-onboarding.md 第 4 步文档契约对齐；
无此修 CT142 剥 join code 即 crash loop 实测）、`205ef04`（smoke：补
/agent/unacked 与 /agent/ack 的 `?hostId=`——#377 显式目标机改造漏改的
两处，CT142 实跑 422 复现）。house flake `cap` 输入锁 `205ef04`，镜像
tarball `nixos-lxc-stg-01-26.11-20261006.tar.xz` sha256 `410aa6f9…55b66f`。

逐条验收：

1. **CT 上 daemon systemd 常驻在线（connected 稳定无 replaced）**——
   单元声明式（`/etc/systemd/system/cap-daemon.service`，enabled，
   `Restart=always`）；enroll journal `boot → native addon gate: current →
   enrolled as hostId=host_7xykdvxmdk → session.ready → sync.complete
   generation=1`；落地后 25 min 窗口 journal `replaced|code 1000` 计数
   **0**，`NRestarts=0`；`/api/v1/hosts` 终态**仅一行**
   `host_7xykdvxmdk / lxc-stg-01 / connected`（幽灵 `local`、
   `host_6je2m3mn5u`、`host_z7zsq4g7sn` 已 DELETE，见 cutover）。
2. **staging 工具 turn（bash）经 LXC 执行往返**——CT142 内
   `ct142-smoke.sh` 两轮 PASS（`thr_stg_smoke_muwiu4so`、
   `thr_stg_smoke_muwj2mio`）：`dispatch accepted (tool=bash)` →
   `roundtrip closed: exit 0`，输出 `lxc-stg-01 / x86_64 /
   nix (Nix) 2.34.8 / root / cap-verify-smoke-ok-…` →
   `result acked at journal seq 22/35`；smoke 报告 bootId 与 CT 单元
   journal 的 boot id 一致（回环在本机）。
3. **WSL 关机后 staging 仍可跑工具 turn**——运行面零 WSL 组件：daemon
   进程在 CT142（PVE 宿主，onboot=1），工具环 = 发起方 → CF edge →
   CT142 出站 WS。机器级证据：`pct reboot 142` 后 45 s 内无人值守恢复
   （`identity restored (hostId=host_7xykdvxmdk)` → `session.ready` →
   `sync.complete`，system profile 无回滚）；本轮 smoke 即自 CT142 发起，
   全程无工作站进程参与。终验（真实关 WSL 后从浏览器发 turn）留给 owner。

重建/更新路径亦实跑两轮（`nix flake update cap` + rsync + `nixos-rebuild
switch --build-host nixos-pve`），switch 后 daemon 凭 dataDir 身份秒级
回线——即「日常重建」一节的命令原样可用。
