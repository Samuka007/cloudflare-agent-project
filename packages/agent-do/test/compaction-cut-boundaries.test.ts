import fc from "fast-check";
import { afterEach, describe, expect, test } from "vitest";
import {
  estimateTurnTokens,
  isContextOverflowFailure,
  planCompactCut,
  turnSlices,
  type CompactCutPlan,
} from "../src/compaction.js";
import { parseAgentEvent, type AnyAgentEvent } from "../src/fsm-events.js";
import { executionIdFor } from "../src/ids.js";
import {
  completionsRequestBody,
  type CompletionsRequestBody,
} from "../src/relay/completions-wire.js";
import { responsesRequestBody, type ResponsesRequestBody } from "../src/relay/responses-wire.js";
import { anthropicRequestBody, type AnthropicRequestBody } from "../src/relay/wire.js";
import { threadCompactedCut } from "../src/tools/session-tree.js";
import { modelRequestFromEvents } from "../src/translate.js";
import { replayEvents } from "../src/turn-state.js";
import type { ModelRequest } from "../src/provider.js";
import type { PromptContent } from "@cap/protocol";
import {
  buildSessionContext,
  estimateTokens,
  ESTIMATED_IMAGE_CHARS,
  findCutPoint,
  prepareCompaction,
  type CompactionEntry,
  type PortEntry,
  type PortMessage,
} from "./pi-port/compaction-kernel.js";
import { createRig, resetRuntime, type Rig } from "./helpers.js";

/**
 * #550 — compaction boundary gap patch: property faces over the cut seam
 * (#309 manual + #326 auto), generated with fast-check instead of hand-rolled
 * scenario campaigns.
 *
 * Phase 0 framework selection (research-first, PM steering 2026-10-08):
 * - **fast-check@3.23.2 — selected.** The ticket's "已在 pnpm 树" premise was
 *   stale for this repo (pnpm-lock.yaml had zero fast-check entries at
 *   dispatch); it is now a pinned devDependency of @cap/agent-do (pure JS:
 *   fast-check + pure-rand, no native deps). forAll over generated journals
 *   is exactly the L1-invariant / gapless / assembly-equivalence shape this
 *   ticket pins, and shrunk counterexamples come out reproducible.
 * - **@oh-my-pi/pi-agent-core test helpers — not importable.** pi-agent-core
 *   @18.6.0 exists in the tree only as a transitive dep of pi-coding-agent
 *   (the daemon-service Bun runtime); pnpm strict isolation would make the
 *   import a new direct dep, and upstream pi moved compaction out of
 *   pi-agent-core anyway (pi-parity-matrix §"结构变化"). The in-repo
 *   equivalent — test/pi-port/compaction-kernel.ts, the #314 vendored
 *   semantic kernel already serving four suites — IS the "自带测试助手" and
 *   is reused below for the kernel-side invariants.
 * - **vitest — kept.** Properties run as plain vitest tests inside the
 *   existing `pnpm test` CI gate; no second runner.
 *
 * Faces (ticket Change list, one describe block each):
 * 1. image/attachment over the cut boundary — post-cut priorTurns carry
 *    exactly the kept turns' images (never a hidden turn's, no dangling
 *    references) on every wire face, and token estimation counts image bytes
 *    where the journal carries them (blob-detoured results; kernel
 *    user-image budget).
 * 2. summarizer failure paths (rig) — a summarizer model-call failure and a
 *    summarizer self-overflow each land ZERO thread/compacted rows, keep the
 *    journal gapless/replayable, leave the thread usable, and stay
 *    retryable (the next compact RPC succeeds with exactly one checkpoint).
 * 3. responses/completions post-cut assembly equivalence — both OpenAI faces
 *    repeat the anthropic assertions over the same cut request: hidden span
 *    absent, kept span present, tool pairs intact, and the ordered content
 *    fingerprint identical across all three faces.
 * 4. kept-tail tool-pair integrity — planCompactCut never splits a pair at
 *    any budget, the first kept (found/crossing) turn assembles whole with
 *    its pair, the post-cut rebuild succeeds, and the kernel cut point never
 *    lands on a toolResult/system row (pi isCutPointMessage invariant).
 */

// ---------------------------------------------------------------------------
// Generators — valid journals with globally-unique content tags
// ---------------------------------------------------------------------------

const THREAD = "thr_cut_prop";

/**
 * Marker scheme: every generative row carries a unique bracketed tag
 * (`[TX3X]`, `[aNw0r]`, …) so absence/presence assertions are exact
 * substring probes over the serialized wire bodies. Image cores are
 * additionally base64-safe (inline data: payloads) and appear in every
 * projection shape that carries the image (url, path, degradation text).
 */
const textTagOf = (turn: number): string => `[TX${turn}X]`;
const imageTagOf = (turn: number, index: number): string => `IMg${turn}z${index}`;
const callTagOf = (turn: number): string => `[cmD${turn}q]`;
const answerTagOf = (turn: number): string => `[aNw${turn}r]`;

type ImageKind = "url" | "data" | "path";

