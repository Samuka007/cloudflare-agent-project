import { beforeAll, describe, expect, it } from "vitest";
import { ensureMigrations } from "../migrate.js";
import { SELF } from "cloudflare:test";

/**
 * Criterion 7 (port-inventory §6.7): SDK fetches carry
 * `x-bb-app-surface: web`; the Worker must accept and pass them through
 * without error.
 */
beforeAll(ensureMigrations);

describe("criterion 7: x-bb-app-surface passthrough", () => {
  it("serves API reads with the surface header present", async () => {
    const response = await SELF.fetch("https://example.com/api/v1/threads", {
      headers: { "x-bb-app-surface": "web" },
    });
    expect(response.status).toBe(200);
    expect(Array.isArray(await response.json())).toBe(true);
  });

  it("serves mutations with the surface header present", async () => {
    const response = await SELF.fetch("https://example.com/api/v1/threads", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-bb-app-surface": "web",
      },
      body: JSON.stringify({
        projectId: "proj_personal",
        origin: "app",
        environment: { type: "host", workspace: { type: "personal" } },
        input: [{ type: "text", text: "surface header probe" }],
      }),
    });
    expect(response.status).toBe(201);
  });

  it("keeps /health open for liveness probes", async () => {
    const response = await SELF.fetch("https://example.com/health");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });
});
