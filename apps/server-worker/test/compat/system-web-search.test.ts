import { beforeAll, afterEach, describe, expect, it } from "vitest";
import { env, exports } from "cloudflare:workers";
import { ensureMigrations } from "../migrate.js";
import { decryptProviderSecret, loadProviderConfigOverlay } from "@cap/provider-app";
import {
  systemWebSearchResponseSchema,
  type SystemWebSearchResponse,
} from "../../src/contract/api/system.js";
import { setWebSearchConfig } from "../../src/db/web-search.js";

/**
 * #449 the web-search engine-chain write face (the D1 `web_search` row, the
 * sole 正本 — the AGENT_DO_WEB_SEARCH env path is deleted, #450 zero-env
 * ruling): GET/PUT /api/v1/system/web-search. Acceptance faces exercised:
 *
 * - chain reorder/add is stored and effective (GET re-reads the stored
 *   truth, the rowAfterWrite discipline);
 * - the credential protocol is TRI-STATE (absent → keep, null → clear,
 *   string → set) per engine field;
 * - validation refuses browser-backed and unknown chain entries (L1:
 *   rejection, never silent fallback);
 * - secrets are AES-GCM at rest (a D1 direct read never yields plaintext);
 * - the master-key gate refuses key-bearing writes without the secret;
 * - a broken stored row is a loud decodeError and refuses keep-semantics.
 */

beforeAll(ensureMigrations);

const BASE = "https://example.com";
// The L1 rig master key (vitest miniflare bindings) — the deployment injects
// the same value via `wrangler secret put PROVIDER_CONFIG_MASTER_KEY`.
const RIG_MASTER_KEY = "l1-rig-master-key";
const BRAVE_KEY = "brave-secret-449-value";
const BRAVE_KEY_ROTATED = "brave-secret-449-rotated";
const EXA_KEY = "exa-secret-539-value";
const SEARXNG_TOKEN = "searxng-secret-449-token";

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

type WebSearchFace = SystemWebSearchResponse;

async function getFace(): Promise<WebSearchFace> {
  const response = await request("GET", "/api/v1/system/web-search");
  expect(response.status).toBe(200);
  return systemWebSearchResponseSchema.parse(await response.json());
}

async function putFace(
  body: unknown,
): Promise<{ status: number; face?: WebSearchFace; code?: string; message?: string }> {
  const response = await request("PUT", "/api/v1/system/web-search", body);
  const payload = await response.json<{ code?: string; message?: string }>();
  return {
    status: response.status,
    ...(response.status === 200 ? { face: systemWebSearchResponseSchema.parse(payload) } : payload),
  };
}

async function rawSeatRow(): Promise<{
  chain: string;
  timeout_seconds: number;
  engines: string | null;
  secrets_enc: string | null;
  secrets_meta: string | null;
} | null> {
  return env.DB.prepare(
    "SELECT chain, timeout_seconds, engines, secrets_enc, secrets_meta FROM web_search WHERE id = 'web_search'",
  ).first<{
    chain: string;
    timeout_seconds: number;
    engines: string | null;
    secrets_enc: string | null;
    secrets_meta: string | null;
  }>();
}

afterEach(async () => {
  // The seat is single-row; every case starts from the unconfigured state.
  await env.DB.prepare("DELETE FROM web_search WHERE id = 'web_search'").run();
});

