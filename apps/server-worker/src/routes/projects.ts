import { Hono } from "hono";
import {
  createProjectRequestSchema,
  createThreadSectionRequestSchema,
  deleteThreadSectionRequestSchema,
  projectListQuerySchema,
  promptHistoryResponseSchema,
  projectResponseSchema,
  sidebarBootstrapResponseSchema,
  threadSectionMutationResponseSchema,
  updateProjectRequestSchema,
  updateThreadSectionRequestSchema,
  projectWithThreadsResponseSchema,
} from "../contract/api/projects.js";
import {
  PROMPT_HISTORY_ENTRY_LIMIT,
  projectExecutionDefaultsSchema,
  takeVisiblePromptHistoryEntries,
} from "../contract/domain/index.js";
import { threadListEntrySchema } from "../contract/domain/thread.js";
import { ApiError } from "../shared/api-error.js";
import {
  parseBoundedPositiveOptionalInteger,
  parseOr422,
  requireJsonBody,
} from "../shared/route-utils.js";
import { createProjectId, createThreadSectionId } from "../shared/ids.js";
import {
  createProject,
  createThreadSection,
  deleteThreadSection,
  getPersonalProject,
  getProject,
  getThreadSection,
  listPublicProjects,
  listThreadSections,
  listThreads,
  renameThreadSection,
  updateProject,
} from "../db/control-plane.js";
import { listProjectSources } from "../db/project-sources.js";
import { resolveHostRuntimeSnapshot, toThreadListEntry } from "../services/runtime-display.js";
import type { Env, HonoBindings } from "../app-types.js";
import type { ProjectRow } from "../db/rows.js";

/**
 * Projects + sidebar-bootstrap + thread-sections face (bb
 * apps/server/src/routes/projects.ts + routes/thread-sections.ts, commit
 * 8473d8c33). M0 minimal: CRUD + reorder-free listing; sources are
 * host-binding rows only (no file/skill/branch faces).
 */
