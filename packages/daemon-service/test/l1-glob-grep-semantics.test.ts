import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as natives from "@oh-my-pi/pi-natives";
import type { GlobTool } from "@oh-my-pi/pi-coding-agent/tools/glob";
import type { GrepTool } from "@oh-my-pi/pi-coding-agent/tools/grep";
import {
  createToolHost,
  executeDispatch,
  type ToolDispatchFrame,
  type ToolHost,
} from "../src/client/tool-runtime.js";

/**
 * L1 per-tool semantics for glob + grep (M1.5/T7 #97) — the vendored omp
 * engines through real execute(). Card 交付/验收 anchors:
 *   - 超时语义分叉：glob 5s 固定超时 = 成功 + 截断提示而非抛错（glob.ts:429-506,
 *     timeoutMs 构造注入）vs grep 30s 原生超时抛错（grep.ts:637-641）。
 *   - gitignore 尊重（native walk gitignore 透传，glob.ts:441 / grep schema）。
 *   - 分页 skip 幂等（grep.ts:712-755）；重发安全（只读，同帧两次一致）。
 *   - glob 零匹配只给 incomplete-scan 提示绝不宣告不存在（glob.ts:258-266）。
 */

const MACHINE = "machine-l1-glob-grep";

let root: string;
let fixture: string;
let host: ToolHost;
// omp/natives load lazily — the FIRST omp import in the bun process freezes
// the agent-dir resolver, so every VALUE import here stays dynamic and runs
// after createToolHost has pinned PI_CODING_AGENT_DIR (tool-runtime.ts
// runtime discipline; a static import breaks the T6 isolation tests).
let GlobToolClass: typeof GlobTool;
let GrepToolClass: typeof GrepTool;
let Natives: typeof natives;

function frameOf(
  tool: string,
  executionId: string,
  args: Record<string, unknown>,
  timeoutMs = 10_000,
): ToolDispatchFrame {
  return { tool, arguments: args, executionId, machineId: MACHINE, timeoutMs };
}

