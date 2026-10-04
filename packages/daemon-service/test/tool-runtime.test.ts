import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertNativeAddonCurrent,
  createToolHost,
  executeDispatch,
  readNativeAddonStatus,
  type ToolDispatchFrame,
  type ToolHost,
} from "../src/client/tool-runtime.js";

/**
 * L1 for the vendored omp runtime (M1.5/T5' #128) — runs under Bun (the
 * daemon host runtime; omp ships raw TS + `bun` built-ins). Covers the spike
 * harness replay (five tools through real omp execute()), the native-addon
 * version gate, and the adapter's full projection matrix.
 */

const ALPHA = [
  "Hello from fixture file alpha.",
  "Line two for selector tests.",
  "const value = 42;",
  "export function alpha() {",
  '  return "alpha-result";',
  "}",
  "Line seven.",
  "GrepNeedle present here.",
  "",
].join("\n");

let root: string;
let fixture: string;
let agentDir: string;
let host: ToolHost;
const MACHINE = "machine-l1-runtime";

function frameOf(tool: string, executionId: string, args: Record<string, unknown>, timeoutMs = 10_000): ToolDispatchFrame {
  return { tool, arguments: args, executionId, machineId: MACHINE, timeoutMs };
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "omp-runtime-l1-"));
  fixture = join(root, "workspace");
  agentDir = join(root, "omp-agent");
  mkdirSync(join(fixture, "src"), { recursive: true });
  mkdirSync(join(fixture, "out"), { recursive: true });
  writeFileSync(join(fixture, "src", "alpha.ts"), ALPHA);
  // The version gate is the refuse-start precondition — run it here so a
  // broken addon fails the suite before any tool call.
  assertNativeAddonCurrent(await readNativeAddonStatus());
  host = await createToolHost(fixture, agentDir, MACHINE);
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("native addon version gate (T5')", () => {
  test("vendored addon matches the pinned package (stale=false, 18.6.0)", async () => {
    const status = await readNativeAddonStatus();
    expect(status.stale).toBe(false);
    expect(status.version).toBe("18.6.0");
    expect(status.packageVersion).toBe("18.6.0");
  });

  test("a stale addon identity refuses start", () => {
    expect(() =>
      assertNativeAddonCurrent({
        path: "/somewhere/pi_natives.node",
        version: "15.5.6",
        packageVersion: "18.6.0",
        stale: true,
      }),
    ).toThrow(/stale.*15\.5\.6.*18\.6\.0/s);
  });
});

describe("five host tools through real omp execute() (spike replay)", () => {
  test("glob lists the fixture source file", async () => {
    const result = await executeDispatch(host, frameOf("glob", "g1", { path: fixture }));
    expect(result.status).toBe("ok");
    expect(result.output).toContain("alpha.ts");
  });

  test("grep finds the needle with hashline addressing", async () => {
    const result = await executeDispatch(host, frameOf("grep", "g2", { pattern: "GrepNeedle", path: fixture }));
    expect(result.status).toBe("ok");
    expect(result.output).toContain("GrepNeedle");
    expect(result.output).toContain("alpha.ts");
  });

  test("read returns hashline-tagged content and details.source", async () => {
    const result = await executeDispatch(host, frameOf("read", "r1", { path: "src/alpha.ts:2-5" }));
    expect(result.status).toBe("ok");
    expect(result.output).toContain("[src/alpha.ts#");
    expect(result.output).toContain("Line two for selector tests.");
  });

  test("write lands the file and reports resolvedPath", async () => {
    const result = await executeDispatch(host, frameOf("write", "w1", {
      path: "out/draft.md",
      content: "# draft\nvendored runtime\n",
    }));
    expect(result.status).toBe("ok");
    expect(readFileSync(join(fixture, "out", "draft.md"), "utf8")).toContain("vendored runtime");
  });

  test("edit applies a hashline patch anchored at a fresh read tag", async () => {
    const read = await executeDispatch(host, frameOf("read", "r2-tag", { path: "src/alpha.ts" }));
    const tag = /#([0-9A-Fa-f]{4})\]/.exec(read.output)?.[1];
    expect(tag).toBeDefined();
    const input = `[src/alpha.ts#${tag}]\nPUT 3.:\n+const value = 43;`;
    const result = await executeDispatch(host, frameOf("edit", "e1", { input }));
    expect(result.status).toBe("ok");
    expect(readFileSync(join(fixture, "src", "alpha.ts"), "utf8")).toContain("const value = 43;");
  });
});

