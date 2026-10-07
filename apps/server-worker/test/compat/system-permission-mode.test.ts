import { beforeAll, afterEach, describe, expect, it } from "vitest";
import { env, exports } from "cloudflare:workers";
import { ensureMigrations } from "../migrate.js";
import {
  systemPermissionModeResponseSchema,
  type SystemPermissionModeResponse,
} from "../../src/contract/api/system.js";
import { resolveThreadDefaultExecutionOptions } from "../../src/services/execution-selection.js";
import { BASE } from "../helpers.js";

/**
 * #500 the permission-mode default write face (the D1 `permission_mode`
 * single-row seat, the sole 正本 — the retired deployment env scalar is
 * deleted): GET/PUT /api/v1/system/permission-mode. Acceptance faces
 * exercised:
 *
 * - absent row = the ruled "full" default (configured:false — never an env
 *   override);
 * - a PUT replaces the seat and GET re-reads the stored truth;
 * - a hand-edited value outside the vocabulary falls back to "full" (strict
 *   decode — the #502 seat precedent);
 * - malformed payloads are refused 422 (rejection, never silent fallback);
 * - the seat feeds the thread display default (resolveThreadDefaultExecution
 *   Options) — a write hot-applies without a redeploy.
 */

beforeAll(ensureMigrations);

const SEAT = "permission_mode";

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

async function getFace(): Promise<SystemPermissionModeResponse> {
  const response = await request("GET", "/api/v1/system/permission-mode");
  expect(response.status).toBe(200);
  return systemPermissionModeResponseSchema.parse(await response.json());
}

async function putFace(
  body: unknown,
): Promise<{ status: number; face?: SystemPermissionModeResponse; code?: string }> {
  const response = await request("PUT", "/api/v1/system/permission-mode", body);
  const payload = await response.json<{ code?: string }>();
  return {
    status: response.status,
    ...(response.status === 200
      ? { face: systemPermissionModeResponseSchema.parse(payload) }
      : payload),
  };
}

afterEach(async () => {
  // The seat is single-row; every case starts from the absent state.
  await env.DB.prepare(`DELETE FROM ${SEAT} WHERE id = '${SEAT}'`).run();
});

describe("GET /api/v1/system/permission-mode", () => {
  it("serves the ruled full default when no seat row exists", async () => {
    expect(await getFace()).toEqual({ configured: false, mode: "full" });
  });

  it("reflects the stored mode; a hand-edited value outside the enum falls back", async () => {
    // A direct D1 write outside the face: the decode is strict.
    await env.DB.prepare(
      `INSERT INTO ${SEAT} (id, mode, updated_at) VALUES ('${SEAT}', 'sandboxed', ?)`,
    )
      .bind(Date.now())
      .run();
    expect(await getFace()).toEqual({ configured: true, mode: "full" });
    await env.DB.prepare(`UPDATE ${SEAT} SET mode = 'accept-edits' WHERE id = '${SEAT}'`).run();
    expect(await getFace()).toEqual({ configured: true, mode: "accept-edits" });
  });
});

describe("PUT /api/v1/system/permission-mode", () => {
  it("replaces the seat; GET and the thread display default re-read the truth", async () => {
    const put = await putFace({ mode: "accept-edits" });
    expect(put.status).toBe(200);
    expect(put.face).toEqual({ configured: true, mode: "accept-edits" });
    expect(await getFace()).toEqual({ configured: true, mode: "accept-edits" });

    // The display default (GET /threads/:id/default-execution-options
    // resolution) carries the seat's mode — the same read the route runs.
    const overlaid = resolveThreadDefaultExecutionOptions(
      (await getFace()).mode,
      { providerId: "rig", modelOverride: "rig-model", reasoningLevelOverride: null },
      { rig: { models: [{ id: "rig-model" }] } },
    );
    expect(overlaid?.permissionMode).toBe("accept-edits");

    // Flip back to full — the write replaces, never merges.
    const flipped = await putFace({ mode: "full" });
    expect(flipped.face).toEqual({ configured: true, mode: "full" });
  });

  it("422s a mode outside the vocabulary", async () => {
    const refused = await putFace({ mode: "yolo" });
    expect(refused.status).toBe(422);
    expect(await getFace()).toEqual({ configured: false, mode: "full" });
  });
});
