import { Hono } from "hono";
import type { HostRpcCommand } from "@cap/daemon-service";
import { activeTurnIdFromEvents, type RelaySelection } from "@cap/agent-do";
import { CLOUD_PLACEHOLDER_HOST_ID } from "@cap/protocol";
import {
  classifyThreadSelectionChange,
  resolveThreadExecutionOverridePatch,
  resolveStoredThreadExecution,
  resolveThreadDefaultExecutionOptions,
  validateThreadExecutionSelection,
} from "../services/execution-selection.js";
import {
  createThreadRequestSchema,
  deleteThreadRequestSchema,
  sendMessageRequestSchema,
  rebindThreadEnvironmentRequestSchema,
  threadSearchQuerySchema,
  threadSearchResponseSchema,
  threadEventsQuerySchema,
  threadGetQuerySchema,
  threadHostFileContentQuerySchema,
  threadListQuerySchema,
  threadTimelineQuerySchema,
  updateThreadRequestSchema,
  resolvePendingInteractionRequestSchema,
  type ThreadResponse,
} from "../contract/api/threads.js";
import { getPermissionMode } from "../db/permission-mode.js";
import { promptHistoryResponseSchema } from "../contract/api/projects.js";
import {
  PROMPT_HISTORY_ENTRY_LIMIT,
  resolvedThreadExecutionOptionsSchema,
  takeVisiblePromptHistoryEntries,
} from "../contract/domain/index.js";
import { updateThreadTabsRequestSchema } from "../contract/api/thread-tabs.js";
/**
 * bb events route responses are ThreadEventRow[]; the M0 log lives in the
 * agent DO whose UX projection shares the bb envelope ({id, scope, threadId,
 * seq, type, data, createdAt}) with type/data drawn from the protocol UX
 * union rather than bb's full per-type data schemas. The SPA parses this
 * route leniently; the full union grows back with #29/#30 integration.
 */
interface PortedThreadEventRow {
  id: string;
  scope: "thread";
  threadId: string;
  seq: number;
  type: string;
  data: unknown;
  createdAt: number;
}
import {
  CLIENT_TURN_REQUEST_ID_ALPHABET,
  formatClientTurnRequestIdSuffix,
} from "../contract/domain/protocol-ids.js";
import { ApiError } from "../shared/api-error.js";
import {
  parseBoundedPositiveOptionalInteger,
  parseOr422,
  requireJsonBody,
} from "../shared/route-utils.js";
import { createThreadId } from "../shared/ids.js";
import {
  createThreadRecord,
  getThreadRow,
  listThreads,
  markThreadDeleted,
  countNonDeletedAssignedChildThreads,
  pinThread,
  setThreadArchived,
  unpinThread,
  updateThreadRecord,
  getThreadSection,
  getProject,
} from "../db/control-plane.js";
import type { ThreadDbRow } from "../db/rows.js";
import { getEnvironmentRow } from "../db/environments.js";
import { environmentSchema } from "../contract/domain/environment.js";
import { getHostRow } from "../db/hosts.js";
import { getStoredThreadTabs, replaceStoredThreadTabs } from "../db/thread-tabs.js";
import { mirrorPendingInteraction } from "../db/pending-interactions.js";
import { getAppSettingsRow, toAppSettings } from "../db/settings.js";
import { loadProviderConfigCatalogOverlay } from "@cap/provider-app";
import {
  toThreadListEntries,
  toThreadResponseWithSpawnCheck,
} from "../services/runtime-display.js";
import { toHostRecord } from "../services/host-records.js";
import {
  THREAD_SEARCH_LIMIT_PER_GROUP_DEFAULT,
  THREAD_SEARCH_LIMIT_PER_GROUP_MAX,
  buildTitleSearchResponse,
  countNonWhitespaceChars,
} from "../services/thread-search.js";
import { deriveTitleFallback } from "../services/title-generation.js";

import {
  requirePublicInteractionRow,
  toPublicPendingInteraction,
  toPublicPendingInteractions,
} from "../services/pending-interactions.js";
import { settleThreadTurnStatus } from "../services/thread-run-settlement.js";
import {
  HOST_COMMAND_TIMEOUT_MS,
  buildHostFileContentResponse,
  daemonServiceStubOrNull,
  hostFileHostUnavailable,
  remapHostFileRouteError,
} from "../services/host-files.js";
import { hostFileReadResultSchema } from "../contract/api/hosts.js";
import {
  buildConversationOutline,
  buildActiveThinking,
  buildTimelinePage,
  buildContextWindowUsage,
  mergeTimelineRows,
  projectTimelineRows,
  projectUnhandledProviderRows,
  timelineLatestRowsCache,
} from "../services/timeline.js";
import { computeTimelineRowDelta } from "../contract/thread-timeline.js";
import { validatePromptAttachmentReferences } from "../services/attachments.js";
import { agentDoCancelTurn, agentDoCompactThread, agentDoFor } from "../seam/agent-do.js";
import { resolveThreadBinding } from "../services/thread-binding.js";
import type { PromptInput } from "../contract/domain/shared-types.js";
import type { PromptContent } from "@cap/protocol";
import type { AppEnv, Env } from "../app-types.js";

/**
 * #496: the DO refuses a dispatch that would ride no selection (no journaled
 * pin — no legacy materialization either) with the `selection_missing:`
 * marker; the RPC boundary rethrows remote errors without their class (the
 * compact route's
 * message-match precedent), so the marker maps to the create-face 422 shape
 * — the fail-closed refusal is a caller error, not a server fault.
 */
function mapSelectionMissing(error: unknown): unknown {
  if (error instanceof Error && error.message.startsWith("selection_missing")) {
    return new ApiError({
      status: 422,
      code: "selection_missing",
      message: error.message,
      retryable: false,
    });
  }
  return error;
}


/** bb timeline.ts:163-165. */
const THREAD_TIMELINE_DEFAULT_SEGMENT_LIMIT = 20;
const THREAD_TIMELINE_SEGMENT_LIMIT_MAX = 100;

/** bb hub metadata carries the recorded client action types. */
const SEND_EVENT_TYPES = ["client/turn/requested"] as const;

/**
 * M0 thread face (ruling #7 subset): base/actions/data/tabs/interactions
 * routes the SPA's active surfaces consume. Queue, edit-message, fork,
 * rate-limit-recovery, storage face are additive families (#27+). The
 * host-file face opened its minimal subset — content read only (#321).
 */
