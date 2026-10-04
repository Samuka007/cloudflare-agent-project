# omp 工具运行时整嵌 spike：daemon 客户端直接 import omp 工具的实证（M1.5 波次重构输入）

> 状态：**SPIKE 结论**（2026-10-04）。用户裁决 2026-10-04：「细节业务能复用的都复用，聪明的抄，不每个工具 write from scratch」。本 spike 用真实执行的代码回答：daemon 侧（宿主端）能否**整嵌** omp 工具运行时，而不是逐工具手抄第二正本。结论**重构 M1.5 波 2/5**。
>
> omp 锚点：`/home/nixos/workspace/oh-my-pi` @ `9b98865146`（v18.4.3-272，package 18.4.4）。上游相关考古见 [omp-engine-portability.md](./omp-engine-portability.md)（引擎层/loop 层结论仍有效，本文只做工具执行层的实证补充）。harness 与 adapter 源码随本 PR 入库：[spike/omp-runtime/](./spike/omp-runtime/)。

## 0. 结论速览

| 问题              | 结论                                                                                                                                                                                                                                                                                      |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1 import 面      | **极薄**：`Settings.loadIsolated({cwd})` + `{cwd, hasUI, settings, getSessionFile, getSessionSpawns}` 五件套即可构造可执行 read/glob/grep/write/edit 的 ToolSession；五工具全部经 omp 自家 `execute()` 路径跑通（Bun）                                                                    |
| Q2 pi-natives     | 预编译 `.node` 是 NAPI（二进制本身运行时无关），**omp 的 loader 脚本绑定 Bun**（`import.meta.dir`、`Bun.spawnSync` 优先）；Bun 下零改载入成功；纯 Node 需垫 loader。**checkout 自带的 .node 是陈旧版本（addon 15.5.6 vs package 18.4.4）**——版本钉死纪律是 embed 的前置条件               |
| Q3 adapter 缝     | **123 LoC**（`omp-tool-adapter.ts`，含 host 构造）：帧 `{tool, arguments, executionId, machineId, timeoutMs}` → `tool.execute(executionId, arguments, signal, onUpdate)` 一一对应，`AgentToolResult` → `ToolResultPayload` 纯投影；ok/error/unknown-tool/wrong-machine/timeout 全路径实测 |
| Q4 逐工具裁决     | read/glob/grep/write/edit/**find/github/lsp = embed**；bash = **保留我方执行体**（omp 是 brush-core 内嵌 shell，换引擎即换语义）；eval = **库级 vendor**（kernel 基建抄，tool 壳不抄）；ast_grep/ast_edit = **natives 直调 shim**；ida = skip                                             |
| Q5 Workers 边缘件 | 四个 edge 工具本体零 node/bun import，但闭包经 pi-utils/pi-tui barrel 拖入 Bun API 与 TUI 渲染——**edge 件维持 T1/T3 既定「schema 照抄 + DO 本地执行」，不做模块整嵌**（与分类表 §2.2 一致）                                                                                               |
| 运行时裁决        | **daemon 侧工具宿主进程跑 Bun**（omp 原生运行时，零垫片，全部已证）；daemon-service 现有 Node 代码与 Bun 兼容（纯 TS + node: API）。纯 Node 路线需三层垫（bun 模块 98 LoC 已证子集 + `bun:sqlite` 别名 + `import.meta.dir`/`type:"text"` loader）且是永久漂移面                           |

**对 M1.5 的一句判决**：波 2 的 T5–T8/T11 从「每票一个宿主执行体」塌缩为「**一次 host-runtime bring-up 票 + N 张薄激活票**」；T10 eval 从「自建内核」瘦身为「vendor omp 内核库」；波 5 的 T21/T22/T24 同理变薄。工时结构从「每工具一个上下文窗」变为「地基一窗 + 每工具小半窗（注册表行 + replay 断言）」。

## 1. Q1：import 面实测

harness：[spike/omp-runtime/harness.ts](./spike/omp-runtime/harness.ts)。import 对象是 omp checkout **源码**（omp 包发布形态即裸 TS，`main: ./src/index.ts`）：

```ts
import { Settings } from ".../packages/coding-agent/src/config/settings.ts";
import { GlobTool } from ".../packages/coding-agent/src/tools/glob.ts";
// grep / read / write 同理；edit 在 .../src/edit/index.ts
```

最小 ToolSession（全部必填项就这些，其余 100+ 字段全 optional）：

```ts
const settings = await Settings.loadIsolated({ cwd: fixture });
const session = {
  cwd: fixture,
  hasUI: false,
  settings,
  getSessionFile: () => null,
  getSessionSpawns: () => null,
} as never;
```

**Bun 实测结果**（真实 execute() 输出，截头）：

| 工具                         | 耗时 | 证据要点                                                                     |
| ---------------------------- | ---- | ---------------------------------------------------------------------------- |
| `glob **/*.ts`               | 11ms | napi `glob`；gitignore 命中以 `#` 前缀分组；details 含 truncation 元数据     |
| `grep GrepNeedle`            | 6ms  | Rust regex；`*行号` 标 match、上下文 hashline；details.fileMatches 结构化    |
| `read src/alpha.ts:2-5`      | 7ms  | hashline 编址 + `details.meta.source` 路径回显                               |
| `write harness-out/draft.md` | 5ms  | 落盘成功，details.resolvedPath                                               |
| `edit apply_patch`           | 6ms  | 真实 apply：文件被改，details.diff/firstChangedLine/snapshotsPruned 全量返回 |

