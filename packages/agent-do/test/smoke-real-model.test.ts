import { expect, test } from "vitest";
import {
  AnthropicRelayProvider,
  modelRequestFromEvents,
} from "../src/index.js";
import { anthropicRequestBody } from "../src/relay/wire.js";
import { createRig, typeList, type Rig } from "./helpers.js";
import type { AnyAgentEvent } from "../src/fsm-events.js";

/**
 * Real-model POC smoke (ticket #34 loop half): glm-5.3 via the Anthropic
 * relay induces a bash tool_use; the daemon seam is the reference fake (the
 * REAL chain is the service lane's half — full hookup lands after that
 * package merges). Asserts the full event sequence, call/result pairing,
 * and replay-identical request assembly against the recorded wire bodies.
 *
 * Skips itself when `.dev.vars` (gitignored) carries no MODEL_RELAY_* creds —
 * CI stays green without secrets.
 */

const relayKey = __RELAY_ENV__.MODEL_RELAY_API_KEY;
const relayBase = __RELAY_ENV__.MODEL_RELAY_BASE_URL_ANTHROPIC;
const relayModel = __RELAY_ENV__.MODEL_RELAY_MODEL ?? "glm-5.3";

function transcriptOf(rig: Rig, provider: AnthropicRelayProvider, events: AnyAgentEvent[]): string {
  return JSON.stringify(
    {
      threadId: rig.threadId,
      events: events.map((event) => ({ seq: event.seq, type: event.type, data: event.data })),
      relayBodies: provider.bodies,
      finalAssistantText: events.flatMap((event) =>
        event.type === "model.call_completed" ? [event.data.text] : [],
      ),
    },
    null,
    1,
  );
}

test.skipIf(relayKey === undefined || relayKey === "" || relayBase === undefined)(
  "poc smoke: real glm-5.3 turn induces a bash roundtrip via the mock daemon seam",
  { timeout: 180_000 },
  async () => {
    const provider = new AnthropicRelayProvider({
      baseUrl: relayBase!,
      apiKey: relayKey!,
      model: relayModel,
      maxTokens: 8192,
      thinking: { type: "disabled" },
    });
    const rig = await createRig({ provider });
    const marker = `poc-${Date.now()}`;

    const sent = await rig.stub.sendMessage({
      clientRequestId: "poc-smoke-1",
      content: [{ type: "text", text: `用 bash 执行 echo ${marker} 并把输出原样告诉我。` }],
      mode: "start",
    });
    expect(sent.duplicated).toBe(false);

    // The REAL dispatch chain is the service lane's half; the reference fake
    // stands in: emit the canned bash output, then the exit.
    const snapshot = await rig.waitFor((all) => all.some((event) => event.type === "tool.call"));
    const toolCall = snapshot.find((event) => event.type === "tool.call");
    expect(toolCall).toBeDefined();
    const executionId = `${rig.threadId}:${toolCall!.seq}`;
    const canned = `${marker}\n`;
    await rig.service.clientEmitOutput(executionId, canned);
    await rig.service.clientExit(executionId, { status: "ok", exitCode: 0, output: canned });

    const events = await rig.waitTurnComplete(sent.turnId);
    const transcript = transcriptOf(rig, provider, events);
    console.log("POC-SMOKE-TRANSCRIPT\n" + transcript);

    expect(typeList(events)).not.toContain("turn.failed");
    expect(typeList(events)).not.toContain("turn.cancelled");
    expect(typeList(events)).toContain("turn.completed");

    // exactly two model calls: tool-use roundtrip + final answer
    const started = events.filter((event) => event.type === "model.call_started");
    expect(started).toHaveLength(2);
    const completed = events.filter((event) => event.type === "model.call_completed");
    expect(completed).toHaveLength(2);

    // tool.call ↔ tool.result pairing (1:1, terminal ok, canned output back)
    const calls = events.filter((event) => event.type === "tool.call");
    const results = events.filter((event) => event.type === "tool.result");
    expect(calls).toHaveLength(1);
    expect(results).toHaveLength(1);
    const result = results[0];
    if (result === undefined) throw new Error("missing tool.result event");
    expect(result.data).toMatchObject({ status: "ok", output: canned });

    // the model echoed the marker back in the final assistant text
    const finalCall = completed[1];
    if (finalCall === undefined) throw new Error("missing final model.call_completed");
    expect(finalCall.data.toolCalls).toEqual([]);
    expect(finalCall.data.text).toContain(marker);

    // the provider saw exactly the two attempts, each with a recorded body
    expect(provider.requests).toHaveLength(2);
    expect(provider.bodies).toHaveLength(2);

    // replay-identical assembly: the log replays byte-identically to BOTH
    // recorded wire bodies (live DO path ≡ pure projection, twice over)
    const call1 = started[0];
    const call2 = started[1];
    if (call1 === undefined || call2 === undefined) {
      throw new Error("missing model.call_started events");
    }
    const call1Id = call1.seq;
    const call2Id = call2.seq;
    const opts = {
      model: relayModel,
      maxTokens: 8192,
      thinking: { type: "disabled" } as const,
    };
    const replay1 = JSON.stringify(
      anthropicRequestBody(modelRequestFromEvents(events, sent.turnId, call1Id), opts),
    );
    expect(replay1).toBe(provider.bodies[0]);
    const replay2 = JSON.stringify(
      anthropicRequestBody(modelRequestFromEvents(events, sent.turnId, call2Id), opts),
    );
    expect(replay2).toBe(provider.bodies[1]);
  },
);
