import { parseThreadEvent } from "@cap/protocol";
import { afterEach, describe, expect, test } from "vitest";
import { createRig, resetRuntime } from "./helpers.js";
import { executionIdFor } from "../src/ids.js";
import { projectToUxEvents } from "../src/ux-projection.js";
import type { AnyAgentEvent } from "../src/fsm-events.js";
import type { TypedThreadEvent } from "@cap/protocol";

/**
 * B1 (#321) — the imageView event chain: a tool result carrying `images`
 * journals one `imageView` row per image (parentToolCallId = the bare call
 * executionId) BEFORE the closing tool.result, and the ux projection folds
 * each row into the bb item lifecycle pair (`item/started` +
 * `item/completed`, same seq — thread/compacted extraUx precedent). The
 * server timeline face pins the row shape in apps/server-worker
 * timeline-image-view.test.ts.
 */

afterEach(() => {
  resetRuntime();
});

interface ImageViewJournal {
  imageViewRows: Extract<AnyAgentEvent, { type: "imageView" }>[];
  resultRow: Extract<AnyAgentEvent, { type: "tool.result" }>;
}

async function journalWithImages(images: { path: string }[] | undefined): Promise<{
  events: AnyAgentEvent[];
  executionId: string;
  journal: ImageViewJournal;
}> {
  const rig = await createRig({
    turns: [
      { toolCalls: [{ name: "bash", arguments: { command: "make pic" } }] },
      { deltas: ["done"] },
    ],
  });
  const sent = await rig.stub.sendMessage({
    clientRequestId: "b1-1",
    mode: "auto",
    content: [{ type: "text", text: "generate a picture" }],
  });
  const completion = rig.waitTurnComplete(sent.turnId);
  const withCall = await rig.waitFor((all) => all.some((event) => event.type === "tool.call"));
  const call = withCall.find((event) => event.type === "tool.call");
  if (call === undefined) throw new Error("no tool.call row");
  const executionId = executionIdFor(rig.threadId, call.seq);
  await rig.service.clientExit(executionId, {
    status: "ok",
    exitCode: 0,
    output: "saved /tmp/rendered.png",
    ...(images === undefined ? {} : { images }),
  });
  const events = await completion;
  const imageViewRows = events.filter(
    (event): event is Extract<AnyAgentEvent, { type: "imageView" }> => event.type === "imageView",
  );
  const resultRow = events.find(
    (event): event is Extract<AnyAgentEvent, { type: "tool.result" }> =>
      event.type === "tool.result" && event.data.executionId === executionId,
  );
  if (resultRow === undefined) throw new Error("no tool.result row");
  return { events, executionId, journal: { imageViewRows, resultRow } };
}

describe("B1 imageView journal producer (ingestResult)", () => {
  test("one imageView row per image lands before the closing tool.result", async () => {
    const { executionId, journal } = await journalWithImages([
      { path: "/tmp/rendered-1.png" },
      { path: "/tmp/rendered-2.png" },
    ]);
    expect(journal.imageViewRows).toHaveLength(2);
    const firstImage = journal.imageViewRows[0];
    const secondImage = journal.imageViewRows[1];
    if (firstImage === undefined || secondImage === undefined) throw new Error("rows missing");
    expect(firstImage.data.parentToolCallId).toBe(executionId);
    expect(firstImage.data.path).toBe("/tmp/rendered-1.png");
    expect(secondImage.data.parentToolCallId).toBe(executionId);
    expect(secondImage.data.path).toBe("/tmp/rendered-2.png");
    expect(secondImage.data.turnId).toBe(firstImage.data.turnId);
    for (const row of journal.imageViewRows) {
      expect(row.seq).toBeLessThan(journal.resultRow.seq);
    }
  });

  test("a result without images journals no imageView rows", async () => {
    const { journal } = await journalWithImages(undefined);
    expect(journal.imageViewRows).toHaveLength(0);
  });

  test("a result redelivered after settle appends no duplicate rows", async () => {
    const rig = await createRig({
      turns: [
        { toolCalls: [{ name: "bash", arguments: { command: "make pic" } }] },
        { deltas: ["done"] },
      ],
    });
    const sent = await rig.stub.sendMessage({
      clientRequestId: "b1-2",
      mode: "auto",
      content: [{ type: "text", text: "generate a picture" }],
    });
    const completion = rig.waitTurnComplete(sent.turnId);
    const withCall = await rig.waitFor((all) => all.some((event) => event.type === "tool.call"));
    const call = withCall.find((event) => event.type === "tool.call");
    if (call === undefined) throw new Error("no tool.call row");
    const executionId = executionIdFor(rig.threadId, call.seq);
    const result = { status: "ok" as const, exitCode: 0, output: "ok", images: [{ path: "/tmp/x.png" }] };
    await rig.service.clientExit(executionId, result);
    await completion;
    // The queryUnacked redelivery face (§8.4): the terminal guard drops the
    // replayed result, so the imageView rows append exactly once.
    await rig.service.clientExit(executionId, result);
    const events = await rig.events();
    expect(events.filter((event) => event.type === "imageView")).toHaveLength(1);
  });
});

describe("B1 ux projection (journal row → bb item lifecycle pair)", () => {
  test("each imageView row folds into started+completed sharing the row seq", async () => {
    const { events, executionId } = await journalWithImages([{ path: "/tmp/rendered.png" }]);
    const imageViewRow = events.find(
      (event): event is Extract<AnyAgentEvent, { type: "imageView" }> => event.type === "imageView",
    );
    if (imageViewRow === undefined) throw new Error("no imageView row");
    const projected = projectToUxEvents(events).map(parseThreadEvent);
    const started = projected.filter(
      (event): event is Extract<TypedThreadEvent, { type: "item/started" }> =>
        event.type === "item/started" && event.data.item.type === "imageView",
    );
    const completed = projected.filter(
      (event): event is Extract<TypedThreadEvent, { type: "item/completed" }> =>
        event.type === "item/completed" && event.data.item.type === "imageView",
    );
    expect(started).toHaveLength(1);
    expect(completed).toHaveLength(1);
    const begin = started[0];
    const end = completed[0];
    if (begin === undefined || end === undefined) throw new Error("lifecycle pair incomplete");
    const itemId = `itm-iv-${imageViewRow.data.turnId}:${imageViewRow.seq}`;
    for (const row of [begin, end]) {
      expect(row.seq).toBe(imageViewRow.seq);
      expect(row.data.item).toEqual({
        type: "imageView",
        id: itemId,
        path: "/tmp/rendered.png",
        parentToolCallId: executionId,
      });
    }
    // bb lifecycle order: the started row precedes its completion.
    expect(projected.indexOf(begin)).toBeLessThan(projected.indexOf(end));
  });

  test("the fold is replay-stable (I3 on the ux view)", async () => {
    const { events } = await journalWithImages([{ path: "/tmp/rendered.png" }]);
    const first = projectToUxEvents(events);
    const second = projectToUxEvents(events);
    expect(second).toEqual(first);
    expect(second.map(parseThreadEvent)).toEqual(first.map(parseThreadEvent));
  });
});
