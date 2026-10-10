/**
 * #560: ux-journal window → bb StoredEventRow materializer (production port
 * of docs/research/spike/journal-stored-event-row/materializer.ts, #554).
 *
 * Maps a ux view window (packages/agent-do/src/ux-projection.ts output —
 * the @cap/protocol thread-event envelope shape) onto the bb event
 * vocabulary (ThreadEventRow = StoredEventRow + scope), so bb thread-view's
 * buildThreadTimelineFromEvents consumes it verbatim. The projection switch
 * itself lives in apps/server-worker (services/thread-view.ts), which is the
 * only consumer; the materializer stays a pure function so the CI diff
 * harness can run it against the retired porting layer.
 *
 * DECISIONS (per #554 report §2/§3, all harness-verified there):
 * - turn/phase has no bb equivalent → dropped (the retired timeline.ts
 *   ignores it too; zero row delta).
 * - ux item/started{userMessage} → synthesized bb client/turn/requested +
 *   turn/input/accepted pair (bb builds user rows from the request path, not
 *   from userMessage items). clientRequestId is synthesized (`creq_` +
 *   base-31 seq — satisfies bb's clientTurnRequestIdSchema pattern); the ux
 *   face does not carry it. Roadmap cut: materialize inside the DO from the
 *   raw journal where turn.input carries inputId — eliminating both this
 *   synthesis and the userMessage id-prefix sniffing below.
 * - bb turn grouping requires turn/started before turn/input/accepted
 *   (group-event-projection-turns.ts throws otherwise); the ux journal
 *   writes turn.input before the first model call, so a new-turn request's
 *   acceptance is deferred onto the turn's turn/started seq (stable sort
 *   keeps it after). A turn that never starts drops its acceptance — the
 *   request then shows as bb-pending, the honest face for a dead window.
 * - agentMessage item/started rows are dropped (bb ignores them; deltas
 *   build the row). reasoning item/started rows are kept — bb's Thought
 *   lifecycle opens there (assistant-event-projection.ts:75-79); dropping
 *   the start loses the lifecycle (spike harness实证).
 * - ux toolCall.output → bb toolCall.result; ux errorCode dropped (no bb
 *   slot; the ux row face never rendered it either).
 * - ux commandExecution.output/cwd/exitCode reshaped onto
 *   aggregatedOutput/cwd:string/exitCode?:number (bb schema reshape; no
 *   current ux producer).
 * - thread/compacted rides as the bare bb marker (payload dropped; bb's
 *   schema is content-free). The ux projection's estimated
 *   contextWindowUsage companion row materializes separately.
 * - providerThreadId is synthesized ("ux-journal") where bb requires it;
 *   the projection reads it only for provider display names on
 *   provider-unhandled rows, which this stack renders cap-side (#560 D7).
 * - system/error maps {message}; ux `category` has no bb slot (stripped by
 *   bb's schema either way).
 * - D4 Thought rows ("Thought for Ns" op rows) are a cap extension the
 *   pinned bb projection does not materialize (reasoning only feeds the live
 *   activeThinking); they are synthesized on top of the bb projection in
 *   services/thread-view.ts. When the bb pin ships the upstream #3250 row
 *   creation side, this moves back upstream (ticket #560 D4 note).
 * - D5 batch anchors + delegation seals: see anchorAndSealPostPass below —
 *   the one cap delta handled inside the materializer, because it rewrites
 *   materialized rows before bb sees them.
 */
import { threadEventScopeSchema, type ThreadEventRow, type ThreadEventScope } from "@bb/domain";
// (#566: typed through bb's dist .d.ts — the pinned bb emits JS+declarations
// (lane/566-dist-build), so tsc sees only the declaration surface under this
// stack's stricter base flags, and workerd natively loads the dist JS that
// the vitest plugin's module pipeline externalizes bare specifiers to)

/**
 * Structural view of one ux journal envelope. The protocol union
 * (@cap/protocol ThreadEventEnvelope) and the server seam's UxThreadEvent
 * both satisfy this shape; the materializer narrows per type with runtime
 * guards exactly like the ux producers guarantee (schema-valid at write).
 */
