import { z } from "zod";
import { promptContentSchema, threadEventEnvelopeSchema } from "./events.js";
import {
  createThreadEnvironmentArgsSchema,
  environmentSummarySchema,
  hostSummarySchema,
} from "./environments.js";

/**
 * Frozen HTTP surface (`/api/v1`), bb-shaped so the bb SPA can be pointed at
 * fake-edge with minimal adapter work. M0 covers the thread list +
 * conversation + streaming-render face; the full bb route inventory (projects,
 * environments, hosts, terminals, plugins, skills, files) is recorded in
 * README.md and grows additively per later tickets.
 */

export const API_PREFIX = "/api/v1";

export const threadStatusSchema = z.enum(["idle", "starting", "active", "stopping", "error"]);
export type ThreadStatus = z.infer<typeof threadStatusSchema>;

// ---------------------------------------------------------------------------
// Thread DTOs.
// ---------------------------------------------------------------------------

export const threadSummarySchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  title: z.string(),
  status: threadStatusSchema,
  createdAt: z.number(),
  updatedAt: z.number(),
  /** Seq of the newest event in the log; 0 for a fresh thread. */
  lastSeq: z.number().int().min(0),
  /**
   * #288 binding feed-through: the control-plane binding row inlined when the
   * thread has one. `undefined` = the deployment-default
   * binding (no environments row — trajectory machineId is the only truth);
   * `null` fields keep bb's nullable vocabulary.
   */
  environmentId: z.string().min(1).nullable().optional(),
  environment: environmentSummarySchema.nullable().optional(),
  host: hostSummarySchema.nullable().optional(),
});
export type ThreadSummary = z.infer<typeof threadSummarySchema>;

export const threadResponseSchema = threadSummarySchema;
export type ThreadResponse = ThreadSummary;

export const threadListResponseSchema = z.object({
  threads: z.array(threadSummarySchema),
});
export type ThreadListResponse = z.infer<typeof threadListResponseSchema>;

export const createThreadRequestSchema = z.object({
  /** bb requires projectId; M0 fakes default it so a bare SPA create works. */
  projectId: z.string().min(1).optional(),
  title: z.string().min(1).optional(),
  /**
   * #288: workspace binding choice resolved once at creation into the
   * trajectory (`thread.created.machineId`) and the control-plane row
   * (`threads.environment_id`). Omitted = server defaulting policy (project
   * default source, then the deployment single machine).
   */
  environment: createThreadEnvironmentArgsSchema.optional(),
  /** Optional seed message; when present it starts the first turn. */
  input: z.array(promptContentSchema).min(1).optional(),
  clientRequestId: z.string().min(1).optional(),
});
export type CreateThreadRequest = z.infer<typeof createThreadRequestSchema>;

export const sendMessageModeSchema = z.enum(["auto", "start", "steer"]);
export type SendMessageMode = z.infer<typeof sendMessageModeSchema>;

export const sendMessageRequestSchema = z.object({
  input: z.array(promptContentSchema).min(1),
  mode: sendMessageModeSchema.default("auto"),
  /** Idempotency key: duplicate sends with the same key start nothing. */
  clientRequestId: z.string().min(1).optional(),
});
export type SendMessageRequest = z.infer<typeof sendMessageRequestSchema>;

export const okResponseSchema = z.object({ ok: z.literal(true) });
export type OkResponse = z.infer<typeof okResponseSchema>;

// ---------------------------------------------------------------------------
// Events (replay) — the idempotent read side of the append-only log.
// ---------------------------------------------------------------------------

export const threadEventsQuerySchema = z.object({
  afterSeq: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});
export type ThreadEventsQuery = z.infer<typeof threadEventsQuerySchema>;

export const threadEventsResponseSchema = z.object({
  threadId: z.string().min(1),
  events: z.array(threadEventEnvelopeSchema),
  latestSeq: z.number().int().min(0),
  hasMore: z.boolean(),
});
export type ThreadEventsResponse = z.infer<typeof threadEventsResponseSchema>;

// ---------------------------------------------------------------------------
// Timeline — the SPA-facing rendered view (bb `thread-timeline.ts` subset).
// ---------------------------------------------------------------------------

