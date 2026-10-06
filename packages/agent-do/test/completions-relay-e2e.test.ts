import { expect, test } from "vitest";
import { CompletionsRelayProvider } from "../src/relay/completions-provider.js";
import { completionsRequestBody } from "../src/relay/completions-wire.js";
import { createRig, typeList, type Rig } from "./helpers.js";
import { modelRequestFromEvents } from "../src/translate.js";

/**
 * #363 e2e: a DO turn through the chat-completions adaptor against a MOCK
 * upstream (fetchImpl-canned SSE) — the thinking+tool_use acceptance turn of
 * the ticket, journaled as the SAME model.delta/model.thinking/
 * model.usage_receipt/tool.call rows the other two faces produce (the
 * semantic surface is face-neutral; only the wire differs). No secrets:
 * runs in CI.
 */

function sse(chunks: (Record<string, unknown> | "[DONE]")[]): string {
  return (
    chunks
      .map((payload) =>
        payload === "[DONE]" ? "data: [DONE]\n\n" : `data: ${JSON.stringify(payload)}\n\n`,
      )
      .join("") + "\n"
  );
}

function deltaChunk(delta: Record<string, unknown>, finishReason: string | null = null) {
  return {
    id: "chatcmpl-e2e",
    object: "chat.completion.chunk",
    created: 0,
    model: "glm-5.3-flash",
    choices: [{ index: 0, delta, logprobs: null, finish_reason: finishReason }],
  };
}

/** Call 1: think + tool_use. Call 2: the final text answer. */
const CALL1_SSE = sse([
  deltaChunk({ reasoning_content: "需要执行 bash" }),
  deltaChunk({
    tool_calls: [
      {
        index: 0,
        id: "call_e2e",
        type: "function",
        function: { name: "bash", arguments: '{"comm' },
      },
    ],
  }),
  deltaChunk({ tool_calls: [{ index: 0, function: { arguments: 'and":"echo marker-e2e"}' } }] }),
  deltaChunk({}, "tool_calls"),
  {
    id: "chatcmpl-e2e",
    object: "chat.completion.chunk",
    created: 0,
    model: "glm-5.3-flash",
    choices: [],
    usage: { prompt_tokens: 90, completion_tokens: 30, total_tokens: 120 },
  },
  "[DONE]",
]);

const CALL2_SSE = sse([
  deltaChunk({ content: "marker-e2e" }),
  deltaChunk({}, "stop"),
  {
    id: "chatcmpl-e2e",
    object: "chat.completion.chunk",
    created: 0,
    model: "glm-5.3-flash",
    choices: [],
    usage: { prompt_tokens: 140, completion_tokens: 8, total_tokens: 148 },
  },
  "[DONE]",
]);

test(
  "completions e2e: thinking+tool_use roundtrip journals the shared semantics",
  { timeout: 30_000 },
  async () => {
    // Sequenced by call: the canned call-1 SSE first, call-2 second.
    let call = 0;
    const provider = new CompletionsRelayProvider({
      baseUrl: "https://mock-upstream.test/v1",
      apiKey: "k-mock-e2e",
      model: "glm-5.3-flash",
      maxTokens: 8192,
      reasoningEffort: "none",
      api: "openai-completions",
      fetchImpl: () => {
        call += 1;
        return Promise.resolve(
          new Response(call === 1 ? CALL1_SSE : CALL2_SSE, {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          }),
        );
      },
    });
    const rig: Rig = await createRig({ provider });
    const marker = "marker-e2e";

    const sent = await rig.stub.sendMessage({
      clientRequestId: "e2e-completions-1",
      content: [{ type: "text", text: `用 bash 执行 echo ${marker} 并把输出原样告诉我。` }],
      mode: "start",
    });
    expect(sent.duplicated).toBe(false);

    // The reference fake stands in for the real dispatch lane: canned bash
    // output, then the exit (same posture as the real-model smokes).
    const snapshot = await rig.waitFor((all) => all.some((event) => event.type === "tool.call"));
    const toolCall = snapshot.find((event) => event.type === "tool.call");
    if (toolCall === undefined) throw new Error("missing tool.call event");
    const executionId = `${rig.threadId}:${toolCall.seq}`;
    const canned = `${marker}\n`;
    await rig.service.clientEmitOutput(executionId, canned);
    await rig.service.clientExit(executionId, { status: "ok", exitCode: 0, output: canned });

    const events = await rig.waitTurnComplete(sent.turnId);

    expect(typeList(events)).not.toContain("turn.failed");
    expect(typeList(events)).not.toContain("turn.cancelled");
    expect(typeList(events)).toContain("turn.completed");
    // The thinking channel is face-neutral journal semantics (model.thinking
    // rows under #257 — the reasoning_content deltas, not answer text).
    expect(typeList(events)).toContain("model.thinking");
    expect(typeList(events)).toContain("model.delta");
    expect(typeList(events)).toContain("model.usage_receipt");

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
      expect(wire).toMatchObject({ model: "glm-5.3-flash" });
    }
    // Call 1's wire shape: tools on the wire, [DONE]-sealed stream upstream.
    // The bodies are this provider's own serializations — the wire is trusted
    // at the seam that produced it; reads narrow instead of casting.
    const firstBody: unknown = JSON.parse(provider.bodies[0] ?? "{}");
    expect(firstBody).toMatchObject({ reasoning_effort: "none" });
    expect(firstBody).toHaveProperty(["messages", "0", "role"], "system");
    // The tool surface rode the wire (compact JSON.stringify of our own body).
    expect(provider.bodies[0]).toContain('"name":"bash"');

    // replay-identical assembly: the log replays byte-identically to BOTH
    // recorded wire bodies (live DO path ≡ pure projection, twice over)
    const call1 = started[0];
    const call2 = started[1];
    if (call1 === undefined || call2 === undefined) {
      throw new Error("missing model.call_started events");
    }
    const opts = {
      model: "glm-5.3-flash",
      maxTokens: 8192,
      reasoningEffort: "none" as const,
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
