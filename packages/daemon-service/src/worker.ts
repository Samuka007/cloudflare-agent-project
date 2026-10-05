import { apiError, httpStatusForCode } from "@cap/protocol";
import { DAEMON_PROTOCOL_VERSION } from "./constants.js";
import {
  armNegativeCache,
  authKeyOf,
  backfillAuthCache,
  isOverloadClass,
  loadCachedAuth,
  negativeCacheTtlMs,
  negativeRemainingMs,
  rateLimitedResponse,
  sha256Hex,
  takeToken,
} from "./edge.js";
import { TestAgentSinkDO } from "./agent-sink.js";
import { consumeJoinCode } from "./join-codes.js";
import { DaemonServiceDO, type DaemonServiceEnv, type OpenSessionResult } from "./service-do.js";
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
  /**
   * Control-plane host-registry bridge (#49): fired after enroll completes
   * and after each successful session/open, so the control plane's /hosts
   * registry learns the daemon attachment. `hostName` is the daemon's
   * self-reported machine name (bb session/open payload hostName →
   * upsertHost, internal/session.ts:90-95) — the registry stamps it on
   * first sight only, so owner renames survive re-dials. Optional — rigs
   * without a control-plane registry (L1, hookup) omit it. Failures are
   * logged, never fatal: the next handshake step re-fires the bridge (same
   * self-healing shape as the auth ladder's KV backfill).
   */
  onDaemonAttach?: (hostId: string, info?: DaemonAttachInfo) => Promise<void>;
  /**
   * #195 S3 protocol-reject bridge: a handshake with a mismatched
   * protocolVersion writes the daemon's version into the host row
   * (`last_rejected_protocol_version`, bb internal/session.ts:52-55) so the
   * SPA's "Needs update" face activates. Optional like onDaemonAttach;
   * failures are logged, never fatal (the rejection response still leaves).
   */
  onDaemonProtocolReject?: (hostId: string, protocolVersion: number) => Promise<void>;
  /**
   * Edge shield (#36): auth-hash cache binding. Optional — deployments that
   * run on the env-key path only (L1 rig, hookup) skip every KV touch.
   */
  DAEMON_EDGE_KV?: KVNamespace;
  /** Edge-shield tunables (string vars; named-constant defaults). */
  DAEMON_NEGATIVE_CACHE_MS?: string;
  DAEMON_RATE_LIMIT_CAPACITY?: string;
  DAEMON_RATE_LIMIT_REFILL_PER_SEC?: string;
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
    const auth = await authorize(request, env);
    if (auth === null) return unauthorized();
    return handleSessionOpen(request, env, auth.hostIdHint);
  }

  if (path === "/ws") {
    const auth = await authorize(request, env);
    if (auth === null) return unauthorized();
    return handleWsAttach(request, env);
  }

  if (path.startsWith("/agent/") || path.startsWith("/agent-sink/")) {
    const auth = await authorize(request, env);
    if (auth === null) return unauthorized();
    return handleAgentRoute(path, request, env);
  }

  return errorResponse("not_found", `no route ${request.method} ${path}`);
}

// ---------------------------------------------------------------------------
// Enroll (bb §5 shape): one-time credential → long-lived {hostId, hostKey}.
// Two credential classes (#258): the POC static env ENROLL_KEY (hostId comes
// from the body/deployment identity) and a one-time join code minted by the
// control plane's POST /hosts/join-codes (the minted hostId is the authority
// — bb machine-auth.enrollHost redeems the key's metadata, the daemon never
// self-assigns: internal/hosts.ts:83-122, machine-auth.ts:360-401). M1's key
// registry replaces both seams with per-host keys.
// ---------------------------------------------------------------------------

