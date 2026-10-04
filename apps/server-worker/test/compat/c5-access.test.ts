import { beforeAll, describe, expect, it } from "vitest";
import { ensureMigrations } from "../migrate.js";
import { SELF } from "cloudflare:test";
import { accessGate } from "../../src/middleware/access.js";
import { verifyAccessToken } from "../../src/middleware/access.js";
import { ApiError } from "../../src/shared/api-error.js";

/**
 * Criterion 5 (port-inventory §6.5): Access rejects unauthorized callers; the
 * SPA keeps zero token logic (all verification is Worker-side, header/cookie
 * only). The gate is staging-flag gated; full JWKS round-trips are L2
 * (staging), so L1 covers: disabled default, enabled rejection, and the pure
 * JWT verification path against a locally generated RS256 keypair.
 */
function fakeContext(headers: Record<string, string>, env: Record<string, string>) {
  return {
    env,
    req: {
      header: (name: string): string | undefined => headers[name.toLowerCase()],
    },
  } as unknown as Parameters<typeof accessGate>[0];
}

async function next(): Promise<void> {}

beforeAll(ensureMigrations);

describe("criterion 5: Access gate", () => {
  it("leaves the API open while the staging flag is off (default vars)", async () => {
    const response = await SELF.fetch("https://example.com/api/v1/threads");
    expect(response.status).toBe(200);
  });

  it("rejects requests without a token when the gate is enabled", async () => {
    await expect(
      accessGate(fakeContext({}, { ACCESS_CHECK_ENABLED: "true" }), next),
    ).rejects.toMatchObject({ status: 401, code: "unauthorized" });
  });

  it("rejects structurally invalid tokens without network calls", async () => {
    await expect(
      accessGate(
        fakeContext(
          { "cf-access-jwt-assertion": "garbage.token" },
          { ACCESS_CHECK_ENABLED: "true", ACCESS_TEAM_DOMAIN: "https://team.example.com" },
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
    const jwks = [{ kid, kty: "RSA", n: jwk.n!, e: jwk.e! }];

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
    const jwks = [{ kid, kty: "RSA", n: jwk.n!, e: jwk.e! }];
    const verified = await verifyAccessToken(token, { jwks, audience: "aud-cookie" });
    expect(verified.aud).toBe("aud-cookie");
  });
});
