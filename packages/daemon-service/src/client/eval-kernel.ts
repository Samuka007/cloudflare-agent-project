import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  EVAL_TIMEOUT_PAUSE_OP,
  EVAL_TIMEOUT_RESUME_OP,
} from "@oh-my-pi/pi-coding-agent/eval/bridge-timeout";
import { resolveEvalUrlRoots } from "@oh-my-pi/pi-coding-agent/eval/backend";
import { IdleTimeout } from "@oh-my-pi/pi-coding-agent/eval/idle-timeout";
import { prepareEvalSource } from "@oh-my-pi/pi-coding-agent/eval/input";
import { namespaceSessionId as namespacePySession } from "@oh-my-pi/pi-coding-agent/eval/py/index";
import {
  executePython,
  snapshotPythonNamespaceIfPresent,
} from "@oh-my-pi/pi-coding-agent/eval/py/executor";
import { namespaceSessionId as namespaceJsSession } from "@oh-my-pi/pi-coding-agent/eval/js/index";
import { executeJs } from "@oh-my-pi/pi-coding-agent/eval/js/executor";
import { snapshotVmContext } from "@oh-my-pi/pi-coding-agent/eval/js/context-manager";
import { cfgPythonInterpreter, cfgPythonKernelMode } from "@oh-my-pi/pi-coding-agent/eval/settings";
import { clampTimeout } from "@oh-my-pi/pi-coding-agent/tools/tool-timeouts";
import { cfgToolsMaxTimeout } from "@oh-my-pi/pi-coding-agent/tools/settings";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolDispatchFrame, ToolExecutionResult, ToolHost } from "./tool-runtime.js";
import { threadIdFromExecutionId } from "../execution-id.js";

/**
 * Eval kernel seam (M1.5/T10' #100): routes `{tool: "eval"}` dispatch frames
 * into the vendored omp kernel library — the Python framed-IPC kernel
 * (`executePython` → `sessionRegistry.executeOnSession` → NDJSON over the
 * runner.py subprocess stdio) and the JS worker-VM runtime (`executeJs` →
 * `executeInVmContext`) — through the embedded runtime's kernel-management
 * path. Zero kernel code lives here (spike verdict "shim": the kernel infra
 * is the vendored library, the AgentTool shell is not; anchor table at the
 * bottom of this file).
 *
 * Host persistence (card T10): kernels are keyed by
 * `(sessionId, cwd, interpreter)` inside the daemon process's module-level
 * registries — an AgentDO eviction never reaches them. The DO holds only the
 * logical handle (its thread id); after eviction + replay the frame carries
 * the same executionId → thread id → same registry key, and `peekKernel`
 * re-attaches to the live kernel without a second spawn.
 *
 * Identity seam: `evalSessionIdFromExecutionId = "eval:<threadId>"` replaces
 * omp's session-file-derived default (an AgentTool-shell binding we do NOT
 * import); `kernelOwnerId` scopes every kernel to this daemon host.
 *
 * Timeout semantics: the cell budget is `arguments.timeout` driving the omp
 * IdleTimeout — a runtime-work watchdog that pauses across bridge waits and
 * restarts a fresh window on resume (tools/eval.ts:909-920). The dispatch
 * frame's `timeoutMs` deliberately arms NO competing wall-clock timer here
 * (eval/backend.ts:22-24: "Backends MUST NOT derive a competing wall-clock
 * timer"); business cancel (`tool.cancel` → abort) forwards as the
 * destructive cancel (JS terminates the worker, py SIGINT).
 *
 * Runtime discipline (T5'): this module loads ONLY under Bun — the omp eval
 * library ships raw TS and imports `bun` built-ins.
 */

/** Wire-recognized eval arguments (omp evalSchema; the arktype row validates before dispatch). */
export interface EvalCellArgs {
  language: "py" | "js";
  code: string;
  title?: string;
  timeout?: number;
  reset?: boolean;
}

/** One cell budget: `0` disables the watchdog (omp tools/eval.ts:916-919). */
function resolveCellIdleTimeoutMs(args: EvalCellArgs, settings: Settings): number | undefined {
  if (args.timeout === 0) return undefined;
  return clampTimeout("eval", args.timeout, cfgToolsMaxTimeout.get(settings)) * 1000;
}

