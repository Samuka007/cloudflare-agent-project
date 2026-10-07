import { afterEach, describe, expect, test } from "vitest";
import { parseThreadEvent, type TypedThreadEvent } from "@cap/protocol";
import { createRig, resetRuntime } from "./helpers.js";
import { modelRequestFromEvents } from "../src/translate.js";
import { anthropicRequestBody } from "../src/relay/wire.js";
import { completionsRequestBody } from "../src/relay/completions-wire.js";
import { responsesRequestBody } from "../src/relay/responses-wire.js";
import { projectToUxEvents } from "../src/ux-projection.js";
import type { AnyAgentEvent } from "../src/fsm-events.js";

/**
 * #454 acceptance: a thread bound to an offline host (the rig's fake service
 * DO with no live session — the same "no live daemon session" answer the
 * cloud placeholder 恒答 gives) lets the model call bash, and EVERY face of
 * the result is the structured not-executed error:
 *
 * - journal: status "error" + errorCode "host_offline" + the human message,
 *   exitCode null — never exit-0 stdout;
 * - model face: the `[tool error host_offline]` marker ahead of the message
 *   on all three wire faces (anthropic additionally keeps is_error), so the
 *   model can verbalize "tool not executed" instead of reading the refusal
 *   as command output;
 * - ux: the tool card folds failed + the same message + the code.
 *
 * The real-machine contrast (a live host streams stdout/stderr/exit code
 * verbatim) is pinned by the l1 round-trip suite — the contract only ever
 * decorates non-ok results.
 */

describe("tool-result not-executed contract (#454, execution suspension #73)", () => {
  afterEach(resetRuntime);

  test("offline bound host: journal, model faces, and ux all carry the structured refusal", async () => {
    const rig = await createRig({
      turns: [
        { toolCalls: [{ name: "bash", arguments: { command: "hostname" } }] },
        { deltas: ["工具未执行"] },
      ],
    });
    await rig.service.setHostOnline(false);
    const sent = await rig.stub.sendMessage({
      clientRequestId: "454-1",
      content: [{ type: "text", text: "跑 hostname" }],
      mode: "auto",
    });
    const events = await rig.waitTurnComplete(sent.turnId);

    // Journal: the not-executed result, exitCode null (no process ever ran).
    const resultRow = events.find((event) => event.type === "tool.result");
    expect(resultRow?.data).toMatchObject({
      status: "error",
      exitCode: null,
      errorCode: "host_offline",
      output: "tool not executed: bound host offline",
    });

    // Model face: the replayed request carries the structured result. The
    // second model call (post-placeholder) is the request under assertion.
    const resultSeq = resultRow?.seq ?? -1;
    const secondCall = events.findLast(
      (
        event,
      ): event is Extract<AnyAgentEvent, { type: "model.call_started" }> =>
        event.type === "model.call_started" && event.seq > resultSeq,
    );
    if (secondCall === undefined) throw new Error("no post-result model call");
    const request = modelRequestFromEvents(events, sent.turnId, secondCall.seq);
    const prior = request.priorCalls.at(-1);
    if (prior === undefined) throw new Error("no prior call slice");
    const result = prior.toolResults[0];
    expect(result?.executionId.startsWith(`${rig.threadId}:`)).toBe(true);
    expect(result).toMatchObject({
      tool: "bash",
      status: "error",
      output: "tool not executed: bound host offline",
      errorCode: "host_offline",
    } satisfies Record<string, unknown>);

    // …and every wire face renders failure semantics, never exit-0 stdout.
    const expected = "[tool error host_offline] tool not executed: bound host offline";
    const anthropic = anthropicRequestBody(request, {
      model: "test-model",
      maxTokens: 8192,
      thinking: { type: "disabled" },
    });
    const anthropicBlocks = anthropic.messages.at(-1)?.content;
    expect(anthropicBlocks).toHaveLength(1);
    expect(anthropicBlocks?.[0]).toMatchObject({
      type: "tool_result",
      content: expected,
      is_error: true,
    } satisfies Record<string, unknown>);
    const completions = completionsRequestBody(request, {
      model: "test-model",
      maxTokens: 8192,
      reasoningEffort: "none",
    });
    const toolMessages = completions.messages.filter((message) => message.role === "tool");
    expect(toolMessages).toHaveLength(1);
    expect(toolMessages[0]).toMatchObject({
      role: "tool",
      content: expected,
    } satisfies Record<string, unknown>);
    const responses = responsesRequestBody(request, {
      model: "test-model",
      maxTokens: 8192,
      reasoningEffort: "none",
    });
    const outputs = responses.input.filter((item) => item.type === "function_call_output");
    expect(outputs).toHaveLength(1);
    expect(outputs[0]).toMatchObject({
      type: "function_call_output",
      output: expected,
    } satisfies Record<string, unknown>);

    // ux: the tool card folds failed + the human message + the code.
    const projected: TypedThreadEvent[] = projectToUxEvents(events).map(parseThreadEvent);
    const toolItem = projected.find(
      (event): event is Extract<TypedThreadEvent, { type: "item/completed" }> =>
        event.type === "item/completed" && event.data.item.type === "toolCall",
    );
    if (toolItem === undefined) throw new Error("ux projection lost the toolCall item");
    expect(toolItem.data.item).toMatchObject({
      type: "toolCall",
      status: "failed",
      output: "tool not executed: bound host offline",
      errorCode: "host_offline",
    });

    // The turn still completed honestly (execution suspension #73): the
    // model's follow-up call streamed after the placeholder.
    expect(events.some((event) => event.type === "turn.completed")).toBe(true);
    expect(
      events
        .filter(
          (event): event is Extract<AnyAgentEvent, { type: "model.delta" }> =>
            event.type === "model.delta" && event.data.turnId === sent.turnId,
        )
        .map((row) => (typeof row.data.text === "string" ? row.data.text : ""))
        .join(""),
    ).toContain("工具未执行");
  });
});
