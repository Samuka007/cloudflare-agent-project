import { beforeAll, afterEach, describe, expect, it, vi } from "vitest";
import { ensureMigrations } from "../migrate.js";
import { accessGate } from "../../src/middleware/access.js";
import { verifyAccessToken } from "../../src/middleware/access.js";
import { createApp } from "../../src/app.js";
import { ApiError } from "../../src/shared/api-error.js";
import type { Env } from "../../src/env.js";
import { exports } from "cloudflare:workers";

/**
 * Criterion 5 (port-inventory §6.5): Access rejects unauthorized callers; the
 * SPA keeps zero token logic (all verification is Worker-side, header/cookie
 * only). SEC-W5-001 (#397): the gate is fail-closed. #505 removed the
 * ACCESS_CHECK_ENABLED flag — gate state derives from the credential pair
 * (ACCESS_TEAM_DOMAIN ∧ ACCESS_AUD non-empty), so a half-pair or empty
 * deployment rejects /api/v1 + /ws (503 access_gate_disabled) unless the
 * explicit ACCESS_LOCAL_DEV marker is set — and the marker can never disarm
 * an armed gate. Full JWKS round-trips are L2 (staging), so L1 covers: the
 * fail-closed matrix (empty / half-pair), the marker branch, armed rejection,
 * and the pure JWT verification path against a locally generated RS256
 * keypair.
 */
function fakeContext(
  headers: Record<string, string>,
  env: Record<string, string>,
  state: Record<string, string> = {},
) {
  return {
    env,
    req: {
      header: (name: string): string | undefined => headers[name.toLowerCase()],
    },
    get: (name: string) => state[name],
    set: (name: string, value: string) => {
      state[name] = value;
    },
  } as unknown as Parameters<typeof accessGate>[0];
}

const next = (): Promise<void> => Promise.resolve(undefined);

beforeAll(ensureMigrations);

