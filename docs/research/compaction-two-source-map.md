# bb × omp Compaction Two-Source Map

Ticket: Samuka007/cloudflare-agent-project#79 · precursor to #75 (grilling / HITL residual).
Method: source archaeology against both checkouts; every claim carries `path:line`. Rows/claims not verified against source are marked `[INFERENCE]`.

## Provenance

| Source | Checkout | Version studied | Binary relation |
|---|---|---|---|
| **omp** (`can1357/oh-my-pi` fork of pi-mono) | `/home/nixos/workspace/oh-my-pi` @ `9b98865146` (pkg `18.4.4`) | `packages/agent`, `packages/coding-agent` | installed `omp` 18.6.0 builds from this repo (`bin: { "omp": "src/cli.ts" }`, `packages/coding-agent/package.json:27-29`); binary ~2 minors ahead of checkout |
| **bb** | `/home/nixos/workspace/bb` @ `8473d8c33` ("Add pinned OMP compatibility smoke") | `packages/*`, `apps/server` (pnpm monorepo) | installed `bb` 0.40.0 |

**Framing (the one-line answer):** the two sources implement *different products of compaction*. omp compacts **it own transcript** and writes a **content-bearing checkpoint record** into an append-only JSONL journal, which replay consumes to rebuild LLM context. bb never compacts anything itself — it records a **content-free marker event** into a SQLite event log when the *provider* compacts, and replay consumes it only as UI lifecycle; model-context continuity is delegated to the provider via a stored `provider_thread_id`. They are complementary, not competing, designs.

---

## Part 1 — omp: compaction trigger policy

omp compaction = the coding-agent's *context maintenance* engine: `packages/agent/src/compaction/` (engine) + session integration in `packages/coding-agent/src/session/`.

### 1.1 Trigger conditions — token-threshold driven; time only via opt-in idle timer; no message-count trigger

| Trigger | Condition | Site |
|---|---|---|
| **Threshold (auto)** | `contextTokens > thresholdTokens` | `shouldCompact()` `packages/agent/src/compaction/compaction.ts:364-368`; checked pre-turn, mid-turn, and post-turn: `packages/coding-agent/src/session/session-maintenance.ts:2514, 2646` (decision log `:3211-3215`) |
| **Overflow (mid-turn)** | context-overflow payload rejection forces `reason: "overflow"` | reason enum `"overflow" \| "threshold" \| "idle" \| "incomplete"` `session-maintenance.ts:189, 4149-4150` |
| **Idle (time-gated, default OFF)** | idle timer fires only if context ≥ `compaction.idleThresholdTokens` and editor empty; re-checked at fire time | `#scheduleIdleCompaction` `packages/coding-agent/src/modes/controllers/event-controller.ts:2567-2595`; knobs `context-settings.ts:223-276` — `idleEnabled` default **false**, `idleTimeoutSeconds` default **300** (clamped 60–3600), `idleThresholdTokens` default **200 000** |
| **Speculative (async)** | as context nears threshold, background summarization is armed and spliced in when the threshold is crossed | `compaction.asyncEnabled` default true `context-settings.ts:179-190`; arm/refresh `session-maintenance.ts:2053-2057` |
| **Manual** | `/compact` (aborts the live turn), `/shake` (surgical, no LLM) | `session-maintenance.ts:1982-1986` |

The decision input is `compactionContextTokens()` (`compaction.ts:385-387`): max(provider-reported usage, local estimate of the stored conversation) — so on-wire compression extensions cannot hide real growth from the trigger.

### 1.2 Threshold math

- Fixed `compaction.thresholdTokens` (>0) wins, clamped `[1, window−1]` — `resolveThresholdTokens()` `compaction.ts:389-395`; knob default `-1` (off) `context-settings.ts:133-153`.
- Else percentage `compaction.thresholdPercent`, clamped `[1,99]` — `compaction.ts:404-412`; knob default `-1` `context-settings.ts:106-131` (UI offers 10–95 %).
- Default path (`-1/-1`): threshold = window − reserve, reserve = max(15 % of window, `reserveTokens`‖16 384) — `effectiveReserveTokens()` `compaction.ts:334-336`, `DEFAULT_RESERVE_TOKENS = 16384` `:213`. On a 200 k window ⇒ threshold ≈ 170 k (85 %).
- Small-window recovery: a *defaulted* reserve that is impossible for the window falls back to the proportional 15 % reserve, provenance-tracked via "unset vs configured" — `resolveBudgetReserveTokens()` `compaction.ts:350-359`.

### 1.3 Method cascade

