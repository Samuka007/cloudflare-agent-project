import type { EdgeToolResult } from "./edge.js";

/**
 * DO-local `generate_image` executor (B2 #322) — the edge port of omp's
 * imageGenTool (packages/coding-agent/src/tools/image-gen.ts, 18.6.0 line
 * anchors inline). omp classifies the tool `edge` (xd device,
 * omp-tool-execution-classification.md:118): the image-model API call is a
 * pure outbound transport, and the product reaches the user through the file
 * face. In omp's single-machine shape that file face is the local tempdir
 * (image-gen.ts:125-133 `omp-image-<snowflake>.<ext>`); in this split the
 * DO is the edge and the HOST disk is the file face — so the save leg rides
 * the daemon-service thread-file write RPC (`host.write_file`, B2 twin of
 * the B1 read face), and the returned absolute path feeds the imageView
 * journal fold (agent-do.ts ingestResult — the B1 event chain).
 *
 * Transport: the `openai-images` family from omp packages/ai/src/images/
 * (openai-images.ts + shared.ts) — `/images/generations` for text-to-image,
 * `/images/edits` with `input_references` data URLs for edits, a `404` from
 * the edit endpoint retrying generations with the edit payload (omp
 * openai-images.ts:103-113). The OpenAI-provider multipart branch is not
 * ported: the configured source is a relay-style endpoint (JSON in, JSON
 * out), the same population omp's JSON branch serves. Credentials/config
 * ride the panel-resolved image source (the 产图源 seat, #448) instead of
 * omp's model catalog — one resolved source, no candidate chain (omp's
 * aggregate error collapses to the single failure).
 */

/** omp image-gen.ts:25 (IMAGE_TIMEOUT) — the per-request ceiling. */
export const DEFAULT_IMAGE_TIMEOUT_SECONDS = 180;
/** The host online-RPC window for the thread-file seams — the server-worker
 * HOST_COMMAND_TIMEOUT_MS twin (services/host-files.ts:21); the DO names its
 * own so the constant travels with the seam calls. */
export const HOST_FILE_RPC_TIMEOUT_MS = 30_000;

export interface GenerateImageConfig {
  /** Base of the OpenAI-compatible images API, e.g. `https://relay/v1`
   * (trailing slashes stripped — omp shared.ts imageBaseUrl). */
  baseUrl: string;
  apiKey: string;
  /** Image model id sent as the request body's `model`. */
  model: string;
  timeoutSeconds: number;
}

/**
 * The unconfigured source (no 产图源 seat, or a seat on an incomplete row):
 * the executor answers honestly instead of guessing a default (#450 — zero
 * env fallback; D1 image_source + the openai-images row are the only 正本).
 */
const IMAGE_SOURCE_UNCONFIGURED_OUTPUT =
  "generate_image is not configured: no usable image source. Select an " +
  "api=openai-images provider row as the image source (产图源) in Settings → " +
  "Providers — the row's baseUrl, stored key, and first model row are the " +
  "source. There is no deployment-env fallback.";

// ---------------------------------------------------------------------------
// omp verbatim prompt assembly — image-gen.ts:68-81
// ---------------------------------------------------------------------------

export interface GenerateImageParams {
  subject: string;
  action?: string;
  scene?: string;
  composition?: string;
  lighting?: string;
  style?: string;
  text?: string;
  changes?: string[];
  aspect_ratio?: "1:1" | "3:4" | "4:3" | "9:16" | "16:9" | "3:2" | "2:3";
  image_size?: "1024x1024" | "1536x1024" | "1024x1536";
  input?: { path?: string; data?: string; mime_type?: string }[];
  model?: string;
}

export function assemblePrompt(params: GenerateImageParams): string {
  const parts: string[] = [];
  const subjectParts = [params.subject];
  if (params.action) subjectParts.push(params.action);
  if (params.scene) subjectParts.push(params.scene);
  parts.push(subjectParts.join(", "));
  if (params.composition) parts.push(params.composition);
  if (params.lighting) parts.push(params.lighting);
  if (params.style) parts.push(params.style);
  const result = `${parts.map((part) => part.replace(/[.!,;:]+$/, "")).join(". ")}.`;
  const textSection = params.text ? `\n\nText: ${params.text}` : "";
  const changesSection = params.changes?.length
    ? `\n\nChanges:\n${params.changes.map((change) => `- ${change}`).join("\n")}`
    : "";
  return `${result}${textSection}${changesSection}`;
}

