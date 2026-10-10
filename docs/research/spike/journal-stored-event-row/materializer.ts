/**
 * #554 spike: journal→StoredEventRow materializer sketch.
 *
 * Maps a ux-journal window (@cap/protocol ThreadEventEnvelope[], the exact
 * output of packages/agent-do/src/ux-projection.ts) onto the bb event
 * vocabulary (ThreadEventRow = StoredEventRow + scope), so bb thread-view's
 * buildThreadTimelineFromEvents can consume it verbatim.
 *
 * DECISIONS (documented per type in the report):
 * - turn/phase has no bb equivalent → dropped (current timeline.ts ignores it
 *   too; zero row delta).
 * - ux item/started{userMessage} → synthesized bb client/turn/requested +
 *   turn/input/accepted pair (bb builds user rows from the request path, not
 *   from userMessage items). clientRequestId is synthesized (`req-<seq>`) —
 *   the ux face does not carry it; the roadmap cut materializes inside the DO
 *   from the raw journal where turn.input carries inputId.
 * - agentMessage/reasoning item/started rows are dropped (bb ignores them;
 *   deltas build the rows).
 * - ux toolCall.output → bb toolCall.result; ux errorCode dropped (bb has no
 *   code slot; the ux row face never rendered it either).
 * - ux commandExecution.output/cwd/exitCode reshaped onto
 *   aggregatedOutput/cwd:string/exitCode?:number (schema reshape; no current
 *   ux producer).
 * - thread/compacted rides as the bare bb marker (payload dropped; bb schema
 *   is content-free). The ux projection already emits the estimated
 *   contextWindowUsage companion row, which materializes 1:1.
 * - providerThreadId is synthesized ("ux-journal") where bb requires it; the
 *   projection reads it only for provider display names on provider-unhandled
 *   rows, which ux journals cannot produce.
 * - system/error maps {message}; ux `category` has no bb slot (stripped by
 *   bb's schema either way).
 */
import type { ThreadEventEnvelope } from "@cap/protocol";
import {
  threadEventScopeSchema,
  type ThreadEventRow,
  type ThreadEventScope,
} from "@bb/domain";

const SYNTHETIC_PROVIDER_THREAD_ID = "ux-journal";

const rowId = (envelope: ThreadEventEnvelope): string =>
  // The ux projection can emit several envelopes sharing one journal row id
  // (extraUx pairs share the journal seq+id). The bb meta.id is not load-
  // bearing for any row family (row ids derive from seq/callId), so a suffix
  // keeps ids unique without changing any projected row.
  `${envelope.id}#${envelope.seq}`;

const turnScope = (turnId: string): ThreadEventScope =>
  threadEventScopeSchema.parse({ kind: "turn", turnId });

const row = (
  envelope: ThreadEventEnvelope,
  type: ThreadEventRow["type"],
  scope: ThreadEventScope,
  data: Record<string, unknown>,
): ThreadEventRow => ({
  id: rowId(envelope),
  scope,
  threadId: envelope.threadId,
  seq: envelope.seq,
  createdAt: envelope.createdAt,
  type,
  // bb persists providerThreadId as a data member (stored-thread-event.ts
  // Omit<TEvent, "threadId" | "type" | "scope">); buildThreadEvent re-reads it
  // from there. Overridable per row (turn/completed stores null).
  data: { providerThreadId: SYNTHETIC_PROVIDER_THREAD_ID, ...data },
});

