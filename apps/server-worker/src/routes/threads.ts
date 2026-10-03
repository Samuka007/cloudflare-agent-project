import { Hono } from "hono";
import {
  createThreadRequestSchema,
  deleteThreadRequestSchema,
  sendMessageRequestSchema,
  threadEventsQuerySchema,
  threadGetQuerySchema,
  threadListQuerySchema,
  threadTimelineQuerySchema,
  updateThreadRequestSchema,
  type ThreadResponse,
} from "../contract/api/threads.js";
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
import { parseOr422, requireJsonBody } from "../shared/route-utils.js";
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
import { getStoredThreadTabs, replaceStoredThreadTabs } from "../db/thread-tabs.js";
import {
  toThreadListEntry,
  toThreadResponseWithSpawnCheck,
} from "../services/runtime-display.js";
import {
  buildConversationOutline,
  buildTimelinePage,
  projectTimelineRows,
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
      throw new ApiError({ status: 400, code: "invalid_request", message: "limit must be positive" });
    }
    if (offsetRaw !== undefined && offsetRaw < 0) {
      throw new ApiError({ status: 400, code: "invalid_request", message: "offset must be non-negative" });
    }
    if (query.projectId !== undefined) {
      const project = await getProject(ctx.env, query.projectId);
      if (!project || project.deletedAt !== null) {
        throw new ApiError({ status: 404, code: "project_not_found", message: "Project not found" });
      }
    }
    if (query.sectionId !== undefined && query.unsectioned === "true") {
      throw new ApiError({ status: 400, code: "invalid_request", message: "sectionId and unsectioned cannot be used together" });
    }
    if (query.sectionId !== undefined && (await getThreadSection(ctx.env, query.sectionId)) === null) {
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

  // --- create -------------------------------------------------------------------

  routes.post("/threads", async (ctx) => {
    const payload = await requireJsonBody(ctx, createThreadRequestSchema);
    const project = await getProject(ctx.env, payload.projectId);
    if (!project || project.deletedAt !== null) {
      throw new ApiError({ status: 404, code: "project_not_found", message: "Project not found" });
    }
    if (payload.sectionId !== null && payload.sectionId !== undefined) {
      if ((await getThreadSection(ctx.env, payload.sectionId)) === null) {
        throw new ApiError({ status: 404, code: "section_not_found", message: "Section not found" });
      }
    }
    let parentThreadId: string | null = null;
    let sourceThreadId: string | null = null;
    if (payload.parentThreadId !== undefined) {
      const parent = await getThreadRow(ctx.env, payload.parentThreadId);
      if (!parent || parent.deletedAt !== null) {
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
      (parentThreadId !== null ? (await getThreadRow(ctx.env, parentThreadId))?.visibility ?? "visible" : "visible");
    const row = await createThreadRecord(ctx.env, {
      id: threadId,
      projectId: payload.projectId,
      providerId,
      title: payload.title ?? null,
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
    return ctx.json(await toThreadResponseWithSpawnCheck(ctx.env, row), 201);
  });

  // --- get / update / delete ------------------------------------------------------

  routes.get("/threads/:id", async (ctx) => {
    const query = parseOr422(threadGetQuerySchema, ctx.req.query());
    const row = await requirePublicThread(ctx);
    const response = (await toThreadResponseWithSpawnCheck(ctx.env, row)) as ThreadResponse & {
      environment?: unknown;
      host?: unknown;
    };
    const includes = (query.include ?? "").split(",").filter(Boolean);
    // M0: environment/host includes resolve to null — the environment family
    // is OUT (ruling #7); the response fields exist and are nullable (bb
    // threadWithIncludesResponseSchema).
    void includes;
    return ctx.json(response);
  });

  routes.patch("/threads/:id", async (ctx) => {
    const payload = await requireJsonBody(ctx, updateThreadRequestSchema);
    const row = await requirePublicThread(ctx);
    if (payload.sectionId !== undefined && payload.sectionId !== null) {
      if ((await getThreadSection(ctx.env, payload.sectionId)) === null) {
        throw new ApiError({ status: 404, code: "section_not_found", message: "Section not found" });
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
      await hub(ctx).notifyThread(row.id, updated.changedKinds, { projectId: updated.row.projectId });
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
        .map((byte) => CLIENT_TURN_REQUEST_ID_ALPHABET.charAt(byte % CLIENT_TURN_REQUEST_ID_ALPHABET.length))
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
    const row = await requirePublicThread(ctx);
    // bb stopThreadForCurrentState (thread-lifecycle.ts:1470-1522): with no
    // attached environment the stop is a no-op release — M0 threads have no
    // environment (family OUT), so the route is exactly that path.
    void row;
    return ctx.json({ ok: true });
  });

  // --- timeline / outline / events ---------------------------------------------------

  routes.get("/threads/:id/timeline", async (ctx) => {
    const query = parseOr422(threadTimelineQuerySchema, ctx.req.query());
    const row = await requirePublicThread(ctx);
    let segmentLimit = THREAD_TIMELINE_DEFAULT_SEGMENT_LIMIT;
    if (query.segmentLimit !== undefined) {
      const parsed = Number(query.segmentLimit);
      if (!Number.isInteger(parsed) || parsed <= 0 || parsed > THREAD_TIMELINE_SEGMENT_LIMIT_MAX) {
        throw new ApiError({ status: 400, code: "invalid_request", message: "segmentLimit out of range" });
      }
      segmentLimit = parsed;
    }
    const { events, latestSeq } = await agentDoFor(ctx.env, row.id).getEvents({
      sinceSeq: 0,
      project: "ux",
    });
    const allRows = projectTimelineRows(events);
    const kind = query.beforeAnchorSeq !== undefined ? "older" : "latest";
    if (query.beforeAnchorSeq !== undefined) {
      const anchorId = query.beforeAnchorId;
      const anchorExists = allRows.some(
        (candidate) =>
          candidate.id === anchorId &&
          candidate.sourceSeqStart === Number(query.beforeAnchorSeq),
      );
      if (!anchorExists) {
        throw new ApiError({ status: 400, code: "invalid_request", message: "Unknown timeline anchor" });
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
    const paramsKey = `${row.id}|${row.status}|${kind}|${segmentLimit}|${String(includeNestedRows)}|${String(summaryOnly)}`;
    let delta;
    if (query.afterSequence !== undefined && kind === "latest") {
      const cached = timelineLatestRowsCache.get(paramsKey);
      if (cached && cached.maxSeq === Number(query.afterSequence)) {
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
        limit: 1,
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
      await hub(ctx).waitThreadEvent({ threadId: row.id, waitMs: remaining });
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
async function requirePublicThread(ctx: {
  env: Env;
  req: { param(name: string): string };
}) {
  const thread = await getThreadRow(ctx.env, ctx.req.param("id"));
  if (!thread || thread.deletedAt !== null) {
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
    notifyThread(threadId: string, changes: string[], metadata?: unknown): Promise<{ delivered: number }>;
    notifyProject(projectId: string, changes: string[]): Promise<{ delivered: number }>;
    notifyHost(hostId: string, changes: string[]): Promise<{ delivered: number }>;
    notifySystem(changes: string[]): Promise<{ delivered: number }>;
    waitThreadEvent(args: { threadId: string; waitMs: number }): Promise<{ resolved: boolean }>;
    broadcastSignal(frame: Record<string, unknown>): Promise<{ delivered: number }>;
  };
}