// ---------------------------------------------------------------------------
// omp shared.ts ports — size resolution, response decoding, data URLs
// ---------------------------------------------------------------------------

const DATA_URL_PATTERN = /^data:([^;]+);base64,(.+)$/;

/** omp image-gen.ts:83-87. */
function normalizeDataUrl(data: string): { data: string; mimeType?: string } {
  const match = DATA_URL_PATTERN.exec(data);
  if (!match) return { data };
  return { data: match[2] ?? "", mimeType: match[1] };
}

/**
 * Magic-byte sniff for the extension set omp's imageExtension maps
 * (image-gen.ts:115-123: png/jpg/gif/webp) — the workerd stand-in for
 * pi-utils parseImageMetadata (openai-images shared.ts:168-171 uses it as
 * the media-type fallback before the png default).
 */
function sniffImageMimeType(bytes: Uint8Array): string | undefined {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    return "image/gif";
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  return undefined;
}

/** omp image-gen.ts:115-123. */
function imageExtension(mimeType: string): string {
  const extensions: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/gif": "gif",
    "image/webp": "webp",
  };
  return extensions[mimeType] ?? "png";
}

/** omp shared.ts:184-198 (resolveOpenAIImageSize). */
export function resolveOpenAIImageSize(
  aspectRatio?: string,
  imageSize?: string,
): string | undefined {
  if (imageSize) return imageSize;
  const SIZE_BY_ASPECT: Record<string, string> = {
    "1:1": "1024x1024",
    "3:4": "1024x1536",
    "9:16": "1024x1536",
    "4:3": "1536x1024",
    "16:9": "1536x1024",
  };
  return aspectRatio === undefined ? undefined : SIZE_BY_ASPECT[aspectRatio];
}

/** workerd has no node Buffer: base64 → bytes via atob (sniffing only). */
function base64Bytes(content: string): Uint8Array {
  const binary = atob(content);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/** bytes → base64, chunked so large images never blow the argument limit
 * (btoa takes a binary string; String.fromCharCode spreads are capped). */
function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK));
  }
  return btoa(binary);
}

interface GeneratedImage {
  data: string;
  mimeType: string;
}

/** omp shared.ts:43-50 (errorMessage): JSON error bodies keep their message. */
function errorMessage(rawText: string): string {
  try {
    const parsed = JSON.parse(rawText) as { detail?: string; error?: { message?: string } };
    return parsed.detail ?? parsed.error?.message ?? rawText;
  } catch {
    return rawText;
  }
}

/**
 * omp shared.ts:150-178 (decodeImageResponse): b64_json first, else a
 * provider URL downloaded eagerly (omp downloads before saving, docs §Side
 * Effects); media_type from the wire, magic-byte sniff second, png default.
 */
async function decodeImageResponse(
  value: unknown,
  fetchImpl: typeof fetch,
  signal: AbortSignal | undefined,
): Promise<GeneratedImage[]> {
  if (value === null || typeof value !== "object") {
    throw new Error("Image API returned a malformed response");
  }
  const root = value as { data?: unknown };
  if (!Array.isArray(root.data)) {
    throw new Error("Image API response is missing data");
  }
  const images: GeneratedImage[] = [];
  for (const item of root.data) {
    if (item === null || typeof item !== "object") continue;
    const image = item as { b64_json?: unknown; url?: unknown; media_type?: unknown };
    if (typeof image.b64_json === "string" && image.b64_json.length > 0) {
      const bytes = base64Bytes(image.b64_json);
      const mimeType =
        typeof image.media_type === "string"
          ? image.media_type
          : (sniffImageMimeType(bytes) ?? "image/png");
      images.push({ data: image.b64_json, mimeType });
    } else if (typeof image.url === "string" && image.url.length > 0) {
      const response = await fetchImpl(image.url, { signal });
      if (!response.ok) {
        throw new Error(`Image download failed (${response.status}): ${await response.text()}`);
      }
      const mimeType = response.headers.get("content-type")?.split(";")[0];
      if (!mimeType?.startsWith("image/")) {
        throw new Error(`Image URL returned unsupported content type: ${mimeType ?? "missing"}`);
      }
      images.push({ data: bytesToBase64(new Uint8Array(await response.arrayBuffer())), mimeType });
    }
  }
  return images;
}

// ---------------------------------------------------------------------------
// DO-bound context
// ---------------------------------------------------------------------------