async function handleEnroll(request: Request, env: WorkerEnv): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse("bad_request", "invalid json body");
  }
  const parsed = body as { enrollKey?: unknown; hostId?: unknown } | null;
  if (typeof parsed?.enrollKey !== "string" || parsed.enrollKey === "") {
    return unauthorized();
  }
  const credential = parsed.enrollKey;
  let hostId: string;
  if (credential === env.ENROLL_KEY) {
    hostId =
      typeof parsed.hostId === "string" ? parsed.hostId : (env.DAEMON_HOST_ID ?? "poc-local");
  } else if (env.DAEMON_EDGE_KV !== undefined) {
    // Join-code path: the mint record's hostId wins over any body claim.
    const mintedHostId = await consumeJoinCode(env.DAEMON_EDGE_KV, credential);
    if (mintedHostId === null) return unauthorized();
    hostId = mintedHostId;
  } else {
    // No KV binding → no mint surface exists → nothing to redeem.
    return unauthorized();
  }
  const hostName = readString(parsed, "hostName");
  // Auth-ladder order (#36): DO mirror first (the authority), KV cache
  // second. The mirror lands in the deployment-identity DO — the one the
  // ladder's KV-miss fallback consults (at fallback time the host is not
  // yet known, so "which DO validates" can only be the deployment's own
  // identity; M1's key registry replaces this seam). Failure windows:
  // mirror write fails → enroll fails closed (no cache entry exists to
  // answer wrongly); KV put fails after a good mirror → enroll still
  // succeeds and the next open pays one DO authCheck that backfills the
  // cache (self-healing).
  const keyHash = await sha256Hex(env.DAEMON_HOST_KEY);
  try {
    await stubForHost(env, env.DAEMON_HOST_ID ?? env.DAEMON_MACHINE_ID ?? hostId).mirrorHostKey({
      keyHash,
      hostId,
      ttlMs: 60_000,
    });
  } catch {
    return errorResponse("internal", "hostKey mirror registration failed");
  }
  await backfillAuthCache(env.DAEMON_EDGE_KV, keyHash, hostId);
  await bridgeHostAttach(env, hostId, { hostName });
  return Response.json({ hostId, hostKey: env.DAEMON_HOST_KEY }, { status: 201 });
}

// ---------------------------------------------------------------------------
// session/open + WS attach (bb §2.1 handshake steps 1–2).
// ---------------------------------------------------------------------------

async function handleSessionOpen(
  request: Request,
  env: WorkerEnv,
  hostIdHint: string | null,
): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse("bad_request", "invalid json body");
  }
  const parsed = body as { hostId?: unknown; protocolVersion?: unknown; bootId?: unknown } | null;
  const hostId = typeof parsed?.hostId === "string" ? parsed.hostId : hostIdHint;
  const bootId = typeof parsed?.bootId === "string" ? parsed.bootId : null;
  const hostName = readString(parsed ?? {}, "hostName");
  const protocolVersion =
    typeof parsed?.protocolVersion === "number" ? parsed.protocolVersion : null;
  if (hostId === null || bootId === null || protocolVersion === null) {
    return errorResponse("validation_failed", "hostId, bootId and protocolVersion are required");
  }
  // Edge gates (#36): negative cache first (doomed requests must not drain
  // bucket tokens), then the per-hostId bucket, then the DO.
  const shield = negotiateGuard(env, hostId);
  if (shield !== null) return shield;
  const stub = stubForHost(env, hostId);
  let result: OpenSessionResult;
  try {
    result = await stub.openSession({ hostId, protocolVersion, bootId });
  } catch (error) {
    if (isOverloadClass(error)) {
      armNegativeCache(hostId, negativeCacheTtlMs(env));
      return rateLimitedResponse(
        negativeCacheTtlMs(env) / 1000,
        "durable object is overloaded; retry after the negative-cache window",
      );
    }
    throw error;
  }
  if (!result.ok) {
    // bb internal/session.ts:52-77: a rejection stamps the daemon's version
    // into the host row, consumes any pending retry-update flag (surfaced in
    // details so an auto-update daemon knows it was armed), and broadcasts
    // host-disconnected — then the 400. All three host-face effects are
    // best-effort: the rejection itself must always answer.
    await bridgeProtocolReject(env, hostId, protocolVersion);
    const retryUpdate = await takeHostProtocolUpdateRetry(env, hostId);
    notifyHubHostDisconnected(env, hostId);
    return Response.json(
      // bb shape: 400 with the protocol_version_mismatch code in the envelope
      // (outside the frozen ApiErrorCode set — M0 scheme A keeps it raw).
      {
        code: "protocol_version_mismatch",
        message: "protocol version mismatch",
        details: {
          expected: DAEMON_PROTOCOL_VERSION,
          received: protocolVersion,
          retryUpdate,
          serverProtocolVersion: DAEMON_PROTOCOL_VERSION,
        },
        retryable: false,
      },
      { status: 400 },
    );
  }
  // bb internal/session.ts:90-98: the open-time upsert is the point where a
  // successful handshake clears the host's protocol rejection.
  await bridgeHostAttach(env, hostId, { hostName, clearRejected: true });
  return Response.json(
    {
      sessionId: result.sessionId,
      heartbeatIntervalMs: result.heartbeatIntervalMs,
      leaseTimeoutMs: result.leaseTimeoutMs,
    },
    { status: 201 },
  );
}

