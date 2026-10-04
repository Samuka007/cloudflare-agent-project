# omp Agent-Core Loop: Archaeology for the Kernel-Core Design

Source: `oh-my-pi` (omp) @ `9b98865146`, `packages/coding-agent` + `packages/agent` + `packages/ai`.
Shape cross-checks: `bb` @ `8473d8c33` (`packages/agent-runtime`, `packages/agent-providers`).
Purpose: feed wayfinder #89 kernel-core design for the three holes — Turn Loop (queueing/interruption/cascade), Provider Sessions (streams, retries, credentials), Context Assembly. Method: six-field extraction (responsibility / single-writer state / interface+consumers / invariants / failure semantics / budget-accounting) + mechanism-vs-policy splits, all claims cited file:line.

Layout fact that reframes everything: omp's kernel core is **three layers**, not one package:

| Layer                               | Package                                                           | Role                                                                             |
| ----------------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `packages/agent` ("pi-agent-core")  | `agent.ts` (2.1k lines), `agent-loop.ts` (3.9k lines)             | turn loop, queues, tool dispatch, replay policy — provider-agnostic              |
| `packages/ai`                       | `stream.ts` (2.4k lines), `dialect/`, `providers/`, `error/`      | wire transport, SSE normalization, auth retry, in-flight gating                  |
| `packages/coding-agent/src/session` | `agent-session.ts` (12.6k lines), `turn-recovery.ts` (3.1k lines) | policy shell: admission, recovery ladder, fallback chains, persistence, assembly |

`agent-loop.ts:2-3` states the layering contract in one line: _"Agent loop that works with AgentMessage throughout. Transforms to Message[] only at the LLM call boundary."_

---

## 1. Turn Loop (queueing, interruption, continuation)

### 1.1 responsibility

Owns turn admission, message queueing (steer/follow-up/aside), the run loop itself, interrupt/abort propagation, pause, and post-prompt continuation scheduling. Split across: `Agent` (`packages/agent/src/agent.ts:394`) holds queue state + the single in-flight run; `agentLoop`/`runLoopBody` (`packages/agent/src/agent-loop.ts:608,1167`) is the stateless-ish loop driver; `AgentSession` (`packages/coding-agent/src/session/agent-session.ts:670`) is the policy shell that admits submissions, schedules continuations, and owns recovery.

### 1.2 single-writer state ownership

- `Agent.#state.messages` is the transcript of record; `replaceMessages` snapshots the caller's array to defeat external mutation (`agent.ts:1202-1205`). Only the loop body pushes during a turn (`agent-loop.ts:1303-1311,1631-1634`).
- Two plain-array queues inside `Agent`: `#steeringQueue` and `#followUpQueue` (`agent.ts:415-416`). Dequeue modes `"all" | "one-at-a-time"` with a grouping predicate that merges adjacent related messages into one batch (`agent.ts:1387-1390`).
- `#runningPrompt` is the single-active-turn handle; `waitForIdle()` simply returns it (`agent.ts:1438-1440`). Single-writer enforcement is "one promise owns the loop": a second `prompt()` while streaming throws `AgentBusyError` whose message names the escape hatches — _"Use steer() or followUp() to queue messages"_ (`agent.ts:101-104`).
- Dequeued-but-undelivered claims are tracked so editor/undo can still cancel delivery: `#queuedMessageClaims`, `#queuedMessageDeliveries` ("Dequeued originals remain recoverable until their transcript events arrive", `agent.ts:426-433`).
- Session layer adds admission accounting: `#admittedSubmissionCount` (`agent-session.ts:959`), so `isStreaming` = `agent.state.isStreaming || #promptInFlightCount > 0` (`agent-session.ts:5791-5792`) — "admitted but not yet streaming" still counts as busy. Every entry point funnels through `#admitSubmission` (`agent-session.ts:2708-2714,6852-6854`).
- Post-prompt continuation has its own single-writer guard: `#activeAgentContinue` plus a monotonic `#agentContinueSchedulerToken`; later requests **coalesce** onto the in-flight continue attempt (`agent-session.ts:4320-4388`).

### 1.3 interface + consumers

- `Agent.prompt/steer/followUp/abort/waitForIdle` (`agent.ts:1281-1294,1434-1440`); queues peekable via `peekSteeringQueue`/`peekFollowUpQueue`/`peekUndeliveredQueuedMessages` (`agent.ts:1343-1364`).
- Queue-change listeners (`onQueueChange`, `agent.ts:924`) feed UI chips; run-state listeners (`subscribeRunState("running"|"idle")`, `agent-session.ts:4876`) feed TUI/SDK status.
- Message routing while streaming is a **caller-selected policy** — `PromptOptions.streamingBehavior`: no behavior → `AgentBusyError`; `"steer"` / `"followUp"` / `"aside"` queue into the respective channel (`agent-session.ts:6940-7003,8424-8427`). Asides are non-interrupting context injections; a queued `"aside"` on an _idle_ session degrades to starting a turn (`agent-session.ts:8426-8427`).
- Continuations are scheduled through `#scheduleAgentContinue` → post-prompt task queue with `generation` guards and `shouldContinue` re-checks (`agent-session.ts:4320-4388`); compaction continuation uses a 100 ms delay and re-checks `hasQueuedMessages()` (`agent-session.ts:4397-4404`).

### 1.4 core invariants

