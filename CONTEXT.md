# CONTEXT — 域词汇表

本域三源分层：**形状**真理源=bb，**语义**真理源=omp，**平台缝**自裁（docs/engineering.md 元选型）。词汇冲突时以此表为准。

## 词汇

- **Thread（线程/会话）**：一段连续对话与其轨迹的载体。域内说"会话"而无修饰词时指 Thread。另有三个易混词必须带全称：**daemon 会话**（DaemonService 租约期连接）、**provider 会话**（上游模型侧会话）、**用户会话**（浏览器登录态）。
- **Bound Host（绑定宿主）**：thread 的工具执行宿主。轨迹数据（thread.created 时冻结，machineId 字段），重放即真值；重绑=显式 owner 事件，系统永不静默换宿主。
- **Host Execution（宿主执行）**：在绑定宿主上执行的工具调用（#70 分类的 host 类与 hybrid 类的宿主半边）。
- **Edge Execution（边缘执行）**：AgentDO 本地即可完成的工具调用（#70 分类的 edge 类，11/33）与一切模型调用。
- **Cloud Placeholder（云端占位机）**（#386，用户裁决 2026-10-06；#436 升格 primary）：bb「必须有一台 machine」不变量的锚点兼 fleet 的 primary machine——真实 hosts 行（`id='cloud'`，type `placeholder`，migration 0004 播种）。#436 起 hosts 面投影恒报 connected（虚拟 liveness：daemon 缝保留该 id，永不心跳、永无会话），primary 解析（/system/config 的 primaryHostId）服务器本体腿即此行——钉版 SPA 按上游 primary 语义把该行画成不可删（与服务端 DELETE 拒绝一致），真机全可删（200 一致）。默认绑定（无显式宿主/无项目默认源）落此；W6 前不可执行是设计：dispatch 到它诚实答 host_offline（默认即失败 → 用户显式改选真机，无专门拒绝面具）。W6 云执行就位后同一行升格为真执行载体。
- **执行悬置（Execution Suspension）**：绑定宿主离线时对该 thread 的状态——**半停**语义（用户裁决 2026-10-04，#73）：消息可发、模型可回（纯聊天继续），Host Execution 被拒并以宿主离线占位结果诚实完成 turn；Edge Execution 不受影响。占位结果契约（#454）：**未执行结果**（host 离线/占位机/unknown_host 等连接前拒绝）恒为结构化错误——journal `status:"error"` + `errorCode` + 人话 message（"tool not executed: bound host offline"，正本 `@cap/protocol` tool-results），exitCode 恒 null；模型面在全部三个 wire 面加 `[tool error <code>]` 标记（无 is_error 座位的 completions/responses 面靠标记承载失败语义，**永不以 exit-0 stdout 承载失败**）。SPA 呈现词汇（#291，bb 形状）：turn 内＝占位 tool 行、恒无横幅（streaming-contract §9.3 行 1-3）；settled 后＝bb `host-reconnecting` runtime status → "Host disconnected. Waiting for reconnection..." 横幅 + 可排队 composer（`waiting-for-host` 永不发出——该面锁 composer，违反消息可发）。
- **Cloud-only Failover（纯云降级）**（future，未排期）：宿主不可达时 turn 降级为 Edge Execution 继续的形态（模型 + edge 类工具），Host Execution 悬置。执行悬置的进化候选。
- **会话可携带性（Session Portability）**（future，未排期）：thread 的绑定宿主迁移到另一台机器的能力。边缘轨迹天然可搬；宿主本地活状态（bash 现场/工作树/后台进程）物理不可搬。

## 词汇：LLM Provider 族

- **Provider 行（Provider Config）**：一个上游模型服务的配置行——baseUrl、凭据、API family、模型表。正本=D1 `provider_configs`（**零 env 回落**，用户裁决 2026-10-07 #450：env 播种与回落路径全删，未配置=空态诚实，不静默供模型）。
- **API Family（协议族）**：provider 行的 wire 协议枚举，omp `api:` 值域对齐：`anthropic-messages`｜`openai-responses`｜`openai-completions`｜`openai-images`（单一真源=服务端契约；UI 为单选，#452）。
- **模型发现（Discovery）**：从上游 `/v1/models` 拉模型表并富化元信息。omp 正本=pi-catalog（bundled catalog+models.dev 运行时富化+引用回退）；元信息字段面=contextWindow/maxTokens/thinking/input/cost/reasoning/compat（#447 对齐中）。
- **产图源（Image Source）**：`generate_image` 的上游=API family 为 `openai-images` 的 provider 行，面板显式单选（#448；env 回落随 #450 删除）。
- **Web Search 引擎链（Engine Chain）**：web_search 的有序引擎表+per-engine key，正本=D1（#449；env 路径同删）。

## 词汇：机器与工作区族

- **Daemon 链**：bb spa → server-worker → provider-app relay（模型腿）→ AgentDO（turn 编排+事件日志）→ daemon-service DO（宿主租约/命令队列）→ daemon client（宿主机上的 Node 进程，内嵌 omp 工具运行时）。
- **Host（机器行）**：hosts 表的机器行——真机（daemon 注册，有会话可执行）或 Cloud Placeholder。thread 新建可直接选真机的 **local 工作区**（每机默认工作目录入口）。
- **Environment／Project Source（工作区行）**：host+path 的项目级工作区（bb 正名 project source；clone 或指向既有目录）。建面=`POST /projects/:id/sources`（bb 上游动线 ProjectMachineSetupDialog，#445 移植中）——未移植前**只有**每机 local 入口可用，项目级 clone/worktree 不可建。

## 词汇：工具结果语义族

- **工具结果两分**（#454）：**执行成功**=stdout/stderr/exit code 如实；**执行未发生**（host 离线/占位机/unknown_host）=结构化错误结果（isError+code+人话 message）。模型面永不以 exit-0 stdout 承载失败语义——占位/离线字符串混进成功输出会污染下游推理（实例：host_offline 被读成"沙箱主机名"）。
