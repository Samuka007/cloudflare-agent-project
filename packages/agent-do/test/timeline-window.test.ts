import { afterEach, describe, expect, test } from "vitest";
import { runInDurableObject } from "cloudflare:test";
import { parseThreadEvent, type ThreadEventEnvelope } from "@cap/protocol";
import {
  agentEventDataSchemas,
  type AgentEventType,
  type AnyAgentEvent,
} from "../src/fsm-events.js";
import { projectToUxEvents } from "../src/ux-projection.js";
import {
  TIMELINE_MAX_INLINE_OUTPUT_CHARS,
  TIMELINE_WINDOW_BYTE_BUDGET,
} from "../src/timeline-read.js";
import { executionIdFor } from "../src/ids.js";
import { createRig, resetRuntime, type Rig } from "./helpers.js";

/**
 * #561 — DO SQL 读层窗口预算 + 读放大对齐: the ux read face pins the bb
 * mechanisms (truncatedEventDataColumn-style inline truncation,
 * findStoredTimelineWindowByteBudgetFloor-style byte window, delta
 * governance) at the EventLog boundary, plus the equivalence gate: for a
 * journal that fits every budget, the windowed ux read is identical to the
 * legacy full read.
 */

afterEach(() => {
  resetRuntime();
});

interface JournalSeed {
  type: AgentEventType;
  data: Record<string, unknown>;
}

/**
 * Append journal rows straight into DO SQLite (the sanctioned test seam,
 * invariants.test.ts pattern) with contiguous per-thread seqs and
 * schema-valid payloads — the write path would parse the same shapes.
 */
async function seedJournal(rig: Rig, seeds: JournalSeed[]): Promise<void> {
  await runInDurableObject(rig.stub, (_instance, state) => {
    const nextRow = state.storage.sql
      .exec<{ next: number }>(
        "SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM events WHERE thread_id = ?",
        rig.threadId,
      )
      .one().next;
    seeds.forEach((seed, index) => {
      const data = JSON.stringify(agentEventDataSchemas[seed.type].parse(seed.data));
      state.storage.sql.exec(
        "INSERT INTO events (thread_id, seq, id, type, data, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        rig.threadId,
        nextRow + index,
        `evt_seed_${nextRow + index}`,
        seed.type,
        data,
        nextRow + index,
      );
    });
  });
}

/** One model call: started → thinking → deltas → completed → receipt. */
function callSeeds(
  turnId: string,
  modelCallId: number,
  text: string,
  thinking: string,
): JournalSeed[] {
  return [
    { type: "model.call_started", data: { turnId, modelCallId, consumedSteerSeqs: [] } },
    { type: "model.thinking", data: { turnId, modelCallId, text: thinking } },
    { type: "model.delta", data: { turnId, modelCallId, text } },
    { type: "model.call_completed", data: { turnId, modelCallId, text, toolCalls: [] } },
    {
      type: "model.usage_receipt",
      data: {
        turnId,
        modelCallId,
        usage: {
          inputTokens: 10,
          outputTokens: 10,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          contextWindow: 100_000,
          estimated: false,
        },
      },
    },
  ];
}

function turnSeeds(turnId: string, inputId: string, text: string): JournalSeed[] {
  return [{ type: "turn.input", data: { turnId, inputId, content: [{ type: "text", text }] } }];
}

/** Dead-weight rows the ux projection breaks on — tool streaming et al. */
function deadWeightSeeds(turnId: string, executionId: string): JournalSeed[] {
  return [
    {
      type: "tool.call",
      data: { turnId, modelCallId: 1, tool: "bash", arguments: {}, timeoutMs: 1000 },
    },
    { type: "tool.output", data: { turnId, executionId, offset: 0, chunk: "chunk" } },
    {
      type: "tool.dispatch",
      data: { turnId, executionId, attempt: 1, requestId: "r", outcome: "accepted" },
    },
    {
      type: "tool.result",
      data: { turnId, executionId, status: "ok", exitCode: 0, output: "out" },
    },
  ];
}

