import { afterEach, beforeAll, afterAll, describe, expect, test } from "vitest";
import { http, HttpResponse } from "msw";
import { setupNetwork } from "@msw/cloudflare";
import { abortAllDurableObjects, runInDurableObject } from "cloudflare:test";
import { createRig, resetRuntime } from "./helpers.js";
import type { AnyAgentEvent } from "../src/fsm-events.js";
import { executionIdFor } from "../src/ids.js";
import {
  DEFAULT_GENERATE_IMAGE_CONFIG,
  MAX_IMAGE_TIMEOUT_SECONDS,
  assemblePrompt,
  decodeGenerateImageConfig,
  resolveOpenAIImageSize,
  runGenerateImageTool,
  type GenerateImageToolContext,
} from "../src/tools/generate-image.js";
import { M0_RENDER_FLAGS, wireToolSet } from "../src/tools/registry.js";

/**
 * B2 (#322) — the generate_image edge tool: the omp imageGenTool surface
 * (image-gen.ts verbatim schema/description/prompt assembly) over one
 * env-resolved OpenAI-compatible image source, the `openai-images` JSON
 * transport (generations / edits+404 fallback), and the save leg through
 * the daemon-service thread-file write seam whose absolute path feeds the
 * B1 imageView journal fold (ingestResult — rows land before tool.result).
 */

const network = setupNetwork();

beforeAll(() => {
  network.enable();
});

afterEach(() => {
  resetRuntime();
  network.resetHandlers();
});

