import { beforeAll, describe, expect, it } from "vitest";
import { exports } from "cloudflare:workers";
import { ensureMigrations } from "../migrate.js";
import {
  systemConfigResponseSchema,
  systemExecutionOptionsResponseSchema,
  systemVersionResponseSchema,
} from "../../src/contract/api/system.js";
import { buildExecutionOptions } from "../../src/routes/system.js";

/**
 * Ticket #41: GET /system/execution-options — the model catalog behind the
 * SPA model picker ("Failed to load models" blocker). The response shape is
 * bb-verbatim: bb packages/server-contract/src/api/system.ts:35-58 (response
 * schema), construction at bb apps/server/src/services/system/
 * execution-options.ts:484-490, route at bb apps/server/src/routes/system.ts:
 * 347-349 (path public-api.ts:1405-1409). M0 semantics: no host probing —
 * one provider "omp" whose only model is the relay model turns actually run.
 */
beforeAll(ensureMigrations);

describe("GET /api/v1/system/execution-options", () => {
  it("serves a contract-valid catalog with the single omp provider", async () => {
    const response = await exports.default.fetch(
      "https://example.com/api/v1/system/execution-options",
    );
    expect(response.status).toBe(200);
    const parsed = systemExecutionOptionsResponseSchema.parse(await response.json());
    expect(parsed.providers).toHaveLength(1);
    expect(parsed.providers[0]?.id).toBe("omp");
    expect(parsed.providers[0]?.available).toBe(true);
    expect(parsed.permissionCeiling).toBe("full");
    expect(parsed.modelLoadError).toBeNull();
    expect(parsed.selectedOnlyModels).toEqual([]);
    expect(parsed.models).toHaveLength(1);
    expect(parsed.models[0]?.isDefault).toBe(true);
    // The glm relay runs thinking disabled, so the only offered reasoning
    // level is "none" (bb reasoningLevelValues, domain/shared-types.ts:13-20).
    expect(
      parsed.models[0]?.supportedReasoningEfforts.map((effort) => effort.reasoningEffort),
    ).toEqual(["none"]);
    expect(parsed.models[0]?.defaultReasoningEffort).toBe("none");
  });

  it("takes the advertised model name from MODEL_RELAY_MODEL", () => {
    // Staging sets MODEL_RELAY_MODEL; the endpoint must advertise exactly the
    // model the agent runtime will run (agent-do worker.ts reads the same var).
    const configured = systemExecutionOptionsResponseSchema.parse(
      buildExecutionOptions({ MODEL_RELAY_MODEL: "glm-5.3-air" }),
    );
    expect(configured.models.map((model) => model.model)).toEqual(["glm-5.3-air"]);
    expect(configured.models.map((model) => model.id)).toEqual(["glm-5.3-air"]);
    // Unset env falls back to the staging relay model name.
    const fallback = systemExecutionOptionsResponseSchema.parse(buildExecutionOptions({}));
    expect(fallback.models.map((model) => model.model)).toEqual(["glm-5.3-anth"]);
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
