import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { env, exports } from "cloudflare:workers";
import { ensureMigrations } from "../migrate.js";
import { createThread } from "../helpers.js";
import {
  threadResponseSchema,
  threadWithIncludesResponseSchema,
} from "../../src/contract/api/threads.js";
import { threadListEntrySchema } from "../../src/contract/domain/thread.js";
import { threadSummarySchema } from "@cap/protocol";
import type { AgentDoRpc } from "../../src/seam/agent-do.js";

/**
 * #288 binding feed-through (inventory #282 §2.A): POST /threads resolves the
 * workspace binding ONCE (explicit host/reuse > project default source >
 * deployment single machine), materializes the environments row, lands
 * threads.environment_id, freezes thread.created.machineId into the
 * trajectory, and the read faces inline the binding (list join fields,
 * include=environment/host, GET /environments). Rebind is the explicit
 * thread.rebound event (§2.1: system-side switching never happens).
 */

beforeAll(ensureMigrations);

const apiErrorBodySchema = z.object({ code: z.string() });
const createdThreadBodySchema = threadResponseSchema.pick({ id: true, environmentId: true });

/** The helper's programmatic no-turn shape (originKind null would 422 on
 * empty input); explicit payloads use it so only the binding varies. */
const NO_TURN_CREATE = { origin: "app", input: [], originKind: "fork" } as const;

async function postJson(path: string, body: unknown): Promise<Response> {
  return exports.default.fetch(`https://example.com${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function getJson(path: string): Promise<{ status: number; body: unknown }> {
  const response = await exports.default.fetch(`https://example.com${path}`);
  return { status: response.status, body: await response.json() };
}

/** Raw per-thread DO log (create-with-input.test.ts idiom). */
async function rawEvents(threadId: string): Promise<{ type: string; data: unknown }[]> {
  const stub = env.AGENT_DO.get(env.AGENT_DO.idFromName(threadId)) as unknown as AgentDoRpc;
  const { events } = await stub.getEvents({ sinceSeq: 0 });
  return events.map((event) => ({ type: event.type, data: event.data }));
}

/** Guarded single-field read off a journal row's schema-validated data. */
function dataField(data: unknown, key: string): unknown {
  if (typeof data === "object" && data !== null && key in data) {
    return (data as Record<string, unknown>)[key];
  }
  return undefined;
}

function machineIdOfFirstEvent(events: { type: string; data: unknown }[]): string | undefined {
  const first = events[0];
  const value = first === undefined ? undefined : dataField(first.data, "machineId");
  return typeof value === "string" ? value : undefined;
}

interface HostSeed {
  id: string;
}

let hostCounter = 0;

async function seedHost(): Promise<HostSeed> {
  hostCounter += 1;
  const id = `host288_${hostCounter}_${Math.random().toString(36).slice(2, 8)}`;
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO hosts (id, name, type, connect_machine_id, max_permission_mode, destroyed_at, last_seen_at, last_rejected_protocol_version, created_at, updated_at) VALUES (?, ?, 'persistent', NULL, 'full', NULL, ?, NULL, ?, ?)",
  )
    .bind(id, `288-${id}`, now, now, now)
    .run();
  return { id };
}

async function seedProjectWithSource(hostId: string, path: string): Promise<string> {
  const created = await postJson("/api/v1/projects", {
    name: `binding-${Math.random().toString(36).slice(2, 8)}`,
    source: { hostId, type: "local_path", path },
  });
  expect(created.status).toBe(201);
  const parsed = z.object({ id: z.string() }).parse(await created.json());
  return parsed.id;
}

async function environmentCount(): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM environments").first();
  return Number(row?.n ?? 0);
}