1. **Single active turn per Agent**; everything else queues or is rejected. The loop checks `agent.state.isStreaming` and parks/continues accordingly.
2. **tool_use/tool_result pairing**: on `stopReason error/aborted`, placeholder tool results are synthesized for every tool call in the aborted message _"This maintains the tool_use/tool_result pairing that the API requires"_ (`agent-loop.ts:1497-1532`). Steering is _parked_ until after a resume-tail tool batch — _"injecting a message between the tool_use blocks and their results would break the provider's pairing invariant"_ (`agent-loop.ts:1233-1240`).
3. **Steering never reorders**: once live steering is deferred, later input must follow at the boundary — _"delivering it live would reorder the user's messages"_ (`live-steering.ts:40-42`).
4. **Transcript = what the model saw**: live-steering acceptance/rejection is recorded per call; accepted messages get `liveSteered = true` (`agent-loop.ts:1709-1715`, `live-steering.ts:29-32`).
5. **Partial tool calls don't survive replay**: _"Only tool calls that reached `toolcall_end` survive abort/error replay... partial tool arguments are unsafe to keep"_ (`agent-loop.ts:2698-2700`).
6. **Abort leaves the steering queue intact**: draining on abort would _"inject the messages right before a model call that instantly aborts — message lands in history, agent never responds"_ (`agent-loop.ts:1701-1706`).
7. **`length` truncation abandons trailing tool calls** (incomplete args) — the one stop reason that must not run tools (`agent-loop.ts:1551-1553,1642-1665`).
8. **Generation counters defeat stale continuations**: `#promptGeneration` bumped on abort/branch; scheduled continuations carry a generation and re-check (`agent-session.ts:5566-5568,4320-4343`).

### 1.5 failure semantics

- **Mid-turn crash/persistence**: `unpairedToolCallTail` (`agent-loop.ts:649-668`) detects a trailing assistant message with unanswered tool calls; `agentLoopContinue` re-executes exactly those calls before the next model call (`agent-loop.ts:1240-1277`).
- **User abort** synthesizes an aborted assistant boundary + placeholder tool results, then ends the run; `#resetInFlight()` runs during abort teardown so a subsequent prompt doesn't see a phantom-busy session (`agent-session.ts:9025-9028`).
- **Terminal tool-result hook**: a tool hook can mark a result terminal (subagent yield) — loop stops before the next provider call without touching user-abort semantics (`agent-loop.ts:1668-1672`).
- **Queue-drain failure latch**: a failed start (e.g. usage preflight) sets `#queuedMessageDrainBlocked` while messages remain queued; `#reconcileQueuedMessageDrain` clears it when the queue empties (`agent-session.ts:5708-5724,7987-7990`).
- **Idle delivery stranding**: deliveries that arrive after the run settles land in aside queues and are resumed by `#resumeStrandedIrcAsides()` — "no loop left to drain them" guards appear at every late-landing site (`agent-session.ts:1126-1128,7921-7925,8197-8201`).

### 1.6 budget-accounting

- Run deadline is an `AbortSignal.any`-composed deadline timer, not a polled clock (`agent-loop.ts:1179-1192`).
- `stepCounter` counts loop iterations into `agent_end` telemetry (`agent-loop.ts:715-718`).
- Loop-level "budget" is really **occupancy**: `#promptInFlightCount`, `#admittedSubmissionCount`, `awaitingAsyncWork` flags decide idle vs busy, and idle compaction defers when `#hasPendingAsyncWake()` (`agent-session.ts:6157-6166`).

### 1.7 pause (cross-cutting)

Process-global `AgentPauseGate`: every loop in the process polls it at exactly two boundaries — before each model call and before each tool call — freezing at the next safe point **without aborting**; a run's own abort signal unwinds a parked loop without releasing the gate (`pause.ts:1-19,69-93`). Host policy (TUI `/pause`); library code only reads.

### 1.8 mechanism vs policy

- Mechanism (hardcoded, `packages/agent`): queue mechanics, pairing invariants, replay filtering, pause gate, placeholder-result synthesis, `STEERING_INTERRUPT_POLL_MS` interval fallback when no event-driven watch exists (`agent-loop.ts:3545-3608`).
- Policy (host-selected): streamingBehavior per submission; steering/followUp dequeue mode + grouping predicate (`agent.ts:436-437,1383-1385`); interrupt mode `"immediate" | "wait"` (`agent.ts:1190-1196`); deadlines; continuation scheduling sources/delays (`agent-session.ts:4320-4454`); `MAX_PAUSED_TURN_CONTINUATIONS` and `MAX_SOFT_TOOL_ESCALATIONS` caps are hardcoded loop constants.
- Auto-resume policy is asymmetric by design: a queued **steer** resumes a turn from any tail ("the steer itself becomes the valid tail"); a **follow-up-only** queue requires the last message to be assistant/toolResult and is suppressed while `#advisors.autoResumeSuppressed` (set by user interrupt) — `#canAutoContinueForFollowUp` (`agent-session.ts:7997-8019,8977`).
- **No wall-clock idle timer governs the turn loop.** "Idle" is derived state: `#promptInFlightCount === 0`, tail validity, suppression flags. All timing is fixed constants on post-prompt tasks (0/1/100 ms — `agent-session.ts:1773,4400,4442`). Time-based idle policy lives in _maintenance_, not the loop: `compaction.idleEnabled/idleThresholdTokens(200k)/idleTimeoutSeconds(300s)` (`context-settings.ts:223-276`).
- Injected strategy objects (policy seams): YieldQueue per-kind dispatchers (`yield-queue.ts:53-66`), ToolChoiceQueue caller callbacks (`tool-choice-queue.ts:19-33`), injectable `prepareQueuedMessages` (`agent-session.ts:5174`), aside provider (`agent-session.ts:1801-1803`).

