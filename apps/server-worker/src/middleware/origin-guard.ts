import type { Context, Next } from "hono";
import { ApiError } from "../shared/api-error.js";
import type { Env } from "../app-types.js";

/**
 * Origin guard, ported from bb apps/server/src/browser-request-guard.ts
 * (commit 8473d8c33, isTrustedOrigin :100-133). A browser request carrying an
 * Origin header is trusted only when the origin parses as http/https and
 * matches: (1) a configured app origin (APP_EXTRA_ORIGINS; bb's
 * buildLocalAppOrigins serverPort/devAppPort rules have no Worker analogue),
 * or (2) a request-target origin — the request URL, the Host header, or the
 * first x-forwarded-host value (with protocol from x-forwarded-proto).
 * Requests without an Origin (curl/CLI/SDK) pass untouched. Rejection is
 * bb's 403 forbidden_origin with the same message text (guard :153-158,
 * server.ts:446-449).
 */

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost"]);

interface RequestTargets {
  origins: Set<string>;
  hostnames: Set<string>;
}

function parseOriginLike(value: string): URL | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }
    if (url.username !== "" || url.password !== "" || url.pathname !== "/" || url.search !== "" || url.hash !== "") {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

function requestTargets(ctx: Context): RequestTargets {
  const origins = new Set<string>();
  const hostnames = new Set<string>();
  const proto = ctx.req.header("x-forwarded-proto") ?? new URL(ctx.req.url).protocol.replace(":", "");
  const candidates = [
    ctx.req.header("host"),
    ctx.req.header("x-forwarded-host")?.split(",")[0],
  ];
  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }
    const url = parseOriginLike(`${proto}://${candidate}`);
    if (url) {
      origins.add(url.origin);
      hostnames.add(url.hostname);
    }
  }
  try {
    const requestUrl = new URL(ctx.req.url);
    origins.add(requestUrl.origin);
    hostnames.add(requestUrl.hostname);
  } catch {
    // unreachable: Hono request URLs parse
  }
  return { origins, hostnames };
}

function configuredOrigins(env: Env): Set<string> {
  const configured = new Set<string>();
  for (const raw of (env.APP_EXTRA_ORIGINS ?? "").split(",")) {
    const trimmed = raw.trim();
    if (trimmed === "") {
      continue;
    }
    const url = parseOriginLike(trimmed);
    if (url) {
      configured.add(url.origin);
    }
  }
  return configured;
}

function isTrustedOrigin(origin: string, env: Env, targets: RequestTargets): boolean {
  const parsed = parseOriginLike(origin);
  if (!parsed) {
    return false;
  }
  if (configuredOrigins(env).has(parsed.origin)) {
    return true;
  }
  if (targets.origins.has(parsed.origin)) {
    return true;
  }
  // bb's known-port rule (origin port ∈ {serverPort, devAppPort} and hostname
  // matches a target) has no fixed Worker port set; localhost dev origins
  // match by hostname so local SPA builds keep working.
  if (LOCAL_HOSTS.has(parsed.hostname) && targets.hostnames.has(parsed.hostname)) {
    return true;
  }
  return false;
}

/** Paths whose routes declare their own auth (bb PLUGIN_WIRE_HTTP_PATH). */
const GUARD_EXEMPT_PREFIXES: string[] = [];

export async function originGuard(ctx: Context, next: Next): Promise<Response | void> {
  const origin = ctx.req.header("origin");
  if (origin !== undefined && !GUARD_EXEMPT_PREFIXES.some((prefix) => ctx.req.path.startsWith(prefix))) {
    const trusted = isTrustedOrigin(origin, ctx.env as Env, requestTargets(ctx));
    if (!trusted) {
      throw new ApiError({
        status: 403,
        code: "forbidden_origin",
        message: `origin "${origin}" is not a local BB app origin`,
      });
    }
  }
  return next();
}