/** Journal-side content part for one generated image (promptContentSchema). */
function imagePart(kind: ImageKind, tag: string): PromptContent {
  switch (kind) {
    case "url":
      return { type: "image", url: `https://img.invalid/${tag}.png` };
    case "data":
      // The relay's inline vocabulary: data:image/<type>;base64,<payload>.
      // The payload only has to match the base64 charset — the walk passes
      // it through without decoding.
      return { type: "image", url: `data:image/png;base64,${tag}QUJD` };
    case "path":
      return { type: "localImage", path: `/staged/${tag}.png` };
  }
}

/**
 * The substrings an assembled request may carry for one image, per A4
 * consumption dispatch. A `data`-kind image degrades to a media-type-only
 * text when the relay cannot take image input, so its payload tag is only
 * expected when `supportsImageInput` is on; url/path tags ride both shapes
 * (real part or degradation text).
 */
function imageProbes(kind: ImageKind, tag: string, supportsImages: boolean): string[] {
  if (kind === "data" && !supportsImages) return [];
  return [tag];
}

interface TurnSpec {
  inputChars: number;
  images: ImageKind[];
  toolPair: boolean;
  answerChars: number;
}

const turnSpecArb: fc.Arbitrary<TurnSpec> = fc.record({
  inputChars: fc.integer({ min: 40, max: 400 }),
  images: fc.array(fc.constantFrom<ImageKind>("url", "data", "path"), { maxLength: 2 }),
  toolPair: fc.boolean(),
  // A no-pair assistant slice with zero content has no wire shape (the walk
  // throws "assistant message has no content") — real turns always answer.
  answerChars: fc.integer({ min: 1, max: 400 }),
});

const journalSpecArb: fc.Arbitrary<TurnSpec[]> = fc.array(turnSpecArb, {
  minLength: 1,
  maxLength: 5,
});

interface BuiltJournal {
  events: AnyAgentEvent[];
  inputTexts: string[];
  /** Per turn: the generated image cores, in journal order. */
  imageCores: string[][];
  /** Per turn: the image kinds, index-aligned with imageCores. */
  imageKinds: ImageKind[][];
  inputSeqs: number[];
  /** Per turn: the tool pair's executionId, null when the turn has no pair. */
  pairExecutionIds: (string | null)[];
  answerTexts: string[];
}

/** Event sink shared by the journal builders: gapless local seq assignment. */
function rowFactory(prefix: string) {
  let seq = 0;
  return (threadId: string, type: string, data: unknown): AnyAgentEvent => {
    seq += 1;
    return parseAgentEvent({
      id: `${prefix}${seq}`,
      threadId,
      seq,
      type,
      data,
      createdAt: 1_700_000_000_000 + seq,
    });
  };
}

function buildJournal(specs: readonly TurnSpec[]): BuiltJournal {
  const row = rowFactory("evt_p550_");
  const events: AnyAgentEvent[] = [
    row(THREAD, "thread.created", { title: "prop", machineId: THREAD }),
  ];
  const inputTexts: string[] = [];
  const imageCores: string[][] = [];
  const imageKinds: ImageKind[][] = [];
  const inputSeqs: number[] = [];
  const pairExecutionIds: (string | null)[] = [];
  const answerTexts: string[] = [];

  for (let index = 0; index < specs.length; index++) {
    const spec = specs[index];
    if (spec === undefined) throw new Error("unreachable spec");
    const turnId = `t${index}`;
    const cores = spec.images.map((kind, imageIndex) => imageTagOf(index, imageIndex));
    const inputText = `q ${"x".repeat(spec.inputChars)} ${textTagOf(index)}`;
    inputTexts.push(inputText);
    imageCores.push(cores);
    imageKinds.push(spec.images);
    events.push(
      row(THREAD, "turn.input", {
        turnId,
        inputId: `in_${turnId}`,
        content: [
          { type: "text", text: inputText },
          ...spec.images.map((kind, imageIndex) => imagePart(kind, cores[imageIndex] ?? "")),
        ],
      }),
    );
    inputSeqs.push(events[events.length - 1]?.seq ?? 0);

    const started = row(THREAD, "model.call_started", { turnId, consumedSteerSeqs: [] });
    events.push(started);
    const answer = `a ${"y".repeat(spec.answerChars)} ${answerTagOf(index)}`;
    if (spec.toolPair) {
      events.push(
        row(THREAD, "model.call_completed", {
          turnId,
          modelCallId: started.seq,
          text: "",
          toolCalls: [{ name: "bash", arguments: { command: callTagOf(index) } }],
        }),
      );
      const call = row(THREAD, "tool.call", {
        turnId,
        modelCallId: started.seq,
        tool: "bash",
        arguments: { command: callTagOf(index) },
        timeoutMs: 30_000,
      });
      events.push(call);
      events.push(
        row(THREAD, "tool.result", {
          turnId,
          executionId: executionIdFor(THREAD, call.seq),
          status: "ok",
          exitCode: 0,
          output: `out ${callTagOf(index)}`,
        }),
      );
      pairExecutionIds.push(executionIdFor(THREAD, call.seq));
      answerTexts.push("");
    } else {
      events.push(
        row(THREAD, "model.call_completed", {
          turnId,
          modelCallId: started.seq,
          text: answer,
          toolCalls: [],
        }),
      );
      pairExecutionIds.push(null);
      answerTexts.push(answer);
    }
    events.push(row(THREAD, "turn.completed", { turnId }));
  }

  return {
    events,
    inputTexts,
    imageCores,
    imageKinds,
    inputSeqs,
    pairExecutionIds,
    answerTexts,
  };
}