afterAll(() => {
  network.disable();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** 1×1 PNG, base64 (magic-byte sniffable). */
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const IMAGE_API = "https://images.example.com/v1";

const CONFIG = {
  baseUrl: IMAGE_API,
  apiKey: "img-key",
  model: "gpt-image-1",
  timeoutSeconds: 180,
};

interface Seams {
  writes: { filename: string; contentBase64: string }[];
  writeResult?: { kind: "ok"; path: string } | { kind: "error"; errorCode: string; errorMessage: string };
  readResult?: { kind: "ok"; content: string; contentEncoding: "base64"; mimeType: string } | { kind: "error"; errorCode: string; errorMessage: string };
}

function ctxFrom(seams: Seams, signal = new AbortController().signal): GenerateImageToolContext {
  return {
    config: CONFIG,
    signal,
    fetchImpl: (input, init) => fetch(input, init),
    writeThreadFile: async ({ filename, contentBase64 }) => {
      seams.writes.push({ filename, contentBase64 });
      return (
        seams.writeResult ?? { kind: "ok", path: `/host/root/thr/Generated/${filename}` }
      );
    },
    readThreadFile: async ({ path }) =>
      seams.readResult ?? {
        kind: "ok",
        content: PNG_B64,
        contentEncoding: "base64",
        mimeType: "image/png",
      },
  };
}

/**
 * Module-level wire capture: MSW handler closures and the test body share
 * this worker's module instance, and (observed) handler registration can
 * outlive afterEach's reset — one shared array sees every request exactly
 * once, so assertions read the current test's entries from the tail.
 */
const wireBodies: { url: string; body: unknown }[] = [];

function generationsHandler(responder: () => Response): void {
  network.use(
    http.post(`${IMAGE_API}/images/generations`, async ({ request }) => {
      wireBodies.push({ url: request.url, body: await request.json() });
      return responder();
    }),
  );
  network.use(
    http.post(`${IMAGE_API}/images/edits`, async ({ request }) => {
      wireBodies.push({ url: request.url, body: await request.json() });
      return responder();
    }),
  );
}

// ---------------------------------------------------------------------------
// Pure layer — omp verbatim pieces
// ---------------------------------------------------------------------------

describe("B2 — omp imageGenTool surface is verbatim", () => {
  test("schema, description, and wire position follow omp (custom tool before the hidden tail)", () => {
    const tools = wireToolSet(M0_RENDER_FLAGS);
    const names = tools.map((tool) => tool.name);
    expect(names.indexOf("generate_image")).toBe(names.indexOf("manage_skill") + 1);
    expect(names[names.length - 1]).toBe("yield");
    const row = tools.find((tool) => tool.name === "generate_image");
    expect(row?.description).toBe(
      [
        "Generates or edits images with the configured image-model role.",
        "",
        "<instruction>",
        "- Write one detailed `subject` for generation or editing.",
        "- Multiple `input`: identify each image's role in `subject` (for example, `Image 1` composition; `Image 2` lighting).",
        "- Specific catalog model required? Set `model`; otherwise omit it.",
        '- Text: request "sharp, legible, correctly spelled"; keep it short.',
        "</instruction>",
      ].join("\n"),
    );
    // One boundary read of the rendered wire doc; named for the reason.
    const schema = row?.input_schema as {
      required?: string[];
      properties: Record<string, unknown>;
    };
    expect(schema.required).toEqual(["subject", "i"]);
    expect(Object.keys(schema.properties).sort()).toEqual(
      [
        "action",
        "aspect_ratio",
        "changes",
        "composition",
        "i",
        "image_size",
        "input",
        "lighting",
        "model",
        "scene",
        "style",
        "subject",
        "text",
      ].sort(),
    );
  });

  test("assemblePrompt is omp image-gen.ts:68-81 verbatim", () => {
    expect(assemblePrompt({ subject: "a cat." })).toBe("a cat.");
    expect(
      assemblePrompt({
        subject: "a cat",
        action: "sleeping",
        scene: "a windowsill",
        composition: "close-up",
        lighting: "golden hour",
        style: "watercolor",
        text: "MEOW",
        changes: ["make it fluffier"],
      }),
    ).toBe(
      "a cat, sleeping, a windowsill. close-up. golden hour. watercolor.\n\nText: MEOW\n\nChanges:\n- make it fluffier",
    );
  });

  test("resolveOpenAIImageSize is omp shared.ts:184-198 verbatim", () => {
    expect(resolveOpenAIImageSize("1:1")).toBe("1024x1024");
    expect(resolveOpenAIImageSize("9:16")).toBe("1024x1536");
    expect(resolveOpenAIImageSize("16:9")).toBe("1536x1024");
    expect(resolveOpenAIImageSize("3:2")).toBeUndefined();
    expect(resolveOpenAIImageSize("3:2", "1024x1536")).toBe("1024x1536");
  });
});

describe("B2 — env config (AGENT_DO_IMAGE_SOURCE)", () => {
  test("absent env keeps the ruled default; a patch overrides; timeout clamps", () => {
    expect(decodeGenerateImageConfig(undefined)).toEqual(DEFAULT_GENERATE_IMAGE_CONFIG);
    const decoded = decodeGenerateImageConfig(
      JSON.stringify({ baseUrl: `${IMAGE_API}/`, apiKey: "k", model: "m", timeoutSeconds: 9999 }),
    );
    expect(decoded).toEqual({
      baseUrl: IMAGE_API,
      apiKey: "k",
      model: "m",
      timeoutSeconds: MAX_IMAGE_TIMEOUT_SECONDS,
    });
  });

  test("shape violations throw (the web_search construction posture)", () => {
    expect(() => decodeGenerateImageConfig("{not-json")).toThrow();
    expect(() => decodeGenerateImageConfig(JSON.stringify({ apiKey: "k" }))).toThrow();
    expect(() =>
      decodeGenerateImageConfig(JSON.stringify({ baseUrl: "not a url", apiKey: "k", model: "m" })),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Executor — transport + save leg over the fake seams
// ---------------------------------------------------------------------------

describe("B2 — runGenerateImageTool", () => {
  test("text-to-image posts the omp generation body and lands the file through the write seam", async () => {
    wireBodies.length = 0;
    generationsHandler(() =>
      HttpResponse.json({ data: [{ b64_json: PNG_B64, media_type: "image/png" }] }),
    );
    const seams: Seams = { writes: [] };
    const result = await runGenerateImageTool(
      { subject: "a lighthouse", aspect_ratio: "16:9" },
      ctxFrom(seams),
    );
    expect(result.status).toBe("ok");
    expect(result.images).toEqual([{ path: `/host/root/thr/Generated/${seams.writes[0]?.filename}` }]);
    expect(result.output).toBe(
      `Model: gpt-image-1\nGenerated 1 image(s):\n  /host/root/thr/Generated/${seams.writes[0]?.filename}`,
    );
    expect(seams.writes).toHaveLength(1);
    expect(seams.writes[0]?.filename).toMatch(/^agent-image-\d+-1\.png$/);
    expect(wireBodies).toEqual([
      {
        url: `${IMAGE_API}/images/generations`,
        body: {
          model: "gpt-image-1",
          prompt: "a lighthouse.",
          n: 1,
          response_format: "b64_json",
          size: "1536x1024",
        },
      },
    ]);
  });

  test("a per-request model overrides the configured one; url responses download eagerly", async () => {
    generationsHandler(() =>
      HttpResponse.json({ data: [{ url: "https://cdn.example.com/pic.png" }] }),
    );
    network.use(
      http.get("https://cdn.example.com/pic.png", () =>
        new HttpResponse(new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer, {
          headers: { "content-type": "image/png" },
        }),
      ),
    );
    const seams: Seams = { writes: [] };
    const result = await runGenerateImageTool({ subject: "a cat", model: "other-img" }, ctxFrom(seams));
    expect(result.status).toBe("ok");
    expect(seams.writes[0]?.filename).toMatch(/\.png$/);
    expect(atob(seams.writes[0]?.contentBase64 ?? "")).toBe("\u0089PNG");
    expect(wireBodies.at(-1)?.body).toMatchObject({ model: "other-img" });
  });

  test("an empty data array is a normal zero-image ok result (omp buildToolResult)", async () => {
    generationsHandler(() => HttpResponse.json({ data: [] }));
    const result = await runGenerateImageTool({ subject: "nothing" }, ctxFrom({ writes: [] }));
    expect(result).toEqual({ status: "ok", output: "No image data returned." });
  });

  test("provider HTTP failures surface as omp-anchored error text", async () => {
    generationsHandler(() =>
      HttpResponse.json({ error: { message: "quota exhausted" } }, { status: 429 }),
    );
    const result = await runGenerateImageTool({ subject: "x" }, ctxFrom({ writes: [] }));
    expect(result.status).toBe("error");
    expect(result.output).toBe(
      "Error: gpt-image-1 image request failed (429): quota exhausted",
    );
  });

  test("edit flow: data inputs ride /images/edits with input_references; 404 falls back to generations", async () => {
    wireBodies.length = 0;
    network.use(
      http.post(`${IMAGE_API}/images/edits`, async ({ request }) => {
        wireBodies.push({ url: request.url, body: await request.json() });
        return new HttpResponse(null, { status: 404 });
      }),
    );
    generationsHandler(() => HttpResponse.json({ data: [{ b64_json: PNG_B64 }] }));
    const seams: Seams = { writes: [] };
    const result = await runGenerateImageTool(
      { subject: "recolor Image 1", input: [{ data: `data:image/png;base64,${PNG_B64}` }] },
      ctxFrom(seams),
    );
    expect(result.status).toBe("ok");
    expect(wireBodies.map((entry) => entry.url)).toEqual([
      `${IMAGE_API}/images/edits`,
    ]);
    expect(wireBodies[0]?.body).toMatchObject({
      input_references: [{ type: "image_url", url: `data:image/png;base64,${PNG_B64}` }],
    });
    // The 404 fallback provably re-dialed generations: the edits handler
    // answered 404, and the call still ends ok with the image written.
    expect(seams.writes).toHaveLength(1);
  });

  test("path inputs resolve through the host-file read face; ENOENT keeps omp's text", async () => {
    generationsHandler(() => HttpResponse.json({ data: [{ b64_json: PNG_B64 }] }));
    const ok = await runGenerateImageTool(
      { subject: "edit", input: [{ path: "/host/pic.png" }] },
      ctxFrom({ writes: [] }),
    );
    expect(ok.status).toBe("ok");

    const missing = await runGenerateImageTool(
      { subject: "edit", input: [{ path: "/host/gone.png" }] },
      ctxFrom({
        writes: [],
        readResult: { kind: "error", errorCode: "ENOENT", errorMessage: "Path does not exist" },
      }),
    );
    expect(missing).toEqual({ status: "error", output: "Error: Image file not found: /host/gone.png" });
  });

  test("a failed host write is the tool's error (the provider bytes exist nowhere else)", async () => {
    generationsHandler(() => HttpResponse.json({ data: [{ b64_json: PNG_B64 }] }));
    const result = await runGenerateImageTool(
      { subject: "x" },
      ctxFrom({
        writes: [],
        writeResult: { kind: "error", errorCode: "file_too_large", errorMessage: "too big" },
      }),
    );
    expect(result.status).toBe("error");
    expect(result.output).toBe(
      "Error: image generated but could not be saved to the host (file_too_large: too big).",
    );
  });

  test("the owning call's abort surfaces as cancelled, never an Error text", async () => {
    // Deterministic abort: the owning signal is aborted BEFORE the call, so
    // the transport rejects immediately (no wall-clock waits; the executor
    // maps the aborted owner signal to `cancelled` — omp rethrow semantics).
    network.use(
      // The request never escapes — the pre-aborted signal rejects before
      // the transport dials; the handler only keeps MSW from warning.
      http.post(`${IMAGE_API}/images/generations`, () =>
        HttpResponse.json({ data: [{ b64_json: PNG_B64 }] }),
      ),
    );
    const controller = new AbortController();
    controller.abort();
    const result = await runGenerateImageTool(
      { subject: "x" },
      ctxFrom({ writes: [] }, controller.signal),
    );
    expect(result.status).toBe("cancelled");
  });
});

// ---------------------------------------------------------------------------
// Edge chain — dispatch → executor → imageView fold before tool.result
// ---------------------------------------------------------------------------

describe("B2 — the edge execution folds imageView rows (B1 chain)", () => {
  test("a generate_image tool call lands imageView rows before the closing tool.result", async () => {
    generationsHandler(() => HttpResponse.json({ data: [{ b64_json: PNG_B64 }] }));
    const rig = await createRig({
      turns: [
        { toolCalls: [{ name: "generate_image", arguments: { subject: "a lighthouse at dusk" } }] },
        { deltas: ["done"] },
      ],
    });
    // The rig's DO has no deployment env: the image source is injected into
    // the same private seam-poking channel the web-search L1 uses
    // (dispatchExecution), because AGENT_DO_* reads once at construction.
    await runInDurableObject(rig.stub, async (instance) => {
      const configSeam = instance as unknown as { generateImageConfig: unknown };
      configSeam.generateImageConfig = CONFIG;
    });
    const sent = await rig.stub.sendMessage({
      clientRequestId: "b2-fold",
      mode: "auto",
      content: [{ type: "text", text: "draw" }],
    });
    const events = await rig.waitTurnComplete(sent.turnId);

    const imageViewRows = events.filter(
      (event): event is Extract<AnyAgentEvent, { type: "imageView" }> => event.type === "imageView",
    );
    const call = events.find((event) => event.type === "tool.call");
    if (call === undefined) throw new Error("no tool.call row");
    const executionId = executionIdFor(rig.threadId, call.seq);
    const resultRow = events.find(
      (event): event is Extract<AnyAgentEvent, { type: "tool.result" }> =>
        event.type === "tool.result" && event.data.executionId === executionId,
    );
    expect(resultRow).toBeDefined();
    // journal-before-result ordering (todo_phases precedent), one row per image.
    expect(imageViewRows).toHaveLength(1);
    expect(imageViewRows[0]?.data).toMatchObject({
      turnId: sent.turnId,
      parentToolCallId: executionId,
    });
    expect(imageViewRows[0]?.data.path).toMatch(/^\/fake-host\/.*\/Generated\/agent-image-\d+-1\.png$/);
    expect(imageViewRows[0]?.seq).toBeLessThan(resultRow?.seq ?? 0);
    expect(resultRow?.data.output).toContain(imageViewRows[0]?.data.path);
    // Edge path: zero daemon dispatches (the write rode the RPC seam, not exec).
    await expect(rig.service.journal()).resolves.toEqual([]);
  });

  test("without the image source the call fails closed with the structured config error", async () => {
    const rig = await createRig({
      turns: [
        { toolCalls: [{ name: "generate_image", arguments: { subject: "x" } }] },
        { deltas: ["done"] },
      ],
    });
    const sent = await rig.stub.sendMessage({
      clientRequestId: "b2-failclosed",
      mode: "auto",
      content: [{ type: "text", text: "draw" }],
    });
    const events = await rig.waitTurnComplete(sent.turnId);
    const resultRow = events.find(
      (event): event is Extract<AnyAgentEvent, { type: "tool.result" }> =>
        event.type === "tool.result",
    );
    expect(resultRow?.data.status).toBe("error");
    expect(resultRow?.data.output).toContain("AGENT_DO_IMAGE_SOURCE");
    expect(events.some((event) => event.type === "imageView")).toBe(false);
  });

  test("eviction replay re-answers from the journal — zero second outbound fetches", async () => {
    let hits = 0;
    generationsHandler(() => {
      hits += 1;
      return HttpResponse.json({ data: [{ b64_json: PNG_B64 }] });
    });
    const rig = await createRig({
      turns: [
        { toolCalls: [{ name: "generate_image", arguments: { subject: "a lighthouse" } }] },
        { deltas: ["done"] },
      ],
    });
    await runInDurableObject(rig.stub, async (instance) => {
      const configSeam = instance as unknown as { generateImageConfig: unknown };
      configSeam.generateImageConfig = CONFIG;
    });
    const sent = await rig.stub.sendMessage({
      clientRequestId: "b2-replay",
      mode: "auto",
      content: [{ type: "text", text: "draw" }],
    });
    await rig.waitTurnComplete(sent.turnId);
    const before = await rig.events();
    expect(hits).toBe(1);

    await abortAllDurableObjects();
    const after = await rig.afterAbort(() => rig.events());
    expect(after.map((event) => [event.seq, event.type])).toEqual(
      before.map((event) => [event.seq, event.type]),
    );
    // Re-asking the terminal executionId answers from the journal (M1.5 edge
    // iron rule): the seam-poked dispatch re-run must not refetch.
    await runInDurableObject(rig.stub, async (instance) => {
      const configSeam = instance as unknown as { generateImageConfig: unknown };
      configSeam.generateImageConfig = CONFIG;
      const seam = instance as unknown as {
        dispatchExecution: (turnId: string, executionId: string) => Promise<void>;
      };
      const call = before.find((event) => event.type === "tool.call");
      if (call === undefined) throw new Error("no tool.call row");
      await seam.dispatchExecution(sent.turnId, executionIdFor(rig.threadId, call.seq));
    });
    expect(hits).toBe(1);
  });
});