const PAGES = 25;
const HOT_LINES = 30;
const SINGLE_LINES = 250;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "omp-glob-grep-l1-"));
  fixture = join(root, "workspace");
  const pag = join(fixture, "pag");
  const caps = join(fixture, "caps");
  const ignored = join(fixture, "ignored");
  mkdirSync(pag, { recursive: true });
  mkdirSync(caps, { recursive: true });
  mkdirSync(ignored, { recursive: true });
  writeFileSync(join(fixture, ".gitignore"), "ignored/\n*.log\n");
  writeFileSync(join(ignored, "secret.txt"), "SecretNeedle hidden from default search\n");
  writeFileSync(join(fixture, "notes.log"), "LogNeedle inside a gitignored log\n");
  for (let i = 1; i <= PAGES; i += 1) {
    writeFileSync(join(pag, `page-${String(i).padStart(2, "0")}.txt`), `PageNeedle on page ${i}\n`);
  }
  const hot = Array.from({ length: HOT_LINES }, (_, i) => `HotNeedle ${i + 1}`).join("\n");
  writeFileSync(join(caps, "hot.txt"), `${hot}\n`);
  writeFileSync(join(caps, "other.txt"), "HotNeedle lone\n");
  const big = Array.from({ length: SINGLE_LINES }, (_, i) => `SingleNeedle ${i + 1}`).join("\n");
  writeFileSync(join(fixture, "big.txt"), `${big}\n`);
  host = await createToolHost(fixture, join(root, "omp-agent"), MACHINE);
  ({ GlobTool: GlobToolClass } = await import("@oh-my-pi/pi-coding-agent/tools/glob"));
  ({ GrepTool: GrepToolClass } = await import("@oh-my-pi/pi-coding-agent/tools/grep"));
  Natives = await import("@oh-my-pi/pi-natives");
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("glob (T7 #97)", () => {
  test("gitignore respected by default, disableable per call", async () => {
    const clean = await executeDispatch(host, frameOf("glob", "gl-1", { path: fixture }));
    expect(clean.status).toBe("ok");
    expect(clean.output).not.toContain("secret.txt");
    expect(clean.output).not.toContain("notes.log");

    const unfiltered = await executeDispatch(
      host,
      frameOf("glob", "gl-2", { path: fixture, gitignore: false }),
    );
    expect(unfiltered.status).toBe("ok");
    expect(unfiltered.output).toContain("notes.log");
  });

  test("limit caps the page and reports resultLimitReached", async () => {
    // detail-level assertion: direct tool call keeps GlobToolDetails typed
    const glob = new GlobToolClass(host.session as never);
    const result = await glob.execute("gl-3", { path: join(fixture, "pag"), limit: 5 });
    expect(result.isError).toBeFalsy();
    const text = result.content
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("\n");
    expect(text.split("\n").filter((line) => line.includes("page-")).length).toBe(5);
    // reached count, not a boolean (glob.ts:285 limitMeta.resultLimit?.reached)
    expect(result.details?.resultLimitReached).toBe(5);
  });

  test("zero matches report absence without claiming completeness errors", async () => {
    const result = await executeDispatch(
      host,
      frameOf("glob", "gl-4", {
        path: join(fixture, "pag"),
        patternPlaceholder: undefined,
        limit: 200,
      }),
    );
    expect(result.status).toBe("ok");
    // pattern rides inside `path` (glob.ts parseFindPattern): a no-hit glob narrows to nothing.
    const none = await executeDispatch(
      host,
      frameOf("glob", "gl-5", { path: join(fixture, "pag/nope-*.zz") }),
    );
    expect(none.status).toBe("ok");
    expect(none.output).toContain("No files found matching pattern");
  });

  test("glob timeout = success + truncation notice, never a throw", async () => {
    // GlobToolOptions.timeoutMs is a construction-time knob (glob.ts:119) —
    // inject a tiny budget plus an engine stub that streams two matches then
    // rejects on the combined signal exactly like the native walker does
    // (TimeoutError, "Aborted: Timeout" message — the shapes glob.ts:466-478
    // branches on). The REAL tool code then drains the partials and renders
    // the truncation notice instead of throwing.
    const slowGlob = (
      options: { signal?: AbortSignal },
      onMatch: (err: Error | null, match: { path: string; mtime?: number }) => void,
    ): Promise<never> =>
      new Promise<never>((_resolve, reject) => {
        onMatch(null, { path: join("src", "late-a.ts"), mtime: 5 });
        onMatch(null, { path: join("src", "late-b.ts"), mtime: 3 });
        options.signal?.addEventListener(
          "abort",
          () => {
            const abort = new Error("Aborted: Timeout");
            abort.name = "TimeoutError";
            reject(abort);
          },
          { once: true },
        );
      });
    const glob = new GlobToolClass(host.session as never, {
      timeoutMs: 30,
      nativeGlob: slowGlob as unknown as Natives.glob,
    });
    const result = await glob.execute("gl-timeout", { path: fixture });
    expect(result.isError).toBeFalsy();
    const text = result.content
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("\n");
    // 30ms renders through the non-integral branch: (30/1000).toFixed(1) = "0.0".
    expect(text).toContain("glob timed out after 0.0s; returning 2 partial matches");
    expect(text).toContain("results are incomplete");
    expect(text).toContain("late-a.ts");
    expect(result.details?.truncated).toBe(true);
  });

  test("timed-out zero-match scan is never claimed as verified absence", async () => {
    const silentGlob = (
      options: { signal?: AbortSignal },
      _onMatch: (err: Error | null, match: { path: string; mtime?: number }) => void,
    ): Promise<never> =>
      new Promise<never>((_resolve, reject) => {
        options.signal?.addEventListener(
          "abort",
          () => {
            const abort = new Error("Aborted: Timeout");
            abort.name = "TimeoutError";
            reject(abort);
          },
          { once: true },
        );
      });
    const glob = new GlobToolClass(host.session as never, {
      timeoutMs: 30,
      nativeGlob: silentGlob as unknown as Natives.glob,
    });
    const result = await glob.execute("gl-timeout-empty", { path: fixture });
    expect(result.isError).toBeFalsy();
    const text = result.content
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("\n");
    expect(text).toContain("the scan is incomplete, NOT proof of absence");
    expect(text).not.toContain("No files found");
  });
});

