import { beforeAll, afterEach, describe, expect, it } from "vitest";
import { env, exports } from "cloudflare:workers";
import { ensureMigrations } from "../migrate.js";
import { loadProviderConfigCatalogOverlay } from "@cap/provider-app";
import {
  systemConfigResponseSchema,
  systemToolCapabilitiesResponseSchema,
  type SystemToolCapabilitiesResponse,
} from "../../src/contract/api/system.js";

/**
 * #502 the experimental tool-capability write face (the D1 `tool_capabilities`
 * single-row seat, the sole 正本 — the three AGENT_DO_* gate envs are
 * deleted): GET/PUT /api/v1/system/tool-capabilities. Acceptance faces
 * exercised:
 *
 * - absent row = the omp posture (configured:false, all five tool families
 *   off — never an env override);
 * - a PUT replaces the whole seat (three booleans, no tri-state merge) and
 *   GET / the loader overlay / GET /system/config's featureFlags all
 *   re-read the stored truth (the rowAfterWrite discipline);
 * - the seat joins the provider-overlay content fingerprint, so a flip
 *   reaches the agent DO's turn-boundary refresh (hot-apply, no redeploy);
 * - the strict 0/1 decode keeps a hand-edited non-0/1 value off;
 * - malformed payloads are refused 422 (rejection, never silent fallback).
 */

beforeAll(ensureMigrations);

const BASE = "https://example.com";

async function request(method: string, path: string, body?: unknown): Promise<Response> {
  return exports.default.fetch(`${BASE}${path}`, {
    method,
    ...(body === undefined
      ? {}
      : {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
  });
}

type ToolCapabilitiesFace = SystemToolCapabilitiesResponse;

async function getFace(): Promise<ToolCapabilitiesFace> {
  const response = await request("GET", "/api/v1/system/tool-capabilities");
  expect(response.status).toBe(200);
  return systemToolCapabilitiesResponseSchema.parse(await response.json());
}

async function putFace(
  body: unknown,
): Promise<{ status: number; face?: ToolCapabilitiesFace; code?: string; message?: string }> {
  const response = await request("PUT", "/api/v1/system/tool-capabilities", body);
  const payload = await response.json<{ code?: string; message?: string }>();
  return {
    status: response.status,
    ...(response.status === 200
      ? { face: systemToolCapabilitiesResponseSchema.parse(payload) }
      : payload),
  };
}

async function rawSeatRow(): Promise<{
  external_thinking: number;
  context_notes: number;
  checkpoint: number;
} | null> {
  return env.DB.prepare(
    "SELECT external_thinking, context_notes, checkpoint FROM tool_capabilities WHERE id = 'tool_capabilities'",
  ).first<{ external_thinking: number; context_notes: number; checkpoint: number }>();
}

afterEach(async () => {
  // The seat is single-row; every case starts from the absent state.
  await env.DB.prepare("DELETE FROM tool_capabilities WHERE id = 'tool_capabilities'").run();
});

describe("GET /api/v1/system/tool-capabilities", () => {
  it("serves the omp posture when no seat row exists (all gates off)", async () => {
    expect(await getFace()).toEqual({
      configured: false,
      externalThinking: false,
      contextNotes: false,
      checkpoint: false,
    });
  });

  it("reflects the stored gates; a hand-edited non-0/1 value stays off", async () => {
    // A direct D1 write outside the face: the decode is strict (=== 1).
    await env.DB.prepare(
      "INSERT INTO tool_capabilities (id, external_thinking, context_notes, checkpoint, updated_at) VALUES ('tool_capabilities', 2, 1, 0, ?)",
    )
      .bind(Date.now())
      .run();
    expect(await getFace()).toEqual({
      configured: true,
      externalThinking: false,
      contextNotes: true,
      checkpoint: false,
    });
  });
});

describe("PUT /api/v1/system/tool-capabilities", () => {
  it("replaces the seat; GET, the loader overlay and /system/config re-read the truth", async () => {
    const before = await loadProviderConfigCatalogOverlay(env);
    expect(before?.toolCapabilities).toEqual({
      configured: false,
      externalThinking: false,
      contextNotes: false,
      checkpoint: false,
    });

    const put = await putFace({ externalThinking: true, contextNotes: false, checkpoint: true });
    expect(put.status).toBe(200);
    expect(put.face).toEqual({
      configured: true,
      externalThinking: true,
      contextNotes: false,
      checkpoint: true,
    });

    // GET re-reads the SAME stored truth.
    expect(await getFace()).toEqual(put.face);
    // The raw row is 0/1 in D1 (the 正本).
    expect(await rawSeatRow()).toEqual({
      external_thinking: 1,
      context_notes: 0,
      checkpoint: 1,
    });
    // The loader overlay (the agent DO's input) carries the seat and a NEW
    // content fingerprint — the flip hot-applies at the next turn boundary.
    const after = await loadProviderConfigCatalogOverlay(env);
    expect(after?.toolCapabilities).toEqual(put.face);
    expect(after?.fingerprint).not.toBe(before?.fingerprint);
    // The featureFlags projection (GET /system/config) resolves the seat.
    const config = await request("GET", "/api/v1/system/config");
    expect(config.status).toBe(200);
    const parsed = systemConfigResponseSchema.parse(await config.json());
    expect(parsed.featureFlags.toolCapabilities).toEqual({
      externalThinking: true,
      contextNotes: false,
      checkpoint: true,
    });
  });

  it("a partial flip replaces wholesale (no merge with the stored gates)", async () => {
    await putFace({ externalThinking: true, contextNotes: true, checkpoint: true });
    const put = await putFace({ externalThinking: false, contextNotes: false, checkpoint: true });
    expect(put.status).toBe(200);
    expect(put.face).toEqual({
      configured: true,
      externalThinking: false,
      contextNotes: false,
      checkpoint: true,
    });
    expect(await rawSeatRow()).toEqual({
      external_thinking: 0,
      context_notes: 0,
      checkpoint: 1,
    });
  });

  it("refuses malformed payloads (strict shape — rejection, never fallback)", async () => {
    const missing = await putFace({ externalThinking: true });
    expect(missing.status).toBe(422);
    expect(missing.code).toBe("validation_failed");
    const extra = await putFace({
      externalThinking: false,
      contextNotes: false,
      checkpoint: false,
      extra: true,
    });
    expect(extra.status).toBe(422);
    const nonBoolean = await putFace({
      externalThinking: "yes",
      contextNotes: false,
      checkpoint: false,
    });
    expect(nonBoolean.status).toBe(422);
    // No write leaked through the refusals.
    expect(await rawSeatRow()).toBeNull();
  });

  it("an absent row again serves the honest posture (configured:false)", async () => {
    await putFace({ externalThinking: true, contextNotes: false, checkpoint: false });
    await env.DB.prepare("DELETE FROM tool_capabilities WHERE id = 'tool_capabilities'").run();
    expect(await getFace()).toEqual({
      configured: false,
      externalThinking: false,
      contextNotes: false,
      checkpoint: false,
    });
  });
});