export interface DaemonAttachInfo {
  /** Daemon's self-reported machine name (bb session/open hostName). */
  hostName?: string | null;
  /** A successful session/open clears the host's protocol rejection
   * (bb internal/session.ts:96-98); enroll leaves it untouched. */
  clearRejected?: boolean;
}

/** #49: auxiliary registry write; best-effort by design — a failed write
 * only delays visibility until the next handshake step re-fires it. */
async function bridgeHostAttach(
  env: WorkerEnv,
  hostId: string,
  info?: DaemonAttachInfo,
): Promise<void> {
  if (env.onDaemonAttach === undefined) return;
  try {
    await env.onDaemonAttach(hostId, info);
  } catch (error) {
    console.error(`daemon attach bridge failed for host ${hostId}:`, error);
  }
}

/** #195 S3: mismatch stamps last_rejected_protocol_version — best-effort. */
async function bridgeProtocolReject(
  env: WorkerEnv,
  hostId: string,
  protocolVersion: number,
): Promise<void> {
  if (env.onDaemonProtocolReject === undefined) return;
  try {
    await env.onDaemonProtocolReject(hostId, protocolVersion);
  } catch (error) {
    console.error(`daemon protocol-reject bridge failed for host ${hostId}:`, error);
  }
}

/** Reads-and-clears the hub's retry-update flag (bb hub takeHostProtocolUpdateRetry,
 * hub.ts:855-860); absent hub degrades to false — the flag is advisory. */
async function takeHostProtocolUpdateRetry(env: WorkerEnv, hostId: string): Promise<boolean> {
  if (env.HUB === undefined) return false;
  try {
    const stub = env.HUB.get(env.HUB.idFromName("hub")) as DurableObjectStub & {
      takeHostProtocolUpdateRetry(args: { hostId: string }): Promise<{ retryUpdate: boolean }>;
    };
    return (await stub.takeHostProtocolUpdateRetry({ hostId })).retryUpdate;
  } catch (error) {
    console.error(`retry-update flag read failed for host ${hostId}:`, error);
    return false;
  }
}

/** Fire-and-forget host-disconnected on rejection (bb internal/session.ts:57). */
function notifyHubHostDisconnected(env: WorkerEnv, hostId: string): void {
  if (env.HUB === undefined) return;
  const stub = env.HUB.get(env.HUB.idFromName("hub")) as DurableObjectStub & {
    notifyHost(hostId: string, changes: string[]): Promise<{ delivered: number }>;
  };
  void stub.notifyHost(hostId, ["host-disconnected"]).catch((error: unknown) => {
    console.error(`rejection broadcast failed for host ${hostId}:`, error);
  });
}

