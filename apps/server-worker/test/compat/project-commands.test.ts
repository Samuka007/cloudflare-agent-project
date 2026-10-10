import { beforeAll, describe, expect, it } from "vitest";
import { exports } from "cloudflare:workers";
import { BASE, createThread } from "../helpers.js";
import { ensureMigrations } from "../migrate.js";
import { commandListResponseSchema } from "../../src/contract/api/projects.js";

/**
 * #546: GET /projects/:id/commands — the composer typeahead's data source
 * (bb routes/projects.ts:684-738). The host/skill discovery legs stay
 * deferred (no host to probe, no skills store); the builtin compact row is
 * the whole list, served for every provider — the port's compact engine is
 * the provider-agnostic DO summarizer, so bb's
 * supportsManualCompaction(provider) gate holds unconditionally.
 */
beforeAll(ensureMigrations);

describe("GET /projects/:id/commands (#546)", () => {
  it("serves the builtin compact command for the composer typeahead", async () => {
    const thread = await createThread({ title: "commands-face" });
    const response = await exports.default.fetch(
      `${BASE}/api/v1/projects/${thread.projectId}/commands?provider=rig`,
    );
    expect(response.status).toBe(200);
    const parsed = commandListResponseSchema.parse(await response.json());
    expect(parsed.commands).toEqual([
      {
        name: "compact",
        source: "command",
        origin: "builtin",
        description:
          "Compact context — soft (summarize) | remote (delegated model) | snap (snapshot, no model call)",
        argumentHint: "",
      },
    ]);
  });

  it("404s an unknown project", async () => {
    const response = await exports.default.fetch(
      `${BASE}/api/v1/projects/proj_does_not_exist/commands?provider=rig`,
    );
    expect(response.status).toBe(404);
  });

  it("422s a query without the provider selector", async () => {
    const thread = await createThread({ title: "commands-face-no-provider" });
    const response = await exports.default.fetch(
      `${BASE}/api/v1/projects/${thread.projectId}/commands`,
    );
    expect(response.status).toBe(422);
  });
});