/**
 * The DO RPC types every getEvents face as the raw journal union; a
 * project:"ux" payload is structurally the protocol envelope (the seam's
 * documented shape-compatible lie) — re-tag once here so the protocol
 * schemas own the narrowing.
 */
function asUx(events: readonly { type: string }[]): ThreadEventEnvelope[] {
  return events as unknown as ThreadEventEnvelope[];
}

/** Protocol-parse ux envelopes so item shapes are boundary-typed. */
function parsedUx(events: readonly { type: string }[]) {
  return asUx(events).map((event) => parseThreadEvent(event));
}

type CompletedItem = Extract<
  ReturnType<typeof parseThreadEvent>,
  { type: "item/completed" }
>["data"]["item"];

/** Every item/completed item in the read, boundary-typed. */
function completedItems(rows: readonly { type: string }[]): CompletedItem[] {
  const items: CompletedItem[] = [];
  for (const event of parsedUx(rows)) {
    if (event.type === "item/completed") items.push(event.data.item);
  }
  return items;
}

/** The first completed item of the named type. */
function completedItem<T extends CompletedItem["type"]>(
  rows: readonly { type: string }[],
  itemType: T,
): Extract<CompletedItem, { type: T }> | undefined {
  return completedItems(rows).find(
    (item): item is Extract<CompletedItem, { type: T }> => item.type === itemType,
  );
}

