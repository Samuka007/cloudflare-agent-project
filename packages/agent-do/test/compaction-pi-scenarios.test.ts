/**
 * #314 — pi compaction scenarios rewritten over our journal contract
 * (需改写 tier: same scenario intent, journal/event-log shape).
 *
 * Scenario sources:
 * - pi test/compaction.test.ts:448-469 "multiple compactions (only latest
 *   matters)" + docs/sessions.md:40-41 "original session entries are never
 *   deleted" → the checkpoint/rewind cut seam over the append-only journal.
 * - pi test/compaction.test.ts:377-411 (upstream #9740) "never cut inside a
 *   tool result pair" → the (thread_id, seq) journal pairing invariant.
 *
 * Inventory/mapping/classification: docs/research/pi-test-asset-inventory.md.
 */

import { describe, expect, test } from "vitest";
import type { AnyAgentEvent } from "../src/fsm-events.js";
import { executionIdFor } from "../src/ids.js";
import { activeBranchAfterRewind, checkpointRewindState } from "../src/tools/session-tree.js";

// ---------------------------------------------------------------------------
// Synthetic journal fixtures (session-tree.test.ts:422-451 convention)
// ---------------------------------------------------------------------------

const THREAD = "thr-pi314";

function ev(type: string, seq: number, data: Record<string, unknown>): AnyAgentEvent {
  return {
    type,
    seq,
    id: `evt-${seq}`,
    threadId: THREAD,
    createdAt: 1_000 + seq,
    data,
  } as unknown as AnyAgentEvent;
}

function call(tool: string, seq: number, args: Record<string, unknown>): AnyAgentEvent {
  return ev("tool.call", seq, {
    turnId: "t1",
    modelCallId: 1,
    tool,
    arguments: args,
    timeoutMs: 1_000,
  });
}

function result(tool: string, callSeq: number, seq: number, status: string): AnyAgentEvent {
  return ev("tool.result", seq, {
    turnId: "t1",
    executionId: executionIdFor(THREAD, callSeq),
    status,
    exitCode: null,
    output: "x",
  });
}

/** One full checkpoint → exploration → rewind cycle; returns the appended rows. */
function rewindCycle(
  journal: AnyAgentEvent[],
  seqs: {
    checkpointCall: number;
    checkpointResult: number;
    exploreCall: number;
    exploreResult: number;
    rewindCall: number;
    rewindResult: number;
  },
  report: string,
): void {
  journal.push(call("checkpoint", seqs.checkpointCall, { goal: "g" }));
  journal.push(result("checkpoint", seqs.checkpointCall, seqs.checkpointResult, "ok"));
  journal.push(call("think", seqs.exploreCall, { thoughts: "dig" }));
  journal.push(result("think", seqs.exploreCall, seqs.exploreResult, "ok"));
  journal.push(call("rewind", seqs.rewindCall, { report }));
  journal.push(result("rewind", seqs.rewindCall, seqs.rewindResult, "ok"));
}

// ---------------------------------------------------------------------------
// pi:448 "multiple compactions (only latest matters)" → journal cut seam
// ---------------------------------------------------------------------------

