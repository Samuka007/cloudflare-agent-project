import { beforeAll, describe, expect, it } from "vitest";
import { ensureMigrations } from "../migrate.js";
import { projectTimelineRows } from "../../src/services/timeline.js";
import type { TimelineImageViewWorkRow, TimelineRow } from "../../src/contract/thread-timeline.js";
import type { UxThreadEvent } from "../../src/seam/agent-do.js";

/**
 * B1 (#321): the timeline projection's image-view row producer — the journal
 * imageView event folds into the bb item lifecycle pair in agent-do
 * (ux-projection.ts); this face materializes TimelineImageViewWorkRow from
 * those envelopes (bb build-thread-timeline.ts:674-683). The SPA's pinned
 * ImageViewWorkRowBody renders the row with the lightbox, src =
 * buildThreadHostFileContentUrl → the #321 host-file content face. Pure
 * projection tests over synthetic ux envelopes (timeline-delegation pattern).
 */
beforeAll(ensureMigrations);

let seqCounter = 0;

function uxEvent(type: string, data: unknown): UxThreadEvent {
  seqCounter += 1;
  return {
    id: `evt-${seqCounter}`,
    threadId: "thr_b1",
    seq: seqCounter,
    type,
    data,
    createdAt: 2_000 + seqCounter,
  };
}

function imageViewItem(overrides?: { id?: string; path?: string; parentToolCallId?: string }) {
  return {
    type: "imageView",
    id: overrides?.id ?? "itm-iv-turn_1:42",
    path: overrides?.path ?? "/workspace/output/diagram.png",
    ...(overrides?.parentToolCallId === undefined
      ? {}
      : { parentToolCallId: overrides.parentToolCallId }),
  };
}

function imageViewRows(rows: readonly TimelineRow[]): TimelineImageViewWorkRow[] {
  return rows.filter(
    (row): row is TimelineImageViewWorkRow => row.kind === "work" && row.workKind === "image-view",
  );
}

describe("#321 B1 timeline image-view row projection", () => {
  it("materializes the image-view work row from item/started (pending, item id as callId)", () => {
    const rows = projectTimelineRows([
      uxEvent("item/started", {
        turnId: "turn_1",
        item: imageViewItem({ parentToolCallId: "thr_b1:40" }),
      }),
    ]);
    const rowsFor = imageViewRows(rows);
    expect(rowsFor).toHaveLength(1);
    const row = rowsFor[0];
    if (row === undefined) throw new Error("no image-view row");
    expect(row).toMatchObject({
      workKind: "image-view",
      id: "itm-iv-turn_1:42",
      callId: "itm-iv-turn_1:42",
      path: "/workspace/output/diagram.png",
      status: "pending",
      completedAt: null,
      turnId: "turn_1",
      threadId: "thr_b1",
    });
    expect(row.sourceSeqStart).toBe(row.sourceSeqEnd);
  });

  it("seals the row from the same-seq item/completed with the refreshed path", () => {
    const rows = projectTimelineRows([
      uxEvent("item/started", {
        turnId: "turn_1",
        item: imageViewItem(),
      }),
      uxEvent("item/completed", {
        turnId: "turn_1",
        item: imageViewItem({ path: "/workspace/output/diagram-final.png" }),
      }),
    ]);
    const rowsFor = imageViewRows(rows);
    expect(rowsFor).toHaveLength(1);
    const row = rowsFor[0];
    if (row === undefined) throw new Error("no image-view row");
    expect(row).toMatchObject({
      status: "completed",
      path: "/workspace/output/diagram-final.png",
    });
    expect(row.completedAt).not.toBeNull();
  });

  it("seals a still-pending row at the turn boundary (bb tool-activity sweep)", () => {
    const rows = projectTimelineRows([
      uxEvent("item/started", {
        turnId: "turn_1",
        item: imageViewItem(),
      }),
      uxEvent("turn/completed", { turnId: "turn_1", status: "interrupted", error: null }),
    ]);
    const swept = imageViewRows(rows)[0];
    if (swept === undefined) throw new Error("no image-view row");
    expect(swept).toMatchObject({ status: "interrupted" });
  });

  it("keeps the row top-level (bb build-thread-timeline emits it where the message sits)", () => {
    const rows = projectTimelineRows([
      uxEvent("item/started", { turnId: "turn_1", item: imageViewItem() }),
      uxEvent("item/completed", { turnId: "turn_1", item: imageViewItem() }),
    ]);
    expect(rows).toHaveLength(1);
    const only = rows[0];
    if (only === undefined) throw new Error("no image-view row");
    expect(only.kind).toBe("work");
  });
});