### 1.9 bb shape deltas (turn loop)

- bb (`packages/agent-runtime/runtime.ts`, `runtime-turn-state.ts`) drives provider **CLI subprocesses** (`runtime-provider-process.ts`) — the "turn" is a provider process lifetime, so queueing/steering lives at the thread/runtime layer, not inside a shared in-process loop. omp inverts this: one in-process loop, providers are libraries.
- bb keeps an explicit `runtime-turn-replay-filter.ts` as a separate stage; omp folds replay filtering into the loop + `replay-policy.ts` (13 lines).
- bb tracks multi-thread identity and background-work state as first-class runtime tables (`runtime-thread-identity.ts`, `runtime-background-work-state.ts`); omp's equivalent (`#promptGeneration`, async-wake tracking) is embedded in AgentSession fields.
- Exclusivity enforcement differs in kind: bb _observes_ turn events from outside (`RuntimeTurnState` per-thread Map + `waitForActiveTurn` waiters, `runtime-turn-state.ts:48-96`) and fences stale steers against an `expectedTurnId`, returning status `"stale"` on mismatch (`runtime.ts:1964-1972`); omp fences writer-side via generation counters and per-incarnation AbortController identity checks (`agent.ts:1576,1869,1940`).
- bb **reaps** idle hosted provider sessions after an `idleForMs` window (`runtime.ts:753-765`, `reapIdleProviderSessions` at 2243+); omp has no reaper — an idle session is just an idle object.
- bb captures per-thread exit state (`activeTurnId`, `pendingTurnStart`) for provider-process restart recovery (`runtime.ts:357-361`); omp's crash story is transcript replay + tail repair.

### 1.10 durability of turn-loop state (the "DO-eviction recovery" question)

omp has **no durable-object/eviction layer**: sessions are file-backed. Queued-but-unstarted user input (`#steeringQueue`/`#followUpQueue` are plain in-memory arrays, `agent.ts:415-416`) is **not durable** — lost on hard crash [INFERENCE from absence of any persistence path]; in-session aborts leave them queued and the TUI can restore them to the editor (`input-controller.ts:1950-1956`). What _is_ durable: the transcript, replayed on restart; `TurnRecovery` repairs the broken assistant tail and explicitly rebuilds "the active assistant tail that Agent.continue() needs to dequeue follow-ups" (`turn-recovery.ts:1178-1182`). Persistence is promise-chained per message (`#messageEndPersistenceTail`, `agent-session.ts:886-888`); storage failures fail-fast chained ops (`indexed-session-storage.ts:62-72`) rather than dropping records silently.

Ticket-name correction: `speculation-lead.ts` is not turn speculation — it sizes the **speculative-compaction** lead band, `clamp(threshold × 0.125, 8_192, 32_000)` tokens below the compaction threshold, where a background summarizer precomputes the summary so the kept tail between compute and apply grows by at most ~lead tokens (`speculation-lead.ts:2-23`).

---

## 2. Provider Sessions (streams, retry cascade, credentials)

### 2.1 responsibility

Split across two packages. `packages/ai` owns the wire: per-API SSE→event translation (`packages/ai/src/providers/*`, e.g. `anthropic.ts:2646-2886` mapping `message_start/content_block_delta/...` to the internal union, stop reasons `end_turn/max_tokens/tool_use/refusal → stop/length/toolUse/error` at `anthropic.ts:5911-5933`), the public stream pipeline (`streamSimple` composes leaked-thinking healing → thinking-loop guard → transport fetch, `stream.ts:69-75,1262-1283`), a/b/c credential auth-retry (`auth-retry.ts`), 429/usage-limit classification (`error/rate-limit.ts`), and a **cross-process in-flight concurrency gate** built from filesystem leases + heartbeats + `.wakeup` signals (`stream.ts:159-708` — `PROVIDER_INFLIGHT_HEARTBEAT_MS=5000`, stale-lease reaping via `process.kill(pid,0)`, `configureProviderMaxInFlightRequests` as the config seam).

**Do not confuse the two "dialect" concepts**: `packages/ai/src/dialect/` is NOT wire translation — it is _in-band tool-call text dialects_ for models that emit tool calls as prose (`DialectDefinition {dialect, prompt, createScanner, renderToolCall, ...}`, `dialect/anthropic.ts:575-580`; per-family scanners harmony/gemini/deepseek/kimi/glm/gemma/hermes/minimax). `OwnedStreamProjector` re-projects a settled message through a dialect scanner for replay (`dialect/owned-stream.ts:78-207`).

The coding-agent layer owns turn-level recovery: `TurnRecovery` ("Owns terminal-stop recovery, automatic retries, and fallback routing", `turn-recovery.ts:294-295`) implements the retry/rotation/fallback cascade, symptom classifiers, replay veto, and usage-aware fallback; `SessionProviderBoundary` owns session→provider context transforms and side-request options (`session-provider-boundary.ts:178-252`).

