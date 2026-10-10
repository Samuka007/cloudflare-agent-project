import { beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { env, exports } from "cloudflare:workers";
import { agentEventDataSchemas, type CompactMode } from "@cap/agent-do";
import { threadEventDataSchemas } from "@cap/protocol";
import { ensureMigrations } from "../migrate.js";
import {
  BASE,
  RIG_PROVIDER_ID,
  RIG_RELAY_BASE_URL,
  createThread,
  ensureRigReady,
} from "../helpers.js";
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

/** #547: the optional-body face — `{mode}` forces one taxonomy entry. */
function compactWithMode(threadId: string, mode?: CompactMode): Promise<Response> {
  return exports.default.fetch(`${BASE}/api/v1/threads/${threadId}/compact`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    ...(mode !== undefined ? { body: JSON.stringify({ mode }) } : {}),
  });
}

/** The builtin mention input with a trailing mode argument (the omp
 * allowArgs shape; the mention spans the "/compact" prefix exactly). */
function compactCommandInputWithArgument(argument: string) {
  const text = argument === "" ? "/compact" : `/compact ${argument}`;
  return [
    {
      type: "text",
      text,
      mentions: [
        {
          start: 0,
          end: "/compact".length,
          resource: {
            kind: "command",
            trigger: "/",
            name: "compact",
            source: "command",
            origin: "builtin",
            label: "compact",
            argumentHint: "",
          },
        },
      ],
    },
  ];
}

async function sendCompactCommand(threadId: string, argument: string): Promise<Response> {
  return exports.default.fetch(`${BASE}/api/v1/threads/${threadId}/send`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ input: compactCommandInputWithArgument(argument), mode: "auto" }),
  });
}

