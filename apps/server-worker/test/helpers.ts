import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { ensureMigrations } from "./migrate.js";

/** Base URL for SELF requests; any origin works inside the pool. */
export const BASE = "https://example.com";

export async function apiGet(path: string, init?: RequestInit): Promise<Response> {
  await ensureMigrations();
  return SELF.fetch(`${BASE}${path}`, {
    ...init,
    headers: { ...(init?.headers ?? {}) },
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
  input?: { type: "text"; text: string }[];
}): Promise<CreatedThread> {
  await ensureMigrations();
  const response = await SELF.fetch(`${BASE}/api/v1/threads`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      projectId: args?.projectId ?? "proj_personal",
      origin: "app",
      environment: { type: "host", workspace: { type: "personal" } },
      ...(args?.title !== undefined ? { title: args.title } : {}),
      ...(args?.sectionId !== undefined ? { sectionId: args.sectionId } : {}),
      // bb requires input ≥ 1 for user-originated creates (the SPA composer
      // always ships the first message with the create call).
      input: args?.input ?? [{ type: "text", text: "first message from L1 suite" }],
    }),
  });
  if (response.status !== 201) {
    throw new Error(`createThread failed: ${response.status} ${await response.text()}`);
  }
  const body = (await response.json()) as { id: string; projectId: string };
  return { id: body.id, projectId: body.projectId };
}

export async function send(threadId: string): Promise<void> {
  const response = await SELF.fetch(`${BASE}/api/v1/threads/${threadId}/send`, {
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
    throw new Error(`unsupported websocket path: ${path}`);
  }
  const stub = env.HUB.get(env.HUB.idFromName("hub"));
  const response = await stub.fetch("https://hub/ws", {
    headers: { upgrade: "websocket" },
  });
  if (response.status !== 101) {
    throw new Error(`websocket upgrade failed: ${response.status}`);
  }
  if (response.webSocket === null || response.webSocket === undefined) {
    throw new Error("upgrade produced no websocket");
  }
  const socket: WebSocket = response.webSocket;
  socket.accept();
  return socket;
}

/** Resolves with the next JSON frame, or null on close. */
export function nextFrame(socket: WebSocket): Promise<unknown | null> {
  const { promise, resolve } = Promise.withResolvers<unknown | null>();
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

export { env, SELF, ensureMigrations };