describe("GET /api/v1/system/web-search", () => {
  it("serves the ruled defaults when no seat row exists", async () => {
    const face = await getFace();
    expect(face.configured).toBe(false);
    expect(face.decodeError).toBe(false);
    expect(face.chain.map((entry) => entry.engine)).toEqual(["brave", "public"]);
    expect(face.timeoutSeconds).toBe(60);
    expect(face.availableEngines).toEqual([
      "brave",
      "exa",
      "duckduckgo",
      "searxng",
      "startpage",
      "public",
    ]);
    expect(face.browserBackedEngines).toEqual(["google", "ecosia", "mojeek"]);
    expect(face.engines).toEqual({
      brave: { hasApiKey: false },
      exa: { hasApiKey: false },
      searxng: {
        endpoint: null,
        categories: null,
        language: null,
        safesearch: null,
        hasToken: false,
        hasBasicAuth: false,
      },
    });
  });

  it("reflects the stored chain order and engine detail", async () => {
    const put = await putFace({
      chain: ["public", "duckduckgo", "searxng"],
      timeoutSeconds: 90,
      engines: { searxng: { endpoint: "https://searx.example.com", language: "en" } },
    });
    expect(put.status).toBe(200);
    // The response is the post-write truth (rowAfterWrite discipline).
    expect(put.face?.chain.map((entry) => entry.engine)).toEqual([
      "public",
      "duckduckgo",
      "searxng",
    ]);
    expect(put.face?.timeoutSeconds).toBe(90);
    expect(put.face?.configured).toBe(true);
    expect(put.face?.engines.searxng).toMatchObject({
      endpoint: "https://searx.example.com",
      language: "en",
      hasToken: false,
    });
    // GET re-reads the SAME stored truth.
    const face = await getFace();
    expect(face.chain.map((entry) => entry.engine)).toEqual(["public", "duckduckgo", "searxng"]);
    expect(face.engines.searxng.endpoint).toBe("https://searx.example.com");
    // The raw D1 row is the 正本 the loader (and thus the agent DO) reads.
    const row = await rawSeatRow();
    if (!row) throw new Error("web_search row must exist");
    expect(JSON.parse(row.chain)).toEqual(["public", "duckduckgo", "searxng"]);
    expect(row.timeout_seconds).toBe(90);
  });

  it("reports a broken stored row loudly and refuses keep-semantics on it", async () => {
    // A hand-edited row carrying a browser-backed engine can never come from
    // the write face; the loader refuses the chain (L1) and the faces report
    // decodeError instead of silently substituting defaults.
    await env.DB.prepare(
      "INSERT INTO web_search (id, chain, timeout_seconds, engines, secrets_enc, secrets_meta, updated_at) VALUES ('web_search', '[\"google\"]', 60, NULL, NULL, NULL, ?)",
    )
      .bind(Date.now())
      .run();
    const face = await getFace();
    expect(face.configured).toBe(true);
    expect(face.decodeError).toBe(true);
    expect(face.chain).toEqual([]);
    // The zero-detail object rides the loud decodeError banner — the panel
    // renders the unavailable row, never a writable editor over broken data.
    expect(face.engines).toEqual({
      brave: { hasApiKey: false },
      exa: { hasApiKey: false },
      searxng: {
        endpoint: null,
        categories: null,
        language: null,
        safesearch: null,
        hasToken: false,
        hasBasicAuth: false,
      },
    });
    const put = await putFace({ chain: ["public"] });
    expect(put.status).toBe(422);
    expect(put.code).toBe("web_search_row_broken");
  });
});

