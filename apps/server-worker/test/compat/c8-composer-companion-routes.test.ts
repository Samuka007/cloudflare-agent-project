import { beforeAll, describe, expect, it } from "vitest";
import { ensureMigrations } from "../migrate.js";
import {
  pluginContributionsResponseSchema,
  pluginListResponseSchema,
} from "../../src/contract/api/plugins.js";
import {
  promptHistoryResponseSchema,
  projectDefaultExecutionOptionsQuerySchema,
} from "../../src/contract/api/projects.js";
import { projectExecutionDefaultsSchema } from "../../src/contract/domain/index.js";
import { createThread, restoreRigRelayCatalog, unsetRigRelayCatalog } from "../helpers.js";
import { env, exports } from "cloudflare:workers";

/**
 * Criterion 8 (issue #40): the composer's startup companion reads —
 * GET /plugins, GET /plugins/contributions, GET /projects/:id/prompt-history,
 * GET /projects/:id/default-execution-options — must all answer 200 with the
 * bb shapes (bb routes/plugins.ts:196-206, routes/projects.ts:393-418, commit
 * 8473d8c33) instead of the 404s the SPA saw before this face existed.
 */
beforeAll(ensureMigrations);

const BASE = "https://example.com";

function apiGet(path: string): Promise<Response> {
  return exports.default.fetch(`${BASE}${path}`);
}

describe("criterion 8: composer companion routes", () => {
  it("serves the schema-valid /plugins list", async () => {
    const response = await apiGet("/api/v1/plugins");
    expect(response.status).toBe(200);
    const body = await response.json();
    // #382: the static registry tracks the cap-provider-config bundle (the
    // fixture descriptor stands in for the staged one), so the list is no
    // longer pinned to the experiment-off empty state — but it still parses
    // against the bb installedPlugin schema, which is what the SPA's SDK
    // client enforces.
    const parsed = pluginListResponseSchema.parse(body);
    expect(parsed.plugins.map((plugin) => plugin.id)).toEqual(["cap-provider-config"]);
  });

  it("serves the bb empty /plugins/contributions metadata", async () => {
    const response = await apiGet("/api/v1/plugins/contributions");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(pluginContributionsResponseSchema.parse(body)).toEqual({
      cliCommands: [],
      mentionProviders: [],
    });
  });

  it("serves the bb empty prompt-history list for an existing project", async () => {
    const { projectId } = await createThread({ title: "prompt-history-visible" });
    const response = await apiGet(`/api/v1/projects/${projectId}/prompt-history`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(promptHistoryResponseSchema.parse(body)).toEqual([]);
  });

  it("keeps bb limit semantics on prompt-history (garbage → 400, clamped → 200)", async () => {
    const { projectId } = await createThread({ title: "prompt-history-limits" });
    const garbage = await apiGet(`/api/v1/projects/${projectId}/prompt-history?limit=abc`);
    expect(garbage.status).toBe(400);
    const errorBody = await garbage.json<{ code: string }>();
    expect(errorBody.code).toBe("invalid_request");

    const zero = await apiGet(`/api/v1/projects/${projectId}/prompt-history?limit=0`);
    expect(zero.status).toBe(400);

    const bounded = await apiGet(`/api/v1/projects/${projectId}/prompt-history?limit=3`);
    expect(bounded.status).toBe(200);
    expect(promptHistoryResponseSchema.parse(await bounded.json())).toEqual([]);
  });

  it("404s prompt-history with project_not_found for an unknown project (bb requirePublicProject)", async () => {
    const response = await apiGet("/api/v1/projects/prj_missing/prompt-history");
    expect(response.status).toBe(404);
    const body = await response.json<{ code: string }>();
    expect(body.code).toBe("project_not_found");
  });

  it("serves null default-execution-options when no defaultProvider is declared (#434)", async () => {
    // The L1 rig declares a catalog (#434); the null shape is asserted with
    // the binding locally unset (a declaration without defaultProvider).
    unsetRigRelayCatalog();
    try {
      // The seeded personal project — an unconfigured deployment admits no
      // thread create at all (the fail-closed 422), so no thread is made.
      const response = await apiGet("/api/v1/projects/proj_personal/default-execution-options");
      expect(response.status).toBe(200);
      const body = await response.json();
      // bb's stored-defaults-absent shape: the declaration names no
      // defaultProvider, so the face serves null — never a synthesized row
      // (the composer falls back to the picker's explicit selection).
      expect(body).toBeNull();
      // bb contract (public-api.ts:384-385) validates the (empty) query schema.
      expect(projectDefaultExecutionOptionsQuerySchema.parse({})).toEqual({});
    } finally {
      restoreRigRelayCatalog();
    }
  });

  it("serves resolved default-execution-options when the declaration names a default", async () => {
    (env as unknown as Record<string, string>).MODEL_RELAY_CATALOG = JSON.stringify({
      defaultProvider: "declared",
      providers: {
        declared: { models: [{ id: "declared-model", defaultReasoningLevel: "none" }] },
      },
    });
    try {
      const { projectId } = await createThread({ title: "defaults-declared" });
      const response = await apiGet(`/api/v1/projects/${projectId}/default-execution-options`);
      expect(response.status).toBe(200);
      const parsed = projectExecutionDefaultsSchema.parse(await response.json());
      expect(parsed.providerId).toBe("declared");
      // The harness model folds the declaration's default row (the running
      // model), so the defaults face names exactly what turns run.
      expect(parsed.model).toBe("declared-model");
      expect(parsed.serviceTier).toBe("default");
      // #350 three-face convergence: with the thinking budget unset the relay
      // runs thinking disabled, so the defaults face reports "none" — the same
      // derivation the execution-options ladder and the harness execution use.
      expect(parsed.reasoningLevel).toBe("none");
      expect(parsed.permissionMode).toBe("full");
    } finally {
      restoreRigRelayCatalog();
    }
  });

  it("404s default-execution-options with project_not_found for an unknown project", async () => {
    const response = await apiGet("/api/v1/projects/prj_missing/default-execution-options");
    expect(response.status).toBe(404);
    const body = await response.json<{ code: string }>();
    expect(body.code).toBe("project_not_found");
  });
});
