import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { env, exports } from "cloudflare:workers";
import { classifyExecutionSettingsChange } from "@cap/provider-app";
import type { AnyAgentEvent } from "@cap/agent-do";
import { ensureMigrations } from "../migrate.js";
import {
  ensureRigReady,
  removeRigProviderRow,
  RIG_RELAY_BASE_URL,
  RIG_MODEL_ID,
  RIG_PROVIDER_ID,
} from "../helpers.js";
import {
  classifyThreadSelectionChange,
  type ResolvedThreadExecutionSelection,
} from "../../src/services/execution-selection.js";
import type { RuntimeThreadExecutionOptions } from "../../../daemon-worker/src/provider-types.js";

/**
 * #351/#450 thread-level provider/model/reasoningLevel selection: the
 * create/send payloads validate fail-closed against the D1 directory
 * (unknown values 422 with a NAMED error — provider_unknown / model_unknown /
 * reasoning_level_unknown — and #434/#450 add provider_default_undeclared for
 * a selection-less payload, since rows never declare a deployment-wide
 * default); a valid selection persists to the threads row overrides, bridges
 * through the composed chain (route → orchestrator → manager → agent DO)
 * into thread.created / turn.input journal rows, and send-time drift
 * classifies over the bb unchanged/live/session vocabulary.
 *
 * The suite runs against the RIG's D1 provider row (budget off → the
 * declared ladder collapses to ["none"]). The empty-directory fail-closed
 * state is covered by the unconfigured-deployment assertions in
 * system-execution-options.test.ts and the agent-do/provider-app suites
 * (#434: nothing is synthesized, so an empty directory admits no selection
 * at all).
 */

beforeAll(async () => {
  await ensureMigrations();
  await ensureRigReady();
});

afterAll(async () => {
  // The suite shares one worker (isolate:false) — leave the rig row in place
  // for the later files (the suite-local rows were never seeded).
  await ensureRigReady();
});

const BASE = "https://example.com";