describe("#288 explicit host binding lands in D1, trajectory and read faces", () => {
  it("create with {type:host} resolves, materializes the row and feeds both halves", async () => {
    const host = await seedHost();
    const before = await environmentCount();
    const created = await postJson("/api/v1/threads", {
      ...NO_TURN_CREATE,
      projectId: "proj_personal",
      title: "explicit-host",
      environment: {
        type: "host",
        hostId: host.id,
        workspace: { type: "unmanaged", path: "/repo/288-explicit" },
      },
    });
    expect(created.status).toBe(201);
    const thread = createdThreadBodySchema.parse(await created.json());
    // Control-plane half.
    expect(thread.environmentId).not.toBeNull();
    // Trajectory half: thread.created carries the binding machine.
    const events = await rawEvents(thread.id);
    expect(events[0]?.type).toBe("thread.created");
    expect(machineIdOfFirstEvent(events)).toBe(host.id);
    // Find-or-create: exactly one new row.
    expect(await environmentCount()).toBe(before + 1);
    // Read faces: detail includes.
    const detail = await getJson(`/api/v1/threads/${thread.id}?include=environment,host`);
    expect(detail.status).toBe(200);
    const detailBody = threadWithIncludesResponseSchema.parse(detail.body);
    expect(detailBody.environment?.id).toBe(thread.environmentId);
    expect(detailBody.environment?.hostId).toBe(host.id);
    expect(detailBody.environment?.path).toBe("/repo/288-explicit");
    expect(detailBody.environment?.status).toBe("ready");
    expect(detailBody.host?.id).toBe(host.id);
    // The pinned protocol ThreadSummary (fake-edge face) accepts the inlined
    // feed: the same summary plus the binding fields parses unchanged.
    const summary = threadSummarySchema.parse({ ...detailBody, lastSeq: 1 });
    expect(summary.environment?.hostId).toBe(host.id);
    expect(summary.host?.id).toBe(host.id);
    // List join fields.
    const listed = await getJson("/api/v1/threads");
    const listedRows = z.array(threadListEntrySchema).parse(listed.body);
    const entry = listedRows.find((row) => row.id === thread.id);
    expect(entry?.environmentHostId).toBe(host.id);
    // Environments route.
    const envDetail = await getJson(`/api/v1/environments/${thread.environmentId ?? ""}`);
    expect(envDetail.status).toBe(200);
    // Second create on the same (project, host, path) reuses the row.
    const again = await postJson("/api/v1/threads", {
      ...NO_TURN_CREATE,
      projectId: "proj_personal",
      title: "explicit-host-again",
      environment: {
        type: "host",
        hostId: host.id,
        workspace: { type: "unmanaged", path: "/repo/288-explicit" },
      },
    });
    expect(again.status).toBe(201);
    expect(createdThreadBodySchema.parse(await again.json()).environmentId).toBe(
      thread.environmentId,
    );
    expect(await environmentCount()).toBe(before + 1);
  });

  it("reuse binds, unknown reuse 404s, cross-project reuse 409s", async () => {
    const host = await seedHost();
    const projectA = await seedProjectWithSource(host.id, "/repo/288-reuse-a");
    const projectB = await seedProjectWithSource(host.id, "/repo/288-reuse-b");
    const seeded = await postJson("/api/v1/threads", {
      ...NO_TURN_CREATE,
      projectId: projectA,
      title: "reuse-source",
      environment: {
        type: "host",
        hostId: host.id,
        workspace: { type: "unmanaged", path: "/repo/288-reuse-a" },
      },
    });
    const { environmentId } = createdThreadBodySchema.parse(await seeded.json());
    expect(environmentId).not.toBeNull();
    const ok = await postJson("/api/v1/threads", {
      ...NO_TURN_CREATE,
      projectId: projectA,
      title: "reuse-thread",
      environment: { type: "reuse", environmentId: environmentId ?? "" },
    });
    expect(ok.status).toBe(201);
    const missing = await postJson("/api/v1/threads", {
      ...NO_TURN_CREATE,
      projectId: projectA,
      title: "reuse-missing",
      environment: { type: "reuse", environmentId: "env_does_not_exist" },
    });
    expect(missing.status).toBe(404);
    expect(apiErrorBodySchema.parse(await missing.json()).code).toBe("environment_not_found");
    const foreign = await postJson("/api/v1/threads", {
      ...NO_TURN_CREATE,
      projectId: projectB,
      title: "reuse-foreign",
      environment: { type: "reuse", environmentId: environmentId ?? "" },
    });
    expect(foreign.status).toBe(409);
  });

  it("no environment falls back to the project default source, then the deployment machine", async () => {
    const host = await seedHost();
    const projectId = await seedProjectWithSource(host.id, "/repo/288-default-src");
    // Direct create with NO environment: the explicit personal payload the
    // shared helper always ships would win the priority chain — this asserts
    // the project-default-source fallback itself.
    const bare = await postJson("/api/v1/threads", {
      ...NO_TURN_CREATE,
      projectId,
      title: "project-default",
    });
    expect(bare.status, await bare.clone().text()).toBe(201);
    const thread = createdThreadBodySchema.parse(await bare.json());
    expect(machineIdOfFirstEvent(await rawEvents(thread.id))).toBe(host.id);
    const detail = await getJson(`/api/v1/threads/${thread.id}?include=environment`);
    const body = threadWithIncludesResponseSchema.parse(detail.body);
    expect(body.environmentId).not.toBeNull();
    expect(body.environment?.path).toBe("/repo/288-default-src");
    // The personal singleton has no source: deployment default, zero rows.
    const before = await environmentCount();
    const deployment = await createThread({ title: "deployment-default" });
    expect(machineIdOfFirstEvent(await rawEvents(deployment.id))).toBe("local");
    const bareDetail = threadResponseSchema.parse(
      (await getJson(`/api/v1/threads/${deployment.id}`)).body,
    );
    expect(bareDetail.environmentId).toBeNull();
    expect(await environmentCount()).toBe(before);
  });

  it("managed-worktree fails explicitly and unknown hosts 404", async () => {
    const worktree = await postJson("/api/v1/threads", {
      ...NO_TURN_CREATE,
      projectId: "proj_personal",
      title: "managed-worktree",
      environment: {
        type: "host",
        workspace: { type: "managed-worktree", baseBranch: { kind: "default" } },
      },
    });
    expect(worktree.status).toBe(422);
    const ghost = await postJson("/api/v1/threads", {
      ...NO_TURN_CREATE,
      projectId: "proj_personal",
      title: "ghost-host",
      environment: {
        type: "host",
        hostId: "host_missing_288",
        workspace: { type: "unmanaged", path: "/repo/ghost" },
      },
    });
    expect(ghost.status).toBe(404);
    expect(apiErrorBodySchema.parse(await ghost.json()).code).toBe("host_not_found");
  });

  it("explicit rebind appends thread.rebound, moves the row and is idempotent", async () => {
    const hostA = await seedHost();
    const hostB = await seedHost();
    const created = await postJson("/api/v1/threads", {
      ...NO_TURN_CREATE,
      projectId: "proj_personal",
      title: "rebind-me",
      environment: {
        type: "host",
        hostId: hostA.id,
        workspace: { type: "unmanaged", path: "/repo/288-rebind" },
      },
    });
    const thread = createdThreadBodySchema.parse(await created.json());
    const rebound = await postJson(`/api/v1/threads/${thread.id}/environment`, {
      environment: {
        type: "host",
        hostId: hostB.id,
        workspace: { type: "unmanaged", path: "/repo/288-rebind-b" },
      },
    });
    expect(rebound.status).toBe(200);
    const row = threadResponseSchema.parse(await rebound.json());
    expect(row.environmentId).not.toBeNull();
    expect(row.environmentId).not.toBe(thread.environmentId);
    const events = await rawEvents(thread.id);
    const reboundEvent = events.find((event) => event.type === "thread.rebound");
    expect(dataField(reboundEvent?.data, "machineId")).toBe(hostB.id);
    // Same-target rebind appends nothing (idempotent owner operation).
    const again = await postJson(`/api/v1/threads/${thread.id}/environment`, {
      environment: {
        type: "host",
        hostId: hostB.id,
        workspace: { type: "unmanaged", path: "/repo/288-rebind-b" },
      },
    });
    expect(again.status).toBe(200);
    const eventsAfter = await rawEvents(thread.id);
    expect(eventsAfter.filter((event) => event.type === "thread.rebound")).toHaveLength(1);
  });
});
