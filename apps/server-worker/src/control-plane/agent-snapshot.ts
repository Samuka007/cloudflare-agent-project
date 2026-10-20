import { z } from "zod";
import {
  agentSnapshotSchema,
  type AgentSnapshot,
  type AgentToolCapabilitiesRow,
  type AgentWebSearchRow,
} from "@cap/protocol";
import type { Env } from "../env";

/**
 * The server side of the ControlPlane agent snapshot (db campaign T7, #599):
 * the four provider-settings statements the provider-app loader used to
 * batch against D1 directly (image_source / provider_configs / web_search /
 * tool_capabilities), now a server-private read behind the typed face.
 * Static SQL only (#591: zero dynamic concatenation); the zod row decoders
 * and the snapshot parse at the return boundary ARE the contract enforcement.
 *
 * T9 (#601, contract retirement) re-points this reader at the drizzle
 * repositories (provider_configs rows verbatim; the web_search /
 * tool_capabilities / image_source seats collapsed into settings_agent) —
 * the snapshot face and every consumer stay untouched; that swap is the
 * proof the table ABI is retired.
 */

// Boundary decoders: D1 rows are outside-controlled data (persisted cells),
// so each statement's rows validate through a schema — no shape assertions.
const imageSourceRowsSchema = z.array(z.object({ provider_id: z.string().nullable() }).loose());
const providerRowsSchema = z.array(
  z
    .object({
      id: z.string(),
      display_name: z.string().nullable(),
      base_url: z.string().nullable(),
      api: z.string().nullable(),
      service_tier: z.number().nullable(),
      api_key_enc: z.string().nullable(),
      models: z.string().nullable(),
      created_at: z.number(),
      updated_at: z.number(),
    })
    .loose(),
);
const webSearchRowsSchema = z.array(
  z
    .object({
      chain: z.string(),
      timeout_seconds: z.number().nullable(),
      engines: z.string().nullable(),
      secrets_enc: z.string().nullable(),
      secrets_meta: z.string().nullable(),
      updated_at: z.number(),
    })
    .loose(),
);
const toolCapabilitiesRowsSchema = z.array(
  z
    .object({
      external_thinking: z.number().nullable(),
      context_notes: z.number().nullable(),
      checkpoint: z.number().nullable(),
    })
    .loose(),
);

export async function readAgentSnapshot(env: Env): Promise<AgentSnapshot> {
  // ONE batch round trip — the same single-trip shape the loader relied on
  // (#448/#502: the turn-boundary refresh awaits this read; an extra event
  // -loop yield here raced the read faces).
  const results = await env.DB.batch([
    env.DB.prepare("SELECT provider_id FROM image_source WHERE id = 'image_source'"),
    env.DB.prepare(
      "SELECT id, display_name, base_url, api, service_tier, api_key_enc, models, created_at, updated_at FROM provider_configs ORDER BY id",
    ),
    env.DB.prepare(
      "SELECT chain, timeout_seconds, engines, secrets_enc, secrets_meta, updated_at FROM web_search WHERE id = 'web_search'",
    ),
    env.DB.prepare(
      "SELECT external_thinking, context_notes, checkpoint FROM tool_capabilities WHERE id = 'tool_capabilities'",
    ),
  ] as const);
  const [imageSourceResult, rowsResult, webSearchResult, toolCapabilitiesResult] = results;
  if (
    imageSourceResult === undefined ||
    rowsResult === undefined ||
    webSearchResult === undefined ||
    toolCapabilitiesResult === undefined
  ) {
    throw new Error("agent snapshot: D1 batch returned fewer results than statements");
  }

  const imageSourceProviderId =
    imageSourceRowsSchema.parse(imageSourceResult.results)[0]?.provider_id ?? null;

  const providers = providerRowsSchema.parse(rowsResult.results).map((row) => ({
    id: row.id,
    displayName: row.display_name,
    baseUrl: row.base_url,
    api: row.api,
    serviceTier: row.service_tier === 1,
    apiKeyEnc: row.api_key_enc,
    // The models document keeps its raw stored text (a corrupt JSON cell
    // must stay visible for repair on the CRUD face — skip-with-warning).
    models: row.models ?? "[]",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));

  const webSearchRow = webSearchRowsSchema.parse(webSearchResult.results)[0];
  const webSearch: AgentWebSearchRow | null =
    webSearchRow === undefined
      ? null
      : {
          chain: webSearchRow.chain,
          timeoutSeconds: webSearchRow.timeout_seconds,
          engines: webSearchRow.engines,
          secretsEnc: webSearchRow.secrets_enc,
          secretsMeta: webSearchRow.secrets_meta,
          updatedAt: webSearchRow.updated_at,
        };

  // Absent row = the ruled omp posture (all gates off) — the loader applies
  // it, the face just reports the absence as null.
  const toolRow = toolCapabilitiesRowsSchema.parse(toolCapabilitiesResult.results)[0];
  const toolCapabilities: AgentToolCapabilitiesRow | null =
    toolRow === undefined
      ? null
      : {
          externalThinking: toolRow.external_thinking === 1,
          contextNotes: toolRow.context_notes === 1,
          checkpoint: toolRow.checkpoint === 1,
        };

  return agentSnapshotSchema.parse({
    providers,
    imageSourceProviderId,
    webSearch,
    toolCapabilities,
  });
}
