import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EvalKernelRuntime } from "./eval-kernel.js";

/**
 * Vendored omp tool runtime (M1.5/T5' #128): host construction, native-addon
 * version gate, and the dispatch-frame adapter. The host tools
 * (read/glob/grep/find/write/edit + manage_skill, T6 #96 / T11 #101) execute
 * through omp's own `execute()` path —
 * spike evidence docs/research/omp-runtime-embedding.md §1–§3; the vendoring
 * mechanism is npm dependency pinning (@oh-my-pi 18.6.0, exact in
 * package.json + pnpm-lock.yaml), so the runtime is the release artifact of
 * the pinned checkout (oh-my-pi npm 18.6.0) rather than a copied tree.
 *
 * Runtime discipline (spike §5 verdict): omp executes ONLY under Bun — the
 * daemon client process must be started with Bun (omp ships raw TS and
 * imports `bun` built-ins); the Node-side tsc program typechecks against the
 * package's shipped dist/types declarations. omp modules load LAZILY inside
 * createToolHost (dynamic imports): the process-global agent dir must be
 * redirected (PI_CODING_AGENT_DIR) before omp's dir resolver freezes at
 * module load, and the version gate runs before any omp import.
 */

/** The dispatch frame (control-plane §4; agent-do ToolDispatchRequest minus
 * thread/turn routing, which the WS session already binds). */
export interface ToolDispatchFrame {
  tool: string;
  arguments: Record<string, unknown>;
  executionId: string;
  machineId: string;
  timeoutMs: number;
}

export type WireStatus = "ok" | "error" | "timeout" | "cancelled";

/** Projected result — agent-do ToolResultPayload shape (exitCode is a bash
 * process concept; host tools carry none). */
export interface ToolExecutionResult {
  status: WireStatus;
  exitCode: null;
  output: string;
  outputTruncated?: boolean;
}

// ---------------------------------------------------------------------------
// omp surface (structural — the spike's `never` bridge, narrowed to what the
// adapter reads; omp's own types stay generic so version bumps surface here
// as explicit mapping work, not silent structural drift).
// ---------------------------------------------------------------------------

interface OmpToolResult {
  content: { type: string; text?: string }[];
  /** Tool-specific structured details — read only through the truncation meta. */
  details?: object;
  isError?: boolean;
}

interface OmpTool {
  name: string;
  execute(
    toolCallId: string,
    params: unknown,
    signal?: AbortSignal,
    onUpdate?: (partial: { content: { type: string; text?: string }[] }) => void,
  ): Promise<OmpToolResult>;
}

export interface ToolHost {
  /** machineId this host is bound to (frame.machineId must match). */
  machineId: string;
  settings: Settings;
  session: Record<string, unknown>;
  tools: Record<string, OmpTool>;
}

/**
 * Host settings overrides (agent enablement, T6 #96): `autolearn.enabled`
 * admits omp's own ManageSkillTool.createIf gate — the same flag omp checks,
 * pinned host-side in the isolated settings (no daemon capability
 * negotiation, control-plane §1.2).
 */
const HOST_SETTINGS_OVERRIDES: Record<string, unknown> = {
  "autolearn.enabled": true,
};

// ---------------------------------------------------------------------------
// Native addon version gate (spike §2: a stale addon — 15.5.6 vs 18.4.4 —
// loads but misses exports and crashes at import; the gate refuses start).
// ---------------------------------------------------------------------------

export interface NativeAddonIdentity {
  path: string;
  version: string | null;
  packageVersion: string;
  stale: boolean;
}

/**
 * Reads omp's own addon diagnostics (`nativeAddonStatus()` from
 * pi-natives/native/loader-state.js). Runtime-selected import (rule
 * exception): the loader-state module is not in the package exports map, so
 * no static bare specifier can reach it — resolve the exported main entry
 * and import the sibling file by real path (identical under Bun and Node).
 * The addon loads lazily on the natives surface import — until then
 * `nativeAddonStatus()` is null — so the surface import happens HERE, before
 * the status read; a stale addon surfaces as an import failure (spike §2's
 * actual crash-at-import mode), which is itself a refusal.
 */
export async function readNativeAddonStatus(): Promise<NativeAddonIdentity> {
  const require = createRequire(import.meta.url);
  const nativesEntry = require.resolve("@oh-my-pi/pi-natives");
  await import(pathToFileURL(nativesEntry).href);
  // unknown boundary: the computed specifier resolves to `any` (no static
  // d.ts), and `any as T` trips no-unnecessary-type-assertion while a bare
  // typed assignment trips no-unsafe-assignment.
  const loaded: unknown = await import(
    pathToFileURL(join(dirname(nativesEntry), "loader-state.js")).href
  );
  const loaderState = loaded as { nativeAddonStatus: () => NativeAddonIdentity | null };
  const status = loaderState.nativeAddonStatus();
  if (status === null) {
    throw new Error("pi-natives addon did not load — nativeAddonStatus() returned null");
  }
  return status;
}

