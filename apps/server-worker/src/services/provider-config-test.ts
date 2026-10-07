import type {
  ProviderConfigDiscoverResponse,
  ProviderConfigTestResponse,
} from "../contract/api/system.js";
import {
  hostDiscoverModelsResultSchema,
  type DiscoveredModelEntry,
  type HostDiscoverModelsCommand,
} from "@cap/daemon-service";
import { listNonDestroyedHostRows } from "../db/hosts.js";
import { HOST_COMMAND_TIMEOUT_MS, daemonServiceStubOrNull } from "./host-files.js";
import type { Env } from "../env.js";
import { z } from "zod";

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

/** The fetch seam: real outbound fetch in production, stubbed in unit rigs. */
export type FetchImpl = (url: string, init: RequestInit) => Promise<Response>;

// The envelope and entry shapes are outside-controlled (upstream JSON) —
// parsed, never cast: a missing `data` array or a non-string id is a
// verdict/warning, not a trusted read.
const modelsListEnvelopeSchema = z.object({ data: z.array(z.unknown()) });
const upstreamModelEntrySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).optional(),
});

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
  fetchImpl: FetchImpl = fetch,
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
    response = await fetchImpl(url, {
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

/**
 * #362 PM addition ①: /models discovery (openai-models-list semantics) —
 * GET `${baseUrl}/models` and normalize the envelope into catalog model
 * seats. The panel merges the result with skip-with-warning discipline:
 * entries without a usable string id become WARNINGS (never silently
 * dropped), and a non-list envelope is an ok:false verdict with bounded
 * error text. `apiKey` rides the Authorization header only — the response
 * never echoes credential material.
 *
 * #447: this edge probe is the NO-HOST fallback — it cannot enrich (the omp
 * pi-catalog stack needs the Bun host), so every row is marked
 * `metadataSource: "unavailable"` and carries id/name only. The enriched
 * primary path is discoverProviderModelsEnriched below.
 */
export async function discoverProviderModels(
  target: { baseUrl: string; apiKey: string | null },
  fetchImpl: FetchImpl = fetch,
): Promise<ProviderConfigDiscoverResponse> {
  const url = `${target.baseUrl.replace(/\/+$/, "")}/models`;
  const headers: Record<string, string> = {};
  if (target.apiKey !== null) headers.authorization = `Bearer ${target.apiKey}`;
  const startedAt = Date.now();
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
  } catch (error) {
    return {
      ok: false,
      status: null,
      latencyMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
      models: [],
      warnings: [],
    };
  }
  const latencyMs = Date.now() - startedAt;
  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      latencyMs,
      error: await boundedErrorText(response),
      models: [],
      warnings: [],
    };
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return {
      ok: false,
      status: response.status,
      latencyMs,
      error: "response body is not JSON",
      models: [],
      warnings: [],
    };
  }
  const envelope = modelsListEnvelopeSchema.safeParse(payload);
  if (!envelope.success) {
    return {
      ok: false,
      status: response.status,
      latencyMs,
      error: 'response is not an OpenAI models list (expected { "data": [...] })',
      models: [],
      warnings: [],
    };
  }
  const models: DiscoveredModelEntry[] = [];
  const warnings: string[] = [];
  for (const entry of envelope.data.data) {
    const parsed = upstreamModelEntrySchema.safeParse(entry);
    if (!parsed.success) {
      warnings.push(
        `discovered entry without a usable string id (${JSON.stringify(entry ?? null).slice(0, 80)}) — skipped, never silently dropped`,
      );
      continue;
    }
    models.push({ ...parsed.data, metadataSource: "unavailable" });
  }
  return { ok: true, status: response.status, latencyMs, error: null, models, warnings };
}

/**
 * #447: the enriched primary path. Discovery delegates to a connected host
 * over the host online-RPC seam (`host.discover_models`): the daemon runs
 * the SAME `${baseUrl}/models` probe and enriches every entry against omp's
 * pi-catalog stack (live models.dev hydration + bundled snapshot), which the
 * Workers edge cannot run (Bun-only zstd hydration). `apiKey` rides the
 * host-rpc frame to the user's OWN daemon — the same authenticated WS
 * channel the host file faces use; the daemon is the credential's owner.
 *
 * Host selection: `hostId` pins the server; otherwise the first registered
 * persistent hosts in creation order serve (capped). Every per-host failure
 * becomes a warning note, and when NO host can serve, the face degrades to
 * the edge's bare probe (discoverProviderModels) instead of failing — the
 * panel still gets ids, now with an explicit unavailable marking and a
 * degradation warning, never a silent metadata loss.
 */
const DISCOVERY_HOST_CANDIDATES_MAX = 3;

export interface ProviderDiscoverTarget {
  baseUrl: string;
  apiKey: string | null;
  /** Row api family hint ("anthropic" | "openai-responses" | …); null when undeclared. */
  api: string | null;
  hostId?: string;
}

export async function discoverProviderModelsEnriched(
  env: Env,
  target: ProviderDiscoverTarget,
): Promise<ProviderConfigDiscoverResponse> {
  const notes: string[] = [];
  const hostIds =
    target.hostId !== undefined
      ? [target.hostId]
      : (await listNonDestroyedHostRows(env))
          .filter((row) => row.type !== "placeholder")
          .slice(0, DISCOVERY_HOST_CANDIDATES_MAX)
          .map((row) => row.id);
  const command: HostDiscoverModelsCommand = {
    type: "host.discover_models",
    baseUrl: target.baseUrl,
    ...(target.apiKey !== null ? { apiKey: target.apiKey } : {}),
    ...(target.api !== null && target.api !== "" ? { api: target.api } : {}),
  };
  for (const hostId of hostIds) {
    const stub = daemonServiceStubOrNull(env, hostId);
    if (stub === null) {
      notes.push(`host ${hostId}: daemon service unavailable`);
      continue;
    }
    const outcome = await stub.hostOnlineRpc({
      hostId,
      command,
      timeoutMs: HOST_COMMAND_TIMEOUT_MS,
    });
    if (outcome.kind === "host_offline") {
      notes.push(`host ${hostId}: offline`);
      continue;
    }
    if (outcome.kind === "timeout") {
      notes.push(`host ${hostId}: timed out`);
      continue;
    }
    if (!outcome.response.ok) {
      // An old daemon answers unknown_command; a newer one can fail its own
      // dispatch. Either way the next candidate (or the edge fallback) serves.
      notes.push(
        `host ${hostId}: ${outcome.response.errorCode} (${outcome.response.errorMessage})`,
      );
      continue;
    }
    if (outcome.response.commandType !== command.type) {
      notes.push(`host ${hostId}: response type ${outcome.response.commandType}`);
      continue;
    }
    const parsed = hostDiscoverModelsResultSchema.safeParse(outcome.response.result);
    if (!parsed.success) {
      notes.push(`host ${hostId}: malformed discovery result`);
      continue;
    }
    return parsed.data;
  }
  const fallback = await discoverProviderModels({
    baseUrl: target.baseUrl,
    apiKey: target.apiKey,
  });
  return {
    ...fallback,
    warnings: [
      ...notes,
      "metadata enrichment unavailable (no host served discovery) — rows carry id/name only",
      ...fallback.warnings,
    ],
  };
}