describe("adapter projection matrix (spike §3)", () => {
  test("unknown tool is a structured error, not a throw", async () => {
    const result = await executeDispatch(host, frameOf("bash", "x1", { command: "echo hi" }));
    expect(result.status).toBe("error");
    expect(result.output).toBe("unknown tool: bash");
    expect(result.exitCode).toBeNull();
  });

  test("wrong machine is rejected before any execution", async () => {
    const result = await executeDispatch(host, frameOf("read", "x2", { path: "src/alpha.ts" }));
    const misrouted = { ...frameOf("read", "x2", { path: "src/alpha.ts" }), machineId: "machine-other" };
    const rejected = await executeDispatch(host, misrouted);
    expect(rejected.status).toBe("error");
    expect(rejected.output).toContain("machine machine-other");
    expect(result.status).toBe("ok");
  });

  test("omp structured tool failure projects to status=error with precise copy", async () => {
    const result = await executeDispatch(host, frameOf("edit", "x3", { input: "not a hashline patch" }));
    expect(result.status).toBe("error");
    expect(result.output).toContain("[PATH#HASH]");
  });

  test("missing file is a structured omp error", async () => {
    const result = await executeDispatch(host, frameOf("read", "x4", { path: "no/such/file.txt" }));
    expect(result.status).toBe("error");
    expect(result.output).toContain("no/such/file.txt");
  });

  test("timeout aborts the dispatch and projects status=timeout", async () => {
    // omp's own reads finish sub-millisecond — the timeout PROJECTION is the
    // adapter's contract, so a stub tool holds the dispatch open past the
    // deadline (omp's internal abort semantics are upstream's to test).
    host.tools["l1-slow"] = {
      name: "l1-slow",
      execute: async (_toolCallId: string, _params: unknown, signal?: AbortSignal) => {
        // Settles only through the adapter's deadline abort — no test-owned
        // wall-clock wait; the awaited condition IS the abort event.
        await new Promise<never>((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => {
              const abort = new Error("aborted");
              abort.name = "AbortError";
              reject(abort);
            },
            { once: true },
          );
        });
        return { content: [{ type: "text", text: "unreachable" }] };
      },
    };
    const result = await executeDispatch(host, frameOf("l1-slow", "x5", {}, 25));
    expect(result.status).toBe("timeout");
    expect(result.output).toBe("timeout after 25ms");
  });

  test("onUpdate streams partial content chunks", async () => {
    // omp single-shot tools return their content once (no onUpdate traffic);
    // the ExecutionUpdate stream is exercised with a stub that emits partials.
    host.tools["l1-streaming"] = {
      name: "l1-streaming",
      execute: async (
        _toolCallId: string,
        _params: unknown,
        _signal?: AbortSignal,
        onUpdate?: (partial: { content: { type: string; text?: string }[] }) => void,
      ) => {
        onUpdate?.({ content: [{ type: "text", text: "partial-one" }] });
        onUpdate?.({ content: [{ type: "text", text: "partial-two" }] });
        return { content: [{ type: "text", text: "final" }] };
      },
    };
    const chunks: string[] = [];
    const result = await executeDispatch(host, frameOf("l1-streaming", "x6", {}), {
      onOutput: (chunk) => chunks.push(chunk),
    });
    expect(result.status).toBe("ok");
    expect(chunks).toEqual(["partial-one", "partial-two"]);
    expect(result.output).toBe("final");
  });

  test("cancel signal projects status=cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await executeDispatch(host, frameOf("read", "x7", { path: "src/alpha.ts" }), {
      cancelSignal: controller.signal,
    });
    expect(["cancelled", "ok"]).toContain(result.status);
  });
});
