import { beforeAll, describe, expect, it } from "vitest";
import { exports } from "cloudflare:workers";
import {
  ensureRigProviderRow,
  removeRigProviderRow,
} from "../helpers.js";
import { ensureMigrations } from "../migrate.js";
import {
  systemConfigResponseSchema,
  systemExecutionOptionsResponseSchema,
  systemVersionResponseSchema,
} from "../../src/contract/api/system.js";
import { buildExecutionOptions } from "../../src/routes/system.js";
import type { RelayCatalogProvider } from "@cap/agent-do";

/**
 * Ticket #41: GET /system/execution-options — the model catalog behind the
 * SPA model picker ("Failed to load models" blocker). The response shape is
 * bb-verbatim: bb packages/server-contract/src/api/system.ts:35-58 (response
 * schema), construction at bb apps/server/src/services/system/
 * execution-options.ts:484-490, route at bb apps/server/src/routes/system.ts:
 * 347-349 (path public-api.ts:1405-1409). No host probing; the catalog is
 * the D1 provider-config 正本 (#450 — the env seed is deleted) projected
 * through the same resolution the dispatch registry runs (provider-app
 * resolveOverlayCatalog) — #434: no configured rows → an EMPTY directory
 * (nothing synthesized); only configured rows are served. #500: no
 * deployment env takes part — row declarations (ladder budget / input) are
 * the whole truth and no row is ever marked default.
 */
beforeAll(async () => {
  await ensureMigrations();
  await ensureRigProviderRow();
});

const PROVIDERS: Record<string, RelayCatalogProvider> = {
  declared: { models: [{ id: "glm-5.3", reasoningLevels: ["none"], defaultReasoningLevel: "none" }] },
};

