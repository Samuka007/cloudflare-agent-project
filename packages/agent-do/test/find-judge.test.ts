import { describe, expect, test } from "vitest";
import { runFindJudged } from "../src/tools/find-judge.js";
import {
  parseFindNoulReply,
  splitFindAnswerLines,
  type FindExecPayload,
} from "../src/tools/find-protocol.js";
import type { TextCompletionRequest, TextCompletionResult } from "../src/provider.js";

/**
 * The find judge leg (#523): the edge half of the composite find. The host
 * execution payload is a FIXTURE (the daemon-side cascade pins its own L1);
 * these tests pin the judge leg's product face end to end through the mock
 * relay: judge-ranked hits with merged heat ranges, the omp report shape
 * and footer, the degradation ladder (all-failed = error, partial =
 * failures block, zero batches = no-hits), and footer pricing from the
 * resolved row's declared cost.
 */

function payloadFixture(overrides: Partial<FindExecPayload> = {}): FindExecPayload {
  return {
    v: 1,
    query: "login flow",
    keywords: ["login", "flow"],
    threshold: 0.2,
    files: [
      { rel: "src/login.ts", totalLines: 40, truncated: false },
      { rel: "src/session.ts", totalLines: 80, truncated: true },
    ],
    batches: [
      {
        rel: "src/login.ts",
        system: "SYS-login",
        user: "STATE-login p00 p01",
        passages: [
          { key: "p00", start: 3, end: 10, snippet: "export function loginUser()", bytes: 300 },
          { key: "p01", start: 12, end: 14, snippet: "session.save()", bytes: 100 },
        ],
      },
      {
        rel: "src/session.ts",
        system: "SYS-session",
        user: "STATE-session p00",
        passages: [{ key: "p00", start: 5, end: 9, snippet: "class SessionManager", bytes: 200 }],
      },
    ],
    stats: {
      listed: 120,
      filesRead: 20,
      fileBytes: 50_000,
      mapCards: 90,
      windowsPruned: 50,
      elapsedMs: 120,
    },
    cwd: "/ws",
    ...overrides,
  };
}

function ctxFixture(
  payload: FindExecPayload,
  answers: (request: TextCompletionRequest) => TextCompletionResult | Promise<never>,
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number },
) {
  return {
    execHost: () => Promise.resolve({ status: "ok", output: JSON.stringify(payload) }),
    judge: (request: TextCompletionRequest) => Promise.resolve(answers(request)),
    ...(cost !== undefined ? { cost } : {}),
  };
}

/** A noul reply line per asked key: `key: yes` / `key: no` (omp protocol). */
function yesNo(request: TextCompletionRequest, yesKeys: string[]): TextCompletionResult {
  const keys = [...request.user.matchAll(/\b(p\d{2})\b/g)].map((match) => match[1] ?? "p00");
  const lines = [...new Set(keys)].map((key) => `${key}: ${yesKeys.includes(key) ? "yes" : "no"}`);
  return {
    text: lines.join("\n"),
    usage: {
      inputTokens: 500,
      outputTokens: 20,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      contextWindow: 32_768,
      estimated: false,
    },
  };
}