失败模式同样有价值：传错参数（如把 replace 形状喂给 apply_patch 模式）返回**结构化 isError 结果 + 精确文案**（"The first line of the patch must be '*** Begin Patch'"），不是 throw——adapter 的 error 投影路径有真实输入可用。

注意点（实现票要抄进验收）：

- `edit.mode` 跟随 settings（本机用户配置是 apply_patch）；schema 变体（replace/hashline/patch/sloppy 五族）按模式门控。**注册表行必须把模式变体当作 settings 函数而非常量**（`bash.ts:618-622` 的 parameters getter 同理）。
- `Settings.loadIsolated` 会读用户全局配置——embedder 生产化时要显式隔离子目录（`PI_*`/agentDir override），否则宿主配置漂移会静默改变工具 schema/行为。
- `session.getSessionFile`/`getSessionSpawns` 是接口仅有的两个**非 optional** 方法，headless 传 `() => null` 即可。

## 2. Q2：pi-natives 实测

- 二进制：`packages/natives/native/pi_natives.linux-x64-modern.node`（NAPI，napi-rs 单 addon，与 omp-engine-portability §3.1 一致）。
- **Bun 载入成功**：18.6.0 安装版抽取的 addon 放进 checkout 后，`glob/grep/EditStore/EditSession/astGrep/astEdit/PtySession/Shell` 全部可用（fresh-process probe：[spike/omp-runtime/probe-natives.ts](./spike/omp-runtime/probe-natives.ts)）。
- **坑（必记）**：checkout 自带 `.node` 的 build stamp 是 **15.5.6**，落后 package 18.4.4，loader 虽容忍载入但 `EditStore`/`DesktopSession` 等 export 缺失（`missingNativeExport` 占位）→ import 期就崩（`adaptDesktopSession(undefined)` WeakMap 崩）。**embed 票必须有 native 版本钉死 + 载入期全符号自检**（`nativeAddonStatus().stale` 检查即现成钩子）。
- **纯 Node**：loader 脚本 `import.meta.dir`（loader-state.js:863）是 Bun-only，Node 下 `path.join(undefined)` 直接崩；另有 `Bun.spawnSync` 优先（有 Node fallback）。结论：`.node` 二进制本身 Node 能 dlopen（NAPI 语义），但 **omp 的 loader 需要 ~20 LoC 垫片或上游 PR**（`fileURLToPath(new URL("..", import.meta.url))` 替换 `import.meta.dir`）。跑 Bun 则全部免掉。

## 3. Q3：adapter 缝实测

源码：[spike/omp-runtime/omp-tool-adapter.ts](./spike/omp-runtime/omp-tool-adapter.ts)（**123 LoC**，含 host 构造 + 帧映射 + 超时/错误投影）。驱动：[spike/omp-runtime/run-adapter.ts](./spike/omp-runtime/run-adapter.ts)。

映射关系（一一对应，零语义发明）：

| 我方帧                      | omp 调用                         | 说明                                                     |
| --------------------------- | -------------------------------- | -------------------------------------------------------- |
| `frame.tool`                | `host.tools[frame.tool]`         | 注册表查名；miss → `{status:"error"}`                    |
| `frame.executionId`         | `tool.execute(toolCallId, …)`    | omp 的 toolCallId 就是我方 executionId，透传             |
| `frame.arguments`           | `params`（omp 自行 validate）    | schema 校验归 omp；lenientArgValidation 等按注册表行带过 |
| `frame.timeoutMs`           | `AbortController` + `setTimeout` | abort → 投影 `{status:"timeout"}`                        |
| `frame.machineId`           | host 绑定校验                    | mismatch → error（防错投）                               |
| `AgentToolResult.content[]` | `output` 文本拼接                | `details.meta.truncation` → `outputTruncated`            |
| `onUpdate(partial)`         | `ExecutionUpdate{kind:"output"}` | 流式增量通道现成                                         |

**实测输出**：glob/read/grep ok、unknown tool error、缺失文件 omp 结构化 error（"Path 'no/such/file.txt' not found"）、跨 machine 拒绝，全部正确投影。

