import { AgentDO, AgentRpcError, type AgentDoBindings } from "./agent-do.js";
import { setAgentRuntime } from "./injection.js";
import { AnthropicRelayProvider } from "./relay/anthropic-provider.js";
import { CompletionsRelayProvider } from "./relay/completions-provider.js";
import { ResponsesRelayProvider } from "./relay/responses-provider.js";
import {
  deriveRelayReasoning,
  resolveRelayApi,
  resolveRelaySelection,
  RelaySelectionError,
  SYNTHETIC_RELAY_PROVIDER_ID,
  type ModelProvider,
  type RelaySelection,
} from "./index.js";
import { TestDaemonServiceDO } from "./testing/test-daemon-do.js";
import { RecordingHubDO } from "./testing/recording-hub.js";
import { envFlag } from "./config.js";
import { CLOUD_PLACEHOLDER_HOST_ID } from "@cap/protocol";
import {
  DaemonServiceDO,
  daemonServiceWorker,
  requireDaemonCredentials,
  type WorkerEnv,
} from "@cap/daemon-service";

/**
 * Wrangler mains. `AgentDO` must be exported from the deployed entry; the
 * fake `TestDaemonServiceDO` serves this package's own L1 rig, and the REAL
 * `DaemonServiceDO` (#30) is exported for the composed deployment — the
 * hookup rig binds it as `DAEMON_SERVICE`.
 */
export { AgentDO, TestDaemonServiceDO, DaemonServiceDO, RecordingHubDO };

/** Route prefixes served by the landed daemon-service worker (#30). */
const DAEMON_ROUTE_PREFIXES = ["/health", "/enroll", "/session/open", "/ws", "/agent/"];

/**
 * Relay env the composed POC rig needs (repo-root .dev.vars shape). #501: the
 * watchdog drill timings no longer ride an env var — the rig injects them
 * through the drive surface (`POST /drive/:threadId/watchdog` → the DO's KV
 * hot-patch seam).
 */
export interface PocDriveEnv {
  MODEL_RELAY_BASE_URL_ANTHROPIC?: string;
  /**
   * #361/#363: relay protocol face (anthropic-messages default |
   * openai-responses | openai-completions).
   */
  MODEL_RELAY_API?: string;
  MODEL_RELAY_API_KEY?: string;
  MODEL_RELAY_MODEL?: string;
  /** #308 usage-percentage denominator; unset = receipts carry no window. */
  MODEL_RELAY_CONTEXT_WINDOW?: string;
  /** A4 image-input capability declaration (1/true/on); unset = degrade. */
  MODEL_RELAY_IMAGE_INPUT?: string;
  /**
   * #377 optional explicit host pin for drive-created threads. Unset = the
   * cloud placeholder — the rig fabricates no machine.
   */
  DAEMON_MACHINE_ID?: string;
}

/** Register-once runtime seam: module state is shared with the DOs' isolate. */
let runtimeRegistered = false;

/**
 * The rig's single declared directory row (the reserved id "omp", thinking
 * disabled → the only runnable reasoning rung is "none"). Shared verbatim by
 * the runtime resolver and the drive-surface validation so the two can never
 * disagree on what a selection means. An in-code declaration, not a default:
 * the row exists only because the rig env named the model (ensureRuntime).
 */
function rigRelayDirectory(model: string) {
  const ladder = deriveRelayReasoning({ thinkingEnabled: false });
  return {
    rows: [
      {
        providerId: SYNTHETIC_RELAY_PROVIDER_ID,
        id: model,
        reasoningLevels: ladder.levels,
        defaultReasoningLevel: ladder.defaultLevel,
      },
    ],
    defaultProviderId: SYNTHETIC_RELAY_PROVIDER_ID,
    defaultModelId: model,
    thinkingEnabled: false,
  };
}

/** Registry validation for the drive surface (fail-closed 422 before dispatch). */
function validateDriveSelection(model: string, selection: RelaySelection): void {
  try {
    resolveRelaySelection(rigRelayDirectory(model), selection);
  } catch (error) {
    if (error instanceof RelaySelectionError) {
      throw new AgentRpcError("invalid", `${error.code}: ${error.message}`);
    }
    throw error;
  }
}

