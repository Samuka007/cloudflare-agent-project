import { expect, test } from "vitest";
import { ResponsesRelayProvider, modelRequestFromEvents } from "../src/index.js";
import { responsesRequestBody } from "../src/relay/responses-wire.js";
import { createRig, typeList, type Rig } from "./helpers.js";
import type { AnyAgentEvent } from "../src/fsm-events.js";

/**
 * #361 real-upstream smoke: newapi glm-5.3-flash via the openai-responses
 * adaptor induces a bash tool roundtrip; the daemon seam is the reference
 * fake (same posture as the anthropic-face smoke-real-model). The type-58
 * lesson is the gate: the SSE stream must terminate explicitly — the
 * provider throws "stream ended without response.completed" otherwise, and
 * a completed turn here PROVES the terminal frame arrived.
 *
 * Skips itself when `.dev.vars` (gitignored) carries no responses-face
 * creds — CI stays green without secrets. The deployment supplies the same
 * values through MODEL_RELAY_PROVIDER_CREDENTIALS + the catalog row's
 * api: "openai-responses" (the deployment-side face of this file's local
 * .dev.vars slots).
 */

const responsesKey = __RELAY_ENV__.MODEL_RELAY_RESPONSES_API_KEY;
const responsesBase = __RELAY_ENV__.MODEL_RELAY_RESPONSES_BASE_URL;
const responsesModel = __RELAY_ENV__.MODEL_RELAY_RESPONSES_MODEL ?? "glm-5.3-flash";

function transcriptOf(
  rig: Rig,
  provider: ResponsesRelayProvider,
  events: AnyAgentEvent[],
): string {
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

test.skipIf(
  responsesKey === undefined || responsesKey === "" || responsesBase === undefined,
)("responses smoke: newapi glm-5.3-flash tool roundtrip terminates with response.completed",
  { timeout: 240_000 },
  async () => {
    if (responsesBase === undefined || responsesBase === "" || responsesKey === undefined || responsesKey === "") {
      throw new Error("live responses relay env missing (MODEL_RELAY_RESPONSES_* in .dev.vars)");
    }
    const provider = new ResponsesRelayProvider({
      baseUrl: responsesBase,
      apiKey: responsesKey,
      model: responsesModel,
      maxTokens: 8192,
      // The M0 deterministic budget: effort "none" is the explicit off —
      // this smoke doubles as the upstream-accepts-effort-none probe.
      reasoningEffort: "none",
      api: "openai-responses",
    });
    const rig = await createRig({ provider });
    const marker = `poc-${Date.now()}`;

    const sent = await rig.stub.sendMessage({
      clientRequestId: "poc-smoke-responses-1",
      content: [{ type: "text", text: `用 bash 执行 echo ${marker} 并把输出原样告诉我。` }],
      mode: "start",
    });
    expect(sent.duplicated).toBe(false);

    // The REAL dispatch chain is the service lane's half; the reference fake
    // stands in: emit the canned bash output, then the exit.
    const snapshot = await rig.waitFor((all) => all.some((event) => event.type === "tool.call"));
    const toolCall = snapshot.find((event) => event.type === "tool.call");
    if (toolCall === undefined) throw new Error("missing tool.call event");
    const executionId = `${rig.threadId}:${toolCall.seq}`;
    const canned = `${marker}\n`;
    await rig.service.clientEmitOutput(executionId, canned);
    await rig.service.clientExit(executionId, { status: "ok", exitCode: 0, output: canned });

    const events = await rig.waitTurnComplete(sent.turnId);
    const transcript = transcriptOf(rig, provider, events);
    console.log("POC-RESPONSES-SMOKE-TRANSCRIPT\n" + transcript);

    expect(typeList(events)).not.toContain("turn.failed");
    expect(typeList(events)).not.toContain("turn.cancelled");
    expect(typeList(events)).toContain("turn.completed");

    // exactly two model calls: tool-use roundtrip + final answer
    const started = events.filter((event) => event.type === "model.call_started");
    expect(started).toHaveLength(2);
    const completedEvents = events.filter((event) => event.type === "model.call_completed");
    expect(completedEvents).toHaveLength(2);

    // tool.call ↔ tool.result pairing (1:1, terminal ok, canned output back)
    const calls = events.filter((event) => event.type === "tool.call");
    const results = events.filter((event) => event.type === "tool.result");
    expect(calls).toHaveLength(1);
    expect(results).toHaveLength(1);
    const result = results[0];
    if (result === undefined) throw new Error("missing tool.result event");
    expect(result.data).toMatchObject({ status: "ok", output: canned });

    // the model echoed the marker back in the final assistant text
    const finalCall = completedEvents[1];
    if (finalCall === undefined) throw new Error("missing final model.call_completed");
    expect(finalCall.data.toolCalls).toEqual([]);
    expect(finalCall.data.text).toContain(marker);

    // the provider saw exactly the two attempts, each with a recorded body
    expect(provider.requests).toHaveLength(2);
    expect(provider.bodies).toHaveLength(2);
    // Both calls completed: turn.completed + receipts prove the terminal
    // response.completed frame rode every stream (the type-58 gate).
    for (const body of provider.bodies) {
      expect(JSON.parse(body).model).toBe(responsesModel);
    }

    // replay-identical assembly: the log replays byte-identically to BOTH
    // recorded wire bodies (live DO path ≡ pure projection, twice over)
    const call1 = started[0];
    const call2 = started[1];
    if (call1 === undefined || call2 === undefined) {
      throw new Error("missing model.call_started events");
    }
    const opts = {
      model: responsesModel,
      maxTokens: 8192,
      reasoningEffort: "none" as const,
      api: "openai-responses" as const,
    };
    const gates = {
      externalThinking: false,
      contextNotes: false,
      checkpoint: false,
      generateImage: false,
    } as const;
    const replay1 = JSON.stringify(
      responsesRequestBody(
        { ...modelRequestFromEvents(events, sent.turnId, call1.seq), experimentalGates: gates },
        opts,
      ),
    );
    expect(replay1).toBe(provider.bodies[0]);
    const replay2 = JSON.stringify(
      responsesRequestBody(
        { ...modelRequestFromEvents(events, sent.turnId, call2.seq), experimentalGates: gates },
        opts,
      ),
    );
    expect(replay2).toBe(provider.bodies[1]);
  },
);
