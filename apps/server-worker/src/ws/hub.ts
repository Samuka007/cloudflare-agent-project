import { DurableObject } from "cloudflare:workers";
import { realtimeThreadDeltaSchema, type RealtimeThreadDelta } from "@cap/protocol";
import {
  changedMessageSchema,
  clientMessageSchema,
  realtimeSubscriptionTargetKey,
  type ThreadChangeMetadata,
} from "../contract/domain/change-kinds.js";

/**
 * NotificationHub → Durable Object port (bb apps/server/src/ws/hub.ts,
 * commit 8473d8c33). Owns: browser client sockets on /ws, subscription keys
 * (nine targets), `changed` fan-out, thread event waiters, and the daemon
 * disconnect grace window. Semantics preserved:
 * - no subscribe/unsubscribe ack frames and no greeting frame (bb
 *   client-protocol.ts:11-16);
 * - malformed frames close 1008 "invalid-message" (client-protocol.ts:30-41);
 * - a changed message with an id fans out to both the list key and the detail
 *   key (hub.ts subscriptionKeysForMessage:53-89), list key only without an
 *   id, "system" for system messages;
 * - transient thread-open / thread-pane-action / plugin-signal frames go to
 *   every connected client (hub.ts notifyThreadOpen/PaneAction/PluginSignal);
 * - outgoing changed frames are validated with the strict
 *   changedMessageSchema; invalid payloads are skipped, not crashed on
 *   (hub.ts:957-961 "Skipping invalid realtime broadcast").
 */
export class NotificationHubDO extends DurableObject {
  private threadEventWaiters: ThreadEventWaiter[] = [];
  private daemonDisconnects: DaemonDisconnect[] = [];

  // --- public /ws endpoint ---------------------------------------------------