export interface UxThreadEventEnvelope {
  id: string;
  threadId: string;
  seq: number;
  type: string;
  data: unknown;
  createdAt: number;
}

const SYNTHETIC_PROVIDER_THREAD_ID = "ux-journal";

/**
 * Narrow an untyped ux payload member to a record — the single `as` in this
 * file's shape handling (typeof proves object; members stay unknown and are
 * checked at each read).
 */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

/** The human message of a ux turn/completed error member, if present. */
function errorMessageOf(value: unknown): string | undefined {
  const record = asRecord(value);
  if (record === undefined || !("message" in record)) {
    return undefined;
  }
  return String(record.message);
}

/** The string `type` discriminator of a decoded bb event, if present. */
export function eventTypeOf(event: unknown): string | null {
  if (typeof event !== "object" || event === null || !("type" in event)) {
    return null;
  }
  const type: unknown = event.type;
  return typeof type === "string" ? type : null;
}

const rowId = (envelope: UxThreadEventEnvelope): string =>
  // The ux projection can emit several envelopes sharing one journal row id
  // (extraUx pairs share the journal seq+id). The bb meta.id is not load-
  // bearing for any row family (row ids derive from seq/callId), so a suffix
  // keeps ids unique without changing any projected row.
  `${envelope.id}#${envelope.seq}`;

const threadScope = (): ThreadEventScope => threadEventScopeSchema.parse({ kind: "thread" });

const turnScope = (turnId: string): ThreadEventScope =>
  threadEventScopeSchema.parse({ kind: "turn", turnId });

const row = (
  envelope: UxThreadEventEnvelope,
  type: ThreadEventRow["type"],
  scope: ThreadEventScope,
  data: Record<string, unknown>,
): ThreadEventRow =>
  // The static union cannot express "data payload valid for this type"
  // without duplicating bb's per-type schemas; the pairing is a runtime
  // contract — bb's decode (buildThreadEvent) re-validates every row through
  // its zod schema, so a mismatched payload throws at the projection
  // boundary instead of lying. #566: the cast replaced the #560 ambient
  // shim, which hid the real bb types from this program entirely.
  ({
    id: rowId(envelope),
    scope,
    threadId: envelope.threadId,
    seq: envelope.seq,
    createdAt: envelope.createdAt,
    type,
    // bb persists providerThreadId as a data member (stored-thread-event.ts
    // Omit<TEvent, "threadId" | "type" | "scope">); buildThreadEvent re-reads
    // it from there. Overridable per row (turn/completed stores null).
    data: { providerThreadId: SYNTHETIC_PROVIDER_THREAD_ID, ...data },
  }) as ThreadEventRow;

// clientTurnRequestIdSchema: /^creq_[23456789abcdefghijkmnpqrstuvwxyz]{10}$/
// — the synthesized id must satisfy bb's pattern, so the ux seq encodes
// base-31 over the allowed alphabet (injective for any real journal seq).
const REQUEST_ID_ALPHABET = "23456789abcdefghijkmnpqrstuvwxyz";
function encodeRequestId(seq: number): string {
  let out = "";
  let value = seq;
  for (let index = 0; index < 10; index += 1) {
    out = REQUEST_ID_ALPHABET.charAt(value % REQUEST_ID_ALPHABET.length) + out;
    value = Math.floor(value / REQUEST_ID_ALPHABET.length);
  }
  return `creq_${out}`;
}

/**
 * ux prompt-content parts are a subset of bb PromptInput (no visibility /
 * mentions members) — they flow through unchanged and bb's optional members
 * default.
 */
const requestInput = (content: readonly unknown[]): unknown[] => [...content];

const synthesizedExecution = {
  model: "unknown",
  serviceTier: "default",
  reasoningLevel: "medium",
  permissionMode: "accept-edits",
  source: "client/turn/requested",
} as const;

/**
 * ux userMessage items encode message vs steer in the id prefix
 * (itm-um-<turnId>:<seq> / itm-st-<turnId>:<seq> — ux-projection.ts). The
 * roadmap cut materializes inside the DO from the raw journal, where
 * turn.input vs turn.steer is a typed fact instead of an id prefix.
 */
const userMessageRequestKind = (itemId: string): "new-turn" | "steer" | null => {
  if (itemId.startsWith("itm-um-")) return "new-turn";
  if (itemId.startsWith("itm-st-")) return "steer";
  return null;
};