/** Wire-args guard: the frame schema validates the envelope, not tool payloads. */
function isEvalCellArgs(value: object): value is EvalCellArgs {
  const candidate = value as Partial<EvalCellArgs> | null;
  return (
    (candidate?.language === "py" || candidate?.language === "js") &&
    typeof candidate.code === "string"
  );
}

/**
 * Seeds omp's global settings singleton with the daemon-private directories
 * BEFORE the first kernel call. omp library internals resolve settings via
 * the memoized `Settings.init()` (executor-base.ts:446 sink budgets, js
 * package-installer auto-provision) — without this seed they would fall back
 * to the developer's `~/.omp` (spike §1 isolation warning). The five-tool
 * host uses `Settings.loadIsolated` per host; the eval library path needs the
 * global singleton because it constructs settings internally.
 */
export async function seedGlobalSettingsIsolation(
  cwd: string,
  agentDir: string,
): Promise<Settings> {
  return Settings.init({ cwd, agentDir });
}

/** Eval session identity for one dispatch frame: stable per agent thread. */
export function evalSessionIdFromExecutionId(executionId: string): string {
  return `eval:${threadIdFromExecutionId(executionId)}`;
}

export interface EvalKernelRuntimeConfig {
  /** Workspace root — the cwd cells resolve against (daemon sandbox). */
  workspaceRoot: string;
  /** Daemon-private settings/artifact directory (dataDir/omp-agent). */
  agentDir: string;
  machineId: string;
}

export class EvalKernelRuntime {
  readonly #config: EvalKernelRuntimeConfig;
  /** Session-domain artifact sink root (`artifact://eval/<executionId>` → file). */
  readonly #artifactsDir: string;
  #globalSettings: Promise<Settings> | null = null;

  constructor(config: EvalKernelRuntimeConfig) {
    this.#config = config;
    this.#artifactsDir = join(config.agentDir, "artifacts", "eval");
  }

  /** The settings-seeded eval session — the AgentTool-shell binding, seam-shaped. */
  async ensureSession(host: ToolHost, sessionId: string): Promise<Record<string, unknown>> {
    this.#globalSettings ??= seedGlobalSettingsIsolation(
      this.#config.workspaceRoot,
      this.#config.agentDir,
    );
    await this.#globalSettings;
    mkdirSync(this.#artifactsDir, { recursive: true });
    return {
      ...host.session,
      getEvalSessionId: () => sessionId,
      getEvalKernelOwnerId: () => this.kernelOwnerId,
      getArtifactsDir: () => this.#artifactsDir,
    };
  }

  get kernelOwnerId(): string {
    return `daemon:${this.#config.machineId}`;
  }

