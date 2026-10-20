import { z } from "zod";

/**
 * ControlPlane typed RPC contract (db campaign T7, #599).
 *
 * The seam that retires the provider-app / daemon-service direct D1
 * reads/writes: table structures become server-private storage detail and
 * THESE shapes are the only cross-worker ABI. The server (apps/server-worker)
 * exposes the face behind a `CONTROL_PLANE` service binding (named
 * entrypoint — not publicly routable); consumers build a client either over
 * that binding (`createRpcControlPlaneClient`, the daemon-service DO's path)
 * or in-process (`createLocalControlPlaneClient`, server-worker side — the
 * same-process adapter, #591 ruling: "Local 与 Rpc 双适配器，今日同进程先
 * Local").
 *
 * Contract discipline (#591): the wire shapes are zod, both adapters
 * validate through the same schemas, and there is no hand-written second
 * copy of any shape. Consumers never see SQL, D1, or column layouts — the
 * snapshot carries logical domain values (booleans, raw JSON documents)
 * that survive the T9 seat-table collapse unchanged.
 */

// ─── Agent snapshot (provider-app's read face) ───────────────────────────────
//
// The four provider-settings domains the provider-app loader used to batch
// against D1 directly (image_source / provider_configs / web_search /
// tool_capabilities). One call, one round trip — the turn-boundary refresh
// awaits this loader, so the single-call shape is load-bearing (#448/#502).

/** One stored provider row. `models` stays the RAW stored JSON document so a
 * corrupt cell rides the CRUD face visibly for repair (skip-with-warning);
 * `apiKeyEnc` is the AES-GCM ciphertext in provider-app's own column format
 * (its crypto module owns it; T9 preserves the shape verbatim). */
export const agentProviderRowSchema = z.object({
  id: z.string(),
  displayName: z.string().nullable(),
  baseUrl: z.string().nullable(),
  api: z.string().nullable(),
  serviceTier: z.boolean(),
  apiKeyEnc: z.string().nullable(),
  models: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type AgentProviderRow = z.infer<typeof agentProviderRowSchema>;

/** The stored #449 web_search row's cells (JSON documents as stored); null =
 * the absent-row ruled-defaults posture. */
export const agentWebSearchRowSchema = z.object({
  /** JSON array of engine ids, in chain order. */
  chain: z.string(),
  timeoutSeconds: z.number().nullable(),
  /** JSON non-secret engine settings (searxng endpoint/categories/…). */
  engines: z.string().nullable(),
  /** AES-GCM JSON of the secret half (brave apiKey, searxng token/basic*). */
  secretsEnc: z.string().nullable(),
  /** JSON secret-PRESENCE map — the no-decrypt faces read presence only. */
  secretsMeta: z.string().nullable(),
  updatedAt: z.number(),
});
export type AgentWebSearchRow = z.infer<typeof agentWebSearchRowSchema>;

/** The stored #502 tool-capability gates (logical booleans, not 0/1 seats);
 * null = the absent-row omp posture (all gates off). */
export const agentToolCapabilitiesRowSchema = z.object({
  externalThinking: z.boolean(),
  contextNotes: z.boolean(),
  checkpoint: z.boolean(),
});
export type AgentToolCapabilitiesRow = z.infer<typeof agentToolCapabilitiesRowSchema>;

export const agentSnapshotSchema = z.object({
  providers: z.array(agentProviderRowSchema),
  /** The #448 generate_image source seat; null = nothing selected. */
  imageSourceProviderId: z.string().nullable(),
  webSearch: agentWebSearchRowSchema.nullable(),
  toolCapabilities: agentToolCapabilitiesRowSchema.nullable(),
});
export type AgentSnapshot = z.infer<typeof agentSnapshotSchema>;

// ─── RPC envelope ─────────────────────────────────────────────────────────────

export const markHostSeenArgsSchema = z.object({
  hostId: z.string().min(1),
  /** Stamp time (ms epoch); the server owns the write throttle. */
  at: z.number(),
});
export type MarkHostSeenArgs = z.infer<typeof markHostSeenArgsSchema>;

export const controlPlaneRequestSchema = z.discriminatedUnion("method", [
  z.object({ method: z.literal("agentSnapshot.get") }),
  z.object({ method: z.literal("hosts.markSeen"), args: markHostSeenArgsSchema }),
]);
export type ControlPlaneRequest = z.infer<typeof controlPlaneRequestSchema>;

export const controlPlaneResponseSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), data: z.unknown() }),
  z.object({
    ok: z.literal(false),
    error: z.object({ code: z.string(), message: z.string() }),
  }),
]);
export type ControlPlaneResponse = z.infer<typeof controlPlaneResponseSchema>;

// ─── Clients ──────────────────────────────────────────────────────────────────

export interface ControlPlaneClient {
  /** The provider-settings domain snapshot (the retired 4-statement batch). */
  getAgentSnapshot(): Promise<AgentSnapshot>;
  /**
   * hosts liveness stamp (bb markHostSeen). The ≥30s write throttle is the
   * SERVER's policy now (#591 ruling: markSeen 节流内聚 Hosts repo) — callers
   * fire per heartbeat; the server decides which stamps land.
   */
  markHostSeen(args: MarkHostSeenArgs): Promise<void>;
}

/**
 * The minimal structural fetcher the RPC adapter needs — satisfied by a CF
 * service binding (Fetcher) without importing workers types into this
 * package.
 */
export interface ControlPlaneFetcher {
  fetch(input: string | URL | Request, init?: RequestInit): Promise<Response>;
}

/** The Rpc adapter: the same zod boundary, one fetch per call. Response
 * payloads are schema-parsed so a misbehaving server fails loudly at the
 * boundary, never as silent shape drift downstream. */
export function createRpcControlPlaneClient(fetcher: ControlPlaneFetcher): ControlPlaneClient {
  const call = async (
    request: ControlPlaneRequest,
    responseSchema: z.ZodType,
  ): Promise<unknown> => {
    const response = await fetcher.fetch("https://control-plane.rpc/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
    let envelope: unknown;
    try {
      envelope = await response.json();
    } catch {
      throw new Error(`control-plane rpc: non-JSON response (status ${response.status})`);
    }
    const parsed = controlPlaneResponseSchema.parse(envelope);
    if (!parsed.ok) {
      throw new Error(`control-plane rpc ${request.method} failed: ${parsed.error.message}`);
    }
    return responseSchema.parse(parsed.data);
  };

  return {
    async getAgentSnapshot() {
      return agentSnapshotSchema.parse(
        await call({ method: "agentSnapshot.get" }, agentSnapshotSchema),
      );
    },
    async markHostSeen(args) {
      await call(
        { method: "hosts.markSeen", args: markHostSeenArgsSchema.parse(args) },
        z.unknown(),
      );
    },
  };
}
