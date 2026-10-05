import { defineConfig } from "vitest/config";

/**
 * Node environment: the suite exercises the stdio transport (child processes)
 * and real loopback HTTP servers (streamable-http fixtures) — the same shape
 * upstream runs. The edge/daemon consumers re-test the integration surfaces
 * in their own runtimes (@cap/agent-do vitest-plugin, conformance suite).
 */
export default defineConfig({
  test: {
    environment: "node",
    testTimeout: 20_000,
  },
});
