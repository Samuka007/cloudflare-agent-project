import { expect, test } from "vitest";
import { CompletionsRelayProvider, modelRequestFromEvents } from "../src/index.js";
import { completionsRequestBody } from "../src/relay/completions-wire.js";
import { createRig, waitForToolCallOrTerminal, typeList, type Rig } from "./helpers.js";
import type { AnyAgentEvent } from "../src/fsm-events.js";

/**
 * #363 real-upstream smoke: newapi glm-5.3-flash via the openai-completions
 * adaptor induces a bash tool roundtrip; the daemon seam is the reference
 * fake (same posture as the anthropic/responses-face smokes). The type-58
 * lesson is the gate: the chat-completions SSE stream must terminate
 * explicitly at `data: [DONE]` — the provider throws "stream ended without
 * [DONE]" otherwise, and a completed turn here PROVES the terminal frame
 * arrived on this wire too.
 *
 * Skips itself when `.dev.vars` (gitignored) carries no completions-face
 * creds — CI stays green without secrets. The deployment supplies the same
 * values through MODEL_RELAY_PROVIDER_CREDENTIALS + the catalog row's
 * api: "openai-completions".
 */

const completionsKey = __RELAY_ENV__.MODEL_RELAY_COMPLETIONS_API_KEY;
const completionsBase = __RELAY_ENV__.MODEL_RELAY_COMPLETIONS_BASE_URL;
const completionsModel = __RELAY_ENV__.MODEL_RELAY_COMPLETIONS_MODEL ?? "glm-5.3-flash";

function transcriptOf(
  rig: Rig,
  provider: CompletionsRelayProvider,
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

test.skipIf(completionsKey === undefined || completionsKey === "" || completionsBase === undefined)(
  "completions smoke: newapi glm-5.3-flash tool roundtrip terminates with [DONE]",
  { timeout: 240_000 },
  async () => {
    if (
      completionsBase === undefined ||
      completionsBase === "" ||
      completionsKey === undefined ||
      completionsKey === ""
    ) {
      throw new Error(
        "live completions relay env missing (MODEL_RELAY_COMPLETIONS_* in .dev.vars)",
      );
    }
    const provider = new CompletionsRelayProvider({
      baseUrl: completionsBase,
      apiKey: completionsKey,
      model: completionsModel,
      maxTokens: 8192,
      // The chat face has no required effort seat: no pin rides the wire —
      // the model's own default reasoning budget applies (the smoke proves
      // the adaptor speaks upstream shapes it did not choose itself).
      api: "openai-completions",
    });
    const rig = await createRig({ provider });
    const marker = `poc-${Date.now()}`;

    const sent = await rig.stub.sendMessage({
      clientRequestId: "poc-smoke-completions-1",
      content: [{ type: "text", text: `用 bash 执行 echo ${marker} 并把输出原样告诉我。` }],
      mode: "start",
    });
    expect(sent.duplicated).toBe(false);

    // The REAL dispatch chain is the service lane's half; the reference fake
    // stands in: emit the canned bash output, then the exit.
    const toolCall = await waitForToolCallOrTerminal(rig, sent.turnId);
    const executionId = `${rig.threadId}:${toolCall.seq}`;
    const canned = `${marker}\n`;
    await rig.service.clientEmitOutput(executionId, canned);
    await rig.service.clientExit(executionId, { status: "ok", exitCode: 0, output: canned });

    const events = await rig.waitTurnComplete(sent.turnId);
    const transcript = transcriptOf(rig, provider, events);
    console.log("POC-COMPLETIONS-SMOKE-TRANSCRIPT\n" + transcript);

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
    for (const body of provider.bodies) {
      const wire: unknown = JSON.parse(body);
      expect(wire).toMatchObject({ model: completionsModel });
    }

    // Both calls completed: turn.completed + receipts prove the terminal
    // [DONE] frame rode every stream (the type-58 gate, chat-wire analog).
    const receipts = events.filter((event) => event.type === "model.usage_receipt");
    expect(receipts.length).toBeGreaterThanOrEqual(2);
    const firstReceipt = receipts[0];
    if (firstReceipt === undefined) throw new Error("missing usage receipt");
    expect(firstReceipt.data.usage.estimated).toBe(false);

    // replay-identical assembly: the log replays byte-identically to BOTH
    // recorded wire bodies (live DO path ≡ pure projection, twice over)
    const call1 = started[0];
    const call2 = started[1];
    if (call1 === undefined || call2 === undefined) {
      throw new Error("missing model.call_started events");
    }
    const opts = {
      model: completionsModel,
      maxTokens: 8192,
      reasoningEffort: undefined,
      api: "openai-completions" as const,
    };
    const gates = {
      externalThinking: false,
      contextNotes: false,
      checkpoint: false,
      generateImage: false,
    } as const;
    const replay1 = JSON.stringify(
      completionsRequestBody(
        { ...modelRequestFromEvents(events, sent.turnId, call1.seq), experimentalGates: gates },
        opts,
      ),
    );
    expect(replay1).toBe(provider.bodies[0]);
    const replay2 = JSON.stringify(
      completionsRequestBody(
        { ...modelRequestFromEvents(events, sent.turnId, call2.seq), experimentalGates: gates },
        opts,
      ),
    );
    expect(replay2).toBe(provider.bodies[1]);
  },
);