/**
 * Budgets that force the keepRecent crossing at every turn boundary of the
 * journal (plus the fits-the-budget pole). Deterministic sweep per journal —
 * the generator owns shapes, the sweep owns the boundary positions.
 */
function sweepBudgets(events: readonly AnyAgentEvent[]): number[] {
  const slices = turnSlices(events);
  const budgets = [1];
  let accumulated = 0;
  for (const slice of slices) {
    accumulated += slice.estimatedTokens;
    // A budget one past this prefix crosses exactly at this turn's end, so
    // the boundary lands at each turn start across the sweep.
    budgets.push(accumulated + 1);
  }
  budgets.push(accumulated * 4 + 1_000_000);
  return budgets;
}

/** All content tags a turn's rows produce (probe vocabulary per turn). */
function tagsOfTurn(built: BuiltJournal, index: number): string[] {
  const tags = [textTagOf(index)];
  tags.push(...(built.imageCores[index] ?? []));
  if (built.pairExecutionIds[index] !== null) tags.push(callTagOf(index));
  const answer = built.answerTexts[index];
  if (answer !== "") tags.push(answerTagOf(index));
  return tags;
}

/**
 * Append the #309 checkpoint (when a plan exists) and the post-cut retry
 * turn, then project the retry call's ModelRequest — the cut-assembly face
 * every property below asserts over. Returns the armed boundary so callers
 * can partition hidden/kept turns.
 */
function assemblePostCut(
  built: BuiltJournal,
  plan: CompactCutPlan | undefined,
): { request: ModelRequest; events: AnyAgentEvent[]; hideThroughSeq: number } {
  let seq = built.events.length;
  const row = (type: string, data: unknown): AnyAgentEvent => {
    seq += 1;
    return parseAgentEvent({
      id: `evt_p550c_${seq}`,
      threadId: THREAD,
      seq,
      type,
      data,
      createdAt: 1_700_000_000_000 + seq,
    });
  };
  const rows: AnyAgentEvent[] = [...built.events];
  const hideThroughSeq = plan === undefined ? -1 : plan.hideThroughSeq;
  if (plan !== undefined) {
    rows.push(
      row("thread/compacted", {
        turnId: "t_compact",
        hideThroughSeq: plan.hideThroughSeq,
        tokensBefore: null,
        tokensAfter: 1_000,
        contextWindow: 200_000,
        method: "manual",
      }),
    );
  }
  rows.push(
    row("turn.input", {
      turnId: "t_retry",
      inputId: "in_retry",
      content: [{ type: "text", text: "retry after compact [TXRX]" }],
    }),
  );
  const started = row("model.call_started", { turnId: "t_retry", consumedSteerSeqs: [] });
  rows.push(started);
  const events = rows;
  return {
    request: modelRequestFromEvents(events, "t_retry", started.seq),
    events,
    hideThroughSeq,
  };
}

/** Hidden/kept turn-index partition of the journal under the armed boundary. */
function partitionTurns(
  built: BuiltJournal,
  hideThroughSeq: number,
): { kept: number[]; hidden: number[] } {
  const kept: number[] = [];
  const hidden: number[] = [];
  for (const { seq, index } of built.inputSeqs.map((seq, index) => ({ seq, index }))) {
    if (seq <= hideThroughSeq) hidden.push(index);
    else kept.push(index);
  }
  return { kept, hidden };
}

// ---------------------------------------------------------------------------
// Face 1 — image/attachment over the cut boundary
// ---------------------------------------------------------------------------

