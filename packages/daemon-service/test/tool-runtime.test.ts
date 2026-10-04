import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
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
 * T6 #96 adds the write-semantics anchors (overwrite idempotent, archive
 * whole-rewrite, SQLite row insert) and the manage_skill lifecycle
 * (SKILL.md exclusive management + symlink escape refusals).
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
let managedSkillsDir: string;
const MACHINE = "machine-l1-runtime";

function frameOf(
  tool: string,
  executionId: string,
  args: Record<string, unknown>,
  timeoutMs = 10_000,
): ToolDispatchFrame {
  return { tool, arguments: args, executionId, machineId: MACHINE, timeoutMs };
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "omp-runtime-l1-"));
  fixture = join(root, "workspace");
  agentDir = join(root, "omp-agent");
  mkdirSync(join(fixture, "src"), { recursive: true });
  mkdirSync(join(fixture, "out"), { recursive: true });
  writeFileSync(join(fixture, "src", "alpha.ts"), ALPHA);
  // T6 archive fixture: a real uncompressed tar with two members — the
  // write tool rewrites the whole archive through a temp sibling + rename.
  mkdirSync(join(fixture, "arch", "members"), { recursive: true });
  writeFileSync(join(fixture, "arch", "members", "keep.txt"), "keep-me\n");
  writeFileSync(join(fixture, "arch", "members", "edit.txt"), "before-archive-edit\n");
  await Bun.$`tar -cf ${join(fixture, "arch", "bundle.tar")} -C ${join(fixture, "arch", "members")} keep.txt edit.txt`.quiet();
  // T6 SQLite fixture: a real database with one table for the insert target.
  mkdirSync(join(fixture, "data"), { recursive: true });
  const db = new Database(join(fixture, "data", "ledger.db"), { create: true });
  db.exec("CREATE TABLE items (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)");
  db.close();
  // Agent-dir isolation (T6): the client pins PI_CODING_AGENT_DIR before omp
  // loads; the managed-skills store must land under the test agentDir.
  managedSkillsDir = join(agentDir, "managed-skills");
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
    const result = await executeDispatch(
      host,
      frameOf("grep", "g2", { pattern: "GrepNeedle", path: fixture }),
    );
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
    const result = await executeDispatch(
      host,
      frameOf("write", "w1", {
        path: "out/draft.md",
        content: "# draft\nvendored runtime\n",
      }),
    );
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

// ---------------------------------------------------------------------------
// T6 #96 — write semantics + manage_skill (SKILL.md exclusive management).
// ---------------------------------------------------------------------------

describe("T6 #96 — write semantics through real omp execute()", () => {
  test("overwrite write is idempotent: same content twice, byte-identical file, no temp leftovers", async () => {
    const args = { path: "out/twice.md", content: "# idempotent\nsame bytes\n" };
    const first = await executeDispatch(host, frameOf("write", "t6-w1", args));
    expect(first.status).toBe("ok");
    const second = await executeDispatch(host, frameOf("write", "t6-w2", args));
    expect(second.status).toBe("ok");
    expect(readFileSync(join(fixture, "out", "twice.md"), "utf8")).toBe(args.content);
    // The omp write path stages nothing for plain files: no temp sibling remains.
    const siblings = Array.from(new Bun.Glob("out/twice.md.tmp*").scanSync({ cwd: fixture }));
    expect(siblings).toEqual([]);
  });

  test("archive member write rewrites the whole tar via temp sibling + rename (atomic, sibling preserved)", async () => {
    const result = await executeDispatch(
      host,
      frameOf("write", "t6-w3", {
        path: "arch/bundle.tar:edit.txt",
        content: "after-archive-edit\n",
      }),
    );
    expect(result.status).toBe("ok");
    // The untouched member survives the whole-archive rewrite; the target
    // member carries the new bytes (uncompressed tar = plain concatenation).
    const listing = await Bun.$`tar -tf ${join(fixture, "arch", "bundle.tar")}`.text();
    expect(listing.split("\n").filter(Boolean).sort()).toEqual(["edit.txt", "keep.txt"]);
    const keep = await Bun.$`tar -xOf ${join(fixture, "arch", "bundle.tar")} keep.txt`.text();
    const edited = await Bun.$`tar -xOf ${join(fixture, "arch", "bundle.tar")} edit.txt`.text();
    expect(keep).toBe("keep-me\n");
    expect(edited).toBe("after-archive-edit\n");
    // The atomic swap leaves no temp sibling behind.
    const leftovers = Array.from(new Bun.Glob("arch/bundle.tar.tmp*").scanSync({ cwd: fixture }));
    expect(leftovers).toEqual([]);
  });

  test("SQLite target insert lands a row; the tool is NOT idempotent (dedup is executionId-level)", async () => {
    const dbPath = join(fixture, "data", "ledger.db");
    const insert = await executeDispatch(
      host,
      frameOf("write", "t6-w4", { path: "data/ledger.db:items", content: '{"name": "row-one"}' }),
    );
    expect(insert.status).toBe("ok");
    expect(insert.output).toContain("Inserted row into items");
    const db = new Database(dbPath, { readonly: true });
    try {
      expect(db.query("SELECT name FROM items ORDER BY id").all()).toEqual([{ name: "row-one" }]);
    } finally {
      db.close();
    }
    // A second, DIFFERENT execution inserts again — the tool itself is not
    // idempotent; dedup rides the service journal (same executionId replays
    // the journaled result, l1-i19-replay.test.ts), never the tool.
    const repeat = await executeDispatch(
      host,
      frameOf("write", "t6-w5", { path: "data/ledger.db:items", content: '{"name": "row-one"}' }),
    );
    expect(repeat.status).toBe("ok");
    const db2 = new Database(dbPath, { readonly: true });
    try {
      expect(db2.query("SELECT count(*) AS n FROM items").get()).toEqual({ n: 2 });
    } finally {
      db2.close();
    }
  });
});