  /**
   * Executes one eval dispatch frame through the vendored kernel-management
   * path. `title` rides the schema (omp cell labeling) but the daemon wire
   * projection is text-only — no details card to label.
   */
  async execute(
    host: ToolHost,
    frame: ToolDispatchFrame,
    options: {
      onOutput?: (chunk: string) => void;
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
    const args: object = frame.arguments;
    if (!isEvalCellArgs(args)) {
      return {
        status: "error",
        exitCode: null,
        output: "eval requires language 'py'|'js' and string code",
      };
    }
    const { language, code } = args;
    const sessionId = evalSessionIdFromExecutionId(frame.executionId);
    const idleMs = resolveCellIdleTimeoutMs(args, host.settings);
    // Cancel outranks the watchdog: a business cancel must not be masked by a
    // watchdog that fires in the same window.
    const controller = new AbortController();
    const idle = idleMs === undefined ? undefined : new IdleTimeout(idleMs);
    options.cancelSignal?.addEventListener(
      "abort",
      () => {
        controller.abort();
      },
      { once: true },
    );
    const signalList: AbortSignal[] = [controller.signal];
    if (idle !== undefined) signalList.push(idle.signal);
    const combinedSignal = signalList.length === 2 ? AbortSignal.any(signalList) : signalList[0];
    const onStatus = (event: { op?: string }): void => {
      if (event.op === EVAL_TIMEOUT_PAUSE_OP) idle?.pause();
      else if (event.op === EVAL_TIMEOUT_RESUME_OP) idle?.resume();
    };
    try {
      const session = (await this.ensureSession(host, sessionId)) as never;
      const artifactPath = join(this.#artifactsDir, `${frame.executionId}.txt`);
      // %load / %bun add / %environment standalone-command resolution (omp input.ts).
      const source = await prepareEvalSource({ language, code }, session, combinedSignal);
      const result =
        language === "py"
          ? await executePython(source.code, {
              cwd: host.session.cwd as string,
              filename: source.filename,
              idleTimeoutMs: idleMs,
              signal: combinedSignal,
              sessionId: namespacePySession(sessionId),
              kernelMode: cfgPythonKernelMode.get(host.settings),
              interpreter: cfgPythonInterpreter.get(host.settings).trim() || undefined,
              artifactsDir: this.#artifactsDir,
              localRoots: resolveEvalUrlRoots(session),
              kernelOwnerId: this.kernelOwnerId,
              reset: args.reset === true,
              artifactPath,
              artifactId: `eval/${frame.executionId}`,
              onChunk: options.onOutput,
              onStatus,
            })
          : await executeJs(source.code, {
              cwd: host.session.cwd as string,
              idleTimeoutMs: idleMs,
              signal: combinedSignal,
              sessionId: namespaceJsSession(sessionId),
              kernelOwnerId: this.kernelOwnerId,
              filename: source.filename,
              packages: source.packages,
              environment: source.environment,
              reset: args.reset === true,
              artifactPath,
              artifactId: `eval/${frame.executionId}`,
              onChunk: options.onOutput,
              onStatus,
              session,
              localRoots: resolveEvalUrlRoots(session),
            });
      return this.#project(result, idle, controller.signal);
    } catch (error) {
      if (controller.signal.aborted)
        return { status: "cancelled", exitCode: null, output: "cancelled" };
      if (idle?.signal.aborted) return this.#timeoutResult(idleMs);
      const message = error instanceof Error ? error.message : String(error);
      return { status: "error", exitCode: null, output: message };
    } finally {
      idle?.dispose();
    }
  }

  #timeoutResult(idleMs: number | undefined): ToolExecutionResult {
    const seconds = Math.max(1, Math.round((idleMs ?? 0) / 1000));
    return {
      status: "timeout",
      exitCode: null,
      output: `Command timed out after ${seconds} seconds`,
    };
  }

  /**
   * omp-observable projection (single-cell form of tools/eval.ts:1057-1084):
   * cancelled or non-zero exit → error path with the verbatim "Command exited
   * with code N" line; timeout/cancel decided by the seam-armed signals (the
   * backend results carry the same facts only as output annotations); the
   * artifact sink's full-output id rides the omp inline notice shape.
   */
  #project(
    result: {
      output: string;
      exitCode: number | undefined;
      cancelled: boolean;
      truncated: boolean;
      totalBytes: number;
      outputBytes: number;
      artifactId?: string;
    },
    idle: IdleTimeout | undefined,
    cancelSignal: AbortSignal,
  ): ToolExecutionResult {
    if (idle?.signal.aborted && !cancelSignal.aborted) return this.#timeoutResult(idle.idleMs);
    if (cancelSignal.aborted || result.cancelled) {
      return { status: "cancelled", exitCode: null, output: result.output || "Command aborted" };
    }
    if (result.exitCode !== 0 && result.exitCode !== undefined) {
      return {
        status: "error",
        exitCode: null,
        output: `${result.output.trim()}\n\nCommand exited with code ${result.exitCode}`,
        ...(result.truncated ? { outputTruncated: true } : {}),
      };
    }
    const notice =
      result.artifactId !== undefined ? `\n[raw output: artifact://${result.artifactId}]` : "";
    // `truncated` reports data LOSS (artifact also failed/capped); the inline
    // body being a head/tail sample of a fully-persisted artifact is still a
    // truncated view on the wire (OutputSummary: outputBytes < totalBytes).
    const elided = result.outputBytes < result.totalBytes;
    return {
      status: "ok",
      exitCode: null,
      output: result.output.trim() + notice,
      ...(result.truncated || elided ? { outputTruncated: true } : {}),
    };
  }

