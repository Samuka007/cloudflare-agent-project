import { env, exports } from "cloudflare:workers";
import type { DispatchOutcome } from "@cap/agent-do";
import { DAEMON_PROTOCOL_VERSION } from "../src/constants.js";
import type { DaemonServiceDO } from "../src/service-do.js";
import type { TestAgentSinkDO } from "../src/agent-sink.js";
import { serviceFrameSchema } from "../src/protocol.js";
import type {
  ExecSpawnServiceFrame,
  ExecOutputAckServiceFrame,
  KillListServiceFrame,
  ObservedExecution,
  ServiceFrame,
  ToolExecServiceFrame,
} from "../src/protocol.js";
import type { JournalOp } from "../src/journal.js";

/**
 * L1 rig (docs/research/testing-strategy-cloudflare-do.md §4.1): the service
 * WS server semantics run for real in workerd — the simulated daemon client
 * drives the actual upgrade path through `exports.default.fetch`, exactly the
 * official WebSocketServer fixture pattern. The real client PROCESS is not
 * testable here (no network ports in the pool); that half is the wrangler-dev
 * smoke (scripts/poc-smoke-service.ts).
 */

export interface HarnessEnv {
  DAEMON_SERVICE: DurableObjectNamespace;
  AGENT_DO: DurableObjectNamespace;
  /** Edge shield (#36): auth-hash cache binding (L1 rig provisions it locally). */
  DAEMON_EDGE_KV: KVNamespace;
  ENROLL_KEY: string;
  DAEMON_HOST_KEY: string;
  DAEMON_HOST_ID: string;
  DAEMON_MACHINE_ID: string;
}

export const testEnv = env as unknown as HarnessEnv;

/** The real worker front — auth + routing included. */
export async function workerFetch(request: Request): Promise<Response> {
  // exports.default is cloudflare:workers' handle on the worker's default
  // export (docs/research/testing-strategy-cloudflare-do.md §1.3 integration
  // entry; SELF is the deprecated cloudflare:test spelling).
  return exports.default.fetch(request);
}

