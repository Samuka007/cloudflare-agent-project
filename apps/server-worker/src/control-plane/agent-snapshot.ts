import { agentSnapshotSchema, type AgentSnapshot } from "@cap/protocol";
import { createProviderConfigsRepository } from "../db/repositories/provider-configs";
import { createSettingsRepository } from "../db/repositories/settings";
import type { Env } from "../env";

/**
 * The server side of the ControlPlane agent snapshot (db campaign T7, #599;
 * drizzle reader since the T6 write cutover, #598): the four provider-settings
 * domains read from the drizzle repositories over DB_V2 — the same database
 * every T6 write face lands on, so a panel write is visible to the next turn
 * boundary with no dual-write bridge.
 *
 * The web-search cells stay RAW (unparsed, ciphertext-bearing): the
 * provider-app loader owns decode/decrypt/validate byte-identically
 * (assembleWebSearch), so the snapshot carries exactly the stored cells the
 * legacy D1 batch served — the table ABI retires while the wire contract and
 * the assembly do not move (#591: no hand-written second shape).
 *
 * Static reads only (#591: zero dynamic concatenation); the snapshot parse at
 * the return boundary IS the contract enforcement.
 */

export async function readAgentSnapshot(env: Env): Promise<AgentSnapshot> {
  const masterKey = env.PROVIDER_CONFIG_MASTER_KEY;
  const settings = createSettingsRepository(env.DB_V2, masterKey);
  const configs = createProviderConfigsRepository(env.DB_V2, masterKey);

  const [providers, imageSourceProviderId, webSearchRaw, toolCapabilitiesState] = await Promise.all(
    [
      configs.listWithCipher(),
      settings.getImageSourceProviderId(),
      settings.getWebSearchRaw(),
      settings.getToolCapabilities(),
    ],
  );

  // Absent row = the ruled omp posture (all gates off) — the loader applies
  // it, the face just reports the absence as null.
  const toolCapabilities = toolCapabilitiesState.configured
    ? {
        externalThinking: toolCapabilitiesState.externalThinking,
        contextNotes: toolCapabilitiesState.contextNotes,
        checkpoint: toolCapabilitiesState.checkpoint,
      }
    : null;

  return agentSnapshotSchema.parse({
    providers,
    imageSourceProviderId,
    webSearch: webSearchRaw,
    toolCapabilities,
  });
}
