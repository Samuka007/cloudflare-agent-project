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
 * through the same resolution the harness runs (provider-app
 * resolveOverlayCatalog) — #434: no configured rows → an EMPTY directory
 * (nothing synthesized); only configured rows are served.
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
      buildExecutionOptions({}, PROVIDERS),
    );
    expect(parsed.providers).toHaveLength(1);
    expect(parsed.providers[0]?.id).toBe("declared");
    expect(parsed.providers[0]?.available).toBe(true);
    expect(parsed.permissionCeiling).toBe("full");
    expect(parsed.modelLoadError).toBeNull();
    expect(parsed.selectedOnlyModels).toEqual([]);
    expect(parsed.models).toHaveLength(1);
    expect(parsed.models[0]?.isDefault).toBe(true);
    // The declared ladder is the offer; budget off collapses it to "none".
    expect(
      parsed.models[0]?.supportedReasoningEfforts.map((effort) => effort.reasoningEffort),
    ).toEqual(["none"]);
    expect(parsed.models[0]?.defaultReasoningEffort).toBe("none");
  });

  it("takes the advertised model name from MODEL_RELAY_MODEL", () => {
    // Staging sets MODEL_RELAY_MODEL; the endpoint must advertise exactly the
    // model the agent runtime will run (agent-do worker.ts reads the same var).
    const configured = systemExecutionOptionsResponseSchema.parse(
      buildExecutionOptions(
        { MODEL_RELAY_MODEL: "glm-5.3-air" },
        {
          main: { models: [{ id: "glm-5.3-air" }, { id: "spare" }] },
        },
      ),
    );
    expect(configured.models.map((model) => model.model)).toEqual(["glm-5.3-air", "spare"]);
    expect(configured.models.map((model) => model.id)).toEqual(["glm-5.3-air", "spare"]);
    // The rows are NOT auto-defaulted by the face: the running marker follows
    // the harness model only when the configured rows carry it.
    expect(configured.models.filter((model) => model.isDefault)).toHaveLength(1);
  });

  it("projects the image-input capability from MODEL_RELAY_IMAGE_INPUT (#319)", () => {
    // The same harness resolution the provider-app reads — the picker face
    // and the relay wire dispatch can never disagree.
    const declared = systemExecutionOptionsResponseSchema.parse(
      buildExecutionOptions({ MODEL_RELAY_IMAGE_INPUT: "1" }, PROVIDERS),
    );
    expect(declared.providers[0]?.capabilities.supportsImageInput).toBe(true);
    const undeclared = systemExecutionOptionsResponseSchema.parse(
      buildExecutionOptions({}, PROVIDERS),
    );
    expect(undeclared.providers[0]?.capabilities.supportsImageInput).toBe(false);
  });

  it("#450 projects configured multi-provider rows verbatim", () => {
    const parsed = systemExecutionOptionsResponseSchema.parse(
      buildExecutionOptions(
        {},
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
    // Budget on + declared default → the picker offers the declared ladder
    // with the declared rung — the same derivation the harness execution
    // reports (same resolution).
    const declared = systemExecutionOptionsResponseSchema.parse(
      buildExecutionOptions(
        { MODEL_RELAY_THINKING_BUDGET_TOKENS: "4096" },
        {
          omp: {
            models: [
              {
                id: "glm-5.3",
                reasoningLevels: ["none", "low", "medium", "high"],
                defaultReasoningLevel: "high",
              },
            ],
          },
        },
      ),
    );
    expect(
      declared.models[0]?.supportedReasoningEfforts.map((effort) => effort.reasoningEffort),
    ).toEqual(["none", "low", "medium", "high"]);
    expect(declared.models[0]?.defaultReasoningEffort).toBe("high");
    // Budget on without configured rows → NO rows at all (#434: nothing is
    // synthesized, so there is no implicit "medium" row to serve).
    const undeclared = systemExecutionOptionsResponseSchema.parse(
      buildExecutionOptions({ MODEL_RELAY_THINKING_BUDGET_TOKENS: "4096" }, {}),
    );
    expect(undeclared.models).toEqual([]);
    expect(undeclared.providers).toEqual([]);
  });

  it("#434 leaves the running model unmarked when the rows omit it", () => {
    const parsed = systemExecutionOptionsResponseSchema.parse(
      buildExecutionOptions({ MODEL_RELAY_MODEL: "glm-5.3" }, {
        main: { models: [{ id: "glm-5.3-flash" }] },
      }),
    );
    // #434: the omission is configuration — the configured row serves, and
    // nothing is synthesized under it to carry the default marker.
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
