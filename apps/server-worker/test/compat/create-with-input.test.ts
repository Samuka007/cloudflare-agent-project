import { beforeAll, describe, expect, it } from "vitest";
import { ensureMigrations } from "../migrate.js";
import { createThread, type CreatedThread } from "../helpers.js";
import { env, exports } from "cloudflare:workers";
import { threadResponseSchema } from "../../src/contract/api/threads.js";
import type { AgentDoRpc } from "../../src/seam/agent-do.js";

/**
 * #61: the SPA composer ships the first message with POST /threads (bb
 * ShowcaseHeroCarousel.tsx:367); bb hands that input to requestThreadProvision
 * (thread-create.ts:533-544) and dispatches it as turn 1 once the environment
 * is ready (thread-provisioning.ts:225-248). The M0 create route dropped
 * payload.input entirely, so SPA-created threads stuck at status=starting
 * forever with an empty event log. These tests pin the bb-verbatim behavior:
 * create-with-input dispatches turn 1 in the create request chain;
 * create-without-input stays a no-turn programmatic start.
 */
beforeAll(ensureMigrations);

/** Raw per-thread DO log: the ux projection drops thread.created/turn.input. */
async function rawEventTypes(threadId: string): Promise<string[]> {
  const stub = env.AGENT_DO.get(env.AGENT_DO.idFromName(threadId)) as unknown as AgentDoRpc;
  const { events } = await stub.getEvents({ sinceSeq: 0 });
  return events.map((event) => event.type);
}

async function threadDetail(thread: CreatedThread) {
  const detail = await exports.default.fetch(`https://example.com/api/v1/threads/${thread.id}`);
  expect(detail.status).toBe(200);
  return threadResponseSchema.parse(await detail.json());
}

describe("create-with-input dispatches the first turn (#61)", () => {
  it("POST /threads with input records the turn sequence and lands the user timeline row", async () => {
    const thread = await createThread({
      title: "create-with-input",
      input: [{ type: "text", text: "first message rides the create" }],
    });
    // The dispatch records the turn on the create chain itself — the row
    // never sits at starting. #477: the instant rig turn also SEALS inside
    // the chain, and the CAS-guarded flip must not resurrect `active` over
    // the settlement — the honest face for a sealed turn is idle.
    const dispatched = await threadDetail(thread);
    expect(dispatched.status).toBe("idle");
    // DO event log: bootstrap + the create-carried turn request.
    const types = await rawEventTypes(thread.id);
    expect(types[0]).toBe("thread.created");
    expect(types).toContain("turn.input");
    // The mock turn seals asynchronously; /events/wait resolves the moment
    // the terminal event lands — no guessed sleep.
    const wait = await exports.default.fetch(
      `https://example.com/api/v1/threads/${thread.id}/events/wait` +
        `?type=${encodeURIComponent("turn/completed")}&afterSeq=0&waitMs=15000`,
    );
    expect(wait.status).toBe(200);
    // Timeline: the user row materializes from the create-carried input.
    const timeline = await exports.default.fetch(
      `https://example.com/api/v1/threads/${thread.id}/timeline?segmentLimit=20`,
    );
    expect(timeline.status).toBe(200);
    const body = await timeline.json<{
      rows: { kind: string; role: string; text: string }[];
    }>();
    const userRow = body.rows.find((row) => row.kind === "conversation" && row.role === "user");
    expect(userRow?.text).toBe("first message rides the create");
    // #52 settlement consumes the terminal event on the timeline fetch.
    const settled = await threadDetail(thread);
    expect(settled.status).toBe("idle");
  });

  it("POST /threads without input stays a no-turn programmatic start", async () => {
    const thread = await createThread({ title: "create-without-input" });
    const body = await threadDetail(thread);
    // Unchanged behavior: no dispatch, coarse status stays starting.
    expect(body.status).toBe("starting");
    const types = await rawEventTypes(thread.id);
    expect(types).toEqual(["thread.created"]);
    // No user row: the timeline is empty.
    const timeline = await exports.default.fetch(
      `https://example.com/api/v1/threads/${thread.id}/timeline?segmentLimit=20`,
    );
    const timelineBody = await timeline.json<{ rows: unknown[] }>();
    expect(timelineBody.rows).toEqual([]);
  });
});
