import { expect, test } from "vitest";
import { env, exports } from "cloudflare:workers";
import {
  DAEMON_PROTOCOL_VERSION,
  serviceFrameSchema,
  type ExecSpawnServiceFrame,
  type ServiceFrame,
} from "@cap/daemon-service";
import { AnthropicRelayProvider } from "../src/relay/anthropic-provider.js";
import { anthropicRequestBody } from "../src/relay/wire.js";
import { modelRequestFromEvents } from "../src/translate.js";
import { createRig, typeList, type Rig } from "./helpers.js";
import type { AgentEventRecord } from "../src/fsm-events.js";
import type { MockTurn } from "../src/testing/mock-provider.js";
import type { AnyAgentEvent } from "../src/fsm-events.js";

/**
 * Full-chain hookup smoke (#34): real AgentDO ↔ REAL per-machine
 * DaemonServiceDO (#30) under the production binding shape — dispatch lands
 * on the service DO named by the thread's machineId, the daemon client
 * speaks the real WS protocol through the composed worker front, and results
 * return via forwardToAgent → AgentDO.onExecutionUpdate. The real-RELAY
 * variant (env-gated) adds live glm-5.3 on top; the mock variant proves the
 * transport deterministically.
 */

// #398/SEC-W5-002: no in-repo credential literal — the hookup rig injects
// the daemon-face secret as a test binding (vitest.hookup.config.ts).
const rigEnv = env as unknown as { DAEMON_HOST_KEY: string };
const HOST_KEY = rigEnv.DAEMON_HOST_KEY;

/** Protocol-real simulated daemon client (drives the composed worker front). */
class HookupClient {
  private socket: WebSocket | null = null;
  readonly inbound: ServiceFrame[] = [];

  constructor(
    readonly hostId: string,
    private readonly bootId = `boot_${crypto.randomUUID().slice(0, 8)}`,
  ) {}

  async dial(): Promise<void> {
    const open = await exports.default.fetch("https://hookup.test/session/open", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${HOST_KEY}` },
      body: JSON.stringify({
        hostId: this.hostId,
        protocolVersion: DAEMON_PROTOCOL_VERSION,
        bootId: this.bootId,
      }),
    });
    expect(open.status).toBe(201);
    const session = await open.json<{ sessionId: string }>();

    const upgrade = await exports.default.fetch(
      `https://hookup.test/ws?hostId=${encodeURIComponent(this.hostId)}&sessionId=${encodeURIComponent(session.sessionId)}`,
      { headers: { Upgrade: "websocket", authorization: `Bearer ${HOST_KEY}` } },
    );
    const socket = upgrade.webSocket;
    if (socket === null) throw new Error(`ws upgrade failed: ${upgrade.status}`);
    socket.addEventListener("message", (event) => {
      const frame = serviceFrameSchema.safeParse(JSON.parse(String(event.data)));
      if (frame.success) this.inbound.push(frame.data);
    });
    socket.accept();
    this.socket = socket;

    socket.send(
      JSON.stringify({
        type: "boot.announce",
        bootId: this.bootId,
        protocolVersion: DAEMON_PROTOCOL_VERSION,
        capabilities: {
          platform: "linux",
          sandboxRoot: "/tmp/poc-sandbox",
          protocolVersion: DAEMON_PROTOCOL_VERSION,
        },
        generation: 1,
        observed: [],
      }),
    );
    await this.waitFor((frame) => frame.type === "sync.complete" || frame.type === "error");
  }

  waitFor<Wanted extends ServiceFrame>(
    predicate: (frame: ServiceFrame) => frame is Wanted,
  ): Promise<Wanted> {
    const existing = this.inbound.find(predicate);
    if (existing !== undefined) return Promise.resolve(existing);
    const socket = this.socket;
    if (socket === null) throw new Error("client not dialed");
    const { promise, resolve } = Promise.withResolvers<Wanted>();
    socket.addEventListener("message", (event) => {
      const frame = serviceFrameSchema.safeParse(JSON.parse(String(event.data)));
      if (frame.success && predicate(frame.data)) resolve(frame.data);
    });
    return promise;
  }

  async waitForSpawn(): Promise<ExecSpawnServiceFrame> {
    return this.waitFor((frame): frame is ExecSpawnServiceFrame => frame.type === "exec.spawn");
  }

  acknowledgeSpawn(spawn: ExecSpawnServiceFrame): void {
    this.send({
      type: "exec.started",
      requestId: spawn.requestId,
      threadId: spawn.threadId,
      executionId: spawn.executionId,
      pid: 4242,
      pidStartedAt: 42420,
    });
  }

  sendOutput(executionId: string, offset: number, text: string): void {
    this.send({
      type: "exec.output",
      threadId: spawnThreadOf(executionId),
      executionId,
      offset,
      bytesBase64: btoa(text),
    });
  }

