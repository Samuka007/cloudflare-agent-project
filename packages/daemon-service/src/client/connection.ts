import { randomUUID } from "node:crypto";
import {
  DAEMON_PROTOCOL_VERSION,
  HEARTBEAT_INTERVAL_MS,
  KILL_ESCALATION_MS,
  RECONNECT_BACKOFF_MAX_MS,
  RECONNECT_BACKOFF_MIN_MS,
  RECONNECT_STABLE_RESET_MS,
  WS_BACKPRESSURE_HIGH_WATER_BYTES,
} from "../constants.js";
import { serviceFrameSchema, type ObservedExecution, type ServiceFrame } from "../protocol.js";
import type { ClientConfig, ClientIdentity } from "./identity.js";
import { log } from "./identity.js";
import { Executor, scanMarkerProcesses } from "./executor.js";
import { ExecutionBuffer } from "./buffers.js";

/**
 * Client connection lifecycle (§8.2/§8.5): open → attach → announce → serve;
 * heartbeat per the server-declared interval; reconnect with bb backoff
 * (1s→30s ×2, stable >10s resets); every reconnect is a full boot.announce —
 * the service DO's judgment tree does the rest. Disconnect NEVER kills
 * running work (§3.4): execution continues into the buffers.
 */

const CLIENT_COMMAND_QUEUE_LIMIT = 256;
const WS_ATTACH_TIMEOUT_MS = 10_000;

interface ClientRuntime {
  bootId: string;
  executor: Executor;
  readonly buffers: Map<string, ExecutionBuffer>;
  /** announce generation, per session, from 1 (§8.2). */
  generation: number;
  heartbeatTimer: NodeJS.Timeout | null;
  backoffMs: number;
  connectedAt: number;
  /** Command queue bound (§8.3): serial per-client processing. */
  readonly queue: Array<() => Promise<void>>;
  queueBusy: boolean;
}

export async function runClient(config: ClientConfig, identity: ClientIdentity): Promise<void> {
  const runtime: ClientRuntime = {
    bootId: randomUUID(),
    executor: new Executor(config.sandboxRoot),
    buffers: new Map(),
    generation: 0,
    heartbeatTimer: null,
    backoffMs: RECONNECT_BACKOFF_MIN_MS,
    connectedAt: 0,
    queue: [],
    queueBusy: false,
  };
  log(`boot ${runtime.bootId} sandbox=${config.sandboxRoot} dataDir=${config.dataDir}`);
  while (true) {
    try {
      await establishSession(config, identity, runtime);
      runtime.backoffMs = RECONNECT_BACKOFF_MIN_MS;
      await sessionLifetime(runtime);
    } catch (error) {
      log(`session lost: ${errorText(error)} — reconnecting in ${runtime.backoffMs}ms`);
    }
    teardownSession(runtime);
    const stable = Date.now() - runtime.connectedAt > RECONNECT_STABLE_RESET_MS;
    if (stable) runtime.backoffMs = RECONNECT_BACKOFF_MIN_MS;
    await sleep(runtime.backoffMs);
    runtime.backoffMs = Math.min(runtime.backoffMs * 2, RECONNECT_BACKOFF_MAX_MS);
  }
}

// ---------------------------------------------------------------------------
// Session establishment (bb §2.1 handshake, client side).
// ---------------------------------------------------------------------------

