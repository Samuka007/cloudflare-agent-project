import { beforeAll, describe, expect, it } from "vitest";
import { env, exports } from "cloudflare:workers";
import { agentEventDataSchemas } from "@cap/agent-do";
import { threadEventDataSchemas } from "@cap/protocol";
import { ensureMigrations } from "../migrate.js";
import { BASE, createThread } from "../helpers.js";
import { threadTimelineResponseSchema } from "../../src/contract/api/threads.js";
import { createStandaloneBuiltinCompactCommandInput } from "../../src/contract/domain/shared-types.js";
import type { AgentDoRpc } from "../../src/seam/agent-do.js";

/**
 * #309: POST /threads/:id/compact — the bb wire (noRequest → {ok:true}) over
 * the journal-checkpoint semantics. The compact turn (one tool-free
 * summarization call + the content-bearing `thread/compacted` checkpoint)
 * appends on the per-thread agent DO; the timeline carries the "Context
 * compacted" op row and the estimated contextWindowUsage row that drops the
 * SPA indicator without a further model call. DO-side gate/failure faces are
 * asserted in packages/agent-do compact.test.ts; here the route wire, the
 * refusal mapping, and the served projection are the surface under test.
 */
beforeAll(ensureMigrations);

function compact(threadId: string): Promise<Response> {
  return exports.default.fetch(`${BASE}/api/v1/threads/${threadId}/compact`, { method: "POST" });
}

/** Raw journal read (the same direct-stub pattern the stop route tests use). */
async function rawEvents(threadId: string) {
  const stub = env.AGENT_DO.get(env.AGENT_DO.idFromName(threadId)) as unknown as AgentDoRpc;
  const { events } = await stub.getEvents({ sinceSeq: 0 });
  return events;
}

async function sendInput(threadId: string, text: string): Promise<void> {
  const response = await exports.default.fetch(`${BASE}/api/v1/threads/${threadId}/send`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ input: [{ type: "text", text }], mode: "auto" }),
  });
  expect(response.status, await response.text()).toBe(200);
}

/** ~24K tokens of journal estimate (bytes/4) so the middle turn crosses the
 * retention budget while the newest turn alone stays under it (the planner
 * refuses a boundary at the oldest turn — pi kept-still-fits). */
const BIG_INPUT = `filler:${"x".repeat(96 * 1024)}`;

describe("POST /threads/:id/compact (#309)", () => {
  it("404s an unknown thread", async () => {
    const missing = await compact("thr_does_not_exist");
    expect(missing.status).toBe(404);
    expect((await missing.json<{ code: string }>()).code).toBe("thread_not_found");
  });

  it("refuses a thread with no model activity (409 nothing_to_compact)", async () => {
    const thread = await createThread({ title: "compact-empty" });
    const response = await compact(thread.id);
    expect(response.status).toBe(409);
    const body = await response.json<{ code: string; details?: { reason?: string } }>();
    expect(body.code).toBe("thread_not_writable");
    expect(body.details?.reason).toBe("nothing_to_compact");
  });

  it("compacts a grown thread: checkpoint row, op row, and a dropped indicator", async () => {
    const thread = await createThread({
      title: "compact-grown",
      input: [{ type: "text", text: "small opener" }],
    });
    const completedCount = async (): Promise<number> => {
      const events = await rawEvents(thread.id);
      return events.filter((event) => event.type === "turn.completed").length;
    };
    // Sequential turn gating on journal truth — each send starts only after
    // the previous turn terminalized (mode auto + a live turn would steer).
    await expect.poll(completedCount, { timeout: 30_000, interval: 150 }).toBeGreaterThanOrEqual(1);
    await sendInput(thread.id, BIG_INPUT);
    await expect.poll(completedCount, { timeout: 30_000, interval: 150 }).toBeGreaterThanOrEqual(2);
    await sendInput(thread.id, "closing small turn");
    await expect.poll(completedCount, { timeout: 30_000, interval: 150 }).toBeGreaterThanOrEqual(3);

    const response = await compact(thread.id);
    const body = await response.text();
    expect(response.status, body).toBe(200);
    expect(JSON.parse(body)).toEqual({ ok: true });

    // Journal checkpoint: content-bearing marker + the compact turn rows.
    const events = await rawEvents(thread.id);
    const markers = events.filter((event) => event.type === "thread/compacted");
    expect(markers).toHaveLength(1);
    const marker = markers[0];
    if (marker === undefined) throw new Error("unreachable");
    const markerData = threadEventDataSchemas["thread/compacted"].safeParse(marker.data);
    if (!markerData.success) throw new Error(`malformed marker: ${markerData.error.message}`);
    expect(markerData.data.method).toBe("manual");
    expect(markerData.data.hideThroughSeq).toBeGreaterThan(0);
    expect(events.some((event) => event.type === "model.call_sealed")).toBe(false);

    // Thread remains usable: another send lands a normal turn past the cut.
    await sendInput(thread.id, "post-compact follow-up");
    await expect.poll(completedCount, { timeout: 30_000, interval: 150 }).toBeGreaterThanOrEqual(4);
    const postEvents = await rawEvents(thread.id);
    expect(
      postEvents.some((event) => event.type === "turn.completed" && event.seq > marker.seq),
    ).toBe(true);

    // Served projection: compaction op row + the estimated usage row the
    // checkpoint emitted (the indicator drops without a further model call).
    const timeline = await exports.default.fetch(
      `${BASE}/api/v1/threads/${thread.id}/timeline?segmentLimit=50`,
    );
    expect(timeline.status).toBe(200);
    const parsed = threadTimelineResponseSchema.parse(await timeline.json());
    const compactionRow = parsed.rows.find(
      (row) =>
        row.kind === "system" && "operationKind" in row && row.operationKind === "compaction",
    );
    expect(compactionRow).toBeDefined();
    expect(parsed.contextWindowUsage).toBeDefined();
    // #450: turns dispatch through the D1 rig row, so the receipt is the
    // relay wire's real usage — the estimated flag is a deployment-mock
    // artifact no longer reachable on any dispatched turn.
    expect(parsed.contextWindowUsage?.estimated).toBe(false);
  });
});

