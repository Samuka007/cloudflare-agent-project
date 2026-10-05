import { describe, expect, test } from "vitest";
import type { AgentEventDataByType, AgentEventType } from "../src/fsm-events.js";
import { parseAgentEvent, type AnyAgentEvent } from "../src/fsm-events.js";
import type { ModelRequest } from "../src/provider.js";
import { modelRequestFromEvents, ProjectionError } from "../src/translate.js";
import { AnthropicRelayProvider } from "../src/relay/anthropic-provider.js";
import { anthropicRequestBody, type WireCallOptions } from "../src/relay/wire.js";
import { createRig, resetRuntime, type Rig } from "./helpers.js";

/**
 * A4 model consumption (#319): the #317 prompt-image union reaches the model
 * seam as ImageContributions, and the wire dispatches per capability — a
 * vision-capable relay receives real Anthropic image blocks, a non-capable
 * one receives the acp degradation text (bridge.ts:1131-1153 anchor). Path
 * contributions degrade regardless: the DO has no byte channel to the
 * staging host.
 */

const THREAD = "th-img";

function event<TType extends AgentEventType>(
  seq: number,
  type: TType,
  data: AgentEventDataByType[TType],
): AnyAgentEvent {
  return parseAgentEvent({ id: `e${seq}`, threadId: THREAD, seq, type, data, createdAt: 0 });
}

const HTTP_URL = "https://example.com/cat.png";
const DATA_URI = "data:image/png;base64,aGVsbG8=";

const WIRE_OPTS: WireCallOptions = {
  model: "test-model",
  maxTokens: 8192,
  thinking: { type: "disabled" },
};

/** One-call turn over the given input content; the call is terminal. */
function singleTurnLog(
  inputContent: AgentEventDataByType["turn.input"]["content"],
): AnyAgentEvent[] {
  return [
    event(1, "thread.created", { title: "t", machineId: "local" }),
    event(2, "turn.input", { turnId: "t1", inputId: "i1", content: inputContent }),
    event(3, "model.call_started", { turnId: "t1", consumedSteerSeqs: [] }),
    event(4, "model.call_completed", {
      turnId: "t1",
      modelCallId: 3,
      text: "看到图了。",
      toolCalls: [],
    }),
    event(5, "turn.completed", { turnId: "t1" }),
  ];
}

describe("A4 fold: journal image parts → ImageContributions", () => {
  test("classifies url/data/path and skips text/localFile", () => {
    const request = modelRequestFromEvents(
      singleTurnLog([
        { type: "text", text: "看这张图" },
        { type: "image", url: HTTP_URL },
        { type: "image", url: DATA_URI },
        { type: "localImage", path: "attachments/p1/staged.png" },
        { type: "localImage", path: "/srv/staging/th1/Attachments/staged.png" },
        { type: "localFile", path: "attachments/p1/notes.txt" },
      ]),
      "t1",
      3,
    );
    expect(request.input).toBe("看这张图");
    expect(request.inputImages).toEqual([
      { kind: "url", url: HTTP_URL },
      { kind: "data", mediaType: "image/png", base64: "aGVsbG8=" },
      { kind: "path", path: "attachments/p1/staged.png" },
      { kind: "path", path: "/srv/staging/th1/Attachments/staged.png" },
    ]);
  });

  test("a data URI may ride the localImage pass-through leg", () => {
    const request = modelRequestFromEvents(
      singleTurnLog([{ type: "localImage", path: DATA_URI }]),
      "t1",
      3,
    );
    expect(request.inputImages).toEqual([
      { kind: "data", mediaType: "image/png", base64: "aGVsbG8=" },
    ]);
  });

  test("a non-Anthropic inline media type degrades to path", () => {
    const request = modelRequestFromEvents(
      singleTurnLog([{ type: "image", url: "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=" }]),
      "t1",
      3,
    );
    expect(request.inputImages).toEqual([
      { kind: "path", path: "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=" },
    ]);
  });

  test("an image-only turn is a legal turn (no empty-text projection error)", () => {
    const request = modelRequestFromEvents(
      singleTurnLog([{ type: "image", url: HTTP_URL }]),
      "t1",
      3,
    );
    expect(request.input).toBe("");
    expect(request.inputImages).toEqual([{ kind: "url", url: HTTP_URL }]);
  });

  test("an empty text part with no images still throws", () => {
    expect(() =>
      modelRequestFromEvents(singleTurnLog([{ type: "text", text: "" }]), "t1", 3),
    ).toThrow(ProjectionError);
  });

  test("prior turn images ride priorTurns; steer images ride their boundary", () => {
    // t1 = answered image-only turn; t2 = text input whose first call
    // consumes an image steer.
    const log: AnyAgentEvent[] = [
      event(1, "thread.created", { title: "t", machineId: "local" }),
      event(2, "turn.input", {
        turnId: "t1",
        inputId: "i1",
        content: [{ type: "image", url: HTTP_URL }],
      }),
      event(3, "model.call_started", { turnId: "t1", consumedSteerSeqs: [] }),
      event(4, "model.call_completed", { turnId: "t1", modelCallId: 3, text: "ok", toolCalls: [] }),
      event(5, "turn.completed", { turnId: "t1" }),
      event(6, "turn.input", {
        turnId: "t2",
        inputId: "i2",
        content: [{ type: "text", text: "还有这张" }],
      }),
      event(7, "turn.steer", {
        turnId: "t2",
        inputId: "i3",
        content: [
          { type: "text", text: "只看这张" },
          { type: "image", url: DATA_URI },
        ],
      }),
      event(8, "model.call_started", { turnId: "t2", consumedSteerSeqs: [7] }),
    ];
    const request = modelRequestFromEvents(log, "t2", 8);
    expect(request.input).toBe("还有这张");
    expect(request.inputImages).toEqual([]);
    const priorTurn = request.priorTurns?.[0];
    expect(priorTurn?.images).toEqual([{ kind: "url", url: HTTP_URL }]);
    const steer = request.steers[0];
    expect(steer?.text).toBe("只看这张");
    expect(steer?.images).toEqual([{ kind: "data", mediaType: "image/png", base64: "aGVsbG8=" }]);
  });
});

