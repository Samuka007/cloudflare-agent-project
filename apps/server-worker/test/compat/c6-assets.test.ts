import { beforeAll, describe, expect, it } from "vitest";
import { ensureMigrations } from "../migrate.js";
import { SELF } from "cloudflare:test";

/**
 * Criterion 6 (port-inventory §6.6): Workers Assets hosts the SPA dist at the
 * domain root with `not_found_handling="single-page-application"`; an
 * `/assets/*` miss must 404, never fall back to index.html (bb server.ts:
 * 640-647 rationale — content-hashed assets are never routes).
 */
beforeAll(ensureMigrations);

describe("criterion 6: SPA fallback + assets 404", () => {
  it("serves index.html at the domain root with no-store", async () => {
    const response = await SELF.fetch("https://example.com/");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(await response.text()).toContain('<div id="root">');
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("falls back to index.html for deep links (SPA routing)", async () => {
    const response = await SELF.fetch("https://example.com/threads/thr_23456789ab");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
  });

  it("404s a missing /assets/* file instead of serving index.html", async () => {
    const response = await SELF.fetch("https://example.com/assets/missing-bundle-abc123.js");
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).not.toContain("text/html");
  });

  it("serves present /assets/* files as immutable", async () => {
    // The real SPA bundle is content-hashed; discover one entry from the
    // served index.html instead of pinning a filename.
    const index = await SELF.fetch("https://example.com/");
    const html = await index.text();
    const asset = /<script[^>]+src="(\/assets\/[^"]+)"/.exec(html)?.[1];
    expect(asset).toBeTruthy();
    const response = await SELF.fetch(`https://example.com${asset}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("javascript");
    expect(response.headers.get("cache-control")).toContain("immutable");
  });
});
