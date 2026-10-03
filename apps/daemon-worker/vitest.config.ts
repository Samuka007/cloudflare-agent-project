import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

/**
 * L1 suite: the Worker + Durable Objects run in miniflare (workers runtime),
 * single shared worker context (same shape as apps/server-worker; DO alarm
 * semantics need it). See docs/research/testing-strategy-cloudflare-do.md.
 */
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
    }),
  ],
  test: {
    maxWorkers: 1,
    minWorkers: 1,
    isolate: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