export function registerProjectRoutes(app: Hono<{ Bindings: HonoBindings }>): void {
  const routes = new Hono<{ Bindings: HonoBindings }>();

  routes.get("/projects", async (ctx) => {
    const query = parseOr422(projectListQuerySchema, ctx.req.query());
    const rows = await listPublicProjects(ctx.env);
    const filtered =
      query.includePersonal === "true" ? rows : rows.filter((row) => row.kind !== "personal");
    const includeThreads = (query.include ?? "").split(",").includes("threads");
    if (!includeThreads) {
      return ctx.json(
        filtered.map((row) =>
          projectResponseSchema.parse({
            ...toPublicProject(row),
            sources: [],
          }),
        ),
      );
    }
    return ctx.json(
      await Promise.all(
        filtered.map(async (row) =>
          projectWithThreadsResponseSchema.parse(await toProjectWithThreads(ctx.env, row)),
        ),
      ),
    );
  });

  routes.post("/projects", async (ctx) => {
    const payload = await requireJsonBody(ctx, createProjectRequestSchema);
    const row = await createProject(ctx.env, {
      id: createProjectId(),
      name: payload.name,
      kind: "standard",
      gitRemoteUrl: null,
    });
    await ctx.env.DB.prepare(
      "INSERT INTO project_sources (id, project_id, is_default, type, host_id, path, created_at, updated_at) VALUES (?, ?, 1, 'local_path', ?, ?, ?, ?)",
    )
      .bind(
        `src_${crypto.randomUUID().replaceAll("-", "").slice(0, 10)}`,
        row.id,
        payload.source.hostId,
        payload.source.path,
        row.createdAt,
        row.createdAt,
      )
      .run();
    return ctx.json(
      projectResponseSchema.parse({
        ...toPublicProject(row),
        sources: await listProjectSources(ctx.env, row.id),
      }),
      201,
    );
  });

  routes.get("/sidebar-bootstrap", async (ctx) => {
    // bb buildSidebarBootstrapResponse (projects.ts:249-277): sections,
    // projects with threads, and the personal singleton (500 when absent).
    const sections = await listThreadSections(ctx.env);
    const personal = await getPersonalProject(ctx.env);
    if (personal?.deletedAt !== null) {
      throw new ApiError({
        status: 500,
        code: "internal",
        message: "Personal project is not initialized",
        retryable: false,
      });
    }
    const projects = await Promise.all(
      (await listPublicProjects(ctx.env))
        .filter((row) => row.kind !== "personal")
        .map(async (row) =>
          projectWithThreadsResponseSchema.parse(await toProjectWithThreads(ctx.env, row)),
        ),
    );
    return ctx.json(
      sidebarBootstrapResponseSchema.parse({
        sections,
        projects,
        personalProject: projectWithThreadsResponseSchema.parse(
          await toProjectWithThreads(ctx.env, personal),
        ),
      }),
    );
  });

  routes.get("/projects/:id", async (ctx) => {
    const row = await requirePublicProject(ctx.env, ctx.req.param("id"));
    return ctx.json(
      projectResponseSchema.parse({
        ...toPublicProject(row),
        sources: await listProjectSources(ctx.env, row.id),
      }),
    );
  });

  routes.patch("/projects/:id", async (ctx) => {
    const payload = await requireJsonBody(ctx, updateProjectRequestSchema);
    await requirePublicProject(ctx.env, ctx.req.param("id"));
    const updated = await updateProject(ctx.env, {
      id: ctx.req.param("id"),
      ...(payload.name !== undefined ? { name: payload.name } : {}),
    });
    if (updated?.deletedAt !== null) {
      throw new ApiError({ status: 404, code: "project_not_found", message: "Project not found" });
    }
    return ctx.json(
      projectResponseSchema.parse({
        ...toPublicProject(updated),
        sources: await listProjectSources(ctx.env, updated.id),
      }),
    );
  });

  routes.delete("/projects/:id", async (ctx) => {
    await requirePublicProject(ctx.env, ctx.req.param("id"));
    await updateProject(ctx.env, {
      id: ctx.req.param("id"),
      deletedAt: Date.now(),
    });
    return ctx.json({ ok: true });
  });

  // bb routes/projects.ts:393-400: public project required, then the stored
  // defaults (typed ProjectExecutionDefaults | null, server-contract
  // public-api.ts:381-388). No composer 404: the resolved runtime default.
  routes.get("/projects/:id/default-execution-options", async (ctx) => {
    await requirePublicProject(ctx.env, ctx.req.param("id"));
    return ctx.json(resolveProjectDefaultExecutionOptions(ctx.env));
  });

  // bb routes/projects.ts:402-418: public project required, limit clamped to
  // PROMPT_HISTORY_ENTRY_LIMIT (bb parseBoundedPositiveOptionalInteger), and
  // the entry array (PromptHistoryResponse, public-api.ts:389-396). The port
  // persists no prompt history yet, so listProjectPromptHistory
  // (services/prompt-history.ts:191-213) runs over an empty store and the
  // visibility pass returns the bb empty list.
  routes.get("/projects/:id/prompt-history", async (ctx) => {
    await requirePublicProject(ctx.env, ctx.req.param("id"));
    const limit = parseBoundedPositiveOptionalInteger({
      defaultValue: PROMPT_HISTORY_ENTRY_LIMIT,
      max: PROMPT_HISTORY_ENTRY_LIMIT,
      name: "limit",
      value: ctx.req.query("limit"),
    });
    return ctx.json(
      promptHistoryResponseSchema.parse(takeVisiblePromptHistoryEntries({ entries: [], limit })),
    );
  });

  app.route("/api/v1", routes);
}