export function registerThreadRoutes(app: Hono<AppEnv>): void {
  const routes = new Hono<AppEnv>();

  // --- list -------------------------------------------------------------------

  routes.get("/threads", async (ctx) => {
    const query = parseOr422(threadListQuerySchema, ctx.req.query());
    const limitRaw = query.limit !== undefined ? Number(query.limit) : undefined;
    const offsetRaw = query.offset !== undefined ? Number(query.offset) : undefined;
    if (limitRaw !== undefined && limitRaw <= 0) {
      throw new ApiError({
        status: 400,
        code: "invalid_request",
        message: "limit must be positive",
      });
    }
    if (offsetRaw !== undefined && offsetRaw < 0) {
      throw new ApiError({
        status: 400,
        code: "invalid_request",
        message: "offset must be non-negative",
      });
    }
    if (query.projectId !== undefined) {
      const project = await getProject(ctx.env, query.projectId);
      if (project?.deletedAt !== null) {
        throw new ApiError({
          status: 404,
          code: "project_not_found",
          message: "Project not found",
        });
      }
    }
    if (query.sectionId !== undefined && query.unsectioned === "true") {
      throw new ApiError({
        status: 400,
        code: "invalid_request",
        message: "sectionId and unsectioned cannot be used together",
      });
    }
    if (
      query.sectionId !== undefined &&
      (await getThreadSection(ctx.env, query.sectionId)) === null
    ) {
      throw new ApiError({ status: 404, code: "section_not_found", message: "Section not found" });
    }
    const rows = await listThreads(ctx.env, {
      ...(query.projectId !== undefined ? { projectId: query.projectId } : {}),
      ...(query.parentThreadId !== undefined ? { parentThreadId: query.parentThreadId } : {}),
      ...(query.sourceThreadId !== undefined ? { sourceThreadId: query.sourceThreadId } : {}),
      ...(query.sectionId !== undefined ? { sectionId: query.sectionId } : {}),
      ...(query.unsectioned === "true" ? { unsectioned: true } : {}),
      ...(query.archived !== undefined ? { archived: query.archived === "true" } : {}),
      ...(query.hasParent !== undefined ? { hasParent: query.hasParent === "true" } : {}),
      ...(query.originKind !== undefined ? { originKind: query.originKind } : {}),
      ...(query.originPluginId !== undefined ? { originPluginId: query.originPluginId } : {}),
      ...(query.includeHidden === "true" ? { includeHidden: true } : {}),
      ...(limitRaw !== undefined ? { limit: limitRaw } : {}),
      ...(offsetRaw !== undefined ? { offset: offsetRaw } : {}),
    });
    // bb threadListResponseSchema: bare array. #291: the list resolves the
    // §9.3 row-4 suspension face once per distinct bound host.
    return ctx.json(await toThreadListEntries(ctx.env, rows));
  });

  // --- search ---------------------------------------------------------------------

  /**
   * bb routes/threads/base.ts:257-275 registers the literal /threads/search
   * route in an explicit table, so it cannot be captured by the /threads/:id
   * param route. Hono resolves in registration order (param-first registration
   * answers GET /threads/search with thread_not_found — the B4 staging
   * symptom), so the literal must register BEFORE the :id route below.
   */
  routes.get("/threads/search", async (ctx) => {
    const query = parseOr422(threadSearchQuerySchema, ctx.req.query());
    const searchQuery = query.query.trim();
    if (countNonWhitespaceChars(searchQuery) < 2) {
      throw new ApiError({
        status: 400,
        code: "invalid_request",
        message: "query must contain at least two non-whitespace characters",
      });
    }
    // bb parseSearchLimitPerGroup (base.ts:141-164): default 20, positive,
    // capped at 50.
    const limitRaw = query.limitPerGroup === undefined ? undefined : Number(query.limitPerGroup);
    if (limitRaw !== undefined && limitRaw <= 0) {
      throw new ApiError({
        status: 400,
        code: "invalid_request",
        message: "limitPerGroup must be positive",
      });
    }
    if (limitRaw !== undefined && limitRaw > THREAD_SEARCH_LIMIT_PER_GROUP_MAX) {
      throw new ApiError({
        status: 400,
        code: "invalid_request",
        message: `limitPerGroup must be at most ${THREAD_SEARCH_LIMIT_PER_GROUP_MAX}`,
      });
    }
    const limitPerGroup = limitRaw ?? THREAD_SEARCH_LIMIT_PER_GROUP_DEFAULT;
    // bb searchThreadsWithPendingInteractionState splits the visible,
    // non-deleted set into an archived and an active group (data/threads.ts:
    // 1113-1132); the title-level M0 scan serves both from one listing.
    const rows = await listThreads(ctx.env, {});
    const response = buildTitleSearchResponse({ rows, query: searchQuery, limitPerGroup });
    // The two groups are disjoint (archived split), so one face pass each.
    const [activeEntries, archivedEntries] = await Promise.all([
      toThreadListEntries(
        ctx.env,
        response.active.results.map((result) => result.thread),
      ),
      toThreadListEntries(
        ctx.env,
        response.archived.results.map((result) => result.thread),
      ),
    ]);
    const entryById = new Map(
      [...activeEntries, ...archivedEntries].map((entry) => [entry.id, entry]),
    );
    return ctx.json(
      threadSearchResponseSchema.parse({
        active: {
          total: response.active.total,
          results: response.active.results.map((result) => ({
            thread: entryById.get(result.thread.id) ?? result.thread,
            matches: result.matches,
          })),
        },
        archived: {
          total: response.archived.total,
          results: response.archived.results.map((result) => ({
            thread: entryById.get(result.thread.id) ?? result.thread,
            matches: result.matches,
          })),
        },
      }),
    );
  });

  // --- create -------------------------------------------------------------------

  routes.post("/threads", async (ctx) => {
    const payload = await requireJsonBody(ctx, createThreadRequestSchema);
    const project = await getProject(ctx.env, payload.projectId);
    if (project?.deletedAt !== null) {
      throw new ApiError({ status: 404, code: "project_not_found", message: "Project not found" });
    }
    if (payload.sectionId !== null && payload.sectionId !== undefined) {
      if ((await getThreadSection(ctx.env, payload.sectionId)) === null) {
        throw new ApiError({
          status: 404,
          code: "section_not_found",
          message: "Section not found",
        });
      }
    }
    let parentThreadId: string | null = null;
    let sourceThreadId: string | null = null;
    if (payload.parentThreadId !== undefined) {
      const parent = await getThreadRow(ctx.env, payload.parentThreadId);
      if (parent?.deletedAt !== null) {
        throw new ApiError({ status: 404, code: "thread_not_found", message: "Thread not found" });
      }
      if (payload.originKind === null) {
        parentThreadId = parent.id;
      } else {
        sourceThreadId = parent.id;
      }
    }
    // #317 gate unlock: relative localImage/localFile paths are server-managed
    // attachment references — verify containment + presence in the sending
    // project's family before any write lands (a 4xx leaves no orphan row).
    await validatePromptAttachmentReferences(ctx.env.BLOBS, payload.projectId, payload.input);
    // #351: fail-closed selection validation over the catalog directory —
    // unknown provider/model/reasoning 422 with a named error before any
    // write lands (ROADMAP red line: never silently relax). #434 (point 3):
    // no selection fields resolve against the DECLARED defaultProvider —
    // and a deployment that declares none fails the create with the named
    // 422 (provider_default_undeclared) instead of storing an "omp" sentinel.
    // #362/#450: the selection validates against the D1 directory (the sole
    // 正本 — a panel-side provider is selectable the moment it exists; no
    // rows → the fail-closed empty directory).
    const overlay = await loadProviderConfigCatalogOverlay(ctx.env);
    const selection = validateThreadExecutionSelection(
      payload,
      overlay?.providers ?? {},
    );
    const providerId = selection.resolved.providerId;
    // #288: the binding source chain resolves once, here — explicit choice >
    // project default source > deployment single machine — and feeds BOTH
    // halves: the environments row / threads.environment_id (control plane)
    // and thread.created.machineId (trajectory truth).
    const binding = await resolveThreadBinding(ctx.env, {
      projectId: payload.projectId,
      ...(payload.environment !== undefined ? { environment: payload.environment } : {}),
    });
    const threadId = createThreadId();
    const visibility =
      payload.visibility ??
      (parentThreadId !== null
        ? ((await getThreadRow(ctx.env, parentThreadId))?.visibility ?? "visible")
        : "visible");
    const row = await createThreadRecord(ctx.env, {
      id: threadId,
      projectId: payload.projectId,
      environmentId: binding.environmentId,
      providerId,
      modelOverride: payload.model ?? null,
      reasoningLevelOverride: payload.reasoningLevel ?? null,
      title: payload.title ?? null,
      // bb derives the sidebar title fallback from the create input at the
      // create boundary (thread-create.ts:770-775 → title-generation.ts:53-68).
      titleFallback: deriveTitleFallback(payload.input),
      sectionId: payload.sectionId ?? null,
      parentThreadId,
      sourceThreadId,
      originKind: payload.originKind,
      originPluginId: payload.originPluginId ?? null,
      visibility,
    });
    // Event log bootstrap in the per-thread AgentDO (#29 seam).
    await agentDoFor(ctx.env, threadId).createThread({
      threadId,
      title: payload.title ?? "",
      machineId: binding.machineId,
      ...(selection.explicit !== null ? { execution: selection.explicit } : {}),
    });
    // bb createThread broadcasts (packages/db/src/data/threads.ts:337-340).
    await hub(ctx).notifyThread(threadId, ["thread-created"], { projectId: payload.projectId });
    await hub(ctx).notifyProject(payload.projectId, ["threads-changed"]);
    // bb create-with-input rides the first turn on the create call: the SPA
    // composer ships input with POST /threads (ShowcaseHeroCarousel.tsx:367),
    // createProvisioningThread hands args.request.input to
    // requestThreadProvision (thread-create.ts:533-544), which appends the
    // client/turn/requested event and dispatches requestThreadStart with that
    // input once the environment is ready (thread-provisioning.ts:225-248).
    // The M0 face has no provisioning FSM — the environment is always ready —
    // so bb's advance-before-response branch (thread-create.ts:558-562) maps
    // to inline dispatch before the 201 resolves. Empty input is bb's
    // no-input-no-turn guard (thread-provisioning.ts:221-224): programmatic
    // creates (fork/side-chat preloads) start no turn and stay starting.
    let dispatchedRow = row;
    if (payload.input.length > 0) {
      const content = promptContentFromInput(payload.input);
      // bb generates the client turn request id server-side (thread-send.ts:
      // 346-356) — the same shape the send route records for /send turns.
      const clientRequestId = formatClientTurnRequestIdSuffix({
        suffix: Array.from(crypto.getRandomValues(new Uint8Array(10)))
          .map((byte) =>
            CLIENT_TURN_REQUEST_ID_ALPHABET.charAt(byte % CLIENT_TURN_REQUEST_ID_ALPHABET.length),
          )
          .join(""),
      });
      let result;
      try {
        result = await agentDoFor(ctx.env, threadId).sendMessage({
          clientRequestId,
          content,
          mode: "start",
        });
      } catch (error) {
        // #496: same fail-closed refusal surface as the send face.
        throw mapSelectionMissing(error);
      }
      if (!result.duplicated) {
        // Coarse M0 status transition shared with the send route: the daemon
        // lifecycle (#30) owns the real starting→active path; without it the
        // control plane flips active on dispatch so SPA surfaces reflect an
        // open turn. #477: the flip is guarded to `starting` — an instant
        // turn seals (and the DO settles the row idle) inside the dispatch
        // chain, and re-flipping active over that settlement re-arms the
        // stuck-Working face the detail settlement exists to clear.
        const flipped = await updateThreadRecord(ctx.env, threadId, {
          status: "active",
          expectedStatus: "starting",
        });
        dispatchedRow = (await getThreadRow(ctx.env, threadId)) ?? row;
        if (flipped !== null && flipped.row.status === "active") {
          await hub(ctx).notifyThread(threadId, ["status-changed"], {
            projectId: payload.projectId,
          });
          await hub(ctx).notifyThread(threadId, ["events-appended"], {
            eventTypes: [...SEND_EVENT_TYPES],
            projectId: payload.projectId,
          });
          await hub(ctx).notifyProject(payload.projectId, ["threads-changed"]);
        }
      }
    }
    return ctx.json(await toThreadResponseWithSpawnCheck(ctx.env, dispatchedRow), 201);
  });

  // --- get / update / delete ------------------------------------------------------

  routes.get("/threads/:id", async (ctx) => {
    // bb parseThreadIncludes (routes/threads/base.ts:59-68); the query schema
    // 422s unknown params, the include set drives the inline resolution.
    const query = parseOr422(threadGetQuerySchema, ctx.req.query());
    const includes = new Set<"environment" | "host">();
    if (query.include !== undefined) {
      for (const value of query.include.split(",")) {
        includes.add(value as "environment" | "host");
      }
    }
    let row = await requirePublicThread(ctx);
    // #477: this face seeds the SPA's runtime cache (useThreadDetailBootstrap
    // ingests it and useThread yields to the fresh bootstrap), so a stale
    // coarse row here renders the permanent Working... surface: the page's
    // own timeline fetch settles the row moments later (server truth reads
    // idle) while the settlement's status-changed broadcast races the fresh
    // page's WS subscribe — the hub is ephemeral fan-out with no replay, so
    // the correction is lost and nothing refetches. Settle before answering,
    // mirroring the timeline face (#52). Only rows a terminal turn event can
    // move pay the journal read; idle/error rows take the hot path.
    if (row.status === "starting" || row.status === "active" || row.status === "stopping") {
      const { events } = await agentDoFor(ctx.env, row.id).getEvents({
        sinceSeq: 0,
        project: "ux",
      });
      const settlement = await settleThreadTurnStatus(ctx.env, row, events);
      if (settlement !== null) {
        row = settlement.row;
        await hub(ctx).notifyThread(row.id, ["status-changed"], { projectId: row.projectId });
        await hub(ctx).notifyProject(row.projectId, ["threads-changed"]);
      }
    }
    // bb buildThreadResponse (base.ts:86-121): one environment read serves
    // both includes; host rides the binding row's hostId with live status.
    const environment =
      includes.size > 0 && row.environmentId !== null
        ? await getEnvironmentRow(ctx.env, row.environmentId)
        : null;
    const host =
      includes.has("host") && environment !== null
        ? await getHostRow(ctx.env, environment.hostId).then((hostRow) =>
            hostRow !== null && hostRow.destroyedAt === null
              ? toHostRecord(ctx.env, hostRow)
              : null,
          )
        : null;
    const response = (await toThreadResponseWithSpawnCheck(ctx.env, row)) as ThreadResponse & {
      environment?: unknown;
      host?: unknown;
    };
    if (includes.has("environment")) {
      response.environment = environment === null ? null : environmentSchema.parse(environment);
    }
    if (includes.has("host")) {
      response.host = host;
    }
    return ctx.json(response);
  });

  /**
   * bb GET /threads/:id/default-execution-options (public-api.ts:1276-1281,
   * route at routes/threads/data.ts:531-543): the thread composer's
   * stored-selection face (ResolvedThreadExecutionOptions | null). #486:
   * without this face the composer never sees the thread's stored selection —
   * the SPA seeds no model, the picker silently falls to the catalog's
  * isDefault row, and follow-up sends ride no selection
   * (followUpExecutionSelection gates on this face) so turns dispatch the
   * deployment default: the exact display+dispatch drift the ticket reports.
   * Resolution is the stored row through resolveThreadDefaultExecutionOptions
  * — the same merged catalog a send validates against. #500: the display's
  * permission posture is the D1 `permission_mode` seat (hot, no redeploy).
   */
  routes.get("/threads/:id/default-execution-options", async (ctx) => {
    const row = await requirePublicThread(ctx);
    const overlay = await loadProviderConfigCatalogOverlay(ctx.env);
    const permissionMode = (await getPermissionMode(ctx.env)).mode;
    return ctx.json(
      resolvedThreadExecutionOptionsSchema.nullable().parse(
        resolveThreadDefaultExecutionOptions(permissionMode, row, overlay?.providers ?? {}),
      ),
    );
  });

  routes.patch("/threads/:id", async (ctx) => {
    const payload = await requireJsonBody(ctx, updateThreadRequestSchema);
    const row = await requirePublicThread(ctx);
    if (payload.sectionId !== undefined && payload.sectionId !== null) {
      if ((await getThreadSection(ctx.env, payload.sectionId)) === null) {
        throw new ApiError({
          status: 404,
          code: "section_not_found",
          message: "Section not found",
        });
      }
    }
    // #499: model/reasoningLevel are a stored execution-override rewrite (the
    // fallback card's explicit "use this model" action). Validate the exact
    // pair that will be stored against the directory BEFORE anything writes —
    // the same resolveStoredThreadExecution gate the read face runs — so a
    // dead model fails closed with the named 422 and the thread truth never
    // drifts onto a row the next GET would reject.
    const executionPatch =
      payload.model !== undefined || payload.reasoningLevel !== undefined
        ? resolveThreadExecutionOverridePatch(
            row,
            {
              ...(payload.model !== undefined ? { model: payload.model } : {}),
              ...(payload.reasoningLevel !== undefined
                ? { reasoningLevel: payload.reasoningLevel }
                : {}),
            },
            (await loadProviderConfigCatalogOverlay(ctx.env))?.providers ?? {},
          )
        : null;
    const updated = await updateThreadRecord(ctx.env, row.id, {
      ...(payload.title !== undefined ? { title: payload.title } : {}),
      ...(payload.sectionId !== undefined ? { sectionId: payload.sectionId } : {}),
      ...(payload.parentThreadId !== undefined ? { parentThreadId: payload.parentThreadId } : {}),
      ...(payload.visibility !== undefined ? { visibility: payload.visibility } : {}),
      // Persist the RESOLVED pair — a model-only patch may reconcile a
      // stranded stored rung (see resolveThreadExecutionOverridePatch) — and
      // leave values already stored alone.
      ...(executionPatch !== null && executionPatch.modelOverride !== row.modelOverride
        ? { modelOverride: executionPatch.modelOverride }
        : {}),
      ...(executionPatch !== null &&
      executionPatch.reasoningLevelOverride !== row.reasoningLevelOverride
        ? { reasoningLevelOverride: executionPatch.reasoningLevelOverride }
        : {}),
    });
    if (!updated) {
      throw new ApiError({ status: 404, code: "thread_not_found", message: "Thread not found" });
    }
    if (updated.changedKinds.length > 0) {
      await hub(ctx).notifyThread(row.id, updated.changedKinds, {
        projectId: updated.row.projectId,
      });
    }
    return ctx.json(await toThreadResponseWithSpawnCheck(ctx.env, updated.row));
  });

  // --- rebind (#288) ----------------------------------------------------------------

  /**
   * bb's thread rebind is DB-level (two-source map §1.3: 换 environment =
   * DB 换绑 + 新环境重新 provision, in-flight turn included); the M0 face is
   * the explicit owner operation: resolve the new binding (same chain as
   * create, explicit vocabulary only), update threads.environment_id, and
   * land the trajectory half — thread.rebound migrates state.machineId on
   * replay, so every later dispatch resolves the new machine with zero
   * per-dispatch lookups (§2.1). No mid-turn guard, matching bb.
   *
   * #445 disposition: this is an INTERNAL control-plane face, not a product
   * feature — it has no bb upstream route, no feature proposal, and no SPA
   * UX. It exists for the owner/测试动线 (binding surgery, rig tests); it is
   * NOT a recovery path to advertise (the SPA never calls it). Promoting it
   * to a product capability requires a feature ticket with its own UX.
   */
  routes.post("/threads/:id/environment", async (ctx) => {
    const payload = await requireJsonBody(ctx, rebindThreadEnvironmentRequestSchema);
    const row = await requirePublicThread(ctx);
    const resolved = await resolveThreadBinding(ctx.env, {
      projectId: row.projectId,
      environment: payload.environment,
    });
    const updated = await updateThreadRecord(ctx.env, row.id, {
      environmentId: resolved.environmentId,
    });
    if (updated === null) {
      throw new ApiError({ status: 404, code: "thread_not_found", message: "Thread not found" });
    }
    await agentDoFor(ctx.env, row.id).rebindThread({
      machineId: resolved.machineId,
      ...(resolved.environmentId !== null ? { environmentId: resolved.environmentId } : {}),
    });
    await hub(ctx).notifyThread(row.id, ["environment-changed"], { projectId: row.projectId });
    return ctx.json(await toThreadResponseWithSpawnCheck(ctx.env, updated.row));
  });

  routes.delete("/threads/:id", async (ctx) => {
    const payload = await requireJsonBody(ctx, deleteThreadRequestSchema);
    const row = await requirePublicThread(ctx);
    const childCount = await countNonDeletedAssignedChildThreads(ctx.env, row.id);
    if (childCount > 0 && !payload.childThreadsConfirmed) {
      throw new ApiError({
        status: 409,
        code: "invalid_request",
        message: "childThreadsConfirmed is required when the thread has child threads",
        details: { childThreadCount: childCount },
      });
    }
    await markThreadDeleted(ctx.env, row.id);
    // bb markThreadDeleted broadcasts (packages/db/src/data/threads.ts:1800-1803).
    await hub(ctx).notifyThread(row.id, ["thread-deleted"]);
    await hub(ctx).notifyProject(row.projectId, ["threads-changed"]);
    return ctx.json({ ok: true });
  });

  // --- send / stop -----------------------------------------------------------------

  routes.post("/threads/:id/send", async (ctx) => {
    const payload = await requireJsonBody(ctx, sendMessageRequestSchema);
    let row = await requirePublicThread(ctx);
    // #317 gate unlock: the same attachment-reference verification the create
    // face runs — relative paths must be uploaded into this thread's project
    // family; absolute/URI-like paths pass through to the runtime untouched.
    await validatePromptAttachmentReferences(ctx.env.BLOBS, row.projectId, payload.input);
    const mode = resolveSendMode(row.status, payload.mode);
    // #351: a send carrying model/reasoningLevel is a selection change —
    // validate fail-closed against the catalog (422 named errors), classify
    // the drift (bb unchanged/live/session), and on `live` persist the
    // overrides AND ride the resolved explicit selection on the dispatch so
    // the turn (and any replay) pins the new row.
    let executionRide: RelaySelection | undefined;
    if (payload.model !== undefined || payload.reasoningLevel !== undefined) {
      const overlay = await loadProviderConfigCatalogOverlay(ctx.env);
      // #496: a reasoning-only change validates against the thread's STORED
      // model (the row override), never a deployment default — the channel
      // names no default model anymore; a row without an override still
      // 422s with the named remedy.
      const next = validateThreadExecutionSelection(
        {
          providerId: row.providerId,
          ...(payload.model !== undefined ? { model: payload.model } : {}),
          ...(payload.model === undefined && row.modelOverride !== null
            ? { model: row.modelOverride }
            : {}),
          ...(payload.reasoningLevel !== undefined
            ? { reasoningLevel: payload.reasoningLevel }
            : {}),
        },
        overlay?.providers ?? {},
      );
      // validateThreadExecutionSelection never returns null anymore (#434):
      // the payload always carries providerId here, so `explicit` is set.
      const current = resolveStoredThreadExecution(row, overlay?.providers ?? {});
      if (classifyThreadSelectionChange(current, next.resolved) === "live" && next.explicit) {
        const updated = await updateThreadRecord(ctx.env, row.id, {
          ...(payload.model !== undefined ? { modelOverride: payload.model } : {}),
          ...(payload.reasoningLevel !== undefined
            ? { reasoningLevelOverride: payload.reasoningLevel }
            : {}),
        });
        // #477: the dispatch flip's stamp guard pins THIS write's version, so
        // the observed row must carry it.
        if (updated !== null) {
          row = updated.row;
        }
        executionRide = next.explicit;
      }
    }
    // #499 dispatch-source unification: a send WITHOUT a live explicit change
    // — a model-less follow-up, or a re-send equal to the stored selection —
    // pins the thread's STORED selection, resolved through the SAME gate the
    // composer read face and the PATCH rewrite run. The turn never rides the
    // previous turn's journal pin: display and dispatch read one source by
    // construction. The ride journals `thread.execution_updated` only when
    // the stored truth moved (timeline-provable, no churn on equal sends),
    // and a stored row the directory dropped fails closed with the named 422
    // instead of dispatching stale history (the #510 acceptance defect: after
    // the fallback card's PATCH, a model-less follow-up still rode the
    // create-time pin).
    if (executionRide === undefined) {
      const overlay = await loadProviderConfigCatalogOverlay(ctx.env);
      const stored = resolveStoredThreadExecution(row, overlay?.providers ?? {});
      executionRide = {
        providerId: stored.providerId,
        model: stored.model,
        reasoningLevel: stored.reasoningLevel,
      };
    }
    // bb generates the client turn request id server-side when appending the
    // client/turn/requested event (thread-send.ts:346-356); the HTTP schema
    // has no clientRequestId field.
    const clientRequestId = formatClientTurnRequestIdSuffix({
      suffix: Array.from(crypto.getRandomValues(new Uint8Array(10)))
        .map((byte) =>
          CLIENT_TURN_REQUEST_ID_ALPHABET.charAt(byte % CLIENT_TURN_REQUEST_ID_ALPHABET.length),
        )
        .join(""),
    });
    const content = promptContentFromInput(payload.input);
    let result;
    try {
      result = await agentDoFor(ctx.env, row.id).sendMessage({
        clientRequestId,
        content,
        mode,
        // #499: both paths above leave a ride set — the send always pins the
        // thread's stored selection (or the live explicit change that just
        // rewrote it), never an empty selection.
        execution: executionRide,
      });
    } catch (error) {
      // #496: the DO refuses a send that would dispatch no selection (no
      // journaled pin — no legacy materialization exists either) — the RPC
      // boundary drops the error class, so the named marker maps to the
      // create-face 422 shape. Unreachable while #499's ride construction
      // holds; the backstop keeps the refusal named rather than a 500.
      throw mapSelectionMissing(error);
    }
    if (!result.duplicated) {
      // Coarse M0 status transition: the daemon lifecycle (#30) owns the real
      // starting→active path; without it the control plane flips active on
      // send so SPA surfaces reflect an open turn.
      // #477: the flip pins the pre-dispatch row stamp — a turn that seals
      // inside the dispatch chain settles the row idle (stamping a new
      // version), and re-flipping active over that settlement re-arms the
      // stuck-Working face.
      if (row.status !== "active") {
        const flipped = await updateThreadRecord(ctx.env, row.id, {
          status: "active",
          expectedUpdatedAt: row.updatedAt,
        });
        if (flipped !== null && flipped.row.status === "active") {
          await hub(ctx).notifyThread(row.id, ["status-changed"], { projectId: row.projectId });
        }
      }
      await hub(ctx).notifyThread(row.id, ["events-appended"], {
        eventTypes: [...SEND_EVENT_TYPES],
        projectId: row.projectId,
      });
      await hub(ctx).notifyProject(row.projectId, ["threads-changed"]);
    }
    return ctx.json({ ok: true });
  });

  routes.post("/threads/:id/stop", async (ctx) => {
    // bb stopThreadForCurrentState (thread-lifecycle.ts:1470-1522): an idle
    // thread's stop is a release no-op; an in-flight turn must actually
    // cancel. The turn-cancel face is journal state on the per-thread agent
    // DO (T19: turn.cancel_requested → abort driver → kill non-terminal
    // executions, including the ask-pending interrupt whose watchdog the DO
    // deliberately suspends — "the user is the deadline"), so derive the
    // active turn from the raw journal and cancel on the DO directly, the
    // same direct-read pattern every journal consumer above uses. See
    // agentDoCancelTurn for why the orchestrator's thread/stop is not used.
    const row = await requirePublicThread(ctx);
    const { events } = await agentDoFor(ctx.env, row.id).getEvents({
      sinceSeq: 0,
      project: "raw",
    });
    const turnId = activeTurnIdFromEvents(events);
    if (turnId !== null) {
      await agentDoCancelTurn(ctx.env, row.id, turnId);
    }
    return ctx.json({ ok: true });
  });

  // --- compact (#309, bb /threads/:id/compact wire: noRequest → {ok:true}) ----------

  routes.post("/threads/:id/compact", async (ctx) => {
    // bb compactThreadContext (routes/threads/actions.ts:131-161) gates the
    // manual compact on a writable/idle thread; the turn-cancel face is
    // journal state on the per-thread agent DO (the stop route's direct-read
    // pattern), so derive activeness from the raw journal and reject before
    // the DO RPC. The compact turn itself (summarization call + the
    // `thread/compacted` checkpoint row) appends on the DO; the boundary is a
    // replay-derived journal cut, never a deletion (#116).
    const row = await requirePublicThread(ctx);
    const { events } = await agentDoFor(ctx.env, row.id).getEvents({
      sinceSeq: 0,
      project: "raw",
    });
    if (activeTurnIdFromEvents(events) !== null) {
      throw new ApiError({
        status: 409,
        code: "thread_not_writable",
        message: "Thread has an active turn; stop it before compacting",
        details: { reason: "already_active" },
      });
    }
    try {
      await agentDoCompactThread(ctx.env, row.id);
    } catch (error) {
      // The RPC seam rethrows remote errors without their class; the DO's
      // retention-budget gate (pi prepareCompaction kept-still-fits →
      // undefined) is a user-facing refusal, not a server fault — bb maps its
      // compact gates to 409 invalid_request the same way.
      if (error instanceof Error && error.message.includes("nothing to compact")) {
        throw new ApiError({
          status: 409,
          code: "thread_not_writable",
          message: error.message,
          details: { reason: "nothing_to_compact" },
        });
      }
      throw error;
    }
    await hub(ctx).notifyThread(row.id, ["events-appended"], {
      projectId: row.projectId,
    });
    return ctx.json({ ok: true });
  });

  // --- timeline / outline / events ---------------------------------------------------

  routes.get("/threads/:id/timeline", async (ctx) => {
    const query = parseOr422(threadTimelineQuerySchema, ctx.req.query());
    let row = await requirePublicThread(ctx);
    // bb data.ts:331-334 — the Debug settings toggle turns on the
    // provider-unhandled diagnostic rows (bb dev builds force them on; the
    // packaged staging Worker has no dev term, so the flag alone decides).
    // Read per-request, so unlike bb's server-start constant the latest-rows
    // delta cache below MUST key on it (bb data.ts:334-337).
    const includeUnhandledProviderEvents = toAppSettings(
      await getAppSettingsRow(ctx.env),
    ).showUnhandledProviderEvents;
    let segmentLimit = THREAD_TIMELINE_DEFAULT_SEGMENT_LIMIT;
    if (query.segmentLimit !== undefined) {
      const parsed = Number(query.segmentLimit);
      if (!Number.isInteger(parsed) || parsed <= 0 || parsed > THREAD_TIMELINE_SEGMENT_LIMIT_MAX) {
        throw new ApiError({
          status: 400,
          code: "invalid_request",
          message: "segmentLimit out of range",
        });
      }
      segmentLimit = parsed;
    }
    const { events, latestSeq } = await agentDoFor(ctx.env, row.id).getEvents({
      sinceSeq: 0,
      project: "ux",
    });
    // Terminal turn events settle the coarse M0 execution status (#52):
    // the send route flips `active` on dispatch; without consuming the
    // agent DO's turn/completed the row never leaves active and the SPA
    // derives a permanent busy state (census #45 P0-3).
    const settlement = await settleThreadTurnStatus(ctx.env, row, events);
    if (settlement !== null) {
      row = settlement.row;
      await hub(ctx).notifyThread(row.id, ["status-changed"], { projectId: row.projectId });
      await hub(ctx).notifyProject(row.projectId, ["threads-changed"]);
    }
    let allRows = projectTimelineRows(events);
    if (includeUnhandledProviderEvents) {
      const { events: rawEvents } = await agentDoFor(ctx.env, row.id).getEvents({
        sinceSeq: 0,
        project: "raw",
      });
      allRows = mergeTimelineRows(allRows, projectUnhandledProviderRows(events, rawEvents));
    }
    const kind = query.beforeAnchorSeq !== undefined ? "older" : "latest";
    if (query.beforeAnchorSeq !== undefined) {
      const anchorId = query.beforeAnchorId;
      const anchorExists = allRows.some(
        (candidate) =>
          candidate.id === anchorId && candidate.sourceSeqStart === Number(query.beforeAnchorSeq),
      );
      if (!anchorExists) {
        throw new ApiError({
          status: 400,
          code: "invalid_request",
          message: "Unknown timeline anchor",
        });
      }
    }
    const includeNestedRows = query.includeNestedRows !== "false";
    const summaryOnly = query.summaryOnly === "true";
    const pageKind: "latest" | "older" = query.beforeAnchorSeq !== undefined ? "older" : "latest";
    const pageQuery = {
      kind: pageKind,
      segmentLimit,
      ...(query.beforeAnchorSeq !== undefined && query.beforeAnchorId !== undefined
        ? {
            beforeAnchor: {
              anchorSeq: Number(query.beforeAnchorSeq),
              anchorId: query.beforeAnchorId,
            },
          }
        : {}),
      summaryOnly,
    };
    const page = buildTimelinePage(allRows, pageQuery);
    // bb tail-only state gates on the LATEST page (thread-timeline.ts:2073);
    // activeThinking additionally gates on thread status === active (bb
    // thread-view buildProjectionActiveThinking, #257 CoT surface).
    const activeThinking = buildActiveThinking(events, row.status);
    const paramsKey = `${row.id}|${row.status}|${kind}|${segmentLimit}|${String(includeNestedRows)}|${String(summaryOnly)}|${String(includeUnhandledProviderEvents)}`;
    let delta;
    if (query.afterSequence !== undefined && kind === "latest") {
      const cached = timelineLatestRowsCache.get(paramsKey);
      if (cached?.maxSeq === Number(query.afterSequence)) {
        delta = computeTimelineRowDelta(cached.rows, page.rows);
      }
    }
    if (kind === "latest" && !summaryOnly) {
      timelineLatestRowsCache.put(paramsKey, { maxSeq: latestSeq, rows: page.rows });
    }
    // #308: context-window fill is latest-row-wins tail state; omitted when
    // the thread has no usage row (the SPA renders no indicator then).
    const contextWindowUsage = buildContextWindowUsage(events);
    return ctx.json({
      rows: summaryOnly ? [] : page.rows,
      activePromptMode: null,
      activeThinking,
      activeWorkflows: [],
      activeBackgroundCommands: [],
      pendingTodos: null,
      goal: null,
      modelFallback: null,
      ...(contextWindowUsage !== null ? { contextWindowUsage } : {}),
      timelinePage: page.page,
      maxSeq: latestSeq,
      ...(delta !== undefined ? { delta } : {}),
    });
  });

  routes.get("/threads/:id/conversation-outline", async (ctx) => {
    const row = await requirePublicThread(ctx);
    const { events, latestSeq } = await agentDoFor(ctx.env, row.id).getEvents({
      sinceSeq: 0,
      project: "ux",
    });
    return ctx.json({
      items: buildConversationOutline(projectTimelineRows(events)),
      maxSeq: latestSeq,
    });
  });

  /**
   * B1 (#321) — bb GET /threads/:id/host-files/content (routes/threads/
   * data.ts:660-682): the files face's minimal subset, content read only
   * (packages/protocol README §1 defers the rest of the family). Agent-
   * produced images live on the host disk; the SPA's ImageViewWorkRowBody
   * lightbox fetches their bytes here (file-content-urls.ts
   * buildThreadHostFileContentUrl). bb demands an attached environment (409
   * thread_environment_unavailable otherwise); this stack's deployment-host
   * posture (#318 pickup §2.1) resolves the bound environment's host, else
   * the cloud placeholder (#377) — a placeholder-bound thread has no machine
   * to read from and the RPC answers the honest host_offline.
   */
  routes.get("/threads/:id/host-files/content", async (ctx) => {
    const query = parseOr422(threadHostFileContentQuerySchema, ctx.req.query());
    const row = await requirePublicThread(ctx);
    let hostId = CLOUD_PLACEHOLDER_HOST_ID;
    if (row.environmentId !== null) {
      const environment = await getEnvironmentRow(ctx.env, row.environmentId);
      if (environment === null) {
        throw new ApiError({
          status: 404,
          code: "environment_not_found",
          message: "Thread environment not found",
        });
      }
      hostId = environment.hostId;
    }
    const command: HostRpcCommand = { type: "host.read_file", path: query.path };
    const stub = daemonServiceStubOrNull(ctx.env, hostId);
    if (stub === null) {
      throw hostFileHostUnavailable();
    }
    try {
      const outcome = await stub.hostOnlineRpc({
        hostId,
        command,
        timeoutMs: HOST_COMMAND_TIMEOUT_MS,
      });
      switch (outcome.kind) {
        case "host_offline":
          throw hostFileHostUnavailable();
        case "timeout":
          // bb online-rpc.ts:154-156 (hosts.ts directory-face twin).
          throw new ApiError({
            status: 504,
            code: "command_timeout",
            message: "Timed out waiting for command result",
          });
        case "ok": {
          const response = outcome.response;
          if (!response.ok) {
            // bb online-rpc.ts:98-99: a daemon dispatch failure rides its
            // own code (ENOENT, invalid_path, file_too_large) — remapped to
            // the route statuses by the catch below.
            throw new ApiError({
              status: 502,
              code: response.errorCode,
              message: response.errorMessage,
              retryable: false,
            });
          }
          if (response.commandType !== command.type) {
            // bb online-rpc.ts:102-108.
            throw new ApiError({
              status: 500,
              code: "command_result_type_mismatch",
              message: `Host RPC ${response.requestId} completed with unexpected type ${response.commandType}`,
            });
          }
          const parsed = hostFileReadResultSchema.safeParse(response.result);
          if (!parsed.success) {
            throw new ApiError({
              status: 500,
              code: "command_result_invalid",
              message: `Host RPC ${response.requestId} returned a malformed file read`,
              details: { issues: parsed.error.issues },
            });
          }
          return buildHostFileContentResponse(parsed.data);
        }
      }
    } catch (error) {
      // bb remapDaemonFileRouteError (data.ts:679-681): the daemon's own
      // dispatch codes land on the route contract's statuses.
      return remapHostFileRouteError(error);
    }
  });

  /**
   * bb GET /threads/:id/child-summary (routes/threads/base.ts:327-339): the
   * delete-confirm flow fetches this before opening the dialog
   * (apps/app/src/components/thread/ThreadActionsProvider.tsx:208-237) — a 404
   * makes requestDelete resolve null and the confirm never opens (#123).
   * Response shape is contract threadChildSummaryResponseSchema, mirroring bb
   * server-contract threadChildSummaryResponseSchema
   * (server-contract/src/api/threads.ts:495-500).
   */
  routes.get("/threads/:id/child-summary", async (ctx) => {
    const row = await requirePublicThread(ctx);
    const nonDeletedChildCount = await countNonDeletedAssignedChildThreads(ctx.env, row.id);
    return ctx.json({ nonDeletedChildCount });
  });

  routes.get("/threads/:id/events", async (ctx) => {
    const query = parseOr422(threadEventsQuerySchema, ctx.req.query());
    const row = await requirePublicThread(ctx);
    const afterSeq = query.afterSeq !== undefined ? Number(query.afterSeq) : 0;
    const limit = query.limit !== undefined ? Number(query.limit) : 100;
    const { events } = await agentDoFor(ctx.env, row.id).getEvents({
      sinceSeq: afterSeq,
      limit,
      project: "ux",
    });
    const rows: PortedThreadEventRow[] = events.map((event) => ({
      id: event.id,
      scope: "thread",
      threadId: event.threadId,
      seq: event.seq,
      type: event.type,
      data: event.data,
      createdAt: event.createdAt,
    }));
    return ctx.json(rows);
  });

  routes.get("/threads/:id/events/wait", async (ctx) => {
    const query = ctx.req.query();
    const type = query.type;
    if (type === undefined || type.length === 0) {
      throw new ApiError({ status: 400, code: "invalid_request", message: "type is required" });
    }
    const row = await requirePublicThread(ctx);
    const afterSeq = query.afterSeq !== undefined ? Number(query.afterSeq) : 0;
    const waitMs = Math.min(query.waitMs !== undefined ? Number(query.waitMs) : 30_000, 60_000);
    const deadline = Date.now() + waitMs;
    for (;;) {
      const { events } = await agentDoFor(ctx.env, row.id).getEvents({
        sinceSeq: afterSeq,
        // Scan the window since the cursor: the target type may sit many
        // rows deep (limit:1 only ever saw the log head).
        limit: 100,
        project: "ux",
      });
      const match = events.find((event) => event.type === type);
      if (match) {
        const row: PortedThreadEventRow = {
          id: match.id,
          scope: "thread",
          threadId: match.threadId,
          seq: match.seq,
          type: match.type,
          data: match.data,
          createdAt: match.createdAt,
        };
        return ctx.json(row);
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        return ctx.body(null, 204);
      }
      // Since #197 D2 the agent DO pings the hub per journal row (delta /
      // phase-changed / events-appended notifies all resolveThreadWaiters),
      // so a notify wakes this wait directly; the bounded slice remains only
      // as the idle safety net (spec §7).
      await hub(ctx).waitThreadEvent({ threadId: row.id, waitMs: Math.min(remaining, 500) });
    }
  });

  // --- state transitions -------------------------------------------------------------

  routes.post("/threads/:id/archive", async (ctx) => {
    const row = await requirePublicThread(ctx);
    const updated = await setThreadArchived(ctx.env, row.id, true);
    if (!updated) {
      throw new ApiError({ status: 404, code: "thread_not_found", message: "Thread not found" });
    }
    if (updated.archivedAt !== row.archivedAt) {
      await hub(ctx).notifyThread(row.id, ["archived-changed"]);
    }
    return ctx.json({ ok: true });
  });

  /**
   * bb POST /threads/:id/archive-all (routes/threads/actions.ts:706-715): the
   * SPA Archive menu hits this cascade route — the sdk `archive` itself routes
   * here to "Match the UI" (packages/sdk/src/areas/threads.ts:894-910) — so a
   * port exposing only /archive 404s the menu (#122). Cascade per bb
   * archiveThreadAndChildren (services/threads/thread-archive.ts:140-190):
   * unarchived assigned children + unarchived hidden source forks, parent last
   * and only while still live; every cascaded id lands in the response.
   * bb's per-environment cleanup sweep is family OUT in the Worker port, so
   * each target transitions via setThreadArchived like /archive.
   */
  routes.post("/threads/:id/archive-all", async (ctx) => {
    const row = await requirePublicThread(ctx);
    const childThreads = await listThreads(ctx.env, {
      parentThreadId: row.id,
      archived: false,
      includeHidden: true,
    });
    const hiddenSourceThreads = await listThreads(ctx.env, {
      sourceThreadId: row.id,
      archived: false,
      visibility: "hidden",
    });
    const targets: ThreadDbRow[] = [...childThreads, ...hiddenSourceThreads].filter(
      (thread) => thread.id !== row.id,
    );
    if (row.archivedAt === null) {
      targets.push(row);
    }
    const archivedThreadIds: string[] = [];
    for (const target of targets) {
      const updated = await setThreadArchived(ctx.env, target.id, true);
      if (updated === null || updated.archivedAt === target.archivedAt) {
        continue;
      }
      archivedThreadIds.push(target.id);
      await hub(ctx).notifyThread(target.id, ["archived-changed"]);
    }
    return ctx.json({ ok: true, archivedThreadIds });
  });

  routes.post("/threads/:id/unarchive", async (ctx) => {
    const row = await requirePublicThread(ctx);
    const updated = await setThreadArchived(ctx.env, row.id, false);
    if (!updated) {
      throw new ApiError({ status: 404, code: "thread_not_found", message: "Thread not found" });
    }
    if (updated.archivedAt !== row.archivedAt) {
      await hub(ctx).notifyThread(row.id, ["archived-changed"]);
    }
    return ctx.json({ ok: true });
  });

  routes.post("/threads/:id/pin", async (ctx) => {
    const row = await requirePublicThread(ctx);
    const updated = await pinThread(ctx.env, row.id, null);
    if (!updated) {
      throw new ApiError({ status: 404, code: "thread_not_found", message: "Thread not found" });
    }
    if (updated.pinnedAt !== row.pinnedAt) {
      await hub(ctx).notifyThread(row.id, ["pin-state-changed"], { projectId: row.projectId });
    }
    return ctx.json(await toThreadResponseWithSpawnCheck(ctx.env, updated));
  });

  routes.post("/threads/:id/unpin", async (ctx) => {
    const row = await requirePublicThread(ctx);
    const updated = await unpinThread(ctx.env, row.id);
    if (!updated) {
      throw new ApiError({ status: 404, code: "thread_not_found", message: "Thread not found" });
    }
    if (updated.pinnedAt !== row.pinnedAt) {
      await hub(ctx).notifyThread(row.id, ["pin-state-changed"], { projectId: row.projectId });
    }
    return ctx.json(await toThreadResponseWithSpawnCheck(ctx.env, updated));
  });

  routes.post("/threads/:id/read", async (ctx) => {
    const row = await requirePublicThread(ctx);
    const updated = await updateThreadRecord(ctx.env, row.id, { lastReadAt: Date.now() });
    if (!updated) {
      throw new ApiError({ status: 404, code: "thread_not_found", message: "Thread not found" });
    }
    await hub(ctx).notifyThread(row.id, ["read-state-changed"]);
    return ctx.json(await toThreadResponseWithSpawnCheck(ctx.env, updated.row));
  });

  routes.post("/threads/:id/unread", async (ctx) => {
    const row = await requirePublicThread(ctx);
    const updated = await updateThreadRecord(ctx.env, row.id, { lastReadAt: null });
    if (!updated) {
      throw new ApiError({ status: 404, code: "thread_not_found", message: "Thread not found" });
    }
    await hub(ctx).notifyThread(row.id, ["read-state-changed"]);
    return ctx.json(await toThreadResponseWithSpawnCheck(ctx.env, updated.row));
  });

  // --- tabs (bb routes/threads/tabs.ts:34-56) -------------------------------------------

  routes.get("/threads/:id/tabs", async (ctx) => {
    const row = await requirePublicThread(ctx);
    return ctx.json(await getStoredThreadTabs(ctx.env, row.id));
  });

  routes.put("/threads/:id/tabs", async (ctx) => {
    const payload = await requireJsonBody(ctx, updateThreadTabsRequestSchema);
    const row = await requirePublicThread(ctx);
    const result = await replaceStoredThreadTabs(ctx.env, {
      threadId: row.id,
      expectedRevision: payload.expectedRevision,
      tabs: payload.tabs,
    });
    if (result.outcome === "conflict") {
      throw new ApiError({
        status: 409,
        code: "thread_tabs_conflict",
        message: "Thread tabs revision conflict",
        details: { currentRevision: result.revision },
      });
    }
    await hub(ctx).notifyThread(row.id, ["tabs-changed"]);
    return ctx.json(result.stored);
  });

  // --- interactions (bb routes/threads/interactions.ts; source = the agent
  // DO journal fold, #225 — bb's D1 row source is the per-thread journal
  // here, and the mirror only feeds the list-query EXISTS probe) ------------

  routes.get("/threads/:id/interactions", async (ctx) => {
    const row = await requirePublicThread(ctx);
    const { interactions } = await agentDoFor(ctx.env, row.id).listInteractions();
    const pending = toPublicPendingInteractions(interactions);
    for (const interaction of interactions) {
      await mirrorPendingInteraction(ctx.env, interaction);
    }
    return ctx.json(pending);
  });

  routes.get("/threads/:id/interactions/:interactionId", async (ctx) => {
    const row = await requirePublicThread(ctx);
    const interactionId = ctx.req.param("interactionId");
    const { interactions } = await agentDoFor(ctx.env, row.id).listInteractions();
    const found = requirePublicInteractionRow(interactions, row.id, interactionId);
    await mirrorPendingInteraction(ctx.env, found);
    return ctx.json(toPublicPendingInteraction(found));
  });

  routes.post("/threads/:id/interactions/:interactionId/resolve", async (ctx) => {
    const row = await requirePublicThread(ctx);
    const interactionId = ctx.req.param("interactionId");
    const resolution = await requireJsonBody(ctx, resolvePendingInteractionRequestSchema);
    const agent = agentDoFor(ctx.env, row.id);
    const existing = requirePublicInteractionRow(
      (await agent.listInteractions()).interactions,
      row.id,
      interactionId,
    );
    if (existing.status !== "pending") {
      // bb buildResolveConflictError (interactions.ts:184-189).
      throw new ApiError({
        status: 409,
        code: "invalid_request",
        message: `Pending interaction ${interactionId} is already ${existing.status}`,
      });
    }
    try {
      const outcome = await agent.resolveInteraction({ interactionId, resolution });
      if (outcome.duplicated) {
        throw new ApiError({
          status: 409,
          code: "invalid_request",
          message: `Pending interaction ${interactionId} is already resolved`,
        });
      }
    } catch (error) {
      if (error instanceof ApiError) throw error;
      // The DO-side ruling validation is authoritative; the RPC boundary
      // drops the error class, so every remaining failure here is the
      // invalid-ruling face (bb answers validation → 400 invalid_request).
      throw new ApiError({
        status: 400,
        code: "invalid_request",
        message: error instanceof Error ? error.message : "Invalid resolution",
      });
    }
    // Re-fold: the journal append is authoritative for the updated row.
    const updated = requirePublicInteractionRow(
      (await agent.listInteractions()).interactions,
      row.id,
      interactionId,
    );
    await mirrorPendingInteraction(ctx.env, updated);
    return ctx.json(toPublicPendingInteraction(updated));
  });

  // --- prompt history (bb routes/threads/data.ts:462-478) -----------------------------

  routes.get("/threads/:id/prompt-history", async (ctx) => {
    await requirePublicThread(ctx);
    const limit = parseBoundedPositiveOptionalInteger({
      defaultValue: PROMPT_HISTORY_ENTRY_LIMIT,
      max: PROMPT_HISTORY_ENTRY_LIMIT,
      name: "limit",
      value: ctx.req.query("limit"),
    });
    // bb listThreadPromptHistory (services/prompt-history.ts:215-247) merges
    // queued + accepted entries; the port persists neither store yet, so the
    // visibility pass returns the bb empty list — the same legal-empty shape
    // the project-level route serves (routes/projects.ts:181-198).
    return ctx.json(
      promptHistoryResponseSchema.parse(takeVisiblePromptHistoryEntries({ entries: [], limit })),
    );
  });

  app.route("/api/v1", routes);
}