export const timelineRowStatusSchema = z.enum(["pending", "completed", "error", "interrupted"]);
export type TimelineRowStatus = z.infer<typeof timelineRowStatusSchema>;

const timelineRowBaseSchema = z.object({
  id: z.string().min(1),
  threadId: z.string().min(1),
  turnId: z.string().nullable(),
  sourceSeqStart: z.number().int().min(1),
  sourceSeqEnd: z.number().int().min(1),
  startedAt: z.number(),
  createdAt: z.number(),
  status: timelineRowStatusSchema,
});

export const timelineRowSchema = z.discriminatedUnion("kind", [
  timelineRowBaseSchema.extend({
    kind: z.literal("conversation"),
    role: z.enum(["user", "assistant"]),
    text: z.string(),
  }),
  timelineRowBaseSchema.extend({
    kind: z.literal("work"),
    workKind: z.enum(["command", "tool"]),
    callId: z.string(),
    command: z.string().nullable(),
    toolName: z.string().nullable(),
    output: z.string(),
    exitCode: z.number().int().nullable(),
    completedAt: z.number().nullable(),
  }),
  timelineRowBaseSchema.extend({
    kind: z.literal("system"),
    systemKind: z.enum(["debug", "error", "reconnect", "operation"]),
    title: z.string(),
    detail: z.string().nullable(),
  }),
]);
export type TimelineRow = z.infer<typeof timelineRowSchema>;

export const timelineResponseSchema = z.object({
  threadId: z.string().min(1),
  rows: z.array(timelineRowSchema),
  latestSeq: z.number().int().min(0),
});
export type TimelineResponse = z.infer<typeof timelineResponseSchema>;

// ---------------------------------------------------------------------------
// System + bootstrap.
// ---------------------------------------------------------------------------

export const systemVersionResponseSchema = z.object({
  version: z.string(),
  protocol: z.object({
    http: z.literal("v1"),
    realtimeWs: z.literal("v1"),
  }),
});
export type SystemVersionResponse = z.infer<typeof systemVersionResponseSchema>;

export const sidebarProjectSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
});
export type SidebarProject = z.infer<typeof sidebarProjectSchema>;

export const sidebarBootstrapResponseSchema = z.object({
  projects: z.array(sidebarProjectSchema),
  threads: z.array(threadSummarySchema),
});
export type SidebarBootstrapResponse = z.infer<typeof sidebarBootstrapResponseSchema>;

// ---------------------------------------------------------------------------
// Frozen route table. Paths are relative to API_PREFIX. This list is the
// single source of truth for what M0 serves; fake-edge implements exactly
// these routes.
// ---------------------------------------------------------------------------

export interface HttpRouteDescriptor {
  readonly method: "GET" | "POST" | "DELETE";
  readonly path: string;
  readonly purpose: string;
}

export const HTTP_ROUTES: readonly HttpRouteDescriptor[] = [
  {
    method: "GET",
    path: "/system/version",
    purpose: "protocol + build version banner",
  },
  {
    method: "GET",
    path: "/sidebar-bootstrap",
    purpose: "one-shot sidebar payload (projects + threads)",
  },
  { method: "GET", path: "/threads", purpose: "thread list" },
  { method: "POST", path: "/threads", purpose: "create thread (201)" },
  { method: "GET", path: "/threads/:id", purpose: "thread detail" },
  { method: "DELETE", path: "/threads/:id", purpose: "delete thread" },
  { method: "POST", path: "/threads/:id/send", purpose: "start a turn" },
  { method: "POST", path: "/threads/:id/stop", purpose: "stop active turn" },
  {
    method: "GET",
    path: "/threads/:id/events",
    purpose: "idempotent event replay (afterSeq/limit)",
  },
  {
    method: "GET",
    path: "/threads/:id/timeline",
    purpose: "rendered timeline rows",
  },
  {
    method: "GET",
    path: "/environments",
    purpose: "binding rows for a project (?projectId=, #288 minimal set)",
  },
  {
    method: "GET",
    path: "/environments/:id",
    purpose: "binding row detail (bb environments get, #288 minimal set)",
  },
] as const;