### 2.2 single-writer state ownership

- The in-flight request + abort: AgentSession owns the turn; `TurnRecovery` owns `#retryAbortController`, swapping a fresh controller per backoff/rotation sleep (`turn-recovery.ts:297,2439-2441,2550-2551,2770-2772`).
- Accumulated stream deltas live inside the provider-layer `AssistantMessageEventStream`; committed-ness is tracked session-side via `#textOutputCommitted` (main-session text commits on render; subagents stay buffered until settle — `agent-session.ts:1927-1931,5863-5866`).
- Cross-turn provider state: `provider-session-state.ts` maps per-provider session state (Anthropic thinking-replay flags; OpenAI Responses `previous_response_id` baselines + chaining circuit breaker; Codex WS keyed by account+bearer). **Endpoint-scoped entries survive credential rotation; account-scoped ones reset** via `resetAccountScopedProviderSessionState` (`provider-session-state.ts:13-39,50-56`).
- Retry state: `#retryAttempt`, `#activeRetryFallback` (with `.served` attribution flag), `#lastServed`, per-symptom counters, all reset per prompt via `resetForNewPrompt` (`turn-recovery.ts:296-351,446-453`). Usage-limit outcomes memoized in `#usageLimitOutcomes` (`turn-recovery.ts:739-769`); durable blocks/cooldowns live in `AuthStorage.limits`.

### 2.3 interface + consumers

Provider streams return `AssistantMessageEventStream` over the union `AssistantMessageEvent` (`types.ts:1504-1527`): `start | text_start|delta|end | thinking_start|delta|end | image_end | toolcall_start|delta|end | done(stop|length|toolUse) | error(aborted|error)`, each carrying `partial: AssistantMessage`. Consumers: pi-agent-core loop (turn accumulation), AgentSession (re-emit as `AgentSessionEvent` to TUI/ACP/RPC, `agent-session-events.ts:13-91`), ttsr-coordinator (`ttsr-coordinator.ts:130-134`), side-requests/advisors/handoff through `prepareSimpleStreamOptions`. Observability taps ride `onPayload/onResponse/onSseEvent`, chained session-then-request (`session-provider-boundary.ts:210-249`).

### 2.4 the retry cascade (ticket premise corrected)

**`remote→snapcompact→handoff→shake→soft` is NOT the retry cascade** — it is `DEFAULT_COMPACTION_METHOD_ORDER` ("server-native first, portable summary last", `compaction-methods.ts:43-50`), config-injectable via `compaction.methodOrder` (`context-settings.ts:91-104`), overridden per invocation by `/compact` modes (`compact-modes.ts:16-56`).

The actual retry cascade in `TurnRecovery.#handleRetryableError` (`turn-recovery.ts:2351-2812`), in order:

1. **Same-model backoff retry** within `retry.maxRetries` (default 10), entered when `isRetryableError` (`turn-recovery.ts:1409-1443`: transient flags, AccountPolicy, classifier refusal; context overflow explicitly NOT retryable — "handled by compaction, not retry", `turn-recovery.ts:1423-1425`).
2. **Usage-limit leg**: `markReached` persists a credential block → rotate credentials or `maybeAutoRedeemReset` (reset-credit redemption planners `claude-auto-reset.ts`/`codex-auto-reset.ts`); rotation sets `switchedCredential` with zero delay (`turn-recovery.ts:2435-2474`).
3. **Model fallback chain** `#tryRetryModelFallback`, gated on `retry.modelFallback` + no sibling-wait; a switched model gets a **fresh budget** (`#retryAttempt = 1`, `turn-recovery.ts:2598-2653`).
4. **Fireworks Fast→base degrade** — runs even when retries are disabled (`turn-recovery.ts:2361-2364,2618-2624`).
5. **Terminal outcomes**: budget exhausted with no switch → `auto_retry_end` failure (`2632-2649`); classifier-refusal/account-policy with no switch → saga close (`2655-2676`); fail-fast when `delayMs > retry.maxDelayMs` without `waitForUsageReset` (`2721-2741`).

Parallel **bounded per-prompt symptom retries** (max 3 each, `turn-recovery.ts:91-95`): empty stop, unexpected stop (4s classifier timeout), malformed function call, committed-text stream-stall _continue_ — these continue-with-reminder rather than wire-retry. Orthogonal guards (not cascade): `stream-guards.ts` (StreamingEditGuard, tool-call loop redirect, Gemini header runaway), `session-handoff.ts` (one-shot handoff-document generation), `anthropic-slow-mode.ts` (subscription low-priority lane), `shake-types.ts` (types only).

### 2.5 core invariants

