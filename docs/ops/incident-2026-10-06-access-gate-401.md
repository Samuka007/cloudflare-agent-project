# 事故记录：bb-staging Access gate 401 三段链（2026-10-06 晚）

状态：已修复（#438/#439/#440 打点，#442 终修）。本文为正本复盘，会话无关。

## 面向与症状

- 面向：https://bb-staging.samuka007.com `/api/v1/*`（worker 侧 accessGate，#411 部署后首次真实流量）
- 症状演进：全 500 → 401（服务令牌路径）；**用户浏览器 SPA 全程正常**（身份令牌路径）——这个分裂是定位的钥匙

## 三段根因链（每段一轮打点实证，非推理）

1. **500 段**：`ACCESS_TEAM_DOMAIN` secret 存了裸域名（无 scheme），`fetchJwks` 拼出
   `samuka007.cloudflareaccess.com/cdn-cgi/access/certs` 非法 URL → gate 覆盖面全 500。
   tail 栈：`TypeError: Invalid URL`。
   修：secret 补 scheme（运维）+ `requireTeamDomain` 归一化（#438，裸域名补 https://、尾斜杠剥除）。
   教训：**正典形态写进文档**（TEAM_DOMAIN 必须 `https://<team>.cloudflareaccess.com`），代码对两种形态都合法化。

2. **401 段（verify 级）**：#439 打点解码 aud/exp/iss——三者全对、与 allowed 一致，仍拒。
   排除法收窄到签名或 claims 解析（后者在签名之后）。

3. **401 终因（claims-parse 段）**：#440 分级打点命中 `stage: claims-parse`——
   **服务令牌 JWT 带空 `sub`**（无身份设计），旧 schema `z.string().min(1)` 拒 present-but-empty。
   浏览器身份令牌（sub 非空 email）全过——与观测分裂完全吻合。
   修（#442）：identity 字段（sub/email）optional 且容空串——**安全严格字段是 aud/exp/签名，不是身份在场**；
   principal 链 `??`→真值判断（空 sub 不得成为 principal，落 sha256 digest）；
   回归测试钉死空 sub 形状。

## 方法论（可复用）

- **打点分级定位 > 假设链推理**：三轮打点各一段真相（URL→claims 值→stage），每轮假设空间收窄一次。
  仪器最终形态留在 `access.ts`（拒绝原因+stage+aud/exp/iss 对照，非敏感声明，不落 token 材料）。
- **工具链陷阱**：`gh pr checks --watch; gh pr merge` 组合在 watch 以 fail 退出后 **merge 仍执行**——
  #437/#440 两次带红进 main。merge 前必须显式查 PR state。
- **凭据转录**：从截断显示拼凭据=幻觉注入（曾把 client_id 尾巴拼错→unknown Client ID→302 无日志）。
  凭据文件必须内核直写/完整重定向。

## 关联

- 票：#411（gate fail-closed）/#437（cloud 主位，曾带 lint 错进 main）/#438/#439/#440/#442
- Access 面收敛背景：单 root app（见 #412 comment）；残留清理 #435
- 打点日志退役/降噪（#435 裁定 2026-10-07）：**保留现形态**——打点全部落在拒绝
  路径（放行零开销），三段链定位刚刚证明其价值；非敏感声明（aud/exp/iss/stage）、
  不落 token 材料的红线不变。退役复评留待 gate 稳定一季后。
