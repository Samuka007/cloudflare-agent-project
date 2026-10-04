import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { disposeAllKernelSessions } from "@oh-my-pi/pi-coding-agent/eval/py/executor";
import { disposeAllVmContexts } from "@oh-my-pi/pi-coding-agent/eval/js/context-manager";
import {
  assertNativeAddonCurrent,
  createToolHost,
  type ToolDispatchFrame,
  type ToolHost,
  ToolRuntime,
  readNativeAddonStatus,
} from "../src/client/tool-runtime.js";
import { EvalKernelRuntime, evalSessionIdFromExecutionId } from "../src/client/eval-kernel.js";

/**
 * L1 for the eval kernel seam (M1.5/T10' #100) — runs under Bun (the omp eval
 * library ships raw TS + `bun` built-ins). Covers the card's acceptance set:
 * py framed-IPC kernel + js worker VM through the vendored kernel-management
 * path, IdleTimeout watchdog (0 disables), host-persistent kernels with
 * handle re-attach across a simulated DO eviction (zero second spawn),
 * destructive cancel, artifact-sink spill + sink-failure finalize.
 *
 * Anchor table: src/client/eval-kernel.ts (bottom) maps every seam point to
 * its omp @oh-my-pi 18.6.0 source line.
 */

const MACHINE = "machine-l1-eval";
const THREAD = "thread-eval-l1";

/**
 * Bounded poll awaiting a real condition (kernel liveness converges
 * asynchronously: omp kills cancelled JS workers fire-and-forget). Awaits the
 * actual state transition, never a guessed fixed delay.
 */
async function expectKernelGone(
  runtime: EvalKernelRuntime,
  host: ToolHost,
  executionId: string,
  language: "py" | "js",
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (!(await runtime.peekKernel(host, executionId, language)).alive) return;
    await Bun.sleep(10);
  }
  throw new Error(`kernel ${executionId} (${language}) still alive after cancel`);
}

let root: string;
let fixture: string;
let agentDir: string;
let host: ToolHost;
let runtime: EvalKernelRuntime;

function frameOf(
  seq: number,
  args: Record<string, unknown>,
  timeoutMs = 30_000,
): ToolDispatchFrame {
  return {
    tool: "eval",
    arguments: args,
    executionId: `${THREAD}:${seq}`,
    machineId: MACHINE,
    timeoutMs,
  };
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "omp-eval-l1-"));
  fixture = join(root, "workspace");
  agentDir = join(root, "omp-agent");
  mkdirSync(fixture, { recursive: true });
  // The version gate is the refuse-start precondition (T5' discipline).
  assertNativeAddonCurrent(await readNativeAddonStatus());
  host = await createToolHost(fixture, agentDir, MACHINE);
  runtime = new EvalKernelRuntime({ workspaceRoot: fixture, agentDir, machineId: MACHINE });
});

afterAll(async () => {
  // Kernels detach into their own process group (omp spawn-options) — dispose
  // through omp's own shutdown path so the test process can exit.
  await disposeAllKernelSessions();
  await disposeAllVmContexts();
  rmSync(root, { recursive: true, force: true });
});