describe("pi compaction scenarios over the journal (需改写 tier)", () => {
  test("pi:448 two cut cycles — only the latest rewind's boundary and report project", () => {
    const journal: AnyAgentEvent[] = [
      ev("thread.created", 1, { title: "t", machineId: "m" }),
      ev("turn.input", 2, { turnId: "t1", inputId: "in1", content: [] }),
    ];
    rewindCycle(
      journal,
      {
        checkpointCall: 3,
        checkpointResult: 4,
        exploreCall: 5,
        exploreResult: 6,
        rewindCall: 7,
        rewindResult: 8,
      },
      "first findings",
    );
    journal.push(ev("turn.completed", 9, { turnId: "t1" }));
    journal.push(ev("turn.input", 10, { turnId: "t2", inputId: "in2", content: [] }));
    rewindCycle(
      journal,
      {
        checkpointCall: 11,
        checkpointResult: 12,
        exploreCall: 13,
        exploreResult: 14,
        rewindCall: 15,
        rewindResult: 16,
      },
      "second findings",
    );
    journal.push(ev("turn.completed", 17, { turnId: "t2" }));

    // The state fold resolves to the LATEST completed pair (pi: only the
    // latest compaction matters — the first report/boundary are superseded).
    expect(checkpointRewindState(journal, THREAD)).toEqual({
      phase: "completed",
      checkpointResultSeq: 12,
      rewindResultSeq: 16,
      report: "second findings",
    });

    const projection = activeBranchAfterRewind(journal, THREAD);
    if (projection === undefined) throw new Error("completed rewind produced no projection");
    expect(projection.summary).toBe("second findings");
    expect(projection.kept.at(-1)?.seq).toBe(12);
    expect(projection.hidden.map((event) => event.seq)).toEqual([13, 14, 15, 16, 17]);
  });

  test("pi:docs/sessions.md:40 both cuts leave the journal append-only — no row is deleted or mutated", () => {
    const journal: AnyAgentEvent[] = [
      ev("thread.created", 1, { title: "t", machineId: "m" }),
      ev("turn.input", 2, { turnId: "t1", inputId: "in1", content: [] }),
    ];
    rewindCycle(
      journal,
      {
        checkpointCall: 3,
        checkpointResult: 4,
        exploreCall: 5,
        exploreResult: 6,
        rewindCall: 7,
        rewindResult: 8,
      },
      "first findings",
    );
    journal.push(ev("turn.completed", 9, { turnId: "t1" }));
    const afterFirstCut = journal.length;

    const first = activeBranchAfterRewind(journal, THREAD);
    if (first === undefined) throw new Error("first rewind produced no projection");
    // Partition holds and the first cut's rows survive in the raw journal.
    expect(first.kept.length + first.hidden.length).toBe(journal.length);
    expect(journal.some((event) => event.seq === 5)).toBe(true);
    expect(journal.some((event) => event.seq === 8)).toBe(true);

    journal.push(ev("turn.input", 10, { turnId: "t2", inputId: "in2", content: [] }));
    rewindCycle(
      journal,
      {
        checkpointCall: 11,
        checkpointResult: 12,
        exploreCall: 13,
        exploreResult: 14,
        rewindCall: 15,
        rewindResult: 16,
      },
      "second findings",
    );
    journal.push(ev("turn.completed", 17, { turnId: "t2" }));

    const second = activeBranchAfterRewind(journal, THREAD);
    if (second === undefined) throw new Error("second rewind produced no projection");
    expect(second.kept.length + second.hidden.length).toBe(journal.length);
    // The journal only ever grew; the first cut's hidden span is still there.
    expect(journal.length).toBeGreaterThan(afterFirstCut);
    for (const seq of [5, 6, 7, 8]) {
      expect(journal.find((event) => event.seq === seq)).toBeDefined();
    }
    // Seqs stay contiguous 1..N (I1): cuts never punch holes.
    expect(journal.map((event) => event.seq)).toEqual(Array.from({ length: 17 }, (_, i) => i + 1));
  });

  // -------------------------------------------------------------------------
  // pi:377 (upstream #9740) "never cut inside a tool result pair" → journal
  // pairing invariant. Shape rewrite: pi cuts entry streams with
  // user/assistant/toolResult roles; we cut (thread_id, seq) journal rows
  // where the pairing is tool.call → tool.result via executionIdFor.
  // -------------------------------------------------------------------------

  test("pi:378 budget cut over journal rows never lands on a tool.result — the pair stays together", () => {
    // Turn skeleton mirroring pi's #9740 fixture: old history, the current
    // user input, a tool call, and an oversized trailing tool result.
    const journal: AnyAgentEvent[] = [
      ev("thread.created", 1, { title: "t", machineId: "m" }),
      ev("turn.input", 2, {
        turnId: "t1",
        inputId: "in1",
        content: [{ type: "text", text: "old history" }],
      }),
      ev("turn.completed", 3, { turnId: "t1" }),
      ev("turn.input", 4, {
        turnId: "t2",
        inputId: "in2",
        content: [{ type: "text", text: "read the large file" }],
      }),
      call("bash", 5, { command: "cat big.txt" }),
      ev("tool.result", 6, {
        turnId: "t2",
        executionId: executionIdFor(THREAD, 5),
        status: "ok",
        exitCode: 0,
        output: "x".repeat(8000),
      }),
      ev("turn.completed", 7, { turnId: "t2" }),
    ];

    // Our shape rewrite of pi's cut eligibility (compaction.ts:351-379):
    // cut-eligible rows are turn inputs (user-like) and tool calls
    // (assistant-with-toolCall analog); tool.result rows are never
    // cut-eligible — their call must stay with them.
    const cutEligible = (event: AnyAgentEvent): boolean =>
      event.type === "turn.input" || event.type === "tool.call";
    for (const event of journal) {
      if (event.type === "tool.result") expect(cutEligible(event)).toBe(false);
    }

    // The backwards budget walk (pi compaction.ts:458-479): row cost =
    // text payload size; cut at the closest eligible row at/after the
    // budget crossing.
    const rowCost = (event: AnyAgentEvent): number => {
      if (event.type === "tool.result") {
        const output = event.data.output;
        return typeof output === "string" ? output.length : 0;
      }
      if (event.type === "turn.input") {
        const content = event.data.content;
        const text = content.map((block) => block.text).join("");
        return text.length;
      }
      return 0;
    };

    const keepBudget = 1000;
    let accumulated = 0;
    let cutIndex = journal.findIndex((event) => cutEligible(event));
    for (let i = journal.length - 1; i >= 0; i--) {
      const row = journal[i];
      if (row === undefined) continue;
      const cost = rowCost(row);
      if (cost === 0) continue;
      accumulated += cost;
      if (accumulated >= keepBudget) {
        const candidate = journal.findIndex((event, index) => index >= i && cutEligible(event));
        cutIndex = candidate >= 0 ? candidate : journal.findLastIndex(cutEligible);
        break;
      }
    }

    const cut = journal[cutIndex];
    if (cut === undefined) throw new Error("budget walk returned an out-of-range cut index");
    // The cut lands on the tool.call row (seq 5), never inside its result —
    // the pi #9740 expectation, rewritten onto executionIdFor pairing.
    expect(cut.type).toBe("tool.call");
    expect(cut.seq).toBe(5);
    const pairedResult = journal.find(
      (event) =>
        event.type === "tool.result" && event.data.executionId === executionIdFor(THREAD, cut.seq),
    );
    if (pairedResult === undefined) throw new Error("tool.call has no paired tool.result row");
    expect(pairedResult.seq).toBeGreaterThan(cut.seq);
    // Every cut-eligible row keeps its results on the kept side of the cut.
    for (const candidate of journal.filter(cutEligible)) {
      if (candidate.type !== "tool.call") continue;
      const resultRow = journal.find(
        (event) =>
          event.type === "tool.result" &&
          event.data.executionId === executionIdFor(THREAD, candidate.seq),
      );
      if (resultRow === undefined) continue;
      const candidateAfterCut = candidate.seq >= cut.seq;
      const resultAfterCut = resultRow.seq >= cut.seq;
      expect(candidateAfterCut).toBe(resultAfterCut);
    }
  });
});
