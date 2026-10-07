# Codebase Guidelines

> [!IMPORTANT]
> High-level target about current wave: W5（伞 #310 / milestone 12）— agent 基本功能 UX 做到确定性与鲁棒，skill 之外随发现随立。永续使命：云上随时可用的 omp——波次是刻度，交付持续。

## Must-Follow Reading（每会话先读——违反即返工）

动手前按序读过，未读先读：

1. `rule://belief-state-discipline` — 信念台账：每个外部操作前把前提标 OBSERVED/ASSUMED；ASSUMED 不许直接落码/落票，先取 retrieved truth（读近处源码/文档/schema），其次问 provenance，最后才 probe。禁止把上游源码存在性当作产品可达性。
2. `rule://eval-first-orchestration` — 复杂编排进 eval 内核：远程解析/JSON 内嵌/凭据处理/跨环境探测出现深层引号或多项组合时，用命名 eval cell 留中间态，不写一锤子 shell。
3. `omp://secrets.md` — 凭据脱敏机制正本：`$$HASH(:hint)$$`/`$$FRIENDLY_HASH(:hint)$$` 占位符=secrets.yml/env/内建正则收集的明文可逆脱敏；会话与工具参数自动脱/还原——取凭据真实值时按此机制解析（secrets.yml 两级：`~/.omp/agent/` 与 `<cwd>/.omp/`），**明文永不回显进 transcript**。
4. `docs/agents/*` — PM 与 tracker 操作正本：`pm.md`（PM 循环/DoR/派发/关账，含"症状复现即立项，禁 all-in-one 票"）、`acceptance-lane.md`（验收模板+证据三件套）、`issue-tracker.md`（gh 约定+native blocking edges）、`tracker-schema.md`（三轴模型）、`triage-labels.md`（五标签）、`domain.md`（CONTEXT.md/ADR）；跨块判定加读 `docs/design/decomposition.md`。

## Engineering Doctrine（工程铁律——先读这个）

本节是项目最高优先级的工程纪律，违反任何一条等同于阻断级缺陷。概念均来自标准项目管理/工程实践，此处给出明确中文定义与本项目操作规则。

### 复用三问（Reuse-Three-Questions，反 NIH）

为任何实现工作立项之前，必须依次书面回答三个问题：

1. **上游是否有整库可搬？**——omp 源码（MIT，Node 运行时）、bb 子模块、npm 生态中是否已存在完成同一职责、可整体引入的实现？
2. **运行环境是否同构？**——该实现所依赖的环境与我们的执行面是否一致（daemon 客户端与 omp 工具运行时同为 Node 宿主=同构；Cloudflare Workers 只能运行纯 TypeScript 子集=不同构）。
3. **适配垫是否比重写更薄？**——把现成实现接入本系统所需的适配层（接口转换、类型垫片、构建接线），其规模与风险是否小于从零重写。

三问任一为肯定，必须走复用路线；三问全否定并留有论证，才允许从零手写。未经三问开工手写称为 **NIH 违例**（Not-Invented-Here：拒绝外来轮子、偏好自己重写的反模式）。历史教训：M1.5 初版把 15+ 个宿主工具切成逐个手工移植票，从未测过 omp 工具运行时整体嵌入 daemon 客户端的可行性（spike #125 纠正）。

### 派发就绪定义（Definition of Ready, DoR）

出自 Scrum：一张工单只有满足明确定义的前置条件才允许派发执行；不满足就绪定义的工单，无论排期压力多大都不许进入执行。本项目 DoR 五项：

1. 复用三问有票面书面答案（手工移植票必须含三问否定论证）；
2. 技术不确定性已被证据消除（见下条"风险退役"）；
3. 验收标准在产品面上可观察（可演示、可复验）；
4. 上游锚点已标注（bb/omp 的文件与行号）；
5. 效率与成本预算行已附（工期、DO 请求量、token/费用）。

### Spike 与风险退役（Risk Retirement）

出自极限编程（XP）：当工作的可行性、成本或形态存在不确定性，而人容易对它抱有"未经证实的自信"（我相信我能实现得特别好）时，正确做法不是直接排期实现，而是先做一个**时间盒限定的、以回答问题为唯一目标**的小型实验（spike，技术探针）。spike 的产物不是可上线代码，而是**证据**（真实运行的 harness、测量数据、逐项判定）。**风险退役**就是把"我以为能做好"的主观信念替换为"探针实际运行过、测量过"的客观事实；工单票面必须引用这些证据才算就绪。示例：#125（omp 工具运行时嵌入 spike）先于全部波 2/5 工具票派发。