1. **Replay-veto gate**: a turn that streamed tool calls, images, server tools, or committed non-whitespace text is NEVER retried by re-sending — `#hasReplayUnsafeOutput` gates `isRetryableError` (`turn-recovery.ts:1440`), hard-error fallback eligibility (`2186,2235`), and request-body-timeout recovery (`1373-1387`). Verified first-hand: the only exception requires _positive proof of non-execution_ — every emitted tool call must be paired with a synthetic `executed: false` result; "Any uncertainty keeps the replay veto in place" (`turn-recovery.ts:1435-1459`).
2. **Empty error turns are dropped durably**: `#dropAssistantTurnDurably` reparents them so they cannot resurface on reload or mid-retry kill (`turn-recovery.ts:1009-1013,1162-1173`); a turn with partial text/thinking/tool calls is NOT empty and stays in history.
3. **Committed-text stream failures are never replayed or prefilled**: the partial turn stays and a developer resume-reminder continues it (`turn-recovery.ts:614-683`).
4. **Transport-level replay-safe window**: the auth-retry wrapper buffers all events (including `start`) until the first non-replayable one; a retryable failure _before_ any downstream-visible event returns the buffered events for a clean re-attempt — "Retryable auth failures are buffered until replay is safe" (`stream.ts:1318-1361`). Once `emittedReplayUnsafeEvent` is set, failures propagate terminally. This is the transport twin of invariant 1.
5. **Attribution only names a model that settled a turn**: `#activeRetryFallback.served` gates `retry_fallback_succeeded` (`turn-recovery.ts:479-526,315-319`).
6. **Provider-refusal messages are filtered from replay** (`stopReason=error` + `stopDetails.type refusal|sensitive`) — `replay-policy.ts:4-13`.

### 2.6 failure semantics (per error class)