/**
 * ux item/started{userMessage} → the bb request pair that renders the user
 * row: client/turn/requested (thread scope) + turn/input/accepted (turn
 * scope). The latter feeds buildAcceptedClientRequestById so the projection
 * marks the row accepted and binds it to its turn.
 */
function requestRowsForUserMessage(
  envelope: UxThreadEventEnvelope,
  turnId: string,
  item: Record<string, unknown>,
): ThreadEventRow[] {
  const kind = userMessageRequestKind(String(item.id));
  if (kind === null) return [];
  const requestId = encodeRequestId(envelope.seq);
  const input = requestInput(Array.isArray(item.content) ? item.content : []);
  const requested: ThreadEventRow = row(envelope, "client/turn/requested", threadScope(), {
    direction: "outbound",
    requestId,
    source: "tell",
    initiator: "user",
    senderThreadId: null,
    input,
    target: kind === "steer" ? { kind: "steer", expectedTurnId: turnId } : { kind: "new-turn" },
    request: { method: "turn/start", params: {} },
    execution: synthesizedExecution,
  });
  const accepted: ThreadEventRow = row(envelope, "turn/input/accepted", turnScope(turnId), {
    clientRequestId: requestId,
  });
  return [requested, accepted];
}

function itemStartedRows(
  envelope: UxThreadEventEnvelope,
  turnId: string,
  item: Record<string, unknown>,
  delegationCallIds: ReadonlySet<string>,
): ThreadEventRow[] {
  switch (item.type) {
    case "userMessage":
      return requestRowsForUserMessage(envelope, turnId, item);
    case "agentMessage":
      // bb ignores agentMessage starts (isIgnoredItemStartEvent); deltas
      // build rows.
      return [];
    case "reasoning":
      // bb's Thought row lifecycle (reasoning-lifecycle-projection) opens at
      // item/started{reasoning} (assistant-event-projection.ts:75-79
      // trackReasoningTurn) — the start is row-suppressed at the pinned bb
      // but lifecycle-load-bearing (D4 synthesis rides the completion).
      return [
        row(envelope, "item/started", turnScope(turnId), {
          item: {
            type: "reasoning",
            id: item.id,
            summary: item.summary,
            content: item.content,
            ...(item.parentToolCallId !== undefined
              ? { parentToolCallId: item.parentToolCallId }
              : {}),
          },
        }),
      ];
    case "toolCall":
      return [
        row(envelope, "item/started", turnScope(turnId), {
          item: {
            type: "toolCall",
            id: item.id,
            ...(item.server !== undefined ? { server: item.server } : {}),
            tool: item.tool,
            arguments: item.arguments ?? {},
            status: item.status,
            ...(item.parentToolCallId !== undefined
              ? { parentToolCallId: item.parentToolCallId }
              : {}),
          },
        }),
      ];
    case "imageView":
      return [
        row(envelope, "item/started", turnScope(turnId), {
          item: {
            type: "imageView",
            id: item.id,
            path: item.path,
            // D5 imageView attribution gate: bb suppresses parented rows
            // from the root unless the parent is a delegation row
            // (normalize-event-projection.ts isRootSuppressedContext).
            // ux attribution points at the PRODUCING tool call — keep it
            // only for delegation parents, where bb nests the row instead
            // of losing it.
            ...(typeof item.parentToolCallId === "string" &&
            delegationCallIds.has(item.parentToolCallId)
              ? { parentToolCallId: item.parentToolCallId }
              : {}),
          },
        }),
      ];
    case "commandExecution":
      return [
        row(envelope, "item/started", turnScope(turnId), {
          item: {
            type: "commandExecution",
            id: item.id,
            command: item.command,
            // bb requires a string cwd; ux nulls coalesce to "".
            cwd: typeof item.cwd === "string" ? item.cwd : "",
            status: item.status,
            approvalStatus: null,
            ...(typeof item.output === "string" && item.output.length > 0
              ? { aggregatedOutput: item.output }
              : {}),
            ...(typeof item.exitCode === "number" ? { exitCode: item.exitCode } : {}),
          },
        }),
      ];
    default:
      return [];
  }
}