export function resolveSendMode(
  status: string,
  mode: "queue-if-active" | "steer-if-active" | "auto" | "start" | "steer",
): "auto" | "start" | "steer" {
  // bb resolveSendMode (services/threads/thread-send.ts:175-216).
  if (mode === "start") {
    if (status === "active") {
      throw new ApiError({
        status: 409,
        code: "thread_not_writable",
        message: "Thread is already active",
        details: { reason: "already_active" },
      });
    }
    return "start";
  }
  if (mode === "steer" || mode === "steer-if-active") {
    if (status === "active") {
      return "steer";
    }
    if (status === "idle" || status === "error") {
      return "start";
    }
    throw new ApiError({
      status: 409,
      code: "thread_not_writable",
      message: `Thread status ${status} does not accept sends`,
      details: { reason: status },
    });
  }
  if (mode === "queue-if-active") {
    if (status === "active") {
      // Queue family is OUT of the M0 face (ruling #7) — an explicit queue
      // request against an active turn is reported, not silently dropped.
      throw new ApiError({
        status: 409,
        code: "conflict",
        message: "Message queueing is not part of the M0 face",
        details: { reason: "turn-active" },
        retryable: false,
      });
    }
    return "start";
  }
  return status === "active" ? "auto" : "start";
}

/**
 * Contract prompt input → journal prompt content (#317 gate unlock). The
 * request layer's mention/visibility fields are presentation concerns and
 * stay behind; the four union members ride the journal verbatim (the daemon
 * seam re-anchors mentions on its side). Reference validation is the caller's
 * job (validatePromptAttachmentReferences) — this maps, never validates.
 */