describe("#550 image over the cut boundary (property)", () => {
  test("post-cut priorTurns carry exactly the kept images — never a hidden turn's", () => {
    fc.assert(
      fc.property(journalSpecArb, (specs) => {
        const built = buildJournal(specs);
        for (const budget of sweepBudgets(built.events)) {
          const plan = planCompactCut(built.events, budget);
          const { request, hideThroughSeq } = assemblePostCut(built, plan);
          const { kept } = partitionTurns(built, hideThroughSeq);

          // Structural: the projection carries exactly the kept turns, in
          // order, each with exactly that turn's image cores.
          const priorTurns = request.priorTurns ?? [];
          expect(priorTurns).toHaveLength(kept.length);
          for (let position = 0; position < kept.length; position++) {
            const turnIndex = kept[position];
            const priorTurn = priorTurns[position];
            if (turnIndex === undefined || priorTurn === undefined) {
              throw new Error("unreachable prior turn");
            }
            expect(priorTurn.input).toBe(built.inputTexts[turnIndex]);
            const imageJson = JSON.stringify(priorTurn.images);
            for (const core of built.imageCores[turnIndex] ?? []) {
              expect(imageJson).toContain(core);
            }
            // No image from any other kept turn bleeds into this one.
            const otherCores = kept
              .filter((other) => other !== turnIndex)
              .flatMap((other) => built.imageCores[other] ?? []);
            for (const core of otherCores) {
              expect(imageJson).not.toContain(core);
            }
          }

          // Wire faces: hidden turns' images (and text) appear nowhere —
          // no dangling references across the boundary.
          const options = {
            model: "mock-model",
            maxTokens: 128,
            supportsImageInput: true,
          } as const;
          const bodies = [
            JSON.stringify(anthropicRequestBody(request, options)),
            JSON.stringify(responsesRequestBody(request, { ...options, reasoningEffort: "low" })),
            JSON.stringify(completionsRequestBody(request, { ...options, reasoningEffort: "low" })),
          ];
          const { hidden } = partitionTurns(built, hideThroughSeq);
          for (const body of bodies) {
            for (const turnIndex of hidden) {
              for (const tag of tagsOfTurn(built, turnIndex)) {
                expect(body).not.toContain(tag);
              }
            }
          }
        }
      }),
      { numRuns: 40 },
    );
  });

  test("kept images render on the wire in every A4 consumption shape", () => {
    fc.assert(
      fc.property(journalSpecArb, fc.boolean(), (specs, supportsImages) => {
        const built = buildJournal(specs);
        for (const budget of sweepBudgets(built.events)) {
          const plan = planCompactCut(built.events, budget);
          const { request, hideThroughSeq } = assemblePostCut(built, plan);
          const { kept } = partitionTurns(built, hideThroughSeq);

          const options = {
            model: "mock-model",
            maxTokens: 128,
            supportsImageInput: supportsImages,
          };
          const bodies = [
            JSON.stringify(anthropicRequestBody(request, options)),
            JSON.stringify(responsesRequestBody(request, { ...options, reasoningEffort: "low" })),
            JSON.stringify(completionsRequestBody(request, { ...options, reasoningEffort: "low" })),
          ];
          for (const body of bodies) {
            for (const turnIndex of kept) {
              const cores = built.imageCores[turnIndex] ?? [];
              const kinds = built.imageKinds[turnIndex] ?? [];
              for (let imageIndex = 0; imageIndex < cores.length; imageIndex++) {
                const tag = cores[imageIndex];
                const kind = kinds[imageIndex];
                if (tag === undefined || kind === undefined) throw new Error("unreachable image");
                for (const probe of imageProbes(kind, tag, supportsImages)) {
                  expect(body).toContain(probe);
                }
              }
            }
          }
        }
      }),
      { numRuns: 40 },
    );
  });

  test("token estimation counts image bytes — blob-detoured results budget their size", () => {
    const encoder = new TextEncoder();
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 4_000_000 }),
        fc.integer({ min: 1, max: 400 }),
        fc.integer({ min: 0, max: 200 }),
        (blobSize, inputChars, answerChars) => {
          const inputText = `q ${"x".repeat(inputChars)} ${textTagOf(0)}`;
          const answerText = `a ${"y".repeat(answerChars)}`;
          const toolTurn = (
            output: string | { __blob__: { key: string; size: number; sha256: string } },
          ): AnyAgentEvent[] => {
            const row = rowFactory("evt_p550b_");
            const rows: AnyAgentEvent[] = [
              row(THREAD, "turn.input", {
                turnId: "t0",
                inputId: "in_t0",
                content: [{ type: "text", text: inputText }],
              }),
            ];
            const started = row(THREAD, "model.call_started", {
              turnId: "t0",
              consumedSteerSeqs: [],
            });
            rows.push(started);
            rows.push(
              row(THREAD, "model.call_completed", {
                turnId: "t0",
                modelCallId: started.seq,
                text: answerText,
                toolCalls: [{ name: "bash", arguments: { command: callTagOf(0) } }],
              }),
            );
            const call = row(THREAD, "tool.call", {
              turnId: "t0",
              modelCallId: started.seq,
              tool: "bash",
              arguments: { command: callTagOf(0) },
              timeoutMs: 30_000,
            });
            rows.push(call);
            rows.push(
              row(THREAD, "tool.result", {
                turnId: "t0",
                executionId: executionIdFor(THREAD, call.seq),
                status: "ok",
                exitCode: 0,
                output,
              }),
            );
            rows.push(row(THREAD, "turn.completed", { turnId: "t0" }));
            return rows;
          };

          const withBlob = estimateTurnTokens(
            toolTurn({ __blob__: { key: `k${blobSize}`, size: blobSize, sha256: "s" } }),
          );
          const twin = estimateTurnTokens(toolTurn(""));
          const otherBytes =
            encoder.encode(inputText).byteLength +
            encoder.encode(answerText).byteLength +
            encoder.encode(JSON.stringify({ command: callTagOf(0) })).byteLength;
          // Exact bytes/4 pin: the blob's real byte size rides the estimate
          // (image bytes count where the result detours), and the string
          // twin proves the blob ref itself adds nothing beyond size.
          expect(withBlob).toBe(Math.ceil((otherBytes + blobSize) / 4));
          expect(twin).toBe(Math.ceil(otherBytes / 4));
        },
      ),
      { numRuns: 200 },
    );
  });

  test("kernel estimator budgets user-side images at ESTIMATED_IMAGE_CHARS each", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 500 }),
        fc.integer({ min: 0, max: 3 }),
        (textChars, images) => {
          const message: PortMessage = { role: "user", text: "u".repeat(textChars), images };
          expect(estimateTokens(message)).toBe(
            Math.ceil((textChars + images * ESTIMATED_IMAGE_CHARS) / 4),
          );
        },
      ),
      { numRuns: 200 },
    );
  });
});

