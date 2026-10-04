import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { resolve, sep } from "node:path";
import { log } from "./log.js";

/**
 * Sandbox executor (§1.3/§1.4): PTY-less bash under the sandbox root, own
 * process group (SIGTERM → 5s → SIGKILL escalation), merged stdout/stderr
 * capture into the per-execution buffer, /proc start-time recorded for the
 * kill-list pid-reuse guard (§8.5, I22).
 *
 * POC boundary note: confinement is cwd-level (resolved paths must stay in
 * the sandbox root) — bash can still address absolute paths outside; this is
 * the documented POC scope, not a security boundary.
 */

export interface ExecutedProcess {
  executionId: string;
  pid: number;
  /** Process group id (== pid: we spawn detached). */
  pgid: number;
  pidStartedAt: number;
  child: ChildProcess;
}

const PROC_STARTTIME_FIELD = 22;

export class Executor {
  private readonly processes = new Map<string, ExecutedProcess>();

  constructor(private readonly sandboxRoot: string) {
    mkdirSync(sandboxRoot, { recursive: true });
  }

  /** Resolves cwd inside the sandbox or throws on escape attempts. */
  resolveCwd(cwd: string): string {
    const root = resolve(this.sandboxRoot);
    const target = resolve(root, cwd === "" ? "." : cwd);
    if (target !== root && !target.startsWith(root + sep)) {
      throw new Error(`sandbox escape refused: ${cwd}`);
    }
    return target;
  }

  spawn(executionId: string, command: string, cwd: string, onOutput: (text: string) => void): ExecutedProcess {
    const resolved = this.resolveCwd(cwd);
    mkdirSync(resolved, { recursive: true });
    const child = spawn("bash", ["-c", command], {
      cwd: resolved,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        POC_DAEMON_MARKER: "1",
        POC_EXECUTION_ID: executionId,
        POC_SANDBOX_ROOT: this.sandboxRoot,
      },
    });
    const process_ = this.processes.get(executionId);
    if (process_ !== undefined) {
      // Stale table entry for the same executionId (watchdog re-spawn while
      // the old process lingers) — refuse rather than orphan it.
      child.kill("SIGKILL");
      throw new Error(`process table already holds ${executionId}`);
    }
    const entry: ExecutedProcess = {
      executionId,
      pid: child.pid ?? -1,
      pgid: child.pid ?? -1,
      // 0 = unknown start (proc read failed) — verification later compares
      // against the live /proc value, so unknown never authorizes a kill.
      pidStartedAt: procStartTime(child.pid ?? -1) ?? 0,
      child,
    };
    this.processes.set(executionId, entry);
    // Merged single logical stream (§8.3 M0 ruling): both pipes feed one
    // consumer in arrival order; interleaving across pipes is best-effort.
    child.stdout?.on("data", (chunk: Buffer) => onOutput(chunk.toString("utf8")));
    child.stderr?.on("data", (chunk: Buffer) => onOutput(chunk.toString("utf8")));
    child.on("error", (error) => {
      log(`exec ${executionId} spawn error: ${String(error)}`);
      onOutput(`\n[daemon-client spawn error] ${String(error)}`);
    });
    return entry;
  }

  get(executionId: string): ExecutedProcess | undefined {
    return this.processes.get(executionId);
  }

  delete(executionId: string): void {
    this.processes.delete(executionId);
  }

  entries(): ExecutedProcess[] {
    return [...this.processes.values()];
  }

  /**
   * Kill-list verification (§8.5/§I22): SIGKILL the process group only when
   * the pid exists AND its /proc start time matches the recorded value — a
   * reused pid is spared.
   */
  verifyAndKill(executionId: string, pid: number, pidStartedAt: number): boolean {
    const current = procStartTime(pid);
    if (current === null || current !== pidStartedAt) {
      log(`kill-list ${executionId}: pid ${pid} verification failed (start ${current} ≠ ${pidStartedAt}) — spared`);
      return false;
    }
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
    this.processes.delete(executionId);
    log(`kill-list ${executionId}: killed process group ${pid}`);
    return true;
  }

  /** Business kill or timeout: TERM → 5s → KILL on the process group. */
  killProcessGroup(executionId: string, escalationMs: number): void {
    const entry = this.processes.get(executionId);
    if (entry === undefined) return;
    try {
      process.kill(-entry.pgid, "SIGTERM");
    } catch {
      // already gone
    }
    setTimeout(() => {
      const still = this.processes.get(executionId);
      if (still === undefined) return;
      try {
        process.kill(-still.pgid, "SIGKILL");
      } catch {
        // already gone
      }
    }, escalationMs).unref();
  }

  forget(executionId: string): void {
    this.processes.delete(executionId);
  }
}

/** /proc/<pid>/stat field 22 = start time in clock ticks (Linux). */
function procStartTime(pid: number): number | null {
  if (pid <= 0) return null;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // The comm field can contain spaces/parens — split after its closing ")".
    const afterComm = stat.slice(stat.lastIndexOf(")") + 2);
    const fields = afterComm.split(" ");
    const value = fields[PROC_STARTTIME_FIELD - 3];
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Marker scan (§8.2): after a restart the process table is gone; the observed
 * snapshot is rebuilt by scanning /proc for our marker env — enough to
 * verify-and-kill, not enough to re-attach pipes.
 */
export function scanMarkerProcesses(): Array<{
  executionId: string;
  pid: number;
  pidStartedAt: number;
}> {
  const found: Array<{ executionId: string; pid: number; pidStartedAt: number }> = [];
  const self = process.pid;
  for (const entry of readdirSync("/proc")) {
    const pid = Number(entry);
    if (!Number.isInteger(pid) || pid === self) continue;
    try {
      const env = readFileSync(`/proc/${pid}/environ`).toString("utf8");
      if (!env.includes("POC_DAEMON_MARKER=1")) continue;
      const match = /POC_EXECUTION_ID=([^\0]+)/.exec(env);
      if (match === null) continue;
      const markerExecutionId = match[1];
      if (markerExecutionId === undefined) continue;
      const startedAt = procStartTime(pid);
      if (startedAt === null) continue;
      found.push({ executionId: markerExecutionId, pid, pidStartedAt: startedAt });
    } catch {
      // process vanished or not ours — skip
    }
  }
  return found;
}
