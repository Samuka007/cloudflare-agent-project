import type { Context, Next } from "hono";
import { z } from "zod";
import { ApiError } from "../shared/api-error.js";
import type { Env } from "../app-types.js";

/**
 * Cloudflare Access JWT gate (spec #17 认证 decision; staging-flag gated via
 * ACCESS_CHECK_ENABLED). When enabled, every /api/v1 request and /ws upgrade
 * must carry a valid Access token: `Cf-Access-Jwt-Assertion` header or the
 * `CF_Authorization` cookie (browsers send the cookie automatically; the SPA
 * itself has zero token logic). Verification is standard RS256 JWT against
 * the team JWKS ({team}/cdn-cgi/access/certs) with audience == ACCESS_AUD,
 * per Cloudflare Access docs. Failure → 401 unauthorized JSON, so the SPA's
 * HTML/401 mapping degrades to "Authentication failed" and
 * ReconnectingWebSocket simply retries (bb-spa-ux-surface §4.2).
 */

const jwtHeaderSchema = z.object({ alg: z.string(), kid: z.string() });
const accessClaimsSchema = z.object({
  aud: z.union([z.string(), z.array(z.string())]),
  exp: z.number(),
  // SEC-W5-003 probe-face rate limiting keys on the verified identity when
  // present; both are standard Cloudflare Access claims (optional here so
  // exotic tokens still pass verification unchanged).
  sub: z.string().min(1).optional(),
  email: z.string().min(1).optional(),
});
interface AccessClaims {
  aud: string | string[];
  exp: number;
  sub?: string;
  email?: string;
}

export interface AccessJwk {
  kid: string;
  kty: string;
  alg?: string;
  n?: string;
  e?: string;
}

export interface VerifyAccessTokenOptions {
  jwks: readonly AccessJwk[];
  audience: string;
  nowMs?: number;
}

let jwksCache: { keys: AccessJwk[]; fetchedAt: number } | null = null;
const JWKS_CACHE_MS = 10 * 60 * 1000;

function bearerToken(ctx: Context): string | null {
  const header = ctx.req.header("cf-access-jwt-assertion");
  if (header !== undefined && header !== "") {
    return header;
  }
  const cookieHeader = ctx.req.header("cookie");
  if (cookieHeader === undefined) {
    return null;
  }
  for (const pair of cookieHeader.split(";")) {
    const [name, ...rest] = pair.trim().split("=");
    if (name === "CF_Authorization") {
      return rest.join("=");
    }
  }
  return null;
}

function decodeSegment(segment: string): unknown {
  const json = atob(segment.replaceAll("-", "+").replaceAll("_", "/"));
  return JSON.parse(json);
}

async function fetchJwks(teamDomain: string): Promise<AccessJwk[]> {
  if (jwksCache !== null && Date.now() - jwksCache.fetchedAt < JWKS_CACHE_MS) {
    return jwksCache.keys;
  }
  const response = await fetch(`${teamDomain}/cdn-cgi/access/certs`);
  if (!response.ok) {
    throw new ApiError({
      status: 503,
      code: "internal",
      message: "Access JWKS unavailable",
      retryable: true,
    });
  }
  const body = await response.json<{ keys?: AccessJwk[] }>();
  const keys = body.keys ?? [];
  jwksCache = { keys, fetchedAt: Date.now() };
  return keys;
}

function base64UrlToBytes(value: string): Uint8Array {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/**
 * Pure RS256 verification (signature, kid → JWK match, exp, aud). Network
 * (JWKS fetch) stays in the middleware so L1 can exercise this path with a
 * locally generated keypair.
 */
export async function verifyAccessToken(
  token: string,
  options: VerifyAccessTokenOptions,
): Promise<AccessClaims> {
  const nowMs = options.nowMs ?? Date.now();
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw unauthorized();
  }
  const headerPart = parts[0];
  const payloadPart = parts[1];
  const signaturePart = parts[2];
  if (headerPart === undefined || payloadPart === undefined || signaturePart === undefined) {
    throw unauthorized();
  }
  let header: z.infer<typeof jwtHeaderSchema>;
  try {
    header = jwtHeaderSchema.parse(decodeSegment(headerPart));
  } catch {
    throw unauthorized();
  }
  if (header.alg !== "RS256") {
    throw unauthorized();
  }
  const jwk = options.jwks.find((candidate) => candidate.kid === header.kid);
  if (jwk?.kty !== "RSA" || jwk.n === undefined || jwk.e === undefined) {
    throw unauthorized();
  }
  const key = await crypto.subtle.importKey(
    "jwk",
    {
      kty: jwk.kty,
      n: jwk.n,
      e: jwk.e,
      alg: "RS256",
      ext: true,
      key_ops: ["verify"],
    },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const data = new TextEncoder().encode(`${headerPart}.${payloadPart}`);
  let signature: Uint8Array;
  try {
    signature = base64UrlToBytes(signaturePart);
  } catch {
    throw unauthorized();
  }
  let valid: boolean;
  try {
    valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature, data);
  } catch {
    throw unauthorized();
  }
  if (!valid) {
    throw unauthorized();
  }
  let claims: AccessClaims;
  try {
    claims = accessClaimsSchema.parse(decodeSegment(payloadPart));
  } catch {
    throw unauthorized();
  }
  if (typeof claims.exp !== "number" || claims.exp * 1000 < nowMs) {
    throw unauthorized();
  }
  const audienceOk =
    claims.aud === options.audience ||
    (Array.isArray(claims.aud) && claims.aud.includes(options.audience));
  if (!audienceOk) {
    throw unauthorized();
  }
  return claims;
}

function requireTeamDomain(env: Env): string {
  if (env.ACCESS_TEAM_DOMAIN === undefined || env.ACCESS_TEAM_DOMAIN === "") {
    throw new ApiError({
      status: 500,
      code: "internal",
      message: "ACCESS_TEAM_DOMAIN must be configured when the Access gate is enabled",
      retryable: false,
    });
  }
  return env.ACCESS_TEAM_DOMAIN;
}

function unauthorized(): ApiError {
  return new ApiError({
    status: 401,
    code: "unauthorized",
    message: "Cloudflare Access token missing or invalid",
  });
}

export function accessGateEnabled(env: Env): boolean {
  return env.ACCESS_CHECK_ENABLED === "true";
}

/** Hex sha-256 — the per-credential fallback principal when the token
 * carries neither sub nor email (keeps raw bearer strings out of memory). */
async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// Return type is inferred (Promise<Response | void>, hono's own middleware
// shape): writing `void` in a union trips no-invalid-void-type, and `next()`
// itself returns Promise<void>, so an `undefined` annotation rejects it.
export async function accessGate(ctx: Context, next: Next) {
  if (!accessGateEnabled(ctx.env as Env)) {
    return next();
  }
  const token = bearerToken(ctx);
  if (token === null) {
    throw unauthorized();
  }
  const header = token.split(".")[0];
  if (header === undefined) {
    throw unauthorized();
  }
  let kid: string;
  try {
    kid = jwtHeaderSchema.parse(decodeSegment(header)).kid;
  } catch {
    throw unauthorized();
  }
  const jwks = await fetchJwks(requireTeamDomain(ctx.env as Env));
  const jwk = jwks.find((candidate) => candidate.kid === kid);
  if (jwk === undefined) {
    throw unauthorized();
  }
  const claims = await verifyAccessToken(token, {
    jwks: [jwk],
    audience: (ctx.env as Env).ACCESS_AUD ?? "",
  });
  ctx.set("accessPrincipalId", claims.sub ?? claims.email ?? (await sha256Hex(token)));
  return next();
}