describe("PUT /api/v1/system/web-search", () => {
  it("bumps the overlay fingerprint so warm DO isolates hot-apply (#449)", async () => {
    const before = (await loadProviderConfigOverlay(env))?.fingerprint;
    await putFace({ chain: ["public"] });
    const after = (await loadProviderConfigOverlay(env))?.fingerprint;
    expect(before).toBeDefined();
    expect(after).not.toBe(before);
  });

  it("refuses browser-backed and unknown engines with the policy error (L1)", async () => {
    const backed = await putFace({ chain: ["google"] });
    expect(backed.status).toBe(422);
    expect(backed.code).toBe("validation_failed");
    expect(backed.message).toContain("browser-backed");
    expect(backed.message).toContain("google");
    const unknown = await putFace({ chain: ["askjeeves"] });
    expect(unknown.status).toBe(422);
    expect(unknown.message).toContain('unknown engine "askjeeves"');
    // Fail-closed: the refused writes left no seat row behind.
    expect(await rawSeatRow()).toBeNull();
  });

  it("refuses shape violations: empty chain, non-positive timeout", async () => {
    const empty = await putFace({ chain: [] });
    expect(empty.status).toBe(422);
    const zero = await putFace({ chain: ["public"], timeoutSeconds: 0 });
    expect(zero.status).toBe(422);
    const unknownMember = await putFace({ chain: ["public"], engines: { brave: { foo: 1 } } });
    expect(unknownMember.status).toBe(422);
  });

  it("clamps the timeout to the omp 300s ceiling", async () => {
    const put = await putFace({ chain: ["public"], timeoutSeconds: 999 });
    expect(put.status).toBe(200);
    expect(put.face?.timeoutSeconds).toBe(300);
    const row = await rawSeatRow();
    if (!row) throw new Error("web_search row must exist");
    expect(row.timeout_seconds).toBe(300);
  });

  it("stores secrets tri-state and AES-GCM at rest (brave + exa)", async () => {
    // Set.
    const first = await putFace({
      chain: ["brave", "exa", "public"],
      engines: {
        brave: { apiKey: BRAVE_KEY },
        exa: { apiKey: EXA_KEY },
        searxng: { token: SEARXNG_TOKEN },
      },
    });
    expect(first.status).toBe(200);
    expect(first.face?.engines.brave.hasApiKey).toBe(true);
    expect(first.face?.engines.exa.hasApiKey).toBe(true);
    expect(first.face?.engines.searxng.hasToken).toBe(true);
    expect(first.face?.chain).toEqual([
      { engine: "brave", credentialsRequired: true, credentialsPresent: true },
      { engine: "exa", credentialsRequired: true, credentialsPresent: true },
      { engine: "public", credentialsRequired: false, credentialsPresent: true },
    ]);
    // Encryption at rest: the D1 column never carries plaintext.
    const row = await rawSeatRow();
    if (!row) throw new Error("web_search row must exist");
    expect(row.secrets_enc).not.toBeNull();
    if (row.secrets_enc === null) throw new Error("secrets_enc must be stored");
    expect(row.secrets_enc).not.toContain(BRAVE_KEY);
    expect(row.secrets_enc).not.toContain(EXA_KEY);
    expect(row.secrets_enc).not.toContain(SEARXNG_TOKEN);
    const decrypted = JSON.parse(await decryptProviderSecret(RIG_MASTER_KEY, row.secrets_enc)) as {
      brave?: { apiKey?: string };
      exa?: { apiKey?: string };
      searxng?: { token?: string };
    };
    expect(decrypted.brave?.apiKey).toBe(BRAVE_KEY);
    expect(decrypted.exa?.apiKey).toBe(EXA_KEY);
    expect(decrypted.searxng?.token).toBe(SEARXNG_TOKEN);
    // Keep: a reorder that omits the key fields preserves them.
    const kept = await putFace({ chain: ["public", "brave"] });
    expect(kept.face?.engines.brave.hasApiKey).toBe(true);
    expect(kept.face?.engines.exa.hasApiKey).toBe(true);
    expect(kept.face?.engines.searxng.hasToken).toBe(true);
    // Rotate.
    const rotated = await putFace({ engines: { brave: { apiKey: BRAVE_KEY_ROTATED } } });
    expect(rotated.face?.engines.brave.hasApiKey).toBe(true);
    const rotateRow = await rawSeatRow();
    if (!rotateRow) throw new Error("web_search row must exist after rotate");
    if (rotateRow.secrets_enc === null) throw new Error("secrets_enc must be stored after rotate");
    const decryptedAfterRotate = JSON.parse(
      await decryptProviderSecret(RIG_MASTER_KEY, rotateRow.secrets_enc),
    ) as { brave?: { apiKey?: string }; searxng?: { token?: string } };
    expect(decryptedAfterRotate.brave?.apiKey).toBe(BRAVE_KEY_ROTATED);
    expect(decryptedAfterRotate.searxng?.token).toBe(SEARXNG_TOKEN);
    // Clear: null wipes the field (and drops the ciphertext when empty).
    const cleared = await putFace({ engines: { brave: { apiKey: null } } });
    expect(cleared.face?.engines.brave.hasApiKey).toBe(false);
    // Exa is untouched by brave's clear — the tri-state scope is per engine.
    expect(cleared.face?.engines.exa.hasApiKey).toBe(true);
    expect(cleared.face?.engines.searxng.hasToken).toBe(true);
    // Zero-secret discipline: the wire never carries a value.
    expect(JSON.stringify(cleared.face)).not.toContain(BRAVE_KEY_ROTATED);
    expect(JSON.stringify(cleared.face)).not.toContain(EXA_KEY);
    expect(JSON.stringify(cleared.face)).not.toContain(SEARXNG_TOKEN);

    // Exa clears on its own null write.
    const exaCleared = await putFace({ engines: { exa: { apiKey: null } } });
    expect(exaCleared.face?.engines.exa.hasApiKey).toBe(false);
  });

  it("guards the master-key gate at the db layer (fail-closed)", async () => {
    await expect(
      setWebSearchConfig(
        { DB: env.DB, PROVIDER_CONFIG_MASTER_KEY: undefined },
        {
          chain: ["brave"],
          timeoutSeconds: 60,
          engines: {},
          secrets: { brave: { apiKey: BRAVE_KEY } },
          meta: { brave: { apiKey: true } },
        },
        undefined,
      ),
    ).rejects.toThrow("master_key_missing");
    // Fail-closed: the refused write left no row behind.
    expect(await rawSeatRow()).toBeNull();
  });
});