function itemCompletedRows(
  envelope: UxThreadEventEnvelope,
  turnId: string,
  item: Record<string, unknown>,
  delegationCallIds: ReadonlySet<string>,
): ThreadEventRow[] {
  switch (item.type) {
    case "agentMessage":
      return [
        row(envelope, "item/completed", turnScope(turnId), {
          item: {
            type: "agentMessage",
            id: item.id,
            text: item.text,
            ...(item.parentToolCallId !== undefined
              ? { parentToolCallId: item.parentToolCallId }
              : {}),
          },
        }),
      ];
    case "reasoning":
      return [
        row(envelope, "item/completed", turnScope(turnId), {
          item: {
            type: "reasoning",
            id: item.id,
            summary: item.summary,
            content: item.content,
            ...(item.parentToolCallId !== undefined
              ? { parentToolCallId: item.parentToolCallId }
              : {}),
          },
        }),
      ];
    case "toolCall":
      return [
        row(envelope, "item/completed", turnScope(turnId), {
          item: {
            type: "toolCall",
            id: item.id,
            tool: item.tool,
            arguments: item.arguments ?? {},
            status: item.status,
            // ux output string → bb result; formatToolCallResultOutput is
            // identity for every ux tool name (only baseToolName "Agent"
            // rewrites, and ux delegation rows carry "spawnAgent").
            ...(typeof item.output === "string" && item.output.length > 0
              ? { result: item.output }
              : {}),
            ...(item.parentToolCallId !== undefined
              ? { parentToolCallId: item.parentToolCallId }
              : {}),
          },
        }),
      ];
    case "imageView":
      return [
        row(envelope, "item/completed", turnScope(turnId), {
          item: {
            type: "imageView",
            id: item.id,
            path: item.path,
            // Same D5 gate as the start row: delegation parents only.
            ...(typeof item.parentToolCallId === "string" &&
            delegationCallIds.has(item.parentToolCallId)
              ? { parentToolCallId: item.parentToolCallId }
              : {}),
          },
        }),
      ];
    case "commandExecution":
      return [
        row(envelope, "item/completed", turnScope(turnId), {
          item: {
            type: "commandExecution",
            id: item.id,
            command: item.command,
            cwd: typeof item.cwd === "string" ? item.cwd : "",
            status: item.status,
            approvalStatus: null,
            ...(typeof item.output === "string" && item.output.length > 0
              ? { aggregatedOutput: item.output }
              : {}),
            ...(typeof item.exitCode === "number" ? { exitCode: item.exitCode } : {}),
          },
        }),
      ];
    default:
      return [];
  }
}

/**
 * D5 post-pass (#554 report §4-D5): batch-spawn anchors + background
 * delegation seals.
 *
 * Background `item/backgroundTask/completed` rows carry the SPAWNING task
 * call's bare executionId as parentToolCallId (tools/task/executor.ts: the
 * delegation anchor is deliberately un-suffixed even for batch items, where
 * per-item delegation rows are `<call>#<i>`). The retired porting layer
 * resolved the seal target with a prefix fallback in plan order
 * (timeline.ts delegationTargetFor — "each settle seals exactly one row");
 * bb matches parentToolCallId exactly and ROOT-SUPPRESSES rows whose parent
 * is not a delegation. Left alone, batch settles would both vanish (workflow
 * row suppressed) and leave the delegation rows pending forever.
 *
 * Same mechanism as the imageView attribution gate, one step earlier: for
 * each completed row, resolve the seal target — exact delegation callId, or
 * the k-th `<anchor>#…` per-item row in plan order (k = settle count for the
 * anchor; the porting layer's pending-consumption order is plan order, so
 * the static assignment is equivalent) — rewrite the workflow row's
 * parentToolCallId to it, and synthesize the `item/completed{toolCall
 * spawnAgent}` seal the bb delegation row lifecycle needs (background
 * spawns never emit one; first-terminal-wins #275 J3 skips targets a
 * materialized completion already sealed).
 */
