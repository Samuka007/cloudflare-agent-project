import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// DO + WebSocket (hibernation) tests require a single shared worker context
// with no per-file isolation (docs/research/testing-strategy-cloudflare-do.md
// §4.4 pit 1) — same shape as packages/agent-do.
export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })],
  test: {
    // tool-runtime.test.ts + eval-kernel.test.ts + the per-tool semantic
    // suites run under `bun test` (the omp runtime + eval kernel library
    // need Bun); the Workers-side L1 suites stay here.
    exclude: [
      "**/node_modules/**",
      "test/tool-runtime.test.ts",
      "test/eval-kernel.test.ts",
      "test/l1-read-semantics.test.ts",
      "test/l1-glob-grep-semantics.test.ts",
      "test/l1-edit-semantics.test.ts",
      "test/l1-find-semantics.test.ts",
      "test/l1-task-isolation.test.ts",
      "test/l1-security-scan.test.ts",
    ],
    maxWorkers: 1,
    minWorkers: 1,
    isolate: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