### 参考类预测（Reference Class Forecasting）

出自行为经济学（卡尼曼、弗林夫布约格）：估算工期时**禁止**只从任务内部视角做乐观推演（"这次应该很快"——内部视角乐观是系统性的，不是偶发的），必须找到同类已完成的往例，以其实际耗时分布为基准。操作规则：新票估算行必须注明参照的往例（如"bb 路由移植 ≈ FixUxBatch 单项实测 ≈ 1h"）；找不到往例的工作，按定义属于不确定性未退役，回到 spike。

### 倒查义务（Retroactive Audit）

复用观或任一上述纪律升级时，**存量 open 票必须全部重审**：涉违例的票加 gated 注记（冻结派发、引用 spike）、或直接重构形态、或给出免罪论证。禁止以"我知道了，以后不再犯"替代对历史工单的实际处理。

## Commits

- One commit per describable behavior; tests and consumer updates in the same commit.
- Conventional commit prefixes: `feat:`, `fix:`, `docs:`, `chore:`, `refactor:`.

## Submodule: bb

- `bb/` is a fork of `get-bb/bb` pinned as a git submodule.
- bb-internal work happens in the bb repo (`Samuka007/bb`), on branches pushed to `origin`.
- Never edit bb files directly from this repo's working tree; cd into `bb/` and work there.
- Issues strictly about bb internals live in `Samuka007/bb` issues. Cross-cutting / Cloudflare / design issues live in this repo's issues.

## Agent-Authored Artifacts

When creating an issue or PR body end-to-end, finish the body with exactly:

> AGENT GENERATED: by <model identity>

No leading marker. When only reviewing or commenting on agent-authored work, do not add this line.

## Debugging And QA

- Do not assume. Inspect logs, query state, or call APIs to observe real behavior.

## Shell Output Discipline

- NEVER suffix commands with `| head`, `| tail`, or `2>&1 | tail`. Tooling
  merges stdout/stderr automatically and spills long output to recoverable
  artifacts (`read artifact://<id>`); manual truncation is permanent loss.
- Side-effect commands (deploy, merge, create, migrate) always run bare —
  their output is the only audit trail and cannot be re-run to regenerate.
- If output is long, let the tool spill it, then query the artifact with
  reads/grep. No one-shot pipeline filtering.

## Observation discipline (POMDP)

Your training memory is a **stale belief state**, not the world. Treat it accordingly:

- **Priors are for discussion only.** Any fact that lands in code, rulings, config, or tickets must come from a fresh observation (schema introspection, official docs, live API call) — never from memory alone.
- **Sample before high-cost actions.** The more irreversible the action, the earlier the observation: verify endpoints/protocols against current docs _before_ calling, query the live schema _before_ asserting an API exists.
- **Prior half-life scales with ecosystem velocity**: weeks for fast-moving surfaces (effect, GitHub GraphQL, Cloudflare API), years for stable ones (SQL, HTTP). Confidence must decay to match.
- Known failure modes this rule exists to prevent: calling `/user/tokens/verify` with an account-owned `cfat_` token and concluding "invalid"; guessing GraphQL type names from memory instead of querying `__schema`.

## Agent skills

### Issue tracker

Issues live as GitHub issues on this repo (`Samuka007/cloudflare-agent-project`). bb-internal issues live on `Samuka007/bb`. See [docs/agents/issue-tracker.md](docs/agents/issue-tracker.md).

### Triage labels

Canonical five-role vocabulary (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See [docs/agents/triage-labels.md](docs/agents/triage-labels.md).

### Domain docs

Single-context: `CONTEXT.md` + `docs/adr/` (created lazily). See [docs/agents/domain.md](docs/agents/domain.md).

### Process routing (ask-matt)

Consult `skill://ask-matt` at every stage before choosing how to proceed. It is the router over the engineering flows: the main flow (idea → ship: `/grill-with-docs` → `/to-spec` → `/to-tickets` → `/implement`), the on-ramps (`/wayfinder` for huge foggy efforts, `/triage`, `/diagnosing-bugs`), and phase-boundary rules (`/clear`, `/handoff`, `/compact`, subagents). Do not improvise process; ask the router.