describe("py kernel: framed IPC through the vendored management path", () => {
  test("cells execute over the NDJSON kernel and state persists across calls", async () => {
    const setCell = await runtime.execute(
      host,
      frameOf(1, { language: "py", code: "state_x = 41\nprint('set')" }),
    );
    expect(setCell.status).toBe("ok");
    expect(setCell.output).toBe("set");
    const readCell = await runtime.execute(
      host,
      frameOf(2, { language: "py", code: "print(state_x + 1)" }),
    );
    expect(readCell.status).toBe("ok");
    // Same retained kernel: a per-call subprocess could never see state_x.
    expect(readCell.output).toBe("42");
  });

  test("session identity is the thread-id seam (stable under DO eviction)", () => {
    expect(evalSessionIdFromExecutionId(`${THREAD}:99`)).toBe(`eval:${THREAD}`);
  });

  test("DO-eviction replay re-attaches the host-persistent kernel without a second spawn", async () => {
    // A fresh seam instance simulates the daemon rebuilding its seam state
    // after the AgentDO was evicted: the module-level kernel registry (host
    // process state) never noticed the eviction.
    const rebuilt = new EvalKernelRuntime({ workspaceRoot: fixture, agentDir, machineId: MACHINE });
    const peek = await rebuilt.peekKernel(host, `${THREAD}:1`, "py");
    expect(peek.alive).toBe(true);
    // The namespace survived: a respawned kernel would NameError on state_x.
    const replayed = await rebuilt.execute(
      host,
      frameOf(3, { language: "py", code: "print(state_x)" }),
    );
    expect(replayed.status).toBe("ok");
    expect(replayed.output).toBe("41");
  });

  test("reset wipes the kernel namespace", async () => {
    const resetCell = await runtime.execute(
      host,
      frameOf(10, { language: "py", code: "pass", reset: true }),
    );
    expect(resetCell.status).toBe("ok");
    const wiped = await runtime.execute(
      host,
      frameOf(11, { language: "py", code: "print(state_x)" }),
    );
    expect(wiped.status).toBe("error");
    expect(wiped.output).toContain("NameError");
  });

  test("cell errors project the traceback and the omp exit line", async () => {
    const result = await runtime.execute(
      host,
      frameOf(12, { language: "py", code: "raise ValueError('boom')" }),
    );
    expect(result.status).toBe("error");
    expect(result.output).toContain("ValueError: boom");
    expect(result.output).toContain("Command exited with code 1");
  });

  test("malformed wire args land as a structured error", async () => {
    const result = await runtime.execute(
      host,
      frameOf(20, { language: "rust", code: "fn main() {}" }),
    );
    expect(result.status).toBe("error");
    expect(result.output).toContain("eval requires language");
  });
});

describe("IdleTimeout watchdog (card T10: 30s default, 0 disables, interrupt keeps kernel)", () => {
  // Real platform clock is the subject here: the watchdog lives inside the
  // vendored executor and the interrupt path reaches a live python subprocess
  // — no fake-timer seam exists below the seam under test.
  test("a hung py cell times out at the clamped budget and the kernel survives", async () => {
    const hung = await runtime.execute(
      host,
      frameOf(7, { language: "py", code: "import time\ntime.sleep(30)", timeout: 1 }),
    );
    expect(hung.status).toBe("timeout");
    // omp formatSessionTimeoutAnnotation text, verbatim.
    expect(hung.output).toBe("Command timed out after 1 seconds");
    // SIGINT interrupted the sleep, but the kernel (and its namespace) lives.
    const after = await runtime.execute(
      host,
      frameOf(8, { language: "py", code: "print('still-alive')" }),
    );
    expect(after.status).toBe("ok");
    expect(after.output).toBe("still-alive");
  }, 20_000);

  test("timeout: 0 disables the watchdog entirely", async () => {
    const slow = await runtime.execute(
      host,
      frameOf(9, {
        language: "py",
        code: "import time\ntime.sleep(2)\nprint('slow-ok')",
        timeout: 0,
      }),
    );
    expect(slow.status).toBe("ok");
    expect(slow.output).toBe("slow-ok");
  }, 20_000);
});

