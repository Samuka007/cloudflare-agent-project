import { AgentDO, AgentRpcError, type AgentDoBindings } from "./agent-do.js";
import { setAgentRuntime } from "./injection.js";
import { AnthropicRelayProvider } from "./relay/anthropic-provider.js";
import { TestDaemonServiceDO } from "./testing/test-daemon-do.js";
import { RecordingHubDO } from "./testing/recording-hub.js";
import { DaemonServiceDO, daemonServiceWorker, type WorkerEnv } from "@cap/daemon-service";

/**
 * Wrangler mains. `AgentDO` must be exported from the deployed entry; the
 * fake `TestDaemonServiceDO` serves this package's own L1 rig, and the REAL
 * `DaemonServiceDO` (#30) is exported for the composed deployment — the
 * hookup rig binds it as `DAEMON_SERVICE`.
 */
export { AgentDO, TestDaemonServiceDO, DaemonServiceDO, RecordingHubDO };

/** Route prefixes served by the landed daemon-service worker (#30). */
const DAEMON_ROUTE_PREFIXES = ["/health", "/enroll", "/session/open", "/ws", "/agent/"];

/** Relay + watchdog env the composed POC rig needs (repo-root .dev.vars shape). */
export interface PocDriveEnv {
  MODEL_RELAY_BASE_URL_ANTHROPIC?: string;
  MODEL_RELAY_API_KEY?: string;
  MODEL_RELAY_MODEL?: string;
}

/** Register-once runtime seam: module state is shared with the DOs' isolate. */
let runtimeRegistered = false;

function ensureRuntime(env: PocDriveEnv): void {
  if (runtimeRegistered) return;
  const baseUrl = env.MODEL_RELAY_BASE_URL_ANTHROPIC;
  const apiKey = env.MODEL_RELAY_API_KEY;
  if (baseUrl === undefined || baseUrl === "" || apiKey === undefined || apiKey === "") {
    throw new Error(
      "MODEL_RELAY_BASE_URL_ANTHROPIC / MODEL_RELAY_API_KEY missing — the composed rig needs the relay env (repo-root .dev.vars) to drive turns",
    );
  }
  setAgentRuntime("*", {
    provider: new AnthropicRelayProvider({
      baseUrl,
      apiKey,
      model: env.MODEL_RELAY_MODEL ?? "glm-5.3",
      maxTokens: 8192,
      thinking: { type: "disabled" },
    }),
  });
  runtimeRegistered = true;
}

/**
 * Dev-rig turn drive (#34 external mile): `POST /drive/:threadId`
 * {text, clientRequestId?} → createThread (idempotent) + sendMessage(start);
 * `GET /drive/:threadId/events?sinceSeq=` → raw event log. Bearer-guarded by
 * the POC host key so a deployed staging rig is not an open relay front.
 */
async function handleDriveRoute(
  path: string,
  request: Request,
  env: AgentDoBindings & Partial<WorkerEnv> & PocDriveEnv,
): Promise<Response> {
  const hostKey = env.DAEMON_HOST_KEY ?? "[REDACTED-staging-secret]";
  if (request.headers.get("authorization") !== `Bearer ${hostKey}`) {
    return Response.json(
      { code: "unauthorized", message: "bearer hostKey required" },
      { status: 401 },
    );
  }
  const [, , threadId, leaf] = path.split("/");
  if (threadId === undefined || threadId === "") {
    return Response.json(
      { code: "not_found", message: "use /drive/:threadId[/events]" },
      { status: 404 },
    );
  }
  // The composed rig always binds AGENT_DO; namespace.get() drops the class
  // RPC type, so the stub is retyped at this one boundary (rig-only surface).
  const agentDo = env.AGENT_DO;
  if (agentDo === undefined) {
    return Response.json(
      { code: "internal_error", message: "AGENT_DO binding missing" },
      { status: 500 },
    );
  }
  const stub = agentDo.get(agentDo.idFromName(threadId)) as DurableObjectStub<AgentDO>;
  if (request.method === "POST" && leaf === undefined) {
    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      return Response.json({ code: "bad_request", message: "invalid json body" }, { status: 400 });
    }
    let text: string | undefined;
    let clientRequestId: string | undefined;
    if (typeof raw === "object" && raw !== null) {
      if ("text" in raw && typeof raw.text === "string") text = raw.text;
      if ("clientRequestId" in raw && typeof raw.clientRequestId === "string") {
        clientRequestId = raw.clientRequestId;
      }
    }
    if (text === undefined || text === "") {
      return Response.json(
        { code: "validation_failed", message: "text required" },
        { status: 422 },
      );
    }
    ensureRuntime(env);
    await stub.createThread({
      threadId,
      title: text.slice(0, 60),
      machineId: env.DAEMON_MACHINE_ID ?? env.DAEMON_HOST_ID ?? "local",
    });
    const result = await stub.sendMessage({
      clientRequestId:
        clientRequestId !== undefined && clientRequestId !== ""
          ? clientRequestId
          : `drive_${crypto.randomUUID()}`,
      content: [{ type: "text", text }],
      mode: "start",
    });
    return Response.json(result);
  }
  if (request.method === "GET" && leaf === "events") {
    const sinceSeq = Number(new URL(request.url).searchParams.get("sinceSeq") ?? "0");
    return Response.json(
      await stub.getEvents({ sinceSeq: Number.isFinite(sinceSeq) ? sinceSeq : 0 }),
    );
  }
  return Response.json({ code: "not_found", message: `no drive route ${path}` }, { status: 404 });
}

