import { Hono } from "hono";
import { cors } from "hono/cors";
import { apiErrorHandler } from "./shared/api-error.js";
import { originGuard } from "./middleware/origin-guard.js";
import { accessGate } from "./middleware/access.js";
import { registerThreadRoutes } from "./routes/threads.js";
import { registerSystemRoutes } from "./routes/system.js";
import { registerProjectRoutes, registerThreadSectionRoutes } from "./routes/projects.js";
import { registerHostRoutes } from "./routes/hosts.js";
import { registerEnvironmentRoutes } from "./routes/environments.js";
import { registerPluginRoutes } from "./routes/plugins.js";
import { registerFileRoutes } from "./routes/files.js";
import { installShScript } from "./install-sh.js";
import type { AppEnv, Env } from "./app-types.js";
import type { Context, Next } from "hono";

/** Shared fallback: no guard read this request (no Origin header) = none extra. */
const EMPTY_ORIGIN_ALLOWLIST: ReadonlySet<string> = new Set();

/**
 * Hono assembly, ported from bb apps/server/src/server.ts (commit 8473d8c33)
 * middleware order: guard → CORS → routes, with Access gate inserted ahead of
 * the API (spec #17: Access 前置, Worker 内仅校验 JWT).
 */
// The env slot stays for call-shape symmetry with app.fetch(request, env, ctx)
// (the c5 rig builds the assembled app against an explicit locked env); the
// guards read bindings per-request off ctx.env instead (#506).
export function createApp(_env: Env): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.onError(apiErrorHandler);

  app.get("/health", (ctx) => ctx.json({ ok: true }));

  // Add-a-machine bootstrap (#258): public like bb's /install.sh — the
  // one-time join code is the capability, curl carries no JWT.
  app.get("/install.sh", (ctx) =>
    ctx.body(installShScript(), 200, {
      "content-type": "text/x-shellscript; charset=utf-8",
      "cache-control": "no-store",
    }),
  );

  // Guarded surface: /api/v1/* + /ws (bb guards both, server.ts:490-499).
  app.use("/api/v1/*", async (ctx: Context, next: Next) => {
    await originGuard(ctx, next);
  });
  app.use("/api/v1/*", async (ctx: Context, next: Next) => {
    await accessGate(ctx, next);
  });
  app.use(
    "/api/v1/*",
    cors({
      origin: (origin, ctx) => {
        // #506: the allowlist rides the Origin-guard's per-request D1 read
        // (stashed on the context) — one query serves both legs, and a
        // /system/origin-allowlist write hot-applies without a redeploy.
        const stashed: unknown = ctx.get("originAllowlist");
        const extra = stashed instanceof Set ? stashed : EMPTY_ORIGIN_ALLOWLIST;
        const requestOrigin = new URL(ctx.req.url).origin;
        if (origin === requestOrigin || (extra.has(origin) && origin !== "")) {
          return origin;
        }
        return null;
      },
    }),
  );
  app.use("/ws", async (ctx: Context, next: Next) => {
    await originGuard(ctx, next);
  });
  app.use("/ws", async (ctx: Context, next: Next) => {
    await accessGate(ctx, next);
  });

  // bb mounts publicApi at /api/v1 (server.ts:474).
  registerThreadRoutes(app);
  registerProjectRoutes(app);
  registerThreadSectionRoutes(app);
  registerHostRoutes(app);
  registerFileRoutes(app);
  registerEnvironmentRoutes(app);
  registerPluginRoutes(app);
  registerSystemRoutes(app);

  app.notFound((ctx) => {
    if (ctx.req.path.startsWith("/api/")) {
      return ctx.json({ code: "not_found", message: "Route not found" }, 404);
    }
    return serveAssets(ctx.env, ctx.req.raw, true);
  });

  app.get("/ws", (ctx) => {
    const stub = ctx.env.HUB.get(ctx.env.HUB.idFromName("hub"));
    return stub.fetch(ctx.req.raw);
  });

  // bb static semantics (server.ts:586-656): /assets/* miss → 404, never
  // index.html; other misses → SPA fallback with no-store.
  app.get("/assets/*", (ctx) => serveAssets(ctx.env, ctx.req.raw, false));

  return app;
}

async function serveAssets(env: Env, request: Request, spaFallback: boolean): Promise<Response> {
  const assetResponse = await env.ASSETS.fetch(
    new Request(request.url, { headers: request.headers }),
  );
  if (assetResponse.status !== 404) {
    const headers = new Headers(assetResponse.headers);
    if (new URL(request.url).pathname.startsWith("/assets/")) {
      headers.set("cache-control", "public, max-age=31536000, immutable");
    } else {
      headers.set("cache-control", "no-store");
    }
    return new Response(assetResponse.body, {
      status: assetResponse.status,
      headers,
    });
  }
  if (!spaFallback) {
    // /assets/* 404 stays a 404 (bb server.ts:640-647 rationale).
    return new Response("Not found", { status: 404 });
  }
  const indexUrl = new URL("/index.html", request.url);
  const indexResponse = await env.ASSETS.fetch(new Request(indexUrl, { headers: request.headers }));
  const headers = new Headers(indexResponse.headers);
  headers.set("cache-control", "no-store");
  headers.set("content-type", "text/html; charset=utf-8");
  return new Response(indexResponse.body, {
    status: indexResponse.status,
    headers,
  });
}
