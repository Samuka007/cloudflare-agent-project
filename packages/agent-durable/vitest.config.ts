import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        // The drizzle-kit generated journal DDL (#602) is a static text
        // import replayed by src/db/bootstrap.ts — same rule as the
        // server-worker rig.
        modulesRules: [{ type: "Text", include: ["**/*.sql"], fallThrough: true }],
      },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
    maxWorkers: 1,
    minWorkers: 1,
    isolate: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