describe("GET /api/v1/system/execution-options", () => {
  it("serves the empty directory on an unconfigured deployment (#434)", async () => {
    // The L1 rig seeds a configured D1 row (#450); the unconfigured face is
    // asserted with the row removed locally and restored afterwards.
    await removeRigProviderRow();
    try {
      const response = await exports.default.fetch(
        "https://example.com/api/v1/system/execution-options",
      );
      expect(response.status).toBe(200);
      const parsed = systemExecutionOptionsResponseSchema.parse(await response.json());
      expect(parsed.providers).toEqual([]);
      expect(parsed.permissionCeiling).toBe("full");
      expect(parsed.modelLoadError).toBeNull();
      expect(parsed.selectedOnlyModels).toEqual([]);
      expect(parsed.models).toEqual([]);
    } finally {
      await ensureRigProviderRow();
    }
  });

  it("serves a contract-valid single-provider catalog from the configured rows", () => {
    const parsed = systemExecutionOptionsResponseSchema.parse(
      buildExecutionOptions(PROVIDERS),
    );
    expect(parsed.providers).toHaveLength(1);
    expect(parsed.providers[0]?.id).toBe("declared");
    expect(parsed.providers[0]?.available).toBe(true);
    expect(parsed.permissionCeiling).toBe("full");
    expect(parsed.modelLoadError).toBeNull();
    expect(parsed.selectedOnlyModels).toEqual([]);
    expect(parsed.models).toHaveLength(1);
    // #500: no deployment model is named — no row is the default (nothing
    // invented).
    expect(parsed.models[0]?.isDefault).toBe(false);
    // The declared ladder is the offer; budget off collapses it to "none".
    expect(
      parsed.models[0]?.supportedReasoningEfforts.map((effort) => effort.reasoningEffort),
    ).toEqual(["none"]);
    expect(parsed.models[0]?.defaultReasoningEffort).toBe("none");
  });

  it("projects the image-input capability from the row declaration (#319/#500)", () => {
    // The row declaration is the ONE source — the picker face and the relay
    // wire dispatch can never disagree.
    const declared = systemExecutionOptionsResponseSchema.parse(
      buildExecutionOptions({
        main: { models: [{ id: "glm-5.3", input: ["text", "image"] }] },
      }),
    );
    expect(declared.providers[0]?.capabilities.supportsImageInput).toBe(true);
    const undeclared = systemExecutionOptionsResponseSchema.parse(
      buildExecutionOptions({ main: { models: [{ id: "glm-5.3" }] } }),
    );
    expect(undeclared.providers[0]?.capabilities.supportsImageInput).toBe(false);
  });

  it("#450 projects configured multi-provider rows verbatim", () => {
    const parsed = systemExecutionOptionsResponseSchema.parse(
      buildExecutionOptions(
        {
          main: {
            displayName: "Main relay",
            serviceTier: true,
            models: [
              {
                id: "glm-5.3",
                name: "GLM-5.3",
                description: "Flagship",
                input: ["text", "image"],
                reasoningLevels: ["none", "low", "high"],
                defaultReasoningLevel: "high",
              },
              { id: "glm-5.3-air", name: "GLM-5.3-Air" },
            ],
          },
          backup: { models: [{ id: "glm-5.3-flash" }] },
        },
      ),
    );
    expect(parsed.providers.map((provider) => [provider.id, provider.displayName])).toEqual([
      ["main", "Main relay"],
      ["backup", "backup"],
    ]);
    expect(parsed.providers[0]?.capabilities.supportsServiceTier).toBe(true);
    expect(parsed.providers[1]?.capabilities.supportsServiceTier).toBe(false);
    expect(parsed.models.map((model) => model.displayName)).toEqual([
      "GLM-5.3",
      "GLM-5.3-Air",
      "glm-5.3-flash",
    ]);
    // Budget off → every ladder collapses to [none]; the wire cannot run
    // any budget rung (roadmap §2.3 contradiction 2).
    expect(parsed.models.map((model) => model.defaultReasoningEffort)).toEqual([
      "none",
      "none",
      "none",
    ]);
  });

  it("#362 reflects the thinking budget in the ladder and honors the declared default", () => {
    // #500: the row's thinkingBudgetTokens is the budget — budget on +
    // declared default → the picker offers the declared ladder with the
    // declared rung (the same derivation the dispatch registry runs).
    const declared = systemExecutionOptionsResponseSchema.parse(
      buildExecutionOptions({
        omp: {
          models: [
            {
              id: "glm-5.3",
              reasoningLevels: ["none", "low", "medium", "high"],
              defaultReasoningLevel: "high",
              thinkingBudgetTokens: 4096,
            },
          ],
        },
      }),
    );
    expect(
      declared.models[0]?.supportedReasoningEfforts.map((effort) => effort.reasoningEffort),
    ).toEqual(["none", "low", "medium", "high"]);
    expect(declared.models[0]?.defaultReasoningEffort).toBe("high");
    // No configured rows → NO rows at all (#434: nothing is synthesized).
    const undeclared = systemExecutionOptionsResponseSchema.parse(
      buildExecutionOptions({}),
    );
    expect(undeclared.models).toEqual([]);
    expect(undeclared.providers).toEqual([]);
  });

  it("#434/#500 never marks a row default — no deployment model exists", () => {
    const parsed = systemExecutionOptionsResponseSchema.parse(
      buildExecutionOptions({
        main: { models: [{ id: "glm-5.3-flash" }] },
      }),
    );
    // The configured row serves, and nothing is synthesized to carry a
    // default marker (the selection is always explicit).
    expect(parsed.models.map((model) => model.model)).toEqual(["glm-5.3-flash"]);
    expect(parsed.models.filter((model) => model.isDefault)).toHaveLength(0);
  });

  it("422s the mutually exclusive host/environment routing like bb", async () => {
    const response = await exports.default.fetch(
      "https://example.com/api/v1/system/execution-options?hostId=h1&environmentId=e1",
    );
    expect(response.status).toBe(422);
  });

  it("leaves the existing system faces untouched (config/version)", async () => {
    const config = await exports.default.fetch("https://example.com/api/v1/system/config");
    expect(config.status).toBe(200);
    expect(systemConfigResponseSchema.parse(await config.json()).serverUrl).toMatch(/^https?:\/\//);
    const version = await exports.default.fetch("https://example.com/api/v1/system/version");
    expect(version.status).toBe(200);
    expect(systemVersionResponseSchema.parse(await version.json()).currentVersion).toBe(
      "0.0.0-dev",
    );
  });
});
