/**
 * #560 fixture: a representative ux-journal window, built through
 * @cap/protocol's buildThreadEvent so every envelope is schema-valid exactly
 * like packages/agent-do/src/ux-projection.ts output (same shapes, same
 * synthetic id conventions: itm-um-/itm-st-/itm-am-/itm-rs-/itm-iv-).
 *
 * Ported from the #554 spike fixture
 * (docs/research/spike/journal-stored-event-row/fixture.ts, lane-554) with
 * the #560 additions: a BATCH spawn (per-item `#i` delegation anchors) and
 * the backgroundTask seal synthesis case (D5).
 *
 * Covering: user message + steer, turn lifecycle, agentMessage deltas +
 * completion, reasoning deltas + completion, toolCall lifecycle, imageView
 * pair (non-delegation attribution — the D5 gate), delegation (spawnAgent)
 * with attributed child rows and the backgroundTask family (J3), batch
 * spawn + background settle, context-window usage, compact checkpoint +
 * estimated usage, system/error, turn/phase.
 */
import { buildThreadEvent } from "@cap/protocol";
import type { ThreadEventEnvelope, ThreadEventType } from "@cap/protocol";

const THREAD = "thr_560harness";
let seq = 0;

const env = (
  type: ThreadEventType,
  data: Record<string, unknown>,
  opts: { id?: string; createdAt?: number } = {},
): ThreadEventEnvelope =>
  // Fixture payloads are written loosely; the ux projection re-validates
  // every envelope through threadEventDataSchemas downstream, and the
  // protocol constructor itself casts its args the same way.
  buildThreadEvent({
    id: opts.id ?? `evt-${String(seq).padStart(4, "0")}`,
    threadId: THREAD,
    seq: ++seq,
    type,
    data,
    createdAt: opts.createdAt ?? 1_700_000_000_000 + seq * 1_000,
  } as Parameters<typeof buildThreadEvent>[0]);

const T1 = "turn_0001";
const T2 = "turn_0002";
const BATCH_ANCHOR = "exec_batch_call";

