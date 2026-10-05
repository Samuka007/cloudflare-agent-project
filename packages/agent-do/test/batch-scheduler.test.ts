import { describe, expect, test } from "vitest";
import {
  batchCallsConflict,
  batchScheduleClass,
  batchScheduleKey,
  normalizeScheduleKey,
  scheduleBatch,
  type BatchScheduleItem,
} from "../src/tools/batch-scheduler.js";

/**
 * #328 C3 — the conflict-aware batch scheduler (pi parity anchor: pi
 * agent-loop.ts default-parallel batches + tools/file-mutation-queue.ts
 * same-file serialization). Pure-function pins: the classification source
 * (registry rows), the key extraction from journaled arguments, the
 * pairwise conflict table, and the wave layout a batch produces.
 */

function item(
  executionId: string,
  tool: string,
  arguments_: Record<string, unknown>,
): BatchScheduleItem {
  return { executionId, tool, arguments: arguments_ };
}

describe("#328 registry classification", () => {
  test("read-side host tools classify read; scope readers included", () => {
    for (const tool of ["read", "glob", "grep", "find"]) {
      expect(batchScheduleClass(tool)).toBe("read");
    }
  });

  test("detached tools: think, web_search, and the blocking wait/ask pair", () => {
    for (const tool of ["think", "web_search", "wait", "ask"]) {
      expect(batchScheduleClass(tool)).toBe("detached");
    }
  });

  test("everything mutating or unknown is exclusive — including mcp__* and unregistered names", () => {
    for (const tool of [
      "bash",
      "edit",
      "write",
      "eval",
      "task",
      "todo",
      "checkpoint",
      "rewind",
      "context_notes",
      "new_context",
      "security_scan",
      "manage_skill",
      "yield",
      "mcp__demo__add",
      "no_such_tool",
    ]) {
      expect(batchScheduleClass(tool)).toBe("exclusive");
    }
  });
});

describe("#328 key extraction", () => {
  test("read/write key on the path argument", () => {
    expect(batchScheduleKey("read", { path: "src/a.ts" })).toBe("src/a.ts");
    expect(batchScheduleKey("write", { path: "src/a.ts", content: "x" })).toBe("src/a.ts");
  });

  test("read selectors strip — `a.ts:50-100` is the same file", () => {
    expect(batchScheduleKey("read", { path: "a.ts:50-100" })).toBe("a.ts");
    expect(batchScheduleKey("read", { path: "a.ts:50" })).toBe("a.ts");
  });

  test("lexical normalization folds `./` and duplicate slashes", () => {
    expect(normalizeScheduleKey("./src/a.ts")).toBe("src/a.ts");
    expect(batchScheduleKey("write", { path: "./src/a.ts" })).toBe("src/a.ts");
    expect(normalizeScheduleKey("src//a.ts")).toBe("src/a.ts");
  });

  test("edit keys on the hashline input header (first line)", () => {
    expect(batchScheduleKey("edit", { input: "src/a.ts\n@@\nold" })).toBe("src/a.ts");
    expect(batchScheduleKey("edit", { input: "  src/a.ts  " })).toBe("src/a.ts");
  });

  test("missing or unkeyed arguments yield null (conservative barrier)", () => {
    expect(batchScheduleKey("bash", { command: "ls" })).toBeNull();
    expect(batchScheduleKey("glob", { pattern: "**" })).toBeNull();
    expect(batchScheduleKey("write", {})).toBeNull();
    expect(batchScheduleKey("edit", {})).toBeNull();
    expect(batchScheduleKey("eval", { code: "1" })).toBeNull();
  });
});

describe("#328 pairwise conflicts", () => {
  const call = (batchClass: "read" | "detached" | "exclusive", key: string | null) => ({
    executionId: "x",
    batchClass,
    key,
  });

  test("reads never conflict — even unkeyed scope reads", () => {
    expect(batchCallsConflict(call("read", "a.ts"), call("read", "a.ts"))).toBe(false);
    expect(batchCallsConflict(call("read", "a.ts"), call("read", null))).toBe(false);
    expect(batchCallsConflict(call("read", null), call("read", null))).toBe(false);
  });

  test("same non-null key conflicts whenever one side is exclusive", () => {
    expect(batchCallsConflict(call("read", "a.ts"), call("exclusive", "a.ts"))).toBe(true);
    expect(batchCallsConflict(call("exclusive", "a.ts"), call("read", "a.ts"))).toBe(true);
    expect(batchCallsConflict(call("exclusive", "a.ts"), call("exclusive", "a.ts"))).toBe(true);
  });

  test("different keyed files do not conflict — pi mutation-queue semantics", () => {
    expect(batchCallsConflict(call("exclusive", "a.ts"), call("exclusive", "b.ts"))).toBe(false);
    expect(batchCallsConflict(call("read", "a.ts"), call("exclusive", "b.ts"))).toBe(false);
  });

  test("unkeyed participants conflict with every exclusive call", () => {
    expect(batchCallsConflict(call("exclusive", null), call("exclusive", "a.ts"))).toBe(true);
    expect(batchCallsConflict(call("exclusive", "a.ts"), call("exclusive", null))).toBe(true);
    expect(batchCallsConflict(call("read", null), call("exclusive", "a.ts"))).toBe(true);
    expect(batchCallsConflict(call("exclusive", null), call("read", "a.ts"))).toBe(true);
    expect(batchCallsConflict(call("exclusive", null), call("exclusive", null))).toBe(true);
  });

  test("detached calls conflict with nothing", () => {
    expect(batchCallsConflict(call("detached", null), call("exclusive", "a.ts"))).toBe(false);
    expect(batchCallsConflict(call("exclusive", "a.ts"), call("detached", null))).toBe(false);
    expect(batchCallsConflict(call("detached", null), call("exclusive", null))).toBe(false);
    expect(batchCallsConflict(call("detached", null), call("read", "a.ts"))).toBe(false);
  });
});

