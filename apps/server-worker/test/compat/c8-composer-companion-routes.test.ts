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
import { createThread } from "../helpers.js";
import { exports } from "cloudflare:workers";

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

  it("serves null default-execution-options unconditionally (#434/#450)", async () => {
    // D1 rows carry no deployment-wide default declaration (the env seed is
    // retired), so the face ALWAYS serves bb's stored-defaults-absent shape:
    // null — never a synthesized row (the composer sends the picker's
    // explicit selection; #450 the configured/row-present state is
    // equivalent, so one case pins the face).
    const response = await apiGet("/api/v1/projects/proj_personal/default-execution-options");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toBeNull();
    // bb contract (public-api.ts:384-385) validates the (empty) query schema.
    expect(projectDefaultExecutionOptionsQuerySchema.parse({})).toEqual({});
  });

  it("404s default-execution-options with project_not_found for an unknown project", async () => {
    const response = await apiGet("/api/v1/projects/prj_missing/default-execution-options");
    expect(response.status).toBe(404);
    const body = await response.json<{ code: string }>();
    expect(body.code).toBe("project_not_found");
  });
});
