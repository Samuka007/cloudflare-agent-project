import { fileURLToPath } from "node:url";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const source = (path: string) => fileURLToPath(new URL(path, import.meta.url));

// Runs in workerd: DO SQLite, alarms, and eviction are Cloudflare's own.
export default defineConfig({
  root: source("."),
  plugins: [cloudflareTest({ wrangler: { configPath: source("./wrangler.jsonc") } })],
  test: { include: ["*.test.ts"], testTimeout: 120_000 },
});
