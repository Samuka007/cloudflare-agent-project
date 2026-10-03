import { apiError, httpStatusForCode } from "@cap/protocol";
import { DAEMON_PROTOCOL_VERSION } from "./constants.js";
import { TestAgentSinkDO } from "./agent-sink.js";
import { DaemonServiceDO, type DaemonServiceEnv } from "./service-do.js";
// Wrangler requires the DO classes on the deployed entry (main).
export { DaemonServiceDO, TestAgentSinkDO };
export type { DaemonServiceEnv };

/**
 * Service worker — the stateless front (unified-turn-state §1.2/topology):
 * daemon-client HTTP handshake (enroll → session/open → WS attach) with
 * Bearer hostKey auth on every daemon seam, and the agent-facing HTTP
 * projection of the DO RPC seam used by the local smoke's fake agent-caller
 * (the real agent DO calls the DO binding directly, not this HTTP face).
 *
 * No state lives here: everything routes into the per-machine DaemonServiceDO
 * (named by hostId / machineId — same instance for the client WS and the
 * agent seam so they meet).
 */

export interface WorkerEnv extends DaemonServiceEnv {
  DAEMON_SERVICE: DurableObjectNamespace;
  ENROLL_KEY: string;
  DAEMON_HOST_KEY: string;
  DAEMON_HOST_ID?: string;
  DAEMON_MACHINE_ID?: string;
}

export default {
  fetch(request: Request, env: WorkerEnv): Promise<Response> {
    return route(request, env);
  },
} satisfies ExportedHandler<WorkerEnv>;

// ---------------------------------------------------------------------------
// Routing (plain fetch — the closest sibling worker packages/agent-do uses
// the same shape; hono is the project HTTP framework for the app surface).
// ---------------------------------------------------------------------------

async function route(request: Request, env: WorkerEnv): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path === "/health") {
    return Response.json({ ok: true, protocolVersion: DAEMON_PROTOCOL_VERSION });
  }

  if (path === "/enroll" && request.method === "POST") {
    return handleEnroll(request, env);
  }

  // Everything below the daemon seam requires Bearer hostKey (engineering.md
  // practice 7: hostKey guards the daemon seam only).
  if (path === "/session/open" && request.method === "POST") {
    const auth = bearerOf(request, env);
    if (auth === null) return unauthorized();
    return handleSessionOpen(request, env, auth.hostIdHint);
  }

  if (path === "/ws") {
    const auth = bearerOf(request, env);
    if (auth === null) return unauthorized();
    return handleWsAttach(request, env);
  }

  if (path.startsWith("/agent/") || path.startsWith("/agent-sink/")) {
    const auth = bearerOf(request, env);
    if (auth === null) return unauthorized();
    return handleAgentRoute(path, request, env);
  }

  return errorResponse("not_found", `no route ${request.method} ${path}`);
}

// ---------------------------------------------------------------------------
// Enroll (bb §5 shape): one-time enrollKey → long-lived {hostId, hostKey}.
// POC stores the key as an env var; M1 moves issuance into a keyed registry.
// ---------------------------------------------------------------------------

async function handleEnroll(request: Request, env: WorkerEnv): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse("bad_request", "invalid json body");
  }
  const parsed = body as { enrollKey?: unknown; hostId?: unknown } | null;
  if (typeof parsed?.enrollKey !== "string" || parsed.enrollKey !== env.ENROLL_KEY) {
    return unauthorized();
  }
  const hostId = typeof parsed.hostId === "string" ? parsed.hostId : (env.DAEMON_HOST_ID ?? "poc-local");
  return Response.json({ hostId, hostKey: env.DAEMON_HOST_KEY }, { status: 201 });
}

// ---------------------------------------------------------------------------
// session/open + WS attach (bb §2.1 handshake steps 1–2).
// ---------------------------------------------------------------------------

async function handleSessionOpen(request: Request, env: WorkerEnv, hostIdHint: string | null): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse("bad_request", "invalid json body");
  }
  const parsed = body as { hostId?: unknown; protocolVersion?: unknown; bootId?: unknown } | null;
  const hostId = typeof parsed?.hostId === "string" ? parsed.hostId : hostIdHint;
  const bootId = typeof parsed?.bootId === "string" ? parsed.bootId : null;
  const protocolVersion = typeof parsed?.protocolVersion === "number" ? parsed.protocolVersion : null;
  if (hostId === null || bootId === null || protocolVersion === null) {
    return errorResponse("validation_failed", "hostId, bootId and protocolVersion are required");
  }
  const stub = stubForHost(env, hostId);
  const result = await stub.openSession({ hostId, protocolVersion, bootId });
  if (!result.ok) {
    return Response.json(
      // bb shape: 400 with the protocol_version_mismatch code in the envelope
      // (outside the frozen ApiErrorCode set — M0 scheme A keeps it raw).
      {
        code: "protocol_version_mismatch",
        message: "protocol version mismatch",
        details: { expected: DAEMON_PROTOCOL_VERSION, received: protocolVersion },
        retryable: false,
      },
      { status: 400 },
    );
  }
  return Response.json(
    {
      sessionId: result.sessionId,
      heartbeatIntervalMs: result.heartbeatIntervalMs,
      leaseTimeoutMs: result.leaseTimeoutMs,
    },
    { status: 201 },
  );
}