/** AgentRpcError codes → HTTP status for the drive surface. */
const DRIVE_ERROR_STATUS: Record<string, number> = {
  not_found: 404,
  conflict: 409,
  invalid: 422,
  validation_failed: 422,
  wrong_thread: 422,
};

/**
 * Composed dev/integration worker: the agent DO seam plus the daemon-service
 * HTTP front (enroll → session/open → WS), which forwards into the
 * per-machine DaemonServiceDO. Production decomposition (agent worker vs
 * daemon worker) is the cutover ticket's shape; this composition is what the
 * full-chain hookup smoke runs against.
 */
export default {
  async fetch(request: Request, env: AgentDoBindings & Partial<WorkerEnv>): Promise<Response> {
    const path = new URL(request.url).pathname;
    try {
      if (path.startsWith("/drive/") || path === "/drive") {
        return await handleDriveRoute(path, request, env);
      }
      if (DAEMON_ROUTE_PREFIXES.some((prefix) => path === prefix || path.startsWith(prefix))) {
        const daemonService = env.DAEMON_SERVICE;
        const agentDo = env.AGENT_DO;
        if (daemonService === undefined || agentDo === undefined) {
          return Response.json(
            { code: "internal_error", message: "daemon bindings missing" },
            { status: 500 },
          );
        }
        const serviceEnv: WorkerEnv = {
          DAEMON_SERVICE: daemonService,
          AGENT_DO: agentDo,
          ENROLL_KEY: env.ENROLL_KEY ?? "[REDACTED-staging-secret]",
          DAEMON_HOST_KEY: env.DAEMON_HOST_KEY ?? "[REDACTED-staging-secret]",
          DAEMON_HOST_ID: env.DAEMON_HOST_ID,
          DAEMON_MACHINE_ID: env.DAEMON_MACHINE_ID,
          DAEMON_EDGE_KV: env.DAEMON_EDGE_KV,
          DAEMON_NEGATIVE_CACHE_MS: env.DAEMON_NEGATIVE_CACHE_MS,
          DAEMON_RATE_LIMIT_CAPACITY: env.DAEMON_RATE_LIMIT_CAPACITY,
          DAEMON_RATE_LIMIT_REFILL_PER_SEC: env.DAEMON_RATE_LIMIT_REFILL_PER_SEC,
        };
        return await daemonServiceWorker.fetch(request, serviceEnv);
      }
    } catch (error) {
      const code = error instanceof AgentRpcError ? error.code : "internal_error";
      return Response.json(
        { code, message: error instanceof Error ? error.message : String(error) },
        { status: DRIVE_ERROR_STATUS[code] ?? 500 },
      );
    }
    return new Response("agent-do: DO-only worker (bind AGENT_DO)", { status: 404 });
  },
} satisfies ExportedHandler<AgentDoBindings & Partial<WorkerEnv>>;