`DEFAULT_COMPACTION_METHOD_ORDER = ["remote", "snapcompact", "handoff", "shake", "soft"]` — `packages/coding-agent/src/session/compaction-methods.ts:44-50`; failed/unavailable methods advance to the next (`context-settings.ts:99-103`):

| Method | Mechanism | Ref |
|---|---|---|
| `remote` | provider-native: OpenAI Responses compact (streamed V2 / V1 `/responses/compact`), Anthropic `compact-2026-09-04` beta (re-issues the live turn's own request — cache-friendly) | `packages/agent/src/compaction/openai.ts:1-15`, `anthropic.ts:1-5` |
| `snapcompact` | archive history onto dense bitmap images read back by the vision model; no LLM call | `compaction-methods.ts:18-22` |
| `handoff` | generate a handoff document that becomes the summary | `compaction-methods.ts:24-27` |
| `shake` | mechanically drop heavy tool-result text / large blocks in place; no LLM call | `packages/agent/src/compaction/shake.ts:1-5` |
| `soft` | in-place LLM summarization with a compaction model | `compaction-methods.ts:29-32` |

---

## Part 2 — omp: retention semantics (what enters the summary; what stays original)

### 2.1 The journal is never truncated — compaction appends a record

Sessions are append-only JSONL of typed entries. Compaction writes a **new `CompactionEntry`** (originals stay on disk):

```ts
// packages/coding-agent/src/session/session-entries.ts:120-127
export interface CompactionEntry<T = unknown> extends SessionEntryBase {
  type: "compaction";
  summary: string;
  shortSummary?: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  tokensAfter?: number;   // display metadata
```

plus `method`, `preserveData` (provider-native replay state), `parentId`, `timestamp` — appended via `session-manager.ts:2979-2999`. The in-memory `AppendOnlyLog` allows exactly one mutation, `replaceTail()`, "reserved for compaction" (`packages/agent/src/append-only-context.ts:220-242`) — that rewrites the *live context*, not the file.

### 2.2 The boundary: `firstKeptEntryId`

`prepareCompaction` walks **valid cut points** — user/assistant/custom/bashExecution messages only, **never a tool result** (results must follow their call) — accumulating whole assistant/tool groups backwards until `keepRecentTokens` (default 20 000) is exceeded; the newest group is kept even if it alone exceeds budget: `findValidCutPoints` `compaction.ts:419-461`, `findCutPoint` `:503-548`, knob `context-settings.ts:202-206`. Everything older than `firstKeptEntryId` is "summarized away and never sent", and prune/shake passes skip it too (`packages/agent/src/compaction/pruning.ts:35-42, 99-104, 149-155`).

### 2.3 What enters the summary

Structured handoff prompt `packages/agent/src/compaction/prompts/compaction-summary.md:1-38`: Goal / Constraints & Preferences / Progress (Done · In Progress · Blocked) / Key Decisions / Next Steps / Critical Context / Additional Notes. Verbatim-preservation requirements: an unanswered question awaiting user response, exact file paths, function names, error messages, relevant tool outputs, repository state (branch, uncommitted changes). Summary budget capped at `MAX_SUMMARY_TOKENS = 16384` ≈ `floor(0.8 × reserve)` (`compaction.ts:215-225`).

### 2.4 What must stay original (never summarized)

- Recent tail ≥ `keepRecentTokens` of complete turns (`compaction.ts:503-508`).
- Tool results stay paired with their calls (cut-point rule `compaction.ts:419-424`).
- `/clear` boundaries: prior summaries are not reused across a reset (`compaction-cut-point` / `compact-reset-boundary.test.ts:71-75`); the reset boundary starts the rebuilt transcript (`session-context.ts:333-337`).
- System prompt and tools are outside the summarized transcript.
- Provider-native routes keep provider-owned originals: OpenAI V2 retains real user messages in `preserveData` (budget `v2RetainedMessageBudget` default 64 000 tokens, `context-settings.ts:216-220`); V1 keeps encrypted reasoning replayable via `preserveData` (`openai.ts:9-12`); Anthropic beta stores the signed block + harness `<files>` section (`anthropic.ts:26, 33-37, 84-89`). Encrypted blobs are excluded from fit estimates (`openai.ts:113-117`).

### 2.5 Replay consumption

Context rebuild walks the branch and, quoting the contract at `packages/coding-agent/src/session/session-context.ts:339-343`:

```
// When there's a compaction, we need to:
// 1. Emit summary first (entry = compaction)
// 2. Emit kept messages (from firstKeptEntryId up to compaction)
// 3. Emit messages after compaction
```

The summary is a *prefix overlay* on the retained suffix; pre-boundary originals are never re-sent (but remain on disk for full-history export — `session-context.ts:335-336`). Token accounting anchors usage to the first post-rewrite report so stale pre-compaction usage can't anchor (`packages/agent/src/compaction/transcript-tokens.ts:79-105`).

---

## Part 3 — bb: compaction as event-log checkpoint

bb is a *control plane over provider sessions*; it never summarizes anything itself.

### 3.1 The event log

Append-only SQLite table — `packages/db/drizzle/0000_baseline.sql:107-131`:

```sql
CREATE TABLE `events` (
  `id` text PRIMARY KEY NOT NULL,
  `thread_id` text NOT NULL,
  `scope_kind` text NOT NULL,        -- 'turn' | 'thread' (CHECK ties turn_id presence)
  `turn_id` text, `provider_thread_id` text,
  `sequence` integer NOT NULL,
  `type` text NOT NULL,
  `data` text DEFAULT '{}' NOT NULL, -- JSON payload
  `created_at` integer NOT NULL, ...);
CREATE UNIQUE INDEX `events_thread_sequence_idx` ON `events` (`thread_id`,`sequence`);
```

Append path: `insertEvents` INSERT OR IGNORE with minted `evt_` ids (`packages/db/src/data/events.ts:306-360`); daemon→server ingestion stores the normalized event minus scope/type/threadId as `data` and resolves `provider_thread_id` (`apps/server/src/internal/events.ts:236-237, 275-287`).

### 3.2 The checkpoint shape: a content-free marker event

The entire persisted compaction record (zod, `.strict()`):

```ts
// packages/domain/src/provider-event.ts:495-499
z.object({
  type: z.literal("thread/compacted"),
  threadId: z.string(),
  providerThreadId: z.string(),
}),
```

Scope policy is `'turn'` (`packages/domain/src/thread-event-scope.ts:90`). **No summary text, no token counts, no boundary id, no method** — everything content-bearing lives provider-side. The `provider_thread_id` column on the events table (and the threads table) is the continuity anchor: bb resolves "which provider session owns context at/after sequence N" via `getLastProviderThreadId` / `getProviderThreadIdAtOrBeforeSequence`.

### 3.3 When it is written — and who triggers compaction

- **Trigger owner: the provider.** bb's own trigger is manual-only: `POST /threads/:id/compact` → `compactThreadContext` gates on `supportsManualCompaction(thread.providerId)` (codex, claude-code, pi, acp-opencode — `packages/agent-providers/src/catalog.ts:445-448`), requires thread `idle|error`, and merely sends a standalone builtin `/compact` command into the provider session (`apps/server/src/routes/threads/actions.ts:131-161`). There is **no token threshold, no timer, no auto trigger in bb**; automatic compaction originates inside the provider and bb only observes it.
- **When written:** provider adapters translate native success signals into the normalized event — Codex `thread/compacted` (`packages/agent-runtime/src/codex/event-translation.ts:837-843`); Claude Code `status: "compacting"` item open/close + `compact_boundary` with `compact_metadata {pre_tokens, trigger}` consumed but **not persisted** (`packages/agent-runtime/src/claude-code/translate-message.ts:524-566, 280-284`; emitted with empty `providerThreadId`); pi adapter emits on successful `compaction_end` only — failed/aborted compactions emit **no marker** (`packages/agent-runtime/src/pi/adapter.ts:818-846`); ACP after a successful maintenance prompt (`packages/agent-runtime/src/acp/adapter.ts:1159-1163`); omp adapter only for successful *automatic* `compaction_end` (`packages/agent-runtime/src/omp/adapter.ts:1826-1830`).

### 3.4 Replay consumption — projection only, never context

Replay walks stored rows and treats `thread/compacted` as a **turn-keyed lifecycle `'end'` marker**: `parseCompactionLifecycleEvent` (`packages/thread-view/src/compaction-lifecycle.ts:29-51`; key derivation `:12-27`) renders a compaction banner in the timeline; the operation row parser maps it to a `'compaction'` op row (`packages/thread-view/src/parse-operation-message.ts:573-576`). **Nothing reconstructs model context from the log** — post-compaction continuity is delegated entirely to the provider session, tracked via `provider_thread_id`. Pre-compaction events remain in the log; the only stored-event deletion path is `deleteThreadEventSuffixInTransaction`, used by message editing, not compaction (`packages/db/src/data/events.ts:231-285`).

---

## Part 4 — Side-by-side map

| Dimension | **omp** (owns its transcript) | **bb** (control plane over providers) |
|---|---|---|
| Log substrate | append-only JSONL session file, typed `SessionEntry` stream (`session-entries.ts:120`) | SQLite `events` rows, append-only, UNIQUE(thread_id, sequence) (`0000_baseline.sql:107-131`) |
| Compaction write | full **content-bearing** `CompactionEntry`: summary, shortSummary, `firstKeptEntryId`, tokensBefore/After, method, preserveData (`session-entries.ts:120-127`, `session-manager.ts:2991-2999`) | content-free marker `thread/compacted {threadId, providerThreadId}` (`provider-event.ts:495-499`) |
| Written when | after omp's own engine summarizes (threshold/overflow/idle/manual), success only (failed methods advance to next) | when a provider reports compaction success; failed/aborted ⇒ no marker at all (`pi/adapter.ts:818-846`) |
| Trigger owner | omp itself: token threshold vs reserve math (`compaction.ts:364-413`), opt-in idle timer, speculative async, manual `/compact` | delegated to provider; bb offers manual `/compact` forwarding only, gated per provider (`catalog.ts:445-448`, `actions.ts:131-161`) |
| Replay consumption | context rebuild: summary overlay + entries from `firstKeptEntryId` onward (`session-context.ts:339-343`) | UI lifecycle banner only (`compaction-lifecycle.ts:29-51`); never feeds model context |
| Context continuity after compaction | self-contained: summary + retained tail re-sent every turn | outsourced: provider session addressed by stored `provider_thread_id` |
| What stays original on disk | everything; pre-boundary entries skipped at replay, kept for export/audit | everything; deletion exists only for message-edit suffix (`events.ts:231-285`) |
| Retention guarantees | machine-enforced: cut only at turn boundaries, tool results stay paired, keepRecentTokens tail, structured summary prompt with verbatim-preserve list | none — bb sees no content before/after; `compact_boundary` metadata (`pre_tokens`, trigger) is translated but not persisted |
| Token accounting | estimator + provider usage, divergence floored (`compaction.ts:370-387`); tokensBefore/After recorded | nothing persisted from `compact_boundary.pre_tokens` — the adapter parses `compact_metadata` then emits an event built from `{threadId, turnId}` only (`translate-message.ts:564-576`) |
| Summary-chain semantics | previous summary reused as input to next compaction, reset at `/clear` (`compact-reset-boundary.test.ts:71-99`) | N/A — chain lives entirely inside the provider session |

---

## Part 5 — Gaps: where neither source speaks (true #75 HITL residual)

These are the questions **neither** source answers; they are the residual a grilling pass on #75 must rule on. Everything else above is already decided by code.

1. **⚠ No portable checkpoint contract.** omp's checkpoint is only replayable by omp (boundary ids point into omp's entry-id namespace; `preserveData` is provider-opaque). bb's marker carries no content. Neither defines an interchange record a *third* harness could replay (summary digest, boundary anchor semantics, summarizer-model provenance, verification). If #75 wants cross-harness resume, this schema must be invented — neither source constrains it beyond the two existence proofs.
2. **⚠ Summary fidelity is prompt-enforced, not machine-checked.** omp's retention guarantees ("MUST preserve exact file paths / unanswered questions / repo state") live in prompt text (`compaction-summary.md:1-38`); there is no validator that the produced summary actually retained them, and bb has no view at all. A HITL gate ("was anything load-bearing lost?") has no observable to check today.
3. **⚠ No pre-compaction approval hook anywhere.** omp emits lifecycle events (`auto_compaction_start/end`) and can auto-continue, but there is no gate where a human (or policy) can approve/veto destruction of context; bb structurally cannot intervene in provider-auto compaction — it only learns after the fact. If #75 requires human-in-the-loop *before* compaction, neither codebase offers an insertion point without new plumbing.
4. **⚠ Post-compaction continuity-anchor loss.** omp recovers by re-expanding its own originals into a portable summary when the native replay payload is unusable by the active model (`anthropic-native-compaction.test.ts:611-615`, `remote-compaction.test.ts:2481-2485`). bb has **no** answer: if the provider session behind `provider_thread_id` is gone/expired, the event log cannot rebuild context — the checkpoint was never content-bearing. Neither source defines recovery semantics for that failure.
5. **⚠ Summary-of-summary chain policy.** omp chains `previousSummary` into successive compactions but sets no depth bound, no decay check, no drift audit; bb is silent (chain lives in the provider). Whether unbounded chaining is acceptable is an open ruling for #75.
6. **⚠ Reclaimed-token accountability.** omp records estimator-based `tokensBefore/tokensAfter` for display; bb drops `pre_tokens` on the floor. Neither provides a verified account of "how much context was actually freed" that a policy gate could consume.

**Net for #75:** items 2, 3, 4 are where a HITL admission gate would bind first — (2) gives it an observable to audit, (3) gives it a decision point, (4) gives it a failure mode to own. Item 1 is the design work if cross-harness replay is in scope; 5–6 are policy rulings.
