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

  // The bare REPLY from the #529 four-round root cause (PM wire repro
  // 2026-10-08): real provider class + real renderJudgmentPrompt on
  // glm-5.3-flash answers a single-passage batch with a bare "YES" — no
  // `p00:` line — so the id-line split parses nothing and every batch
  // scores judged 0 → "[tool error]".
  const bare = (text: string): TextCompletionResult => ({
    text,
    usage: {
      inputTokens: 500,
      outputTokens: 5,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      contextWindow: 32_768,
      estimated: false,
    },
  });

  /** The single-passage production shape: one batch, one asked passage. */
  function singleBatchPayload(): FindExecPayload {
    return payloadFixture({
      files: [{ rel: "src/session.ts", totalLines: 80, truncated: true }],
      batches: [
        {
          rel: "src/session.ts",
          system: "SYS-session",
          user: "STATE-session p00",
          passages: [
            { key: "p00", start: 5, end: 9, snippet: "class SessionManager", bytes: 200 },
          ],
        },
      ],
    });
  }

  test("bare-answer tolerance: a single-passage batch judges from a bare YES/NO (#529)", async () => {
    const yes = await runFindJudged(
      { query: "login flow" },
      ctxFixture(singleBatchPayload(), () => bare("YES")),
    );
    expect(yes.status).toBe("ok");
    expect(yes.output).toContain("judged 1 ·");
    expect(yes.output).toContain('1 hit(s) for "login flow"');
    expect(yes.output).toContain("src/session.ts  1.00  5 lines judged, partial");
    expect(yes.output).toContain("src/session.ts:5-9  1.00  class SessionManager");

    const no = await runFindJudged(
      { query: "login flow" },
      ctxFixture(singleBatchPayload(), () => bare("no")),
    );
    expect(no.status).toBe("ok");
    expect(no.output).toContain("judged 1 ·");
    expect(no.output).toContain('no hits for "login flow" (τ 0.20)');
    expect(no.output).not.toContain("requests failed");
  });

  test("bare-answer tolerance composes with the think-leak sanitize (#529)", async () => {
    const result = await runFindJudged(
      { query: "login flow" },
      ctxFixture(singleBatchPayload(), () => bare("the passage matches the request.</think>YES")),
    );
    expect(result.status).toBe("ok");
    expect(result.output).toContain("judged 1 ·");
    expect(result.output).toContain('1 hit(s) for "login flow"');
  });

  test("multi-passage batches stay strict: a bare verdict is not applied (#529)", async () => {
    const login = payloadFixture().batches[0];
    if (login === undefined) throw new Error("fixture lost its multi-passage batch");
    const result = await runFindJudged(
      { query: "login flow" },
      ctxFixture(
        payloadFixture({
          files: [{ rel: "src/login.ts", totalLines: 40, truncated: false }],
          batches: [login],
        }),
        () => bare("YES"),
      ),
    );
    // Tolerance is single-passage only: a bare "YES" is ambiguous across
    // two asked passages, so nothing parses → judged 0 + the zero-parse
    // evidence row with the raw reply.
    expect(result.output).toContain("judged 0 ·");
    expect(result.output).toContain("parse miss (src/login.ts): YES");
    expect(result.output).not.toContain("hit(s)");
  });

  test("zero-parse self-evidence: excerpt, whitespace collapse, 160 cap, empty marker (#529)", async () => {
    const run = (text: string) =>
      runFindJudged({ query: "login flow" }, ctxFixture(singleBatchPayload(), () => bare(text)));

    // Prose without a verdict word: the one request failed → the error
    // face + the excerpt row (the #524 "parse miss only counts" gap closed).
    const prose = await run("The passage seems unrelated to the request at hand.");
    expect(prose.status).toBe("error");
    expect(prose.output).toContain("1 of 1 requests failed:");
    expect(prose.output).toContain(
      "parse miss (src/session.ts): The passage seems unrelated to the request at hand.",
    );

    // Newlines/tabs collapse so the row stays one report line.
    const collapsed = await run("unsure\n  about\tthis one");
    expect(collapsed.output).toContain("parse miss (src/session.ts): unsure about this one");

    // Capped at 160 collapsed characters; the tail never renders.
    const long = "filler ".repeat(40);
    const capped = await run(long);
    const whole = long.trim().replace(/\s+/g, " ");
    expect(whole.length).toBeGreaterThan(160);
    expect(capped.output).toContain(`parse miss (src/session.ts): ${whole.slice(0, 160)}`);
    expect(capped.output).not.toContain(whole);

    // Empty replies (including a think-only leak cut) mark explicitly.
    const empty = await run("");
    expect(empty.status).toBe("error");
    expect(empty.output).toContain("parse miss (src/session.ts): empty reply");
    const thinkOnly = await run("reasoning about the passage...</think>");
    expect(thinkOnly.output).toContain("parse miss (src/session.ts): empty reply");
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
