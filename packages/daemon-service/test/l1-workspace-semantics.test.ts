import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Executor } from "../src/client/executor.js";
import { ToolRuntime, type ToolDispatchFrame } from "../src/client/tool-runtime.js";
import type { WorkspaceRef } from "../src/protocol.js";

/**
 * L1 workspace semantics (#290 C1-C4) — the ticket acceptance face: the SAME
 * daemon ToolRuntime serves tool calls tagged with distinct workspace
 * bindings, and each call resolves paths in its own root (各归其位), while
 * workspace-less frames keep landing in the sandbox (backward compatible).
 * Path drift and unknown paths fail as structured error results (bb
 * workspace_type_mismatch anchor shape), never a re-route. Runs under Bun —
 * the embedded omp runtime executes only there (T5' discipline).
 */

const MACHINE = "machine-l1-ws";

let root: string;
let sandbox: string;
let wsA: string;
let wsB: string;
let agentDir: string;
let runtime: ToolRuntime;

const REF_A: WorkspaceRef = { id: "ws-a", path: "" }; // path filled in beforeAll
const REF_B: WorkspaceRef = { id: "ws-b", path: "" };

function frameOf(
  tool: string,
  executionId: string,
  args: Record<string, unknown>,
  workspace?: WorkspaceRef,
  timeoutMs = 10_000,
): ToolDispatchFrame {
  return {
    tool,
    arguments: args,
    executionId,
    machineId: MACHINE,
    timeoutMs,
    ...(workspace !== undefined ? { workspace } : {}),
  };
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "omp-ws-l1-"));
  sandbox = join(root, "sandbox");
  wsA = join(root, "ws-a");
  wsB = join(root, "ws-b");
  agentDir = join(root, "omp-agent");
  mkdirSync(sandbox, { recursive: true });
  mkdirSync(join(wsA, "sub"), { recursive: true });
  mkdirSync(wsB, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  // Settings isolation (spike §1): daemon-private agentDir, deterministic pin.
  writeFileSync(join(agentDir, "config.yml"), "fetch:\n  enabled: false\n");

  // The SAME relative path in all three roots — each frame must read ITS
  // root's copy, which is the crisp 各归其位 assertion.
  writeFileSync(join(sandbox, "note.txt"), "sandbox note\n");
  writeFileSync(join(wsA, "note.txt"), "workspace A note\n");
  writeFileSync(join(wsB, "note.txt"), "workspace B note\n");

  REF_A.path = wsA;
  REF_B.path = wsB;
  runtime = new ToolRuntime({ workspaceRoot: sandbox, agentDir, machineId: MACHINE });
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("dual workspace placement (#290 acceptance)", () => {
  // Three real host constructions (base + two workspaces) — omp imports and
  // per-workspace settings load; under `bun test --parallel` contention the
  // 5s default is not enough (tool-runtime.test.ts timeout-test precedent).
  test("tool calls tagged with distinct workspaces each read their own root", async () => {
    const viaA = await runtime.execute(frameOf("read", "thr_wsa:1", { path: "note.txt" }, REF_A));
    expect(viaA.status).toBe("ok");
    expect(viaA.output).toContain("workspace A note");
    // Same id + same path rebinds idempotently — the registration is stable.
    const viaAAgain = await runtime.execute(
      frameOf("read", "thr_wsa:2", { path: "note.txt" }, REF_A),
    );
    expect(viaAAgain.output).toContain("workspace A note");

    const viaB = await runtime.execute(frameOf("read", "thr_wsb:1", { path: "note.txt" }, REF_B));
    expect(viaB.status).toBe("ok");
    expect(viaB.output).toContain("workspace B note");
  }, 20_000);

  test("workspace-less frames keep the sandbox default (backward compatible)", async () => {
    const result = await runtime.execute(frameOf("read", "thr_wsdef:1", { path: "note.txt" }));
    expect(result.status).toBe("ok");
    expect(result.output).toContain("sandbox note");
  });

  test("writes land inside the tagged workspace, not the sandbox or a sibling", async () => {
    const result = await runtime.execute(
      frameOf("write", "thr_wsw:1", { path: "written.txt", content: "from A" }, REF_A),
    );
    expect(result.status).toBe("ok");
    expect(existsSync(join(wsA, "written.txt"))).toBe(true);
    expect(existsSync(join(sandbox, "written.txt"))).toBe(false);
    expect(existsSync(join(wsB, "written.txt"))).toBe(false);
  });

  test("bash resolves cwd against the tagged workspace root (shim 2 per workspace)", async () => {
    const pwd = await runtime.execute(frameOf("bash", "thr_wsbash:1", { command: "pwd" }, REF_A));
    expect(pwd.status).toBe("ok");
    // omp decorates bash output (Wall time footer, duplicate-line collapse)
    // — placement is asserted by path containment, the suite convention.
    expect(pwd.output).toContain(wsA);
    const sub = await runtime.execute(
      frameOf("bash", "thr_wsbash:2", { command: "pwd", cwd: "sub" }, REF_A),
    );
    expect(sub.status).toBe("ok");
    expect(sub.output).toContain(join(wsA, "sub"));
  });
});

describe("workspace binding failures (#290 C3 — bb workspace_type_mismatch anchor)", () => {
  test("same id with a drifted path fails explicitly and never re-routes", async () => {
    const drifted: WorkspaceRef = { id: REF_A.id, path: wsB };
    const result = await runtime.execute(
      frameOf("read", "thr_wsdrift:1", { path: "note.txt" }, drifted),
    );
    expect(result.status).toBe("error");
    expect(result.output).toContain("workspace_type_mismatch");
    expect(result.output).toContain(wsA);
    expect(result.output).toContain(wsB);
    // The original binding survives the refused frame — the daemon keeps
    // serving the registered path.
    const still = await runtime.execute(
      frameOf("read", "thr_wsdrift:2", { path: "note.txt" }, REF_A),
    );
    expect(still.status).toBe("ok");
    expect(still.output).toContain("workspace A note");
  });

  test("a never-registered non-existent path fails explicitly without poisoning the id", async () => {
    const ghost: WorkspaceRef = { id: "ws-ghost", path: join(root, "does-not-exist") };
    const refused = await runtime.execute(
      frameOf("read", "thr_wsghost:1", { path: "note.txt" }, ghost),
    );
    expect(refused.status).toBe("error");
    expect(refused.output).toContain("workspace_not_found");
    // The failed registration is not sticky: the same id binds once the
    // path exists.
    const realPath = join(root, "ws-ghost");
    mkdirSync(realPath, { recursive: true });
    writeFileSync(join(realPath, "note.txt"), "workspace ghost note\n");
    const bound = await runtime.execute(
      frameOf("read", "thr_wsghost:2", { path: "note.txt" }, { id: "ws-ghost", path: realPath }),
    );
    expect(bound.status).toBe("ok");
    expect(bound.output).toContain("workspace ghost note");
  });
});

describe("exec.spawn workspace root (#290 C1 — Executor level)", () => {
  test("spawn resolves cwd against the workspace root override", async () => {
    const executor = new Executor(join(root, "exec-sandbox"));
    const chunks: string[] = [];
    const entry = executor.spawn("thr_wsexec:1", "pwd", ".", (text) => chunks.push(text), wsA);
    const exited = Promise.withResolvers<void>();
    entry.child.on("close", () => exited.resolve());
    await exited.promise;
    expect(chunks.join("").trim()).toBe(wsA);
  });

  test("workspace-relative escapes refuse exactly like sandbox escapes", () => {
    const executor = new Executor(join(root, "exec-sandbox"));
    expect(() => executor.resolveCwd("..", wsA)).toThrow(/sandbox escape refused/);
    expect(() => executor.resolveCwd("/tmp", wsA)).toThrow(/sandbox escape refused/);
  });
});