/** The deployment compaction seat (the compaction-settings 正本). */
async function putCompactionSettings(payload: {
  methodOrder: CompactMode[];
  remote: { providerId?: string; model: string } | null;
}): Promise<Response> {
  return exports.default.fetch(`${BASE}/api/v1/system/compaction-settings`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

/** The absent-row posture is the shared-worker default: tests leave the seat
 * DELETED, not rewritten — a present soft row would flip the configured flag
 * for later suites' absent-row faces. */
async function deleteCompactionSeat(): Promise<void> {
  await env.DB.prepare("DELETE FROM compaction_settings WHERE id = 'compaction_settings'").run();
}

/** The wire captures every outbound relay POST body (the remote-mode wire
 * evidence: the summarization call names the delegated model on the wire). */
async function captureRigWireBodies(): Promise<{ bodies: unknown[]; restore: () => void }> {
  await ensureRigReady();
  const bodies: unknown[] = [];
  const current = globalThis.fetch.bind(globalThis);
  const stub = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const href = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
    if (href.startsWith(`${RIG_RELAY_BASE_URL}/`) && typeof init?.body === "string") {
      bodies.push(JSON.parse(init.body) as unknown);
    }
    return current(url, init);
  };
  vi.stubGlobal("fetch", stub);
  return { bodies, restore: () => vi.unstubAllGlobals() };
}

/** Add the delegated summarizer model to the rig catalog row (local test
 * mutation; additive — every other suite resolves "rig-model" explicitly). */
async function addRigRemoteModel(): Promise<void> {
  await env.DB.prepare("UPDATE provider_configs SET models = ?, updated_at = ? WHERE id = ?")
    .bind(
      JSON.stringify([
        { id: "rig-model", reasoningLevels: ["none"], defaultReasoningLevel: "none" },
        { id: "rig-remote", reasoningLevels: ["none"], defaultReasoningLevel: "none" },
      ]),
      Date.now(),
      RIG_PROVIDER_ID,
    )
    .run();
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

// ---------------------------------------------------------------------------
// #547 the compact-mode faces
// ---------------------------------------------------------------------------

/** Grown journal helper: one small turn + one BIG turn, both terminalized. */
async function growJournal(threadId: string): Promise<void> {
  const completedCount = async (): Promise<number> => {
    const events = await rawEvents(threadId);
    return events.filter((event) => event.type === "turn.completed").length;
  };
  await expect.poll(completedCount, { timeout: 30_000, interval: 150 }).toBeGreaterThanOrEqual(1);
  await sendInput(threadId, BIG_INPUT);
  await expect.poll(completedCount, { timeout: 30_000, interval: 150 }).toBeGreaterThanOrEqual(2);
}

describe("POST /threads/:id/compact with a mode (#547)", () => {
  it("snap: the checkpoint hides the whole journal, no model call, fresh context", async () => {
    const thread = await createThread({
      title: "compact-snap",
      input: [{ type: "text", text: "small opener" }],
    });
    await growJournal(thread.id);

    const response = await compactWithMode(thread.id, "snap");
    expect(response.status, await response.text()).toBe(200);

    await expect
      .poll(
        async () => {
          const events = await rawEvents(thread.id);
          return events.filter((event) => event.type === "thread/compacted").length;
        },
        { timeout: 30_000, interval: 150 },
      )
      .toBe(1);

    const events = await rawEvents(thread.id);
    const marker = events.find((event) => event.type === "thread/compacted");
    if (marker === undefined) throw new Error("unreachable");
    const markerData = threadEventDataSchemas["thread/compacted"].parse(marker.data);
    expect(markerData.mode).toBe("snap");
    expect(markerData.method).toBe("manual");
    // The snap turn's own directive hides WITH the cut — the fresh context
    // is empty (the #547 snapshot semantics, no directive residue).
    const snapInput = events.find(
      (event) =>
        event.type === "turn.input" &&
        agentEventDataSchemas["turn.input"].parse(event.data).turnId === markerData.turnId,
    );
    if (snapInput === undefined) throw new Error("snap turn.input missing");
    expect(snapInput.type === "turn.input" && markerData.hideThroughSeq === snapInput.seq).toBe(
      true,
    );
    expect(markerData.tokensAfter).toBe(0);
    // No summarization call on the snap turn.
    const snapCalls = events.filter(
      (event) =>
        event.type === "model.call_started" &&
        agentEventDataSchemas["model.call_started"].parse(event.data).turnId === markerData.turnId,
    );
    expect(snapCalls).toHaveLength(0);

    // The served projection: the op row names the snapshot mode, and the
    // estimated usage row drops to the honest zero of the empty tail (read
    // BEFORE the follow-up turn — its real receipt postdates and supersedes
    // the marker's estimate, the #326 anchor rule).
    const timeline = await exports.default.fetch(
      `${BASE}/api/v1/threads/${thread.id}/timeline?segmentLimit=50`,
    );
    expect(timeline.status).toBe(200);
    const parsed = threadTimelineResponseSchema.parse(await timeline.json());
    const compactionRow = parsed.rows.find(
      (row) =>
        row.kind === "system" && "operationKind" in row && row.operationKind === "compaction",
    );
    if (compactionRow === undefined) throw new Error("no compaction op row");
    if (compactionRow.kind !== "system") throw new Error("unreachable");
    expect(compactionRow.title).toBe("Context compacted (snapshot)");
    expect(parsed.contextWindowUsage?.usedTokens).toBe(0);
    expect(parsed.contextWindowUsage?.estimated).toBe(true);

    // Thread remains usable: a follow-up dispatches past the empty context.
    await sendInput(thread.id, "post-snap follow-up");
    await expect
      .poll(
        async () => {
          const fresh = await rawEvents(thread.id);
          return fresh.some((event) => event.type === "turn.completed" && event.seq > marker.seq);
        },
        { timeout: 30_000, interval: 150 },
      )
      .toBe(true);
  }, 120_000);

  it("remote without a configured summarizer is the named 409", async () => {
    const thread = await createThread({ title: "compact-remote-unconfigured" });
    // Make sure no seat row leaks a remote selection from another suite.
    await deleteCompactionSeat();
    const response = await compactWithMode(thread.id, "remote");
    const body = await response.json<{ code: string; details?: { reason?: string } }>();
    expect(response.status).toBe(409);
    expect(body.code).toBe("invalid_request");
    expect(body.details?.reason).toBe("remote_not_configured");
  });

  it("remote with a configured summarizer pins it on the compact turn (wire evidence)", async () => {
    await addRigRemoteModel();
    const thread = await createThread({
      title: "compact-remote",
      input: [{ type: "text", text: "small opener" }],
    });
    await growJournal(thread.id);
    expect(
      (
        await putCompactionSettings({
          methodOrder: ["soft"],
          remote: { providerId: RIG_PROVIDER_ID, model: "rig-remote" },
        })
      ).status,
    ).toBe(200);
    const wire = await captureRigWireBodies();
    try {
      const response = await compactWithMode(thread.id, "remote");
      expect(response.status, await response.text()).toBe(200);

      await expect
        .poll(
          async () => {
            const events = await rawEvents(thread.id);
            const marker = events.find(
              (event) =>
                event.type === "thread/compacted" &&
                threadEventDataSchemas["thread/compacted"].parse(event.data).mode === "remote",
            );
            return marker === undefined ? 0 : 1;
          },
          { timeout: 30_000, interval: 150 },
        )
        .toBe(1);

      const events = await rawEvents(thread.id);
      const marker = events.find((event) => event.type === "thread/compacted");
      if (marker === undefined) throw new Error("unreachable");
      const markerData = threadEventDataSchemas["thread/compacted"].parse(marker.data);
      expect(markerData.mode).toBe("remote");
      // #351 mechanism: the remote selection is journaled on the compact
      // turn's pin — replay resolves the same delegated model.
      const remoteInput = events.find(
        (event) =>
          event.type === "turn.input" &&
          agentEventDataSchemas["turn.input"].parse(event.data).turnId === markerData.turnId,
      );
      if (remoteInput?.type !== "turn.input") throw new Error("remote turn.input missing");
      expect(agentEventDataSchemas["turn.input"].parse(remoteInput.data).execution).toEqual({
        providerId: RIG_PROVIDER_ID,
        model: "rig-remote",
      });
      // Wire evidence: the outbound relay POST named the delegated model.
      expect(
        wire.bodies.some((body) => {
          const parsed = z.object({ model: z.string() }).safeParse(body);
          return parsed.success && parsed.data.model === "rig-remote";
        }),
      ).toBe(true);
    } finally {
      wire.restore();
    }
    // Restore the absent-row posture for the other suites.
    await deleteCompactionSeat();
  }, 120_000);

  it("the modeless face walks the seat's methodOrder (first entry wins)", async () => {
    const thread = await createThread({
      title: "compact-order",
      input: [{ type: "text", text: "small opener" }],
    });
    await growJournal(thread.id);
    // An operator opting into the snapshot-first order: the bare compact
    // button runs snap without a body.
    expect(
      (await putCompactionSettings({ methodOrder: ["snap", "soft"], remote: null })).status,
    ).toBe(200);
    try {
      const response = await compact(thread.id);
      expect(response.status, await response.text()).toBe(200);
      await expect
        .poll(
          async () => {
            const events = await rawEvents(thread.id);
            return events.filter((event) => event.type === "thread/compacted").length;
          },
          { timeout: 30_000, interval: 150 },
        )
        .toBe(1);
      const marker = (await rawEvents(thread.id)).find(
        (event) => event.type === "thread/compacted",
      );
      if (marker === undefined) throw new Error("unreachable");
      expect(threadEventDataSchemas["thread/compacted"].parse(marker.data).mode).toBe("snap");
    } finally {
      await deleteCompactionSeat();
    }
  }, 120_000);
});

describe("POST /threads/:id/send with '/compact <mode>' (#547)", () => {
  it("a recognized mode argument runs that mode", async () => {
    const thread = await createThread({
      title: "compact-send-snap",
      input: [{ type: "text", text: "small opener" }],
    });
    await growJournal(thread.id);

    const response = await sendCompactCommand(thread.id, "snap");
    expect(response.status, await response.text()).toBe(200);
    await expect
      .poll(
        async () => {
          const events = await rawEvents(thread.id);
          return events.filter((event) => event.type === "thread/compacted").length;
        },
        { timeout: 30_000, interval: 150 },
      )
      .toBe(1);
    const marker = (await rawEvents(thread.id)).find((event) => event.type === "thread/compacted");
    if (marker === undefined) throw new Error("unreachable");
    expect(threadEventDataSchemas["thread/compacted"].parse(marker.data).mode).toBe("snap");
    // The omp alias name rides to the same mode.
    const alias = await sendCompactCommand(thread.id, "snapcompact");
    expect(alias.status).toBe(200);
  }, 120_000);

  it("an unrecognized argument is a named 422, never a silent compact", async () => {
    const thread = await createThread({
      title: "compact-send-bogus",
      input: [{ type: "text", text: "small opener" }],
    });
    await growJournal(thread.id);
    const response = await sendCompactCommand(thread.id, "aggressively");
    const body = await response.json<{ code: string; message?: string }>();
    expect(response.status).toBe(422);
    expect(body.code).toBe("invalid_request");
    expect(body.message).toContain("unknown /compact mode");
    // Nothing compacted.
    const events = await rawEvents(thread.id);
    expect(events.some((event) => event.type === "thread/compacted")).toBe(false);
  });
});
