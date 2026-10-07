import type { Context, Next } from "hono";
import { z } from "zod";
import { ApiError } from "../shared/api-error.js";
import type { Env } from "../app-types.js";

/**
 * Cloudflare Access JWT gate (spec #17 认证 decision). When armed, every
 * /api/v1 request and /ws upgrade must carry a valid Access token:
 * `Cf-Access-Jwt-Assertion` header or the `CF_Authorization` cookie (browsers
 * send the cookie automatically; the SPA itself has zero token logic).
 * Verification is standard RS256 JWT against the team JWKS
 * ({team}/cdn-cgi/access/certs) with audience == ACCESS_AUD, per Cloudflare
 * Access docs. Failure → 401 unauthorized JSON, so the SPA's HTML/401 mapping
 * degrades to "Authentication failed" and ReconnectingWebSocket simply retries
 * (bb-spa-ux-surface §4.2).
 *
 * SEC-W5-001 (#397): the gate is fail-closed. #505 removed the
 * ACCESS_CHECK_ENABLED flag — gate state derives from the credential pair
 * itself (accessGateEnabled: ACCESS_TEAM_DOMAIN ∧ ACCESS_AUD non-empty), so
 * a deployment either has the Access app credentials or it has no
 * authentication front; there is no third "flag says on, secrets say off"
 * state to drift into. Credentials absent → /api/v1/* and /ws answer 503
 * access_gate_disabled. The ONLY way to run gate-off is the explicit
 * local-dev marker ACCESS_LOCAL_DEV="true" (L1 rig, `wrangler dev`);
 * deployed configs ship the two secrets (deploy scripts assert them).
 */

const jwtHeaderSchema = z.object({ alg: z.string(), kid: z.string() });
const accessClaimsSchema = z.object({
  aud: z.union([z.string(), z.array(z.string())]),
  exp: z.number(),
  // SEC-W5-003 probe-face rate limiting keys on the verified identity when
  // present. #441: service-token JWTs carry an EMPTY sub (no identity by
  // design) — present-but-empty rejected by the old .min(1) at claims-parse
  // (staging tail实证: browser identity tokens passed, service tokens 401).
  // Identity fields stay optional AND tolerate empty; the security-relevant
  // strict fields are aud/exp/signature, not identity presence.
  sub: z.string().optional(),
  email: z.string().optional(),
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
  /** Allowed audiences. Production ACCESS_AUD is the single root-app aud
   * (#412 app consolidation, #435 secret/env cleanup); the comma-separated
   * list form is legacy tolerance from the retired per-path-app era — a
   * token matching any listed aud still passes. */
  audience: string | readonly string[];
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
    console.log("verifyAccessToken stage: verify-threw");
    throw unauthorized();
  }
  if (!valid) {
    console.log(
      "verifyAccessToken stage: sig-invalid",
      `tokenLen=${token.length}`,
      `first=${JSON.stringify(token[0])}`,
      `last=${JSON.stringify(token[token.length - 1])}`,
      `sigLen=${signature.length}`,
    );
    throw unauthorized();
  }
  let claims: AccessClaims;
  try {
    claims = accessClaimsSchema.parse(decodeSegment(payloadPart));
  } catch {
    console.log("verifyAccessToken stage: claims-parse");
    throw unauthorized();
  }
  if (typeof claims.exp !== "number" || claims.exp * 1000 < nowMs) {
    throw unauthorized();
  }
  const allowed = typeof options.audience === "string" ? [options.audience] : options.audience;
  const presented = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  const audienceOk = presented.some((a) => allowed.includes(a));
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
  // #437 事故：secret 曾存裸域名（无 scheme），fetchJwks 拼出
  // "host/cdn-cgi/…" 非法 URL → gate 覆盖面全 500。归一化：裸域名补
  // https://，尾斜杠剥除——两种形态都合法，一类事故关门。
  const raw = env.ACCESS_TEAM_DOMAIN.trim().replace(/\/+$/, "");
  return raw.startsWith("https://") || raw.startsWith("http://") ? raw : `https://${raw}`;
}

function unauthorized(): ApiError {
  return new ApiError({
    status: 401,
    code: "unauthorized",
    message: "Cloudflare Access token missing or invalid",
  });
}

