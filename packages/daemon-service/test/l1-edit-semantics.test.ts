import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EditTool } from "@oh-my-pi/pi-coding-agent/edit";
import {
  createToolHost,
  executeDispatch,
  type ToolDispatchFrame,
  type ToolHost,
} from "../src/client/tool-runtime.js";

/**
 * L1 per-tool semantics for edit (M1.5/T8 #98) — the vendored omp EditTool
 * (Rust EditStore natives) through real execute(). Card 交付/验收 anchors:
 *   - 防双 apply 三态：1st 真写 / 2nd 同 payload 字节相同=no_change 诊断（成功，
 *     patcher.rs:41-48）/ 3rd 连续 no-op=硬错误（store.rs NOOP_HARD_LIMIT=3）
 *   - mismatch 拒写 + 解析失败拒写：stage 全部先于 write（session.rs:304-331），
 *     文件零字节变化
 *   - exclusive 批：EditTool.concurrency === "exclusive"（index.ts:328）——
 *     agent-loop 调度语义，无锁错误可断言（锚 pin）
 *   - 新语法错误不回滚只注记（session.rs:397-401 parse_regressed → index.ts:548-554）
 *   - stale 快照恢复仅在链证明唯一安全结果时应用（recovery.rs:372-415）
 *   - 多文件段 OS 写失败前缀语义（session.rs:280-286：已落盘段保留，错误逐字返回）
 */

const MACHINE = "machine-l1-edit";

let root: string;
let fixture: string;
let host: ToolHost;
// omp loads lazily — the FIRST omp import in the bun process freezes the
// agent-dir resolver, so the VALUE import stays dynamic after createToolHost
// pins PI_CODING_AGENT_DIR (tool-runtime.ts runtime discipline; a static
// import breaks the T6 isolation tests).
let EditToolClass: typeof EditTool;

function frameOf(
  tool: string,
  executionId: string,
  args: Record<string, unknown>,
  timeoutMs = 10_000,
): ToolDispatchFrame {
  return { tool, arguments: args, executionId, machineId: MACHINE, timeoutMs };
}

const DOUBLE_APPLY_BODY = ["line A", "line B", "line C"].join("\n");