function anchorAndSealPostPass(rows: ThreadEventRow[]): void {
  // Delegation rows in plan order (materialization order = seq order), with
  // the turn each item/started rode (the seal's scope).
  const delegationPlan: { callId: string; turnId: string }[] = [];
  const delegationCallIds = new Set<string>();
  // Materialized spawnAgent completions — blocking settles; a target here is
  // already sealed and first-terminal-wins keeps it.
  const sealedCallIds = new Set<string>();
  for (const materialized of rows) {
    if (materialized.type === "item/started") {
      const item = asRecord(materialized.data.item);
      if (item?.type === "toolCall" && item.tool === "spawnAgent" && typeof item.id === "string") {
        const turnId = materialized.scope.kind === "turn" ? materialized.scope.turnId : null;
        if (turnId !== null) {
          delegationPlan.push({ callId: item.id, turnId });
          delegationCallIds.add(item.id);
        }
      }
      continue;
    }
    if (materialized.type === "item/completed") {
      const item = asRecord(materialized.data.item);
      if (item?.type === "toolCall" && item.tool === "spawnAgent" && typeof item.id === "string") {
        sealedCallIds.add(item.id);
      }
    }
  }

  const sealsPerAnchor = new Map<string, number>();
  for (const materialized of rows) {
    if (
      materialized.type !== "item/backgroundTask/completed" ||
      materialized.scope.kind !== "thread"
    ) {
      continue;
    }
    const item = materialized.data.item as Record<string, unknown> | undefined;
    if (item === undefined) {
      continue;
    }
    const anchor = item.parentToolCallId;
    let target: { callId: string; turnId: string } | undefined;
    if (typeof anchor === "string" && delegationCallIds.has(anchor)) {
      target = delegationPlan.find((plan) => plan.callId === anchor);
    } else if (typeof anchor === "string") {
      const prefix = `${anchor}#`;
      const settledSoFar = sealsPerAnchor.get(anchor) ?? 0;
      const candidates = delegationPlan.filter((plan) => plan.callId.startsWith(prefix));
      target = candidates[settledSoFar];
      if (target !== undefined) {
        // The k-th settle rides the k-th per-item row (plan-order parity
        // with delegationTargetFor's pending consumption).
        item.parentToolCallId = target.callId;
        sealsPerAnchor.set(anchor, settledSoFar + 1);
      }
    }
    if (
      target === undefined ||
      sealedCallIds.has(target.callId) ||
      (item.status !== "completed" && item.status !== "failed" && item.status !== "interrupted")
    ) {
      continue;
    }
    sealedCallIds.add(target.callId);
    rows.push({
      id: `${materialized.id}:seal`,
      scope: turnScope(target.turnId),
      threadId: materialized.threadId,
      seq: materialized.seq,
      createdAt: materialized.createdAt,
      type: "item/completed",
      data: {
        providerThreadId: SYNTHETIC_PROVIDER_THREAD_ID,
        item: {
          type: "toolCall",
          id: target.callId,
          tool: "spawnAgent",
          arguments: {},
          status: item.status,
          ...(typeof item.summary === "string" && item.summary.length > 0
            ? { result: item.summary }
            : {}),
        },
      },
    });
  }
}

/**
 * The materializer: ux window → bb ThreadEventRow window (pure, in-memory).
 * Projection-consumable via decodeThreadEventRow → buildThreadTimelineFromEvents.
 */
