# 工具执行管线（tool execution）

一次 tool_use 从模型到结果的完整路径的**单一正本**。四份上游：[control-plane-layer.md](control-plane-layer.md)（注册表/帧/设置的原设计）、[decomposition.md](decomposition.md)（模块边界）、[m15-ticket-set.md](../proposals/m15-ticket-set.md) §0（约束）、[omp-runtime-embedding.md](../research/omp-runtime-embedding.md)（spike 判决，2026-10-04 起生效）。

## 管线（高层）

```
模型 tool_use
  → AgentDO 回合循环：TOOL_REGISTRY 行校验（schema=omp verbatim，单 schema 权威）
  → 按 class 路由：
     edge  ── runEdgeTool（DO 本地执行器；journal 追加=DO storage 写，零 daemon）        [#91 已落地]
     host  ── 工具无关派发帧 {tool, arguments, executionId, machineId, timeoutMs}
               → DaemonService（租约会话）→ 宿主 daemon client（Bun）
               → 宿主执行器 = **嵌入的 omp 工具运行时**（vendored，spike #125 判决）
                 + 123 LoC 适配垫（executionId→toolCallId / content[]→output /
                   truncation→outputTruncated / onUpdate→ExecutionUpdate）
                 + native addon 版本钉死门禁（stale 拒启）
                 换引擎=推翻 M0 沙箱语义）；只 embed 其纯 TS 件               [#128 在做]
               bash：embed-with-shims（BashProbe 判决 #130——brush-core 17/17 真跑通，
     hybrid ─ 拆缝规则（分类表 §3.3）：控制/状态面归 AgentDO，执行体（fs/进程/natives）
               归 daemon——按工具逐个拆（task=编排 DO/隔离工作区 daemon）
  → 结果回灌：tool.result 落 journal（persist-then-wake），executionId 去重，
     驱逐重放语义不变（replay 一致性=每票 L1 断言）
```

wire 面：`tools:` 数组只从注册表行渲染（wireToolSet），intent 字段按行策略注入（omp injectIntentIntoSchema 逐字）。

## 不变量

1. **派发帧永久工具无关**——加工具零 daemon 协议变更；daemon 链不知道工具语义
2. **注册表=唯一 schema 权威**（编译期常量，零请求组装——实践 11）
3. **先日志后应用**；已提交部分流永不重放（#71）
4. 上游化：bb 面零改动（工具 wire 经 providerOwnsRuntimeSurface 透传——实践 10）
5. omp 运行时 vendoring 钉版本 + native 门禁；Settings.loadIsolated 隔离目录
6. **实验工具闸（omp 姿态，#150）**：think/context_notes/new_context/checkpoint/rewind 五件默认 **off**——#502 起闸源=**D1 `tool_capabilities` 单行 seat**（迁移 `0007_tool_capabilities.sql`，写面 `GET/PUT /api/v1/system/tool-capabilities`；行缺省=全 off；**零 env 回落**——`AGENT_DO_EXTERNAL_THINKING`/`AGENT_DO_CONTEXT_NOTES`/`AGENT_DO_CHECKPOINT` env 对已删除，见 provider-config-points.md §2 实验闸行；DO 经 `applyToolCapabilities` 于 `refreshProviderOverlay` 回合边界热应用）；B2 #322 增第六闸 `generate_image`——#448 起闸源=**产图源 seat**（D1 `image_source`，面板显式单选 openai-images provider 行；**零 env 回落**，#450 裁决——`AGENT_DO_GENERATE_IMAGE`/`AGENT_DO_IMAGE_SOURCE` env 对已删除，见 provider-config-points.md §2 产图行）；supportsExternalThinking 按模型判定（原生推理族拒绝，未知 model id 放行给闸）。**forceReasoningOff 钉死配对在 wire 判定**（#257 修正）：`anthropicRequestBody` 在 RENDERED 工具面——experimentalGates ∧ supportsExternalThinking 过滤后的 finalNames——实际含 `think` 时才 pin `thinking:{type:"disabled"}`（外部 CoT 与原生推理互斥=ToC 安全）；**DO 不从闸推导**——DO 不知 relay model id，闸开≠`think` 上 wire（glm-5.3 类原生推理模型被 supports() 滤掉时，原生 CoT 通路必须存活）；显式 `request.forceReasoningOff` 保留给上游决定配对的调用方。部署面 env：另 `DAEMON_TASK_ISOLATION`（#110 隔离后端）；judge 通道 env 已随 #523 退役——find 判相在 edge（线程 pinned selection 经 D1 `provider_configs` 正本链，find-protocol v1 候选载荷进 DO 折叠），宿主纯执行、零模型注册表。

## 状态（2026-10-04）

- edge 三件+注册表骨架：**已落地**（#91/PR #120）
- T2 wait（JobRegistry 接口）：#92 在跑
- host 嵌入运行时 bring-up：#128 在跑（关键路径——10 张激活票 gated 于它）
- T3 会话树（edge）：#93 在跑
- 波 5 工具（github/lsp/debug 等）：激活票，等 #128

历史注：嵌入路线是 spike #125 对"逐工具手工移植"的推翻（复用优先=实践 13；adapter 实测 123 LoC vs 15+ 工具各自重写）。