估工：**host 构造 ~40 LoC + 帧缝 ~60 LoC + 类型 ~25 LoC**。生产化增量只有：artifact sink 桥（OutputSink 溢出 → 我方 artifact）、`details` 的按工具裁剪、`onUpdate` 节流。**结论：缝的成本可以忽略，决策焦点全在「native 版本钉死 + Bun 运行时 + settings 隔离」三件运维纪律上。**

## 4. Q4：逐工具裁决（T5–T11、T21–T25）

判据：`embed` = import omp 工具类直接跑（本 spike 已证或闭包已查）；`shim` = 用 omp 的库/natives 层但不用 AgentTool 壳；`not-worth` = 手抄/保留我方正本更便宜。

| 票  | 工具                 | 裁决                                            | 依据（实测/闭包证据）                                                                                                                                                                                                                                                                                      |
| --- | -------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T5  | read                 | **embed**                                       | harness 跑通；专项读取器（archive/sqlite/pdf/notebook）随 omp 全集；URL 分支有 `fetch` 注入缝（ToolSession.fetch）                                                                                                                                                                                         |
| T6  | write + manage_skill | **embed**                                       | write 跑通；manage_skill 闭包浅（agentDir + symlink 检查），实现票验证 agentDir override 即可                                                                                                                                                                                                              |
| T7  | glob + grep          | **embed**                                       | harness 跑通，natives 引擎 6–11ms；超时/分页语义原生自带                                                                                                                                                                                                                                                   |
| T8  | edit                 | **embed**                                       | apply_patch 跑通；hashline 模式需 `session.editStore`（natives EditStore，probe 已证可用）；**前置=Q2 的版本钉死纪律**                                                                                                                                                                                     |
| T9  | bash                 | **not-worth（保留我方执行体）+ embed 工具函数** | omp 执行体是 **pi-natives `Shell`（brush-core 内嵌 Rust shell）+ PtySession**（bash-executor.ts:8-14），非子进程——换引擎等于推翻 M0 沙箱/journal/pid-kill 语义。可整段 import 的纯 TS 件：`shell-tokenize.ts`（patterns deny）、`tool-timeouts.ts`（clampTimeout）、输出 spill 形状（OutputSink 接口对齐） |
| T10 | eval                 | **shim（库级 vendor）**                         | kernel 基建（py framed IPC / bun worker VM、IdleTimeout、`%load`）是可 vendor 的库；AgentTool 壳深绑 session（budget/trackEvalExecution/getEvalSessionId）。T10 从「自建内核」改为「daemon 侧 vendor omp kernel 库 + 我方 seam」——票尺寸显著缩水                                                           |
| T11 | find (jfind)         | **embed（注入 judge 缝）**                      | 级联 = fs + natives 词汇索引/IDF；judge 经 `resolveJudge`（judgment/，吃 settings + modelRegistry）——我方 provider 通道可从 `session.modelRegistry` 注入；20s 预算/失败不抛错语义原生自带                                                                                                                  |
| T21 | github               | **embed**                                       | gh 子进程 + natives vcs（worktree/branch），无深 session 依赖                                                                                                                                                                                                                                              |
| T22 | lsp                  | **embed**                                       | 子进程 JSON-RPC 管理；`queueDeferredDiagnostics` 等 session 钩子全部 optional，headless stub 即可                                                                                                                                                                                                          |
| T23 | ast_grep + ast_edit  | **shim（natives 直调）**                        | natives `astGrep/astEdit/astMatch` probe 已证在；AgentTool 壳的 staged resolve/reject 依赖 tool-choice queue/peekPendingInvoker 接缝——M1.5 用 natives 直调 + 我方 staged 裁决流更薄                                                                                                                        |
| T24 | debug                | **embed（P1，实现票复核）**                     | DAP 传输 + action 分派，闭包无深 session 依赖（未见 block），import 面与 lsp 同族                                                                                                                                                                                                                          |
| T25 | ida                  | skip（PM 裁剪点不变）                           | omp ida = broker-client 族；我方 daemon 本身就是同族先例，无抄的收益                                                                                                                                                                                                                                       |

edge 件（T1/T2/T3/T4 的 context_notes/new_context/think/wait/todo/checkpoint）：**维持原案**。本体纯 TS（四文件 import 面逐一查过，零 node:/bun 直接依赖），但闭包经 `pi-utils` barrel（→ `frontmatter.ts` 的 `import { YAML } from "bun"`）与 pi-tui 渲染件（`Bun.stringWidth` 等）——在 workerd 里整嵌要拖整套垫片，不值。schema/模板照抄 + DO 本地执行（分类表 §2.2）继续成立。

## 5. Q5：运行时裁决与垫片成本

