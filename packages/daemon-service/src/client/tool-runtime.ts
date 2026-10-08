import { createRequire } from "node:module";
import { existsSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { log } from "./log.js";
import type { WorkspaceRef } from "../protocol.js";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EvalKernelRuntime } from "./eval-kernel.js";
import { threadIdFromExecutionId } from "../execution-id.js";
import { IsolationManager, type TaskIsolationConfig } from "./task-isolation.js";
import { installAgentAuth, type AgentAuthConfig } from "./agent-auth.js";

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
 * package's shipped dist/types declarations. The omp module graph (and its
 * DirResolver) loads at this module's import — the static Settings import —
 * so createToolHost re-points the frozen resolver via pi-utils' setAgentDir
 * before any tool executes; the version gate runs before any omp import.
 */

/** The dispatch frame (control-plane §4; agent-do ToolDispatchRequest minus
 * thread/turn routing, which the WS session already binds). */
export interface ToolDispatchFrame {
  tool: string;
  arguments: Record<string, unknown>;
  executionId: string;
  machineId: string;
  timeoutMs: number;
  /** Workspace binding leg (#290 C1); absent = the daemon sandbox default. */
  workspace?: WorkspaceRef;
}

export type WireStatus = "ok" | "error" | "timeout" | "cancelled";

/** Projected result — agent-do ToolResultPayload shape. Bash carries the
 * process exit code (M0 exec.exited semantic, T9 #99: omp details.exitCode);
 * host tools carry none (null). */
