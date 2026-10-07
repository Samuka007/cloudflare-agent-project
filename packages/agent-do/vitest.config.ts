/// <reference types="node" />
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { existsSync, readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";

/**
 * workerd's BoringSSL trust probing finds no root store on NixOS (the bundle
 * lives behind /etc/static symlinks), so real-model smoke calls fail the TLS
 * handshake. Point it at the bundle when present; no-op on CI/macOS.
 */
const NIX_OS_CA_BUNDLE = "/etc/ssl/certs/ca-certificates.crt";
if (existsSync(NIX_OS_CA_BUNDLE)) {
  process.env.SSL_CERT_FILE ??= NIX_OS_CA_BUNDLE;
}

/**
 * Real-model smoke credentials ride a Vite `define` constant: config files
 * evaluate in Node (fs available), tests run inside workerd (no fs). The
 * values come from the gitignored `.dev.vars` at the repo root — never
 * committed, absent in CI (the smoke skips itself when the constant is
 * empty).
 */
function relayEnvFromDevVars(): Record<string, string> {
  const path = new URL("../../.dev.vars", import.meta.url);
  if (!existsSync(path)) return {};
  const vars: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = /^([A-Z_]+)=(.*)$/.exec(line);
    if (match) vars[match[1]] = match[2];
  }
  return vars;
}

// DO + WebSocket (hibernation) tests require a single shared worker context
// with no per-file isolation (docs/research/testing-strategy-cloudflare-do.md
// §4.4 pit 1), so the whole package runs pinned to one non-isolated worker.
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        // test/migrate.ts imports the control-plane migration files as text
        // (apps/server-worker owns the schema; the rig replays it verbatim so
        // terminal-turn settlement has its `threads` table — #375). Same Text
        // rule apps/server-worker/vitest.config.ts pins for its migrate.ts.
        modulesRules: [{ type: "Text", include: ["**/*.sql"], fallThrough: true }],
      },
    }),
  ],
  define: {
    __RELAY_ENV__: JSON.stringify(relayEnvFromDevVars()),
  },
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["test/smoke-hookup.test.ts"],
    maxWorkers: 1,
    minWorkers: 1,
    isolate: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