async function handleWsAttach(request: Request, env: WorkerEnv): Promise<Response> {
  const url = new URL(request.url);
  const hostId = url.searchParams.get("hostId") ?? "";
  const sessionId = url.searchParams.get("sessionId") ?? "";
  if (hostId === "" || sessionId === "") {
    return errorResponse("validation_failed", "hostId and sessionId query params required");
  }
  // Forward the upgrade into the DO: the accepted socket must be owned by
  // the per-machine DO so hibernation, leases and the journal co-locate.
  // The DO validates the session synchronously in its fetch and rejects the
  // upgrade with 401 before any socket exists (bb's post-upgrade 1008 shape
  // degrades to a pre-upgrade 401 on this platform).
  return stubForHost(env, hostId).fetch(request);
}

// ---------------------------------------------------------------------------
// Agent-facing HTTP projection (smoke driver; real callers use DO RPC).
// ---------------------------------------------------------------------------

async function handleAgentRoute(path: string, request: Request, env: WorkerEnv): Promise<Response> {
  const machineId = env.DAEMON_MACHINE_ID ?? env.DAEMON_HOST_ID ?? "poc-local";
  const stub = stubForHost(env, machineId);

  if (path === "/agent/dispatch" && request.method === "POST") {
    const parsed = await jsonBody(request);
    if (parsed === null) return errorResponse("bad_request", "invalid json body");
    const body = parsed as Record<string, unknown>;
    const executionId = readString(body, "executionId");
    const threadId = readString(body, "threadId");
    // The bash tool shape carries the command inside `arguments` (the same
    // place the real agent DO's ToolDispatchRequest puts it).
    const arguments_ = (body["arguments"] as Record<string, unknown> | undefined) ?? {};
    const command = typeof arguments_["command"] === "string" ? arguments_["command"] : readString(body, "command");
    if (executionId === null || threadId === null || command === null) {
      return errorResponse("validation_failed", "executionId, threadId, command required");
    }
    const outcome = await stub.dispatch({
      threadId,
      turnId: readString(body, "turnId") ?? "turn_smoke",
      executionId,
      machineId,
      tool: readString(body, "tool") ?? "bash",
      arguments: arguments_,
      timeoutMs: typeof body["timeoutMs"] === "number" ? (body["timeoutMs"] as number) : 0,
    });
    return Response.json(outcome);
  }

  if (path === "/agent/kill" && request.method === "POST") {
    const parsed = await jsonBody(request);
    if (parsed === null) return errorResponse("bad_request", "invalid json body");
    const executionId = readString(parsed as Record<string, unknown>, "executionId");
    if (executionId === null) return errorResponse("validation_failed", "executionId required");
    await stub.kill(executionId);
    return Response.json({ ok: true });
  }

  if (path === "/agent/ack" && request.method === "POST") {
    const parsed = await jsonBody(request);
    if (parsed === null) return errorResponse("bad_request", "invalid json body");
    const body = parsed as Record<string, unknown>;
    const executionId = readString(body, "executionId");
    const resultSeq = body["resultSeq"];
    if (executionId === null || typeof resultSeq !== "number") {
      return errorResponse("validation_failed", "executionId and numeric resultSeq required");
    }
    await stub.ackExecution(executionId, resultSeq);
    return Response.json({ ok: true });
  }

  if (path === "/agent/unacked") {
    const threadId = new URL(request.url).searchParams.get("threadId");
    if (threadId === null) return errorResponse("validation_failed", "threadId query param required");
    return Response.json({ unacked: await stub.queryUnacked(threadId) });
  }

  if (path === "/agent/journal") {
    const executionId = new URL(request.url).searchParams.get("executionId") ?? undefined;
    return Response.json({ ops: await stub.journalOps(executionId) });
  }

  if (path === "/agent/session") {
    return Response.json({ session: await stub.sessionView() });
  }

  // Agent-sink inspection (smoke assertions on forwarded updates).
  if (path === "/agent-sink/updates") {
    const threadId = new URL(request.url).searchParams.get("threadId") ?? machineId;
    const sink = env.AGENT_DO.get(env.AGENT_DO.idFromName(threadId)) as DurableObjectStub & TestAgentSinkDO;
    return Response.json({ updates: await sink.updates() });
  }

  return errorResponse("not_found", `no agent route ${path}`);
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

function stubForHost(env: WorkerEnv, hostId: string): DurableObjectStub & DaemonServiceDO {
  const name = hostId === "" ? (env.DAEMON_MACHINE_ID ?? "poc-local") : hostId;
  return env.DAEMON_SERVICE.get(env.DAEMON_SERVICE.idFromName(name)) as DurableObjectStub & DaemonServiceDO;
}

/** Bearer hostKey check; returns the hostId hint from the key identity. */
function bearerOf(request: Request, env: WorkerEnv): { hostIdHint: string } | null {
  const header = request.headers.get("authorization");
  if (header === null) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (match === null) return null;
  if (match[1] !== env.DAEMON_HOST_KEY) return null;
  return { hostIdHint: env.DAEMON_HOST_ID ?? "poc-local" };
}

async function jsonBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = await request.json();
    if (parsed !== null && typeof parsed === "object") {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

function readString(body: Record<string, unknown>, key: string): string | null {
  const value = body[key];
  return typeof value === "string" ? value : null;
}

function unauthorized(): Response {
  return errorResponse("bad_request", "missing or invalid bearer hostKey", 401);
}

function errorResponse(code: string, message: string, statusOverride?: number): Response {
  const status = statusOverride ?? httpStatusForCode(code as never);
  return Response.json(apiError(code as never, message), { status });
}
