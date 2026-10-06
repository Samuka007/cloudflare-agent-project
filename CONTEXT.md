# CONTEXT — 域词汇表

本域三源分层：**形状**真理源=bb，**语义**真理源=omp，**平台缝**自裁（docs/engineering.md 元选型）。词汇冲突时以此表为准。

## 词汇

- **Thread（线程/会话）**：一段连续对话与其轨迹的载体。域内说"会话"而无修饰词时指 Thread。另有三个易混词必须带全称：**daemon 会话**（DaemonService 租约期连接）、**provider 会话**（上游模型侧会话）、**用户会话**（浏览器登录态）。
- **Bound Host（绑定宿主）**：thread 的工具执行宿主。轨迹数据（thread.created 时冻结，machineId 字段），重放即真值；重绑=显式 owner 事件，系统永不静默换宿主。
- **Host Execution（宿主执行）**：在绑定宿主上执行的工具调用（#70 分类的 host 类与 hybrid 类的宿主半边）。
- **Edge Execution（边缘执行）**：AgentDO 本地即可完成的工具调用（#70 分类的 edge 类，11/33）与一切模型调用。
- **Cloud Placeholder（云端占位机）**（#386，用户裁决 2026-10-06）：bb「必须有一台 machine」不变量的锚点——真实 hosts 行（`id='cloud'`，type `placeholder`，migration 0004 播种），携带空机器语义：永不 connected、永不心跳（daemon 缝保留该 id）、DELETE 拒绝（判词 "placeholder holds empty-machine semantics"）；默认绑定（无显式宿主/无项目默认源）落此，host 工具诚实答 host_offline。W6 云执行就位后同一行升格为真执行载体。
- **执行悬置（Execution Suspension）**：绑定宿主离线时对该 thread 的状态——**半停**语义（用户裁决 2026-10-04，#73）：消息可发、模型可回（纯聊天继续），Host Execution 被拒并以宿主离线占位结果诚实完成 turn；Edge Execution 不受影响。SPA 呈现词汇（#291，bb 形状）：turn 内＝占位 tool 行、恒无横幅（streaming-contract §9.3 行 1-3）；settled 后＝bb `host-reconnecting` runtime status → "Host disconnected. Waiting for reconnection..." 横幅 + 可排队 composer（`waiting-for-host` 永不发出——该面锁 composer，违反消息可发）。
- **Cloud-only Failover（纯云降级）**（future，未排期）：宿主不可达时 turn 降级为 Edge Execution 继续的形态（模型 + edge 类工具），Host Execution 悬置。执行悬置的进化候选。
- **会话可携带性（Session Portability）**（future，未排期）：thread 的绑定宿主迁移到另一台机器的能力。边缘轨迹天然可搬；宿主本地活状态（bash 现场/工作树/后台进程）物理不可搬。