async function handleWsAttach(request: Request, env: WorkerEnv): Promise<Response> {
  const url = new URL(request.url);
  const hostId = url.searchParams.get("hostId") ?? "";
  const sessionId = url.searchParams.get("sessionId") ?? "";
  if (hostId === "" || sessionId === "") {
    return errorResponse("validation_failed", "hostId and sessionId query params required");
  }
  const shield = negotiateGuard(env, hostId);
  if (shield !== null) return shield;
  // Forward the upgrade into the DO: the accepted socket must be owned by
  // the per-machine DO so hibernation, leases and the journal co-locate.
  // The DO validates the session synchronously in its fetch and rejects the
  // upgrade with 401 before any socket exists (bb's post-upgrade 1008 shape
  // degrades to a pre-upgrade 401 on this platform).
  try {
    return await stubForHost(env, hostId).fetch(request);
  } catch (error) {
    if (isOverloadClass(error)) {
      armNegativeCache(hostId, negativeCacheTtlMs(env));
      return rateLimitedResponse(
        negativeCacheTtlMs(env) / 1000,
        "durable object is overloaded; retry after the negative-cache window",
      );
    }
    throw error;
  }
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
    const body = parsed;
    const executionId = readString(body, "executionId");
    const threadId = readString(body, "threadId");
    // The bash tool shape carries the command inside `arguments` (the same
    // place the real agent DO's ToolDispatchRequest puts it).
    const arguments_ = (body.arguments as Record<string, unknown> | undefined) ?? {};
    const command =
      typeof arguments_.command === "string" ? arguments_.command : readString(body, "command");
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
      timeoutMs: typeof body.timeoutMs === "number" ? body.timeoutMs : 0,
    });
    return Response.json(outcome);
  }

  if (path === "/agent/kill" && request.method === "POST") {
    const parsed = await jsonBody(request);
    if (parsed === null) return errorResponse("bad_request", "invalid json body");
    const executionId = readString(parsed, "executionId");
    if (executionId === null) return errorResponse("validation_failed", "executionId required");
    await stub.kill(executionId);
    return Response.json({ ok: true });
  }

  if (path === "/agent/ack" && request.method === "POST") {
    const parsed = await jsonBody(request);
    if (parsed === null) return errorResponse("bad_request", "invalid json body");
    const body = parsed;
    const executionId = readString(body, "executionId");
    const resultSeq = body.resultSeq;
    if (executionId === null || typeof resultSeq !== "number") {
      return errorResponse("validation_failed", "executionId and numeric resultSeq required");
    }
    await stub.ackExecution(executionId, resultSeq);
    return Response.json({ ok: true });
  }

  if (path === "/agent/unacked") {
    const threadId = new URL(request.url).searchParams.get("threadId");
    if (threadId === null)
      return errorResponse("validation_failed", "threadId query param required");
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
    const sink = env.AGENT_DO.get(env.AGENT_DO.idFromName(threadId)) as DurableObjectStub &
      TestAgentSinkDO;
    return Response.json({ updates: await sink.updates() });
  }

  return errorResponse("not_found", `no agent route ${path}`);
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

function stubForHost(env: WorkerEnv, hostId: string): DurableObjectStub & DaemonServiceDO {
  const name = hostId === "" ? (env.DAEMON_MACHINE_ID ?? "poc-local") : hostId;
  return env.DAEMON_SERVICE.get(env.DAEMON_SERVICE.idFromName(name)) as DurableObjectStub &
    DaemonServiceDO;
}

/** Auth ladder (#36): env compare (staging single-host / L1 rig; zero edge
 * storage) → KV hash cache → exactly one DO authCheck fallback + backfill.
 * The DO mirror written at enroll is the authority; KV is a pure cache. */
async function authorize(
  request: Request,
  env: WorkerEnv,
): Promise<{ hostIdHint: string | null } | null> {
  const key = authKeyOf(request);
  if (key === null) return null;
  if (env.DAEMON_HOST_KEY !== "" && key === env.DAEMON_HOST_KEY) {
    return { hostIdHint: env.DAEMON_HOST_ID ?? "poc-local" };
  }
  const keyHash = await sha256Hex(key);
  const cachedHostId = await loadCachedAuth(env.DAEMON_EDGE_KV, keyHash);
  if (cachedHostId !== null) return { hostIdHint: cachedHostId };
  const stub = stubForHost(env, env.DAEMON_HOST_ID ?? env.DAEMON_MACHINE_ID ?? "poc-local");
  const verdict = await stub.authCheck({ keyHash });
  if (!verdict.ok) return null;
  await backfillAuthCache(env.DAEMON_EDGE_KV, keyHash, verdict.hostId ?? "");
  return { hostIdHint: verdict.hostId };
}

/** Negotiation edge gates (#36): negative-cache window, then token bucket. */
function negotiateGuard(env: WorkerEnv, hostId: string): Response | null {
  const remaining = negativeRemainingMs(hostId);
  if (remaining !== null) {
    return rateLimitedResponse(remaining / 1000, "host is in the DO negative-cache window");
  }
  const bucket = takeToken(env, hostId);
  if (!bucket.allowed) {
    return rateLimitedResponse(bucket.retryAfterS, "negotiation rate limit exceeded for host");
  }
  return null;
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