/** Reads the file, scrapes the fresh [path#TAG] anchor from a real read. */
async function freshTag(path: string): Promise<string> {
  const read = await executeDispatch(
    host,
    frameOf("read", `tag-${path}-${Math.random()}`, { path }),
  );
  if (read.status !== "ok") throw new Error(`read failed for ${path}: ${read.output}`);
  const tag = /#([0-9A-Fa-f]{4})\]/.exec(read.output)?.[1];
  if (tag === undefined) throw new Error(`no hashline tag in read output for ${path}`);
  return tag;
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "omp-edit-l1-"));
  fixture = join(root, "workspace");
  mkdirSync(fixture, { recursive: true });
  writeFileSync(join(fixture, "double.txt"), `${DOUBLE_APPLY_BODY}\n`);
  writeFileSync(join(fixture, "anchor.txt"), ["keep one", "keep two", "keep three"].join("\n"));
  writeFileSync(
    join(fixture, "syntax.ts"),
    ["export function fine() {", "  return 1;", "}"].join("\n"),
  );
  writeFileSync(
    join(fixture, "recover.txt"),
    ["row one", "row two", "row three", "row four"].join("\n"),
  );
  writeFileSync(join(fixture, "gone.txt"), ["target line", "other line"].join("\n"));
  writeFileSync(join(fixture, "seg-a.txt"), ["a1", "a2"].join("\n"));
  writeFileSync(join(fixture, "seg-b.txt"), ["b1", "b2"].join("\n"));
  host = await createToolHost(fixture, join(root, "omp-agent"), MACHINE);
  ({ EditTool: EditToolClass } = await import("@oh-my-pi/pi-coding-agent/edit"));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("anti-double-apply three states (T8 #98)", () => {
  test("first apply lands the change; second identical payload is a no-op diagnostic success; third is a hard stop", async () => {
    const path = "double.txt";
    const tag = await freshTag(path);
    const patch = `[${path}#${tag}]\nPUT 2.:\n+line B (edited)`;

    const first = await executeDispatch(host, frameOf("edit", "ed-1", { input: patch }));
    expect(first.status).toBe("ok");
    expect(readFileSync(join(fixture, path), "utf8")).toContain("line B (edited)");

    // The tag was minted BEFORE the edit; the edit response carries the new
    // header — scrape it so the re-apply targets the same payload shape.
    const newTag = /#([0-9A-Fa-f]{4})\]/.exec(first.output)?.[1];
    expect(newTag).toBeDefined();
    const samePatch = `[${path}#${newTag}]\nPUT 2.:\n+line B (edited)`;
    const second = await executeDispatch(host, frameOf("edit", "ed-2", { input: samePatch }));
    expect(second.status).toBe("ok");
    expect(second.output).toContain("produced no change");
    expect(second.output).toContain("byte-identical");

    // NOOP_HARD_LIMIT = 3 (store.rs:24): the counter increments per identical
    // no-op reply; the reply that reaches count 3 hard-errors — the first two
    // consecutive no-ops land as success diagnostics (observed ladder).
    const third = await executeDispatch(host, frameOf("edit", "ed-3", { input: samePatch }));
    expect(third.status).toBe("ok");
    expect(third.output).toContain("produced no change");

    const fourth = await executeDispatch(host, frameOf("edit", "ed-4", { input: samePatch }));
    expect(fourth.status).toBe("error");
    expect(fourth.output).toContain("byte-identical no-op 3 times in a row");

    // The loop guard is per-payload: a DIFFERENT payload resets the counter.
    const freshTag2 = await freshTag(path);
    const different = await executeDispatch(
      host,
      frameOf("edit", "ed-5", {
        input: `[${path}#${freshTag2}]\nPUT 2.:\n+line B (edited once more)`,
      }),
    );
    expect(different.status).toBe("ok");
  });
});

describe("fail-safe staging before write (T8 #98)", () => {
  test("stale-recognized tag rejects with mismatch copy and the file stays untouched", async () => {
    const path = "anchor.txt";
    const staleTag = await freshTag(path);
    writeFileSync(join(fixture, path), ["keep one", "CHANGED externally", "keep three"].join("\n"));
    const before = readFileSync(join(fixture, path), "utf8");

    const result = await executeDispatch(
      host,
      frameOf("edit", "ed-5", { input: `[${path}#${staleTag}]\nPUT 2.:\n+keep two (edited)` }),
    );
    expect(result.status).toBe("error");
    expect(result.output).toContain(`Edit rejected for ${path}`);
    expect(result.output).toContain("file changed between read and edit");
    expect(readFileSync(join(fixture, path), "utf8")).toBe(before);
  });

  test("unrecognized tag names the session provenance and refuses", async () => {
    const result = await executeDispatch(
      host,
      frameOf("edit", "ed-6", { input: "[anchor.txt#DEAD]\nPUT 1.:\n+nope" }),
    );
    expect(result.status).toBe("error");
    expect(result.output).toContain("not from this session");
    expect(readFileSync(join(fixture, "anchor.txt"), "utf8")).toContain("CHANGED externally");
  });

  test("missing snapshot tag is a structured parse-stage error, file untouched", async () => {
    const before = readFileSync(join(fixture, "anchor.txt"), "utf8");
    const result = await executeDispatch(
      host,
      frameOf("edit", "ed-7", { input: "[anchor.txt]\nPUT 1.:\n+nope" }),
    );
    expect(result.status).toBe("error");
    expect(result.output).toContain("Missing hashline snapshot tag");
    expect(readFileSync(join(fixture, "anchor.txt"), "utf8")).toBe(before);
  });
});

