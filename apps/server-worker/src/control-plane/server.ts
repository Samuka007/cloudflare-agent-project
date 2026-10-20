import type { ControlPlaneClient } from "@cap/protocol";
import type { ProviderConfigEnv } from "@cap/provider-app";
import type { Env } from "../env";
import { readAgentSnapshot } from "./agent-snapshot";
import { markHostSeenInRegistry } from "./registry";

/**
 * The ControlPlane face's server-worker wiring (db campaign T7, #599).
 *
 * `createLocalControlPlaneClient` is the Local adapter (#591 ruling: Local
 * 与 Rpc 双适配器，今日同进程先 Local) — same-process, zero-hop, calling the
 * server-side reads/writes directly. The zod boundary still applies (the
 * snapshot reader parses through the contract schemas), so behavior is
 * identical when a consumer later moves to the Rpc adapter over the
 * CONTROL_PLANE service binding.
 *
 * `providerConfigEnvFor` is the provider-config loader's env slice for this
 * deployment: the Local client plus the master key (the loader owns
 * decryption; the ciphertext only ever leaves storage in its own crypto
 * module's format).
 */

export function createLocalControlPlaneClient(env: Env): ControlPlaneClient {
  return {
    getAgentSnapshot: () => readAgentSnapshot(env),
    markHostSeen: ({ hostId, at }) => markHostSeenInRegistry(env, hostId, at),
  };
}

export function providerConfigEnvFor(env: Env): ProviderConfigEnv {
  return {
    controlPlane: createLocalControlPlaneClient(env),
    PROVIDER_CONFIG_MASTER_KEY: env.PROVIDER_CONFIG_MASTER_KEY,
  };
}
