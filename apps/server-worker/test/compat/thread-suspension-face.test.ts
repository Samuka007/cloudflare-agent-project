import { beforeAll, describe, expect, it } from "vitest";
import { env, exports } from "cloudflare:workers";
import { ensureMigrations } from "../migrate.js";
import {
  ensureRigReady,
  send,
  type CreatedThread,
  RIG_MODEL_ID,
  RIG_PROVIDER_ID,
  TEST_ENROLL_KEY,
  TEST_HOST_KEY,
} from "../helpers.js";
import { threadResponseSchema } from "../../src/contract/api/threads.js";
import { threadListEntrySchema } from "../../src/contract/domain/thread.js";
import { getEnvironmentRow } from "../../src/db/environments.js";
import type { Env } from "../../src/env.js";
import {
  resolveThreadRuntimeState,
  resolveThreadRuntimeStateAsync,
} from "../../src/services/runtime-display.js";
import type { ThreadDbRow } from "../../src/db/rows.js";

/**
 * #291 execution-suspension display face (streaming contract §9.3 row 4,
 * CONTEXT.md 执行悬置): the honest host face is legal ONLY with no active
 * turn — "settled + 无活跃 turn + runtime host 离线". A bound host down with
 * an open turn keeps the rows-1-3 echo (#148, thread-runtime-host.test.ts);
 * with no open turn it renders bb's host-reconnecting status, which the
 * pinned SPA displays as the "Host disconnected. Waiting for reconnection..."
 * banner while keeping the composer in queue mode — the #73 Q1 half-stop:
 * 消息可发, 模型可回, Host Execution rejected with placeholder rows.
 * `waiting-for-host` is never emitted (that pinned face locks the composer).
 */
beforeAll(async () => {
  await ensureMigrations();
  await ensureRigReady();
});

/** The pool's generated Cloudflare.Env vs the app Env: the DO class labels
 * differ, the bindings are the same objects (worker-configuration.d.ts). */
const appEnv = env as unknown as Env;

let hostCounter = 0;

interface HostSeed {
  id: string;
}

/** thread-binding.test.ts idiom: the hosts registry row without a daemon. */
async function seedHost(): Promise<HostSeed> {
  hostCounter += 1;
  const id = `host291_${hostCounter}_${Math.random().toString(36).slice(2, 8)}`;
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO hosts (id, name, type, connect_machine_id, max_permission_mode, destroyed_at, last_seen_at, last_rejected_protocol_version, created_at, updated_at) VALUES (?, ?, 'persistent', NULL, 'full', NULL, ?, NULL, ?, ?)",
  )
    .bind(id, `291-${id}`, now, now, now)
    .run();
  return { id };
}

const NO_TURN_CREATE = {
  origin: "app",
  input: [],
  originKind: "fork",
  // #450: the explicit selection the fail-closed create validation demands.
  providerId: RIG_PROVIDER_ID,
  model: RIG_MODEL_ID,
} as const;

/** Bind a thread to a fleet host through the public create face (#288). */
async function createBoundThread(hostId: string, title: string): Promise<CreatedThread & { environmentId: string }> {
  const response = await exports.default.fetch("https://example.com/api/v1/threads", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ...NO_TURN_CREATE,
      projectId: "proj_personal",
      title,
      environment: { type: "host", hostId, workspace: { type: "unmanaged", path: `/tmp/${title}` } },
    }),
  });
  expect(response.status).toBe(201);
  const body = threadResponseSchema.pick({ id: true, projectId: true, environmentId: true }).parse(
    await response.json(),
  );
  if (typeof body.environmentId !== "string") {
    throw new Error("bound create returned no environmentId");
  }
  return { id: body.id, projectId: body.projectId, environmentId: body.environmentId };
}

async function readThread(id: string) {
  const response = await exports.default.fetch(`https://example.com/api/v1/threads/${id}`);
  expect(response.status).toBe(200);
  return threadResponseSchema.parse(await response.json());
}

async function listThreadEntry(id: string, projectId: string) {
  const response = await exports.default.fetch(
    `https://example.com/api/v1/threads?projectId=${encodeURIComponent(projectId)}`,
  );
  expect(response.status).toBe(200);
  const body = await response.json<unknown[]>();
  const match = body
    .map((entry) => threadListEntrySchema.parse(entry))
    .find((entry) => entry.id === id);
  if (match === undefined) throw new Error(`thread ${id} missing from list face`);
  return match;
}

/** events/wait + timeline fetch, the settlement drive (thread-run-settlement idiom). */
async function settleTurn(threadId: string): Promise<void> {
  const wait = await exports.default.fetch(
    `https://example.com/api/v1/threads/${threadId}/events/wait` +
      `?type=${encodeURIComponent("turn/completed")}&afterSeq=0&waitMs=15000`,
  );
  expect(wait.status).toBe(200);
  const timeline = await exports.default.fetch(
    `https://example.com/api/v1/threads/${threadId}/timeline?segmentLimit=20`,
  );
  expect(timeline.status).toBe(200);
}