export function uniqueHostId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().slice(0, 8)}`;
}

export function serviceStub(hostId: string): DurableObjectStub<DaemonServiceDO> {
  const ns = testEnv.DAEMON_SERVICE;
  return ns.get(ns.idFromName(hostId)) as DurableObjectStub<DaemonServiceDO>;
}

export function sinkStub(threadId: string): DurableObjectStub<TestAgentSinkDO> {
  const ns = testEnv.AGENT_DO;
  return ns.get(ns.idFromName(threadId)) as DurableObjectStub<TestAgentSinkDO>;
}

// ---------------------------------------------------------------------------
// Simulated daemon client.
// ---------------------------------------------------------------------------

export interface DialOptions {
  hostId: string;
  bootId?: string;
  hostKey?: string;
  protocolVersion?: number;
  observed?: ObservedExecution[];
  /** Skip the post-attach announce (I30 syncing-gate tests). */
  skipAnnounce?: boolean;
}

export class SimulatedClient {
  bootId: string;
  generation = 0;
  private socket: WebSocket | null = null;
  private sessionId: string | null = null;
  readonly inbound: ServiceFrame[] = [];
  /** Close frames observed on the current socket (code + reason). */
  readonly closeEvents: { code: number; reason: string }[] = [];
  /** Frames the client "would have missed" (closed socket) — for I27. */
  forgets: string[] = [];
  /** Simulated OS process table: executionId → {pid, pidStartedAt}. */
  readonly processes = new Map<string, { pid: number; pidStartedAt: number }>();
  /** Simulated output buffers: executionId → accumulated text. */
  readonly buffers = new Map<string, { text: string; sentThrough: number }>();
  private pidSeq = 4000;
  private closed = false;

  constructor(readonly hostId: string) {
    this.bootId = `boot_${crypto.randomUUID().slice(0, 8)}`;
  }

  /** bb §2.1 handshake: HTTP open → WS attach → (announce). */
  async dial(options: Partial<DialOptions> = {}): Promise<void> {
    const hostKey = options.hostKey ?? testEnv.DAEMON_HOST_KEY;
    if (options.bootId !== undefined) this.bootId = options.bootId;
    const openResponse = await workerFetch(
      new Request("https://daemon-service.test/session/open", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${hostKey}`,
        },
        body: JSON.stringify({
          hostId: options.hostId ?? this.hostId,
          protocolVersion: options.protocolVersion ?? DAEMON_PROTOCOL_VERSION,
          bootId: this.bootId,
        }),
      }),
    );
    if (openResponse.status !== 201) {
      throw new Error(`session/open failed: ${openResponse.status} ${await openResponse.text()}`);
    }
    const open = await openResponse.json<{ sessionId: string }>();
    this.sessionId = open.sessionId;

    const upgradeResponse = await workerFetch(
      new Request(
        `https://daemon-service.test/ws?hostId=${encodeURIComponent(this.hostId)}&sessionId=${encodeURIComponent(open.sessionId)}`,
        {
          headers: {
            Upgrade: "websocket",
            authorization: `Bearer ${hostKey}`,
          },
        },
      ),
    );
    const socket = upgradeResponse.webSocket;
    if (socket === null) {
      throw new Error(`upgrade failed: ${upgradeResponse.status}`);
    }
    this.closed = false;
    socket.addEventListener("message", (event) => {
      const frame = serviceFrameSchema.safeParse(JSON.parse(String(event.data)));
      if (frame.success) {
        this.inbound.push(frame.data);
        if (frame.data.type === "exec.forget") this.forgets.push(frame.data.executionId);
      }
    });
    socket.addEventListener("close", (event) => {
      const close = event;
      this.closeEvents.push({ code: close.code, reason: close.reason });
    });
    socket.accept();
    this.socket = socket;
    this.generation = 0;
    if (options.skipAnnounce !== true) {
      await this.announce(options.observed ?? []);
    }
  }

  /** Full-snapshot announce (§8.2); generation increments per session. */
  async announce(observed: ObservedExecution[]): Promise<void> {
    this.generation += 1;
    this.send({
      type: "boot.announce",
      bootId: this.bootId,
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      capabilities: {
        platform: "linux",
        sandboxRoot: "/tmp/poc-sandbox",
        protocolVersion: DAEMON_PROTOCOL_VERSION,
      },
      generation: this.generation,
      observed,
    });
    await this.waitFor((frame) => frame.type === "sync.complete" || frame.type === "error");
  }

  send(frame: Record<string, unknown>): void {
    if (this.socket === null || this.closed) throw new Error("client socket closed");
    this.socket.send(JSON.stringify(frame));
  }

  close(): Promise<void> {
    this.closed = true;
    this.socket?.close(1000, "client_bye");
    this.socket = null;
    return Promise.resolve();
  }

  /** The service's exec.spawn → simulated spawn + started ack. */
  async acknowledgeSpawn(executionId: string): Promise<{ pid: number; pidStartedAt: number }> {
    const spawn = await this.waitForSpawn(executionId);
    this.pidSeq += 1;
    const ack = { pid: this.pidSeq, pidStartedAt: this.pidSeq * 10 };
    this.processes.set(executionId, ack);
    const buffer = this.buffers.get(executionId) ?? { text: "", sentThrough: 0 };
    this.buffers.set(executionId, buffer);
    this.send({
      type: "exec.started",
      requestId: spawn.requestId,
      threadId: spawn.threadId,
      executionId,
      pid: ack.pid,
      pidStartedAt: ack.pidStartedAt,
    });
    return ack;
  }

  /** The service's tool.exec → simulated pid-less acceptance (T5'/T9). */
  async acknowledgeToolExec(executionId: string): Promise<ToolExecServiceFrame> {
    const frame = await this.waitForToolExec(executionId);
    this.send({
      type: "exec.spawn_ack",
      requestId: frame.requestId,
      threadId: frame.threadId,
      executionId,
      ok: true,
    });
    return frame;
  }

  async waitForToolExec(executionId?: string): Promise<ToolExecServiceFrame> {
    return this.waitFor(
      (candidate): candidate is ToolExecServiceFrame =>
        candidate.type === "tool.exec" &&
        (executionId === undefined || candidate.executionId === executionId),
    );
  }

  /**
   * The standard dispatch drill: the service's dispatch RPC does not settle
   * until the client acks, so callers must never await dispatch first — this
   * sequences spawn-wait → ack → dispatch settlement.
   */
  async acknowledgeSpawnFor(
    executionId: string,
    dispatch: Promise<unknown>,
  ): Promise<{ pid: number; pidStartedAt: number }> {
    const ack = await this.acknowledgeSpawn(executionId);
    await dispatch;
    return ack;
  }

  /** Tool-path twin of acknowledgeSpawnFor (T9: bash rides tool.exec). */
  async acknowledgeToolExecFor(
    executionId: string,
    dispatch: Promise<unknown>,
  ): Promise<ToolExecServiceFrame> {
    const frame = await this.acknowledgeToolExec(executionId);
    await dispatch;
    return frame;
  }

  async refuseSpawn(executionId: string, error: string): Promise<void> {
    const spawn = await this.waitForSpawn(executionId);
    this.send({
      type: "exec.spawn_ack",
      requestId: spawn.requestId,
      threadId: spawn.threadId,
      executionId,
      ok: false,
      error,
    });
  }

  async refuseToolExec(executionId: string, error: string): Promise<void> {
    const frame = await this.waitForToolExec(executionId);
    this.send({
      type: "exec.spawn_ack",
      requestId: frame.requestId,
      threadId: frame.threadId,
      executionId,
      ok: false,
      error,
    });
  }

  sendOutput(executionId: string, offset: number, text: string): void {
    const buffer = this.buffers.get(executionId) ?? { text: "", sentThrough: 0 };
    this.buffers.set(executionId, buffer);
    this.send({
      type: "exec.output",
      threadId: threadIdOf(executionId),
      executionId,
      offset,
      bytesBase64: btoa(text),
    });
  }

  sendExited(
    executionId: string,
    exitCode: number | null,
    finalOffset: number,
    reason?: "timeout",
  ): void {
    this.send({
      type: "exec.exited",
      threadId: threadIdOf(executionId),
      executionId,
      exitCode,
      signal: null,
      finalOffset,
      ...(reason !== undefined ? { reason } : {}),
    });
  }

  sendGap(executionId: string, from: number, to: number): void {
    this.send({
      type: "exec.output_gap",
      threadId: threadIdOf(executionId),
      executionId,
      from,
      to,
    });
  }

  async waitForSpawn(executionId: string): Promise<ExecSpawnServiceFrame> {
    const frame = await this.waitFor(
      (candidate): candidate is ExecSpawnServiceFrame =>
        candidate.type === "exec.spawn" && candidate.executionId === executionId,
    );
    return frame;
  }

  async waitForKillList(): Promise<KillListServiceFrame> {
    return this.waitFor(
      (candidate): candidate is KillListServiceFrame => candidate.type === "kill.list",
    );
  }

  /**
   * Waits for an ack STRICTLY beyond `afterOffset` — callers advancing a
   * frontier must pass the previous frontier or an old ack matches first.
   */
  async waitForOutput(executionId: string, afterOffset = -1): Promise<ExecOutputAckServiceFrame> {
    return this.waitFor(
      (candidate): candidate is ExecOutputAckServiceFrame =>
        candidate.type === "exec.output_ack" &&
        candidate.executionId === executionId &&
        candidate.ackedOffset > afterOffset,
    );
  }

  async waitForResume(
    executionId: string,
  ): Promise<Extract<ServiceFrame, { type: "exec.resume" }>> {
    return this.waitFor(
      (candidate): candidate is Extract<ServiceFrame, { type: "exec.resume" }> =>
        candidate.type === "exec.resume" && candidate.executionId === executionId,
    );
  }

  /** Polls the inbound queue until a matching frame shows up. */
  async waitFor<T extends ServiceFrame>(
    predicate: (frame: ServiceFrame) => frame is T,
    timeoutMs = 5000,
  ): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    let scanned = 0;
    while (Date.now() < deadline) {
      while (scanned < this.inbound.length) {
        const frame = this.inbound[scanned];
        scanned += 1;
        if (frame !== undefined && predicate(frame)) return frame;
      }
      await sleep(25);
    }
    throw new Error(
      `timeout waiting for frame (inbound: ${JSON.stringify(this.inbound.map((f) => f.type))})`,
    );
  }

  framesOfType<T extends ServiceFrame["type"]>(type: T): Extract<ServiceFrame, { type: T }>[] {
    return this.inbound.filter(
      (frame): frame is Extract<ServiceFrame, { type: T }> => frame.type === type,
    );
  }
}

