import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { env, exports } from "cloudflare:workers";
import { classifyExecutionSettingsChange } from "@cap/provider-app";
import type { AnyAgentEvent } from "@cap/agent-do";
import { ensureMigrations } from "../migrate.js";
import { restoreRigRelayCatalog } from "../helpers.js";
import {
  classifyThreadSelectionChange,
  type ResolvedThreadExecutionSelection,
} from "../../src/services/execution-selection.js";
import type { RuntimeThreadExecutionOptions } from "../../../daemon-worker/src/provider-types.js";

/**
 * #351 thread-level provider/model/reasoningLevel selection: the create/send
 * payloads validate fail-closed against the catalog directory (unknown
 * values 422 with a NAMED error — provider_unknown / model_unknown /
 * reasoning_level_unknown — and #434 adds provider_default_undeclared for a
 * selection-less payload under a declaration with no defaultProvider); a
 * valid selection persists to the threads row overrides, bridges through the
 * composed chain
 * (route → orchestrator → manager → agent DO) into thread.created /
 * turn.input journal rows, and send-time drift classifies over the bb
 * unchanged/live/session vocabulary.
 *
 * The suite injects ONE declared catalog (budget off → every declared ladder
 * collapses to ["none"]). The empty-catalog fail-closed state is covered by
 * the unconfigured-deployment assertions in system-execution-options.test.ts
 * and the agent-do/provider-app suites (#434: nothing is synthesized, so an
 * empty directory admits no selection at all).
 */

beforeAll(ensureMigrations);

const SUITE_CATALOG = JSON.stringify({
  defaultProvider: "main",
  providers: {
    main: {
      models: [
        { id: "model-a", reasoningLevels: ["none", "high"], defaultReasoningLevel: "none" },
        { id: "model-b" },
      ],
    },
    side: { models: [{ id: "model-c" }] },
  },
});

beforeAll(() => {
  (env as unknown as Record<string, string>).MODEL_RELAY_CATALOG = SUITE_CATALOG;
});

afterAll(() => {
  // The suite shares one worker (isolate:false) — restore the RIG
  // declaration (#434: the rig is a configured deployment).
  restoreRigRelayCatalog();
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

describe("#351 fail-closed selection validation over the declared catalog", () => {
  it("create with an unknown providerId → 422 provider_unknown", async () => {
    const response = await createThread({ providerId: "ghost-provider" });
    await expect422(response, "provider_unknown");
  });

  it("create with an unknown model → 422 model_unknown", async () => {
    const response = await createThread({ model: "ghost-model" });
    await expect422(response, "model_unknown");
  });

  it("create with a non-none reasoning rung → 422 reasoning_level_unknown (budget off collapses the ladder)", async () => {
    const response = await createThread({ reasoningLevel: "high" });
    await expect422(response, "reasoning_level_unknown");
  });

  it("create with NO selection under a declared default → the declaration fills it", async () => {
    // #434 point 3: the declared defaultProvider is the only implicit fill;
    // the resolved provider lands on the row, the journal carries no
    // explicit selection.
    const response = await createThread({});
    expect(response.status).toBe(201);
    const thread = await response.json<CreatedThread>();
    const row = await threadRow(thread.id);
    expect(row.provider_id).toBe("main");
    expect(row.model_override).toBeNull();
    const events = await rawEvents(thread.id);
    expect(events.find((event) => event.type === "thread.created")?.data.execution).toBeUndefined();
  });

  it("send with an unknown model → 422 model_unknown before any turn lands", async () => {
    const created = await createThread({});
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
    const created = await createThread({});
    expect(created.status).toBe(201);
    const thread = await created.json<CreatedThread>();
    const response = await post(`/api/v1/threads/${thread.id}/send`, {
      input: [{ type: "text", text: "x" }],
      mode: "auto",
      reasoningLevel: "ultra",
    });
    await expect422(response, "reasoning_level_unknown");
  });
});

describe("#351 selection consumption", () => {
  it("a valid selection persists to the row overrides and bridges into the journal", async () => {
    const response = await createThread({
      providerId: "main",
      model: "model-a",
      reasoningLevel: "none",
    });
    expect(response.status).toBe(201);
    const thread = await response.json<CreatedThread>();

    // Control-plane half: the threads row override columns.
    const row = await threadRow(thread.id);
    expect(row.provider_id).toBe("main");
    expect(row.model_override).toBe("model-a");
    expect(row.reasoning_level_override).toBe("none");

    // Trajectory half (through the composed bridge: route → orchestrator →
    // manager → agent DO): thread.created carries the explicit selection and
    // the create-carried turn pins it.
    const events = await rawEvents(thread.id);
    const created = events.find((event) => event.type === "thread.created");
    expect(created?.data).toMatchObject({
      execution: { providerId: "main", model: "model-a", reasoningLevel: "none" },
    });
    const turnInput = events.find((event) => event.type === "turn.input");
    expect(turnInput?.data).toMatchObject({
      execution: { providerId: "main", model: "model-a", reasoningLevel: "none" },
    });
  });

  it("#434 point 8: a selection naming the retired omp sentinel is 422 provider_unknown", async () => {
    const response = await createThread({
      providerId: "omp",
      model: "model-a",
      reasoningLevel: "none",
    });
    await expect422(response, "provider_unknown");
  });

  it("a fork create without selection or input resolves the declared default", async () => {
    const response = await createThread({ input: [], originKind: "fork" });
    expect(response.status).toBe(201);
    const thread = await response.json<CreatedThread>();
    const row = await threadRow(thread.id);
    expect(row.provider_id).toBe("main");
    expect(row.model_override).toBeNull();
    expect(row.reasoning_level_override).toBeNull();
    const events = await rawEvents(thread.id);
    const created = events.find((event) => event.type === "thread.created");
    expect(created?.data.execution).toBeUndefined();
  });

  it("an equal send is classified unchanged — no ride row, no override churn", async () => {
    const created = await createThread({
      model: "model-a",
      reasoningLevel: "none",
    });
    expect(created.status).toBe(201);
    const thread = await created.json<CreatedThread>();
    const turnCount = (await rawEvents(thread.id)).filter(
      (event) => event.type === "turn.input",
    ).length;

    const response = await post(`/api/v1/threads/${thread.id}/send`, {
      input: [{ type: "text", text: "same selection again" }],
      mode: "auto",
      model: "model-a",
      reasoningLevel: "none",
    });
    expect(response.status).toBe(200);

    const events = await rawEvents(thread.id);
    expect(events.filter((event) => event.type === "thread.execution_updated")).toHaveLength(0);
    // The new turn dispatched (auto → queue) but carries no changed pin.
    const inputs = events.filter((event) => event.type === "turn.input");
    expect(inputs.length).toBe(turnCount + 1);
    const row = await threadRow(thread.id);
    expect(row.model_override).toBe("model-a");
    expect(row.reasoning_level_override).toBe("none");
  });
});

describe("#351 drift classification (bb three-value vocabulary)", () => {
  it("selection triples classify unchanged/live over the shared classifier", () => {
    const current: ResolvedThreadExecutionSelection = {
      providerId: "main",
      model: "model-a",
      reasoningLevel: "none",
    };
    expect(classifyThreadSelectionChange(current, current)).toBe("unchanged");
    expect(classifyThreadSelectionChange(current, { ...current, model: "model-b" })).toBe("live");
    expect(classifyThreadSelectionChange(current, { ...current, reasoningLevel: "high" })).toBe(
      "live",
    );
  });

  it("the classifier keeps the session verdict for permission drift (vocabulary guard)", () => {
    const full: RuntimeThreadExecutionOptions = {
      model: "model-a",
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
