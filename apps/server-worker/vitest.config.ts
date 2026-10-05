import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

/**
 * L1 suite: the Worker + Durable Objects run in miniflare (workers runtime).
 * Single shared worker context (DO + WS tests need it; see
 * docs/research/testing-strategy-cloudflare-do.md §4.4). D1 migrations are
 * replayed by test/migrate.ts — miniflare 5 dropped the per-binding
 * `migrations` option the old pool-workers pattern relied on.
 */
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        modulesRules: [{ type: "Text", include: ["**/*.sql"], fallThrough: true }],
        // Ticket #47: the L1 suite must be green on a clean checkout. public/
        // is gitignored build output (staged by CI / nix run .#staging-deploy),
        // so tests serve a committed minimal SPA fixture instead: the plugin
        // passes miniflare.assets to wrangler as an overrides.assets merge, so
        // only the directory changes; binding, not_found_handling and
        // run_worker_first stay as wrangler.jsonc declares them. The asset
        // manifest is snapshotted when miniflare boots, which is also why
        // fixtures cannot be written from inside a running test.
        assets: { directory: "./test/fixtures/spa-root" },
      },
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