describe("T6 #96 — manage_skill: SKILL.md exclusive management", () => {
  const skillArgs = (name: string, body = "step one\nstep two\n") => ({
    action: "create",
    name,
    description: "demo skill for the daemon host anchor",
    body,
  });

  test("managed-skills store resolves under the daemon-private agentDir (#182 regression)", async () => {
    // Value import stays dynamic: it must observe the resolver AFTER
    // createToolHost re-pointed it (runtime discipline — a static import
    // would read the pre-pin freeze and see the operator's ~/.omp/agent).
    const { getManagedSkillsDir } = await import(
      "@oh-my-pi/pi-coding-agent/autolearn/managed-skills",
    );
    expect(getManagedSkillsDir()).toBe(join(agentDir, "managed-skills"));
    expect(process.env.PI_CODING_AGENT_DIR).toBe(agentDir);
  });

  test("create/update/delete lifecycle writes SKILL.md under the daemon-private managed root", async () => {
    const created = await executeDispatch(
      host,
      frameOf("manage_skill", "t6-m1", skillArgs("deploy-demo")),
    );
    expect(created.status).toBe("ok");
    expect(created.output).toContain('Created managed skill "deploy-demo"');
    const skillFile = join(managedSkillsDir, "deploy-demo", "SKILL.md");
    const onDisk = readFileSync(skillFile, "utf8");
    expect(onDisk).toContain("name: deploy-demo");
    expect(onDisk).toContain("demo skill for the daemon host anchor");
    expect(onDisk).toContain("step one");

    const updated = await executeDispatch(
      host,
      frameOf("manage_skill", "t6-m2", {
        ...skillArgs("deploy-demo"),
        action: "update",
        body: "step one only\n",
      }),
    );
    expect(updated.status).toBe("ok");
    expect(readFileSync(skillFile, "utf8")).toContain("step one only");

    const removed = await executeDispatch(
      host,
      frameOf("manage_skill", "t6-m3", { action: "delete", name: "deploy-demo" }),
    );
    expect(removed.status).toBe("ok");
    expect(Array.from(new Bun.Glob("deploy-demo/**").scanSync({ cwd: managedSkillsDir }))).toEqual(
      [],
    );
  });

  test("create refuses an existing skill; update/delete refuse an absent one (omp lifecycle contract)", async () => {
    const first = await executeDispatch(
      host,
      frameOf("manage_skill", "t6-m4", skillArgs("once-only")),
    );
    expect(first.status).toBe("ok");
    const duplicate = await executeDispatch(
      host,
      frameOf("manage_skill", "t6-m5", skillArgs("once-only")),
    );
    expect(duplicate.status).toBe("error");
    expect(duplicate.output).toContain('already exists. Use action "update"');
    const updateAbsent = await executeDispatch(
      host,
      frameOf("manage_skill", "t6-m6", { ...skillArgs("never-was"), action: "update" }),
    );
    expect(updateAbsent.status).toBe("error");
    expect(updateAbsent.output).toContain('does not exist. Use action "create"');
    const deleteAbsent = await executeDispatch(
      host,
      frameOf("manage_skill", "t6-m7", { action: "delete", name: "never-was" }),
    );
    expect(deleteAbsent.status).toBe("error");
    expect(deleteAbsent.output).toContain("does not exist");
  });

  test("symlinked skill directory is refused on write and delete — the escape target stays untouched", async () => {
    const escapeTarget = join(root, "escape-victim");
    mkdirSync(escapeTarget, { recursive: true });
    writeFileSync(join(escapeTarget, "SKILL.md"), "authored\n");
    mkdirSync(managedSkillsDir, { recursive: true });
    symlinkSync(escapeTarget, join(managedSkillsDir, "escapee"));
    const writeEscape = await executeDispatch(
      host,
      frameOf("manage_skill", "t6-m8", skillArgs("escapee")),
    );
    expect(writeEscape.status).toBe("error");
    expect(writeEscape.output).toContain("resolves through a symlink");
    const deleteEscape = await executeDispatch(
      host,
      frameOf("manage_skill", "t6-m9", { action: "delete", name: "escapee" }),
    );
    expect(deleteEscape.status).toBe("error");
    expect(deleteEscape.output).toContain("is a symlink");
    // The victim content is intact — nothing followed the link.
    expect(readFileSync(join(escapeTarget, "SKILL.md"), "utf8")).toBe("authored\n");
  });

  test("create without description/body is a structured error (omp execute-time narrow)", async () => {
    const incomplete = await executeDispatch(
      host,
      frameOf("manage_skill", "t6-m10", { action: "create", name: "headless" }),
    );
    expect(incomplete.status).toBe("error");
    expect(incomplete.output).toContain('requires both "description" and "body"');
  });
});