  sendExited(executionId: string, exitCode: number | null, finalOffset: number): void {
    this.send({
      type: "exec.exited",
      threadId: spawnThreadOf(executionId),
      executionId,
      exitCode,
      signal: null,
      finalOffset,
    });
  }

  send(frame: Record<string, unknown>): void {
    if (this.socket === null) throw new Error("client not dialed");
    this.socket.send(JSON.stringify(frame));
  }
}

/** The thread id embedded in an executionId (`${threadId}:${callSeq}`). */
function spawnThreadOf(executionId: string): string {
  return executionId.slice(0, executionId.lastIndexOf(":"));
}

const MOCK_TURNS: MockTurn[] = [
  {
    deltas: ["我来执行。"],
    toolCalls: [{ name: "bash", arguments: { i: "echo", command: "echo hookup" } }],
  },
  { deltas: ["完成：hookup-output"] },
];

async function driveBashRoundtrip(
  rig: Rig,
  client: HookupClient,
  clientRequestId: string,
): Promise<AnyAgentEvent[]> {
  const sent = await rig.stub.sendMessage({
    clientRequestId,
    content: [{ type: "text", text: "用 bash 执行 echo hookup" }],
    mode: "start",
  });
  expect(sent.duplicated).toBe(false);

  // Dispatch settles only after the client acks, so the ack must ride a
  // concurrent turn: wait spawn → ack → output → exited.
  const spawn = await client.waitForSpawn();
  client.acknowledgeSpawn(spawn);
  client.sendOutput(spawn.executionId, 0, "hookup-output\n");
  client.sendExited(spawn.executionId, 0, "hookup-output\n".length);
  return rig.waitTurnComplete(sent.turnId);
}

test(
  "hookup: mock relay turn roundtrips through the real DaemonServiceDO",
  { timeout: 60_000 },
  async () => {
    const rig = await createRig({ turns: MOCK_TURNS });
    const client = new HookupClient(rig.threadId);
    await client.dial();

    const events = await driveBashRoundtrip(rig, client, "hookup-mock-1");

    expect(typeList(events)).toEqual([
      "thread.created",
      "turn.input",
      "model.call_started",
      "model.delta",
      "model.call_completed",
      "tool.call",
      "tool.dispatch",
      "tool.exec_started",
      "tool.output",
      "tool.result",
      "model.call_started",
      "model.delta",
      "model.call_completed",
      "turn.completed",
    ]);
    const dispatch = events.find((event) => event.type === "tool.dispatch");
    expect(dispatch?.data).toMatchObject({ outcome: "accepted", attempt: 1 });
    const result = events.find((event) => event.type === "tool.result");
    expect(result?.data).toMatchObject({ status: "ok", output: "hookup-output\n" });
    // exactly one spawn frame: the real journal dedups (§3.5) — one roundtrip
    expect(client.inbound.filter((frame) => frame.type === "exec.spawn")).toHaveLength(1);
  },
);

const relayKey = __RELAY_ENV__.MODEL_RELAY_API_KEY;
const relayBase = __RELAY_ENV__.MODEL_RELAY_BASE_URL_ANTHROPIC;
const relayModel = __RELAY_ENV__.MODEL_RELAY_MODEL ?? "glm-5.3";

test.skipIf(relayKey === undefined || relayKey === "" || relayBase === undefined)(
  "hookup: live glm-5.3 turn through the real DaemonServiceDO",
  { timeout: 180_000 },
  async () => {
    if (relayBase === undefined || relayBase === "" || relayKey === undefined || relayKey === "") {
      throw new Error("live relay env missing (MODEL_RELAY_* in .dev.vars)");
    }
    const provider = new AnthropicRelayProvider({
      baseUrl: relayBase,
      apiKey: relayKey,
      model: relayModel,
      maxTokens: 8192,
      thinking: { type: "disabled" },
    });
    const rig = await createRig({ provider });
    const client = new HookupClient(rig.threadId);
    await client.dial();

    const events = await driveBashRoundtrip(rig, client, "hookup-live-1");

    expect(typeList(events)).toContain("turn.completed");
    const result = events.find((event) => event.type === "tool.result");
    expect(result?.data).toMatchObject({ status: "ok", output: "hookup-output\n" });
    const completed = events.filter((event) => event.type === "model.call_completed");
    expect(completed).toHaveLength(2);

    // replay-identical bodies still hold over the real chain
    expect(provider.bodies).toHaveLength(2);
    const startedCalls = events.filter(
      (event): event is AgentEventRecord<"model.call_started"> =>
        event.type === "model.call_started",
    );
    const call2 = startedCalls.find((event) => event.seq > (completed[0]?.seq ?? 0));
    if (call2 === undefined) throw new Error("missing second model call");
    const replay = JSON.stringify(
      anthropicRequestBody(modelRequestFromEvents(events, call2.data.turnId, call2.seq), {
        model: relayModel,
        maxTokens: 8192,
        thinking: { type: "disabled" },
      }),
    );
    expect(replay).toBe(provider.bodies[1]);
  },
);
