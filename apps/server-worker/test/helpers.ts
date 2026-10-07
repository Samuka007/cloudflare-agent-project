import { vi } from "vitest";
import { env, exports } from "cloudflare:workers";
import { encryptProviderSecret } from "@cap/provider-app";
import { ensureMigrations } from "./migrate.js";

/** Base URL for SELF requests; any origin works inside the pool. */
export const BASE = "https://example.com";

/**
 * #398/SEC-W5-002: the compat rig's daemon-face credentials — the values
 * vitest.config.ts injects as miniflare bindings. Test-only; deployments set
 * real secrets (`wrangler secret put`), and the repo-public POC literals
 * authenticate nothing anywhere.
 */
export const TEST_ENROLL_KEY = "l1-rig-enroll-key";
export const TEST_HOST_KEY = "l1-rig-host-key";

/**
 * #450 the L1 rig's configured-deployment state: a D1 provider_configs row
 * (the panel 正本 — the env seed is retired) plus a stubbed relay wire the
 * row dispatches through. Suites asserting the UNCONFIGURED faces remove the
 * row locally (removeRigProviderRow) and re-ensure it afterwards.
 */
export const RIG_PROVIDER_ID = "rig";
export const RIG_MODEL_ID = "rig-model";
export const RIG_RELAY_BASE_URL = "https://rig-relay.example.com";

/** The rig master key (vitest.config miniflare bindings) and wire credential. */
const RIG_MASTER_KEY = "l1-rig-master-key";
const RIG_WIRE_KEY = "l1-rig-relay-key";

/**
 * Seed (idempotent) the rig's provider row: id "rig", api anthropic-messages,
 * models [rig-model], and a stored credential the loader decrypts with the
 * rig master key. The row is what makes the rig a CONFIGURED deployment —
 * thread creates resolve the rig selection against it and turns dispatch
 * through the registry exactly like production.
 */
export async function ensureRigProviderRow(): Promise<void> {
  await ensureMigrations();
  const apiKeyEnc = await encryptProviderSecret(RIG_MASTER_KEY, RIG_WIRE_KEY);
  await env.DB.prepare(
    "INSERT OR IGNORE INTO provider_configs (id, display_name, base_url, api, service_tier, api_key_enc, models, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?)",
  )
    .bind(
      RIG_PROVIDER_ID,
      "L1 Rig Relay",
      RIG_RELAY_BASE_URL,
      "anthropic-messages",
      apiKeyEnc,
      JSON.stringify([{ id: RIG_MODEL_ID, reasoningLevels: ["none"], defaultReasoningLevel: "none" }]),
      Date.now(),
      Date.now(),
    )
    .run();
}

/** The unconfigured-state analog of the retired unsetRigRelayCatalog. */
export async function removeRigProviderRow(): Promise<void> {
  await ensureMigrations();
  await env.DB.prepare("DELETE FROM provider_configs WHERE id = ?").bind(RIG_PROVIDER_ID).run();
}

/**
 * The rig relay's wire answer: a minimal Anthropic Message SSE stream ("mock
 * reply" + a real receipt). The provider dials `${baseUrl}/v1/messages`.
 */
const RIG_SSE_BODY = [
  'event: message_start',
  'data: {"type":"message_start","message":{"id":"msg_rig","type":"message","role":"assistant","model":"rig-model","content":[],"stop_reason":null,"usage":{"input_tokens":24,"output_tokens":1}}}',
  "",
  "event: content_block_start",
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
  "",
  "event: content_block_delta",
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"mock reply"}}',
  "",
  "event: content_block_stop",
  'data: {"type":"content_block_stop","index":0}',
  "",
  "event: message_delta",
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":8}}',
  "",
  "event: message_stop",
  'data: {"type":"message_stop"}',
  "",
  "",
].join("\n");

/**
 * In-flight gate: while held, the rig wire's SSE answer waits — a
 * deterministic in-flight turn for the coarse-status race pins (the rigged
 * wire otherwise completes a turn faster than the create/send response
 * round-trips). Always `release()` in a finally — a leaked hold stalls every
 * later rig-wire turn in the shared worker.
 */
let rigWireHold: Promise<void> | null = null;

export function holdRigWire(): { release: () => void } {
  const { promise, resolve } = Promise.withResolvers<void>();
  rigWireHold = promise;
  return {
    release: () => {
      if (rigWireHold === promise) rigWireHold = null;
      resolve();
    },
  };
}