| Class                                                                                                              | Path                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Transient network (429/500/502/503/529, overloaded, stall/reset/premature-close regexes `turn-recovery.ts:99-109`) | backoff retry if replay-safe; mid-stream with unexecuted tool calls stays retryable with pairing preserved (`turn-recovery.ts:1435-1442`)                                                                                                                                |
| 429 rate-limit (transient wording)                                                                                 | reason-specific backoff floors 5s/30s, stays on same credential (`turn-recovery.ts:2409-2417`); provider retry hints parsed longest-wins (`2335-2341`)                                                                                                                   |
| 429/402 usage-limit (parked-account wording)                                                                       | `Flag.UsageLimit` → credential block + rotation; 30-min `QUOTA_EXHAUSTED` heuristic only when hintless (`error/rate-limit.ts:743-756`; `turn-recovery.ts:2490-2498`); `retry.waitForUsageReset` bypasses the max-delay fail-fast with authoritative timing (`2722-2741`) |
| Opaque 429 (empty body)                                                                                            | conservative rotate-to-sibling signal; body content defers to `parseRateLimitReason` (`error/rate-limit.ts:344-363`)                                                                                                                                                     |
| 401 / auth                                                                                                         | stream-level a/b/c auth-retry: refresh same credential → rotate, bounded by `AUTH_RETRY_MAX_ATTEMPTS`; transient OAuth refresh failure blocks the credential 5 min (`auth-retry.ts:8-25`; `auth/select.ts:42-43`)                                                        |
| 400-class hard errors                                                                                              | never retried same-model; eligible only for the hard-error fallback chain, with exclusions (immutable-Anthropic-thinking, context overflow, classifier refusals, replay-unsafe) (`turn-recovery.ts:2212-2240`)                                                           |
| Context overflow                                                                                                   | NOT retryable — owned by recovery compaction; 413 recovery excludes media-heavy snapcompact (#11482) (`turn-recovery.ts:1423-1425,260-262`)                                                                                                                              |
| Abort / user interrupt / classifier refusal                                                                        | never fallback-switched (`turn-recovery.ts:2228,2655-2676`)                                                                                                                                                                                                              |

**Backoff math** (verified first-hand, `retry-fallback-chains.ts:83-91`): `delay = min(base × 2^(attempt−1), 8000) × (1 − random × 0.25)` — capped exponential with downward-only jitter, cap 8 s. Settings: `retry.baseDelayMs` default 500, `retry.maxDelayMs` default 300_000, `retry.maxRetries` default 10 (`settings.ts:665-838`).

### 2.7 budget-accounting

Provider-reported usage (`input/output/cacheRead/cacheWrite` + cost) lands on `AssistantMessage.usage`; cost stamped via catalog `calculateCost` when the provider doesn't bill one (`providers/amazon-bedrock.ts:934-935`). Quota-side accounting is a separate per-provider **usage-probe registry** (`packages/ai/src/usage/`) behind `UsageService`, with `USAGE_FAILURE_BACKOFF_MS=10s ± 25%` cooldown, feeding `ModelUsageHealth` for usage-aware fallback (`auth/usage.ts:91-94,380-381`; `retry-fallback-reason.ts:5-23`). Durable sinks: per-session cost stats (`agent-session-types.ts:489-497`), per-model perf samples in `agent.db model_perf` (`agent-storage.ts:64-108`). Failed turns persist their usage too — "its provider usage can anchor the next prompt at the full failed-request size" (`turn-recovery.ts:1002-1007`).

### 2.8 mechanism vs policy

- Config-injected (settings.ts:665-838): `retry.enabled(true)`, `retry.maxRetries(10)`, `retry.baseDelayMs(500)`, `retry.maxDelayMs(300000)`, `retry.waitForUsageReset(false)`, `retry.modelFallback(true)`, `retry.usageAwareFallback(false)`, `retry.usageReservePct/Policy`, `retry.fallbackChains`, `retry.fallbackRevertPolicy('cooldown-expiry'|'never')`. Fallback chains support role keys, model selectors, and `provider/*` wildcards with wrap-around (`retry-fallback-chains.ts:115-133,548-594`).
- Hardcoded: the a/b/c auth-retry step order (`auth-retry.ts:14-25`); in-flight gate constants (`stream.ts:172-180`); symptom retry caps (3); backoff jitter ratio; compaction default order (member order itself is config).
- Env: `PI_NO_INTENT`, `PI_NO_INTERLEAVED_THINKING`, endpoint gates for leaked-thinking heal exemption (`stream.ts:100-121`).

### 2.9 bb shape deltas (provider sessions)

- bb normalizes provider-CLI events into ThreadEvents via per-provider `translateEvent` adapters and **owns no wire dialects at all** — the CLI owns them (`bb claude-code/translate-message.ts:290-291`, `codex/adapter.ts`).
- bb's retry policy lives _inside the subprocess_; its adapter merely observes and translates retry events with attempt/max_retries/retry_delay_ms (`schemas.ts:172-179`). omp owns the cascade in-process.
- bb's failure unit is process exit (`ProviderProcessExitedError` with bounded stderr tail, `runtime-provider-process.ts:134-142,684-701`; `AcpAgentExitedError` rejecting all pending requests); omp's failure unit is a classified error inside `AssistantMessage` — no process to die.
- Replay filtering: bb dedups provider reconnect replays by completed-turn-id set (`runtime-turn-replay-filter.ts:13-61`); omp vetoes by replay-unsafe content + replay-safe buffering.
- bb has no credential rotation in agent-runtime (credentials live inside CLIs; rate limits arrive as data); omp centralizes credential selection, stickiness, usage probes, blocks, rotation in `packages/ai/src/auth/`.

---

## 3. Context Assembly

### 3.1 responsibility

Five cooperating pieces: (a) `buildSystemPrompt` (`system-prompt.ts:626-1043`) renders a Handlebars template into ordered system-prompt string blocks; (b) `buildSessionContext` (`session-context.ts:218`) resolves the persisted append-only JSONL branch into internal `Message[]`; (c) `convertToLlm` (`messages.ts:1163`) translates internal AgentMessages to provider format with per-message memoization; (d) `sdk.ts:4071-4123` installs per-request transforms (obfuscator → snapcompact-inline → image clamp → image normalization → date/cwd reminder); (e) `SessionMaintenance` (`session-maintenance.ts:511`) owns compaction/shape upkeep. Name trap: `src/compress/` is NOT compaction — it is the `omp compress` file-rewriting CLI (`compress/index.ts:1-27`); the compaction engine lives in `packages/agent/src/compaction/` + `session-context/session-maintenance/compaction-methods/compact-modes`.

### 3.2 single-writer state ownership

- `SessionManager` is the single writer of persisted history (append-only JSONL entry tree); `buildSessionContext` (`session-manager.ts:3184-3189`) is the ONLY sanctioned way to materialize context from disk.
- The live agent owns the in-memory `AgentMessage[]`; after any compaction/shake/prune commit, SessionMaintenance splices the rebuilt array in place and invalidates the conversion cache (`session-maintenance.ts:2624-2629,2711-2716`).
- The system-prompt snapshot is owned by SessionTools (`#baseSystemPrompt`, `session-tools.ts:2009`); memory injection composes `[...preparedBase, injected]` and commits only through the owning turn's commit callback (`session-tools.ts:2034-2047`).
- Conversion caches are **keyed by message identity**: `convertCache` WeakMap per message, `convertArrayCache` WeakMap per array, plus a global `convertGeneration` (`messages.ts:961-999`); managed rewrites (prune/shake/strip-images/compaction) MUST invalidate via the shared registry (`messages.ts:49-52,742-748,1155-1163`).

### 3.3 interface + consumers

`buildSystemPrompt(options)` runs at session construction (`sdk.ts:3754-3802`) and again at each agent start via `buildSystemPromptForAgentStart` (`session-tools.ts:2002-2056`), staged and committed with extension policy; rebuilt only when memoized inputs change (tool names/labels/wireNames/skill capability/MCP projection, `session-tools.ts:2105-2156`). `convertToLlm` is ownership-injected: AgentSession takes `config.convertToLlm` (`agent-session.ts:1822`) and hands it to the agent host (`1904-1906`); the live turn pipeline, side requests/advisors (`agent-session.ts:6278-6280`), and snapshot export (`12256-12260`) all consume it. `buildSessionContext` serves resume (`session-loader.ts:537-541`), display (`session-provider-boundary.ts:111-123`), and maintenance estimation (`session-maintenance.ts:3716-3717`). Context is rebuilt per request — cheap because conversion is cached per message — and after every history rewrite.

### 3.4 prompt layer hierarchy (assembly order)

1. **Block 0** (Handlebars, `prompts/system/system-prompt.md`): role/engineering → Personality (bundled preset or `PERSONALITY.md` override) → Skills & Rules → Internal URLs → Tool Inventory (compact name list when native tools; full catalog otherwise) → xd:// Tool Devices → Tool Policy/Workflow/Delivery/Critical. Tool _availability_ is data-driven (`{{#has tools}}`), but **section order is fixed in the template**.
2. Eval-prelude guidance blocks (`system-prompt.ts:1018-1022`).
3. **Block 1 `<project-context>`** (`project-prompt.md`): workstation → repo-rules context files → dir-context → optional workspace-tree → workspace-roots → activeRepoContext → critical → appendPrompt. **Deliberately last** so the static prefix stays cache-stable across cwds and the Anthropic head cache breakpoint lands before it (`system-prompt.ts:1023-1033`).
4. Append slot inside the project block (`composeAppendPrompt`): memory-backend instructions + MCP route/server instructions (capped `MAX_MCP_INSTRUCTIONS_LENGTH`) + user append prompt (`sdk.ts:3790-3801`).
5. Per-turn memory recall appended as a trailing system block (`session-tools.ts:2034`).
6. **Date/cwd reminder is NOT in the system prompt** — it rides the first user message per request (`sdk.ts:4085,4119-4123`), so a session spanning midnight never rebuilds a stale-date prompt (`session-tools.ts:2100-2103`).
7. Mode templates (plan/vibe/subagent) swap in as block 0 or per-turn messages.

**Tool injection**: native tool API by default — each `AgentTool` carries a JSON-Schema `parameters` handed to the agent registry; the prompt lists only names (`system-prompt.ts:410-416,905-917`). Full-catalog prompt text happens only for non-native dialects (`cfgToolsFormat`) or `inlineToolDescriptors`. Wire-name remapping via `tool.customWireName` (`session-tools.ts:2069-2073`). Withdrawn tools are **re-declared byte-identically** for providers that keep them declared (Anthropic `tool_removal`) — `SentToolDefinitions` remembers the last sent wire definition per name (`sent-tool-definitions.ts:3-13`).

### 3.5 core invariants

1. **Compaction cut points never split a tool call from its results** — cuts are user/assistant/custom/bashExecution only; a cut at an assistant with tool calls keeps its results (`compaction/compaction.ts:419-425`).
2. **Cache stability is engineered, not incidental**: project-context last; steering envelope wrapping is position-independent so cached prefix bytes are never rewritten (`messages.ts:685-691`); prompt rebuild signature guarantees identical inputs → identical prompt bytes, else rebuild (`session-tools.ts:2059-2098`).
3. **Compacted history is summary-first, not an overlay**: the LLM sees a `CompactionSummaryMessage` (tokensBefore, shortSummary, optional provider-native replay payload / snapcompact archive) followed by kept-tail messages (`session-context.ts:515-548`); remote (Codex) compaction can carry `replacementHistory` replayed verbatim (`codex-session-store.ts:587-605`). The wire cut is unconditional even if the active model can't replay the provider payload (`session-maintenance.ts:872-875`).
4. **System-prompt preparation is time-boxed**: `SYSTEM_PROMPT_PREP_TIMEOUT_MS = 5000`, unref'd; timeout/step failure substitutes a minimal fallback and the real work continues in background to warm caches (`system-prompt.ts:217,717-746,846-864`).

### 3.6 failure semantics

Each prompt prep step races the 5s deadline and degrades to a minimal fallback instead of failing the turn (`system-prompt.ts:724-746`); a discovered user template that fails to render falls back to the bundled prompt (`system-prompt.ts:1004-1017`). Compaction failure advances `methodIndex` through the configured preference list and emits `auto_compaction_end` with aborted/willRetry/errorMessage (`session-maintenance.ts:1480-1496,5003-5043`); all-methods-failure surfaces as "Context overflow recovery failed" (`5017-5023`). No-op compaction ("Already compacted", "session too small") is resume-safe, unlike summarizer failures (`1081-1085,1214-1217`). Overflow retries continue only when the rebuilt context fits, or auto-continue under the 0.8 recovery band — anti-thrash guards (`5140-5197,5293-5321`).

### 3.7 budget-accounting

Usage type `{input, output, cacheRead, cacheWrite, totalTokens, orchestration}` (`compaction/compaction.ts:276-299`). Provider usage is ground truth for display/cost, but **compaction decisions floor it with a local stored-conversation estimate** because per-request transforms deflate the wire request (`compaction.ts:370-387`). Cost-bearing input = input + cacheRead + cacheWrite (`run-collector.ts:206-218`); telemetry emits cache_read/cache_creation attributes (`telemetry.ts:1231-1240`). Pruning is cache-aware: useless results inside the still-cached prefix are left for compaction/shake to avoid the cacheWrite premium (`compaction/pruning.ts:46-50,357-361`). Trigger: `thresholdTokens` (priority) else `thresholdPercent` else legacy `contextWindow − reserveTokens`, clamped to contextWindow−1 (`compaction.ts:389-413`); resolution requires residual ≤ 0.8 × threshold (`COMPACTION_RECOVERY_BAND`, `session-maintenance.ts:329`); speculation arms in `[threshold − lead, threshold)` (`2022-2046`). Image budget: provider-specific count caps, oldest transient images dropped with placeholder text, undecodable images degrade via a 512-entry LRU (`provider-image-budget.ts:20-23,73-94,101-111`).

### 3.8 mechanism vs policy

- Hardcoded: section order inside the templates; `SYSTEM_PROMPT_PREP_TIMEOUT_MS=5000`; `DEFAULT_COMPACTION_METHOD_ORDER` (`compaction-methods.ts:44-50`); `COMPACTION_RECOVERY_BAND=0.8`; keepRecentTokens default 20 000; image placeholder strings.
- Config (`context-settings.ts`): `compaction.enabled/midTurnEnabled/methodOrder/thresholdPercent(-1→legacy)/thresholdTokens(-1)/reserveTokens/keepRecentTokens/autoContinue/remoteEndpoint/remoteStreamingV2Enabled/v2RetainedMessageBudget(64000)/idleEnabled/idleThresholdTokens(200k)/idleTimeoutSeconds(300s)/supersedeReads/dropUseless`, `contextPromotion.enabled`, `extendedContext`, `snapcompact.systemPrompt|toolResults|shape`, plus prompt-behavior settings feeding the template data bag (`system-prompt.ts:66-90,955-1000`); env `$env.NULL_PROMPT` short-circuits to an empty prompt.
- Pluggable strategy objects: memory backend, snapcompact shape/image-budget tables from `@oh-my-pi/snapcompact`, injectable `convertToLlm`; overrides are data-driven files (`SYSTEM.md`, `PERSONALITY.md`, context files with @-imports).

### 3.9 bb shape deltas (context assembly)

- bb has **no system-prompt assembly and no compaction/context-budget machinery at all** — prompts, skills, and history lifecycle belong to the delegated provider CLI; bb only observes turn lifecycle events.
- bb's translation direction is inverted: provider-emitted items → internal display (`shared/tool-item-translation.ts`), vs omp's internal → provider build.
- bb adds thread-identity and thread-goal state as first-class runtime tables; omp has no thread-identity layer because one session owns one history.

---

## 4. Design decisions omp made that we must ratify or reject

Each item: the decision, where it lives, and the open question for kernel-core.

1. **Queued-but-unstarted user input is memory-only** (turn-loop queues not persisted; transcript replay + tail repair on restart). Ratify = we accept losing steers on hard crash. (`agent.ts:415-416`, `turn-recovery.ts:1178-1182`)
2. **No idle timer in the turn loop** — idle is derived state; all timing is 0/1/100 ms post-prompt constants; time-based policies belong to maintenance. (`agent-session.ts:1773,4400,4442`)
3. **Two-queue split with caller-selected routing**: steer (interrupting) vs followUp (non-interrupting) vs aside (non-interrupting context), chosen per submission via `streamingBehavior`; no priority arbitration. (`agent-session.ts:6940-7003`)
4. **Steer-resumes / follow-up-doesn't asymmetry** after a user interrupt. (`agent-session.ts:7997-8019,8977`)
5. **Abort preserves the steering queue** (draining would strand messages in a dying run). (`agent-loop.ts:1701-1706`)
6. **Placeholder tool results keep API pairing on abort/error**; only `toolcall_end`-completed calls survive replay; partial arguments always dropped. (`agent-loop.ts:1497-1532,2698-2700`)
7. **Replay-veto gate with positive-proof exception** — replay-unsafe output blocks retry unless every tool call carries a synthetic `executed: false` proof; uncertainty keeps the veto. (`turn-recovery.ts:1435-1459`)
8. **Transport replay-safe buffering window**: events buffered until the first downstream-visible one; retry only inside that window. (`stream.ts:1318-1361`)
9. **Empty error turns dropped durably; committed-text failures continued, never replayed.** (`turn-recovery.ts:1009-1013,614-683`)
10. **Backoff: capped exponential, downward-only jitter** (`min(base·2^(n−1), 8s) × (1−U(0,0.25))`) — rationale unclear; downward jitter biases toward faster retries.
11. **Usage-limit vs rate-limit split by message phrasing** (`parseRateLimitReason`): rotation for parked accounts, backoff for transient caps; opaque 429 rotates conservatively. (`error/rate-limit.ts:24-126,344-363`)
12. **Fresh retry budget per fallback arm**; rotation bypasses the same-route budget. (`turn-recovery.ts:2650-2653`)
13. **Endpoint-scoped provider session state survives credential rotation; account-scoped state resets.** (`provider-session-state.ts:13-39`)
14. **Cross-process provider in-flight limiting via filesystem leases** (lock dir + heartbeat + wakeup) — a global concurrency gate shared by all agent processes on a host. (`stream.ts:159-708`)
15. **System prompt = fixed-order template + cache-engineered block placement** (project-context last, date/cwd on first user message, byte-identical tool re-declaration, position-independent steering wrap). (§3.4, §3.5.2)
16. **Per-message-identity conversion cache with global invalidation generation**; managed rewrites must invalidate via the shared registry. (`messages.ts:961-999`)
17. **Compaction = summary-first splice (not overlay), unconditional wire cut, method-order ladder with speculation in a lead band.** (§3.5.3, §3.7)
18. **Estimate-floored compaction accounting**: billed usage is display truth, but compaction thresholds use a local estimate because transforms deflate the wire request. (`compaction.ts:370-387`)
19. **Process-global pause gate** frozen at two loop boundaries, abort-transparent. (`pause.ts:1-19`)
20. **Provider-native live steering with transcript-mirrors-model invariant** (accepted vs deferred, ordering guarantee). (`live-steering.ts:29-47`)
21. **Attribution only names settled models** (`.served` gate). (`turn-recovery.ts:479-526`)
22. **Harmony-leak detect/recover with caps (2 retries / 2 truncate-resumes) hardcoded in the loop.** (`agent-loop.ts:1444-1473`)
23. **Soft tool requirements escalate via forced tool_choice with detour-skip placeholders, capped.** (`agent-loop.ts:1586-1617`)
24. **`stop`/`end_turn` treated as runnable for tool continuation** (adaptive-thinking models emit calls under end_turn); `length` is the only non-runnable stop. (`agent-loop.ts:1541-1565`)
