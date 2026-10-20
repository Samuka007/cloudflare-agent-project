import { beforeAll, afterEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import {
  agentSnapshotSchema,
  controlPlaneResponseSchema,
  markHostSeenArgsSchema,
} from "@cap/protocol";
import { ensureMigrations } from "../migrate";
import type { Env } from "../../src/env";

/**
 * T7 #599: the CONTROL_PLANE service binding + typed client contract — the
 * real binding-targeted fetch into this worker's `control_plane` named
 * entrypoint (the same path the daemon-service DO's liveness projection
 * rides; host-liveness.test.ts covers it through a live heartbeat).
 *
 * This suite pins the WIRE contract itself: envelope shapes validate through
 * the @cap/protocol schemas (the exact parse the createRpcControlPlaneClient
 * adapter applies), the agent snapshot serves the four provider-settings
 * domains, and hosts.markSeen carries the ≥30s server-side throttle.
 */
beforeAll(ensureMigrations);

/** The rig env vs src Env: only the DO-namespace generics differ; the
 * bindings are the same objects (thread-suspension-face.test.ts precedent). */
const appEnv = env as unknown as Env;

/** The rig must bind CONTROL_PLANE (wrangler.jsonc services entry). */
function binding(): Fetcher {
  const bound = appEnv.CONTROL_PLANE;
  if (bound === undefined) {
    throw new Error("the rig must bind CONTROL_PLANE (wrangler.jsonc services entry)");
  }
  return bound;
}

async function rpc(payload: unknown): Promise<{ status: number; envelope: unknown }> {
  const response = await binding().fetch("https://control-plane.rpc/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return { status: response.status, envelope: await response.json() };
}

function okData(envelope: unknown): unknown {
  const parsed = controlPlaneResponseSchema.parse(envelope);
  if (!parsed.ok) throw new Error(`rpc failed: ${parsed.error.message}`);
  return parsed.data;
}

type Row = Record<string, string | number | null>;

async function seed(sql: string, ...binds: (string | number | null)[]): Promise<void> {
  await appEnv.DB.prepare(sql)
    .bind(...binds)
    .run();
}

async function row(sql: string, ...binds: (string | number | null)[]): Promise<Row | null> {
  return (
    (await appEnv.DB.prepare(sql)
      .bind(...binds)
      .first<Row>()) ?? null
  );
}

afterEach(async () => {
  await seed("DELETE FROM provider_configs WHERE id = 'rpc-face-rig'");
  await seed("DELETE FROM image_source WHERE id = 'image_source'");
  await seed("DELETE FROM web_search WHERE id = 'web_search'");
  await seed("DELETE FROM tool_capabilities WHERE id = 'tool_capabilities'");
  await seed("DELETE FROM hosts WHERE id = 'rpc-face-rig-host'");
});

describe("CONTROL_PLANE binding → control_plane entrypoint (#599)", () => {
  it("agentSnapshot.get serves the four provider-settings domains through the contract", async () => {
    const now = Date.now();
    await seed(
      `INSERT INTO provider_configs (id, display_name, base_url, api, service_tier, api_key_enc, models, created_at, updated_at)
       VALUES ('rpc-face-rig', 'RPC Rig', 'https://upstream.example', 'anthropic-messages', 1, 'enc-payload', '[{"id":"m1"}]', ?, ?)`,
      now,
      now,
    );
    await seed(
      "INSERT INTO image_source (id, provider_id, updated_at) VALUES ('image_source', 'rpc-face-rig', ?)",
      now,
    );
    await seed(
      "INSERT INTO web_search (id, chain, timeout_seconds, engines, secrets_enc, secrets_meta, updated_at) VALUES ('web_search', '[\"public\"]', 45, NULL, 'sealed', '{\"brave\":{\"apiKey\":true}}', ?)",
      now,
    );
    await seed(
      "INSERT INTO tool_capabilities (id, external_thinking, context_notes, checkpoint, updated_at) VALUES ('tool_capabilities', 1, 0, 1, ?)",
      now,
    );

    const { status, envelope } = await rpc({ method: "agentSnapshot.get" });
    expect(status).toBe(200);
    const snapshot = agentSnapshotSchema.parse(okData(envelope));

    const rig = snapshot.providers.find((candidate) => candidate.id === "rpc-face-rig");
    expect(rig).toEqual({
      id: "rpc-face-rig",
      displayName: "RPC Rig",
      baseUrl: "https://upstream.example",
      api: "anthropic-messages",
      serviceTier: true,
      apiKeyEnc: "enc-payload",
      models: '[{"id":"m1"}]',
      createdAt: now,
      updatedAt: now,
    });
    expect(snapshot.imageSourceProviderId).toBe("rpc-face-rig");
    expect(snapshot.webSearch).toEqual({
      chain: '["public"]',
      timeoutSeconds: 45,
      engines: null,
      secretsEnc: "sealed",
      secretsMeta: '{"brave":{"apiKey":true}}',
      updatedAt: now,
    });
    expect(snapshot.toolCapabilities).toEqual({
      externalThinking: true,
      contextNotes: false,
      checkpoint: true,
    });
  });

  it("absent seats decode to the ruled null postures (no rows invented)", async () => {
    const { status, envelope } = await rpc({ method: "agentSnapshot.get" });
    expect(status).toBe(200);
    const snapshot = agentSnapshotSchema.parse(okData(envelope));
    expect(snapshot.imageSourceProviderId).toBeNull();
    expect(snapshot.webSearch).toBeNull();
    expect(snapshot.toolCapabilities).toBeNull();
  });

  it("hosts.markSeen stamps last_seen_at and the throttle is the server's policy", async () => {
    const at = Date.now();
    await seed(
      `INSERT INTO hosts (id, name, type, connect_machine_id, max_permission_mode, destroyed_at, last_seen_at, last_rejected_protocol_version, created_at, updated_at)
       VALUES ('rpc-face-rig-host', 'rpc-rig', 'persistent', NULL, 'full', NULL, NULL, NULL, ?, ?)`,
      at,
      at,
    );
    const args = { hostId: "rpc-face-rig-host", at: at + 60_000 };

    // Payload validation lives on both sides of the seam.
    expect(markHostSeenArgsSchema.safeParse(args).success).toBe(true);

    const first = await rpc({ method: "hosts.markSeen", args });
    expect(first.status).toBe(200);
    expect(controlPlaneResponseSchema.parse(first.envelope).ok).toBe(true);
    expect(await row("SELECT last_seen_at FROM hosts WHERE id = 'rpc-face-rig-host'")).toEqual({
      last_seen_at: at + 60_000,
    });

    // Within the server-owned window the stamp does NOT move — the daemon
    // side fires freely, the server decides (markSeen 节流内聚 Hosts repo).
    const second = await rpc({ method: "hosts.markSeen", args: { ...args, at: at + 61_000 } });
    expect(second.status).toBe(200);
    expect(await row("SELECT last_seen_at FROM hosts WHERE id = 'rpc-face-rig-host'")).toEqual({
      last_seen_at: at + 60_000,
    });

    // Unknown host: a quiet no-op (rows are created by the attach bridge).
    const unknown = await rpc({ method: "hosts.markSeen", args: { hostId: "no-such-host", at } });
    expect(unknown.status).toBe(200);
  });

  it("rejects malformed requests loudly (zod boundary, never silent)", async () => {
    expect((await rpc({ method: "no.such.method" })).status).toBe(400);
    expect((await rpc({ method: "hosts.markSeen", args: { hostId: "", at: 1 } })).status).toBe(400);
    expect((await rpc({ method: "hosts.markSeen" })).status).toBe(400);
    const bad = await binding().fetch("https://control-plane.rpc/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not-json",
    });
    expect(bad.status).toBe(400);
    const wrongMethod = await binding().fetch("https://control-plane.rpc/");
    expect(wrongMethod.status).toBe(405);
  });
});
