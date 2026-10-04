# Staging 模型中转（newapi）运维记录

2026-10-04 事故与修复的不可变记录；面板侧变更无 git，此文件即版本源。

## 链路

```
agent DO (cap-server-staging)
  → https://newapi.samuka007.top/v1/messages   (Anthropic 协议, MODEL_RELAY_API_KEY)
    → channel 10 "zhipu-anthropic-native" (type 14, group svip)
      → https://open.bigmodel.cn/api/anthropic  (zhipu 原生 Anthropic 端点)
```

## 为什么有 channel 10（事故根因）

面板 v1.0.0-rc.25 的 oai_chat→Anthropic SSE 转换**必截断**（无 `message_stop`，全模型复现，
type-58 bifrost-bridge 渠道）。agent relay 是显式终止策略（缺 `message_stop` = 流断，永不视
作完成），因此一切经转换渠道的流式调用全部失败。channel 10 直连 zhipu 原生 Anthropic 端点，
零转换层，SSE 完整（实测 `message_stop` 收尾）。

## channel 10 参数（DB 直写，面板 UI 亦可见）

- name `zhipu-anthropic-native`，type 14（Anthropic），status enabled
- base_url `https://open.bigmodel.cn/api/anthropic`
- key = zhipu GLM Coding Plan key（与 repo .dev.vars 的 MODEL_RELAY_API_KEY 同源）
- models `glm-5.3-anth`；model_mapping `{"glm-5.3-anth":"glm-5.3"}`（公网名→上游真名）
- group `svip`（staging relay token 所属组），priority 10

## 相关 staging secret

- MODEL_RELAY_BASE_URL_ANTHROPIC=https://newapi.samuka007.top
- MODEL_RELAY_API_KEY=<newapi token，sk-bZ…，见 ~/.omp/agent/models.yml newapi provider>
- MODEL_RELAY_MODEL=glm-5.3-anth

## 注意

- `glm-5.3-anth` 仅 staging 消费；其它消费者继续走原渠道，不受影响
- 面板新渠道需 `podman restart new-api` 才进内存索引（rc.25 缓存陷阱）；重启约 20s 公网中断
- 面板升级若修复 type-58 转换截断，channel 10 可退役（保留无害）
- 面板宿主：worker 10.0.100.71（host-network 容器 new-api:3000 / PG 15432 root/new-api / redis 16379），
  公网经 lighthouse(43.139.31.220) rathole 隧道