function ensureRuntime(env: PocDriveEnv): void {
  if (runtimeRegistered) return;
  const baseUrl = env.MODEL_RELAY_BASE_URL_ANTHROPIC;
  const apiKey = env.MODEL_RELAY_API_KEY;
  // #434: no model fallback — the rig runs exactly the model the deployment
  // declares. An unset MODEL_RELAY_MODEL is a named deployment error.
  const modelRaw = env.MODEL_RELAY_MODEL?.trim() ?? "";
  if (baseUrl === undefined || baseUrl === "" || apiKey === undefined || apiKey === "") {
    throw new Error(
      "MODEL_RELAY_BASE_URL_ANTHROPIC / MODEL_RELAY_API_KEY missing — the composed rig needs the relay env (repo-root .dev.vars) to drive turns",
    );
  }
  if (modelRaw === "") {
    throw new Error(
      "MODEL_RELAY_MODEL missing — the rig declares no default model; set the env to the relay model turns should run",
    );
  }
  const contextWindowParsed = Number.parseInt(env.MODEL_RELAY_CONTEXT_WINDOW ?? "", 10);
  const contextWindow =
    Number.isFinite(contextWindowParsed) && contextWindowParsed > 0 ? contextWindowParsed : null;
  const model = modelRaw;
  // #361: the rig dials the face the deployment declares — the responses
  // face rides the selection-default effort "none" (deterministic budget).
  const relayApi = resolveRelayApi(env.MODEL_RELAY_API);
  const provider: ModelProvider =
    relayApi === "openai-responses"
      ? new ResponsesRelayProvider({
          baseUrl,
          apiKey,
          model,
          maxTokens: 8192,
          ...(contextWindow !== null ? { contextWindow } : {}),
          reasoningEffort: "none",
          supportsImageInput: envFlag(env.MODEL_RELAY_IMAGE_INPUT),
          api: relayApi,
        })
      : relayApi === "openai-completions"
        ? new CompletionsRelayProvider({
            baseUrl,
            apiKey,
            model,
            maxTokens: 8192,
            ...(contextWindow !== null ? { contextWindow } : {}),
            // The rig's deterministic budget: no effort pin (the chat face
            // runs the model's default reasoning unless the row maps one).
            reasoningEffort: undefined,
            supportsImageInput: envFlag(env.MODEL_RELAY_IMAGE_INPUT),
            api: relayApi,
          })
        : new AnthropicRelayProvider({
            baseUrl,
            apiKey,
            model,
            maxTokens: 8192,
            ...(contextWindow !== null ? { contextWindow } : {}),
            thinking: { type: "disabled" },
            supportsImageInput: envFlag(env.MODEL_RELAY_IMAGE_INPUT),
            api: relayApi,
          });
  // #351: the single-line relay registration became a providerId-keyed
  // registry — the rig declares one "omp" row and every selection
  // resolves through the same fail-closed grammar the composed deployment
  // runs (dispatch never silently re-routes). The rig runs thinking
  // disabled, so the only runnable reasoning rung is "none".
  setAgentRuntime("*", {
    resolveExecutionProvider: (selection: RelaySelection): ModelProvider => {
      resolveRelaySelection(rigRelayDirectory(model), selection);
      return provider;
    },
  });
  runtimeRegistered = true;
}

/**
 * Dev-rig turn drive (#34 external mile): `POST /drive/:threadId`
 * {text, clientRequestId?} → createThread (idempotent) + sendMessage(start);
 * `GET /drive/:threadId/events?sinceSeq=` → raw event log;
 * `POST /drive/:threadId/watchdog` {patch} → the DO's KV hot-patch seam
 * (#501: the rig injects watchdog drill timings through the write face, not
 * env). Bearer-guarded by the POC host key so a deployed staging rig is not
 * an open relay front.
 */
