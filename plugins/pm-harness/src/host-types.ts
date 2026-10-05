/**
 * host-types.ts — structural types for the omp custom-tool host API (#270).
 *
 * The plugin must typecheck and install WITHOUT the `@oh-my-pi/pi-coding-agent`
 * dependency (it is not a workspace dep, and the package has to stay
 * standalone-extractable per the #270 ticket), so the host surfaces used by
 * tools.ts are declared structurally here against the installed runtime's
 * public contract:
 * `@oh-my-pi/pi-coding-agent/dist/types/extensibility/custom-tools/types.d.ts`
 * (verified against omp 18.6.1, 2026-10-05). Keep in sync on omp upgrades.
 *
 * Deliberately opaque: `parameters` accepts whatever the injected
 * `pi.zod` builder returns, and each tool's `execute` types its params with a
 * locally-declared args interface that mirrors the schema declared beside it —
 * omp validates against the schema before execute, so the static type is the
 * wire contract, exactly like the vendored-runtime adapter pattern in
 * packages/agent-do/src/tools/registry.ts.
 */

/** Subset of omp ExecOptions/ExecResult (exec/exec.d.ts). */
export interface ExecOptions {
  signal?: AbortSignal;
  timeout?: number;
  cwd?: string;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
  killed: boolean;
}

/** Tool result content — text blocks only is all this family needs. */
export interface ToolContentBlock {
  type: "text";
  text: string;
}

export interface ToolResult {
  content: ToolContentBlock[];
  details?: unknown;
}

export interface ToolUpdate {
  content: ToolContentBlock[];
  details?: unknown;
}

/** Structural slice of CustomToolContext (types.d.ts:71-92) — read-only for
 *  this family; nothing here uses session internals yet. */
export interface CustomToolContext {
  sessionManager: unknown;
  modelRegistry: unknown;
  model: unknown;
  isIdle(): boolean;
  hasQueuedMessages(): boolean;
  abort(): void;
}

/** Chainable leaf node — the omptype zod-compatible builder's returned shape,
 *  typed as the union of everything this family calls. */
export interface ZodNode {
  describe(text: string): ZodNode;
  optional(): ZodNode;
  default(value: string | number | boolean | null): ZodNode;
}

/** Structural slice of the injected `pi.zod` builder (types.d.ts:61). */
export interface ZodBuilder {
  object(shape: Record<string, ZodNode>): ZodNode;
  array(item: ZodNode): ZodNode;
  union(options: ZodNode[]): ZodNode;
  number(): ZodNode;
  string(): ZodNode;
  boolean(): ZodNode;
  null(): ZodNode;
  enum(values: readonly string[]): ZodNode;
}

/** Structural slice of CustomToolAPI (types.d.ts:45-66) — only what this
 *  family consumes. */
export interface CustomToolAPI {
  cwd: string;
  exec(command: string, args: string[], options?: ExecOptions): Promise<ExecResult>;
  hasUI: boolean;
  zod: ZodBuilder;
}

/**
 * Structural CustomTool (types.d.ts:175-215). `TArgs` mirrors the zod schema
 * declared beside the definition; omp validates params before execute.
 */
export interface CustomTool<TArgs = unknown> {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  execute(
    toolCallId: string,
    params: TArgs,
    onUpdate: ((update: ToolUpdate) => void) | undefined,
    ctx: CustomToolContext,
    signal: AbortSignal | undefined,
  ): Promise<ToolResult> | ToolResult;
}

/** Factory contract the omp custom-tools loader invokes (default export). */
export type CustomToolFactory = (
  pi: CustomToolAPI,
) => CustomTool | CustomTool[] | Promise<CustomTool | CustomTool[]>;