// ---------------------------------------------------------------------------
// Face 2 — summarizer failure paths (rig)
// ---------------------------------------------------------------------------

const SUMMARY = "SUMMARY-550: the summary text.";
const OVERFLOW_MESSAGE =
  'relay http 400: {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 190000 tokens > 200000 maximum"}}';

function compactedRows(events: readonly AnyAgentEvent[]) {
  return events.filter(
    (event): event is Extract<AnyAgentEvent, { type: "thread/compacted" }> =>
      event.type === "thread/compacted",
  );
}

/** I1 on this path: seqs contiguous from 1 and the reducer replays cleanly. */
function assertJournalGapless(events: readonly AnyAgentEvent[]): void {
  const seqs = events.map((event) => event.seq);
  expect(seqs).toEqual(seqs.map((_, index) => index + 1));
  expect(() => replayEvents(events)).not.toThrow();
}

/** Every tool pair sits wholly on one side of the boundary (#326 helper). */
function assertPairsUncut(events: readonly AnyAgentEvent[], hideThroughSeq: number): void {
  const callSeqByExecution = new Map<string, number>();
  for (const event of events) {
    if (event.type === "tool.call") {
      callSeqByExecution.set(executionIdFor(event.threadId, event.seq), event.seq);
    }
  }
  for (const event of events) {
    if (event.type !== "tool.result") continue;
    const callSeq = callSeqByExecution.get(event.data.executionId);
    if (callSeq === undefined) continue;
    expect(
      callSeq <= hideThroughSeq,
      `pair ${event.data.executionId} split at ${hideThroughSeq} (call ${callSeq}, result ${event.seq})`,
    ).toBe(event.seq <= hideThroughSeq);
  }
}

/** The retry compact sealed exactly one checkpoint with a turn-start boundary. */
async function assertRetrySealsOneCheckpoint(rig: Rig, clientRequestId: string): Promise<void> {
  const retried = await rig.stub.compactThread({ clientRequestId, keepRecentTokens: 1 });
  await rig.waitTurnComplete(retried.turnId);
  const events = await rig.events();
  const markers = compactedRows(events);
  expect(markers).toHaveLength(1);
  const marker = markers[0];
  if (marker === undefined) throw new Error("unreachable marker");
  expect(marker.data.turnId).toBe(retried.turnId);
  expect(retried.duplicated).toBe(false);
  const retryInputSeq = events.find(
    (event) => event.type === "turn.input" && event.data.turnId === retried.turnId,
  )?.seq;
  expect(marker.data.hideThroughSeq).toBeLessThan(retryInputSeq ?? 0);
  assertPairsUncut(events, marker.data.hideThroughSeq);
  assertJournalGapless(events);
}

