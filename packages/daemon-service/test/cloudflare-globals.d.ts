/**
 * Main-module shape for `exports` from "cloudflare:workers" in this package's
 * vitest-pool-workers suites (the L1 rig drives `exports.default.fetch`).
 * Mirrors what `wrangler types` generates from wrangler.jsonc.
 */
declare namespace Cloudflare {
  interface GlobalProps {
    mainModule: typeof import("../src/worker");
    durableNamespaces: "DaemonServiceDO" | "TestAgentSinkDO";
  }
}