export const uxJournal: ThreadEventEnvelope[] = [
  // --- turn 1: user message ------------------------------------------------
  env("item/started", {
    turnId: T1,
    item: {
      type: "userMessage",
      id: `itm-um-${T1}:${seq}`,
      content: [{ type: "text", text: "List the workspace and summarize." }],
    },
  }),
  env("turn/started", { turnId: T1 }),
  env("item/reasoning/textDelta", {
    turnId: T1,
    itemId: `itm-rs-${T1}:1`,
    delta: "I should inspect the workspace first. ",
  }),
  env("item/reasoning/textDelta", {
    turnId: T1,
    itemId: `itm-rs-${T1}:1`,
    delta: "Then summarize findings.",
  }),
  env("item/agentMessage/delta", {
    turnId: T1,
    itemId: `itm-am-${T1}:1`,
    delta: "Inspecting the workspace",
  }),
  env("item/agentMessage/delta", {
    turnId: T1,
    itemId: `itm-am-${T1}:1`,
    delta: " now.",
  }),
  env("item/completed", {
    turnId: T1,
    item: {
      type: "reasoning",
      id: `itm-rs-${T1}:1`,
      summary: [],
      content: ["I should inspect the workspace first. Then summarize findings."],
    },
  }),
  env("item/completed", {
    turnId: T1,
    item: {
      type: "agentMessage",
      id: `itm-am-${T1}:1`,
      text: "Inspecting the workspace now.",
    },
  }),
  env("thread/contextWindowUsage/updated", {
    contextWindowUsage: { usedTokens: 4_200, modelContextWindow: 200_000, estimated: false },
  }),
  // tool call + imageView (attributed to the PRODUCING tool call, not a
  // delegation — the D5 imageView gate keeps the row from being suppressed)
  env("item/started", {
    turnId: T1,
    item: {
      type: "toolCall",
      id: "exec_0009",
      tool: "read",
      arguments: { path: "/workspace/README.md" },
      status: "pending",
      output: "",
      completedAt: null,
    },
  }),
  env("item/started", {
    turnId: T1,
    item: {
      type: "imageView",
      id: `itm-iv-${T1}:${seq + 1}`,
      path: "/workspace/shot.png",
      parentToolCallId: "exec_0009",
    },
  }),
  env("item/completed", {
    turnId: T1,
    item: {
      type: "imageView",
      id: `itm-iv-${T1}:${seq}`,
      path: "/workspace/shot.png",
      parentToolCallId: "exec_0009",
    },
  }),
  env("item/completed", {
    turnId: T1,
    item: {
      type: "toolCall",
      id: "exec_0009",
      tool: "read",
      arguments: {},
      status: "completed",
      output: "# Workspace\nhello world",
      completedAt: 1_700_000_000_000 + (seq + 1) * 1_000,
    },
  }),
  env("turn/completed", { turnId: T1, status: "completed", error: null }),

  // --- turn 2: steer + delegation + background family -----------------------
  env("item/started", {
    turnId: T2,
    item: {
      type: "userMessage",
      id: `itm-st-${T2}:${seq + 1}`,
      content: [{ type: "text", text: "Also spawn a scout for the docs." }],
    },
  }),
  env("turn/started", { turnId: T2 }),
  env("item/agentMessage/delta", {
    turnId: T2,
    itemId: `itm-am-${T2}:2`,
    delta: "Spawning the scout.",
  }),
  env("item/completed", {
    turnId: T2,
    item: { type: "agentMessage", id: `itm-am-${T2}:2`, text: "Spawning the scout." },
  }),
  env("item/started", {
    turnId: T2,
    item: {
      type: "toolCall",
      id: "exec_0014",
      tool: "bash",
      arguments: { command: "ls -la", cwd: "/workspace" },
      status: "pending",
      output: "",
      completedAt: null,
    },
  }),
  env("item/completed", {
    turnId: T2,
    item: {
      type: "toolCall",
      id: "exec_0014",
      tool: "bash",
      arguments: {},
      status: "completed",
      output: "README.md\nsrc",
      completedAt: 1_700_000_000_000 + (seq + 1) * 1_000,
    },
  }),
  // delegation row (synthetic spawnAgent toolCall from task.spawn_planned)
  env("item/started", {
    turnId: T2,
    item: {
      type: "toolCall",
      id: "exec_0016",
      tool: "spawnAgent",
      arguments: {
        senderThreadId: THREAD,
        receiverThreadIds: ["thr_child560"],
        description: "Scout the docs folder",
        subagent_type: "scout",
      },
      status: "pending",
      output: "",
      completedAt: null,
    },
  }),
  // J5 attributed child rows
  env("item/started", {
    turnId: T2,
    item: {
      type: "toolCall",
      id: "child_exec_1",
      tool: "glob",
      arguments: { pattern: "**/*.md" },
      status: "pending",
      output: "",
      completedAt: null,
      parentToolCallId: "exec_0016",
    },
  }),
  env("item/completed", {
    turnId: T2,
    item: {
      type: "toolCall",
      id: "child_exec_1",
      tool: "glob",
      arguments: {},
      status: "completed",
      output: "docs/a.md",
      completedAt: 1_700_000_000_000 + (seq + 1) * 1_000,
      parentToolCallId: "exec_0016",
    },
  }),
  env("item/completed", {
    turnId: T2,
    item: {
      type: "reasoning",
      id: "child_rs_1",
      summary: [],
      content: ["Child CoT text."],
      parentToolCallId: "exec_0016",
    },
  }),
  env("item/completed", {
    turnId: T2,
    item: {
      type: "agentMessage",
      id: "child_am_1",
      text: "Child answer text.",
      parentToolCallId: "exec_0016",
    },
  }),
  // background family (J3): parked → revived → settled
  env("item/backgroundTask/progress", {
    item: {
      type: "backgroundTask",
      id: "task:spawn_1#0",
      taskType: "local_subagent",
      description: "Scout the docs folder",
      status: "pending",
      taskStatus: "paused",
      skipTranscript: false,
      parentToolCallId: "exec_0016",
    },
  }),
  env("item/backgroundTask/progress", {
    item: {
      type: "backgroundTask",
      id: "task:spawn_1#0",
      taskType: "local_subagent",
      description: "Scout the docs folder",
      status: "pending",
      taskStatus: "running",
      skipTranscript: false,
      parentToolCallId: "exec_0016",
    },
  }),
  env("item/backgroundTask/completed", {
    item: {
      type: "backgroundTask",
      id: "task:spawn_1#0",
      taskType: "local_subagent",
      description: "Scout the docs folder",
      status: "completed",
      taskStatus: "completed",
      skipTranscript: false,
      summary: "docs/a.md is the only doc.",
      parentToolCallId: "exec_0016",
    },
  }),
  // delegation settles (blocking, inside the spawning turn) — the late
  // duplicate the first-terminal-wins fold absorbs
  env("item/completed", {
    turnId: T2,
    item: {
      type: "toolCall",
      id: "exec_0016",
      tool: "spawnAgent",
      arguments: {},
      status: "completed",
      output: "agentId: child-1\nScout done.",
      completedAt: 1_700_000_000_000 + (seq + 1) * 1_000,
    },
  }),

  // --- turn 3: BATCH spawn (D5 anchors + background seals) ------------------
  // The spawning task call itself is tool{task} — the ux projection drops it
  // (no delegation row), so the BARE anchor matches no row exactly and the
  // D5 k-th-per-item plan-order fallback is the only resolution path.
  env("item/started", {
    turnId: T2,
    item: {
      type: "toolCall",
      id: `${BATCH_ANCHOR}#0`,
      tool: "spawnAgent",
      arguments: {
        senderThreadId: THREAD,
        receiverThreadIds: ["thr_child560a"],
        description: "Batch scout wave item 0",
        subagent_type: "scout",
      },
      status: "pending",
      output: "",
      completedAt: null,
    },
  }),
  env("item/started", {
    turnId: T2,
    item: {
      type: "toolCall",
      id: `${BATCH_ANCHOR}#1`,
      tool: "spawnAgent",
      arguments: {
        senderThreadId: THREAD,
        receiverThreadIds: ["thr_child560b"],
        description: "Batch scout wave item 1",
        subagent_type: "scout",
      },
      status: "pending",
      output: "",
      completedAt: null,
    },
  }),
  // two background settles against the BARE batch anchor — the k-th settle
  // seals the k-th per-item row in plan order (delegationTargetFor parity)
  env("item/backgroundTask/completed", {
    item: {
      type: "backgroundTask",
      id: "task:spawn_b0#0",
      taskType: "local_subagent",
      description: "Batch scout wave item 0",
      status: "completed",
      taskStatus: "completed",
      skipTranscript: false,
      summary: "batch item 0 summary",
      parentToolCallId: BATCH_ANCHOR,
    },
  }),
  env("item/backgroundTask/completed", {
    item: {
      type: "backgroundTask",
      id: "task:spawn_b1#0",
      taskType: "local_subagent",
      description: "Batch scout wave item 1",
      status: "failed",
      taskStatus: "failed",
      skipTranscript: false,
      summary: "batch item 1 crashed",
      parentToolCallId: BATCH_ANCHOR,
    },
  }),

  // phase marker + sealed-call system error + compact checkpoint
  env("turn/phase", { turnId: T2, phase: "first_token", modelCallId: 2 }),
  env("system/error", {
    message: "model stream interrupted mid-call; turn sealed",
    category: "internal",
  }),
  env("thread/compacted", {
    turnId: T2,
    hideThroughSeq: 10,
    tokensBefore: 21_000,
    tokensAfter: 3_100,
    contextWindow: 200_000,
    method: "manual",
  }),
  env("thread/contextWindowUsage/updated", {
    contextWindowUsage: { usedTokens: 3_100, modelContextWindow: 200_000, estimated: true },
  }),
  env("turn/completed", {
    turnId: T2,
    status: "interrupted",
    error: { category: "cancelled", message: "turn cancelled" },
  }),
];

export const THREAD_ID = THREAD;
export const THREAD_STATUS = "idle";
