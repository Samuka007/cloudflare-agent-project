/// <reference types="node" />
import { defineConfig } from "vitest/config";

/**
 * #560 diff-harness suite: the dual-path timeline equivalence gate (path A =
 * the retired porting layer, services/timeline.ts; path B = the switched
 * materializer + bb thread-view face, services/thread-view.ts).
 *
 * Deliberately NOT the @cloudflare/vitest-plugin suite: both paths are pure
 * functions over ux envelopes, and running them in plain node keeps the
 * dual-path comparison free of worker boot machinery. (#566: the bb packages
 * now ship JS dist, so the plugin pipeline would also load them — the worker
 * face route E2E covers that path; this file stays the pure-node gate.)
 */
export default defineConfig({
  test: {
    include: ["test/thread-view/**/*.test.ts"],
    environment: "node",
    testTimeout: 30_000,
  },
});