async function post(path: string, body: unknown): Promise<Response> {
  return exports.default.fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

interface CreatedThread {
  id: string;
  projectId: string;
}

async function createThread(args: Record<string, unknown>): Promise<Response> {
  return post("/api/v1/threads", {
    projectId: "proj_personal",
    origin: "app",
    environment: { type: "host", workspace: { type: "personal" } },
    input: [{ type: "text", text: "selection rig first message" }],
    ...args,
  });
}

/** Raw per-thread journal with the typed event union (UX projection drops
 * thread.created/turn.input, so the selection assertions read raw). */
async function rawEvents(threadId: string): Promise<AnyAgentEvent[]> {
  // Boundary cast: the DO namespace RPC loses the event union to
  // UxThreadEvent's `data: unknown`; the raw projection IS AnyAgentEvent.
  const stub = env.AGENT_DO.get(env.AGENT_DO.idFromName(threadId)) as unknown as {
    getEvents(args: { sinceSeq: number; project: "raw" }): Promise<{ events: AnyAgentEvent[] }>;
  };
  const { events } = await stub.getEvents({ sinceSeq: 0, project: "raw" });
  return events;
}

async function threadRow(threadId: string): Promise<{
  provider_id: string;
  model_override: string | null;
  reasoning_level_override: string | null;
}> {
  const row = await env.DB.prepare(
    "SELECT provider_id, model_override, reasoning_level_override FROM threads WHERE id = ?",
  )
    .bind(threadId)
    .first();
  expect(row).not.toBeNull();
  return row as {
    provider_id: string;
    model_override: string | null;
    reasoning_level_override: string | null;
  };
}

async function expect422(
  response: Response,
  code: string,
): Promise<{ code: string; message: string }> {
  expect(response.status).toBe(422);
  const body = await response.json<{ code: string; message: string }>();
  expect(body.code).toBe(code);
  // Named + actionable: the message names the offending value's context.
  expect(body.message.length).toBeGreaterThan(0);
  return body;
}

/** Deterministic settle: the create-carried turn's terminal event. */
async function waitTurnSettled(threadId: string): Promise<void> {
  const wait = await exports.default.fetch(
    `${BASE}/api/v1/threads/${threadId}/events/wait` +
      `?type=${encodeURIComponent("turn/completed")}&afterSeq=0&waitMs=15000`,
  );
  expect(wait.status).toBe(200);
}

describe("#351 fail-closed selection validation over the D1 directory", () => {
  it("create with an unknown providerId → 422 provider_unknown", async () => {
    const response = await createThread({ providerId: "ghost-provider" });
    await expect422(response, "provider_unknown");
  });

  it("create with an unknown model → 422 model_unknown", async () => {
    // Without providerId the default absence fires first (#434/#450) — the
    // model check needs the explicit provider.
    const response = await createThread({ providerId: RIG_PROVIDER_ID, model: "ghost-model" });
    await expect422(response, "model_unknown");
  });

  it("create with a non-none reasoning rung → 422 reasoning_level_unknown (budget off collapses the ladder)", async () => {
    const response = await createThread({
      providerId: RIG_PROVIDER_ID,
      model: RIG_MODEL_ID,
      reasoningLevel: "high",
    });
    await expect422(response, "reasoning_level_unknown");
  });

  it("create with NO selection → 422 provider_default_undeclared (#434/#450 fail-closed)", async () => {
    // #434/#450: D1 rows carry no deployment-wide default declaration, so a
    // selection-less create is the named 422 — the picker always sends the
    // explicit selection, never a guessed provider.
    const response = await createThread({});
    const body = await expect422(response, "provider_default_undeclared");
    expect(body.message).toContain("no provider selected");
  });

  it("send with an unknown model → 422 model_unknown before any turn lands", async () => {
    const created = await createThread({
      providerId: RIG_PROVIDER_ID,
      model: RIG_MODEL_ID,
    });
    expect(created.status).toBe(201);
    const thread = await created.json<CreatedThread>();
    const before = (await rawEvents(thread.id)).length;
    const response = await post(`/api/v1/threads/${thread.id}/send`, {
      input: [{ type: "text", text: "should never dispatch" }],
      mode: "auto",
      model: "ghost-model",
    });
    await expect422(response, "model_unknown");
    // Fail-closed: the rejected send appended nothing.
    expect((await rawEvents(thread.id)).length).toBe(before);
  });

  it("send with an unknown reasoning rung → 422 reasoning_level_unknown", async () => {
    const created = await createThread({
      providerId: RIG_PROVIDER_ID,
      model: RIG_MODEL_ID,
    });
    expect(created.status).toBe(201);
    const thread = await created.json<CreatedThread>();
    const response = await post(`/api/v1/threads/${thread.id}/send`, {
      input: [{ type: "text", text: "x" }],
      mode: "auto",
      model: RIG_MODEL_ID,
      reasoningLevel: "ultra",
    });
    await expect422(response, "reasoning_level_unknown");
  });
});

describe("#351 selection consumption", () => {
  it("a valid selection persists to the row overrides and bridges into the journal", async () => {
    const response = await createThread({
      providerId: RIG_PROVIDER_ID,
      model: RIG_MODEL_ID,
      reasoningLevel: "none",
    });
    expect(response.status).toBe(201);
    const thread = await response.json<CreatedThread>();

    // Control-plane half: the threads row override columns.
    const row = await threadRow(thread.id);
    expect(row.provider_id).toBe(RIG_PROVIDER_ID);
    expect(row.model_override).toBe(RIG_MODEL_ID);
    expect(row.reasoning_level_override).toBe("none");

    // Trajectory half (through the composed bridge: route → orchestrator →
    // manager → agent DO): thread.created carries the explicit selection and
    // the create-carried turn pins it.
    const events = await rawEvents(thread.id);
    const created = events.find((event) => event.type === "thread.created");
    expect(created?.data).toMatchObject({
      execution: { providerId: RIG_PROVIDER_ID, model: RIG_MODEL_ID, reasoningLevel: "none" },
    });
    const turnInput = events.find((event) => event.type === "turn.input");
    expect(turnInput?.data).toMatchObject({
      execution: { providerId: RIG_PROVIDER_ID, model: RIG_MODEL_ID, reasoningLevel: "none" },
    });
  });

  it("#434 point 8: a selection naming the retired omp sentinel is 422 provider_unknown", async () => {
    const response = await createThread({
      providerId: "omp",
      model: RIG_MODEL_ID,
      reasoningLevel: "none",
    });
    await expect422(response, "provider_unknown");
  });

  it("a fork create with the explicit selection stays a no-turn programmatic start", async () => {
    const response = await createThread({
      input: [],
      originKind: "fork",
      providerId: RIG_PROVIDER_ID,
      model: RIG_MODEL_ID,
    });
    expect(response.status).toBe(201);
    const thread = await response.json<CreatedThread>();
    const row = await threadRow(thread.id);
    expect(row.provider_id).toBe(RIG_PROVIDER_ID);
    expect(row.model_override).toBe(RIG_MODEL_ID);
    expect(row.reasoning_level_override).toBeNull();
    const events = await rawEvents(thread.id);
    const created = events.find((event) => event.type === "thread.created");
    expect(created?.data).toMatchObject({ execution: { providerId: RIG_PROVIDER_ID } });
    // No turn dispatched: the fork shape starts no turn.
    expect(events.some((event) => event.type === "turn.input")).toBe(false);
  });

  it("an equal send is classified unchanged — no ride row, no override churn", async () => {
    const created = await createThread({
      providerId: RIG_PROVIDER_ID,
      model: RIG_MODEL_ID,
      reasoningLevel: "none",
    });
    expect(created.status).toBe(201);
    const thread = await created.json<CreatedThread>();
    const turnCount = (await rawEvents(thread.id)).filter(
      (event) => event.type === "turn.input",
    ).length;

    // Settle the create-carried turn BEFORE the send: a send arriving on an
    // active turn becomes a steer (no second turn), which is not this test's
    // subject. With the thread quiescent, the equal send deterministically
    // dispatches a fresh turn.
    await waitTurnSettled(thread.id);

    const response = await post(`/api/v1/threads/${thread.id}/send`, {
      input: [{ type: "text", text: "same selection again" }],
      mode: "auto",
      model: RIG_MODEL_ID,
      reasoningLevel: "none",
    });
    expect(response.status).toBe(200);

    // The send turn journals asynchronously (the route queues through the
    // composed bridge; the DO RPC returns after the turn.input append lands,
    // so the journal already carries it when the send resolves.
    const events = await rawEvents(thread.id);
    expect(events.filter((event) => event.type === "thread.execution_updated")).toHaveLength(0);
    // The new turn dispatched (auto → queue) but carries no changed pin.
    const inputs = events.filter((event) => event.type === "turn.input");
    expect(inputs.length).toBe(turnCount + 1);
    const row = await threadRow(thread.id);
    expect(row.model_override).toBe(RIG_MODEL_ID);
    expect(row.reasoning_level_override).toBe("none");
  });
});

describe("#351 drift classification (bb three-value vocabulary)", () => {
  it("selection triples classify unchanged/live over the shared classifier", () => {
    const current: ResolvedThreadExecutionSelection = {
      providerId: RIG_PROVIDER_ID,
      model: RIG_MODEL_ID,
      reasoningLevel: "none",
    };
    expect(classifyThreadSelectionChange(current, current)).toBe("unchanged");
    expect(classifyThreadSelectionChange(current, { ...current, model: "other-model" })).toBe(
      "live",
    );
    expect(classifyThreadSelectionChange(current, { ...current, reasoningLevel: "high" })).toBe(
      "live",
    );
  });

  it("the classifier keeps the session verdict for permission drift (vocabulary guard)", () => {
    const full: RuntimeThreadExecutionOptions = {
      model: RIG_MODEL_ID,
      serviceTier: "default" as const,
      reasoningLevel: "none" as const,
      workflowsEnabled: false,
      permissionMode: "full" as const,
      permissionScope: "full" as const,
      approvalReviewer: null,
      permissionEscalation: null,
    };
    const auto: RuntimeThreadExecutionOptions = {
      ...full,
      permissionMode: "auto",
      permissionScope: "workspace",
      approvalReviewer: "automatic",
      permissionEscalation: "deny",
    };
    expect(classifyExecutionSettingsChange(full, { ...full, model: "other" })).toBe("live");
    expect(classifyExecutionSettingsChange(full, auto)).toBe("session");
  });
});

describe("#486 thread default-execution-options face", () => {
  interface DefaultExecutionOptionsBody {
    model: string;
    serviceTier: string;
    reasoningLevel: string;
    permissionMode: string;
    source: string;
  }

  async function getDefaultExecutionOptions(
    threadId: string,
  ): Promise<{ status: number; body: DefaultExecutionOptionsBody | null }> {
    const response = await exports.default.fetch(
      `${BASE}/api/v1/threads/${threadId}/default-execution-options`,
    );
    return {
      status: response.status,
      body:
        response.status === 200
          ? await response.json<DefaultExecutionOptionsBody>()
          : null,
    };
  }

  /** #450 the directory is D1: a second row reuses the rig's credential slot
   * and wire so any dispatch hits the same stub. */
  async function insertProviderRow(id: string, models: { id: string }[]): Promise<void> {
    const rig = await env.DB.prepare(
      "SELECT api_key_enc FROM provider_configs WHERE id = ?",
    )
      .bind(RIG_PROVIDER_ID)
      .first<{ api_key_enc: string }>();
    await env.DB.prepare(
      "INSERT OR IGNORE INTO provider_configs (id, display_name, base_url, api, service_tier, api_key_enc, models, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?)",
    )
      .bind(
        id,
        id,
        RIG_RELAY_BASE_URL,
        "anthropic-messages",
        rig?.api_key_enc ?? "",
        JSON.stringify(
          models.map((model) => ({
            id: model.id,
            reasoningLevels: ["none"],
            defaultReasoningLevel: "none",
          })),
        ),
        Date.now(),
        Date.now(),
      )
      .run();
  }

  it("a thread's stored selection is the face — display seed equals the dispatched pin", async () => {
    const created = await createThread({
      providerId: RIG_PROVIDER_ID,
      model: RIG_MODEL_ID,
    });
    expect(created.status).toBe(201);
    const thread = await created.json<CreatedThread>();
    const { status, body } = await getDefaultExecutionOptions(thread.id);
    expect(status).toBe(200);
    expect(body).toEqual({
      model: RIG_MODEL_ID,
      serviceTier: "default",
      reasoningLevel: "none",
      permissionMode: "full",
      source: "client/turn/requested",
    });
  });

  it("a stored selection the directory dropped returns verbatim — never re-projected onto the harness model", async () => {
    const created = await createThread({
      providerId: RIG_PROVIDER_ID,
      model: RIG_MODEL_ID,
    });
    expect(created.status).toBe(201);
    const thread = await created.json<CreatedThread>();

    await insertProviderRow("side", [{ id: "side-model" }]);
    await removeRigProviderRow();
    try {
      const { status, body } = await getDefaultExecutionOptions(thread.id);
      expect(status).toBe(200);
      expect(body?.model).toBe(RIG_MODEL_ID);

      // The picker pool keeps the dropped selection renderable (bb's
      // selected-only contract) — provider-scoped by the query.
      const scoped = await exports.default.fetch(
        `${BASE}/api/v1/system/execution-options?providerId=${RIG_PROVIDER_ID}`,
      );
      const scopedBody = await scoped.json<{
        models: { model: string }[];
        selectedOnlyModels: { model: string; isDefault: boolean }[];
      }>();
      expect(scopedBody.models.map((model) => model.model)).toEqual(["side-model"]);
      expect(scopedBody.selectedOnlyModels.map((model) => model.model)).toEqual([RIG_MODEL_ID]);
      expect(scopedBody.selectedOnlyModels[0]?.isDefault).toBe(false);

      const otherProvider = await exports.default.fetch(
        `${BASE}/api/v1/system/execution-options?providerId=side`,
      );
      const otherBody = await otherProvider.json<{ selectedOnlyModels: unknown[] }>();
      expect(otherBody.selectedOnlyModels).toEqual([]);

      // And dispatching the dropped selection still fails closed with the
      // named error — the read face never relaxes the write face.
      const send = await post(`/api/v1/threads/${thread.id}/send`, {
        input: [{ type: "text", text: "dispatch the dropped row" }],
        mode: "auto",
        model: RIG_MODEL_ID,
      });
      // The rig PROVIDER row is gone, so the rejection names the provider.
      await expect422(send, "provider_unknown");
    } finally {
      await env.DB.prepare("DELETE FROM provider_configs WHERE id = 'side'").run();
      await ensureRigReady();
    }
  });

  it("no stored override under a harness model the provider does not declare serves bb's null face", async () => {
    // #450 selection-less creates 422, so a NULL override row only exists as
    // a pre-#450 legacy row — simulated with a direct D1 write. The rig
    // directory never declares the harness default model, so the read face
    // answers bb's stored-defaults-absent null instead of projecting one.
    const created = await createThread({
      providerId: RIG_PROVIDER_ID,
      model: RIG_MODEL_ID,
    });
    expect(created.status).toBe(201);
    const thread = await created.json<CreatedThread>();
    await env.DB.prepare("UPDATE threads SET model_override = NULL WHERE id = ?")
      .bind(thread.id)
      .run();
    try {
      const { status, body } = await getDefaultExecutionOptions(thread.id);
      expect(status).toBe(200);
      expect(body).toBeNull();
    } finally {
      await env.DB.prepare("DELETE FROM threads WHERE id = ?").bind(thread.id).run();
    }
  });

  it("a changed follow-up send persists the override and pins the turn journal (timeline-provable dispatch)", async () => {
    // A second rig model gives the follow-up a LIVE change to classify; the
    // row surgery is undone through the rig re-seed below.
    await env.DB.prepare("UPDATE provider_configs SET models = ? WHERE id = ?")
      .bind(
        JSON.stringify([
          { id: RIG_MODEL_ID, reasoningLevels: ["none"], defaultReasoningLevel: "none" },
          { id: "rig-model-2", reasoningLevels: ["none"], defaultReasoningLevel: "none" },
        ]),
        RIG_PROVIDER_ID,
      )
      .run();
    const created = await createThread({
      providerId: RIG_PROVIDER_ID,
      model: RIG_MODEL_ID,
    });
    expect(created.status).toBe(201);
    const thread = await created.json<CreatedThread>();

    const nextModel = "rig-model-2";
    const response = await post(`/api/v1/threads/${thread.id}/send`, {
      input: [{ type: "text", text: "switch models" }],
      mode: "auto",
      model: nextModel,
    });
    expect(response.status).toBe(200);

    const row = await threadRow(thread.id);
    expect(row.model_override).toBe(nextModel);
    const events = await rawEvents(thread.id);
    expect(events.find((event) => event.type === "thread.execution_updated")).toBeDefined();
    const lastTurnInput = events
      .filter((event) => event.type === "turn.input")
      .at(-1);
    expect(lastTurnInput?.data).toMatchObject({
      // The ride is the payload's EXPLICIT selection verbatim (#351) — the
      // reasoning rung stays unset when the payload omits it and the ladder
      // default fills at dispatch.
      execution: { providerId: RIG_PROVIDER_ID, model: nextModel },
    });
    await ensureRigReady();
  });
});