export interface ToolExecutionResult {
  status: WireStatus;
  exitCode: number | null;
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

/** Bash result details (probe delta table): the process exit code and the
 * truncation meta live here; everything else stays omp-internal. */
interface BashToolDetails {
  exitCode?: number;
  meta?: { truncation?: unknown };
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
  /** Workspace root — the sandbox every bash cwd is clamped into (shim 2). */
  workspaceRoot: string;
  settings: Settings;
  session: Record<string, unknown>;
  tools: Record<string, OmpTool>;
  /** Daemon-private artifact root (T20 #110: isolation delta artifacts). */
  artifactsRoot: string;
  /**
   * Per-frame bash tool view keyed by the thread-scoped shell sessionKey
   * (T9 #99): a fresh BashTool per dispatch carries `getSessionId` returning
   * the frame's thread, so the persistent brush Shell is pinned per thread
   * and concurrent frames cannot bleed each other's key. Built once in
   * createToolHost (the class is captured there — omp loads lazily).
   */
  bashView: (sessionKey: string) => OmpTool;
  /**
   * Per-cwd host view (T20 #110): omp tools rebuilt against a session
   * clone whose cwd is the isolated workspace — same settings, artifacts,
   * and agentDir, different path resolution. Cached per resolved cwd;
   * sessions are few (one per isolated child), so the map stays small.
   */
  viewFor(cwd: string): ToolHost;
}

/**
 * Host settings overrides (agent enablement + policy pins):
 * - `autolearn.enabled` (T6 #96) admits omp's own ManageSkillTool.createIf
 *   gate — the same flag omp checks, pinned host-side in the isolated
 *   settings (no daemon capability negotiation, control-plane §1.2).
 * - `security.enabled` is deliberately NOT pinned (#522, user ruling
 *   2026-10-08): omp's default-off gate keeps security_scan out of the tool
 *   map — the host face stays disabled until a revival ruling (#507).
 * - `tools.maxTimeout` (T9 #99 shim 1): omp's bash clamps 1–3600 s natively;
 *   the 600 s pin restores the M0 ceiling the wire schema promises
 *   (registry bashSchema: "nonzero values are clamped to 1-600"). Probe
 *   docs/research/bash-embedding-probe.md delta row "timeout clamp".
 */
const HOST_SETTINGS_OVERRIDES: Record<string, unknown> = {
  "autolearn.enabled": true,
  "tools.maxTimeout": 600,
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
 * Host constructions are serialized process-wide (#290 C4): every host —
 * base and per-workspace alike — installs the SHARED daemon-private
 * agentDir's models.yml (installAgentAuth) and re-pins the process-global
 * agent-dir resolver (setAgentDir). The pins are value-idempotent (one
 * agentDir per process), but concurrent constructions would interleave the
 * file writes; one-at-a-time keeps the discipline the single base host has
 * always run under. The chain never poisons: a failed build must not block
 * later workspaces.
 */
let hostBuildChain: Promise<unknown> = Promise.resolve();
function serializedHostBuild<T>(build: () => Promise<T>): Promise<T> {
  const built = hostBuildChain.then(build);
  hostBuildChain = built.catch(() => undefined);
  return built;
}

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
  agentAuth: AgentAuthConfig | null = null,
): Promise<ToolHost> {
  // Agent-dir isolation (T6 #96): process-global omp paths — the
  // managed-skills store (getManagedSkillsDir → getAgentDir()), auth,
  // session-index db — must resolve under the daemon-private directory, not
  // the operator's ~/.omp. Setting the env var alone is a NO-OP once the
  // resolver has frozen (the static Settings import above already froze it):
  // getAgentDir() kept serving the pre-pin default (~/.omp/agent), so
  // manage_skill wrote skills outside the sandbox (#182). setAgentDir
  // rebuilds the live resolver — and re-pins the env var — so every later
  // getAgentDir() read resolves under agentDir. It stays BEFORE the dynamic
  // imports below: on a cold process those specifiers load the resolver, and
  // the daemon-private dir must be the baseline by the time anything reads it.
  // (Dynamic, not static: pi-utils/dirs loads the native addon, and the addon
  // version gate must run before ANY omp import — a static specifier here
  // would crash the process on a stale addon before the gate can refuse it.)
  const { setAgentDir } = await import("@oh-my-pi/pi-utils/dirs");
  setAgentDir(agentDir);
  // Static imports cannot work here: omp's module graph freezes the
  // process-global agent-dir resolver at load time (pi-utils dirs.ts module
  // init), and the daemon-private agentDir is a runtime config value — the
  // re-point above must land BEFORE these specifiers evaluate.
  const [
    { Settings },
    { ArtifactManager },
    { EditTool },
    { FindTool },
    { GlobTool },
    { GrepTool },
    { ReadTool },
    { WriteTool },
    { ManageSkillTool },
    { BashTool },
    { SecurityScanTool },
    { cfgSecurityEnabled },
  ] = await Promise.all([
    import("@oh-my-pi/pi-coding-agent/config/settings"),
    import("@oh-my-pi/pi-coding-agent/session/artifacts"),
    import("@oh-my-pi/pi-coding-agent/edit"),
    import("@oh-my-pi/pi-coding-agent/tools/jfind"),
    import("@oh-my-pi/pi-coding-agent/tools/glob"),
    import("@oh-my-pi/pi-coding-agent/tools/grep"),
    import("@oh-my-pi/pi-coding-agent/tools/read"),
    import("@oh-my-pi/pi-coding-agent/tools/write"),
    import("@oh-my-pi/pi-coding-agent/tools/manage-skill"),
    import("@oh-my-pi/pi-coding-agent/tools/bash"),
    import("@oh-my-pi/pi-coding-agent/tools/security-scan"),
    import("@oh-my-pi/pi-coding-agent/tools/settings"),
  ]);
  // #145: the judge role pins the provider channel the find cascade
  // resolves through (deployment-time input; the model-facing schemas stay
  // omp-verbatim).
  const settings = await Settings.loadIsolated({
    cwd,
    agentDir,
    overrides: agentAuth?.judgeRole
      ? { ...HOST_SETTINGS_OVERRIDES, "modelRoles.judge": agentAuth.judgeRole }
      : HOST_SETTINGS_OVERRIDES,
  });
  // #145: materialize the provider channel into the daemon-private agentDir
  // (models.yml is the canonical omp custom-provider config — baseUrl +
  // apiKey + models land there), then build the ModelRegistry over the
  // agent-dir auth store. find's ChainJudge resolves through this registry;
  // without it every find degrades with "find has no model registry".
  await installAgentAuth(agentDir, agentAuth);
  const [{ discoverAuthStorage }, { ModelRegistry }] = await Promise.all([
    import("@oh-my-pi/pi-coding-agent/session/auth-broker-config"),
    import("@oh-my-pi/pi-coding-agent/config/model-registry"),
  ]);
  // Explicit agentDir: the local SQLite store (<agentDir>/agent.db) — never
  // the operator's ~/.omp credentials.
  const authStorage = await discoverAuthStorage(agentDir);
  // modelsPath is EXPLICIT: the registry's default resolves getAgentDir(),
  // which is frozen at the first omp import (the static Settings import at
  // this module's top — before the PI_CODING_AGENT_DIR pin lands) and would
  // silently read the operator's ~/.omp/models.yml instead of the
  // daemon-private one.
  const modelRegistry = new ModelRegistry(authStorage, join(agentDir, "models.yml"), { settings });
  await modelRegistry.refresh();
  for (const [provider, apiKey] of Object.entries(agentAuth?.runtimeKeys ?? {})) {
    authStorage.keys.setRuntime(provider, apiKey);
  }
  // T9 #99 shim 3 (artifact allocator): omp's OutputSink middle-truncates
  // inline output at 50 KiB; the full bytes are recoverable only when the
  // session allocates artifacts. omp's own ArtifactManager (numeric ids,
  // `<id>.<tool>.log` staging, atomic publish) backs a daemon-private
  // artifacts dir, and `getArtifactsDir` pins `artifact://<id>` resolution —
  // the embedded read tool recovers the spill end to end. Probe #14: with
  // no allocator the elided bytes are silently gone.
  const artifacts = new ArtifactManager(join(agentDir, "artifacts"));
  const sessionBase = {
    cwd,
    hasUI: false,
    settings,
    // #145: the judge channel. FindTool resolves `resolveJudge` from
    // here; absent, every find dies with "find has no model registry".
    modelRegistry,
    // The host credential registry: runtimeKeys install at top cascade
    // precedence (the judge chain resolves provider keys through the
    // registry's copy). Credentials stay on the daemon host; nothing
    // auth-shaped crosses the dispatch frame.
    authStorage,
    getSessionFile: () => null,
    getSessionSpawns: () => null,
    getArtifactsDir: () => artifacts.dir,
    allocateOutputArtifact: (toolType: string) => artifacts.allocatePath(toolType),
  };
  // Tool assembly is parameterized by cwd so isolation views (T20) rebuild
  // the same candidate set against a session clone rooted in the workspace
  // copy — omp tools capture `session.cwd` at construction.
  const buildTools = (
    sessionCwd: string,
  ): { tools: Record<string, OmpTool>; bashView: (sessionKey: string) => OmpTool } => {
    const viewBase = { ...sessionBase, cwd: sessionCwd };
    const session = viewBase as never;
    const candidates: OmpTool[] = [
      new GlobTool(session),
      new GrepTool(session),
      // T11 (#101) + #145: the judge role resolves through the
      // session's model registry (always wired — see the auth block above);
      // with NO credential configured the chain resolves to zero candidates
      // and find degrades with "judgment: no judge model available".
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
    // security_scan rides omp's own enablement gate (security.enabled —
    // #522 dropped the daemon pin, so omp's default-off closes the gate and
    // the tool is absent from the map, same as manage_skill).
    if (cfgSecurityEnabled.get(settings)) {
      const securityScan = new SecurityScanTool(session);
      tools[securityScan.name] = securityScan;
    }
    const bashView = (sessionKey: string): OmpTool =>
      new BashTool({ ...viewBase, getSessionId: () => sessionKey });
    return { tools, bashView };
  };
  const baseTools = buildTools(cwd);
  // Per-cwd view cache (T20 #110) — closed over, never on the host object;
  // sessions are few (one per isolated child), so the map stays small.
  const viewCache = new Map<string, ToolHost>();
  const viewFor = (viewCwd: string): ToolHost => {
    const resolved = resolve(viewCwd);
    const cached = viewCache.get(resolved);
    if (cached !== undefined) return cached;
    const built = buildTools(resolved);
    const view: ToolHost = {
      machineId,
      workspaceRoot: resolved,
      settings,
      // The view session keeps the base's session-file/artifact bindings
      // but resolves paths in the isolation workspace (omp tools read cwd).
      session: { ...sessionBase, cwd: resolved },
      tools: built.tools,
      artifactsRoot: artifacts.dir,
      bashView: built.bashView,
      // Views do not nest: an isolated workspace is a plain directory, so
      // every view shares the same resolver.
      viewFor,
    };
    viewCache.set(resolved, view);
    return view;
  };
  const host: ToolHost = {
    machineId,
    workspaceRoot: cwd,
    settings,
    session: sessionBase,
    tools: baseTools.tools,
    artifactsRoot: artifacts.dir,
    bashView: baseTools.bashView,
    viewFor,
  };
  return host;
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

/**
 * Bash-specific frame preparation (T9 #99 shims 2 + sessionKey pin). The
 * embedded brush shell has no sandbox-root concept (probe delta row "cwd"):
 * the wrapper restores M0's cwd-level confinement — resolve against the
 * workspace root, refuse escapes, hand the tool an absolute path. The
 * dispatch deadline is mapped onto bash's `timeout` seconds parameter so an
 * omitted per-call timeout resolves to the agent-DO policy deadline (M0's
 * 600 s default), not omp's 300 s. The persistent Shell is keyed per thread
 * (probe: "pin one sessionKey per machine/thread to keep isolation
 * intentional") — a fresh per-frame session view carries the thread id so
 * concurrent frames cannot bleed each other's session key.
 */
function prepareBashFrame(
  host: ToolHost,
  frame: ToolDispatchFrame,
): { arguments: Record<string, unknown>; sessionKey: string } | { error: string } {
  const args = { ...frame.arguments };
  const rawCwd = args.cwd;
  if (typeof rawCwd === "string" && rawCwd.length > 0) {
    if (isAbsolute(rawCwd) || rawCwd.split(/[\\/]/).includes("..")) {
      return { error: `cwd escapes the sandbox root: ${rawCwd}` };
    }
    const resolved = resolve(host.workspaceRoot, rawCwd);
    if (resolved !== host.workspaceRoot && !resolved.startsWith(host.workspaceRoot + sep)) {
      return { error: `cwd escapes the sandbox root: ${rawCwd}` };
    }
    args.cwd = resolved;
  }
  const timeoutSec = Math.round(frame.timeoutMs / 1000);
  if (frame.timeoutMs > 0 && timeoutSec > 0 && args.timeout === undefined) {
    args.timeout = timeoutSec;
  }
  return { arguments: args, sessionKey: threadIdFromExecutionId(frame.executionId) };
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
  let tool = host.tools[frame.tool];
  let argumentsJson = frame.arguments;
  if (frame.tool === "bash") {
    // T9 #99: bash executes through omp's BashTool with the four shims from
    // docs/research/bash-embedding-probe.md (verdict (b) embed-with-shims):
    // (1) tools.maxTimeout=600 pin lives in the isolated settings; (2) the
    // cwd sandbox guard + timeout default mapping below; (3) the
    // allocateOutputArtifact wiring on the host session; (4) kill = abort —
    // exec.kill reaches ToolRuntime.abort (connection.ts), and the pid
    // kill-list is superseded: the brush shell IS the host process (probe:
    // /proc/$$/exe = bun), so there is no child pid to record and no
    // cross-restart verify-and-kill exists — in-flight externals die with
    // the run's AbortController, same-group stragglers die with the client
    // process, and setsid escapees stay the operator's business, same as M0
    // post-restart minus verify-and-kill.
    const prepared = prepareBashFrame(host, frame);
    if ("error" in prepared) {
      return { status: "error", exitCode: null, output: prepared.error };
    }
    tool = host.bashView(prepared.sessionKey);
    argumentsJson = prepared.arguments;
  }
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
      argumentsJson,
      controller.signal,
      options.onOutput ? (partial) => options.onOutput?.(contentText(partial)) : undefined,
    );
    const details = result.details as BashToolDetails | undefined;
    const truncation = details?.meta?.truncation;
    // Bash exit code (T9 #99, M0 propagation): omp sets details.exitCode only
    // for non-zero exits (bash.ts:732 failedExit); a definite 0 exit omits the
    // field — an ok result without a code IS the 0 exit (bash throws on a
    // missing exit status, bash.ts:682). Errors without a code (timeout,
    // cancel) carry null.
    const exitCode =
      typeof details?.exitCode === "number" ? details.exitCode : result.isError ? null : 0;
    // Recovery footer (shim 3): 18.6.0 records the spill id in
    // meta.truncation.artifactId without a text pointer — project the probe's
    // `artifact://<id>` footer so the truncated bytes are wire-discoverable.
    let output = contentText(result);
    const spillId: unknown =
      typeof truncation === "object" && truncation !== null && "artifactId" in truncation
        ? truncation.artifactId
        : undefined;
    const artifactId =
      typeof spillId === "string" || typeof spillId === "number" ? String(spillId) : null;
    if (artifactId !== null && !output.includes(`artifact://${artifactId}`)) {
      output += `\n[raw output: artifact://${artifactId}]\n`;
    }
    return {
      status: result.isError ? "error" : "ok",
      exitCode,
      output,
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

/** One registered workspace (#290 C2): the bound root plus its lazily built
 * first-class host (bb ensureEnvironment anchor: per-environment runtime). */
interface WorkspaceBinding {
  path: string;
  hostPromise: Promise<ToolHost> | null;
}

export interface ToolRuntimeConfig {
  /** Workspace root — the cwd every host tool resolves against. */
  workspaceRoot: string;
  /** Daemon-private settings directory (dataDir/omp-agent). */
  agentDir: string;
  machineId: string;
  /** T20 #110 isolation policy (omp defaults; DAEMON_TASK_ISOLATION patch). */
  taskIsolation: TaskIsolationConfig;
  /** #145 provider channel (DAEMON_AGENT_AUTH; null = agentDir only). */
  agentAuth: AgentAuthConfig | null;
}

export class ToolRuntime {
  private host: ToolHost | null = null;
  private hostPromise: Promise<ToolHost> | null = null;
  /** Eval kernel seam (T10' #100) — lazily constructed, shares this config. */
  private evalRuntime: EvalKernelRuntime | null = null;
  /** Task isolation backend (T20 #110) — lazily constructed over the host. */
  private isolation: IsolationManager | null = null;
  /** Live runs by executionId (abort handle + idempotent re-forward answer). */
  readonly running = new Map<string, RunningTool>();
  /** Registered workspaces by id (#290 C2 — bb ensureEnvironment anchor). */
  private readonly workspaces = new Map<string, WorkspaceBinding>();

  constructor(private readonly config: ToolRuntimeConfig) {}

  /** Builds the host once; the version gate runs first (refuse start). */
  ensureHost(): Promise<ToolHost> {
    this.hostPromise ??= (async () => {
      assertNativeAddonCurrent(await readNativeAddonStatus());
      return serializedHostBuild(() =>
        createToolHost(
          this.config.workspaceRoot,
          this.config.agentDir,
          this.config.machineId,
          this.config.agentAuth,
        ),
      );
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
    const done = this.ensureHost().then(async (baseHost) => {
      // #290 C1/C2: a frame-declared workspace routes to its first-class
      // host (per-workspace createToolHost — per-project settings by cwd).
      // Drift and unknown paths fail as STRUCTURED ERROR RESULTS (C3, the
      // mis-route guard's shape): the service DO's waiter resolves only on
      // tool.exited, so a rejected dispatch would hang the run to timeout.
      // Isolation sessions stay sandbox-scoped (isolationOp carries no
      // workspace leg), so workspace frames bypass the isolation manager.
      if (frame.workspace !== undefined) {
        const bound = this.bindWorkspace(frame.workspace);
        if ("error" in bound) {
          return { status: "error" as const, exitCode: null, output: bound.error };
        }
        const host = await this.workspaceHost(bound.binding);
        return frame.tool === "eval"
          ? (this.evalRuntime ??= new EvalKernelRuntime(this.config)).execute(host, frame, {
              onOutput,
              cancelSignal: controller.signal,
            })
          : executeDispatch(host, frame, { onOutput, cancelSignal: controller.signal });
      }
      // T20 #110: reserved isolation verbs route to the manager; every other
      // frame resolves against the thread's isolation view when its child is
      // workspace-isolated, else the base host.
      this.isolation ??= new IsolationManager(baseHost, this.config.taskIsolation);
      const isolation = this.isolation;
      // Prefix-less executionIds (test rigs) have no thread leg; the raw id
      // then never matches a session key and routing falls to the base host.
      const frameThreadId = frame.executionId.includes(":")
        ? threadIdFromExecutionId(frame.executionId)
        : frame.executionId;
      const routedHost = isolation.hostFor(frameThreadId) ?? baseHost;
      return isolation.execute(frame).then(
        (handled) =>
          handled ??
          (frame.tool === "eval"
            ? (this.evalRuntime ??= new EvalKernelRuntime(this.config)).execute(routedHost, frame, {
                onOutput,
                cancelSignal: controller.signal,
              })
            : executeDispatch(routedHost, frame, { onOutput, cancelSignal: controller.signal })),
      );
    });
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

  /**
   * Sync binding resolution — runs on EVERY workspace-tagged frame before
   * any host/spawn work. A registered id with a different path is an
   * explicit mismatch (C3, bb `workspace_type_mismatch` anchor: "Loaded
   * environment X is bound to A, not B" — never a silent re-route); a fresh
   * id registers only once the path proves an existing directory (bb
   * unmanaged semantics: validate an existing path, never provision).
   */
  private bindWorkspace(
    ref: WorkspaceRef,
  ): { root: string; binding: WorkspaceBinding } | { error: string } {
    const path = resolve(ref.path);
    const existing = this.workspaces.get(ref.id);
    if (existing !== undefined) {
      if (existing.path !== path) {
        return {
          error: `workspace_type_mismatch: workspace ${ref.id} is bound to ${existing.path}, not ${path}`,
        };
      }
      return { root: path, binding: existing };
    }
    if (!existsSync(path) || !statSync(path).isDirectory()) {
      return { error: `workspace_not_found: ${path}` };
    }
    const binding: WorkspaceBinding = { path, hostPromise: null };
    this.workspaces.set(ref.id, binding);
    log(`workspace ${ref.id} registered at ${path}`);
    return { root: path, binding };
  }

  /** Public sync face for the exec.spawn path — root only, no host work. */
  resolveWorkspaceRoot(ref: WorkspaceRef): { root: string } | { error: string } {
    const bound = this.bindWorkspace(ref);
    return "error" in bound ? bound : { root: bound.root };
  }

  /**
   * Per-workspace host (C2): a full createToolHost per registered path.
   * Distinct workspaces are distinct projects, so each loads its own
   * project settings by cwd — unlike the T20 viewFor, which shares the base
   * settings for same-project worktrees. The shared agentDir keeps every
   * setAgentDir pin value-idempotent and the frozen omp resolver correct
   * (C4 audit: one daemon-private agentDir per process; eval kernels key
   * their module-level registries by cwd, so per-workspace cells stay
   * apart while EvalKernelRuntime stays one per process, deterministically
   * seeded from the sandbox root).
   */
  private workspaceHost(binding: WorkspaceBinding): Promise<ToolHost> {
    binding.hostPromise ??= serializedHostBuild(() =>
      createToolHost(
        binding.path,
        this.config.agentDir,
        this.config.machineId,
        this.config.agentAuth,
      ),
    );
    return binding.hostPromise;
  }
}