**推荐：daemon 侧工具宿主进程 = Bun。** 依据：

1. omp 官方 engines 就是 `bun >= 1.3.14`；TS 源码直跑，本 spike 全部证据在 Bun 下取得。
2. 我方 daemon-service client（executor/ws-session/connection 等）是纯 TS + node: API，Bun 兼容运行——宿主进程换 Bun 不动现有代码。
3. 纯 Node 的三层垫是**永久漂移面**：上游 108 个文件 `from "bun"`（实测 grep），新增 Bun API 无契约义务通知我们。
   - 垫 1：`bun` 模块（YAML/JSONC/file/write/spawnSync 子集）——已写出 98 LoC 可用版（[spike/omp-runtime/bun-shim.ts](./spike/omp-runtime/bun-shim.ts)，settings 链实测走到 YAML 解析）；
   - 垫 2：`bun:sqlite` scheme（settings.ts:37 → agent-storage.ts:1 静态依赖；node:sqlite 可对位，~70 LoC 未落地）；
   - 垫 3：loader 的 `import.meta.dir` + `.md with {type:"text"}`（tsx/loader 变换）。
4. 折中备案（若运维上 Bun 不可行）：只对 omp engine 面跑 Bun 子进程，经其官方 RPC 面（omp-engine-portability §2.6「RPC=投影」）——但这引入第二进程模型，M1.5 内不建议。

## 6. M1.5 波次重构草案（供 PM 裁决）

```
波 2（原 T5 read → T6 write → T7 glob/grep → T8 edit → T10 eval → T11 find）
  ↓ 塌缩为
T5'  omp host-runtime bring-up（P0，一窗）：
     - daemon 宿主跑 Bun + workspace 依赖策略（vendoring vs checkout 子模块，PR 时定）
     - pi-natives 版本钉死 + 载入自检（nativeAddonStatus().stale 门禁）
     - Settings 隔离 profile（禁读用户全局配置）
     - adapter（本文 §3 的 123 LoC 起步）+ OutputSink→artifact 桥
     - 验收：本文 harness 的五行调用全部 replay 通过
T5a' read 激活票（薄）：注册表行 + replay 断言 + URL 分支 fetch 缝
T5b' write+manage_skill 激活票（薄）：同上 + agentDir override 验证
T5c' glob+grep 激活票（薄）：超时/分页语义断言（omp 自带，测投影即可）
T5d' edit 激活票（薄）：hashline 模式 + editStore 快照链 + 防双 apply 断言
T9   bash 不变（delta 清单仍以 omp 文档为验收正本；新增：import shell-tokenize/tool-timeouts 两个纯 TS 件）
T10' eval 重定义：vendor omp kernel 库（py framed IPC + js runtime + IdleTimeout）→ daemon 常驻 + 我方 JobRegistry seam；删除自建内核范围
T11' find 重定义：embed FindTool + judge 经 modelRegistry 注入我方 provider 通道；预算/降级语义由 omp 承担，票只测缝
波 5：T21/T22/T24 降为「激活票」（同 T5a' 形）；T23 = natives 直调 shim 票；T25 维持 skip
波 1/3/4 不受影响（edge 件与 task 族不依赖本结论）
```

风险与边界：

- **上游锚定**：embedding 把我方工具语义钉在 omp checkout commit 上；上游跟进策略（pin + 定期 bump，还是持续 rebase）是发布工程问题，须在 T5' 里显式裁决。omp MIT + THIRD-PARTY-NOTICES 保留即合规。
- **settings 泄漏**：`loadIsolated` 读用户全局配置——宿主进程必须显式隔离目录，否则我方宿主的工具 schema 随开发者机器漂移。
- **native 版本**：见 §2 坑；这是 embed 路线最大的运维雷，T5' 必须给 CI 门禁。
- **bash 例外**：T9 结论不变的理由是执行体引擎不同（brush vs 我方 PTY-less bash），不是 embed 路线失败——工具函数层面的复用照旧。

## 附：复现

```bash
cd /home/nixos/workspace/oh-my-pi && bun install --frozen-lockfile
# 注意：checkout 自带 .node 陈旧；从 ~/.omp/natives/<安装版>/ 取匹配 addon 覆盖
cd /tmp/omp-spike && bun harness.ts && bun run-adapter.ts
# Node 对照（预期：bun 模块垫片可过 settings，loader 在 import.meta.dir 崩）：
bunx tsx --tsconfig tsconfig.json harness.ts
```

harness/adapter/shim 源码：[spike/omp-runtime/](./spike/omp-runtime/)。证据产出时间 2026-10-04，omp `9b98865146`。

> AGENT GENERATED: by zhipu-coding-plan/glm-5.3-flash:max (OmpRuntimeSpike, M1.5 波次重构输入)