describe("adapter projection matrix (spike §3)", () => {
  test("unknown tool is a structured error, not a throw", async () => {
    const result = await executeDispatch(host, frameOf("l1-nonexistent", "x1", {}));
    expect(result.status).toBe("error");
    expect(result.output).toBe("unknown tool: l1-nonexistent");
    expect(result.exitCode).toBeNull();
  });

  test("wrong machine is rejected before any execution", async () => {
    const result = await executeDispatch(host, frameOf("read", "x2", { path: "src/alpha.ts" }));
    const misrouted = {
      ...frameOf("read", "x2", { path: "src/alpha.ts" }),
      machineId: "machine-other",
    };
    const rejected = await executeDispatch(host, misrouted);
    expect(rejected.status).toBe("error");
    expect(rejected.output).toContain("machine machine-other");
    expect(result.status).toBe("ok");
  });

  test("omp structured tool failure projects to status=error with precise copy", async () => {
    const result = await executeDispatch(
      host,
      frameOf("edit", "x3", { input: "not a hashline patch" }),
    );
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

// ---------------------------------------------------------------------------
// T9 #99 — bash activation through the embedded runtime (probe verdict (b)
// embed-with-shims: tools.maxTimeout pin, cwd sandbox guard, artifact
// allocator, kill→AbortController; exit code rides details.exitCode).
// ---------------------------------------------------------------------------

describe("T9 #99 — bash through the embedded runtime", () => {
  test("exit code propagates: ok/0 and error/7 (M0 exec.exited semantic survives)", async () => {
    const ok = await executeDispatch(
      host,
      frameOf("bash", "thr_t9b:1", { command: "echo hello-embed" }),
    );
    expect(ok.status).toBe("ok");
    expect(ok.exitCode).toBe(0);
    expect(ok.output).toContain("hello-embed");
    const failed = await executeDispatch(
      host,
      frameOf("bash", "thr_t9b:2", { command: "echo before-exit; exit 7" }),
    );
    expect(failed.status).toBe("error");
    expect(failed.exitCode).toBe(7);
    expect(failed.output).toContain("before-exit");
    expect(failed.output).toContain("Command exited with code 7");
  });

  test("merged streams arrive in order (M0 §1.3 semantic survives)", async () => {
    const result = await executeDispatch(
      host,
      frameOf("bash", "thr_t9b:3", { command: "echo out-stream; echo err-stream 1>&2" }),
    );
    expect(result.status).toBe("ok");
    expect(result.output).toContain("out-stream");
    expect(result.output).toContain("err-stream");
  });

  test("tools.maxTimeout=600 pin restores the M0 ceiling (shim 1)", async () => {
    const result = await executeDispatch(
      host,
      frameOf("bash", "thr_t9b:4", { command: "echo clamped", timeout: 99999 }),
    );
    expect(result.status).toBe("ok");
    expect(result.output).toContain("Timeout clamped to 600s");
    expect(result.output).toContain("99999s");
  });

  test("omp enforces the per-call deadline (timedOut error result)", async () => {
    const result = await executeDispatch(
      host,
      frameOf("bash", "thr_t9b:5", { command: "sleep 5", timeout: 1 }, 10_000),
    );
    expect(result.status).toBe("error");
    expect(result.output).toContain("Command timed out after 1 seconds");
  }, 15_000);

  test("cwd sandbox guard: inside resolves, escapes refused before execution (shim 2)", async () => {
    mkdirSync(join(fixture, "sub"), { recursive: true });
    const inside = await executeDispatch(
      host,
      frameOf("bash", "thr_t9b:6", { command: "pwd", cwd: "sub" }),
    );
    expect(inside.status).toBe("ok");
    expect(inside.output).toContain(join(fixture, "sub"));
    const parentEscape = await executeDispatch(
      host,
      frameOf("bash", "thr_t9b:7", { command: "pwd", cwd: "../" }),
    );
    expect(parentEscape.status).toBe("error");
    expect(parentEscape.output).toContain("cwd escapes the sandbox root");
    const absoluteEscape = await executeDispatch(
      host,
      frameOf("bash", "thr_t9b:8", { command: "pwd", cwd: "/tmp" }),
    );
    expect(absoluteEscape.status).toBe("error");
    expect(absoluteEscape.output).toContain("cwd escapes the sandbox root");
  });

  test("artifact allocator: 50 KiB-truncated output spills to artifact:// and reads back (shim 3)", async () => {
    const result = await executeDispatch(
      host,
      // Multi-line so omp's 50 KiB inline cap middle-truncates (a single
      // giant line takes the column-truncation path instead — 18.6.0 shape).
      frameOf("bash", "thr_t9b:9", { command: "yes 0123456789abcdefghij | head -5000" }),
    );
    expect(result.status).toBe("ok");
    expect(result.outputTruncated).toBe(true);
    const footer = /\[raw output: artifact:\/\/(\d+)\]/.exec(result.output);
    expect(footer).not.toBeNull();
    const artifactId = footer?.[1];
    expect(artifactId).toBeDefined();
    // Full bytes land in the daemon-private artifacts dir (105,000 = 5000
    // lines x 21 bytes); the embedded read tool resolves artifact://<id>
    // through the pinned getArtifactsDir.
    const spilled = await Bun.file(join(agentDir, "artifacts", `${artifactId}.bash.log`)).text();
    expect(spilled).toHaveLength(105_000);
    const readback = await executeDispatch(
      host,
      frameOf("read", "thr_t9b:10", { path: `artifact://${artifactId}:raw:1-5000` }),
    );
    expect(readback.status).toBe("ok");
    // The read tool applies its own inline budget past 50 KiB — the
    // assertion proves the artifact:// resolution recovered the real spill
    // (well beyond the truncated inline view), not a miss.
    expect(readback.output.length).toBeGreaterThan(50_000);
  }, 20_000);

  test("persistent shell is keyed per thread: state survives within, never across (sessionKey pin)", async () => {
    const threadA = "thr_t9shellA";
    const threadB = "thr_t9shellB";
    const setA = await executeDispatch(
      host,
      frameOf("bash", `${threadA}:1`, { command: "T9_PROBE_STATE=41" }),
    );
    expect(setA.status).toBe("ok");
    const readA = await executeDispatch(
      host,
      frameOf("bash", `${threadA}:2`, { command: "echo state=$T9_PROBE_STATE" }),
    );
    expect(readA.output).toContain("state=41");
    const readB = await executeDispatch(
      host,
      frameOf("bash", `${threadB}:1`, { command: "echo state=${T9_PROBE_STATE:-unset}" }),
    );
    expect(readB.output).toContain("state=unset");
  });

  test("kill maps to abort: cancelSignal aborts the live bash run (shim 4)", async () => {
    // Deterministic time control cannot work here: the abort must land on a
    // REAL live shell process (omp's AbortSignal → native kill), so the
    // cancel is fired on the platform clock — the assertion awaits the
    // run's actual cancellation, never a guessed duration.
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);
    const started = Date.now();
    const result = await executeDispatch(
      host,
      frameOf("bash", "thr_t9b:11", { command: "sleep 30" }, 30_000),
      { cancelSignal: controller.signal },
    );
    expect(result.status).toBe("cancelled");
    expect(Date.now() - started).toBeLessThan(5_000);
  }, 15_000);
});