describe("find judge leg (#523)", () => {
  // The leaked REPLY from the #529 root-cause reproduction (PM isolation
  // run): newapi's glm-5.3-flash leaks its thinking text into output_text
  // even with effort:none, and the answer lines glue right after
  // "</think>" with no newline — the production judged-0 face (CT142).
  const leakedReply =
    "the passage mentions find but does not implement it. Answer: no.</think>p00: no\np01: no";

  test("glm think-leak: the raw reply parses only p01; the post-think tail parses both (#529)", () => {
    // Before the strip the glued line is line-granular: its first
    // separator yields a prose id, so p00 is welded to the thinking tail
    // and never matches — only p01 survives.
    expect([...splitFindAnswerLines(leakedReply, ["p00", "p01"]).keys()]).toEqual(["p01"]);
    // The consumption-point sanitize takes the post-think tail.
    const judgeText = leakedReply.includes("</think>")
      ? leakedReply.slice(leakedReply.lastIndexOf("</think>") + "</think>".length)
      : leakedReply;
    const answers = splitFindAnswerLines(judgeText, ["p00", "p01"]);
    expect([...answers.keys()].sort()).toEqual(["p00", "p01"]);
    for (const reply of answers.values()) {
      expect(parseFindNoulReply(reply)).toBe(false);
    }
  });

  test("glm think-leak: sanitized judge text still judges every passage (#529)", async () => {
    const result = await runFindJudged(
      { query: "login flow" },
      ctxFixture(payloadFixture(), () => ({
        text: leakedReply,
        usage: {
          inputTokens: 500,
          outputTokens: 66,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          contextWindow: 32_768,
          estimated: false,
        },
      })),
    );
    // Pre-fix both batches lost their glued p00 → errors === requests →
    // "[tool error] no hits". Post-fix every passage parses (all "no").
    expect(result.status).toBe("ok");
    expect(result.output).not.toContain("[tool error]");
    expect(result.output).toContain('no hits for "login flow" (τ 0.20)');
    expect(result.output).toContain("judged 3 ·");
  });

  test("judged ranking: hits strongest first, merged heat ranges, omp report shape", async () => {
    const result = await runFindJudged(
      { query: "login flow", grep_keywords: ["login"] },
      ctxFixture(payloadFixture(), (request) => {
        if (request.system === "SYS-login") return yesNo(request, ["p00"]);
        return yesNo(request, ["p00"]);
      }),
    );
    expect(result.status).toBe("ok");
    const lines = result.output.split("\n");
    expect(lines[0]).toBe('2 hit(s) for "login flow" (τ 0.20), strongest first');
    // Both files scored 1.00; the tie preserves fold order — pin the shape.
    // lines judged < the file's total → the omp "partial" coverage flag.
    expect(result.output).toContain("src/login.ts  1.00  11 lines judged, partial");
    // Merged heat: p00 (3-10, yes) rides; p01 (12-14, no) does not — the
    // merged span is 3-10 at p=1.00 with the host-computed snippet.
    expect(result.output).toContain("src/login.ts:3-10  1.00  export function loginUser()");
    expect(result.output).not.toContain("src/login.ts:12-14");
    // The unjudged-negative passage still counts toward lines judged.
    expect(result.output).toContain("src/session.ts  1.00  5 lines judged, partial");
    // Footer: host stats + judge usage, shape-verbatim with the host face.
    expect(result.output).toContain(
      "listed 120 · judged 3 · read 20 files (49.4 KB) · 2 requests · 1,040 tokens · $0.0000",
    );
  });

  test("threshold cut: a file whose best passage is NO is not a hit", async () => {
    const result = await runFindJudged(
      { query: "login flow" },
      ctxFixture(payloadFixture(), (request) =>
        request.system === "SYS-login" ? yesNo(request, ["p00"]) : yesNo(request, []),
      ),
    );
    expect(result.status).toBe("ok");
    expect(result.output).toContain('1 hit(s) for "login flow"');
    expect(result.output).toContain("src/login.ts");
    expect(result.output).not.toContain("src/session.ts");
  });

  test("zero batches: the honest no-hits line, zero judge requests", async () => {
    const payload = payloadFixture({ batches: [], files: [] });
    let judgeCalls = 0;
    const result = await runFindJudged(
      { query: "login flow" },
      {
        execHost: () => Promise.resolve({ status: "ok", output: JSON.stringify(payload) }),
        judge: () => {
          judgeCalls += 1;
          throw new Error("must not dial");
        },
      },
    );
    expect(result.status).toBe("ok");
    expect(result.output).toContain('no hits for "login flow" (τ 0.20)');
    expect(result.output).toContain("0 requests");
    expect(judgeCalls).toBe(0);
  });

  test("all judge calls failed: structured error + failures block", async () => {
    const result = await runFindJudged(
      { query: "login flow" },
      {
        execHost: () => Promise.resolve({ status: "ok", output: JSON.stringify(payloadFixture()) }),
        judge: () => {
          throw new Error("relay connect failed: dns");
        },
      },
    );
    expect(result.status).toBe("error");
    expect(result.output).toContain("2 of 2 requests failed:");
    expect(result.output).toContain("verification: relay connect failed: dns");
  });

  test("partial failure: surviving answers still rank, failures reported", async () => {
    let calls = 0;
    const result = await runFindJudged(
      { query: "login flow" },
      {
        execHost: () => Promise.resolve({ status: "ok", output: JSON.stringify(payloadFixture()) }),
        judge: (request) => {
          calls += 1;
          if (calls === 1) return Promise.resolve(yesNo(request, ["p00"]));
          throw new Error("stream broke");
        },
      },
    );
    expect(result.status).toBe("ok");
    expect(result.output).toContain('1 hit(s) for "login flow"');
    expect(result.output).toContain("1 of 2 requests failed:");
  });

  test("unpriced rows print $0.0000; priced rows use the resolved cost", async () => {
    const priced = await runFindJudged(
      { query: "login flow" },
      ctxFixture(payloadFixture(), (request) => yesNo(request, ["p00"]), {
        input: 3,
        output: 15,
        cacheRead: 0,
        cacheWrite: 0,
      }),
    );
    // 2 batches × (500 input + 20 output): $0.0036 at the declared rates.
    expect(priced.output).toContain("· $0.0036 ·");
  });

  test("host leg failures ride through as structured find errors", async () => {
    const offline = await runFindJudged(
      { query: "login flow" },
      {
        execHost: () =>
          Promise.resolve({
            status: "error",
            exitCode: null,
            output: "host_offline: no live daemon session for the find execution leg",
          }),
        judge: () => {
          throw new Error("must not dial");
        },
      },
    );
    expect(offline.status).toBe("error");
    expect(offline.output).toContain("host_offline");

    const corrupt = await runFindJudged(
      { query: "login flow" },
      {
        // Valid JSON, wrong shape → the zod boundary refuses.
        execHost: () => Promise.resolve({ status: "ok", exitCode: 0, output: '{"v":2}' }),
        judge: () => {
          throw new Error("must not dial");
        },
      },
    );
    expect(corrupt.status).toBe("error");
    expect(corrupt.output).toContain("unreadable candidate payload");
  });

  test("empty query fails like the omp tool contract", async () => {
    const result = await runFindJudged(
      { query: "   " },
      {
        execHost: () => {
          throw new Error("must not dispatch");
        },
        judge: () => {
          throw new Error("must not dial");
        },
      },
    );
    expect(result.status).toBe("error");
    expect(result.output).toBe("`query` must be a non-empty description");
  });
});