describe("criterion 5: Access gate", () => {
  it("serves the API only on the explicit local-dev branch (L1 rig env)", async () => {
    // Rig bindings (vitest.config.ts): no Access credentials → gate
    // disarmed, + ACCESS_LOCAL_DEV — the one sanctioned gate-off surface;
    // deployed configs ship the credential pair.
    const response = await exports.default.fetch("https://example.com/api/v1/threads");
    expect(response.status).toBe(200);
  });

  it("rejects with 503 when the credential pair is absent and no local-dev marker is set", async () => {
    // Fail-closed default: fresh deployment, secrets never provisioned.
    await expect(accessGate(fakeContext({}, {}), next)).rejects.toMatchObject({
      status: 503,
      code: "access_gate_disabled",
    });
  });

  it("locks on a half-pair — either credential alone does not arm the gate", async () => {
    // #505: the flag could contradict the secrets (flag on + no credentials
    // = runtime 500s); with the pair as the gate state, a partial
    // provisioning is just an unarmed deployment. Each single key (including
    // empty-string values) keeps the control plane locked.
    await expect(
      accessGate(fakeContext({}, { ACCESS_TEAM_DOMAIN: "https://team.example.com" }), next),
    ).rejects.toMatchObject({ status: 503, code: "access_gate_disabled" });
    await expect(
      accessGate(fakeContext({}, { ACCESS_AUD: "test-aud" }), next),
    ).rejects.toMatchObject({ status: 503, code: "access_gate_disabled" });
    await expect(
      accessGate(fakeContext({}, { ACCESS_TEAM_DOMAIN: "", ACCESS_AUD: "test-aud" }), next),
    ).rejects.toMatchObject({ status: 503, code: "access_gate_disabled" });
    await expect(
      accessGate(
        fakeContext({}, { ACCESS_TEAM_DOMAIN: "https://team.example.com", ACCESS_AUD: "" }),
        next,
      ),
    ).rejects.toMatchObject({ status: 503, code: "access_gate_disabled" });
  });

  it("passes gate-off traffic only with the explicit local-dev marker", async () => {
    await accessGate(fakeContext({}, { ACCESS_LOCAL_DEV: "true" }), next);
  });

  it("never lets the local-dev marker disarm an armed gate", async () => {
    // The marker widens nothing: once the credential pair exists, JWT
    // verification applies even if a stray marker leaks into a deployed env
    // (SEC-W5-001 fail-closed direction — the marker can only unlock an
    // already-unarmed deployment, never weaken an armed one).
    await expect(
      accessGate(
        fakeContext(
          {},
          {
            ACCESS_TEAM_DOMAIN: "https://team.example.com",
            ACCESS_AUD: "test-aud",
            ACCESS_LOCAL_DEV: "true",
          },
        ),
        next,
      ),
    ).rejects.toMatchObject({ status: 401, code: "unauthorized" });
  });

  it("locks /api/v1 and /ws at the assembled-app level when gate-off without the marker", async () => {
    // Bindings ride app.fetch's env argument, so the gate-off non-local
    // deployment is exercisable without touching the rig env; the gate
    // rejects before any binding is read, hence the empty env.
    const lockedEnv = {} as unknown as Env;
    const app = createApp(lockedEnv);
    const threads = await app.fetch(new Request("https://example.com/api/v1/threads"), lockedEnv);
    expect(threads.status).toBe(503);
    expect(await threads.json()).toMatchObject({ code: "access_gate_disabled" });

    const ws = await app.fetch(new Request("https://example.com/ws"), lockedEnv);
    expect(ws.status).toBe(503);
    expect(await ws.json()).toMatchObject({ code: "access_gate_disabled" });
  });

  it("rejects requests without a token when the gate is armed", async () => {
    await expect(
      accessGate(
        fakeContext({}, { ACCESS_TEAM_DOMAIN: "https://team.example.com", ACCESS_AUD: "test-aud" }),
        next,
      ),
    ).rejects.toMatchObject({ status: 401, code: "unauthorized" });
  });

  it("rejects structurally invalid tokens without network calls", async () => {
    await expect(
      accessGate(
        fakeContext(
          { "cf-access-jwt-assertion": "garbage.token" },
          { ACCESS_TEAM_DOMAIN: "https://team.example.com", ACCESS_AUD: "test-aud" },
        ),
        next,
      ),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("verifies RS256 tokens signature + audience + expiry (pure path)", async () => {
    const keyPair = (await crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair; // TS cannot unify the union return of generateKey
    const jwk = (await crypto.subtle.exportKey("jwk", keyPair.publicKey)) as JsonWebKey; // ditto for exportKey
    const kid = "test-key";
    const claims = { aud: "test-aud", exp: Math.floor(Date.now() / 1000) + 300 };
    const encode = (value: object): string =>
      btoa(JSON.stringify(value)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
    const signingInput = `${encode({ alg: "RS256", kid })}.${encode(claims)}`;
    const signature = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      keyPair.privateKey,
      new TextEncoder().encode(signingInput),
    );
    const token = `${signingInput}.${btoa(String.fromCharCode(...new Uint8Array(signature)))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replaceAll("=", "")}`;
    if (jwk.n === undefined || jwk.e === undefined) {
      throw new Error("generated RSA JWK is missing modulus/exponent");
    }
    const jwks = [{ kid, kty: "RSA", n: jwk.n, e: jwk.e }];

    const verified = await verifyAccessToken(token, { jwks, audience: "test-aud" });
    expect(verified.aud).toBe("test-aud");

    await expect(verifyAccessToken(token, { jwks, audience: "other-aud" })).rejects.toMatchObject({
      status: 401,
    });

    const expired = await verifyAccessToken(
      `${encode({ alg: "RS256", kid })}.${encode({ aud: "test-aud", exp: 1 })}.x`,
      { jwks, audience: "test-aud" },
    ).catch((error: unknown) => error);
    expect(expired).toBeInstanceOf(ApiError);

    await expect(
      verifyAccessToken(`${signingInput}.broken`, { jwks, audience: "test-aud" }),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("accepts an audience list — a token matching any allowed aud passes (legacy multi-aud tolerance; staging ACCESS_AUD is single-aud since #435)", async () => {
    const keyPair = (await crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    const jwk = (await crypto.subtle.exportKey("jwk", keyPair.publicKey)) as JsonWebKey;
    const kid = "list-key";
    const claims = { aud: "path-aud", exp: Math.floor(Date.now() / 1000) + 300 };
    const encode = (value: object): string =>
      btoa(JSON.stringify(value)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
    const signingInput = `${encode({ alg: "RS256", kid })}.${encode(claims)}`;
    const signature = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      keyPair.privateKey,
      new TextEncoder().encode(signingInput),
    );
    const token = `${signingInput}.${btoa(String.fromCharCode(...new Uint8Array(signature)))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replaceAll("=", "")}`;
    if (jwk.n === undefined || jwk.e === undefined) {
      throw new Error("generated RSA JWK is missing modulus/exponent");
    }
    const jwks = [{ kid, kty: "RSA", n: jwk.n, e: jwk.e }];

    // Position 2 of the comma list matches → pass.
    const verified = await verifyAccessToken(token, {
      jwks,
      audience: ["main-aud", "path-aud"],
    });
    expect(verified.aud).toBe("path-aud");

    // Absent from the list → 401, same as the single-audience mismatch.
    await expect(
      verifyAccessToken(token, { jwks, audience: ["main-aud", "other-aud"] }),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("accepts service-token claims — empty-string sub passes claims-parse (#441)", async () => {
    const keyPair = (await crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    const jwk = (await crypto.subtle.exportKey("jwk", keyPair.publicKey)) as JsonWebKey;
    const kid = "svc-empty-sub";
    // The real service-token shape (staging tail #439/#440): identity claims
    // present-but-empty — the old .min(1) schema rejected this at
    // claims-parse while the browser (identity-bearing) tokens passed.
    const claims = {
      aud: "app-aud",
      exp: Math.floor(Date.now() / 1000) + 300,
      sub: "",
      iss: "https://team.example.com",
    };
    const encode = (value: object): string =>
      btoa(JSON.stringify(value)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
    const signingInput = `${encode({ alg: "RS256", kid })}.${encode(claims)}`;
    const signature = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      keyPair.privateKey,
      new TextEncoder().encode(signingInput),
    );
    const token = `${signingInput}.${btoa(String.fromCharCode(...new Uint8Array(signature)))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replaceAll("=", "")}`;
    if (jwk.n === undefined || jwk.e === undefined) {
      throw new Error("generated RSA JWK is missing modulus/exponent");
    }
    const jwks = [{ kid, kty: "RSA", n: jwk.n, e: jwk.e }];

    const verified = await verifyAccessToken(token, { jwks, audience: "app-aud" });
    expect(verified.aud).toBe("app-aud");
    expect(verified.sub).toBe("");
  });

  it("accepts the token from the CF_Authorization cookie (browser path)", async () => {
    const keyPair = (await crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair; // TS cannot unify the union return of generateKey
    const jwk = (await crypto.subtle.exportKey("jwk", keyPair.publicKey)) as JsonWebKey; // ditto for exportKey
    const kid = "cookie-key";
    const encode = (value: object): string =>
      btoa(JSON.stringify(value)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
    const header = encode({ alg: "RS256", kid });
    const payload = encode({ aud: "aud-cookie", exp: Math.floor(Date.now() / 1000) + 300 });
    const signature = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      keyPair.privateKey,
      new TextEncoder().encode(`${header}.${payload}`),
    );
    const token = `${header}.${payload}.${btoa(String.fromCharCode(...new Uint8Array(signature)))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replaceAll("=", "")}`;
    if (jwk.n === undefined || jwk.e === undefined) {
      throw new Error("generated RSA JWK is missing modulus/exponent");
    }
    const jwks = [{ kid, kty: "RSA", n: jwk.n, e: jwk.e }];
    const verified = await verifyAccessToken(token, { jwks, audience: "aud-cookie" });
    expect(verified.aud).toBe("aud-cookie");
  });

  // SEC-W5-003: the probe-face rate limiter keys on the VERIFIED identity,
  // so the gate must publish it — sub first, email second, token digest as
  // the per-credential fallback.
  describe("principal capture for the probe-face limiter", () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    async function mintToken(
      claims: Record<string, unknown>,
      keyPair: CryptoKeyPair,
    ): Promise<string> {
      const encode = (value: object): string =>
        btoa(JSON.stringify(value)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
      const header = encode({ alg: "RS256", kid: "principal-key" });
      const signature = await crypto.subtle.sign(
        "RSASSA-PKCS1-v1_5",
        keyPair.privateKey,
        new TextEncoder().encode(`${header}.${encode(claims)}`),
      );
      return `${header}.${encode(claims)}.${btoa(String.fromCharCode(...new Uint8Array(signature)))
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replaceAll("=", "")}`;
    }

    async function mintKeyPairWithJwks(): Promise<{
      keyPair: CryptoKeyPair;
      jwks: object[];
    }> {
      const keyPair = (await crypto.subtle.generateKey(
        {
          name: "RSASSA-PKCS1-v1_5",
          modulusLength: 2048,
          publicExponent: new Uint8Array([1, 0, 1]),
          hash: "SHA-256",
        },
        true,
        ["sign", "verify"],
      )) as CryptoKeyPair;
      const jwk = (await crypto.subtle.exportKey("jwk", keyPair.publicKey)) as JsonWebKey;
      if (jwk.n === undefined || jwk.e === undefined) {
        throw new Error("generated RSA JWK is missing modulus/exponent");
      }
      return {
        keyPair,
        jwks: [{ kid: "principal-key", kty: "RSA", n: jwk.n, e: jwk.e }],
      };
    }

    function stubJwks(jwks: object[]): void {
      vi.stubGlobal("fetch", () =>
        Promise.resolve(
          new Response(JSON.stringify({ keys: jwks }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        ),
      );
    }

    it("publishes the verified sub (then email, then token digest) on the context", async () => {
      // One keypair for both tokens: the module JWKS cache serves the first
      // fetch for 10 minutes, so the second gate call must verify under the
      // same kid.
      const { keyPair, jwks } = await mintKeyPairWithJwks();
      const token = await mintToken(
        {
          aud: "test-aud",
          exp: Math.floor(Date.now() / 1000) + 300,
          sub: "user-123",
          email: "user@example.com",
        },
        keyPair,
      );
      stubJwks(jwks);
      const state: Record<string, string> = {};
      await accessGate(
        fakeContext(
          { "cf-access-jwt-assertion": token },
          {
            ACCESS_TEAM_DOMAIN: "https://team.example.com",
            ACCESS_AUD: "test-aud",
          },
          state,
        ),
        next,
      );
      expect(state.accessPrincipalId).toBe("user-123");

      const emailOnlyToken = await mintToken(
        {
          aud: "test-aud",
          exp: Math.floor(Date.now() / 1000) + 300,
          email: "user@example.com",
        },
        keyPair,
      );
      const emailState: Record<string, string> = {};
      await accessGate(
        fakeContext(
          { "cf-access-jwt-assertion": emailOnlyToken },
          {
            ACCESS_TEAM_DOMAIN: "https://team.example.com",
            ACCESS_AUD: "test-aud",
          },
          emailState,
        ),
        next,
      );
      expect(emailState.accessPrincipalId).toBe("user@example.com");
    });
  });
});
