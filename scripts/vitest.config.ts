import { existsSync, readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";

/**
 * workerd-free plain-node suite, but the same NixOS TLS pit applies to real
 * network calls from Node itself (no root store behind /etc/static symlinks):
 * point it at the bundle when present; no-op on CI/macOS.
 */
const NIX_OS_CA_BUNDLE = "/etc/ssl/certs/ca-certificates.crt";
if (existsSync(NIX_OS_CA_BUNDLE)) {
  process.env.SSL_CERT_FILE ??= NIX_OS_CA_BUNDLE;
}

/**
 * Gitignored `.env.local` at the repo root → process.env so the real-call
 * jev smoke can find JEV_API_KEY. Environment values already set win; the
 * file is NEVER committed, CI just skips the smoke.
 */
const envLocal = new URL("../.env.local", import.meta.url);
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
