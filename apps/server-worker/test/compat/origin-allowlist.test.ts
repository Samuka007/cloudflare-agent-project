import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { env, exports } from "cloudflare:workers";
import { ensureMigrations } from "../migrate.js";
import {
  systemOriginAllowlistResponseSchema,
  type SystemOriginAllowlistResponse,
} from "../../src/contract/api/system.js";

/**
 * #506 the origin-allowlist seat (the D1 `origin_allowlist` single-row row,
 * the sole 正本 — the APP_EXTRA_ORIGINS env input is deleted, zero-env
 * ruling). Acceptance faces exercised:
 *
 * - the guard matrix (same-origin / extra / reject) is ROW-DRIVEN over the
 *   seat content: a PUT through /system/origin-allowlist hot-applies on the
 *   next Origin-carrying request — no redeploy, no cache;
 * - the default posture is the retired env-unset one: absent row = zero
 *   extra origins, same-origin behavior unchanged;
 * - the write face 422s (zod validation_failed) on any entry that is not a
 *   strict http(s) browser origin, with the offending entry's path;
 * - decode is fail-closed: a hand-broken seat cell never widens the gate.
 */

beforeAll(ensureMigrations);

const BASE = "https://example.com";
const PROBE = "/api/v1/system/version";

async function probe(headers: Record<string, string>, method = "GET"): Promise<Response> {
  return exports.default.fetch(`${BASE}${PROBE}`, { method, headers });
}