// ---------------------------------------------------------------------------
// Wire dispatch (#319): capability ∧ expressibility decides image block vs
// degradation text.
// ---------------------------------------------------------------------------

describe("A4 wire: image blocks vs acp degradation", () => {
  test("capable relay: url → url source, data → base64 source, path → disk text", () => {
    const request: ModelRequest = modelRequestFromEvents(
      singleTurnLog([
        { type: "text", text: "看" },
        { type: "image", url: HTTP_URL },
        { type: "image", url: DATA_URI },
        { type: "localImage", path: "attachments/p1/staged.png" },
      ]),
      "t1",
      3,
    );
    const body = anthropicRequestBody(request, { ...WIRE_OPTS, supportsImageInput: true });
    const first = body.messages[0];
    if (first?.role !== "user") throw new Error("missing opening user");
    expect(first.content).toEqual([
      { type: "text", text: "看" },
      { type: "image", source: { type: "url", url: HTTP_URL } },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" } },
      { type: "text", text: "[image attachment on disk: attachments/p1/staged.png]" },
    ]);
  });

  test("non-capable relay: every image degrades to its acp text", () => {
    const request: ModelRequest = modelRequestFromEvents(
      singleTurnLog([
        { type: "text", text: "看" },
        { type: "image", url: HTTP_URL },
        { type: "image", url: DATA_URI },
        { type: "localImage", path: "attachments/p1/staged.png" },
      ]),
      "t1",
      3,
    );
    for (const supportsImageInput of [false, undefined]) {
      const body = anthropicRequestBody(request, { ...WIRE_OPTS, supportsImageInput });
      const first = body.messages[0];
      if (first?.role !== "user") throw new Error("missing opening user");
      expect(first.content).toEqual([
        { type: "text", text: "看" },
        { type: "text", text: `[image attachment: ${HTTP_URL}]` },
        { type: "text", text: "[image attachment: inline image/png]" },
        { type: "text", text: "[image attachment on disk: attachments/p1/staged.png]" },
      ]);
    }
  });

  test("prior-turn and steer images ride their own user messages", () => {
    const log: AnyAgentEvent[] = [
      event(1, "thread.created", { title: "t", machineId: "local" }),
      event(2, "turn.input", {
        turnId: "t1",
        inputId: "i1",
        content: [{ type: "image", url: HTTP_URL }],
      }),
      event(3, "model.call_started", { turnId: "t1", consumedSteerSeqs: [] }),
      event(4, "model.call_completed", { turnId: "t1", modelCallId: 3, text: "ok", toolCalls: [] }),
      event(5, "turn.completed", { turnId: "t1" }),
      event(6, "turn.input", {
        turnId: "t2",
        inputId: "i2",
        content: [{ type: "text", text: "还有这张" }],
      }),
      event(7, "turn.steer", {
        turnId: "t2",
        inputId: "i3",
        content: [{ type: "image", url: DATA_URI }],
      }),
      event(8, "model.call_started", { turnId: "t2", consumedSteerSeqs: [7] }),
    ];
    const body = anthropicRequestBody(modelRequestFromEvents(log, "t2", 8), {
      ...WIRE_OPTS,
      supportsImageInput: true,
    });
    const roles = body.messages.map((message) => message.role);
    expect(roles).toEqual(["user", "assistant", "user"]);
    const opening = body.messages[0];
    if (opening?.role !== "user") throw new Error("missing opening user");
    expect(opening.content).toEqual([{ type: "image", source: { type: "url", url: HTTP_URL } }]);
    const trailing = body.messages[2];
    if (trailing?.role !== "user") throw new Error("missing trailing user");
    expect(trailing.content).toEqual([
      { type: "text", text: "还有这张" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" } },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Relay passthrough: the RelayConfig verdict rides every wire call.
// ---------------------------------------------------------------------------

describe("A4 relay: RelayConfig.supportsImageInput reaches the body", () => {
  const SSE =
    'event: message_start\ndata: {"type":"message_start","message":{"id":"m1","usage":{}}}\n\n' +
    'event: message_stop\ndata: {"type":"message_stop"}\n\n';

  function providerWith(supportsImageInput: boolean | undefined): AnthropicRelayProvider {
    return new AnthropicRelayProvider({
      baseUrl: "https://relay.test/api/anthropic",
      apiKey: "k-test",
      model: "glm-5.3",
      maxTokens: 8192,
      ...(supportsImageInput === undefined ? {} : { supportsImageInput }),
      fetchImpl: () =>
        Promise.resolve(
          new Response(SSE, { status: 200, headers: { "content-type": "text/event-stream" } }),
        ),
    });
  }

  async function firstBody(provider: AnthropicRelayProvider): Promise<void> {
    const controller = new AbortController();
    for await (const _ of provider.streamTurn(
      modelRequestFromEvents(singleTurnLog([{ type: "image", url: HTTP_URL }]), "t1", 3),
      { signal: controller.signal },
    )) {
      // drain
    }
  }

  test("declared capability → the image block rides the serialized body", async () => {
    const provider = providerWith(true);
    await firstBody(provider);
    const body = provider.bodies[0];
    if (body === undefined) throw new Error("no body recorded");
    const wire = JSON.parse(body) as { messages: { role: string; content: unknown }[] };
    expect(wire.messages[0]).toEqual({
      role: "user",
      content: [{ type: "image", source: { type: "url", url: HTTP_URL } }],
    });
  });

  test("undeclared capability → the degradation text rides the serialized body", async () => {
    const provider = providerWith(undefined);
    await firstBody(provider);
    const body = provider.bodies[0];
    if (body === undefined) throw new Error("no body recorded");
    const wire = JSON.parse(body) as { messages: { role: string; content: unknown }[] };
    expect(wire.messages[0]).toEqual({
      role: "user",
      content: [{ type: "text", text: `[image attachment: ${HTTP_URL}]` }],
    });
  });
});

// ---------------------------------------------------------------------------
// DO end-to-end: an image-only turn completes and the provider sees the images
// (the A2-era ProjectionError crash is repaired by the fold).
// ---------------------------------------------------------------------------

describe("A4 DO: image-only turn end-to-end", () => {
  test("image-only turn completes; the mock records inputImages; history carries them", async () => {
    const rig: Rig = await createRig({ turns: [{ deltas: ["看到图了"] }, { deltas: ["继续"] }] });
    try {
      const first = await rig.stub.sendMessage({
        clientRequestId: "img-1",
        content: [
          { type: "text", text: "看这张" },
          { type: "image", url: HTTP_URL },
        ],
        mode: "start",
      });
      await rig.waitTurnComplete(first.turnId);
      const firstCall = rig.mock().calls[0];
      expect(firstCall?.inputImages).toEqual([{ kind: "url", url: HTTP_URL }]);

      const second = await rig.stub.sendMessage({
        clientRequestId: "img-2",
        content: [{ type: "image", url: DATA_URI }],
        mode: "start",
      });
      await rig.waitTurnComplete(second.turnId);
      const secondCall = rig.mock().calls[1];
      expect(secondCall?.input).toBe("");
      expect(secondCall?.inputImages).toEqual([
        { kind: "data", mediaType: "image/png", base64: "aGVsbG8=" },
      ]);
      const prior = secondCall?.priorTurns?.[0];
      expect(prior?.images).toEqual([{ kind: "url", url: HTTP_URL }]);
    } finally {
      resetRuntime();
    }
  });
});