  fetch(request: Request): Response {
    const upgrade = request.headers.get("upgrade");
    if (upgrade?.toLowerCase() !== "websocket") {
      return new Response("expected websocket upgrade", { status: 426 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    // bb onClientSocketOpen: register only — no greeting frame. Subscription
    // state rides the hibernation attachment; the runtime may hand
    // webSocketMessage a different socket object than this fetch saw, so
    // identity maps are not reliable here.
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ keys: [] as string[] });
    return new Response(null, { status: 101, webSocket: client });
  }

  /** Called by the runtime for accepted sockets (non-hibernating here). */
  webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
    } catch {
      ws.close(1008, "invalid-message");
      return;
    }
    const message = clientMessageSchema.safeParse(parsed);
    if (!message.success) {
      ws.close(1008, "invalid-message");
      return;
    }
    const keys = new Set<string>(readAttachment(ws).keys);
    const key = realtimeSubscriptionTargetKey(message.data.target);
    if (message.data.type === "subscribe") {
      keys.add(key);
    } else {
      keys.delete(key);
    }
    ws.serializeAttachment({ keys: [...keys] });
  }

  webSocketClose(_ws: WebSocket): void {
    // Event waiters are request-scoped in bb, not socket-scoped; closing a
    // browser socket only drops its subscriptions (attachment dies with it).
  }

  // --- fan-out (RPC surface used by the control plane) ------------------------

  notifyThread(
    threadId: string,
    changes: string[],
    metadata?: ThreadChangeMetadata,
  ): { delivered: number } {
    const message = {
      type: "changed" as const,
      entity: "thread" as const,
      id: threadId,
      changes,
      ...(metadata !== undefined ? { metadata } : {}),
    };
    const delivered = this.broadcastChanged(message);
    // bb notifyThread also resolves threadEventWaiters (hub.ts:714-735).
    this.resolveThreadWaiters(threadId);
    return { delivered };
  }

  /**
   * #197 D2 Tier-A: the agent-DO push RPC — one journal `model.delta` row per
   * call, fanned out as a `delta` payload frame (spec §6.1). Unlike `changed`
   * frames, a delta fans out to the `thread-detail:<id>` key ONLY: the thread
   * list never renders stream text. Strict schema validation, invalid frames
   * skipped not crashed on (broadcastChanged same posture); the call also
   * resolves this thread's event waiters so `events/wait` wakes on stream
   * progress (spec §5.2).
   */
  notifyThreadDelta(frame: RealtimeThreadDelta): { delivered: number } {
    const validated = realtimeThreadDeltaSchema.safeParse(frame);
    if (!validated.success) {
      console.error("Skipping invalid realtime delta broadcast");
      return { delivered: 0 };
    }
    const key = `thread-detail:${validated.data.id}`;
    const payload = JSON.stringify(validated.data);
    let delivered = 0;
    for (const socket of this.ctx.getWebSockets()) {
      if (!readAttachment(socket).keys.includes(key)) continue;
      try {
        socket.send(payload);
        delivered += 1;
      } catch {
        try {
          socket.close(1001, "server-shutdown");
        } catch {
          // already closed
        }
      }
    }
    this.resolveThreadWaiters(validated.data.id);
    return { delivered };
  }

  notifyProject(projectId: string, changes: string[]): { delivered: number } {
    return {
      delivered: this.broadcastChanged({
        type: "changed",
        entity: "project",
        id: projectId,
        changes,
      }),
    };
  }

  notifyEnvironment(environmentId: string, changes: string[]): { delivered: number } {
    return {
      delivered: this.broadcastChanged({
        type: "changed",
        entity: "environment",
        id: environmentId,
        changes,
      }),
    };
  }

  notifyHost(hostId: string, changes: string[]): { delivered: number } {
    return {
      delivered: this.broadcastChanged({
        type: "changed",
        entity: "host",
        id: hostId,
        changes,
      }),
    };
  }

  notifySystem(changes: string[]): { delivered: number } {
    return {
      delivered: this.broadcastChanged({
        type: "changed",
        entity: "system",
        changes,
      }),
    };
  }

  /** Transient, unpersisted frames → every registered client (bb hub.ts:741-808). */
  broadcastSignal(frame: Record<string, unknown>): { delivered: number } {
    const payload = JSON.stringify(frame);
    const sockets = this.ctx.getWebSockets();
    for (const socket of sockets) {
      try {
        socket.send(payload);
      } catch {
        // dead socket; hibernation runtime reaps it
      }
    }
    return { delivered: sockets.length };
  }

  // --- event waiters (bb hub.ts registerThreadEventWaiter + /events/wait) -----

  /**
   * Long-poll primitive behind GET /threads/:id/events/wait: blocks until a
   * thread notification arrives or the (≤60s) deadline passes. Mirrors bb's
   * waiter semantics (data.ts:536-549), collapsed into one RPC hop.
   */
  async waitThreadEvent(args: {
    threadId: string;
    waitMs: number;
  }): Promise<{ resolved: boolean }> {
    const waitMs = Math.max(0, Math.min(args.waitMs, 60_000));
    let release!: () => void;
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    const waiter: ThreadEventWaiter = { threadId: args.threadId, release };
    this.threadEventWaiters.push(waiter);
    const timer = setTimeout(() => {
      this.threadEventWaiters = this.threadEventWaiters.filter((candidate) => candidate !== waiter);
      release();
    }, waitMs);
    try {
      await promise;
      return {
        resolved: this.threadEventWaiters.every((candidate) => candidate !== waiter),
      };
    } finally {
      clearTimeout(timer);
      this.threadEventWaiters = this.threadEventWaiters.filter((candidate) => candidate !== waiter);
    }
  }

  private resolveThreadWaiters(threadId: string): void {
    const pending = this.threadEventWaiters.filter((waiter) => waiter.threadId === threadId);
    for (const waiter of pending) {
      waiter.release();
    }
  }

  // --- daemon disconnect grace (bb pendingDaemonDisconnects, hub.ts:166-173) --

  async markDaemonDisconnected(args: { hostId: string }): Promise<{ ok: true }> {
    this.daemonDisconnects = this.daemonDisconnects.filter((entry) => entry.hostId !== args.hostId);
    this.daemonDisconnects.push({
      hostId: args.hostId,
      atMs: Date.now(),
    });
    await this.ctx.storage.setAlarm(Date.now() + DAEMON_ACTIVE_WORK_DISCONNECT_GRACE_MS);
    return { ok: true };
  }

  markDaemonConnected(args: { hostId: string }): { ok: true } {
    this.daemonDisconnects = this.daemonDisconnects.filter((entry) => entry.hostId !== args.hostId);
    return { ok: true };
  }

  getDaemonDisconnectState(args: { hostId: string }): {
    inGrace: boolean;
    graceExpiresAt: number | null;
  } {
    const entry = this.daemonDisconnects.find((candidate) => candidate.hostId === args.hostId);
    if (!entry) {
      return { inGrace: false, graceExpiresAt: null };
    }
    const expiresAt = entry.atMs + DAEMON_ACTIVE_WORK_DISCONNECT_GRACE_MS;
    if (Date.now() >= expiresAt) {
      this.daemonDisconnects = this.daemonDisconnects.filter(
        (candidate) => candidate.hostId !== args.hostId,
      );
      return { inGrace: false, graceExpiresAt: null };
    }
    return { inGrace: true, graceExpiresAt: expiresAt };
  }

  alarm(): void {
    const now = Date.now();
    this.daemonDisconnects = this.daemonDisconnects.filter(
      (entry) => entry.atMs + DAEMON_ACTIVE_WORK_DISCONNECT_GRACE_MS > now,
    );
  }

  // --- internals ----------------------------------------------------------------

  /**
   * bb subscriptionKeysForMessage (hub.ts:53-89) + notifyClients (hub.ts:
   * 945-965): strict validation then targeted fan-out.
   */
  private broadcastChanged(message: Record<string, unknown>): number {
    const validated = changedMessageSchema.safeParse(message);
    if (!validated.success) {
      console.error("Skipping invalid realtime broadcast");
      return 0;
    }
    // bb subscriptionKeysForMessage (hub.ts:53-89): an id-bearing message
    // fans out to BOTH the detail key and the list key.
    const messageKeys = subscriptionKeysForMessage(validated.data);
    const payload = JSON.stringify(validated.data);
    let delivered = 0;
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = readAttachment(socket);
      if (!messageKeys.some((key) => attachment.keys.includes(key))) {
        continue;
      }
      try {
        socket.send(payload);
        delivered += 1;
      } catch {
        try {
          socket.close(1001, "server-shutdown");
        } catch {
          // already closed
        }
      }
    }
    return delivered;
  }
}

interface SocketAttachment {
  keys: string[];
}

function readAttachment(socket: WebSocket): SocketAttachment {
  const attachment = socket.deserializeAttachment() as SocketAttachment | null;
  return attachment ?? { keys: [] };
}

interface ThreadEventWaiter {
  threadId: string;
  release: () => void;
}

interface DaemonDisconnect {
  hostId: string;
  atMs: number;
}

/** bb resolveThreadRuntimeStateFromLatestSession grace window. */
export const DAEMON_ACTIVE_WORK_DISCONNECT_GRACE_MS = 5_000;

function subscriptionKeysForMessage(
  message:
    { entity: "thread" | "project" | "environment" | "host"; id?: string } | { entity: "system" },
): string[] {
  if (message.entity === "system") {
    return ["system"];
  }
  return message.id === undefined
    ? [`${message.entity}-list`]
    : [`${message.entity}-detail:${message.id}`, `${message.entity}-list`];
}
