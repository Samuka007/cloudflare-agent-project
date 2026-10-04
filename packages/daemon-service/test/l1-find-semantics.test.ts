import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
import { decodeAgentAuthConfig } from "../src/client/agent-auth.js";

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
  test("the host carries find and a ModelRegistry; zero credentials degrade at the chain, not the registry", async () => {
    expect(host.tools.find?.name).toBe("find");
    const result = await executeDispatch(
      host,
      frameOf("find", "fd-1", { query: "login flow", grep_keywords: ["login"] }),
    );
    // #145: createToolHost always wires the ModelRegistry — with no
    // credential configured the judge ROLE chain resolves to zero candidates
    // and the failure surfaces from the chain inside the cascade, never as
    // the old registry ToolError. The box's ambient provider channels
    // (env-tier keys / local servers) may legitimately resolve candidates —
    // so only the SEAM is pinned here, never the cascade outcome.
    expect("modelRegistry" in host.session && host.session.modelRegistry !== undefined).toBe(true);
    expect(result.output).not.toContain("find has no model registry");
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

describe("real judged cascade through the provider channel (#145)", () => {
  /**
   * Acceptance: ONE REAL judged cascade with a non-zero cost line. A local
   * mock OpenAI-compatible endpoint stands in for the upstream — the channel
   * itself is real end to end: models.yml materialized in the daemon-private
   * agentDir → ModelRegistry → judge role chain → credentialed HTTP requests
   * (the mock verifies the bearer) → billed usage → cascade cost.
   */
  const JUDGE_KEY = "test-judge-key";
  let mockServer: Bun.Server;
  let judgedRequests = 0;
  let authedRequests = 0;
  let authedHost: ToolHost;

  beforeAll(async () => {
    mockServer = Bun.serve({
      port: 0,
      fetch: async (request) => {
        if (request.headers.get("authorization") !== `Bearer ${JUDGE_KEY}`) {
          return new Response("unauthorized", { status: 401 });
        }
        authedRequests += 1;
        const body = (await request.json()) as {
          messages: { role: string; content: string }[];
          stream?: boolean;
        };
        const prompt = body.messages.map((message) => message.content).join("\n");
        // Batch shape: yes/no judgments keyed e000/p00 (text-judge.md noul
        // template — "Answer one word: YES if so; NO otherwise"); the
        // one-hot YES parses to p=1.0, above the cascade's τ cut.
        const keys = [...new Set(prompt.match(/\b(?:e\d{3}|p\d{2})\b/g) ?? [])];
        const content = keys.length > 0 ? keys.map((key) => `${key}: yes`).join("\n") : "yes";
        judgedRequests += 1;
        if (body.stream === true) {
          // The openai-completions transport streams by default (compat
          // supportsUsageInStreaming): answer SSE chunks — one content delta,
          // a terminal stop chunk carrying the billed usage, then [DONE].
          const stream = new ReadableStream({
            start(controller) {
              const encoder = new TextEncoder();
              const frame = (payload: unknown) =>
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
              frame({
                id: "mock-judged",
                object: "chat.completion.chunk",
                created: 1,
                model: "judge-mock",
                choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }],
              });
              frame({
                id: "mock-judged",
                object: "chat.completion.chunk",
                created: 1,
                model: "judge-mock",
                choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
                usage: { prompt_tokens: 220, completion_tokens: 30, total_tokens: 250 },
              });
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
              controller.close();
            },
          });
          return new Response(stream, {
            headers: { "content-type": "text/event-stream" },
          });
        }
        return Response.json({
          id: "mock-judged",
          object: "chat.completion",
          created: 1,
          model: "judge-mock",
          choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
          usage: { prompt_tokens: 220, completion_tokens: 30, total_tokens: 250 },
        });
      },
    });
    const authConfig = decodeAgentAuthConfig(
      JSON.stringify({
        providers: {
          mockrelay: {
            baseUrl: `http://127.0.0.1:${mockServer.port}/v1`,
            api: "openai-completions",
            apiKey: JUDGE_KEY,
            models: [
              {
                id: "judge-mock",
                name: "Judge Mock",
                reasoning: false,
                input: ["text"],
                contextWindow: 32_768,
                maxTokens: 4_096,
                cost: { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 },
              },
            ],
          },
        },
        judgeRole: "mockrelay/judge-mock",
      }),
    );
    // A dedicated agentDir: models.yml lands there; the registry loads it.
    authedHost = await createToolHost(fixture, join(root, "omp-agent-auth"), MACHINE, authConfig);
  });

  afterAll(() => {
    mockServer.stop(true);
  });

  test(
    "one real judged cascade: credentialed requests, judged hits, non-zero cost line",
    { timeout: 120_000 },
    async () => {
      expect(existsSync(join(root, "omp-agent-auth", "models.yml"))).toBe(true);
      const result = await executeDispatch(
        authedHost,
        frameOf("find", "fd-auth-1", { query: "login flow", grep_keywords: ["login"] }),
      );
      expect(result.status).toBe("ok");
      // Real HTTP through the channel: bearer-verified requests reached the
      // upstream and every question came back judged YES (one-hot p=1.0, the
      // τ cut sits at 0.20).
      expect(authedRequests).toBeGreaterThan(0);
      expect(judgedRequests).toBe(authedRequests);
      expect(result.output).toContain("login.ts");
      expect(result.output).toContain("1.00");
      // The acceptance line: `· N requests · T tokens · $X.XXXX · …` — a real
      // billed cascade prices non-zero.
      const cost = /\$((?!0\.0000\b)\d+\.\d{4}) /.exec(result.output);
      expect(cost).not.toBeNull();
      expect(result.output).not.toContain("requests failed");
    },
  );
});