export function materializeUxWindowToStoredEventRows(
  envelopes: readonly UxThreadEventEnvelope[],
): ThreadEventRow[] {
  const rows: ThreadEventRow[] = [];
  // Pre-scan: delegation row ids (the synthetic spawnAgent toolCall items).
  // Attribution decisions (imageView D5 parentToolCallId gate) need the
  // full-window set because ux journals place attributed rows before the
  // delegation row.
  const delegationCallIds = new Set<string>();
  for (const envelope of envelopes) {
    if (envelope.type !== "item/started") continue;
    const data = envelopeData(envelope);
    const item = asRecord(data.item);
    if (
      item !== undefined &&
      "tool" in item &&
      item.tool === "spawnAgent" &&
      "id" in item &&
      typeof item.id === "string"
    ) {
      delegationCallIds.add(item.id);
    }
  }
  // bb's turn grouping requires turn/started to precede turn/input/accepted
  // in seq order. The ux journal writes turn.input before the first model
  // call (turn/started), so a new-turn request pair defers its acceptance
  // row until the turn's turn/started materializes.
  const acceptedPendingTurnStart = new Map<string, ThreadEventRow[]>();
  const startedTurnIds = new Set<string>();
  for (const envelope of envelopes) {
    const data = envelopeData(envelope);
    const turnId = typeof data.turnId === "string" ? data.turnId : undefined;
    switch (envelope.type) {
      case "item/started": {
        const item = asRecord(data.item);
        if (item === undefined || typeof turnId !== "string") break;
        for (const emittedRow of itemStartedRows(envelope, turnId, item, delegationCallIds)) {
          if (emittedRow.type === "turn/input/accepted" && !startedTurnIds.has(turnId)) {
            const pending = acceptedPendingTurnStart.get(turnId) ?? [];
            pending.push(emittedRow);
            acceptedPendingTurnStart.set(turnId, pending);
            continue;
          }
          rows.push(emittedRow);
        }
        break;
      }
      case "item/completed": {
        const item = asRecord(data.item);
        if (item === undefined || typeof turnId !== "string") break;
        rows.push(...itemCompletedRows(envelope, turnId, item, delegationCallIds));
        break;
      }
      case "item/agentMessage/delta":
      case "item/reasoning/textDelta": {
        if (typeof turnId !== "string") break;
        rows.push(
          row(envelope, envelope.type, turnScope(turnId), {
            itemId: data.itemId,
            delta: data.delta,
            ...(data.parentToolCallId !== undefined
              ? { parentToolCallId: data.parentToolCallId }
              : {}),
          }),
        );
        break;
      }
      case "turn/started": {
        if (typeof turnId !== "string") break;
        startedTurnIds.add(turnId);
        rows.push(
          row(envelope, "turn/started", turnScope(turnId), {
            providerThreadId: SYNTHETIC_PROVIDER_THREAD_ID,
          }),
        );
        for (const accepted of acceptedPendingTurnStart.get(turnId) ?? []) {
          // getOrderedThreadEvents sorts by meta.seq (stable), so a deferred
          // acceptance must ride the turn/started seq to stay after it; the
          // user row's own bounds use the request row's original seq.
          accepted.seq = envelope.seq;
          rows.push(accepted);
        }
        acceptedPendingTurnStart.delete(turnId);
        break;
      }
      case "turn/completed": {
        if (typeof turnId !== "string") break;
        const errorMessage = errorMessageOf(data.error);
        const error = errorMessage !== undefined ? { message: errorMessage } : undefined;
        rows.push(
          row(envelope, "turn/completed", turnScope(turnId), {
            providerThreadId: null,
            status: data.status,
            ...(error !== undefined ? { error } : {}),
          }),
        );
        break;
      }
      case "item/backgroundTask/progress":
      case "item/backgroundTask/completed": {
        const item = asRecord(data.item);
        if (item === undefined) break;
        rows.push(
          row(envelope, envelope.type, threadScope(), {
            item,
          }),
        );
        break;
      }
      case "thread/contextWindowUsage/updated": {
        rows.push(
          row(envelope, "thread/contextWindowUsage/updated", threadScope(), {
            contextWindowUsage: data.contextWindowUsage,
          }),
        );
        break;
      }
      case "thread/compacted": {
        if (typeof turnId !== "string") break;
        // Bare marker: bb's schema carries no payload. The estimated usage
        // companion row (emitted by the ux projection at the same seq)
        // materializes separately above/below.
        rows.push(
          row(envelope, "thread/compacted", turnScope(turnId), {
            providerThreadId: SYNTHETIC_PROVIDER_THREAD_ID,
          }),
        );
        break;
      }
      case "system/error": {
        rows.push(row(envelope, "system/error", threadScope(), { message: data.message }));
        break;
      }
      case "turn/phase":
      case "client/thread/start":
      case "client/turn/requested":
        // turn/phase: no bb type (the retired timeline.ts ignores it too).
        // client/*: never produced by the ux projection.
        break;
    }
  }
  anchorAndSealPostPass(rows);
  return rows;
}

function envelopeData(envelope: UxThreadEventEnvelope): Record<string, unknown> {
  return asRecord(envelope.data) ?? {};
}