describe("#550 summarizer failure paths (rig)", () => {
  afterEach(() => {
    resetRuntime();
  });

  test("a summarizer model-call failure lands zero checkpoints and stays retryable", async () => {
    const rig = await createRig({
      turns: [
        { deltas: ["answer one"] },
        { deltas: ["answer two"] },
        { failBeforeFirstByte: { message: "summarizer boom", retryable: false } },
        { deltas: [SUMMARY] },
      ],
      watchdog: { retryBackoffBaseMs: 1 },
    });
    for (const label of ["p2a-seed-1", "p2a-seed-2"]) {
      const seed = await rig.stub.sendMessage({
        clientRequestId: label,
        content: [{ type: "text", text: `seed ${label}` }],
        mode: "start",
      });
      await rig.waitTurnComplete(seed.turnId);
    }

    const failed = await rig.stub.compactThread({ keepRecentTokens: 1 });
    await rig.waitTurnComplete(failed.turnId);
    const events = await rig.events();
    // Zero thread/compacted rows: the checkpoint only lands after a usable
    // summary, never on the failure face.
    expect(compactedRows(events)).toHaveLength(0);
    expect(
      events.some(
        (event) =>
          event.type === "model.call_failed" &&
          event.data.turnId === failed.turnId &&
          event.data.error === "summarizer boom" &&
          !event.data.retryable,
      ),
    ).toBe(true);
    expect(
      events.some(
        (event) =>
          event.type === "turn.failed" &&
          event.data.turnId === failed.turnId &&
          event.data.reason === "model_error",
      ),
    ).toBe(true);
    assertJournalGapless(events);

    // Retryable: the same RPC succeeds on the next call.
    await assertRetrySealsOneCheckpoint(rig, "p2a-retry");
  });

  test("the summarizer's own overflow exhausts the retry ladder and stays retryable", async () => {
    const rig = await createRig({
      turns: [
        { deltas: ["answer one"] },
        { deltas: ["answer two"] },
        { failBeforeFirstByte: { message: OVERFLOW_MESSAGE } },
        { failBeforeFirstByte: { message: OVERFLOW_MESSAGE } },
        { failBeforeFirstByte: { message: OVERFLOW_MESSAGE } },
        { deltas: [SUMMARY] },
      ],
      watchdog: { retryBackoffBaseMs: 1 },
    });
    for (const label of ["p2b-seed-1", "p2b-seed-2"]) {
      const seed = await rig.stub.sendMessage({
        clientRequestId: label,
        content: [{ type: "text", text: `seed ${label}` }],
        mode: "start",
      });
      await rig.waitTurnComplete(seed.turnId);
    }

    const failed = await rig.stub.compactThread({ keepRecentTokens: 1 });
    await rig.waitTurnComplete(failed.turnId);
    let events = await rig.events();
    // Zero checkpoints on the overflow face; the ladder retried exactly
    // maxPreFirstByteRetries (2) times, then failed the turn honestly.
    expect(compactedRows(events)).toHaveLength(0);
    expect(isContextOverflowFailure(OVERFLOW_MESSAGE)).toBe(true);
    expect(
      events.filter(
        (event) =>
          event.type === "model.call_failed" &&
          event.data.turnId === failed.turnId &&
          event.data.error === OVERFLOW_MESSAGE,
      ),
    ).toHaveLength(3);
    expect(
      events.filter(
        (event) => event.type === "model.call_retry" && event.data.turnId === failed.turnId,
      ),
    ).toHaveLength(2);
    expect(
      events.some(
        (event) =>
          event.type === "turn.failed" &&
          event.data.turnId === failed.turnId &&
          event.data.reason === "model_error",
      ),
    ).toBe(true);
    assertJournalGapless(events);

    // The failed compact turn leaves the thread usable: a normal turn
    // completes, still without any checkpoint.
    const normal = await rig.stub.sendMessage({
      clientRequestId: "p2b-normal",
      content: [{ type: "text", text: "still here" }],
      mode: "start",
    });
    await rig.waitTurnComplete(normal.turnId);
    events = await rig.events();
    expect(compactedRows(events)).toHaveLength(0);
    expect(normal.duplicated).toBe(false);

    // And the compact itself is retryable: the next RPC seals the checkpoint.
    await assertRetrySealsOneCheckpoint(rig, "p2b-retry");
  });
});

// ---------------------------------------------------------------------------
// Face 3 — responses/completions post-cut assembly equivalence
// ---------------------------------------------------------------------------

interface FaceFingerprint {
  /** Ordered user+assistant text content (degradation texts included). */
  texts: string[];
  /** Ordered image parts, normalized: `url:…` or `data:<type>:<payload>`. */
  images: string[];
  /** Ordered tool-call wire ids. */
  calls: string[];
  /** Ordered tool-result wire ids answering the calls. */
  results: string[];
}

function normalizeImageRef(ref: string): string {
  const inline = /^data:(image\/[^;]+);base64,(.*)$/.exec(ref);
  if (inline !== null) {
    return `data:${inline[1]}:${inline[2] ?? ""}`;
  }
  return `url:${ref}`;
}

function anthropicFingerprint(body: AnthropicRequestBody): FaceFingerprint {
  const fingerprint: FaceFingerprint = { texts: [], images: [], calls: [], results: [] };
  for (const message of body.messages) {
    for (const block of message.content) {
      if (block.type === "text") {
        fingerprint.texts.push(block.text);
      } else if (block.type === "image") {
        if (block.source.type === "url") {
          fingerprint.images.push(normalizeImageRef(block.source.url));
        } else {
          fingerprint.images.push(`data:${block.source.media_type}:${block.source.data}`);
        }
      } else if (block.type === "tool_use") {
        fingerprint.calls.push(block.id);
      } else {
        fingerprint.results.push(block.tool_use_id);
      }
    }
  }
  return fingerprint;
}

function responsesFingerprint(body: ResponsesRequestBody): FaceFingerprint {
  const fingerprint: FaceFingerprint = { texts: [], images: [], calls: [], results: [] };
  for (const item of body.input) {
    if (item.type === "function_call") {
      fingerprint.calls.push(item.call_id);
    } else if (item.type === "function_call_output") {
      fingerprint.results.push(item.call_id);
    } else {
      for (const part of item.content) {
        if (part.type === "input_text") fingerprint.texts.push(part.text);
        else if (part.type === "input_image")
          fingerprint.images.push(normalizeImageRef(part.image_url));
        else fingerprint.texts.push(part.text);
      }
    }
  }
  return fingerprint;
}

function completionsFingerprint(body: CompletionsRequestBody): FaceFingerprint {
  const fingerprint: FaceFingerprint = { texts: [], images: [], calls: [], results: [] };
  for (const message of body.messages) {
    if (message.role === "tool") {
      const callId = message.tool_call_id;
      if (callId !== undefined) fingerprint.results.push(callId);
    } else if (message.role === "assistant") {
      if (typeof message.content === "string") fingerprint.texts.push(message.content);
      for (const call of message.tool_calls ?? []) {
        fingerprint.calls.push(call.id);
      }
    } else if (message.role === "user") {
      if (typeof message.content === "string") {
        fingerprint.texts.push(message.content);
      } else if (message.content !== null) {
        for (const part of message.content) {
          if (part.type === "text") fingerprint.texts.push(part.text);
          else fingerprint.images.push(normalizeImageRef(part.image_url.url));
        }
      }
    }
  }
  return fingerprint;
}