/** Pure gate over the addon identity — unit-testable without the addon. */
export function assertNativeAddonCurrent(status: NativeAddonIdentity): void {
  if (status.stale) {
    throw new Error(
      `pi-natives addon is stale: addon ${status.version ?? "unidentified"} != package ${status.packageVersion} (${status.path}). ` +
        `Refusing to start — a stale addon crashes host tools at import (spike: EditStore missing). ` +
        `Reinstall @oh-my-pi/pi-natives so the addon matches the pinned package version.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Host construction (spike §1: the minimal ToolSession is five members).
// ---------------------------------------------------------------------------

/**
 * Builds the tool host. `agentDir` MUST be a daemon-private directory
 * (settings isolation — spike §1 warning): `Settings.loadIsolated` reads
 * `<agentDir>/config.yml` + agent.db, so a developer's `~/.omp` would
 * silently drift the host's tool schemas/behavior (edit.mode included).
 */
export async function createToolHost(
  cwd: string,
  agentDir: string,
  machineId: string,
): Promise<ToolHost> {
  // Agent-dir isolation (T6 #96): process-global omp paths — the
  // managed-skills store (getManagedSkillsDir → getAgentDir()), auth,
  // session-index db — must resolve under the daemon-private directory, not
  // the operator's ~/.omp. The dir resolver freezes at omp module load, so
  // the env pin lands BEFORE the dynamic imports below.
  process.env.PI_CODING_AGENT_DIR = agentDir;
  // Static imports cannot work here: omp's module graph freezes the
  // process-global agent-dir resolver at load time (pi-utils dirs.ts module
  // init), and the daemon-private agentDir is a runtime config value — the
  // env pin above must land BEFORE these specifiers evaluate.
  const [
    { Settings },
    { EditTool },
    { FindTool },
    { GlobTool },
    { GrepTool },
    { ReadTool },
    { WriteTool },
    { ManageSkillTool },
  ] = await Promise.all([
    import("@oh-my-pi/pi-coding-agent/config/settings"),
    import("@oh-my-pi/pi-coding-agent/edit"),
    import("@oh-my-pi/pi-coding-agent/tools/jfind"),
    import("@oh-my-pi/pi-coding-agent/tools/glob"),
    import("@oh-my-pi/pi-coding-agent/tools/grep"),
    import("@oh-my-pi/pi-coding-agent/tools/read"),
    import("@oh-my-pi/pi-coding-agent/tools/write"),
    import("@oh-my-pi/pi-coding-agent/tools/manage-skill"),
  ]);
  const settings = await Settings.loadIsolated({
    cwd,
    agentDir,
    overrides: HOST_SETTINGS_OVERRIDES,
  });
  const session = {
    cwd,
    hasUI: false,
    settings,
    getSessionFile: () => null,
    getSessionSpawns: () => null,
  } as never;
  const candidates: OmpTool[] = [
    new GlobTool(session),
    new GrepTool(session),
    // T11 (#101): the judge role resolves through the session's model
    // registry — absent here, every find degrades with the precise
    // ToolError ("find has no model registry to resolve a judge from")
    // until the daemon-side provider channel lands (ticket-large gap).
    new FindTool(session),
    new ReadTool(session),
    new WriteTool(session),
    new EditTool(session),
  ];
  const tools: Record<string, OmpTool> = {};
  for (const tool of candidates) tools[tool.name] = tool;
  // manage_skill rides omp's own enablement gate (autolearn.enabled pinned
  // on above); when the gate closes the tool is simply absent from the map.
  const manageSkill = ManageSkillTool.createIf(session);
  if (manageSkill !== null) tools[manageSkill.name] = manageSkill;
  return { machineId, settings, session, tools };
}

// ---------------------------------------------------------------------------
// Dispatch adapter (spike §3: frame → omp execute(), result → payload;
// zero semantic invention — every branch below maps one omp observable).
// ---------------------------------------------------------------------------

function contentText(result: OmpToolResult): string {
  return result.content
    .map((block) => (block.type === "text" ? (block.text ?? "") : `<${block.type}>`))
    .join("\n");
}

export async function executeDispatch(
  host: ToolHost,
  frame: ToolDispatchFrame,
  options: {
    onOutput?: (chunk: string) => void;
    /** Business cancel: an external abort forwarded into the dispatch. */
    cancelSignal?: AbortSignal;
  } = {},
): Promise<ToolExecutionResult> {
  if (frame.machineId !== host.machineId) {
    return {
      status: "error",
      exitCode: null,
      output: `frame for machine ${frame.machineId} reached host ${host.machineId}`,
    };
  }
  const tool = host.tools[frame.tool];
  if (!tool) {
    return { status: "error", exitCode: null, output: `unknown tool: ${frame.tool}` };
  }
  const controller = new AbortController();
  const timedOut = { value: false };
  options.cancelSignal?.addEventListener(
    "abort",
    () => {
      controller.abort();
    },
    { once: true },
  );
  const timer =
    frame.timeoutMs > 0
      ? setTimeout(() => {
          timedOut.value = true;
          controller.abort(new Error(`timeout after ${frame.timeoutMs}ms`));
        }, frame.timeoutMs)
      : undefined;
  timer?.unref();
  try {
    const result = await tool.execute(
      frame.executionId,
      frame.arguments,
      controller.signal,
      options.onOutput ? (partial) => options.onOutput?.(contentText(partial)) : undefined,
    );
    const truncation = (result.details as { meta?: { truncation?: unknown } } | undefined)?.meta
      ?.truncation;
    return {
      status: result.isError ? "error" : "ok",
      exitCode: null,
      output: contentText(result),
      ...(truncation !== undefined ? { outputTruncated: true } : {}),
    };
  } catch (error) {
    if (controller.signal.aborted) {
      const cause = timedOut.value ? "timeout" : "cancelled";
      return {
        status: cause,
        exitCode: null,
        output: cause === "timeout" ? `timeout after ${frame.timeoutMs}ms` : "cancelled",
      };
    }
    const message = error instanceof Error ? error.message : String(error);
    return { status: "error", exitCode: null, output: message };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Runtime: lazy host + running table (abort, idempotent re-forward, announce).
// ---------------------------------------------------------------------------

interface RunningTool {
  controller: AbortController;
  done: Promise<ToolExecutionResult>;
}

export interface ToolRuntimeConfig {
  /** Workspace root — the cwd every host tool resolves against. */
  workspaceRoot: string;
  /** Daemon-private settings directory (dataDir/omp-agent). */
  agentDir: string;
  machineId: string;
}

export class ToolRuntime {
  private host: ToolHost | null = null;
  private hostPromise: Promise<ToolHost> | null = null;
  /** Eval kernel seam (T10' #100) — lazily constructed, shares this config. */
  private evalRuntime: EvalKernelRuntime | null = null;
  /** Live runs by executionId (abort handle + idempotent re-forward answer). */
  readonly running = new Map<string, RunningTool>();

  constructor(private readonly config: ToolRuntimeConfig) {}

  /** Builds the host once; the version gate runs first (refuse start). */
  ensureHost(): Promise<ToolHost> {
    this.hostPromise ??= (async () => {
      assertNativeAddonCurrent(await readNativeAddonStatus());
      return createToolHost(this.config.workspaceRoot, this.config.agentDir, this.config.machineId);
    })();
    return this.hostPromise;
  }

  /**
   * Executes one dispatch frame. Idempotent per executionId: a watchdog
   * re-forward while the same run is live resolves against the SAME run —
   * never a second execution (I16 client half).
   */
  execute(
    frame: ToolDispatchFrame,
    onOutput?: (chunk: string) => void,
  ): Promise<ToolExecutionResult> {
    const live = this.running.get(frame.executionId);
    if (live !== undefined) return live.done;
    const controller = new AbortController();
    const done = this.ensureHost().then((host) =>
      frame.tool === "eval"
        ? (this.evalRuntime ??= new EvalKernelRuntime(this.config)).execute(host, frame, {
            onOutput,
            cancelSignal: controller.signal,
          })
        : executeDispatch(host, frame, { onOutput, cancelSignal: controller.signal }),
    );
    this.running.set(frame.executionId, { controller, done });
    void done
      .catch(() => undefined)
      .finally(() => {
        if (this.running.get(frame.executionId)?.done === done)
          this.running.delete(frame.executionId);
      });
    return done;
  }

  /** Business cancel (§2.4): abort the live run; timeout keeps its own path. */
  abort(executionId: string): boolean {
    const live = this.running.get(executionId);
    if (live === undefined) return false;
    live.controller.abort();
    return true;
  }
}
