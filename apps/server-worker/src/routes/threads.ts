import { Hono } from "hono";
import {
  createThreadRequestSchema,
  deleteThreadRequestSchema,
  sendMessageRequestSchema,
  threadSearchQuerySchema,
  threadSearchResponseSchema,
  threadEventsQuerySchema,
  threadGetQuerySchema,
  threadListQuerySchema,
  threadTimelineQuerySchema,
  updateThreadRequestSchema,
  type ThreadResponse,
} from "../contract/api/threads.js";
import { promptHistoryResponseSchema } from "../contract/api/projects.js";
import {
  PROMPT_HISTORY_ENTRY_LIMIT,
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
import { getStoredThreadTabs, replaceStoredThreadTabs } from "../db/thread-tabs.js";
import { getAppSettingsRow, toAppSettings } from "../db/settings.js";
import { toThreadListEntry, toThreadResponseWithSpawnCheck } from "../services/runtime-display.js";
import {
  THREAD_SEARCH_LIMIT_PER_GROUP_DEFAULT,
  THREAD_SEARCH_LIMIT_PER_GROUP_MAX,
  buildTitleSearchResponse,
  countNonWhitespaceChars,
} from "../services/thread-search.js";
import { deriveTitleFallback } from "../services/title-generation.js";
import { settleThreadTurnStatus } from "../services/thread-run-settlement.js";
import {
  buildConversationOutline,
  buildTimelinePage,
  mergeTimelineRows,
  projectTimelineRows,
  projectUnhandledProviderRows,
  timelineLatestRowsCache,
} from "../services/timeline.js";
import { computeTimelineRowDelta } from "../contract/thread-timeline.js";
import { agentDoFor } from "../seam/agent-do.js";
import type { Env, HonoBindings } from "../app-types.js";

/** bb timeline.ts:163-165. */
const THREAD_TIMELINE_DEFAULT_SEGMENT_LIMIT = 20;
const THREAD_TIMELINE_SEGMENT_LIMIT_MAX = 100;

/** bb hub metadata carries the recorded client action types. */
const SEND_EVENT_TYPES = ["client/turn/requested"] as const;

/**
 * M0 thread face (ruling #7 subset): base/actions/data/tabs/interactions
 * routes the SPA's active surfaces consume. Queue, edit-message, fork,
 * rate-limit-recovery, storage/host-file faces are additive families (#27+).
 */
export function registerThreadRoutes(app: Hono<{ Bindings: HonoBindings }>): void {
  const routes = new Hono<{ Bindings: HonoBindings }>();

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
    // bb threadListResponseSchema: bare array.
    return ctx.json(rows.map(toThreadListEntry));
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
    const toResult = (result: (typeof response.active.results)[number]) => ({
      thread: toThreadListEntry(result.thread),
      matches: result.matches,
    });
    return ctx.json(
      threadSearchResponseSchema.parse({
        active: {
          total: response.active.total,
          results: response.active.results.map(toResult),
        },
        archived: {
          total: response.archived.total,
          results: response.archived.results.map(toResult),
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
    // M0 harness minimum: single provider (spec #17 ruling #10; provider
    // selection surfaces are daemon-lane faces).
    const providerId = payload.providerId ?? "omp";
    const threadId = createThreadId();
    const visibility =
      payload.visibility ??
      (parentThreadId !== null
        ? ((await getThreadRow(ctx.env, parentThreadId))?.visibility ?? "visible")
        : "visible");
    const row = await createThreadRecord(ctx.env, {
      id: threadId,
      projectId: payload.projectId,
      providerId,
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
      const content = payload.input.map((entry) => {
        if (entry.type !== "text") {
          throw new ApiError({
            status: 422,
            code: "validation_failed",
            message: `Unsupported prompt input type for M0: ${entry.type}`,
          });
        }
        return { type: "text" as const, text: entry.text };
      });
      // bb generates the client turn request id server-side (thread-send.ts:
      // 346-356) — the same shape the send route records for /send turns.
      const clientRequestId = formatClientTurnRequestIdSuffix({
        suffix: Array.from(crypto.getRandomValues(new Uint8Array(10)))
          .map((byte) =>
            CLIENT_TURN_REQUEST_ID_ALPHABET.charAt(byte % CLIENT_TURN_REQUEST_ID_ALPHABET.length),
          )
          .join(""),
      });
      const result = await agentDoFor(ctx.env, threadId).sendMessage({
        clientRequestId,
        content,
        mode: "start",
      });
      if (!result.duplicated) {
        // Coarse M0 status transition shared with the send route: the daemon
        // lifecycle (#30) owns the real starting→active path; without it the
        // control plane flips active on dispatch so SPA surfaces reflect an
        // open turn.
        await updateThreadRecord(ctx.env, threadId, { status: "active" });
        dispatchedRow = (await getThreadRow(ctx.env, threadId)) ?? row;
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
    return ctx.json(await toThreadResponseWithSpawnCheck(ctx.env, dispatchedRow), 201);
  });

  // --- get / update / delete ------------------------------------------------------

  routes.get("/threads/:id", async (ctx) => {
    // bb 422s on unknown query params even when the M0 include face resolves
    // them to null, so validate the surface without binding the result.
    parseOr422(threadGetQuerySchema, ctx.req.query());
    const row = await requirePublicThread(ctx);
    const response = (await toThreadResponseWithSpawnCheck(ctx.env, row)) as ThreadResponse & {
      environment?: unknown;
      host?: unknown;
    };
    // M0: environment/host includes resolve to null — the environment family
    // is OUT (ruling #7); the response fields exist and are nullable (bb
    // threadWithIncludesResponseSchema).
    return ctx.json(response);
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
    const updated = await updateThreadRecord(ctx.env, row.id, {
      ...(payload.title !== undefined ? { title: payload.title } : {}),
      ...(payload.sectionId !== undefined ? { sectionId: payload.sectionId } : {}),
      ...(payload.parentThreadId !== undefined ? { parentThreadId: payload.parentThreadId } : {}),
      ...(payload.visibility !== undefined ? { visibility: payload.visibility } : {}),
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
    const row = await requirePublicThread(ctx);
    const mode = resolveSendMode(row.status, payload.mode);
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
    const content = payload.input.map((entry) => {
      if (entry.type !== "text") {
        throw new ApiError({
          status: 422,
          code: "validation_failed",
          message: `Unsupported prompt input type for M0: ${entry.type}`,
        });
      }
      return { type: "text" as const, text: entry.text };
    });
    const result = await agentDoFor(ctx.env, row.id).sendMessage({
      clientRequestId,
      content,
      mode,
    });
    if (!result.duplicated) {
      // Coarse M0 status transition: the daemon lifecycle (#30) owns the real
      // starting→active path; without it the control plane flips active on
      // send so SPA surfaces reflect an open turn.
      if (row.status !== "active") {
        await updateThreadRecord(ctx.env, row.id, { status: "active" });
        await hub(ctx).notifyThread(row.id, ["status-changed"], { projectId: row.projectId });
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
    // bb stopThreadForCurrentState (thread-lifecycle.ts:1470-1522): with no
    // attached environment the stop is a no-op release — M0 threads have no
    // environment (family OUT), so the route is exactly that path.
    await requirePublicThread(ctx);
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
    // derives a permanent waiting-for-host busy state (census #45 P0-3).
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
    return ctx.json({
      rows: summaryOnly ? [] : page.rows,
      activePromptMode: null,
      activeThinking: null,
      activeWorkflows: [],
      activeBackgroundCommands: [],
      pendingTodos: null,
      goal: null,
      modelFallback: null,
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

  // --- interactions (pending list; resolution is a #29/#30 face) --------------------------

  routes.get("/threads/:id/interactions", async (ctx) => {
    await requirePublicThread(ctx);
    // bb listPendingInteractionsByThread with statuses pending|resolving —
    // no pending-interaction producer exists in the M0 control plane.
    return ctx.json([]);
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
