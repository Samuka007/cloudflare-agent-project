import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  DEFAULT_TASK_ISOLATION_CONFIG,
  ISOLATION_PREPARE_TOOL,
  ISOLATION_RELEASE_TOOL,
  decodeTaskIsolationConfig,
} from "../src/client/task-isolation.js";
import { ToolRuntime, type ToolDispatchFrame } from "../src/client/tool-runtime.js";

/**
 * L1 for the task isolation backend (M1.5/T20 #110) — runs under Bun (the
 * daemon host runtime; the vendored omp isolation machinery ships raw TS +
 * natives). Card 交付/验收 anchors:
 *   - 后端降级链：preferred backend unavailable → PAL falls back (fellBack
 *     + reason in the prepare payload), the workspace still materialises
 *     (worktree.ts:554-603 candidate loop)
 *   - 基线超限失败：captureIsolationBaseline over the snapshot budget throws
 *     IsolationBaselineTooLargeError → prepare errors BEFORE the child is
 *     driven; frames for that thread find no session (fail-before-spawn)
 *   - patch/branch 回收矩阵：patch mode applies via the canApplyPatch
 *     precheck (isolation-runner.ts:722-739); branch mode commits
 *     `omp/task/<agentId>` and cherry-picks via mergeTaskBranches
 *     (worktree.ts:929-964); apply gate closed = capture only (branch kept /
 *     patch written, source untouched); `<agentId>.patch` rescue artifact
 *     lands in both modes
 *   - keep-alive retention：the workspace survives settlement (no release) —
 *     later frames of the same child thread keep operating inside it — and
 *     an explicit release captures the post-settle delta too
 */

const MACHINE = "machine-l1-iso";

let root: string;
let workspace: string;
let agentDir: string;

function frameOf(
  tool: string,
  threadId: string,
  seq: number,
  args: Record<string, unknown>,
  timeoutMs = 120_000,
): ToolDispatchFrame {
  return {
    tool,
    arguments: args,
    executionId: `${threadId}:${seq}`,
    machineId: MACHINE,
    timeoutMs,
  };
}

function runtimeWith(patch: Partial<typeof DEFAULT_TASK_ISOLATION_CONFIG> = {}): ToolRuntime {
  return new ToolRuntime({
    workspaceRoot: workspace,
    agentDir,
    machineId: MACHINE,
    taskIsolation: { ...DEFAULT_TASK_ISOLATION_CONFIG, ...patch },
  });
}

async function prepare(
  runtime: ToolRuntime,
  threadId: string,
  agentId: string,
  patch: Record<string, unknown> = {},
): Promise<{ status: string; output: string }> {
  const result = await runtime.execute(
    frameOf(ISOLATION_PREPARE_TOOL, "th-parent", 1, { threadId, agentId, ...patch }),
  );
  return { status: result.status, output: result.output };
}

async function release(
  runtime: ToolRuntime,
  threadId: string,
  patch: Record<string, unknown> = {},
): Promise<{ status: string; output: string }> {
  const result = await runtime.execute(
    frameOf(ISOLATION_RELEASE_TOOL, "th-parent", 2, { threadId, ...patch }),
  );
  return { status: result.status, output: result.output };
}

