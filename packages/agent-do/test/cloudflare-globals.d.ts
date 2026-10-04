/**
 * Main-module shape for `exports` from "cloudflare:workers" in this package's
 * vitest-pool-workers suites (the hookup rig drives `exports.default.fetch`).
 * Mirrors what `wrangler types` generates from wrangler.hookup.jsonc.
 */
declare namespace Cloudflare {
  interface GlobalProps {
    mainModule: typeof import("../src/worker");
    durableNamespaces: "AgentDO" | "DaemonServiceDO" | "HUB";
  }
}