// ---------------------------------------------------------------------------
// Agent-side seam driver (stands in for the agent DO's calls).
// ---------------------------------------------------------------------------

export interface DispatchArgs {
  threadId: string;
  executionId: string;
  command: string;
  machineId: string;
  timeoutMs?: number;
  cwd?: string;
  /** M1.5/T5': non-bash host tools ride the embedded-runtime path. */
  tool?: string;
  toolArguments?: Record<string, unknown>;
  /** #290 C1: frame workspace binding (absent = sandbox default). */
  workspace?: { id: string; path: string };
}

export async function dispatchViaSeam(
  hostId: string,
  args: DispatchArgs,
): Promise<DispatchOutcome> {
  return serviceStub(hostId).dispatch({
    threadId: args.threadId,
    turnId: `${args.threadId}-turn`,
    executionId: args.executionId,
    machineId: args.machineId,
    workspace: args.workspace,
    tool: args.tool ?? "bash",
    arguments: args.toolArguments ?? {
      command: args.command,
      ...(args.cwd !== undefined ? { cwd: args.cwd } : {}),
    },
    timeoutMs: args.timeoutMs ?? 600_000,
  });
}

// ---------------------------------------------------------------------------
// Journal assertions.
// ---------------------------------------------------------------------------

export async function journalOf(
  hostId: string,
  executionId?: string,
): Promise<(JournalOp & { opSeq: number })[]> {
  return serviceStub(hostId).journalOps(executionId);
}

export async function executionViewOf(hostId: string, executionId: string) {
  return serviceStub(hostId).executionView(executionId);
}

export function opsOfKind<T extends JournalOp["kind"]>(
  ops: (JournalOp & { opSeq: number })[],
  kind: T,
): (Extract<JournalOp, { kind: T }> & { opSeq: number })[] {
  return ops.filter(
    (op): op is Extract<JournalOp, { kind: T }> & { opSeq: number } => op.kind === kind,
  );
}

function threadIdOf(executionId: string): string {
  const sep = executionId.indexOf(":");
  return sep > 0 ? executionId.slice(0, sep) : executionId;
}

function sleep(ms: number): Promise<void> {
  // Real-clock pause by contract: the L1 rig drives workerd's own timers
  // (docs/research/testing-strategy-cloudflare-do.md) — there is no
  // injectable clock at this seam to fake.
  const { promise, resolve } = Promise.withResolvers<undefined>();
  setTimeout(resolve, ms);
  return promise;
}