/** Result of one `host.write_file` round trip (agent-do/daemon.ts mirror). */
export type WriteThreadFile = (args: {
  filename: string;
  contentBase64: string;
}) => Promise<
  | { kind: "ok"; path: string }
  | { kind: "error"; errorCode: string; errorMessage: string }
  | { kind: "host_offline" }
  | { kind: "timeout" }
>;

/** Result of one `host.read_file` round trip for `input[].path` legs. */
export type ReadThreadFile = (args: {
  path: string;
}) => Promise<
  | { kind: "ok"; content: string; contentEncoding: "base64" | "utf8"; mimeType?: string }
  | { kind: "error"; errorCode: string; errorMessage: string }
  | { kind: "host_offline" }
  | { kind: "timeout" }
>;

/**
 * DO-bound context: the AgentDO binds the panel-resolved source config
 * (the 产图源 seat over an openai-images row), the owning call's cancel
 * signal, the global fetch (MSW-intercepted under the vitest workers pool)
 * and the two host file seams (agent-do/daemon.ts — the service-DO stub's
 * B2 methods).
 * `config` is null when no source is selected (the honest not-configured
 * state, #450) — the executor answers with the remedy, never a guessed
 * default.
 */
export interface GenerateImageToolContext {
  config: GenerateImageConfig | null;
  signal: AbortSignal;
  fetchImpl: typeof fetch;
  writeThreadFile: WriteThreadFile;
  readThreadFile?: ReadThreadFile;
}

// ---------------------------------------------------------------------------
// Input resolution — omp image-gen.ts:89-113 over the host-file read face
// ---------------------------------------------------------------------------

async function resolveInputImage(
  input: { path?: string; data?: string; mime_type?: string },
  ctx: GenerateImageToolContext,
): Promise<{ data: string; mimeType: string }> {
  if (input.path) {
    // omp loads the path locally (image-gen.ts:89-101); this edge reads it
    // through the B1 host-file face — absolute paths only, 10 MB image cap
    // (the face's own limits; omp's 35 MB tempdir cap is unreachable here).
    const read = await ctx.readThreadFile?.({ path: input.path });
    if (read === undefined) {
      throw new Error("Reading input images by path requires the DO-bound host read context.");
    }
    if (read.kind === "error" || read.kind === "host_offline" || read.kind === "timeout") {
      const detail =
        read.kind === "error"
          ? read.errorMessage
          : read.kind === "timeout"
            ? "host read timed out"
            : "host is not connected";
      if (read.kind === "error" && read.errorCode === "ENOENT") {
        throw new Error(`Image file not found: ${input.path}`);
      }
      throw new Error(`Image file could not be read: ${input.path} (${detail})`);
    }
    if (read.contentEncoding !== "base64") {
      throw new Error(`Unsupported image type: ${input.path}`);
    }
    return { data: read.content, mimeType: read.mimeType ?? "image/png" };
  }
  if (input.data) {
    const normalized = normalizeDataUrl(input.data.trim());
    const mimeType = normalized.mimeType ?? input.mime_type;
    if (!mimeType) throw new Error("mime_type is required when providing raw base64 data.");
    if (!normalized.data) throw new Error("Image data is empty.");
    return { data: normalized.data, mimeType };
  }
  throw new Error("input entries must include either path or data.");
}

// ---------------------------------------------------------------------------
// Transport — omp openai-images.ts generateOpenAIImage (JSON branch)
// ---------------------------------------------------------------------------