function sortedIds(ids: readonly string[]): string[] {
  return [...ids].sort();
}

describe("#550 responses/completions post-cut assembly equivalence (property)", () => {
  test("both OpenAI faces repeat the anthropic assertions over the same cut request", () => {
    fc.assert(
      fc.property(journalSpecArb, fc.boolean(), (specs, supportsImages) => {
        const built = buildJournal(specs);
        for (const budget of sweepBudgets(built.events)) {
          const plan = planCompactCut(built.events, budget);
          const { request, hideThroughSeq } = assemblePostCut(built, plan);
          const { kept, hidden } = partitionTurns(built, hideThroughSeq);

          const options = {
            model: "mock-model",
            maxTokens: 128,
            supportsImageInput: supportsImages,
          };
          const anthropicBody = anthropicRequestBody(request, options);
          const responsesBody = responsesRequestBody(request, {
            ...options,
            reasoningEffort: "low",
          });
          const completionsBody = completionsRequestBody(request, {
            ...options,
            reasoningEffort: "low",
          });
          const anthropicPrint = anthropicFingerprint(anthropicBody);
          const responsesPrint = responsesFingerprint(responsesBody);
          const completionsPrint = completionsFingerprint(completionsBody);

          // Equivalence: the three faces project the same ordered content —
          // texts, images, tool calls, tool results (the anthropic face is
          // the reference the other two must repeat).
          expect(responsesPrint).toEqual(anthropicPrint);
          expect(completionsPrint).toEqual(anthropicPrint);

          // Pair integrity per face: every tool call is answered exactly
          // once (translate's pairing invariant, repeated on the wire).
          for (const print of [anthropicPrint, responsesPrint, completionsPrint]) {
            expect(sortedIds(print.calls)).toEqual(sortedIds(print.results));
          }

          // Hidden span absent on every face; kept span present.
          const bodies = [
            JSON.stringify(anthropicBody),
            JSON.stringify(responsesBody),
            JSON.stringify(completionsBody),
          ];
          for (const body of bodies) {
            for (const turnIndex of hidden) {
              for (const tag of tagsOfTurn(built, turnIndex)) {
                expect(body).not.toContain(tag);
              }
            }
            for (const turnIndex of kept) {
              expect(body).toContain(textTagOf(turnIndex));
              if (built.pairExecutionIds[turnIndex] !== null) {
                expect(body).toContain(callTagOf(turnIndex));
              }
              const answer = built.answerTexts[turnIndex];
              if (answer !== "") expect(body).toContain(answerTagOf(turnIndex));
            }
          }
        }
      }),
      { numRuns: 40 },
    );
  });

  test("the armed marker is journal-derived: threadCompactedCut agrees with the assembly", () => {
    fc.assert(
      fc.property(journalSpecArb, fc.integer({ min: 1, max: 4_000 }), (specs, budget) => {
        const built = buildJournal(specs);
        const plan = planCompactCut(built.events, budget);
        const { events, hideThroughSeq } = assemblePostCut(built, plan);
        const cut = threadCompactedCut(events, "t_retry");
        if (plan === undefined) {
          expect(cut).toBeUndefined();
          expect(hideThroughSeq).toBe(-1);
        } else {
          expect(cut).toBeDefined();
          expect(cut?.hideThroughSeq).toBe(plan.hideThroughSeq);
          expect(hideThroughSeq).toBe(plan.hideThroughSeq);
        }
      }),
      { numRuns: 60 },
    );
  });
});

// ---------------------------------------------------------------------------
// Face 4 — kept-tail tool-pair integrity
// ---------------------------------------------------------------------------

