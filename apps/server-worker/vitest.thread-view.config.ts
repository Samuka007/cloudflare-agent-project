/// <reference types="node" />
import { defineConfig } from "vitest/config";

/**
 * #560 diff-harness suite: the dual-path timeline equivalence gate (path A =
 * the retired porting layer, services/timeline.ts; path B = the switched
 * materializer + bb thread-view face, services/thread-view.ts).
 *
 * Deliberately NOT the @cloudflare/vitest-plugin suite: both paths are pure
 * functions over ux envelopes, and the plugin's module pipeline externalizes
 * bb's bare self-imports to workerd, whose native loader cannot serve bb's
 * source-only TS packages (2026-10-10 #560 investigation — every lever
 * tried: wrangler alias, vite resolve.alias, ssr.noExternal, link:/workspace
 * deps, pre-enforce resolveId; the runner resolves inside workerd). The
 * worker face keeps its plugin suite for everything else; this file runs
 * the projection gates in plain node.
 */
export default defineConfig({
  resolve: {
    // bb packages are workspace members (source-only TS); plain vitest
    // resolves + transforms them through vite like every other workspace dep.
    noExternal: ["@bb/domain", "@bb/thread-view", "@bb/server-contract"],
  },
  test: {
    include: ["test/thread-view/**/*.test.ts"],
    environment: "node",
    testTimeout: 30_000,
  },
});