// clientTurnRequestIdSchema: /^creq_[23456789abcdefghijkmnpqrstuvwxyz]{10}$/
// — the synthesized id must satisfy bb's pattern, so the ux seq encodes
// base-31 over the allowed alphabet (injective for any real journal seq).
const REQUEST_ID_ALPHABET = "23456789abcdefghijkmnpqrstuvwxyz";
function encodeRequestId(seq: number): string {
  let out = "";
  let value = seq;
  for (let index = 0; index < 10; index += 1) {
    out = REQUEST_ID_ALPHABET[value % REQUEST_ID_ALPHABET.length] + out;
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
  envelope: ThreadEventEnvelope,
  turnId: string,
  item: Record<string, unknown>,
): ThreadEventRow[] {
  const kind = userMessageRequestKind(String(item.id));
  if (kind === null) return [];
  const requestId = encodeRequestId(envelope.seq);
  const input = requestInput(item.content as readonly unknown[]);
  const requested: ThreadEventRow = row(envelope, "client/turn/requested", threadEventScopeSchema.parse({ kind: "thread" }), {
    direction: "outbound",
    requestId,
    source: "tell",
    initiator: "user",
    senderThreadId: null,
    input,
    target:
      kind === "steer"
        ? { kind: "steer", expectedTurnId: turnId }
        : { kind: "new-turn" },
    request: { method: "turn/start", params: {} },
    execution: synthesizedExecution,
  });
  const accepted: ThreadEventRow = row(envelope, "turn/input/accepted", turnScope(turnId), {
    clientRequestId: requestId,
  });
  return [requested, accepted];
}

function itemStartedRows(
  envelope: ThreadEventEnvelope,
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
      // bb's Thought row (reasoning-lifecycle) opens at item/started{reasoning}
      // (assistant-event-projection.ts:75-79 trackReasoningTurn) — the start
      // is row-suppressed but lifecycle-load-bearing.
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
  envelope: ThreadEventEnvelope,
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
            // bb suppresses parented messages from the root unless the parent
            // is a delegation row (normalize-event-projection.ts
            // isRootSuppressedContext). ux B1 attribution points at the
            // PRODUCING tool call — keep it only for delegation parents,
            // where bb nests the row instead of losing it.
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
 * The materializer: ux window → bb ThreadEventRow window (pure, in-memory).
 * Projection-consumable via decodeThreadEventRow → buildThreadTimelineFromEvents.
 */
export function materializeUxWindowToStoredEventRows(
  envelopes: readonly ThreadEventEnvelope[],
): ThreadEventRow[] {
  const rows: ThreadEventRow[] = [];
  // Pre-scan: delegation row ids (the synthetic spawnAgent toolCall items).
  // Attribution decisions (imageView B1 parentToolCallId) need the full-window
  // set because ux journals place attributed rows before the delegation row.
  const delegationCallIds = new Set<string>();
  for (const envelope of envelopes) {
    if (envelope.type !== "item/started") continue;
    const item = envelope.data.item;
    if (
      item !== undefined &&
      typeof item === "object" &&
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
    const data =
      envelope.data !== null && typeof envelope.data === "object"
        ? (envelope.data as Record<string, unknown>)
        : {};
    const turnId = typeof data.turnId === "string" ? data.turnId : undefined;
    switch (envelope.type) {
      case "item/started": {
        const item = data.item as Record<string, unknown> | undefined;
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
        const item = data.item as Record<string, unknown> | undefined;
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
        const error =
          data.error !== null && data.error !== undefined
            ? { message: String((data.error as Record<string, unknown>).message) }
            : undefined;
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
        const item = data.item as Record<string, unknown> | undefined;
        if (item === undefined) break;
        rows.push(
          row(envelope, envelope.type, threadEventScopeSchema.parse({ kind: "thread" }), {
            item,
          }),
        );
        break;
      }
      case "thread/contextWindowUsage/updated": {
        rows.push(
          row(
            envelope,
            "thread/contextWindowUsage/updated",
            threadEventScopeSchema.parse({ kind: "thread" }),
            { contextWindowUsage: data.contextWindowUsage },
          ),
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
        rows.push(
          row(envelope, "system/error", threadEventScopeSchema.parse({ kind: "thread" }), {
            message: data.message,
          }),
        );
        break;
      }
      case "turn/phase":
      case "client/thread/start":
      case "client/turn/requested":
        // turn/phase: no bb type (timeline.ts ignores it too).
        // client/*: never produced by the ux projection.
        break;
    }
  }
  return rows;
}
