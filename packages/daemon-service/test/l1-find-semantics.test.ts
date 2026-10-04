import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FindTool } from "@oh-my-pi/pi-coding-agent/tools/jfind";
import type { runCascade } from "@oh-my-pi/pi-coding-agent/tools/jfind/cascade";
import type { resolveSearchRoot } from "@oh-my-pi/pi-coding-agent/tools/jfind/tree";
import type { InternalUrlFilesystem } from "@oh-my-pi/pi-coding-agent/internal-urls/url-filesystem";
import type { sessionResolveContext } from "@oh-my-pi/pi-coding-agent/internal-urls/context";
import {
  createToolHost,
  executeDispatch,
  type ToolDispatchFrame,
  type ToolHost,
} from "../src/client/tool-runtime.js";

/**
 * L1 per-tool semantics for find (M1.5/T11 #101) — the vendored omp jfind
 * cascade + judgment chain through real execute(). Card 交付/验收 anchors:
 *   - judge 失败降级语义：judge.judge 拒绝在 cascade #ask 被捕（cascade.ts:148-153），
 *     条目留未判、`E of R requests failed:` footer（jfind/index.ts:146-151）、
 *     全部失败才 isError（index.ts:153）；失败不抛错（cascade.ts:358 doc contract）
 *   - 重发重烧 judge：无去重（矩阵 §2.1 find 行；Bun 测试运行时 sharedJudgmentCache
 *     返回 undefined，cache.ts:109）——同帧两次各烧一遍并各自出 footer
 *   - 预算超时类型化：20s 总预算 ToolError "find timed out after 20s"
 *     （jfind/index.ts:38,113 —— 20s 墙钟不进单测，锚 pin）；caller abort 逐字
 *     传播出 runCascade（cascade.ts:149 throwIfAborted），adapter 投影 status=timeout
 */

const MACHINE = "machine-l1-find";

let root: string;
let fixture: string;
let host: ToolHost;
// omp loads lazily — the FIRST omp import in the bun process freezes the
// agent-dir resolver, so every VALUE import here stays dynamic and runs after
// createToolHost has pinned PI_CODING_AGENT_DIR (tool-runtime.ts runtime
// discipline; a static import breaks the T6 isolation tests).
let FindToolClass: typeof FindTool;
let RunCascade: typeof runCascade;
let ResolveSearchRoot: typeof resolveSearchRoot;
let InternalUrlFilesystemClass: typeof InternalUrlFilesystem;
let SessionResolveContext: typeof sessionResolveContext;

function frameOf(
  tool: string,
  executionId: string,
  args: Record<string, unknown>,
  timeoutMs = 10_000,
): ToolDispatchFrame {
  return { tool, arguments: args, executionId, machineId: MACHINE, timeoutMs };
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "omp-find-l1-"));
  fixture = join(root, "workspace");
  mkdirSync(join(fixture, "src"), { recursive: true });
  writeFileSync(
    join(fixture, "src", "login.ts"),
    ["export function loginUser(name: string) {", "  return `session for ${name}`;", "}"].join(
      "\n",
    ),
  );
  writeFileSync(
    join(fixture, "src", "logout.ts"),
    ["export function logoutUser(session: string) {", "  session.length = 0;", "}"].join("\n"),
  );
  writeFileSync(join(fixture, "notes.md"), "plain documentation, no code\n");
  host = await createToolHost(fixture, join(root, "omp-agent"), MACHINE);
  ({ FindTool: FindToolClass } = await import("@oh-my-pi/pi-coding-agent/tools/jfind"));
  ({ runCascade: RunCascade } = await import("@oh-my-pi/pi-coding-agent/tools/jfind/cascade"));
  ({ resolveSearchRoot: ResolveSearchRoot } =
    await import("@oh-my-pi/pi-coding-agent/tools/jfind/tree"));
  ({ InternalUrlFilesystem: InternalUrlFilesystemClass } =
    await import("@oh-my-pi/pi-coding-agent/internal-urls/url-filesystem"));
  ({ sessionResolveContext: SessionResolveContext } =
    await import("@oh-my-pi/pi-coding-agent/internal-urls/context"));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("find wiring (T11 #101)", () => {
  test("the host carries find; dispatch without a provider channel degrades with the precise ToolError", async () => {
    expect(host.tools.find?.name).toBe("find");
    const result = await executeDispatch(
      host,
      frameOf("find", "fd-1", { query: "login flow", grep_keywords: ["login"] }),
    );
    expect(result.status).toBe("error");
    expect(result.output).toContain("find has no model registry to resolve a judge from");
  });
});

