import { beforeAll, afterEach, describe, expect, it } from "vitest";
import { env, exports } from "cloudflare:workers";
import { ensureMigrations } from "../migrate.js";
import { RIG_MODEL_ID, RIG_PROVIDER_ID, ensureRigReady } from "../helpers.js";
import {
  systemCompactionSettingsResponseSchema,
  type SystemCompactionSettingsResponse,
} from "../../src/contract/api/system.js";

/**
 * #547 the compaction-preference write face (the D1 `compaction_settings`
 * single-row seat, the sole 正本 — zero env fallback):
 * GET/PUT /api/v1/system/compaction-settings. Acceptance faces exercised:
 *
 * - absent row = the #309 posture (configured:false, methodOrder ["soft"],
 *   remote null — the compact button's shipped semantics, never an env
 *   override);
 * - a PUT replaces the whole seat (order + remote, no tri-state merge) and
 *   GET re-reads the stored truth (the rowAfterWrite discipline);
 * - the remote selection 422-validates against the live catalog at write
 *   time (the #351 named errors — provider/model unknown, fail-closed);
 * - a hand-edited method_order JSON decodes through the omp resolution
 *   (malformed entries filtered, first occurrence wins) instead of throwing;
 * - malformed payloads are refused 422 (rejection, never silent fallback).
 */

beforeAll(ensureMigrations);

const BASE = "https://example.com";

async function request(method: string, path: string, body?: unknown): Promise<Response> {
  return exports.default.fetch(`${BASE}${path}`, {
    method,
    ...(body !== undefined
      ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
      : {}),
  });
}

type CompactionFace = SystemCompactionSettingsResponse;

async function getFace(): Promise<CompactionFace> {
  const response = await request("GET", "/api/v1/system/compaction-settings");
  expect(response.status).toBe(200);
  return systemCompactionSettingsResponseSchema.parse(await response.json());
}

async function putFace(
  body: unknown,
): Promise<{ status: number; face?: CompactionFace; code?: string; message?: string }> {
  const response = await request("PUT", "/api/v1/system/compaction-settings", body);
  const json = await response.json<{
    code?: string;
    message?: string;
    configured?: boolean;
    methodOrder?: string[];
    remote?: unknown;
  }>();
  if (response.status !== 200)
    return { status: response.status, code: json.code, message: json.message };
  return {
    status: response.status,
    face: systemCompactionSettingsResponseSchema.parse(json),
  };
}

async function rawSeatRow(): Promise<{
  method_order: string;
  remote_provider_id: string | null;
  remote_model: string | null;
} | null> {
  return env.DB.prepare(
    "SELECT method_order, remote_provider_id, remote_model FROM compaction_settings WHERE id = 'compaction_settings'",
  ).first();
}

afterEach(async () => {
  // The absent-row posture is the shared-worker default: every test leaves
  // the seat deleted so other suites read the #309 face.
  await env.DB.prepare("DELETE FROM compaction_settings WHERE id = 'compaction_settings'").run();
});

describe("GET /api/v1/system/compaction-settings (#547)", () => {
  it("the absent row is the #309 posture: soft-only, remote ineligible", async () => {
    const face = await getFace();
    expect(face).toEqual({
      configured: false,
      methodOrder: ["soft"],
      remote: null,
    });
  });

  it("a hand-edited method_order decodes through the omp resolution", async () => {
    await env.DB.prepare(
      "INSERT INTO compaction_settings (id, method_order, remote_provider_id, remote_model, updated_at) VALUES ('compaction_settings', ?, NULL, NULL, ?)",
    )
      .bind(JSON.stringify(["snap", "bogus", "snap", "remote", 42]), Date.now())
      .run();
    const face = await getFace();
    // Malformed entries filter, duplicates collapse, first occurrence wins.
    expect(face.configured).toBe(true);
    expect(face.methodOrder).toEqual(["snap", "remote"]);
    expect(face.remote).toBeNull();
  });

  it("a hand-edited remote row without a model is remote-ineligible, not a poisoned read", async () => {
    await env.DB.prepare(
      "INSERT INTO compaction_settings (id, method_order, remote_provider_id, remote_model, updated_at) VALUES ('compaction_settings', ?, ?, NULL, ?)",
    )
      .bind(JSON.stringify(["remote"]), RIG_PROVIDER_ID, Date.now())
      .run();
    const face = await getFace();
    expect(face.configured).toBe(true);
    expect(face.remote).toBeNull();
  });
});

describe("PUT /api/v1/system/compaction-settings (#547)", () => {
  it("replaces the whole seat and the GET re-reads the stored truth", async () => {
    await ensureRigReady();
    const put = await putFace({
      methodOrder: ["remote", "snap", "soft"],
      remote: { providerId: RIG_PROVIDER_ID, model: RIG_MODEL_ID },
    });
    expect(put.status, put.message).toBe(200);
    expect(put.face).toEqual({
      configured: true,
      methodOrder: ["remote", "snap", "soft"],
      remote: { providerId: RIG_PROVIDER_ID, model: RIG_MODEL_ID },
    });
    // The row is the stored truth (no merge semantics with the prior row).
    const row = await rawSeatRow();
    expect(row?.method_order).toBe(JSON.stringify(["remote", "snap", "soft"]));
    expect(row?.remote_model).toBe(RIG_MODEL_ID);

    // Wholesale replace to a different posture.
    const replace = await putFace({ methodOrder: ["snap"], remote: null });
    expect(replace.face?.methodOrder).toEqual(["snap"]);
    expect(replace.face?.remote).toBeNull();
    expect(replace.face?.configured).toBe(true);
  });

  it("the remote selection validates against the live catalog (named 422 on drift)", async () => {
    await ensureRigReady();
    const unknownModel = await putFace({
      methodOrder: ["soft"],
      remote: { providerId: RIG_PROVIDER_ID, model: "not-a-rig-model" },
    });
    expect(unknownModel.status).toBe(422);
    expect(unknownModel.code).toBe("model_unknown");

    const unknownProvider = await putFace({
      methodOrder: ["soft"],
      remote: { providerId: "no-such-provider", model: RIG_MODEL_ID },
    });
    expect(unknownProvider.status).toBe(422);
    expect(unknownProvider.code).toBe("provider_unknown");

    // Nothing wrote on the refusals.
    expect(await rawSeatRow()).toBeNull();
  });

  it("malformed payloads are refused 422", async () => {
    const badMode = await putFace({ methodOrder: ["aggressive"], remote: null });
    expect(badMode.status).toBe(422);
    const missingRemote = await putFace({ methodOrder: ["soft"] });
    expect(missingRemote.status).toBe(422);
    const extra = await putFace({ methodOrder: ["soft"], remote: null, bogus: 1 });
    expect(extra.status).toBe(422);
  });
});