/** bb routes/thread-sections.ts (create/update/delete with mutation counts). */
export function registerThreadSectionRoutes(app: Hono<{ Bindings: HonoBindings }>): void {
  const routes = new Hono<{ Bindings: HonoBindings }>();

  routes.post("/thread-sections", async (ctx) => {
    const payload = await requireJsonBody(ctx, createThreadSectionRequestSchema);
    const section = await createThreadSection(ctx.env, {
      id: createThreadSectionId(),
      name: payload.name,
    });
    return ctx.json(
      threadSectionMutationResponseSchema.parse({
        id: section.id,
        name: section.name,
        updatedThreadCount: 0,
      }),
      201,
    );
  });

  routes.patch("/thread-sections", async (ctx) => {
    const payload = await requireJsonBody(ctx, updateThreadSectionRequestSchema);
    const updated = await renameThreadSection(ctx.env, payload);
    if (!updated) {
      throw new ApiError({ status: 404, code: "section_not_found", message: "Section not found" });
    }
    return ctx.json(
      threadSectionMutationResponseSchema.parse({
        id: updated.id,
        name: updated.name,
        updatedThreadCount: 0,
      }),
    );
  });

  routes.delete("/thread-sections", async (ctx) => {
    const payload = await requireJsonBody(ctx, deleteThreadSectionRequestSchema);
    const existed = await getThreadSection(ctx.env, payload.id);
    if (!existed) {
      throw new ApiError({ status: 404, code: "section_not_found", message: "Section not found" });
    }
    await deleteThreadSection(ctx.env, payload.id);
    return ctx.json(
      threadSectionMutationResponseSchema.parse({
        id: existed.id,
        name: existed.name,
        updatedThreadCount: 0,
      }),
    );
  });

  app.route("/api/v1", routes);
}

function toPublicProject(row: ProjectRow) {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    gitRemoteUrl: row.gitRemoteUrl,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** bb buildProjectsWithThreadsResponseFromRows: visible, non-archived threads. */
async function toProjectWithThreads(env: Env, row: ProjectRow) {
  // One host snapshot per request (#194): every entry's runtime derives from
  // the same attached host.
  const [threads, host] = await Promise.all([
    listThreads(env, { projectId: row.id, archived: false }),
    resolveHostRuntimeSnapshot(env),
  ]);
  return {
    ...toPublicProject(row),
    sources: await listProjectSources(env, row.id),
    threads: threads.map((thread) => threadListEntrySchema.parse(toThreadListEntry(thread, host))),
    defaultExecutionOptions: null,
  };
}

/**
 * bb resolveProjectCreateDefaultExecutionPlan (services/threads/
 * thread-execution-plan.ts:409-424) serves the stored defaults or null; the
 * port has no stored-defaults face yet, so it always resolves the bb
 * ProjectExecutionDefaults shape (packages/domain shared-types.ts:639-645)
 * from runtime policy: the omp provider seam (routes/threads.ts thread
 * create), the relay model (env.MODEL_RELAY_MODEL, falling back to "glm-5.3"
 * exactly like packages/agent-do/src/worker.ts:41), bb's tier and reasoning
 * policy constants (services/threads/thread-default-policy.ts:24-25) and the
 * harness permission default "full" (env.ts HARNESS_PERMISSION_MODE).
 */
function resolveProjectDefaultExecutionOptions(env: Env) {
  const relayModel = env.MODEL_RELAY_MODEL?.trim();
  return projectExecutionDefaultsSchema.parse({
    providerId: "omp",
    model: relayModel === undefined || relayModel === "" ? "glm-5.3" : relayModel,
    serviceTier: "default",
    reasoningLevel: "medium",
    permissionMode: "full",
  });
}

async function requirePublicProject(env: Env, projectId: string): Promise<ProjectRow> {
  const row = await getProject(env, projectId);
  if (!row) {
    throw new ApiError({ status: 404, code: "project_not_found", message: "Project not found" });
  }
  if (row.deletedAt !== null) {
    throw new ApiError({
      status: 410,
      code: "project_unavailable",
      message: "Project is pending deletion",
      details: { reason: "pending_deletion", deletedAt: row.deletedAt },
    });
  }
  return row;
}
