import type { DaemonThreadEventInput, ThreadEventEnvelope } from "@cap/protocol";
import type { AssistantMessage, Message, ToolResultMessage } from "@earendil-works/pi-ai";
import type { AgentEvent, CompactionReason, EntryRecord } from "@earendil-works/pi-durable";

export interface ThreadEventSink {
  /** Idempotent by `input.id`; returns the stored (or existing) envelope. */
  append(input: DaemonThreadEventInput): Promise<ThreadEventEnvelope>;
  /** Adapter seq for an already-appended source id (EntryId → hideThroughSeq). */
  findSeq(id: string): Promise<number | undefined>;
}

function stableHash(value: unknown): string {
  const text = JSON.stringify(value);
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function textOf(content: readonly { type: string; text?: string }[]): string {
  return content
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text ?? "")
    .join("");
}

function assistantMessage(entry: EntryRecord): AssistantMessage | undefined {
  const message: Message | undefined = entry.model?.[0];
  return message?.role === "assistant" ? message : undefined;
}

function toolResultMessage(entry: EntryRecord | undefined): ToolResultMessage | undefined {
  const message = entry?.model?.[0];
  return message?.role === "toolResult" ? message : undefined;
}

/**
 * pi-durable `watchEvents` → cap's frozen UX envelope union (#575). The
 * bridge owns the adapter seq; `ThreadEventSink` persists rows and dedups by
 * source id, so replaying a batch after an adapter restart is a no-op.
 *
 * Deliberately omitted (parity by omission, #575): live tool-output deltas,
 * retry backoff, inbox queue, context-window fill, and subagent fan-in.
 */
export class PiEventBridge {
  readonly #threadId: string;
  readonly #sink: ThreadEventSink;
  readonly #now: () => number;
  #turnOrdinal = 0;
  #modelCallOrdinal = 0;
  #currentTurnId: string | undefined;
  #currentModelCallId: string | undefined;
  #turnFailed = false;
  #turnError: string | undefined;
  readonly #compactionReason = new Map<string, CompactionReason>();

  constructor(options: { threadId: string; sink: ThreadEventSink; now?: () => number }) {
    this.#threadId = options.threadId;
    this.#sink = options.sink;
    this.#now = options.now ?? Date.now;
  }

  async ingest(events: readonly AgentEvent[]): Promise<ThreadEventEnvelope[]> {
    const appended: ThreadEventEnvelope[] = [];
    for (const event of events) {
      const batch = await this.#translate(event);
      appended.push(...batch);
    }
    return appended;
  }