describe("#328 scheduleBatch wave layout", () => {
  test("empty batch schedules zero waves", () => {
    expect(scheduleBatch([])).toEqual([]);
  });

  test("a read-only batch is one wave in call order", () => {
    const waves = scheduleBatch([
      item("e1", "read", { path: "a.md" }),
      item("e2", "grep", { pattern: "x" }),
      item("e3", "read", { path: "b.md" }),
      item("e4", "glob", { path: "src" }),
      item("e5", "find", { query: "q", grep_keywords: [] }),
    ]);
    expect(waves).toEqual([["e1", "e2", "e3", "e4", "e5"]]);
  });

  test("same-file writes serialize in call order; different-file writes do not", () => {
    const waves = scheduleBatch([
      item("w1", "write", { path: "a.txt", content: "1" }),
      item("w2", "write", { path: "b.txt", content: "2" }),
      item("w3", "write", { path: "./a.txt", content: "3" }),
    ]);
    expect(waves).toEqual([["w1", "w2"], ["w3"]]);
  });

  test("read-after-write and write-after-read of one file each take their own wave", () => {
    const afterWrite = scheduleBatch([
      item("w1", "write", { path: "a.txt" }),
      item("r1", "read", { path: "a.txt" }),
      item("r2", "read", { path: "b.txt" }),
    ]);
    expect(afterWrite).toEqual([["w1", "r2"], ["r1"]]);

    const beforeWrite = scheduleBatch([
      item("r1", "read", { path: "a.txt" }),
      item("w1", "write", { path: "a.txt" }),
    ]);
    expect(beforeWrite).toEqual([["r1"], ["w1"]]);
  });

  test("edit serializes against same-file write via the hashline header", () => {
    const waves = scheduleBatch([
      item("w1", "write", { path: "a.ts" }),
      item("e1", "edit", { input: "a.ts\n@@\nold" }),
      item("e2", "edit", { input: "b.ts\n@@\nold" }),
    ]);
    expect(waves).toEqual([["w1", "e2"], ["e1"]]);
  });

  test("bash is a batch barrier in both directions", () => {
    const after = scheduleBatch([
      item("r1", "read", { path: "a.md" }),
      item("b1", "bash", { command: "make" }),
      item("r2", "read", { path: "b.md" }),
    ]);
    expect(after).toEqual([["r1"], ["b1"], ["r2"]]);

    const before = scheduleBatch([
      item("b1", "bash", { command: "make" }),
      item("r1", "read", { path: "a.md" }),
    ]);
    expect(before).toEqual([["b1"], ["r1"]]);
  });

  test("unkeyed scope reads serialize against writes but not against reads", () => {
    const waves = scheduleBatch([
      item("g1", "grep", { pattern: "x" }),
      item("r1", "read", { path: "a.md" }),
      item("w1", "write", { path: "a.md" }),
    ]);
    expect(waves).toEqual([["g1", "r1"], ["w1"]]);
  });

  test("detached tools ride any wave — the t19 photo-finish batch stays together", () => {
    const waves = scheduleBatch([
      item("w8", "wait", {}),
      item("k1", "write", { path: "proc://job-1/kill" }),
    ]);
    expect(waves).toEqual([["w8", "k1"]]);
  });

  test("detached tools never delay the waves around them", () => {
    const waves = scheduleBatch([
      item("b1", "bash", { command: "make" }),
      item("t1", "think", { thoughts: "..." }),
      item("r1", "read", { path: "a.md" }),
    ]);
    expect(waves).toEqual([["b1", "t1"], ["r1"]]);
  });

  test("mcp tools are exclusive-unkeyed barriers", () => {
    const waves = scheduleBatch([
      item("m1", "mcp__demo__add", { a: 1, b: 2 }),
      item("r1", "read", { path: "a.md" }),
    ]);
    expect(waves).toEqual([["m1"], ["r1"]]);
  });

  test("three same-file writes stack three waves in call order", () => {
    const waves = scheduleBatch([
      item("w1", "write", { path: "a.txt" }),
      item("w2", "write", { path: "a.txt" }),
      item("w3", "write", { path: "a.txt" }),
    ]);
    expect(waves).toEqual([["w1"], ["w2"], ["w3"]]);
  });
});