async function handleDriveRoute(
  path: string,
  request: Request,
  env: AgentDoBindings & Partial<WorkerEnv> & PocDriveEnv,
): Promise<Response> {
  // #398/SEC-W5-002: no repo-public fallback — an unconfigured rig fails the
  // request instead of authenticating against a publicly known key.
  const hostKey = requireDaemonCredentials(env).hostKey;
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
    let selection: RelaySelection | undefined;
    if (typeof raw === "object" && raw !== null) {
      if ("text" in raw && typeof raw.text === "string") text = raw.text;
      if ("clientRequestId" in raw && typeof raw.clientRequestId === "string") {
        clientRequestId = raw.clientRequestId;
      }
      // #351: the drive surface exercises the selection seam verbatim —
      // unknown values fail closed here (422 named code), never dispatch.
      // #434: no model fallback — an unset MODEL_RELAY_MODEL fails the
      // request with the named deployment error instead of guessing glm-5.3.
      const modelRaw = env.MODEL_RELAY_MODEL?.trim() ?? "";
      if (modelRaw === "") {
        return Response.json(
          {
            code: "validation_failed",
            message:
              "MODEL_RELAY_MODEL missing — the rig declares no default model; set the env to the relay model turns should run",
          },
          { status: 422 },
        );
      }
      const model = modelRaw;
      const candidate: RelaySelection = {};
      if ("providerId" in raw && typeof raw.providerId === "string") {
        candidate.providerId = raw.providerId;
      }
      if ("model" in raw && typeof raw.model === "string") candidate.model = raw.model;
      if ("reasoningLevel" in raw && typeof raw.reasoningLevel === "string") {
        candidate.reasoningLevel = raw.reasoningLevel as RelaySelection["reasoningLevel"];
      }
      if (Object.keys(candidate).length > 0) {
        try {
          validateDriveSelection(model, candidate);
        } catch (error) {
          if (error instanceof AgentRpcError) {
            return Response.json(
              { code: "invalid", message: error.message },
              { status: DRIVE_ERROR_STATUS.invalid },
            );
          }
          throw error;
        }
        selection = candidate;
      }
      // #496: the DO never materializes a selection — a drive without an
      // explicit one pins the rig's single declared row here, at the rig
      // boundary (create-time journal; the same fail-closed validation
      // applies at dispatch).
      selection ??= { providerId: SYNTHETIC_RELAY_PROVIDER_ID, model };
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
      // #377: an explicit DAEMON_MACHINE_ID pin wins; absent = the cloud
      // placeholder (no fabricated machine).
      machineId: env.DAEMON_MACHINE_ID ?? CLOUD_PLACEHOLDER_HOST_ID,
      ...(selection !== undefined ? { execution: selection } : {}),
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
  // #501: the watchdog config 正本 is the DO's KV patch row — the rig injects
  // its drill timings through the existing write face (configureWatchdog),
  // never an env patch layer. Same bearer guard as the turn verbs above.
  if (request.method === "POST" && leaf === "watchdog") {
    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      return Response.json({ code: "bad_request", message: "invalid json body" }, { status: 400 });
    }
    if (typeof raw !== "object" || raw === null) {
      return Response.json(
        { code: "validation_failed", message: "watchdog patch object required" },
        { status: 422 },
      );
    }
    try {
      return Response.json(await stub.configureWatchdog(raw as Record<string, number | boolean>));
    } catch (error) {
      return Response.json(
        {
          code: "validation_failed",
          message: error instanceof Error ? error.message : String(error),
        },
        { status: 422 },
      );
    }
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
        // #398/SEC-W5-002: no repo-public fallback — the composition fails
        // closed when the deployment has no daemon secrets.
        const credentials = requireDaemonCredentials(env);
        const serviceEnv: WorkerEnv = {
          DAEMON_SERVICE: daemonService,
          AGENT_DO: agentDo,
          ENROLL_KEY: credentials.enrollKey,
          DAEMON_HOST_KEY: credentials.hostKey,
          DAEMON_EDGE_KV: env.DAEMON_EDGE_KV,
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