/**
 * Gate state = credential presence (#505): both ACCESS_TEAM_DOMAIN and
 * ACCESS_AUD non-empty (whitespace-only counts as absent, matching
 * requireTeamDomain's normalization). No flag, one source of state —
 * SEC-W5-001 fail-closed keeps its one-sided failure mode: no credentials =
 * no control plane.
 */
function accessGateEnabled(env: Env): boolean {
  const teamDomain = env.ACCESS_TEAM_DOMAIN?.trim() ?? "";
  const aud = env.ACCESS_AUD?.trim() ?? "";
  return teamDomain !== "" && aud !== "";
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
    // Fail-closed (SEC-W5-001 #397): gate-off no longer means open. The only
    // branch that serves /api/v1 + /ws without the gate is the explicit
    // local-dev marker (L1 rig, `wrangler dev`; never in wrangler configs) —
    // otherwise the deployment lacks the Access credential pair (#505: the
    // pair IS the gate state), so reject the whole control plane. 503 (not
    // 401): no client credential can fix a deployment-side misconfiguration.
    if ((ctx.env as Env).ACCESS_LOCAL_DEV !== "true") {
      throw new ApiError({
        status: 503,
        code: "access_gate_disabled",
        message:
          "Control plane is locked: the Access credential pair (ACCESS_TEAM_DOMAIN + ACCESS_AUD secrets) is not configured and this deployment is not marked local-dev — provision both secrets (`wrangler secret put`) to arm the gate, or set ACCESS_LOCAL_DEV=true on a local rig only",
        retryable: false,
      });
    }
    return next();
  }
  const token = bearerToken(ctx);
  if (token === null) {
    // #437 live triage: which reject stage fired — token extraction, header
    // parse, kid lookup, or verification. One line per reject; no token
    // material logged (kid + stage only).
    console.log("access gate reject: no-token", ctx.req.path);
    throw unauthorized();
  }
  const header = token.split(".")[0];
  if (header === undefined) {
    console.log("access gate reject: malformed-token", ctx.req.path);
    throw unauthorized();
  }
  let kid: string;
  try {
    kid = jwtHeaderSchema.parse(decodeSegment(header)).kid;
  } catch {
    console.log("access gate reject: header-parse", ctx.req.path);
    throw unauthorized();
  }
  const jwks = await fetchJwks(requireTeamDomain(ctx.env as Env));
  const jwk = jwks.find((candidate) => candidate.kid === kid);
  if (jwk === undefined) {
    console.log("access gate reject: kid-miss", kid, ctx.req.path);
    throw unauthorized();
  }
  let claims: AccessClaims;
  try {
    claims = await verifyAccessToken(token, {
      jwks: [jwk],
      // ACCESS_AUD is the single root-app aud in production (#435); the
      // comma-split survives as tolerance for the retired multi-aud form.
      audience: ((ctx.env as Env).ACCESS_AUD ?? "").split(",").filter(Boolean),
    });
  } catch (error) {
    // Decode-only diagnostic (no signature trust): aud/exp/iss are
    // non-sensitive claims; pinpoints aud-mismatch vs expiry vs issuer.
    try {
      const parts = token.split(".");
      const payload = decodeSegment(parts[1] ?? "") as Record<string, unknown>;
      console.log(
        "access gate reject detail:",
        JSON.stringify({ aud: payload.aud, exp: payload.exp, iss: payload.iss }),
        "allowed:",
        JSON.stringify(((ctx.env as Env).ACCESS_AUD ?? "").split(",").filter(Boolean)),
      );
    } catch {
      // decoding is best-effort; the primary reject log above already fired
    }
    console.log(
      "access gate reject: verify",
      kid,
      error instanceof ApiError ? error.message : String(error),
      ctx.req.path,
    );
    throw error;
  }
  // #441: empty-string identity (service tokens) must fall through to the
  // digest principal — ?? only catches null/undefined, so guard on truthiness.
  // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- empty-string sub/email are the service-token shape and MUST fall through
  const principal = claims.sub || claims.email || (await sha256Hex(token));
  ctx.set("accessPrincipalId", principal);
  return next();
}
