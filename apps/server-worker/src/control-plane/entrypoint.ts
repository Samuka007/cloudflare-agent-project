import {
  agentSnapshotSchema,
  controlPlaneRequestSchema,
  controlPlaneResponseSchema,
} from "@cap/protocol";
import type { Env } from "../env";
import { readAgentSnapshot } from "./agent-snapshot";
import { markHostSeenInRegistry } from "./registry";

/**
 * The named entrypoint behind the CONTROL_PLANE service binding (db
 * campaign T7, #599) — server-worker's exposed typed RPC face.
 *
 * Named entrypoints answer ONLY binding-targeted fetches: public traffic on
 * the custom domain routes to the default export and can never reach here,
 * so the face needs no additional auth (the binding IS the capability).
 * Both the request and the response validate through the @cap/protocol
 * contract schemas — the zod boundary is the whole integration surface.
 *
 * Consumers: the daemon-service DO's liveness projection (hosts.markSeen)
 * today; the provider snapshot read (agentSnapshot.get) serves any future
 * split of provider-app into its own worker.
 */

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function errorResponse(status: number, code: string, message: string): Response {
  return jsonResponse(
    status,
    controlPlaneResponseSchema.parse({ ok: false, error: { code, message } }),
  );
}

export const control_plane = {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== "POST") {
      return errorResponse(405, "method_not_allowed", "the control-plane face answers POST only");
    }
    let payload: unknown;
    try {
      payload = await request.json();
    } catch {
      return errorResponse(400, "bad_json", "request body is not valid JSON");
    }
    const parsed = controlPlaneRequestSchema.safeParse(payload);
    if (!parsed.success) {
      return errorResponse(400, "bad_request", parsed.error.message);
    }
    try {
      switch (parsed.data.method) {
        case "agentSnapshot.get": {
          const data = agentSnapshotSchema.parse(await readAgentSnapshot(env));
          return jsonResponse(200, { ok: true, data });
        }
        case "hosts.markSeen": {
          const { hostId, at } = parsed.data.args;
          await markHostSeenInRegistry(env, hostId, at);
          return jsonResponse(200, { ok: true, data: null });
        }
      }
    } catch (error) {
      return errorResponse(
        500,
        "internal_error",
        error instanceof Error ? error.message : String(error),
      );
    }
  },
} satisfies ExportedHandler<Env>;