async function establishSession(
  config: ClientConfig,
  identity: ClientIdentity,
  runtime: ClientRuntime,
): Promise<WebSocket> {
  const openResponse = await fetch(`${config.baseUrl}/session/open`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${identity.hostKey}`,
    },
    body: JSON.stringify({
      hostId: identity.hostId,
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      bootId: runtime.bootId,
    }),
  });
  if (openResponse.status !== 201) {
    throw new Error(`session/open failed: HTTP ${openResponse.status} ${await openResponse.text()}`);
  }
  const open = (await openResponse.json()) as {
    sessionId: string;
    heartbeatIntervalMs: number;
    leaseTimeoutMs: number;
  };
  log(`session ${open.sessionId} opened (heartbeat ${open.heartbeatIntervalMs}ms)`);

  const wsUrl = `${config.baseUrl.replace(/^http/, "ws")}/ws?hostId=${encodeURIComponent(identity.hostId)}&sessionId=${encodeURIComponent(open.sessionId)}`;
  // Bun extends the WHATWG constructor with per-socket headers (bb Bearer
  // auth shape); DOM types only know the protocols overload.
  const BUN_WS_HEADERS = {
    headers: { authorization: `Bearer ${identity.hostKey}` },
  } as unknown as string[];
  const socket = new WebSocket(wsUrl, BUN_WS_HEADERS);

  const attach = Promise.withResolvers<void>();
  const failTimer = setTimeout(() => attach.reject(new Error("ws attach timeout")), WS_ATTACH_TIMEOUT_MS);
  socket.addEventListener("open", () => {
    clearTimeout(failTimer);
    runtime.generation = 0;
    runtime.connectedAt = Date.now();
    attach.resolve();
  });
  socket.addEventListener("error", () => {
    clearTimeout(failTimer);
    attach.reject(new Error("ws attach error"));
  });
  await attach.promise;

  socket.addEventListener("message", (event) => {
    void handleServiceFrame(runtime, config, socket, String(event.data));
  });
  socket.addEventListener("close", () => {
    log("ws closed");
  });

  // First frame after attach: the full boot announce (§8.2) — it resets the
  // service's observed view and drives its judgment tree.
  runtime.generation += 1;
  socket.send(
    JSON.stringify({
      type: "boot.announce",
      bootId: runtime.bootId,
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      capabilities: {
        platform: process.platform,
        sandboxRoot: config.sandboxRoot,
        protocolVersion: DAEMON_PROTOCOL_VERSION,
      },
      generation: runtime.generation,
      observed: observedSnapshot(runtime),
    } satisfies Record<string, unknown>),
  );

  runtime.heartbeatTimer = setInterval(
    () => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify({ type: "heartbeat" }));
    },
    open.heartbeatIntervalMs > 0 ? open.heartbeatIntervalMs : HEARTBEAT_INTERVAL_MS,
  );

  // Coalesced output uplink; backpressure-aware whole-frame flushes (I29).
  const flushTimer = setInterval(() => flushBuffers(runtime, socket), 100);
  flushTimer.unref();
  return socket;
}

async function sessionLifetime(runtime: ClientRuntime): Promise<void> {
  while (runtime.heartbeatTimer !== null) {
    await sleep(1_000);
  }
}

// ---------------------------------------------------------------------------
// Service frames in.
// ---------------------------------------------------------------------------

async function handleServiceFrame(
  runtime: ClientRuntime,
  config: ClientConfig,
  socket: WebSocket,
  raw: string,
): Promise<void> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return;
  }
  const frame = serviceFrameSchema.safeParse(parsed);
  if (!frame.success) {
    log("unrecognized service frame dropped");
    return;
  }
  // Serial command processing (§8.3 envLane discipline); bounded queue with
  // an explicit busy error — never silent drops, never a crashed socket.
  if (runtime.queue.length >= CLIENT_COMMAND_QUEUE_LIMIT) {
    socket.send(JSON.stringify({ type: "error", code: "busy", message: "client command queue full" }));
    return;
  }
  runtime.queue.push(() => dispatchFrame(runtime, config, socket, frame.data));
  if (runtime.queueBusy) return;
  runtime.queueBusy = true;
  while (runtime.queue.length > 0) {
    const task = runtime.queue.shift();
    if (task !== undefined) await task();
  }
  runtime.queueBusy = false;
}

async function dispatchFrame(
  runtime: ClientRuntime,
  config: ClientConfig,
  socket: WebSocket,
  frame: ServiceFrame,
): Promise<void> {
  switch (frame.type) {
    case "session.ready":
      log(`session.ready ${frame.sessionId}`);
      return;
    case "sync.complete":
      log(`sync.complete generation=${frame.generation}`);
      return;
    case "exec.spawn": {
      const buffer = new ExecutionBuffer();
      runtime.buffers.set(frame.executionId, buffer);
      try {
        const entry = runtime.executor.spawn(frame.executionId, frame.command, frame.cwd, (text) => {
          buffer.append(text);
        });
        socket.send(
          JSON.stringify({
            type: "exec.started",
            requestId: frame.requestId,
            threadId: frame.threadId,
            executionId: frame.executionId,
            pid: entry.pid,
            pidStartedAt: entry.pidStartedAt,
          } satisfies Record<string, unknown>),
        );
        log(`exec ${frame.executionId} spawned pid=${entry.pid} cmd=${frame.command}`);
        watchProcess(runtime, socket, frame.executionId, frame.timeoutMs);
      } catch (error) {
        log(`exec ${frame.executionId} refused: ${errorText(error)}`);
        socket.send(
          JSON.stringify({
            type: "exec.spawn_ack",
            requestId: frame.requestId,
            threadId: frame.threadId,
            executionId: frame.executionId,
            ok: false,
            error: errorText(error),
          } satisfies Record<string, unknown>),
        );
      }
      return;
    }
    case "exec.resume":
      resumeExecution(runtime, socket, frame.executionId, frame.ackedOffset);
      return;
    case "exec.kill":
      // Business cancel (§2.4): kill the group; the exit frame is the answer.
      runtime.executor.killProcessGroup(frame.executionId, KILL_ESCALATION_MS);
      return;
    case "kill.list": {
      let verifiedKills = 0;
      for (const entry of frame.entries) {
        const verified = runtime.executor.verifyAndKill(entry.executionId, entry.pid, entry.pidStartedAt);
        if (verified) verifiedKills += 1;
        runtime.buffers.delete(entry.executionId);
        socket.send(
          JSON.stringify({
            type: "exec.killed_ack",
            requestId: frame.requestId,
            threadId: entry.threadId,
            executionId: entry.executionId,
            verified,
          } satisfies Record<string, unknown>),
        );
      }
      log(`kill.list: ${verifiedKills}/${frame.entries.length} verified kills`);
      return;
    }
    case "exec.output_ack": {
      const buffer = runtime.buffers.get(frame.executionId);
      buffer?.trimTo(frame.ackedOffset);
      return;
    }
    case "exec.forget":
      // I27: the buffer drops only here.
      runtime.buffers.delete(frame.executionId);
      runtime.executor.forget(frame.executionId);
      log(`forget ${frame.executionId}: buffer + table entry dropped`);
      return;
    case "error":
      log(`service error frame: ${frame.code} ${frame.message}`);
      return;
  }
}

/** Client-local timeout backup (§5.1): self-kill when the service cannot. */
function watchProcess(runtime: ClientRuntime, socket: WebSocket, executionId: string, timeoutMs: number): void {
  const buffer = runtime.buffers.get(executionId);
  const entry = runtime.executor.get(executionId);
  if (buffer === undefined || entry === undefined) return;
  const timeoutTimer = setTimeout(() => {
    if (runtime.executor.get(executionId) === undefined) return;
    log(`exec ${executionId}: client-local timeout — killing process group`);
    runtime.executor.killProcessGroup(executionId, KILL_ESCALATION_MS);
    buffer.exited = { exitCode: null, signal: "SIGKILL", finalOffset: buffer.end };
    if (socket.readyState === socket.OPEN) {
      flushBuffers(runtime, socket); // output bytes precede the exit on the wire
      socket.send(
        JSON.stringify({
          type: "exec.exited",
          threadId: threadIdOf(executionId),
          executionId,
          exitCode: null,
          signal: "SIGKILL",
          finalOffset: buffer.end,
          reason: "timeout",
        } satisfies Record<string, unknown>),
      );
    }
  }, Math.max(timeoutMs, 1));
  timeoutTimer.unref();
  entry.child.once("exit", (code, signal) => {
    clearTimeout(timeoutTimer);
    buffer.exited = { exitCode: code ?? null, signal: signal ?? null, finalOffset: buffer.end };
    if (socket.readyState === socket.OPEN) {
      flushBuffers(runtime, socket); // output bytes precede the exit on the wire
      socket.send(
        JSON.stringify({
          type: "exec.exited",
          threadId: threadIdOf(executionId),
          executionId,
          exitCode: code ?? null,
          signal: signal ?? null,
          finalOffset: buffer.end,
        } satisfies Record<string, unknown>),
      );
    }
  });
}

/** §8.3 resume: explicit gap when the ack point predates the ring base. */
function resumeExecution(runtime: ClientRuntime, socket: WebSocket, executionId: string, ackedOffset: number): void {
  const buffer = runtime.buffers.get(executionId);
  if (buffer === undefined) return;
  if (ackedOffset < buffer.bufferedFrom) {
    socket.send(
      JSON.stringify({
        type: "exec.output_gap",
        threadId: threadIdOf(executionId),
        executionId,
        from: ackedOffset,
        to: buffer.bufferedFrom,
      } satisfies Record<string, unknown>),
    );
  }
  const resumeFrom = Math.max(ackedOffset, buffer.bufferedFrom);
  for (const frame of buffer.sliceFrames(resumeFrom)) {
    socket.send(
      JSON.stringify({
        type: "exec.output",
        threadId: threadIdOf(executionId),
        executionId,
        offset: frame.offset,
        bytesBase64: frame.base64,
      } satisfies Record<string, unknown>),
    );
    buffer.markSent(frame.byteLength);
  }
  const exited = buffer.exited;
  if (exited !== null && buffer.sent >= buffer.end) {
    socket.send(
      JSON.stringify({
        type: "exec.exited",
        threadId: threadIdOf(executionId),
        executionId,
        exitCode: exited.exitCode,
        signal: exited.signal,
        finalOffset: exited.finalOffset,
      } satisfies Record<string, unknown>),
    );
  }
}

/** Backpressure-aware uplink flush (I29): whole frames only, pause above HW. */
function flushBuffers(runtime: ClientRuntime, socket: WebSocket): void {
  if (socket.readyState !== socket.OPEN) return;
  if (socket.bufferedAmount > WS_BACKPRESSURE_HIGH_WATER_BYTES) return;
  for (const [executionId, buffer] of runtime.buffers) {
    for (const frame of buffer.sliceFrames(buffer.sent)) {
      socket.send(
        JSON.stringify({
          type: "exec.output",
          threadId: threadIdOf(executionId),
          executionId,
          offset: frame.offset,
          bytesBase64: frame.base64,
        } satisfies Record<string, unknown>),
      );
      buffer.markSent(frame.byteLength);
    }
  }
}

/** Full observed snapshot for announce (§8.2): table ∪ /proc scan ∪ buffers. */
function observedSnapshot(runtime: ClientRuntime): ObservedExecution[] {
  const observed = new Map<string, ObservedExecution>();
  for (const entry of runtime.executor.entries()) {
    observed.set(entry.executionId, {
      executionId: entry.executionId,
      threadId: threadIdOf(entry.executionId),
      pid: entry.pid,
      pidStartedAt: entry.pidStartedAt,
      state: "running",
      bufferedFromOffset: runtime.buffers.get(entry.executionId)?.bufferedFrom ?? 0,
    });
  }
  for (const [executionId, buffer] of runtime.buffers) {
    const existing = observed.get(executionId);
    const exited = buffer.exited;
    if (existing !== undefined) {
      existing.bufferedFromOffset = buffer.bufferedFrom;
      continue;
    }
    if (exited === null) continue;
    // Ended entry: the buffer still holds tail bytes + closure — the §8.2
    // disconnect-window result backfill channel.
    observed.set(executionId, {
      executionId,
      threadId: threadIdOf(executionId),
      pid: 0,
      pidStartedAt: 0,
      state: "ended",
      bufferedFromOffset: buffer.bufferedFrom,
      finalOffset: exited.finalOffset,
      exitCode: exited.exitCode,
    });
  }
  // Post-restart the in-memory process table is empty; /proc marker scan
  // rebuilds the view enough for the service's verify-and-kill (§8.2).
  for (const marker of scanMarkerProcesses()) {
    if (observed.has(marker.executionId)) continue;
    observed.set(marker.executionId, {
      executionId: marker.executionId,
      threadId: threadIdOf(marker.executionId),
      pid: marker.pid,
      pidStartedAt: marker.pidStartedAt,
      state: "running",
      bufferedFromOffset: Number.MAX_SAFE_INTEGER,
    });
  }
  return [...observed.values()];
}

function teardownSession(runtime: ClientRuntime): void {
  if (runtime.heartbeatTimer !== null) {
    clearInterval(runtime.heartbeatTimer);
    runtime.heartbeatTimer = null;
  }
}

function threadIdOf(executionId: string): string {
  const sep = executionId.indexOf(":");
  return sep > 0 ? executionId.slice(0, sep) : executionId;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}