async function putFace(
  body: unknown,
): Promise<{ status: number; face?: SystemOriginAllowlistResponse; code?: string }> {
  const response = await exports.default.fetch(`${BASE}/api/v1/system/origin-allowlist`, {
    method: "PUT",
    ...(body === undefined
      ? {}
      : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  const payload = await response.json<{ code?: string; origins?: string[] }>();
  return {
    status: response.status,
    ...(response.status === 200
      ? { face: systemOriginAllowlistResponseSchema.parse(payload) }
      : { code: payload.code }),
  };
}

async function getFace(): Promise<SystemOriginAllowlistResponse> {
  const response = await exports.default.fetch(`${BASE}/api/v1/system/origin-allowlist`);
  expect(response.status).toBe(200);
  return systemOriginAllowlistResponseSchema.parse(await response.json());
}

afterEach(async () => {
  // The seat is single-row; every case starts from the absent-row posture.
  await env.DB.prepare("DELETE FROM origin_allowlist").run();
});

interface GuardRow {
  name: string;
  /** Seated origins, written through the PUT face (proves the hot path). */
  seated: string[];
  origin?: string;
  xForwardedHost?: string;
  xForwardedProto?: string;
  expect: number;
}

describe("origin guard row matrix (#506: same-origin / extra / reject)", () => {
  const rows: GuardRow[] = [
    {
      name: "no Origin header (curl/CLI/SDK) passes untouched and pays no seat read",
      seated: [],
      expect: 200,
    },
    {
      name: "same-origin request passes with an absent seat (default zero-extra posture)",
      seated: [],
      origin: BASE,
      expect: 200,
    },
    {
      name: "foreign origin is 403 forbidden_origin with an absent seat",
      seated: [],
      origin: "https://evil.example",
      expect: 403,
    },
    {
      name: "localhost origin does not match a non-local request target",
      seated: [],
      origin: "http://localhost:5173",
      expect: 403,
    },
    {
      name: "first x-forwarded-host value is a request target (proto from x-forwarded-proto)",
      seated: [],
      origin: "https://forwarded.example",
      xForwardedHost: "forwarded.example, internal.example",
      xForwardedProto: "https",
      expect: 200,
    },
    {
      name: "seated extra origin is accepted — hot, no redeploy",
      seated: ["https://panel.example"],
      origin: "https://panel.example",
      expect: 200,
    },
    {
      name: "entry canonicalization: uppercase host / trailing path seat matches the bare origin",
      seated: ["https://Panel.Example:8443/"],
      origin: "https://panel.example:8443",
      expect: 200,
    },
    {
      name: "an extra origin does not open the gate to any other origin",
      seated: ["https://panel.example"],
      origin: "https://other.example",
      expect: 403,
    },
  ];

  it.each(rows)("$name", async (row) => {
    for (const seated of row.seated) {
      const put = await putFace({ origins: [seated] });
      expect(put.status).toBe(200);
    }
    const response = await probe({
      ...(row.origin !== undefined ? { origin: row.origin } : {}),
      ...(row.xForwardedHost !== undefined ? { "x-forwarded-host": row.xForwardedHost } : {}),
      ...(row.xForwardedProto !== undefined ? { "x-forwarded-proto": row.xForwardedProto } : {}),
    });
    expect(response.status).toBe(row.expect);
    if (row.expect === 403) {
      const payload = await response.json<{ code?: string }>();
      expect(payload.code).toBe("forbidden_origin");
    }
  });

  it("rejects a malformed Origin value even when it is seated", async () => {
    const put = await putFace({ origins: ["https://panel.example"] });
    expect(put.status).toBe(200);
    const response = await probe({ origin: "https://panel.example/not-an-origin" });
    expect(response.status).toBe(403);
  });

  it("preflight with a seated origin passes the guard and gets echoed by CORS", async () => {
    const put = await putFace({ origins: ["https://panel.example"] });
    expect(put.status).toBe(200);
    const response = await probe({ origin: "https://panel.example" }, "OPTIONS");
    expect(response.status).toBeLessThan(400);
    expect(response.headers.get("access-control-allow-origin")).toBe("https://panel.example");
  });

  it("same-origin GET keeps the CORS echo; a foreign origin never reaches CORS", async () => {
    const sameOrigin = await probe({ origin: BASE });
    expect(sameOrigin.headers.get("access-control-allow-origin")).toBe(BASE);
    const foreign = await probe({ origin: "https://evil.example" });
    expect(foreign.status).toBe(403);
    expect(foreign.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("origin-allowlist faces (#506)", () => {
  it("GET serves the empty list while the seat row is absent", async () => {
    expect(await getFace()).toEqual({ origins: [] });
  });

  it("PUT stores canonical origins and the face round-trips them", async () => {
    const put = await putFace({
      origins: ["https://Panel.Example/", "https://a.example", "https://panel.example"],
    });
    expect(put.status).toBe(200);
    expect(put.face).toEqual({ origins: ["https://panel.example", "https://a.example"] });
    expect(await getFace()).toEqual({ origins: ["https://panel.example", "https://a.example"] });
  });

  it("PUT hot-applies: trusted immediately after the write, revoked by the next write", async () => {
    // Absent seat: the extra origin is still rejected.
    expect((await probe({ origin: "https://panel.example" })).status).toBe(403);
    const put = await putFace({ origins: ["https://panel.example"] });
    expect(put.status).toBe(200);
    expect((await probe({ origin: "https://panel.example" })).status).toBe(200);
    const clear = await putFace({ origins: [] });
    expect(clear.status).toBe(200);
    expect((await probe({ origin: "https://panel.example" })).status).toBe(403);
  });

  it.each([
    { name: "origins not an array", body: { origins: "https://x.example" } },
    { name: "non-http scheme", body: { origins: ["https://ok.example", "ftp://bad.example"] } },
    { name: "path-carrying entry", body: { origins: ["https://x.example/app"] } },
    { name: "credential-bearing entry", body: { origins: ["https://user:pass@x.example"] } },
    { name: "query-bearing entry", body: { origins: ["https://x.example/?a=1"] } },
    { name: "not a URL at all", body: { origins: ["not a url"] } },
    { name: "extra top-level key (strict body)", body: { origins: [], extra: 1 } },
  ])("422 on $name", async ({ body }) => {
    const put = await putFace(body);
    expect(put.status).toBe(422);
    expect(put.code).toBe("validation_failed");
    // A refused write must not move the seat: the guard posture is unchanged.
    expect((await probe({ origin: "https://x.example" })).status).toBe(403);
  });

  it("rejects a non-JSON body with the 400 invalid_request face (repo-wide body discipline)", async () => {
    const response = await exports.default.fetch(`${BASE}/api/v1/system/origin-allowlist`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(response.status).toBe(400);
    const payload = await response.json<{ code?: string }>();
    expect(payload.code).toBe("invalid_request");
  });
});

describe("fail-closed seat decode (#506)", () => {
  const PANEL = "https://panel.example";

  async function seedCell(raw: string): Promise<void> {
    await env.DB.prepare(
      "INSERT INTO origin_allowlist (id, origins, updated_at) VALUES ('origin_allowlist', ?, ?)" +
        " ON CONFLICT(id) DO UPDATE SET origins = excluded.origins",
    )
      .bind(raw, Date.now())
      .run();
  }

  it("a non-JSON cell treats the allowlist as empty (foreign and extra both rejected)", async () => {
    await seedCell("not-json{");
    expect((await probe({ origin: PANEL })).status).toBe(403);
    expect((await probe({ origin: "https://evil.example" })).status).toBe(403);
  });

  it("a non-array JSON cell treats the allowlist as empty", async () => {
    await seedCell('{"a":1}');
    expect((await probe({ origin: PANEL })).status).toBe(403);
  });

  it("non-origin entries are dropped while valid siblings stay trusted", async () => {
    await seedCell(JSON.stringify([PANEL, "garbage entry", 42]));
    expect((await probe({ origin: PANEL })).status).toBe(200);
    expect((await probe({ origin: "https://evil.example" })).status).toBe(403);
  });
});