describe("#561 ux read face: dead-weight filter + inline truncation + window budget", () => {
  test("ux read equals the legacy full read projection on a fitting journal", async () => {
    const rig = await createRig();
    await seedJournal(rig, [
      ...turnSeeds("t1", "in-1", "hello"),
      ...deadWeightSeeds("t1", "ex-1"),
      ...callSeeds("t1", 1, "world", "pondering"),
      { type: "turn.completed", data: { turnId: "t1" } },
    ]);

    const raw = await rig.stub.getEvents({ sinceSeq: 0 });
    const legacy = projectToUxEvents(raw.events);
    const ux = await rig.stub.getEvents({ sinceSeq: 0, project: "ux", window: {} });
    expect(asUx(ux.events)).toEqual(legacy);
    // The whole journal fit: no floor, nothing older.
    if (ux.window === undefined) throw new Error("window info missing");
    expect(ux.window.windowStartSeq).toBe(1);
    expect(ux.window.floorSeq).toBe(0);
    expect(ux.window.dataBytes).toBeGreaterThan(0);
    expect(ux.window.hasOlderRows).toBe(false);
  });

  test("completion aggregates truncate at the read boundary with the bb marker; raw stays full", async () => {
    const rig = await createRig();
    const output = "x".repeat(TIMELINE_MAX_INLINE_OUTPUT_CHARS + 5_000);
    await seedJournal(rig, [
      ...turnSeeds("t1", "in-1", "run"),
      {
        type: "tool.call",
        data: { turnId: "t1", modelCallId: 1, tool: "bash", arguments: {}, timeoutMs: 1000 },
      },
      {
        type: "tool.result",
        data: { turnId: "t1", executionId: "ex-1", status: "ok", exitCode: 0, output },
      },
      { type: "turn.completed", data: { turnId: "t1" } },
    ]);

    const ux = (await rig.stub.getEvents({ sinceSeq: 0, project: "ux", window: {} })).events;
    // The bb marker counts the DROPPED characters (length − cap).
    const expectedMarker = `\n…[${(5_000).toLocaleString("en-US")} more characters truncated]`;
    expect(completedItem(ux, "toolCall")?.output).toBe(
      `${"x".repeat(TIMELINE_MAX_INLINE_OUTPUT_CHARS)}${expectedMarker}`,
    );

    const raw = (await rig.stub.getEvents({ sinceSeq: 0 })).events;
    const rawResult = raw.find(
      (event): event is Extract<AnyAgentEvent, { type: "tool.result" }> =>
        event.type === "tool.result",
    );
    expect(rawResult?.data.output).toBe(output);
  });

  test("blob-offloaded payloads stay blob refs on the ux read (projection skips them)", async () => {
    const rig = await createRig();
    const blobRef = { __blob__: { key: `blob/${rig.threadId}/abc`, size: 10, sha256: "abc" } };
    await seedJournal(rig, [
      ...turnSeeds("t1", "in-1", "run"),
      {
        type: "tool.result",
        data: { turnId: "t1", executionId: "ex-1", status: "ok", exitCode: 0, output: blobRef },
      },
      { type: "turn.completed", data: { turnId: "t1" } },
    ]);

    // No R2 binding in the rig: the legacy read throws on resolveBlob; the ux
    // read never materializes the field.
    const ux = await rig.stub.getEvents({ sinceSeq: 0, project: "ux", window: {} });
    expect(completedItem(ux.events, "toolCall")?.output).toBe("");
  });

  test("byte budget floors the window at a turn boundary; deltas stay full in the newest window", async () => {
    const rig = await createRig();
    // ~24 turns × ~220KB of un-truncatable completion text ≈ 5.3MB — over
    // the 4MB budget even after the read truncates every inline output
    // (message text is never capped, bb contract).
    const turnCount = 24;
    const seeds: JournalSeed[] = [];
    for (let index = 1; index <= turnCount; index += 1) {
      const turnId = `t${index}`;
      seeds.push(...turnSeeds(turnId, `in-${index}`, `input ${index}`));
      seeds.push(...callSeeds(turnId, 1, "y".repeat(220_000), "pondering"));
      seeds.push({ type: "turn.completed", data: { turnId } });
    }
    await seedJournal(rig, seeds);

    const ux = await rig.stub.getEvents({ sinceSeq: 0, project: "ux", window: {} });
    if (ux.window === undefined) throw new Error("window info missing");
    const window = ux.window;
    expect(window.floorSeq).toBeGreaterThan(0);
    expect(window.hasOlderRows).toBe(true);
    // The window holds whole turns: it starts at a turn.input row, and the
    // budget overshoot is bounded by one turn (~220KB + small rows).
    const seededTurnInputs = (await rig.stub.getEvents({ sinceSeq: 0 })).events
      .filter((event) => event.type === "turn.input")
      .map((event) => event.seq);
    expect(seededTurnInputs).toContain(window.windowStartSeq);
    expect(window.dataBytes).toBeLessThanOrEqual(TIMELINE_WINDOW_BYTE_BUDGET + 300_000);

    // Newest window keeps answer deltas in full (live streaming face).
    const newestDeltas = asUx(ux.events).filter(
      (event) => event.type === "item/agentMessage/delta",
    );
    expect(newestDeltas.length).toBeGreaterThan(0);

    // Every turn in the window projects completely: the first window event is
    // the window's own user row.
    expect(ux.events[0]?.type).toBe("item/started");
  });

  test("older windows read completion aggregates: answer deltas excluded, thinking capped but present", async () => {
    const rig = await createRig();
    const seeds: JournalSeed[] = [];
    for (let index = 1; index <= 4; index += 1) {
      const turnId = `t${index}`;
      seeds.push(...turnSeeds(turnId, `in-${index}`, `input ${index}`));
      seeds.push(...callSeeds(turnId, 1, `answer ${index}`, "p".repeat(1_000)));
      seeds.push({ type: "turn.completed", data: { turnId } });
    }
    await seedJournal(rig, seeds);

    const all = (await rig.stub.getEvents({ sinceSeq: 0 })).events;
    const anchor = all.find(
      (event) => event.type === "turn.input" && (event.data as { turnId: string }).turnId === "t2",
    );
    if (anchor === undefined) throw new Error("anchor turn.input missing");
    const anchorSeq = anchor.seq;

    const ux = await rig.stub.getEvents({
      sinceSeq: 0,
      project: "ux",
      window: { beforeSeq: anchorSeq },
    });
    // The anchor's whole turn rides along (upper turn extension) — its user
    // row is present — but nothing beyond the turn's last row.
    const uxRows = asUx(ux.events);
    expect(uxRows.map((event) => event.type)).toContain("item/started");
    expect(uxRows.every((event) => event.seq <= anchorSeq + 8)).toBe(true);
    // Delta governance: no answer deltas in an older window.
    expect(uxRows.filter((event) => event.type === "item/agentMessage/delta")).toHaveLength(0);
    // The agentMessage rows still carry the aggregate text (call_completed).
    expect(completedItem(ux.events, "agentMessage")?.text).toBe("answer 1");
    // Thinking stays (Thought rows survive history) — ux reasoning terminals.
    expect(completedItem(ux.events, "reasoning")).toBeDefined();
  });

  test("out-of-window spawn terminals re-read: background rows never render pending across windows", async () => {
    const rig = await createRig();
    // Turn 1 plans a background spawn; the settle lands ~200 turns above it —
    // an older page anchored between the two must still see the terminal.
    // Attribution anchor: parentToolCallId is executionIdFor(threadId,
    // toolCallSeq) over the transport tool.call row (ux-projection J1).
    const transportCallSeq = 4;
    const seeds: JournalSeed[] = [
      ...turnSeeds("t1", "in-1", "spawn"),
      {
        type: "model.call_started",
        data: { turnId: "t1", modelCallId: 1, consumedSteerSeqs: [] },
      },
      {
        type: "tool.call",
        data: { turnId: "t1", modelCallId: 1, tool: "task", arguments: {}, timeoutMs: 1000 },
      },
      {
        type: "task.spawn_planned",
        data: {
          executionId: "sp-1",
          spawnId: "sp-1",
          agentId: "worker",
          agent: "worker",
          childThreadId: "thr-child",
          parentThreadId: rig.threadId,
          machineId: rig.threadId,
          mode: "background",
          jobId: null,
          task: "do things",
          solutionSpace: "one fix",
          parentToolCallId: executionIdFor(rig.threadId, transportCallSeq),
          depth: 1,
        },
      },
      ...callSeeds("t1", 2, "planned", ""),
      { type: "turn.completed", data: { turnId: "t1" } },
      ...turnSeeds("t2", "in-2", "next"),
      ...callSeeds("t2", 1, "after", ""),
      { type: "turn.completed", data: { turnId: "t2" } },
    ];
    for (let index = 3; index <= 200; index += 1) {
      const turnId = `t${index}`;
      seeds.push(...turnSeeds(turnId, `in-${index}`, `input ${index}`));
      seeds.push(...callSeeds(turnId, 1, "y".repeat(40_000), ""));
      seeds.push({ type: "turn.completed", data: { turnId } });
    }
    seeds.push({
      type: "task.spawn_settled",
      data: {
        spawnId: "sp-1",
        jobId: null,
        agentId: "worker",
        childThreadId: "thr-child",
        status: "ok",
        output: "done",
        parentToolCallId: executionIdFor(rig.threadId, transportCallSeq),
      },
    });
    await seedJournal(rig, seeds);

    // Older page anchored between plan and settle: the terminal still folds.
    const all = (await rig.stub.getEvents({ sinceSeq: 0 })).events;
    const anchor = all.find(
      (event) => event.type === "turn.input" && (event.data as { turnId: string }).turnId === "t2",
    );
    if (anchor === undefined) throw new Error("anchor turn.input missing");
    const anchorSeq = anchor.seq;
    const older = await rig.stub.getEvents({
      sinceSeq: 0,
      project: "ux",
      window: { beforeSeq: anchorSeq },
    });
    const olderSettled = parsedUx(older.events).filter(
      (event) => event.type === "item/backgroundTask/completed",
    );
    expect(olderSettled).toHaveLength(1);
    expect(olderSettled[0]?.data.item.status).toBe("completed");
  });
});
