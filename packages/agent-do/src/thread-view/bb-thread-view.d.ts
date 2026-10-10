/**
 * #560 ambient type surface for the bb modules the thread-view materializer
 * imports at runtime.
 *
 * WHY AMBIENT SHIMS INSTEAD OF REAL TYPES: the stack consumes bb thread-view
 * and bb domain as submodule SOURCES (tsc cannot check them under this
 * stack's stricter base flags — noUncheckedIndexedAccess/verbatimModuleSyntax
 * reject bb code that compiles clean under bb's own tsconfig), while runtime
 * resolution differs per pipeline: deploy/dev bundling resolves the bare
 * specifiers through the wrangler `alias` blocks; the vitest plugin's module
 * pipeline externalizes bare specifiers to workerd (source-only TS packages
 * fail there — the worker face tests that exercise the switched route stay
 * on the plugin suite's known-blocked list, see #560 close-out); the pure
 * node-env harness (vitest.thread-view.config.ts) resolves them through the
 * workspace node_modules symlinks and vite's transform, which is why the
 * dual-path harness runs there.
 *
 * The shim declares exactly the surface this package consumes; every value
 * crossing back into the cap stack is re-validated against the cap contract
 * schemas at the consumer boundary (services/thread-view.ts), and bb itself
 * re-validates every row through its per-type zod schema at decode
 * (buildThreadEvent), so shim drift fails loudly instead of lying.
 */
declare module "@bb/domain" {
  export type ThreadEventScope = { kind: "thread" } | { kind: "turn"; turnId: string };

  /**
   * StoredEventRow + scope — bb's persisted event row shape. Typed loosely
   * on purpose: `type`/`data` are validated per-row by bb's own zod schema
   * when the row is decoded (buildThreadEvent → threadEventSchema.parse),
   * and the projection output is re-validated against the cap contract at
   * the consumer boundary.
   */
  export interface ThreadEventRow {
    id: string;
    scope: ThreadEventScope;
    threadId: string;
    seq: number;
    createdAt: number;
    type: string;
    data: Record<string, unknown>;
  }

  export const threadEventScopeSchema: { parse(value: unknown): ThreadEventScope };

  /**
   * bb stored-thread-event.ts buildThreadEvent — validates a row into the
   * decoded event (the projection pipeline's per-type zod gate).
   */
  export function buildThreadEvent(row: {
    scope: ThreadEventScope;
    threadId: string;
    type: string;
    data: Record<string, unknown>;
    [key: string]: unknown;
  }): unknown;
}

declare module "@bb/thread-view" {
  export interface EventMetaLike {
    id: string;
    seq: number;
    createdAt: number;
  }

  /** ThreadEventWithMeta — the decoded event rides meta for seq/bounds. */
  export interface ThreadEventWithMeta {
    event: unknown;
    meta: EventMetaLike;
  }

  export interface AcceptedClientRequestContext {
    readonly requests: readonly unknown[];
  }

  export const EMPTY_ACCEPTED_CLIENT_REQUEST_CONTEXT: AcceptedClientRequestContext;

  export interface ThreadTimelineFromEventsOptions {
    contextOnlyToolCallIds?: ReadonlySet<string>;
    includeDebugRawEvents: boolean;
    includeProviderUnhandledOperations: boolean;
    isLatestPage: boolean;
    providerId?: string;
    providerDisplayName?: string;
    threadStatus: string;
    threadName: string;
    workspaceRoot: string | null;
    includeNestedRows: boolean;
    turnMessageDetail: "summary" | "full";
  }

  export interface BuildThreadTimelineFromEventsArgs {
    acceptedClientRequestContext: AcceptedClientRequestContext;
    contextWindowEvents: ThreadEventWithMeta[];
    events: ThreadEventWithMeta[];
    options: ThreadTimelineFromEventsOptions;
  }

  export interface ThreadTimelineFromEventsResult {
    activePromptMode: unknown;
    activeThinking: unknown;
    activeWorkflows: unknown[];
    activeBackgroundCommands: unknown[];
    contextWindowUsage: unknown;
    goal: unknown;
    modelFallback: unknown;
    pendingTodos: unknown;
    rows: unknown[];
  }

  export function buildThreadTimelineFromEvents(
    args: BuildThreadTimelineFromEventsArgs,
  ): ThreadTimelineFromEventsResult;
}