function serveRigWire(): Response {
  return new Response(RIG_SSE_BODY, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

/**
 * Install the forwarding outbound-fetch stub the rig row dispatches through
 * (idempotent — probe-face suites overwrite and unstub the global freely;
 * this re-arms whenever the active global is not the stub). Non-rig hosts
 * fall through to the original fetch, so every other suite behavior is
 * untouched. The rig row's dispatch is the ONLY traffic that ever reaches
 * the stub — a keyless panel row still fails closed before any wire call
 * (#434 point ⑦ posture stays asserted in system-provider-configs).
 */
export function ensureRigRelayWire(): void {
  type WireFetch = typeof fetch & { __rigWireStub?: boolean };
  const current = globalThis.fetch as WireFetch;
  if (current.__rigWireStub === true) return;
  const original = current.bind(globalThis);
  const stub = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const href = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
    if (href.startsWith(`${RIG_RELAY_BASE_URL}/`)) {
      const hold = rigWireHold;
      if (hold !== null) return hold.then(serveRigWire);
      return serveRigWire();
    }
    return original(url as string, init);
  };
  Object.assign(stub, { __rigWireStub: true });
  vi.stubGlobal("fetch", stub);
}

/** The full rig readiness: provider row present + relay wire armed. */
export async function ensureRigReady(): Promise<void> {
  await ensureRigProviderRow();
  ensureRigRelayWire();
}

export async function apiGet(path: string, init?: RequestInit): Promise<Response> {
  await ensureMigrations();
  return exports.default.fetch(`${BASE}${path}`, {
    ...init,
    headers: init?.headers ?? {},
  });
}

export interface CreatedThread {
  id: string;
  projectId: string;
}

export async function createThread(args?: {
  projectId?: string;
  title?: string;
  sectionId?: string;
  providerId?: string;
  model?: string;
  input?: { type: "text"; text: string }[];
}): Promise<CreatedThread> {
  await ensureRigReady();
  const response = await exports.default.fetch(`${BASE}/api/v1/threads`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      projectId: args?.projectId ?? "proj_personal",
      origin: "app",
      environment: { type: "host", workspace: { type: "personal" } },
      // #450: every create carries an explicit selection (fail-closed
      // validation has no default fill) — the rig selection dispatches the
      // rig row through the stubbed relay wire.
      providerId: args?.providerId ?? RIG_PROVIDER_ID,
      model: args?.model ?? RIG_MODEL_ID,
      ...(args?.title !== undefined ? { title: args.title } : {}),
      ...(args?.sectionId !== undefined ? { sectionId: args.sectionId } : {}),
      // #61: input ships the SPA composer's first message with the create
      // call and the route dispatches turn 1 from it. Omitted input falls to
      // the programmatic no-input shape (bb no-input-no-turn guard,
      // thread-provisioning.ts:221-224 — originKind null would 422 on empty
      // input), which starts no turn: the historical create+send two-step
      // smoke pattern.
      ...(args?.input !== undefined ? { input: args.input } : { input: [], originKind: "fork" }),
    }),
  });
  if (response.status !== 201) {
    throw new Error(`createThread failed: ${response.status} ${await response.text()}`);
  }
  const body = await response.json<{ id: string; projectId: string }>();
  return { id: body.id, projectId: body.projectId };
}

export async function send(threadId: string): Promise<void> {
  await ensureRigReady();
  const response = await exports.default.fetch(`${BASE}/api/v1/threads/${threadId}/send`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      input: [{ type: "text", text: "hello from the L1 suite" }],
      mode: "auto",
    }),
  });
  if (response.status !== 200) {
    throw new Error(`send failed: ${response.status} ${await response.text()}`);
  }
}

export async function openWebSocket(path: string): Promise<WebSocket> {
  await ensureMigrations();
  // Direct namespace fetch: the vitest pool's SELF WebSocket transport does
  // not deliver server→client frames reliably; talking to the hub DO through
  // its namespace exercises the identical DO fetch() handler.
  if (path !== "/ws") {
    throw new Error("unsupported websocket path");
  }
  const stub = env.HUB.get(env.HUB.idFromName("hub"));
  const response = await stub.fetch("https://hub/ws", {
    headers: { upgrade: "websocket" },
  });
  if (response.status !== 101) {
    throw new Error("websocket upgrade failed");
  }
  if (response.webSocket === null) {
    throw new Error("upgrade produced no websocket");
  }
  const socket: WebSocket = response.webSocket;
  socket.accept();
  return socket;
}

/** Resolves with the next JSON frame, or null on close. */
export function nextFrame(socket: WebSocket): Promise<unknown> {
  const { promise, resolve } = Promise.withResolvers<unknown>();
  const onMessage = (event: MessageEvent): void => {
    cleanup();
    resolve(JSON.parse(String(event.data)));
  };
  const onClose = (): void => {
    cleanup();
    resolve(null);
  };
  const cleanup = (): void => {
    socket.removeEventListener("message", onMessage);
    socket.removeEventListener("close", onClose);
  };
  socket.addEventListener("message", onMessage);
  socket.addEventListener("close", onClose);
  return promise;
}

export { env, ensureMigrations };