describe("#291 resolver mapping (§9.3 row-4 face)", () => {
  const row = (over: Partial<ThreadDbRow>): ThreadDbRow =>
    ({ status: "idle", environmentId: null, ...over }) as ThreadDbRow;

  it("unbound rows echo regardless of any host state — the zero-D1 default never banners", async () => {
    const idle = await resolveThreadRuntimeStateAsync(appEnv, row({ status: "idle" }));
    expect(idle).toEqual({ displayStatus: "idle", hostReconnectGraceExpiresAt: null });
  });

  it("active and stopping rows echo — rows 1-3 forbid the banner on open turns", async () => {
    // Dangling environment ids: even with a resolvable (offline) binding the
    // open-turn echo must win.
    for (const status of ["active", "stopping"] as const) {
      const echoed = await resolveThreadRuntimeStateAsync(
        appEnv,
        row({ status, environmentId: "env_291_dangling" }),
      );
      expect(echoed).toEqual({ displayStatus: status, hostReconnectGraceExpiresAt: null });
    }
  });

  it("a dangling environment id echoes on a settled row too", async () => {
    const echoed = await resolveThreadRuntimeStateAsync(
      appEnv,
      row({ status: "idle", environmentId: "env_291_dangling" }),
    );
    expect(echoed.displayStatus).toBe("idle");
  });

  it("bound host down with no open turn: host-reconnecting, no expiry", async () => {
    const host = await seedHost();
    const thread = await createBoundThread(host.id, "face-offline");
    const body = await readThread(thread.id);
    expect(body.status).toBe("starting");
    expect(body.runtime.displayStatus).toBe("host-reconnecting");
    expect(body.runtime.hostReconnectGraceExpiresAt).toBeNull();
  });
});

describe("#291 wiring: the suspension face rides detail and list reads", () => {
  it("offline host: detail and list faces banner; the settled turn keeps them honest", async () => {
    const host = await seedHost();
    const thread = await createBoundThread(host.id, "wiring-offline");

    await send(thread.id);
    await settleTurn(thread.id);
    const settled = await readThread(thread.id);
    expect(settled.status).toBe("idle");
    expect(settled.runtime.displayStatus).toBe("host-reconnecting");
    expect(settled.runtime.hostReconnectGraceExpiresAt).toBeNull();

    const listed = await listThreadEntry(thread.id, thread.projectId);
    expect(listed.runtime.displayStatus).toBe("host-reconnecting");
  });

  it("host attach clears the face on the next read — no banner for a live host", async () => {
    const host = await seedHost();
    const thread = await createBoundThread(host.id, "wiring-recovery");
    expect((await readThread(thread.id)).runtime.displayStatus).toBe("host-reconnecting");

    // Attach a live daemon session to the bound host: daemonConnected flips,
    // so the next detail read echoes idle (no banner, no expiry either way).
    const enroll = await exports.default.fetch("https://example.com/enroll", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enrollKey: TEST_ENROLL_KEY, hostId: host.id }),
    });
    expect(enroll.status).toBe(201);
    const session = await exports.default.fetch("https://example.com/session/open", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TEST_HOST_KEY}` },
      body: JSON.stringify({ hostId: host.id, bootId: `boot_${host.id}`, protocolVersion: 1 }),
    });
    expect(session.status).toBe(201);
    const { sessionId } = await session.json<{ sessionId: string }>();
    const stub = env.DAEMON_SERVICE.get(env.DAEMON_SERVICE.idFromName(host.id));
    const attach = await stub.fetch(
      `https://daemon-service/ws?hostId=${encodeURIComponent(host.id)}&sessionId=${encodeURIComponent(sessionId)}`,
      { headers: { upgrade: "websocket" } },
    );
    expect(attach.status).toBe(101);
    const socket = attach.webSocket;
    if (socket === null) throw new Error("daemon attach produced no socket");
    socket.accept();
    try {
      const recovered = await readThread(thread.id);
      expect(recovered.status).toBe("starting");
      expect(recovered.runtime.displayStatus).toBe("starting");
      expect(recovered.runtime.hostReconnectGraceExpiresAt).toBeNull();
    } finally {
      socket.close(1000, "test-done");
    }
  });
});

describe("#291 the sync echo stays byte-identical (rows 1-3 regression guard)", () => {
  it("resolveThreadRuntimeState still echoes every status verbatim", () => {
    for (const status of ["active", "idle", "starting", "stopping", "error"] as const) {
      expect(resolveThreadRuntimeState({ status } as ThreadDbRow)).toEqual({
        displayStatus: status,
        hostReconnectGraceExpiresAt: null,
      });
    }
  });

  it("the created environment row is the binding the face reads", async () => {
    const host = await seedHost();
    const thread = await createBoundThread(host.id, "face-binding-source");
    const environment = await getEnvironmentRow(appEnv, thread.environmentId);
    expect(environment?.hostId).toBe(host.id);
  });
});
