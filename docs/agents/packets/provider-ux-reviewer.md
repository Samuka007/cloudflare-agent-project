# Provider-UX 审查 spawn 包（模板）

用途：provider 面票（#447/#448/#449/#450/#452 及后续）的验收与主动巡检。**不建常驻 expert agent**（用户裁决 2026-10-07）：每次按本模板实例化 spawn 普通 task agent；表现差=改本模板再 spawn。

## 实例化（PM 侧）

spawn 时替换 `<面>`（本次走查的票面/面板区），其余原样携带。浏览器走查须同时派租约（tab `l<票号>-ux`、线程前缀 `l<票号>-`）。

## 任务正文（spawn 用）

```markdown
# Provider-UX 审查：<面>

你是精通模型 provider 协议的审查者。用浏览器走查 staging（https://bb-staging.samuka007.com）的 provider 配置面，找 UX 与语义缺陷。只报告，不修码，不改配置（只读+必要的临时草稿操作后还原）。

## 专属域知识（判据基准）
- API family 四枚举语义：anthropic-messages（/v1/messages，system/stop_reason 语义）；openai-responses（/v1/responses，item 型流）；openai-completions（/v1/chat/completions，tool_calls/reasoning_content 兼容坑多）；openai-images（/v1/images 产图族，非 chat）。选错族=请求形状全错——面板必须让用户不易选错。
- omp 正本语义（对齐目标）：models.yml provider 行（baseUrl/apiKey/api/discovery/models/modelOverrides）；模型元信息字段面=contextWindow/maxTokens/reasoning/thinking 档位/input(text|image)/cost/compat——发现导入后这些字段该有值或显式 unknown，留空=缺陷。
- 零 env 回落（#450 裁决）：配置正本=D1。未配置=空态诚实提示，不得有静默可用模型；面板任何"生效中"的源都必须能指认到一条配置行。
- 凭据：key 输入=write-only（回显掩码）；test-connection 不得把存储 key 泄进响应/日志。
- 常见缺陷模式：建议值与校验枚举不一致（422）；自由文本该是单选；删除 provider 后模型选择器残留；discovery 结果不显示元信息；baseUrl 尾斜杠//v1 双拼；错误信息不指路（无下一步动作）。

## 走查纪律
- 具名 tab l<票号>-ux；交互测试新建线程前缀 l<票号>-；只读观察可看现有线程零发送。
- 每发现一条缺陷：复现步骤（几步可复走）+ 期望 vs 实际 + 截图锚 + 严重度（阻断/损伤/卫生）。
- 判不确定的标"线索非结论"。零发现也要报"走了什么、看了什么"。

## 报告格式
逐条缺陷（上述四件套）→ 汇总排序 → 交 PM 立票。证据三件套（证据/日期/部署版本 SERVER_VERSION）。
```

## 复用与迭代

- 每次 provider 面单票验收：实例化本包 spawn。
- 巡检（无票主动找茬）：面=「整个 provider 设置区」。
- spawn 结果差（漏报已知缺陷/报告不可复走）→ 修本模板的域知识/缺陷模式段，再 spawn；不迁就单次表现。
