import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// DO + WebSocket (hibernation) tests require a single shared worker context
// with no per-file isolation (docs/research/testing-strategy-cloudflare-do.md
// §4.4 pit 1), so the whole package runs pinned to one non-isolated worker.
export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })],
  test: {
    maxWorkers: 1,
    minWorkers: 1,
    isolate: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