  /**
   * Handle re-attach probe (card T10: "恢复经既有 announce/resume 重挂"):
   * resolves against the module-level kernel registries WITHOUT starting a
   * kernel — `alive` exactly when a live kernel exists for the frame's
   * identity. The DO-side resume path calls this before replaying a cell.
   */
  async peekKernel(
    host: ToolHost,
    executionId: string,
    language: "py" | "js",
  ): Promise<{ alive: boolean }> {
    const sessionId = evalSessionIdFromExecutionId(executionId);
    const cwd = host.session.cwd as string;
    if (language === "py") {
      const snapshot = await snapshotPythonNamespaceIfPresent({
        cwd,
        sessionId: namespacePySession(sessionId),
        kernelOwnerId: this.kernelOwnerId,
      });
      return { alive: snapshot !== null };
    }
    try {
      const snapshot = await snapshotVmContext({
        sessionKey: namespaceJsSession(sessionId),
        cwd,
        sessionId: namespaceJsSession(sessionId),
        // Bounded: a mid-cell (busy) runtime answers null, which reads as
        // "not provably alive" for the re-attach probe — the next cell would
        // still reuse the retained VM through the registry either way.
        timeoutMs: 2_000,
      });
      return { alive: snapshot !== null };
    } catch {
      // Worker died mid-probe (send/timeout failure) — not alive.
      return { alive: false };
    }
  }
}

// ---------------------------------------------------------------------------
// Anchor table (omp @oh-my-pi 18.6.0 → this seam; re-verify on version bumps)
// ---------------------------------------------------------------------------
//
// | Seam point                        | omp anchor (src/)                              | Discipline              |
// | --------------------------------- | ---------------------------------------------- | ----------------------- |
// | py cell execution                 | eval/py/executor.ts:598-612 executePython      | library call            |
// | py framed IPC (NDJSON stdio)      | eval/py/kernel.ts:1-8 + eval/kernel-base.ts    | library-internal        |
// | host-persistent py registry       | eval/py/executor.ts:384-398 sessionRegistry    | library-internal        |
// | js cell execution                 | eval/js/executor.ts:107-255 executeJs          | library call            |
// | js worker VM                      | eval/js/context-manager.ts executeInVmContext  | library-internal        |
// | IdleTimeout arm/dispose           | tools/eval.ts:916-920 (budget semantics)       | tools/eval.ts:909-915   |
// | pause/resume watchdog ops         | eval/bridge-timeout.ts:19-22                   | tools/eval.ts:962-968   |
// | cell timeout clamp, default 30s   | tools/tool-timeouts.ts:12 (eval row)           | clampTimeout("eval", …) |
// | `timeout: 0` disables watchdog    | tools/eval.ts:916-919                          | resolveCellIdleTimeoutMs|
// | sessionId identity                | tools/eval.ts:904 (getEvalSessionId fallback)  | REPLACED by thread seam |
// | kernelOwnerId                     | tools/eval.ts:886 (getEvalKernelOwnerId)       | daemon-scoped constant  |
// | artifactsDir → PI_ARTIFACTS_DIR   | eval/executor-base.ts:313-363 managed env      | getArtifactsDir seam    |
// | local:// URL roots                | eval/backend.ts:79-82 resolveEvalUrlRoots      | library call            |
// | %load/%bun add/%environment       | eval/input.ts:30-86 prepareEvalSource          | library call            |
// | error exit line                   | tools/eval.ts:1062 exitLine                    | text verbatim           |
// | cancelled output                  | tools/eval.ts:1063-1068                        | text verbatim           |
// | artifact notice                   | pi-tui streaming-output.ts:714                 | text verbatim           |
// | re-attach peek (no spawn)         | eval/py/executor.ts:545-559 +                  | library probes          |
// |                                   | eval/js/context-manager.ts:299-332             |                         |