describe("#550 kept-tail tool-pair integrity (property)", () => {
  test("no budget splits a pair; the first kept turn assembles whole with its pair", () => {
    fc.assert(
      fc.property(journalSpecArb, (specs) => {
        const built = buildJournal(specs);
        for (const budget of sweepBudgets(built.events)) {
          const plan = planCompactCut(built.events, budget);
          if (plan === undefined) continue;
          assertPairsUncut(built.events, plan.hideThroughSeq);

          // The boundary is always a turn start (the kept tail begins at a
          // turn.input row).
          expect(built.inputSeqs).toContain(plan.firstKeptTurnInputSeq);

          // "find turn" assembly: the found/crossing turn — the OLDEST of
          // the kept tail — rides the post-cut request whole, pair included.
          const { request } = assemblePostCut(built, plan);
          const firstKeptIndex = built.inputSeqs.indexOf(plan.firstKeptTurnInputSeq);
          if (firstKeptIndex < 0) throw new Error("unreachable first kept turn");
          const firstKeptTurn = (request.priorTurns ?? [])[0];
          expect(firstKeptTurn?.input).toBe(built.inputTexts[firstKeptIndex]);
          const pair = built.pairExecutionIds[firstKeptIndex];
          // One model call per generated turn; the tool pair lives inside
          // its slice (toolCalls index-aligned with toolResults).
          expect(firstKeptTurn?.calls).toHaveLength(1);
          const call = firstKeptTurn?.calls[0];
          if (pair !== null) {
            expect(call?.toolCalls).toHaveLength(1);
            expect(JSON.stringify(call?.toolCalls[0]?.arguments)).toContain(
              callTagOf(firstKeptIndex),
            );
            expect(call?.toolResults[0]?.executionId).toBe(pair);
          } else {
            expect(call?.toolCalls).toHaveLength(0);
            expect(call?.toolResults).toHaveLength(0);
          }
        }
      }),
      { numRuns: 40 },
    );
  });

  test("the post-cut rebuild is replay-deterministic (same log → identical request)", () => {
    fc.assert(
      fc.property(journalSpecArb, fc.integer({ min: 1, max: 4_000 }), (specs, budget) => {
        const built = buildJournal(specs);
        const plan = planCompactCut(built.events, budget);
        const first = assemblePostCut(built, plan);
        const second = assemblePostCut(built, plan);
        expect(JSON.stringify(first.request)).toBe(JSON.stringify(second.request));
        expect(first.hideThroughSeq).toBe(second.hideThroughSeq);
      }),
      { numRuns: 40 },
    );
  });

  test("kernel cut points never land on a toolResult/system row (pi isCutPointMessage)", () => {
    const kernelJournalArb = kernelJournalArbFactory(1, 12);
    fc.assert(
      fc.property(kernelJournalArb, fc.integer({ min: 0, max: 300 }), (entries, keepRecent) => {
        const result = findCutPoint(entries, 0, entries.length, keepRecent);
        const hasCutPoints = entries.some(
          (entry) =>
            entry.type === "message" &&
            entry.message.role !== "toolResult" &&
            entry.message.role !== "system",
        );
        const cut = entries[result.firstKeptEntryIndex];
        if (hasCutPoints) {
          // The kept tail always opens at a valid cut point — never a tool
          // result (it must follow its call) and never a system row.
          expect(cut?.type).toBe("message");
          if (cut?.type === "message") {
            expect(cut.message.role).not.toBe("toolResult");
            expect(cut.message.role).not.toBe("system");
          }
        }
        if (result.isSplitTurn) {
          expect(result.turnStartIndex).toBeGreaterThanOrEqual(0);
          const turnStart = entries[result.turnStartIndex];
          if (turnStart?.type === "message") {
            expect(turnStart.message.role === "user" || turnStart.message.role === "custom").toBe(
              true,
            );
          }
        }
      }),
      { numRuns: 300 },
    );
  });

  test("kernel prepareCompaction round-trip hides exactly the summarized span", () => {
    const kernelJournalArb = kernelJournalArbFactory(2, 12);
    fc.assert(
      fc.property(kernelJournalArb, (entries) => {
        const settings = { enabled: true, reserveTokens: 16_384, keepRecentTokens: 0 };
        const preparation = prepareCompaction(entries, settings);
        if (preparation === undefined) return;
        const checkpoint: CompactionEntry = {
          type: "compaction",
          id: "c_checkpoint",
          summary: "KERNEL-SUMMARY",
          firstKeptEntryId: preparation.firstKeptEntryId,
        };
        const context = buildSessionContext([...entries, checkpoint]);
        // Summary first (omp session-context 339-343), then the kept tail.
        expect(context.messages[0]).toEqual({ role: "user", text: "KERNEL-SUMMARY" });
        // Nothing the summarizer consumed reappears in the rebuilt context.
        const hidden = [...preparation.messagesToSummarize, ...preparation.turnPrefixMessages];
        for (const message of context.messages) {
          expect(hidden).not.toContain(message);
        }
      }),
      { numRuns: 300 },
    );
  });
});

// ---------------------------------------------------------------------------
// Kernel journal generator (face 4 kernel properties)
// ---------------------------------------------------------------------------

const kernelRoleArb = fc.constantFrom<"user" | "assistant" | "toolResult" | "custom" | "system">(
  "user",
  "assistant",
  "toolResult",
  "custom",
  "system",
);

/** Arbitrary kernel entry streams: message rows of every role, no compactions. */
function kernelJournalArbFactory(minLength: number, maxLength: number): fc.Arbitrary<PortEntry[]> {
  return fc
    .array(
      fc.record({
        role: kernelRoleArb,
        textLen: fc.integer({ min: 1, max: 60 }),
        withCall: fc.boolean(),
      }),
      { minLength, maxLength },
    )
    .map((rows) =>
      rows.map((row, index): PortEntry => {
        const message: PortMessage =
          row.role === "assistant"
            ? {
                role: "assistant",
                text: "a".repeat(row.textLen),
                ...(row.withCall
                  ? { toolCall: { name: "bash", argsJson: JSON.stringify({ i: index }) } }
                  : {}),
              }
            : row.role === "toolResult"
              ? { role: "toolResult", text: "r".repeat(row.textLen), toolCallId: `c${index}` }
              : { role: row.role, text: "u".repeat(row.textLen) };
        return { type: "message", id: `e${index}`, message };
      }),
    );
}