function git(args: string, cwd: string = workspace): string {
  return execSync(`git ${args}`, { cwd, encoding: "utf8" }).trim();
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "omp-iso-l1-"));
  // OMP_WORKTREE_DIR pins the isolation slot root BEFORE any omp load
  // (settings.ts:163 worktree-base effect; getWorktreeDir resolves per call).
  process.env.OMP_WORKTREE_DIR = join(root, "wt");
  workspace = join(root, "workspace");
  mkdirSync(workspace, { recursive: true });
  git("init -q -b main");
  git('config user.email "iso-l1@example.test"');
  git('config user.name "iso-l1"');
  writeFileSync(join(workspace, "seed.txt"), "seed\n");
  git("add seed.txt");
  git("commit -q -m seed");
  agentDir = join(root, "omp-agent");
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("task isolation backend (T20 #110)", () => {
  test("config decode: env patch rides omp defaults; raising the snapshot budget is refused", () => {
    expect(decodeTaskIsolationConfig(undefined)).toEqual(DEFAULT_TASK_ISOLATION_CONFIG);
    expect(
      decodeTaskIsolationConfig(JSON.stringify({ mergeMode: "branch", applyGate: false })),
    ).toEqual({
      ...DEFAULT_TASK_ISOLATION_CONFIG,
      mergeMode: "branch",
      applyGate: false,
    });
    expect(() => decodeTaskIsolationConfig("{")).toThrow();
    expect(() =>
      decodeTaskIsolationConfig(JSON.stringify({ baselineBudgetBytes: 2 * 1024 * 1024 * 1024 })),
    ).toThrow(/lowering only/);
  });

  test("prepare materialises a workspace (PAL chain resolves); child frames execute inside it", async () => {
    const runtime = runtimeWith();
    const prepared = await prepare(runtime, "th-child-a", "Task-1");
    expect(prepared.status).toBe("ok");
    const info = JSON.parse(prepared.output) as {
      workspaceDir: string;
      backend: string;
      fellBack: boolean;
      mergeMode: string;
      applyGate: boolean;
    };
    expect(existsSync(info.workspaceDir)).toBe(true);
    expect(readFileSync(join(info.workspaceDir, "seed.txt"), "utf8")).toBe("seed\n");
    expect([
      "auto",
      "apfs",
      "btrfs",
      "zfs",
      "reflink",
      "overlayfs",
      "projfs",
      "block-clone",
      "rcopy",
    ]).toContain(info.backend);
    expect(info.mergeMode).toBe("patch");
    expect(info.applyGate).toBe(true);

    // The child's bash frame lands in the isolated workspace, NOT the source.
    const write = await runtime.execute(
      frameOf("bash", "th-child-a", 3, { command: "echo isolated > work.txt" }),
    );
    expect(write.status).toBe("ok");
    expect(readFileSync(join(info.workspaceDir, "work.txt"), "utf8")).toContain("isolated");
    expect(existsSync(join(workspace, "work.txt"))).toBe(false);
    await release(runtime, "th-child-a");
  });

  test("keep-alive retention: the workspace survives settlement; release captures post-settle work", async () => {
    const runtime = runtimeWith();
    const prepared = await prepare(runtime, "th-child-b", "Task-2");
    const info = JSON.parse(prepared.output) as { workspaceDir: string };
    // Settle happens with NO release dispatch (keep-alive): the workspace
    // stays registered and the child keeps working in it across the park.
    const second = await runtime.execute(
      frameOf("bash", "th-child-b", 3, { command: "echo after-park >> work.txt" }),
    );
    expect(second.status).toBe("ok");
    expect(readFileSync(join(info.workspaceDir, "work.txt"), "utf8")).toContain("after-park");

    // Explicit release captures-merges the whole delta (pre- + post-park).
    const released = await release(runtime, "th-child-b");
    expect(released.status).toBe("ok");
    expect(released.output).toContain("Applied patches: yes");
    expect(readFileSync(join(workspace, "work.txt"), "utf8")).toContain("after-park");
    expect(existsSync(info.workspaceDir)).toBe(false);
    // The thread's registration is gone: frames fall through to the base host.
    const afterRelease = await runtime.execute(
      frameOf("bash", "th-child-b", 4, { command: "echo stray >> stray.txt", cwd: "." }),
    );
    expect(afterRelease.status).toBe("ok");
    expect(existsSync(join(workspace, "stray.txt"))).toBe(true);
  });

  test("apply gate closed = capture only: patch artifact written, source untouched", async () => {
    const runtime = runtimeWith();
    const prepared = await prepare(runtime, "th-child-c", "Task-3");
    const info = JSON.parse(prepared.output) as { workspaceDir: string };
    await runtime.execute(frameOf("bash", "th-child-c", 3, { command: "echo gated > gated.txt" }));
    const released = await release(runtime, "th-child-c", { apply: false });
    expect(released.status).toBe("ok");
    expect(released.output).toContain("apply gate closed");
    const patchPath = /Captured patch \(apply gate closed — not applied\): (.+)$/.exec(
      released.output,
    )?.[1];
    expect(patchPath).toBeDefined();
    expect(readFileSync(patchPath as string, "utf8")).toContain("gated.txt");
    expect(existsSync(join(workspace, "gated.txt"))).toBe(false);
    expect(existsSync(info.workspaceDir)).toBe(false);
  });

  test("branch mode: release commits omp/task/<id>, cherry-picks onto HEAD, cleans the branch", async () => {
    const runtime = runtimeWith({ mergeMode: "branch" });
    const prepared = await prepare(runtime, "th-child-d", "Task-4");
    const info = JSON.parse(prepared.output) as { workspaceDir: string };
    await runtime.execute(
      frameOf("bash", "th-child-d", 3, { command: "echo branched > branched.txt" }),
    );
    const released = await release(runtime, "th-child-d");
    expect(released.status).toBe("ok");
    expect(released.output).toContain("Merged branch: omp/task/Task-4");
    expect(readFileSync(join(workspace, "branched.txt"), "utf8")).toContain("branched");
    expect(git("branch --list omp/task/Task-4")).toBe("");
    expect(existsSync(info.workspaceDir)).toBe(false);
  });

  test("branch mode with the gate closed keeps omp/task/<id> and leaves HEAD alone", async () => {
    const runtime = runtimeWith({ mergeMode: "branch" });
    const headBefore = git("rev-parse HEAD");
    const prepared = await prepare(runtime, "th-child-e", "Task-5");
    const info = JSON.parse(prepared.output) as { workspaceDir: string };
    await runtime.execute(frameOf("bash", "th-child-e", 3, { command: "echo kept > kept.txt" }));
    const released = await release(runtime, "th-child-e", { apply: false });
    expect(released.status).toBe("ok");
    expect(released.output).toContain("Captured branch omp/task/Task-5");
    expect(git("branch --list omp/task/Task-5")).toContain("omp/task/Task-5");
    expect(git("rev-parse HEAD")).toBe(headBefore);
    expect(existsSync(join(workspace, "kept.txt"))).toBe(false);
    expect(existsSync(info.workspaceDir)).toBe(false);
    git("branch -q -D omp/task/Task-5");
  });

  test("baseline over the snapshot budget fails BEFORE the child exists (fail-before-spawn)", async () => {
    const runtime = runtimeWith({ baselineBudgetBytes: 1 });
    const failed = await prepare(runtime, "th-child-f", "Task-6");
    expect(failed.status).toBe("error");
    expect(failed.output).toContain("isolation-snapshot budget");
    // No session registered: the child's frames cannot run isolated.
    const orphan = await runtime.execute(
      frameOf("bash", "th-child-f", 3, { command: "echo should-not-run" }),
    );
    // Frames fall through to the base host (parent-thread cwd semantics); the
    // point is there is NO isolation view — a release finds no session.
    const released = await release(runtime, "th-child-f");
    expect(released.status).toBe("error");
    expect(released.output).toContain("no isolation session for thread th-child-f");
    expect(orphan.status).toBe("ok");
  });

  test("preferred backend downgrade: an impossible backend falls back and still materialises", async () => {
    const runtime = runtimeWith({ backend: "apfs" });
    const prepared = await prepare(runtime, "th-child-g", "Task-7");
    // APFS clonefile cannot exist on Linux: the PAL candidate chain degrades
    // (fellBack=true + reason) instead of failing the spawn.
    expect(prepared.status).toBe("ok");
    const info = JSON.parse(prepared.output) as {
      backend: string;
      fellBack: boolean;
      fallbackReason: string | null;
    };
    expect(info.backend).not.toBe("apfs");
    expect(info.fellBack).toBe(true);
    await release(runtime, "th-child-g");
  });

  test("release without a session errors; unknown prepare args error cleanly", async () => {
    const runtime = runtimeWith();
    const nothing = await release(runtime, "th-never-prepared");
    expect(nothing.status).toBe("error");
    expect(nothing.output).toContain("no isolation session");
    const bad = await runtime.execute(frameOf(ISOLATION_PREPARE_TOOL, "th-parent", 5, {}));
    expect(bad.status).toBe("error");
    expect(bad.output).toContain("invalid task.isolation.prepare arguments");
  });

  // --- #419 landing guard integration (keep last: mutates the shared
  // workspace with a submodule; every earlier test has settled by now) ---

  test("patch mode: a `*:conflicts` sidecar in the delta is refused with cleanup guidance (#419)", async () => {
    const runtime = runtimeWith();
    const prepared = await prepare(runtime, "th-child-sidecar", "Task-Sidecar");
    const info = JSON.parse(prepared.output) as { workspaceDir: string };
    // The spill the #398/#399 lanes shipped: an untracked read-selector
    // artifact enters the delta (no .gitignore gap closure in the lane).
    await runtime.execute(
      frameOf("bash", "th-child-sidecar", 3, {
        command: "printf '3: spill\\n' > 'leak.ts:conflicts'",
      }),
    );
    const released = await release(runtime, "th-child-sidecar");
    expect(released.status).toBe("error");
    expect(released.output).toContain("Landing refused by the task-apply precheck (#419)");
    expect(released.output).toContain("rm -- 'leak.ts:conflicts'");
    expect(released.output).toContain("*:conflicts");
    expect(released.output).toContain(".gitignore");
    // The source checkout is untouched and the workspace torn down cleanly —
    // the patch artifact holds the delta (retention is for capture losses,
    // not refusals).
    expect(existsSync(join(workspace, "leak.ts:conflicts"))).toBe(false);
    expect(existsSync(info.workspaceDir)).toBe(false);
  }, 240_000);
});