function promptContentFromInput(input: readonly PromptInput[]): PromptContent[] {
  return input.map((entry) => {
    switch (entry.type) {
      case "text":
        return { type: "text" as const, text: entry.text };
      case "image":
        return { type: "image" as const, url: entry.url };
      case "localImage":
        return { type: "localImage" as const, path: entry.path };
      case "localFile":
        return {
          type: "localFile" as const,
          path: entry.path,
          ...(entry.name !== undefined ? { name: entry.name } : {}),
          ...(entry.sizeBytes !== undefined ? { sizeBytes: entry.sizeBytes } : {}),
          ...(entry.mimeType !== undefined ? { mimeType: entry.mimeType } : {}),
        };
    }
  });
}

/** bb requirePublicThread (entity-lookup.ts): 404 on missing or deleted. */
async function requirePublicThread(ctx: { env: Env; req: { param(name: string): string } }) {
  const thread = await getThreadRow(ctx.env, ctx.req.param("id"));
  if (thread?.deletedAt !== null) {
    throw new ApiError({ status: 404, code: "thread_not_found", message: "Thread not found" });
  }
  const project = await getProject(ctx.env, thread.projectId);
  if (project?.deletedAt !== null) {
    throw new ApiError({ status: 404, code: "thread_not_found", message: "Thread not found" });
  }
  return thread;
}

function hub(ctx: { env: Env }) {
  const stub = ctx.env.HUB.get(ctx.env.HUB.idFromName("hub"));
  return stub as DurableObjectStub & {
    notifyThread(
      threadId: string,
      changes: string[],
      metadata?: unknown,
    ): Promise<{ delivered: number }>;
    notifyProject(projectId: string, changes: string[]): Promise<{ delivered: number }>;
    notifyHost(hostId: string, changes: string[]): Promise<{ delivered: number }>;
    notifySystem(changes: string[]): Promise<{ delivered: number }>;
    waitThreadEvent(args: { threadId: string; waitMs: number }): Promise<{ resolved: boolean }>;
    broadcastSignal(frame: Record<string, unknown>): Promise<{ delivered: number }>;
  };
}