describe("syntax-error annotation without rollback (T8 #98)", () => {
  test("a change that breaks parsing is applied and annotated, not reverted", async () => {
    const path = "syntax.ts";
    const tag = await freshTag(path);
    // Cutting the closing brace leaves the function unterminated: applied,
    // parse_regressed fires, and the wrapper appends the warning text block.
    const result = await executeDispatch(
      host,
      frameOf("edit", "ed-8", { input: `[${path}#${tag}]\nCUT 3.` }),
    );
    expect(result.status).toBe("ok");
    const after = readFileSync(join(fixture, path), "utf8");
    expect(after).not.toContain("}");
    expect(result.output).toContain("no longer parses after this edit");
    expect(result.output).toContain("The change was applied");
  });
});

describe("stale snapshot recovery (T8 #98)", () => {
  test("external append after the tagged read recovers by remap and lands the edit", async () => {
    const path = "recover.txt";
    const tag = await freshTag(path);
    // External change AFTER the read: hash moves off the tag but every anchor
    // still maps (offset 0, context preserved) — the uniquely-safe case.
    writeFileSync(
      join(fixture, path),
      `${["row one", "row two", "row three", "row four"].join("\n")}\nappended externally\n`,
    );
    const result = await executeDispatch(
      host,
      frameOf("edit", "ed-9", { input: `[${path}#${tag}]\nPUT 2.:\n+row two (recovered edit)` }),
    );
    expect(result.status).toBe("ok");
    expect(result.output).toContain("Recovered from a stale file hash");
    expect(readFileSync(join(fixture, path), "utf8")).toContain("row two (recovered edit)");
  });

  test("external change that invalidates the anchor is a hard mismatch, not a guess", async () => {
    const path = "gone.txt";
    const tag = await freshTag(path);
    writeFileSync(join(fixture, path), ["everything replaced", "other line"].join("\n"));
    const before = readFileSync(join(fixture, path), "utf8");
    const result = await executeDispatch(
      host,
      frameOf("edit", "ed-10", { input: `[${path}#${tag}]\nPUT 1.:\n+target line (edited)` }),
    );
    expect(result.status).toBe("error");
    expect(result.output).toContain("Edit rejected for");
    expect(readFileSync(join(fixture, path), "utf8")).toBe(before);
  });
});

describe("multi-segment OS write failure prefix semantics (T8 #98)", () => {
  test("segment 1 stays on disk when segment 2's write fails; the error names the failure", async () => {
    const tagA = await freshTag("seg-a.txt");
    const tagB = await freshTag("seg-b.txt");
    // b.txt read fine at stage time; deny the write afterwards (session.rs
    // writes sequentially in payload order and returns the writer error verbatim).
    chmodSync(join(fixture, "seg-b.txt"), 0o444);
    try {
      const result = await executeDispatch(
        host,
        frameOf("edit", "ed-11", {
          input: `[seg-a.txt#${tagA}]\nPUT 1.:\n+a1 (segment one)\n[seg-b.txt#${tagB}]\nPUT 1.:\n+b1 (segment two)`,
        }),
      );
      expect(result.status).toBe("error");
      expect(readFileSync(join(fixture, "seg-a.txt"), "utf8")).toContain("a1 (segment one)");
      expect(readFileSync(join(fixture, "seg-b.txt"), "utf8")).toBe("b1\nb2");
    } finally {
      chmodSync(join(fixture, "seg-b.txt"), 0o644);
    }
  });
});

describe("exclusive batch contract (T8 #98)", () => {
  test("EditTool declares exclusive concurrency — solo tool batch in the agent loop", async () => {
    // omp has no lock and no "concurrent edit" error: exclusivity is the
    // agent-loop scheduler running edit as a SOLO batch (index.ts:328). Pin
    // the contract surface; serialization is upstream's tested behavior.
    const edit = new EditToolClass(host.session as never, "hashline");
    expect(edit.concurrency).toBe("exclusive");
  });
});