describe("judge failure degradation through the real chain (T11 #101)", () => {
  /** Real Settings + a registry whose judge role resolves to zero candidates. */
  function judgelessTool(): FindTool {
    const session = { ...host.session, modelRegistry: { getAvailable: () => [] } };
    return new FindToolClass(session as never);
  }

  test("zero judge candidates: cascade completes unjudged, footer reports every failure, all-failed marks isError", async () => {
    const result = await judgelessTool().execute("fd-2", {
      query: "login flow",
      grep_keywords: ["login"],
    });
    expect(result.isError).toBe(true);
    const text = result.content
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("\n");
    // The typed chain failure, phase-prefixed by the cascade.
    expect(text).toContain("judgment: no judge model available");
    // Footer + failure block: `E of R requests failed:` with R > 0.
    expect(text).toMatch(/\d+ of \d+ requests failed:/);
    expect(text).toMatch(/· \d+ requests · \d+ tokens · \$\d+\.\d{4} ·/);
    expect(text).toContain('no hits for "login flow"');
  });

  test("resend re-burns the judge — same request count twice, no dedup", async () => {
    const first = await judgelessTool().execute("fd-3a", {
      query: "login flow",
      grep_keywords: ["login"],
    });
    const second = await judgelessTool().execute("fd-3b", {
      query: "login flow",
      grep_keywords: ["login"],
    });
    const requestsOf = (result: { content: { type: string; text?: string }[] }): number => {
      const text = result.content
        .map((block) => (block.type === "text" ? block.text : ""))
        .join("\n");
      const match = /· (\d+) requests ·/.exec(text);
      if (match === null) throw new Error(`no request counter in find output: ${text}`);
      return Number(match[1]);
    };
    expect(first.isError).toBe(true);
    expect(second.isError).toBe(true);
    const burned = requestsOf(first);
    expect(burned).toBeGreaterThan(0);
    expect(requestsOf(second)).toBe(burned);
  });

  test("a lexical-only scope with zero eligible files reports useless, not error", async () => {
    const emptyRoot = join(root, "empty");
    mkdirSync(emptyRoot, { recursive: true });
    const session = { ...host.session, cwd: emptyRoot, modelRegistry: { getAvailable: () => [] } };
    const result = await new FindToolClass(session as never).execute("fd-4", {
      query: "anything",
      grep_keywords: [],
    });
    // stats.requests === 0 → the all-failed isError gate stays off.
    expect(result.isError).toBeFalsy();
    const text = result.content
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("\n");
    expect(text).toContain('no hits for "anything"');
  });
});

describe("budget timeout propagation (T11 #101)", () => {
  test("caller abort propagates out of runCascade verbatim (the 20s ToolError branch's other half)", async () => {
    // The tool's own 20s budget (jfind/index.ts:38) is wall-clock pinned and
    // anchored, not waited out here. The cascade contract this test pins:
    // an aborted caller signal surfaces as a thrown abort — never as a
    // partial "successful" result (cascade.ts:149 throwIfAborted in #ask).
    const budget = AbortSignal.timeout(40);
    const filesystem = new InternalUrlFilesystemClass({
      context: SessionResolveContext(host.session as never, { signal: budget }),
      tier: "read",
    });
    const judgeRoot = await ResolveSearchRoot(filesystem, fixture, fixture);
    let hangReleased = false;
    const hangingJudge = {
      label: "l1-hanging-judge",
      judge: (_request: unknown, options?: { signal?: AbortSignal }): Promise<never> =>
        new Promise<never>((_resolve, reject) => {
          options?.signal?.addEventListener(
            "abort",
            () => {
              hangReleased = true;
              reject(new Error("aborted"));
            },
            { once: true },
          );
        }),
    };
    let caught: unknown;
    try {
      await RunCascade({
        root: judgeRoot,
        filesystem,
        query: "login flow",
        extraKeywords: ["login"],
        judge: hangingJudge as never,
        includeHidden: false,
        signal: budget,
      });
    } catch (error) {
      caught = error;
    }
    expect(hangReleased).toBe(true);
    expect(caught).toBeInstanceOf(Error);
    expect(budget.aborted).toBe(true);
  });
});