  #turnId(): string {
    if (this.#currentTurnId === undefined) {
      this.#turnOrdinal += 1;
      this.#currentTurnId = `turn-${this.#threadId}-${this.#turnOrdinal}`;
    }
    return this.#currentTurnId;
  }

  #modelCallId(): string {
    if (this.#currentModelCallId === undefined) {
      this.#modelCallOrdinal += 1;
      this.#currentModelCallId = `mc-${this.#modelCallOrdinal}`;
    }
    return this.#currentModelCallId;
  }

  async #append(input: {
    id: string;
    type: DaemonThreadEventInput["type"];
    data: Record<string, unknown>;
  }): Promise<ThreadEventEnvelope> {
    return this.#sink.append({
      ...input,
      threadId: this.#threadId,
      createdAt: this.#now(),
    });
  }

  async #translate(event: AgentEvent): Promise<ThreadEventEnvelope[]> {
    switch (event.type) {
      case "turn_start": {
        this.#turnOrdinal += 1;
        this.#currentTurnId = `turn-${this.#threadId}-${this.#turnOrdinal}`;
        this.#currentModelCallId = undefined;
        this.#turnFailed = false;
        this.#turnError = undefined;
        return [
          await this.#append({
            id: `pi-turn-start-${this.#currentTurnId}`,
            type: "turn/started",
            data: { turnId: this.#currentTurnId },
          }),
        ];
      }
      case "message_start":
        this.#modelCallOrdinal += 1;
        this.#currentModelCallId = `mc-${this.#modelCallOrdinal}`;
        return [];
      case "message_update": {
        const turnId = this.#turnId();
        const callId = this.#modelCallId();
        const out: ThreadEventEnvelope[] = [];
        for (const [index, change] of event.changes.entries()) {
          if (change.type === "text_delta") {
            out.push(
              await this.#append({
                id: `pi-delta-${stableHash({
                  turnId,
                  callId,
                  kind: "text",
                  index,
                  contentIndex: change.contentIndex,
                  delta: change.delta,
                })}`,
                type: "item/agentMessage/delta",
                data: {
                  turnId,
                  itemId: `itm-am-${turnId}:${callId}`,
                  delta: change.delta,
                },
              }),
            );
          } else if (change.type === "thinking_delta") {
            out.push(
              await this.#append({
                id: `pi-delta-${stableHash({
                  turnId,
                  callId,
                  kind: "thinking",
                  index,
                  contentIndex: change.contentIndex,
                  delta: change.delta,
                })}`,
                type: "item/reasoning/textDelta",
                data: {
                  turnId,
                  itemId: `itm-rs-${turnId}:${callId}`,
                  delta: change.delta,
                },
              }),
            );
          }
        }
        return out;
      }
      case "message_end": {
        const turnId = this.#turnId();
        const message = assistantMessage(event.entry);
        if (message === undefined) return [];
        return [
          await this.#append({
            id: `pi-entry-${event.entry.id}`,
            type: "item/completed",
            data: {
              turnId,
              item: {
                type: "agentMessage",
                id: `itm-am-${turnId}:${this.#modelCallId()}`,
                text: textOf(message.content),
              },
            },
          }),
        ];
      }
      case "tool_execution_start":
        return [
          await this.#append({
            id: `pi-tool-start-${event.toolCallId}`,
            type: "item/started",
            data: {
              turnId: this.#turnId(),
              item: {
                type: "toolCall",
                id: event.toolCallId,
                tool: event.toolName,
                arguments: event.args,
                status: "pending",
                output: "",
                completedAt: null,
              },
            },
          }),
        ];
      case "tool_execution_end": {
        const result = toolResultMessage(event.entry);
        const status =
          result === undefined ? "interrupted" : result.isError ? "failed" : "completed";
        return [
          await this.#append({
            id: `pi-tool-end-${event.toolCallId}`,
            type: "item/completed",
            data: {
              turnId: this.#turnId(),
              item: {
                type: "toolCall",
                id: event.toolCallId,
                tool: event.toolName,
                arguments: {},
                status,
                output: result === undefined ? "" : textOf(result.content),
                completedAt: result?.timestamp ?? null,
              },
            },
          }),
        ];
      }
      case "task_failed": {
        this.#turnFailed = true;
        this.#turnError = event.message;
        return [
          await this.#append({
            id: `pi-task-failed-${event.taskId}-${stableHash(event.message)}`,
            type: "system/error",
            data: { message: event.message, category: "internal" },
          }),
        ];
      }
      case "turn_end": {
        const turnId = this.#turnId();
        return [
          await this.#append({
            id: `pi-turn-end-${turnId}`,
            type: "turn/completed",
            data: {
              turnId,
              status: this.#turnFailed ? "failed" : "completed",
              error: this.#turnFailed
                ? { category: "internal", message: this.#turnError ?? "turn failed" }
                : null,
            },
          }),
        ];
      }
      case "compaction_start":
        this.#compactionReason.set(String(event.taskId), event.reason);
        return [];
      case "entry_appended": {
        if (event.entry.kind !== "pi.compaction") return [];
        const head = event.entry.head;
        const hideThroughSeq =
          head === undefined ? 0 : ((await this.#sink.findSeq(`pi-entry-${head}`)) ?? 0);
        const reason = this.#compactionReason.get(String(event.entry.byTaskId));
        return [
          await this.#append({
            id: `pi-compacted-${event.entry.id}`,
            type: "thread/compacted",
            data: {
              turnId: this.#turnId(),
              hideThroughSeq,
              tokensBefore: null,
              tokensAfter: 0,
              contextWindow: null,
              method: reason === "manual" ? "manual" : "auto",
            },
          }),
        ];
      }
      // Parity by omission (#575): these events have no cap UX row.
      case "snapshot":
      case "run_start":
      case "run_end":
      case "tool_execution_update":
      case "inbox_update":
      case "submission":
      case "auto_retry_start":
      case "auto_retry_end":
      case "deferred_poll":
      case "agent_changed":
      case "usage_changed":
      case "compaction_end":
        return [];
      default:
        return [];
    }
  }
}
