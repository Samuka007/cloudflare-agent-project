import { TOOL_REGISTRY } from "@cap/agent-config";
import {
  createHostTool,
  createModelsFromProviders,
  HostToolDispatcher,
  type DurableAgentRuntime,
  type DurableProviderSource,
  type HostDispatchOutcome,
  type HostToolFrame,
  type HostToolScope,
} from "@cap/agent-durable";
import { loadProviderConfigOverlay } from "@cap/provider-app";
import { CLOUD_PLACEHOLDER_HOST_ID } from "@cap/protocol";
import { createRegistry, defineExtension } from "@earendil-works/pi-durable";
import { providerConfigEnvFor } from "./control-plane/server";
import { createThreadsRepo } from "./db/repositories/threads";
import type { Env } from "./env";

interface DaemonDispatchRpc {
  dispatch(request: {
    threadId: string;
    turnId: string;
    executionId: string;
    machineId: string;
    tool: string;
    arguments: Record<string, unknown>;
    timeoutMs: number;
    workspace?: { id: string; path: string };
  }): Promise<HostDispatchOutcome>;
}

/**
 * The D1 provider catalog projected onto the DO's source list, plus a change
 * fingerprint over the projection (including resolved keys — a key rotation
 * must reach the next dispatch too, #623). Sorted by provider id so the hash
 * is stable against row-order jitter.
 */
export async function loadProviderSources(
  env: Env,
): Promise<{ sources: DurableProviderSource[]; fingerprint: string }> {
  const overlay = await loadProviderConfigOverlay(providerConfigEnvFor(env));
  if (overlay === null) throw new Error("durable_runtime_no_provider_config");

  const sources: DurableProviderSource[] = [];
  for (const [providerId, provider] of Object.entries(overlay.providers)) {
    if (provider.api === "openai-images") continue;
    if (provider.models.length === 0) continue;
    const baseUrl = provider.baseUrl ?? overlay.credentials[providerId]?.baseUrl ?? "";
    if (baseUrl === "") {
      throw new Error(`durable_runtime_provider_missing_base_url:${providerId}`);
    }
    sources.push({
      providerId,
      displayName: provider.displayName,
      baseUrl,
      ...(provider.api === undefined ? {} : { api: provider.api }),
      models: provider.models,
      resolveApiKey: () => overlay.credentials[providerId]?.apiKey,
    });
  }
  if (sources.length === 0) throw new Error("durable_runtime_no_chat_providers");

  const material: string[] = [];
  for (const source of [...sources].sort((a, b) => a.providerId.localeCompare(b.providerId))) {
    const key = await source.resolveApiKey?.();
    material.push(
      JSON.stringify([
        source.providerId,
        source.baseUrl,
        source.api ?? "anthropic-messages",
        source.models,
        key ?? "",
      ]),
    );
  }
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(material.join("\n")),
  );
  const fingerprint = Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return { sources, fingerprint };
}
/**
 * Production runtime for `ComposedDurableAgentDO`: D1 provider rows →
 * pi-ai Models; cap's host registry rows → per-tool wrappers over the
 * daemon-service dispatch seam. Only daemon-dispatch rows are registered;
 * edge-owned executors are intentionally absent from this runtime.
 */
export async function createDurableRuntime(
  env: Env,
  ctx: DurableObjectState,
): Promise<DurableAgentRuntime> {
  const { sources, fingerprint } = await loadProviderSources(env);
  ctx.storage.kv.put("providerCatalogFingerprint", fingerprint);

  const first = sources[0];
  const firstModel = first?.models[0];
  if (first === undefined || firstModel === undefined) {
    throw new Error("durable_runtime_no_models");
  }

  const models = createModelsFromProviders(sources);
  const scope = (): HostToolScope => {
    const machineId = ctx.storage.kv.get<string>("machineId");
    return {
      machineId:
        machineId === undefined || machineId === "" ? CLOUD_PLACEHOLDER_HOST_ID : machineId,
      threadId: ctx.storage.kv.get<string>("threadId") ?? "",
      turnId: ctx.storage.kv.get<string>("currentTurnId") ?? "",
    };
  };

  const dispatcher = new HostToolDispatcher({
    dispatch: (frame: HostToolFrame) => {
      const namespace = env.DAEMON_SERVICE;
      if (namespace === undefined) {
        return Promise.resolve({ kind: "host_offline" } satisfies HostDispatchOutcome);
      }
      const stub = namespace.get(
        namespace.idFromName(frame.machineId),
      ) as unknown as DaemonDispatchRpc;
      return stub.dispatch({
        threadId: frame.threadId,
        turnId: frame.turnId,
        executionId: frame.executionId,
        machineId: frame.machineId,
        tool: frame.tool,
        arguments: frame.arguments,
        timeoutMs: frame.timeoutMs,
        ...(frame.workspace === undefined ? {} : { workspace: frame.workspace }),
      });
    },
  });

  const tools = TOOL_REGISTRY.filter((row) => row.backend.kind === "daemon-dispatch").map((row) =>
    createHostTool(
      {
        name: row.name,
        description: row.descriptionTemplate,
        parameters: row.schema.toJsonSchema(),
        scope,
        replay: row.schedule === "read" ? "safe" : "unsafe",
        schedule: row.schedule,
        timeoutMs: row.name === "bash" || row.name === "eval" ? 600_000 : 120_000,
      },
      dispatcher,
    ),
  );

  const registry = createRegistry();
  registry.install(defineExtension({ name: "cap-host", tools }));

  // #591 db campaign T8: the DO's pending-badge flips land on the threads
  // row through the monotonic CAS (a replayed fold lands nowhere).
  const threadsRepo = createThreadsRepo(env.DB_V2);

  return {
    models,
    registry,
    agent: { model: { provider: first.providerId, modelId: firstModel.id } },
    hostTools: dispatcher,
    pendingState: {
      push: async (push) => {
        await threadsRepo.pushPendingState(push.threadId, {
          pendingSince: push.pendingSince,
          foldSeq: push.foldSeq,
        });
      },
    },
  };
}