describe("grep (T7 #97)", () => {
  test("skip pagination: page one names the next skip, page two is terminal, skip is idempotent", async () => {
    const pageOne = await executeDispatch(
      host,
      frameOf("grep", "gr-1", { pattern: "PageNeedle", path: join(fixture, "pag") }),
    );
    expect(pageOne.status).toBe("ok");
    expect(pageOne.output).toContain(`Showing files 1-20 of ${PAGES}`);
    expect(pageOne.output).toContain("Use skip=20 for the next page");

    const pageTwo = await executeDispatch(
      host,
      frameOf("grep", "gr-2", { pattern: "PageNeedle", path: join(fixture, "pag"), skip: 20 }),
    );
    expect(pageTwo.status).toBe("ok");
    // Terminal page: the window holds the remaining 5 files, so no next-page
    // hint — the "Showing files … of …" message only renders when the 20-file
    // window truncates (grep.ts:753 fileLimitReached).
    expect(pageTwo.output).toContain("page-21");
    expect(pageTwo.output).toContain("page-25");
    expect(pageTwo.output).not.toContain("Use skip=");

    const pageTwoAgain = await executeDispatch(
      host,
      frameOf("grep", "gr-3", { pattern: "PageNeedle", path: join(fixture, "pag"), skip: 20 }),
    );
    expect(pageTwoAgain.output).toBe(pageTwo.output);
  });

  test("skip past the end is an explicit empty page, not an error", async () => {
    const result = await executeDispatch(
      host,
      frameOf("grep", "gr-4", { pattern: "PageNeedle", path: join(fixture, "pag"), skip: 999 }),
    );
    expect(result.status).toBe("ok");
    expect(result.output).toContain(
      `No more results (${PAGES} files total; skip=999 is past the end)`,
    );
  });

  test("multi-file per-file match cap keeps a hot file at 20", async () => {
    // detail-level assertion: direct tool call keeps GrepToolDetails typed
    const grep = new GrepToolClass(host.session as never);
    const result = await grep.execute("gr-5", {
      pattern: "HotNeedle",
      path: join(fixture, "caps"),
    });
    expect(result.isError).toBeFalsy();
    expect(result.details?.matchCount).toBe(21); // 20 from hot.txt + 1 from other.txt
    const text = result.content
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("\n");
    expect(text).not.toContain("HotNeedle 21\n");
    expect(text).toContain("HotNeedle lone");
  });

  test("single-file scope raises the per-file cap to 200", async () => {
    const grep = new GrepToolClass(host.session as never);
    const result = await grep.execute("gr-6", {
      pattern: "SingleNeedle",
      path: join(fixture, "big.txt"),
    });
    expect(result.isError).toBeFalsy();
    expect(result.details?.matchCount).toBe(200);
  });

  test("gitignore respected by default, disableable per call", async () => {
    const clean = await executeDispatch(
      host,
      frameOf("grep", "gr-7", { pattern: "LogNeedle", path: fixture }),
    );
    expect(clean.status).toBe("ok");
    expect(clean.output).toContain("No matches found");

    const unfiltered = await executeDispatch(
      host,
      frameOf("grep", "gr-8", { pattern: "LogNeedle", path: fixture, gitignore: false }),
    );
    expect(unfiltered.status).toBe("ok");
    expect(unfiltered.output).toContain("LogNeedle");
  });

  test("unparseable regex degrades to a no-match result, never a crash", async () => {
    // Observed native-engine behavior: the vendored grep treats patterns the
    // engine refuses to compile as no-matches ("No matches found"). The
    // regex-parse-error ToolError branch (grep.ts:634-635) guards engine
    // builds that do surface parse errors.
    const result = await executeDispatch(
      host,
      frameOf("grep", "gr-9", { pattern: "([unclosed", path: fixture }),
    );
    expect(result.status).toBe("ok");
    expect(result.output).toContain("No matches found");
  });

  test("re-send of a read-only dispatch is byte-identical (no hidden state)", async () => {
    const args = { pattern: "PageNeedle", path: join(fixture, "pag"), skip: 5 };
    const first = await executeDispatch(host, frameOf("grep", "gr-10a", args));
    const second = await executeDispatch(host, frameOf("grep", "gr-10b", args));
    expect(second.status).toBe(first.status);
    expect(second.output).toBe(first.output);
  });

  test("native grep timeout surfaces the 'Aborted: Timeout' shape the tool maps to a 30s throw", async () => {
    // grep's 30s wall is a module constant (grep.ts:93 SEARCH_GREP_TIMEOUT_MS,
    // no construction override) and its throw branch (grep.ts:637-641,
    // "Grep timed out after 30s; narrow paths or pattern...") is a pure
    // message-match on the engine error. Drive the REAL engine past a 1ms
    // budget over the pnpm store backing the vendored runtime (30k+ real
    // files) to pin that error shape; the tool-level 30s text is
    // anchor-pinned here instead of a 30-second test. The tree must be
    // GENUINELY large: this pin originally grepped this test's own directory
    // (~26 files) under a ">4k files" premise, and a fast CI runner walked
    // it in under 1ms — the budget never tripped and the pin failed
    // (surface running #182).
    try {
      await Natives.grep({
        pattern: "export",
        path: join(import.meta.dir, "..", "..", "..", "node_modules", ".pnpm"),
        timeoutMs: 1,
        // The store lives under a gitignored node_modules; the walker's
        // default filter would refuse the ignored root outright.
        gitignore: false,
      });
      // Cannot realistically walk 30k+ files in 1ms; if it ever does, walk
      // budget moved by orders of magnitude and this pin must be revisited.
      throw new Error(
        "native grep finished within 1ms over the vendored tree — engine contract changed",
      );
    } catch (error) {
      expect((error as Error).message).toContain("Aborted: Timeout");
    }
  });
});
