import type { ProviderConfigTestResponse } from "../contract/api/system.js";

/**
 * #362 test-connection: ONE minimal wire request against the row's declared
 * endpoint, answered as a true/false verdict (+ status/latency/bounded
 * error). Family conventions match the relay wire (packages/agent-do
 * relay/anthropic-provider.ts `${baseUrl}/v1/messages`) and the OpenAI
 * Responses convention (`${baseUrl}/responses`, #361's adaptor family).
 *
 * Zero-secret: the key value rides headers only and the error body is read
 * bounded — upstream error payloads quote request headers in pathological
 * cases, so the truncation cap keeps any echo out of the response face.
 */

const PROBE_TIMEOUT_MS = 10_000;
const ERROR_BODY_CAP_BYTES = 512;

export interface ProviderProbeTarget {
  api: string | null;
  baseUrl: string;
  model: string;
  apiKey: string | null;
}

async function boundedErrorText(response: Response): Promise<string> {
  const stream: ReadableStream<Uint8Array> | null = response.body;
  if (stream === null) return "";
  const reader = stream.getReader();
  const chunk = await reader.read();
  await reader.cancel();
  if (chunk.done) return "";
  return new TextDecoder().decode(chunk.value.slice(0, ERROR_BODY_CAP_BYTES));
}

export async function probeProviderConnection(
  target: ProviderProbeTarget,
): Promise<ProviderConfigTestResponse> {
  const url = `${target.baseUrl.replace(/\/+$/, "")}${
    target.api === "openai-responses" ? "/responses" : "/v1/messages"
  }`;
  const headers: Record<string, string> = { "content-type": "application/json" };
  let body: string;
  if (target.api === "openai-responses") {
    if (target.apiKey !== null) headers.authorization = `Bearer ${target.apiKey}`;
    body = JSON.stringify({
      model: target.model,
      input: "ping",
      max_output_tokens: 16,
      stream: false,
    });
  } else {
    if (target.apiKey !== null) headers["x-api-key"] = target.apiKey;
    headers["anthropic-version"] = "2023-06-01";
    body = JSON.stringify({
      model: target.model,
      max_tokens: 1,
      messages: [{ role: "user", content: "ping" }],
      stream: false,
    });
  }
  const startedAt = Date.now();
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
  } catch (error) {
    return {
      ok: false,
      status: null,
      latencyMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  const latencyMs = Date.now() - startedAt;
  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      latencyMs,
      error: await boundedErrorText(response),
    };
  }
  // Drain the body so the socket closes cleanly even on streaming probes.
  await response.arrayBuffer();
  return { ok: true, status: response.status, latencyMs, error: null };
}