describe("js runtime: worker VM through the vendored management path", () => {
  test("cells run top-level-await code and state persists across calls", async () => {
    const setCell = await runtime.execute(
      host,
      frameOf(4, { language: "js", code: "globalThis.capVal = 41\nconsole.log('js-set')" }),
    );
    expect(setCell.status).toBe("ok");
    expect(setCell.output).toBe("js-set");
    const readCell = await runtime.execute(
      host,
      frameOf(5, {
        language: "js",
        code: "await Promise.resolve().then(() => { capVal += 1 })\nconsole.log(capVal)",
      }),
    );
    expect(readCell.status).toBe("ok");
    expect(readCell.output).toBe("42");
  });

  test("DO-eviction replay re-attaches the retained worker VM", async () => {
    const rebuilt = new EvalKernelRuntime({ workspaceRoot: fixture, agentDir, machineId: MACHINE });
    const peek = await rebuilt.peekKernel(host, `${THREAD}:4`, "js");
    expect(peek.alive).toBe(true);
    const replayed = await rebuilt.execute(
      host,
      frameOf(6, { language: "js", code: "console.log(capVal)" }),
    );
    expect(replayed.status).toBe("ok");
    // The retained VM carries the LATEST namespace: the previous cell already
    // incremented capVal — a respawned kernel could not see it at all.
    expect(replayed.output).toBe("42");
  });

  test("business cancel is destructive: the worker is terminated, not reused", async () => {
    const controller = new AbortController();
    // Event-driven mid-run cancel: the first streamed chunk proves the worker
    // is live; no wall-clock delay guesses (output stream = the real signal).
    const firstChunk = Promise.withResolvers<void>();
    const pending = runtime.execute(
      host,
      frameOf(15, { language: "js", code: "console.log('cancel-probe')\nawait Bun.sleep(30_000)" }),
      {
        cancelSignal: controller.signal,
        onOutput: () => firstChunk.resolve(),
      },
    );
    await firstChunk.promise;
    controller.abort();
    const result = await pending;
    expect(result.status).toBe("cancelled");
    // omp cancel semantics: JS terminates the worker — the retained VM is gone.
    await expectKernelGone(runtime, host, `${THREAD}:15`, "js");
  }, 15_000);
});

describe("artifact sink (card T10: full output to the session-domain artifact)", () => {
  test("oversized output spills to agentDir/artifacts/eval with the omp inline notice", async () => {
    const result = await runtime.execute(
      host,
      frameOf(13, { language: "js", code: `console.log('x'.repeat(200_000))` }),
    );
    expect(result.status).toBe("ok");
    expect(result.outputTruncated).toBe(true);
    expect(result.output).toContain(`[raw output: artifact://eval/${THREAD}:13]`);
    const artifactFile = join(agentDir, "artifacts", "eval", `${THREAD}:13.txt`);
    expect(existsSync(artifactFile)).toBe(true);
    // The full body (200k chars + newline) landed on the host fs.
    expect(readFileSync(artifactFile, "utf8").length).toBeGreaterThan(200_000);
  }, 15_000);

  test("a failed sink write still finalizes the cell (no throw, no phantom notice)", async () => {
    const artifactsDir = join(agentDir, "artifacts", "eval");
    chmodSync(artifactsDir, 0o500);
    try {
      const result = await runtime.execute(
        host,
        frameOf(14, { language: "js", code: `console.log('y'.repeat(200_000))` }),
      );
      // OutputSink swallowed the EACCES into artifactError; the cell settles.
      expect(result.status).toBe("ok");
      expect(result.outputTruncated).toBe(true);
      expect(result.output).not.toContain("artifact://");
    } finally {
      chmodSync(artifactsDir, 0o700);
    }
  }, 15_000);
});

describe("ToolRuntime routing (wire integration)", () => {
  test("eval frames route to the kernel seam and idempotent re-forward runs one cell", async () => {
    const toolRuntime = new ToolRuntime({ workspaceRoot: fixture, agentDir, machineId: MACHINE });
    const args = {
      language: "js",
      code: "globalThis.routeCount = (globalThis.routeCount ?? 0) + 1\nconsole.log(routeCount)",
    };
    const frame = frameOf(16, args);
    // Concurrent re-forward of the same executionId (I16 watchdog discipline).
    const [first, second] = await Promise.all([
      toolRuntime.execute(frame),
      toolRuntime.execute(frame),
    ]);
    expect(first.status).toBe("ok");
    expect(first.output).toBe("1");
    expect(second).toBe(first);
  }, 20_000);
});
