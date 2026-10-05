import { existsSync, readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";

/**
 * Same shape as the @cap/scripts suite the core tests moved from (#270):
 * workerd-free plain-node, NixOS TLS pin, gitignored .env.local → process.env
 * so the real-call jev smoke can find JEV_API_KEY (CI skips it without one).
 */
const NIX_OS_CA_BUNDLE = "/etc/ssl/certs/ca-certificates.crt";
if (existsSync(NIX_OS_CA_BUNDLE)) {
  process.env.SSL_CERT_FILE ??= NIX_OS_CA_BUNDLE;
}

const envLocal = new URL("../../.env.local", import.meta.url);
if (existsSync(envLocal)) {
  for (const line of readFileSync(envLocal, "utf8").split("\n")) {
    const match = /^([A-Z_]+)=(.*)$/.exec(line);
    if (match !== null) {
      const name = match[1];
      if (name !== undefined) process.env[name] ??= match[2] ?? "";
    }
  }
}

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