describe("POST /threads/:id/send with the builtin /compact mention (#546)", () => {
  it("intercepts the standalone mention: the compact runs, the model never sees the text", async () => {
    const thread = await createThread({
      title: "compact-send-intercept",
      input: [{ type: "text", text: "small opener" }],
    });
    const completedCount = async (): Promise<number> => {
      const events = await rawEvents(thread.id);
      return events.filter((event) => event.type === "turn.completed").length;
    };
    // Grown journal first: the same two-turn shape the manual-compact test
    // uses, so the DO's retention-budget gate admits the compact.
    await expect.poll(completedCount, { timeout: 30_000, interval: 150 }).toBeGreaterThanOrEqual(1);
    await sendInput(thread.id, BIG_INPUT);
    await expect.poll(completedCount, { timeout: 30_000, interval: 150 }).toBeGreaterThanOrEqual(2);

    // The SPA's builtin-command auto-submit body: a lone text item whose
    // only mention is the builtin compact command.
    const response = await exports.default.fetch(`${BASE}/api/v1/threads/${thread.id}/send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: createStandaloneBuiltinCompactCommandInput(), mode: "auto" }),
    });
    const body = await response.text();
    expect(response.status, body).toBe(200);
    expect(JSON.parse(body)).toEqual({ ok: true });

    // The compact face ran: the checkpoint marker lands on the journal.
    await expect
      .poll(
        async () => {
          const events = await rawEvents(thread.id);
          return events.filter((event) => event.type === "thread/compacted").length;
        },
        { timeout: 30_000, interval: 150 },
      )
      .toBeGreaterThanOrEqual(1);

    // …and no turn input ever carried the bare "/compact" text — the
    // mention was intercepted at the send face, not dispatched as content.
    const events = await rawEvents(thread.id);
    const compactTextInputs = events.filter((event) => {
      if (event.type !== "turn.input" && event.type !== "turn.steer") {
        return false;
      }
      const data = agentEventDataSchemas[event.type].parse(event.data);
      return data.content.some((item) => item.type === "text" && item.text === "/compact");
    });
    expect(compactTextInputs).toHaveLength(0);
  });

  it("raw '/compact' text without the mention dispatches as a normal turn", async () => {
    const thread = await createThread({
      title: "compact-send-raw-text",
      input: [{ type: "text", text: "small opener" }],
    });
    const completedCount = async (): Promise<number> => {
      const events = await rawEvents(thread.id);
      return events.filter((event) => event.type === "turn.completed").length;
    };
    await expect.poll(completedCount, { timeout: 30_000, interval: 150 }).toBeGreaterThanOrEqual(1);

    await sendInput(thread.id, "/compact");

    // Raw matching text intentionally does not qualify (bb
    // isStandaloneBuiltinCompactCommand semantics): the turn dispatches the
    // text as model content…
    await expect
      .poll(
        async () => {
          const events = await rawEvents(thread.id);
          return events.some((event) => {
            if (event.type !== "turn.input") {
              return false;
            }
            const data = agentEventDataSchemas["turn.input"].parse(event.data);
            return data.content.some((item) => item.type === "text" && item.text === "/compact");
          });
        },
        { timeout: 30_000, interval: 150 },
      )
      .toBe(true);
    // …and nothing compacted.
    const events = await rawEvents(thread.id);
    expect(events.some((event) => event.type === "thread/compacted")).toBe(false);
  });
});