async function postImageJson(
  ctx: GenerateImageToolContext,
  config: GenerateImageConfig,
  endpoint: string,
  body: unknown,
): Promise<Response> {
  return ctx.fetchImpl(`${config.baseUrl}${endpoint}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: ctx.signal,
  });
}

/** omp openai-images.ts:52-56 + shared.ts:43-50 parseImageApiResponse. */
async function parseImageApi(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!response.ok) {
    throw Object.assign(
      new Error(`image request failed (${response.status}): ${errorMessage(text)}`),
      { status: response.status },
    );
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("Image API returned malformed JSON");
  }
}

async function generateViaOpenAICompatible(
  ctx: GenerateImageToolContext,
  config: GenerateImageConfig,
  prompt: string,
  inputImages: { data: string; mimeType: string }[],
  size: string | undefined,
  model: string,
): Promise<GeneratedImage[]> {
  const generationBody = {
    model,
    prompt,
    n: 1,
    response_format: "b64_json",
    ...(size ? { size } : {}),
  };
  if (inputImages.length === 0) {
    return decodeImageResponse(
      await parseImageApi(await postImageJson(ctx, config, "/images/generations", generationBody)),
      ctx.fetchImpl,
      ctx.signal,
    );
  }
  // omp openai-images.ts:45-56, 93-113 (non-OpenAI JSON branch + the 404
  // fallback): edits first with input_references, generations retry.
  const editBody = {
    ...generationBody,
    input_references: inputImages.map((image) => ({
      type: "image_url",
      // omp shared.ts:180-182 (toDataUrl).
      url: `data:${image.mimeType};base64,${image.data}`,
    })),
  };
  let response = await postImageJson(ctx, config, "/images/edits", editBody);
  if (response.status === 404) {
    response = await postImageJson(ctx, config, "/images/generations", editBody);
  }
  return decodeImageResponse(await parseImageApi(response), ctx.fetchImpl, ctx.signal);
}

// ---------------------------------------------------------------------------
// Execute — omp imageGenTool.execute structure over the single env source
// ---------------------------------------------------------------------------

/** omp docs/tools/generate_image.md §Side Effects — 3-minute ceiling, caller
 * abort combined. */
const IMAGE_TIMEOUT_FALLBACK_MS = DEFAULT_IMAGE_TIMEOUT_SECONDS * 1000;

export async function runGenerateImageTool(
  params: GenerateImageParams,
  ctx: GenerateImageToolContext,
): Promise<EdgeToolResult> {
  const config = ctx.config;
  if (config === null || config.baseUrl === "" || config.apiKey === "" || config.model === "") {
    return {
      status: "error",
      output: IMAGE_SOURCE_UNCONFIGURED_OUTPUT,
    };
  }
  const timeoutMs = config.timeoutSeconds * 1000 || IMAGE_TIMEOUT_FALLBACK_MS;
  // omp image-gen.ts:235 combineSignals(signal, IMAGE_TIMEOUT).
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = ctx.signal.aborted ? ctx.signal : AbortSignal.any([ctx.signal, timeout]);

  const prompt = assemblePrompt(params);
  const size = resolveOpenAIImageSize(params.aspect_ratio, params.image_size);
  const model = params.model ?? config.model;

  const inputImages: { data: string; mimeType: string }[] = [];
  if (params.input?.length) {
    try {
      for (const input of params.input) {
        inputImages.push(await resolveInputImage(input, ctx));
      }
    } catch (error) {
      if (signal.aborted && ctx.signal.aborted) {
        return { status: "cancelled", output: "" };
      }
      return {
        status: "error",
        output: `Error: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  let images: GeneratedImage[];
  try {
    images = await generateViaOpenAICompatible(ctx, config, prompt, inputImages, size, model);
  } catch (error) {
    if (ctx.signal.aborted) {
      // omp cancellation/timeout rethrow (image-gen.ts:323): abort maps to
      // the cancelled tool result (web_search.ts transport semantics).
      return { status: "cancelled", output: "" };
    }
    return {
      status: "error",
      output: `Error: ${model} ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (signal.aborted && ctx.signal.aborted) {
    return { status: "cancelled", output: "" };
  }

  // Save leg: omp writes the OS tempdir (saveImagesToTemp); this edge lands
  // the bytes on the host disk through the thread-file write RPC. A write
  // failure is the tool's error (the provider call already succeeded — the
  // image exists nowhere the user can reach).
  const saved: { path: string }[] = [];
  const now = Date.now();
  for (const [index, image] of images.entries()) {
    const filename = `agent-image-${now}-${index + 1}.${imageExtension(image.mimeType)}`;
    const write = await ctx.writeThreadFile({ filename, contentBase64: image.data });
    if (write.kind !== "ok") {
      const detail =
        write.kind === "error"
          ? `${write.errorCode}: ${write.errorMessage}`
          : write.kind === "timeout"
            ? "host write timed out"
            : "host is not connected";
      return {
        status: "error",
        output: `Error: image generated but could not be saved to the host (${detail}).`,
      };
    }
    saved.push({ path: write.path });
  }

  // omp buildToolResult text shape (image-gen.ts:181-223): zero images are
  // a normal ok result (`No image data returned.`), not an error.
  if (saved.length === 0) {
    return { status: "ok", output: "No image data returned." };
  }
  const lines = [`Model: ${model}`, `Generated ${saved.length} image(s):`];
  for (const image of saved) {
    lines.push(`  ${image.path}`);
  }
  return { status: "ok", output: lines.join("\n"), images: saved };
}
