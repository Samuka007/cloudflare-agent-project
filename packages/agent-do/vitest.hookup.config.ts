/// <reference types="node" />
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { existsSync, readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";

/**
 * Full-chain hookup rig (#34): one worker composing the real AgentDO with
 * the REAL per-machine DaemonServiceDO (#30) under the production binding
 * shape — DAEMON_SERVICE named by machineId, updates returning via
 * forwardToAgent → AGENT_DO.onExecutionUpdate. The daemon client is the
 * protocol-real simulated client (the real Node process half is the
 * wrangler-dev smoke in packages/daemon-service).
 *
 * Kept as a separate vitest project so the default suite keeps its
 * in-package fake binding (the 22 invariants pin its per-thread naming).
 */

function relayEnvFromDevVars(): Record<string, string> {
  const path = new URL("../../.dev.vars", import.meta.url);
  if (!existsSync(path)) return {};
  const vars: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = /^([A-Z_]+)=(.*)$/.exec(line);
    if (match) vars[match[1]] = match[2];
  }
  return vars;
}

// workerd's BoringSSL trust probing finds no root store on NixOS; point it
// at the system bundle when present (no-op on CI/macOS).
const NIX_OS_CA_BUNDLE = "/etc/ssl/certs/ca-certificates.crt";
if (existsSync(NIX_OS_CA_BUNDLE)) {
  process.env.SSL_CERT_FILE ??= NIX_OS_CA_BUNDLE;
}

export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.hookup.jsonc" } })],
  define: {
    __RELAY_ENV__: JSON.stringify(relayEnvFromDevVars()),
  },
  test: {
    include: ["test/smoke-hookup.test.ts"],
    maxWorkers: 1,
    minWorkers: 1,
    isolate: false,
    testTimeout: 120_000,
    hookTimeout: 30_000,
  },
});
