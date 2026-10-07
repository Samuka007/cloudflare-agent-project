import { beforeAll, describe, expect, it } from "vitest";
import { ensureMigrations } from "../migrate.js";
import { sidebarBootstrapResponseSchema } from "../../src/contract/api/projects.js";
import { systemConfigResponseSchema } from "../../src/contract/api/system.js";
import { createThread, holdRigWire, send } from "../helpers.js";
import { exports } from "cloudflare:workers";

/**
 * Criterion 1 (port-inventory §6.1): 首屏双读 — the SPA's first network
 * dependency is GET /system/config + GET /sidebar-bootstrap, both must parse
 * against the bb contract schemas with zero SPA-side knowledge of the port.
 */
beforeAll(ensureMigrations);

describe("criterion 1: first-screen dual reads", () => {
  it("serves a contract-valid /system/config", async () => {
    const response = await exports.default.fetch("https://example.com/api/v1/system/config");
    expect(response.status).toBe(200);
    const body = await response.json();
    const parsed = systemConfigResponseSchema.parse(body);
    expect(parsed.generalSettings.onboardingCompletedAt).toBeNull();
    expect(parsed.serverUrl).toMatch(/^https?:\/\//);
    expect(parsed.voiceTranscriptionEnabled).toBe(false);
  });

  it("serves a contract-valid /sidebar-bootstrap with the personal singleton", async () => {
    // Seed one thread so the sidebar has content to group.
    const thread = await createThread({ title: "bootstrap-visible" });
    const response = await exports.default.fetch("https://example.com/api/v1/sidebar-bootstrap");
    expect(response.status).toBe(200);
    const parsed = sidebarBootstrapResponseSchema.parse(await response.json());
    expect(parsed.personalProject.kind).toBe("personal");
    expect(parsed.projects.every((project) => project.kind !== "personal")).toBe(true);
    const listedIds = parsed.personalProject.threads.map((entry) => entry.id);
    expect(listedIds).toContain(thread.id);
  });

  it("creates threads through the same face the composer uses", async () => {
    // Hold the rig wire so the send's turn is deterministically IN FLIGHT at
    // the read — the rigged wire otherwise settles before the response
    // round-trips and the coarse-active pin would race.
    const gate = holdRigWire();
    try {
      const thread = await createThread({ title: "first-turn" });
      await send(thread.id);
      const detail = await exports.default.fetch(
        `https://example.com/api/v1/threads/${thread.id}`,
      );
      expect(detail.status).toBe(200);
      const body = await detail.json<{ status: string }>();
      // M0 coarse transition: a recorded send flips the thread active.
      expect(body.status).toBe("active");
    } finally {
      gate.release();
    }
  });
});
