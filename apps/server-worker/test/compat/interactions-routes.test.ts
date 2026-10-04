import { beforeAll, describe, expect, it } from "vitest";
import { runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { ensureMigrations } from "../migrate.js";
import { createThread, type CreatedThread } from "../helpers.js";
import { threadPendingInteractionsResponseSchema } from "../../src/contract/api/threads.js";

/**
 * #225: the SPA interactions faces — the bb routes the pending-interaction
 * card consumes (list / single / resolve, bb routes/threads/interactions.ts).
 * The DO journal is the row source; tests seed it through the DO's own
 * appendEvent write path (turn.input first — the fold requires the turn) and
 * exercise the public HTTP faces end-to-end, including the D1 mirror the
 * thread-list `hasPendingInteraction` EXISTS probe reads.
 */

beforeAll(ensureMigrations);

/** Test-side journal seeder: appendEvent is the DO's private single write
 * path; the test seam names that cast once and drives it directly. */
interface JournalAppender {
  appendEvent(type: string, data: Record<string, unknown>): Promise<unknown>;
}

interface Seed {
  interactionId: string;
  turnId: string;
  executionId: string;
}

async function seedPendingAsk(thread: CreatedThread, tag: string): Promise<Seed> {
  const turnId = `turn_seed_${tag}`;
  const executionId = `${thread.id}#exec_${tag}`;
  const interactionId = `pi_${tag}`;
  const stub = env.AGENT_DO.get(env.AGENT_DO.idFromName(thread.id));
  await runInDurableObject(stub, async (instance) => {
    const appender = instance as unknown as JournalAppender;
    await appender.appendEvent("turn.input", {
      turnId,
      inputId: `in_${tag}`,
      content: [{ type: "text", text: "seed" }],
    });
    await appender.appendEvent("interaction.registered", {
      interactionId,
      turnId,
      executionId,
      providerId: "omp",
      providerThreadId: thread.id,
      providerRequestId: executionId,
      expiresAt: null,
      payload: {
        kind: "user_question",
        questions: [
          {
            id: "q1",
            prompt: "Pick one?",
            multiSelect: false,
            options: [
              { value: "v1", label: "One" },
              { value: "v2", label: "Two" },
            ],
            allowFreeText: true,
          },
        ],
      },
    });
  });
  return { interactionId, turnId, executionId };
}

async function get(path: string): Promise<Response> {
  return exports.default.fetch(`https://example.com${path}`);
}

describe("#225 thread interactions faces", () => {
  it("GET list returns [] for a thread with no interactions", async () => {
    const thread = await createThread({ title: "ask-empty" });
    const response = await get(`/api/v1/threads/${thread.id}/interactions`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([]);
  });

  it("serves the pending journal fold; unknown and foreign ids 404", async () => {
    const thread = await createThread({ title: "ask-list" });
    const seed = await seedPendingAsk(thread, "list1");

    const response = await get(`/api/v1/threads/${thread.id}/interactions`);
    expect(response.status).toBe(200);
    const body = threadPendingInteractionsResponseSchema.parse(await response.json());
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({
      id: seed.interactionId,
      threadId: thread.id,
      turnId: seed.turnId,
      status: "pending",
      statusReason: null,
      resolvedAt: null,
      providerId: "omp",
      providerThreadId: thread.id,
      providerRequestId: seed.executionId,
      resolution: null,
      payload: {
        kind: "user_question",
        questions: [expect.objectContaining({ id: "q1", prompt: "Pick one?" })],
      },
    });

    // Single-row face: found, then unknown id and a mismatched thread 404.
    const single = await get(`/api/v1/threads/${thread.id}/interactions/${seed.interactionId}`);
    expect(single.status).toBe(200);
    expect(await single.json()).toMatchObject({ id: seed.interactionId });

    const missing = await get(`/api/v1/threads/${thread.id}/interactions/pi_missing00`);
    expect(missing.status).toBe(404);

    const other = await createThread({ title: "ask-list-other" });
    const foreign = await get(`/api/v1/threads/${other.id}/interactions/${seed.interactionId}`);
    expect(foreign.status).toBe(404);
  });

  it("resolves through the DO journal; repeats 409; invalid rulings 400", async () => {
    const thread = await createThread({ title: "ask-resolve" });
    const seed = await seedPendingAsk(thread, "res1");
    const resolve = (body: unknown): Promise<Response> =>
      exports.default.fetch(
        `https://example.com/api/v1/threads/${thread.id}/interactions/${seed.interactionId}/resolve`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
      );

    const valid = await resolve({
      kind: "user_answer",
      answers: { q1: { selected: ["v2"] } },
    });
    expect(valid.status).toBe(200);
    const resolved = await valid.json<{
      status: string;
      resolution: { kind: string; answers: Record<string, unknown> };
      resolvedAt: number | null;
    }>();
    expect(resolved.status).toBe("resolved");
    expect(resolved.resolvedAt).not.toBeNull();
    expect(resolved.resolution).toEqual({ kind: "user_answer", answers: { q1: { selected: ["v2"] } } });

    // The list face drops the settled row (bb listPendingThreadInteractions).
    const list = await get(`/api/v1/threads/${thread.id}/interactions`);
    expect(await list.json()).toEqual([]);

    const repeat = await resolve({ kind: "user_answer", answers: { q1: { selected: ["v2"] } } });
    expect(repeat.status).toBe(409);

    const second = await createThread({ title: "ask-resolve-2" });
    await seedPendingAsk(second, "res2");
    const invalid = await exports.default.fetch(
      `https://example.com/api/v1/threads/${second.id}/interactions/pi_res2/resolve`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "user_answer", answers: { q1: { selected: ["nope"] } } }),
      },
    );
    expect(invalid.status).toBe(400);
  });

  it("mirrors rows into D1 so the thread-list pending probe self-heals", async () => {
    const thread = await createThread({ title: "ask-mirror" });
    const seed = await seedPendingAsk(thread, "mir1");

    // The self-heal trigger IS the interactions read (the DO journal is the
    // row source; the mirror catches up whenever the faces are served).
    const interactions = await get(`/api/v1/threads/${thread.id}/interactions`);
    expect(interactions.status).toBe(200);

    const listDuring = await get("/api/v1/threads");
    const during = await listDuring.json<{ id: string; hasPendingInteraction: boolean }[]>();
    expect(during.find((entry) => entry.id === thread.id)?.hasPendingInteraction).toBe(true);

    await exports.default.fetch(
      `https://example.com/api/v1/threads/${thread.id}/interactions/${seed.interactionId}/resolve`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "user_answer", answers: { q1: { selected: ["v1"] } } }),
      },
    );

    const listAfter = await get("/api/v1/threads");
    const after = await listAfter.json<{ id: string; hasPendingInteraction: boolean }[]>();
    expect(after.find((entry) => entry.id === thread.id)?.hasPendingInteraction).toBe(false);
  });
});
