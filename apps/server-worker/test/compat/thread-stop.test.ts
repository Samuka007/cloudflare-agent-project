import { beforeAll, describe, expect, it } from "vitest";
import { env, exports } from "cloudflare:workers";
import { ensureMigrations } from "../migrate.js";
import { createThread, type CreatedThread } from "../helpers.js";
import { threadResponseSchema } from "../../src/contract/api/threads.js";
import type { AgentDoRpc } from "../../src/seam/agent-do.js";

/**
 * #226: POST /threads/:id/stop must cancel the in-flight turn through the
 * per-thread agent DO's cancel face (turn.cancelled terminal, ask-pending
 * included — the DO-side state machine is asserted in agent-do ask.test.ts).
 * The route is idempotent by derivation: a quiescent journal yields no active
 * turn, so a Stop appends nothing.
 */
beforeAll(ensureMigrations);

const BASE = "https://example.com";

function stop(threadId: string): Promise<Response> {
  return exports.default.fetch(`${BASE}/api/v1/threads/${threadId}/stop`, { method: "POST" });
}

/** Raw journal rows named by the stop route's active-turn fold. */
async function rawCancelRowCount(threadId: string): Promise<number> {
  const stub = env.AGENT_DO.get(env.AGENT_DO.idFromName(threadId)) as unknown as AgentDoRpc;
  const { events } = await stub.getEvents({ sinceSeq: 0 });
  return events.filter(
    (event) => event.type === "turn.cancel_requested" || event.type === "turn.cancelled",
  ).length;
}

async function threadDetail(thread: CreatedThread) {
  const detail = await exports.default.fetch(`${BASE}/api/v1/threads/${thread.id}`);
  expect(detail.status).toBe(200);
  return threadResponseSchema.parse(await detail.json());
}

describe("POST /threads/:id/stop (#226)", () => {
  it("404s an unknown thread", async () => {
    const missing = await stop("thr_does_not_exist");
    expect(missing.status).toBe(404);
    expect((await missing.json<{ code: string }>()).code).toBe("thread_not_found");
  });

  it("is a release no-op on a quiescent thread: no cancel rows land", async () => {
    const thread = await createThread({ title: "stop-quiescent" });
    const response = await stop(thread.id);
    expect(response.status).toBe(200);
    expect(await response.json<{ ok: boolean }>()).toEqual({ ok: true });
    expect(await rawCancelRowCount(thread.id)).toBe(0);
  });

  it("appends no cancel rows once the turn already settled; the thread stays idle", async () => {
    const thread = await createThread({
      title: "stop-after-completion",
      input: [{ type: "text", text: "finish before I stop you" }],
    });
    const wait = await exports.default.fetch(
      `${BASE}/api/v1/threads/${thread.id}/events/wait` +
        `?type=${encodeURIComponent("turn/completed")}&afterSeq=0&waitMs=15000`,
    );
    expect(wait.status).toBe(200);
    const response = await stop(thread.id);
    expect(response.status).toBe(200);
    expect(await rawCancelRowCount(thread.id)).toBe(0);
    // The #52 settlement consumes the terminal event on a timeline fetch.
    const timeline = await exports.default.fetch(
      `${BASE}/api/v1/threads/${thread.id}/timeline?segmentLimit=20`,
    );
    expect(timeline.status).toBe(200);
    expect((await threadDetail(thread)).status).toBe("idle");
  });
});
