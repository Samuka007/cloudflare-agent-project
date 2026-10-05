/**
 * #314 — first batch of ported pi compaction scenarios (≥5 acceptance).
 *
 * Each test carries its pi anchor:
 * `pi <repo-path>:<lines> @ 98d2e1947aa9` plus the upstream scenario name.
 * The runtime under test is the vendored semantic kernel
 * (`./pi-port/compaction-kernel.ts`) — pi's compaction semantics reduced to
 * our shape vocabulary. Scenario intents are pi's, unchanged; assertions are
 * ported 1:1 unless a shape difference forces an adaptation (noted inline).
 *
 * Inventory/mapping/classification: docs/research/pi-test-asset-inventory.md.
 */

import { describe, expect, test } from "vitest";
import {
  type CompactionSettings,
  type CompactionEntry,
  DEFAULT_COMPACTION_SETTINGS,
  type MessageEntry,
  type PortEntry,
  type PortMessage,
  type PortUsage,
  buildSessionContext,
  calculateContextTokens,
  estimateContextTokens,
  findCutPoint,
  getLastAssistantUsage,
  prepareCompaction,
  serializeConversation,
  shouldCompact,
  TOOL_RESULT_MAX_CHARS,
} from "./pi-port/compaction-kernel.js";

// ---------------------------------------------------------------------------
// pi test fixtures (compaction.test.ts:42-151 @ 98d2e1947aa9), ported
// ---------------------------------------------------------------------------

function mockUsage(input: number, output: number, cacheRead = 0, cacheWrite = 0): PortUsage {
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: input + output + cacheRead + cacheWrite,
  };
}

let entryCounter = 0;

function messageEntry(message: PortMessage): MessageEntry {
  return { type: "message", id: `test-id-${entryCounter++}`, message };
}

function user(text: string): MessageEntry {
  return messageEntry({ role: "user", text });
}

function assistant(text: string, usage?: PortUsage): MessageEntry {
  return messageEntry({
    role: "assistant",
    text,
    usage: usage ?? mockUsage(100, 50),
    stopReason: "stop",
  });
}

function compaction(summary: string, firstKeptEntryId: string): CompactionEntry {
  return { type: "compaction", id: `test-id-${entryCounter++}`, summary, firstKeptEntryId };
}

// ---------------------------------------------------------------------------
// Token calculation — pi compaction.test.ts:193-202
// ---------------------------------------------------------------------------

describe("pi compaction scenarios — token calculation (pi test/compaction.test.ts:193-272)", () => {
  test("pi:194 total context tokens from usage (component sum via native=sum fixture)", () => {
    expect(calculateContextTokens(mockUsage(1000, 500, 200, 100))).toBe(1800);
  });

  test("pi:199 zero usage computes zero", () => {
    expect(calculateContextTokens(mockUsage(0, 0, 0, 0))).toBe(0);
  });

  test("pi:141 native totalTokens wins over the component sum (shape-add: provider total ≠ sum)", () => {
    expect(calculateContextTokens({ ...mockUsage(1000, 500), totalTokens: 900 })).toBe(900);
  });

  test("pi:206 last non-aborted assistant usage wins", () => {
    const entries = [
      user("Hello"),
      assistant("Hi", mockUsage(100, 50)),
      user("How are you?"),
      assistant("Good", mockUsage(200, 100)),
    ];
    expect(getLastAssistantUsage(entries)?.input).toBe(200);
  });

  test("pi:219 aborted assistant messages are skipped", () => {
    const aborted = {
      ...assistant("Aborted", mockUsage(300, 150)).message,
      stopReason: "aborted" as const,
    };
    const entries = [
      user("Hello"),
      assistant("Hi", mockUsage(100, 50)),
      user("How are you?"),
      messageEntry(aborted),
    ];
    expect(getLastAssistantUsage(entries)?.input).toBe(100);
  });

  test("pi:237 all-zero assistant usage is skipped", () => {
    const entries = [
      user("Hello"),
      assistant("Hi", mockUsage(100, 50)),
      user("continue"),
      assistant("Partial", mockUsage(0, 0)),
    ];
    expect(getLastAssistantUsage(entries)?.input).toBe(100);
  });

  test("pi:250 no assistant messages → undefined", () => {
    expect(getLastAssistantUsage([user("Hello")])).toBeUndefined();
  });

  test("pi:257 last non-zero assistant usage anchors the context estimate", () => {
    const estimate = estimateContextTokens([
      { role: "user", text: "Hello" },
      { role: "assistant", text: "Hi", usage: mockUsage(100, 50), stopReason: "stop" },
      { role: "user", text: "continue" },
      { role: "assistant", text: "Partial thinking", usage: mockUsage(0, 0), stopReason: "stop" },
    ]);
    expect(estimate.usageTokens).toBe(150);
    expect(estimate.lastUsageIndex).toBe(1);
    expect(estimate.trailingTokens).toBeGreaterThan(0);
    expect(estimate.tokens).toBe(150 + estimate.trailingTokens);
  });
});

describe("pi compaction scenarios — trigger policy (pi test/compaction.test.ts:274-295)", () => {
  const enabled: CompactionSettings = {
    enabled: true,
    reserveTokens: 10_000,
    keepRecentTokens: 20_000,
  };

  test("pi:275 context beyond window − reserve triggers", () => {
    expect(shouldCompact(95_000, 100_000, enabled)).toBe(true);
    expect(shouldCompact(89_000, 100_000, enabled)).toBe(false);
  });

  test("pi:286 disabled settings never trigger", () => {
    expect(shouldCompact(95_000, 100_000, { ...enabled, enabled: false })).toBe(false);
  });
});

describe("pi compaction scenarios — findCutPoint (pi test/compaction.test.ts:297-411)", () => {
  test("pi:298 budget cut lands on a user/assistant boundary", () => {
    const entries: PortEntry[] = [];
    for (let i = 0; i < 10; i++) {
      entries.push(user(`User ${i}`));
      entries.push(assistant(`Assistant ${i}`, mockUsage(0, 100, (i + 1) * 1000)));
    }

    const result = findCutPoint(entries, 0, entries.length, 2500);
    const cut = entries[result.firstKeptEntryIndex];
    if (cut === undefined) throw new Error("findCutPoint returned an out-of-range index");
    expect(cut.type).toBe("message");
    const role = cut.type === "message" ? cut.message.role : undefined;
    expect(role === "user" || role === "assistant").toBe(true);
  });

  test("pi:318 no valid cut points in range → startIndex", () => {
    const entries = [assistant("a")];
    expect(findCutPoint(entries, 0, entries.length, 1000).firstKeptEntryIndex).toBe(0);
  });

  test("pi:324 everything kept when history fits the budget", () => {
    const entries = [
      user("1"),
      assistant("a", mockUsage(0, 50, 500)),
      user("2"),
      assistant("b", mockUsage(0, 50, 1000)),
    ];
    expect(findCutPoint(entries, 0, entries.length, 50_000).firstKeptEntryIndex).toBe(0);
  });

  test("pi:336 split-turn bookkeeping when cutting inside a turn", () => {
    const entries: PortEntry[] = [
      user("Turn 1"),
      assistant("A1", mockUsage(0, 100, 1000)),
      user("Turn 2"),
      assistant("A2-1", mockUsage(0, 100, 5000)),
      assistant("A2-2", mockUsage(0, 100, 8000)),
      assistant("A2-3", mockUsage(0, 100, 10_000)),
    ];
    const result = findCutPoint(entries, 0, entries.length, 3000);
    const cut = entries[result.firstKeptEntryIndex];
    if (cut === undefined) throw new Error("findCutPoint returned an out-of-range index");
    if (cut.type === "message" && cut.message.role === "assistant") {
      expect(result.isSplitTurn).toBe(true);
      expect(result.turnStartIndex).toBe(2);
    }
  });

  test("pi:358 custom message entries are budget-bearing cut points", () => {
    const entries = [
      user("hi"),
      assistant("hello"),
      messageEntry({ role: "custom", text: "x".repeat(4000) }),
      assistant("ok"),
    ];

    const tinyBudget = findCutPoint(entries, 0, entries.length, 1);
    expect(tinyBudget.firstKeptEntryIndex).toBe(3);
    expect(tinyBudget.isSplitTurn).toBe(true);
    expect(tinyBudget.turnStartIndex).toBe(2);

    const customFitsBudget = findCutPoint(entries, 0, entries.length, 2);
    expect(customFitsBudget.firstKeptEntryIndex).toBe(2);
    expect(customFitsBudget.isSplitTurn).toBe(false);
    expect(customFitsBudget.turnStartIndex).toBe(-1);
  });

  test("pi:378 (upstream #9740) oversized trailing tool results fall back to the latest valid cut; the tool pair stays together", () => {
    const oldUser = user("old history");
    const oldAssistant = assistant("old answer");
    const currentUser = user("read the large file");
    const toolCall = messageEntry({
      role: "assistant",
      text: "",
      stopReason: "toolUse",
      toolCall: { name: "read", argsJson: JSON.stringify({ path: "big.txt" }) },
    });
    const toolResultEntry = messageEntry({
      role: "toolResult",
      text: "x".repeat(8000),
      toolCallId: "call-1",
    });
    const entries = [oldUser, oldAssistant, currentUser, toolCall, toolResultEntry];

    expect(findCutPoint(entries, 0, entries.length, 1000)).toEqual({
      firstKeptEntryIndex: 3,
      turnStartIndex: 2,
      isSplitTurn: true,
    });

    const preparation = prepareCompaction(entries, {
      ...DEFAULT_COMPACTION_SETTINGS,
      keepRecentTokens: 1000,
    });
    expect(preparation?.firstKeptEntryId).toBe(toolCall.id);
    expect(preparation?.messagesToSummarize).toEqual([oldUser.message, oldAssistant.message]);
    expect(preparation?.turnPrefixMessages).toEqual([currentUser.message]);
  });
});

describe("pi compaction scenarios — buildSessionContext (pi test/compaction.test.ts:414-497)", () => {
  test("pi:415 no compaction loads all messages", () => {
    const loaded = buildSessionContext([user("1"), assistant("a"), user("2"), assistant("b")]);
    expect(loaded.messages.length).toBe(4);
  });

  test("pi:429 single compaction: summary first, kept tail follows", () => {
    const u1 = user("1");
    const a1 = assistant("a");
    const u2 = user("2");
    const a2 = assistant("b");
    const comp = compaction("Summary of 1,a,2,b", u2.id);
    const entries = [u1, a1, u2, a2, comp, user("3"), assistant("c")];

    const loaded = buildSessionContext(entries);
    expect(loaded.messages.length).toBe(5);
    expect(loaded.messages[0]?.text).toContain("Summary of 1,a,2,b");
  });

  test("pi:448 multiple compactions: only the latest matters", () => {
    const u1 = user("1");
    const compact1 = compaction("First summary", u1.id);
    const u3 = user("3");
    const compact2 = compaction("Second summary", u3.id);
    const entries = [
      u1,
      assistant("a"),
      compact1,
      user("2"),
      assistant("b"),
      u3,
      assistant("c"),
      compact2,
      user("4"),
      assistant("d"),
    ];

    const loaded = buildSessionContext(entries);
    expect(loaded.messages.length).toBe(5);
    expect(loaded.messages[0]?.text).toContain("Second summary");
  });

  test("pi:471 firstKeptEntryId at the first entry keeps everything under the summary", () => {
    const u1 = user("1");
    const entries = [
      u1,
      assistant("a"),
      compaction("First summary", u1.id),
      user("2"),
      assistant("b"),
    ];
    expect(buildSessionContext(entries).messages.length).toBe(5);
  });
});

describe("pi compaction scenarios — prepareCompaction (pi test/compaction.test.ts:500-565)", () => {
  test("pi:501 system messages are not conversation history", () => {
    const system = messageEntry({ role: "system", text: "" });
    const userEntry = user("one long turn");
    const assistantEntry = assistant("assistant suffix");
    const preparation = prepareCompaction([system, userEntry, assistantEntry], {
      ...DEFAULT_COMPACTION_SETTINGS,
      keepRecentTokens: 1,
    });

    expect(preparation?.firstKeptEntryId).toBe(assistantEntry.id);
    expect(preparation?.isSplitTurn).toBe(true);
    expect(preparation?.messagesToSummarize).toEqual([]);
    expect(preparation?.turnPrefixMessages).toEqual([userEntry.message]);
  });

  test("pi:524 repeated compaction skipped when kept messages still fit", () => {
    const u2 = user("user msg 2 - kept by compaction1");
    const comp1 = compaction("First summary", u2.id);
    const entries = [
      user("user msg 1 (summarized by compaction1)"),
      assistant("assistant msg 1"),
      u2,
      assistant("assistant msg 2"),
      user("user msg 3 - kept by compaction1"),
      assistant("assistant msg 3", mockUsage(5000, 1000)),
      comp1,
      user("user msg 4 (new after compaction1)"),
      assistant("assistant msg 4", mockUsage(8000, 2000)),
    ];

    expect(prepareCompaction(entries, DEFAULT_COMPACTION_SETTINGS)).toBeUndefined();
  });

  test("pi:541 previously kept messages re-summarize when the recent window moves past them", () => {
    const u2 = user("user msg 2 - kept by compaction1 ".repeat(12));
    const comp1 = compaction("First summary", u2.id);
    const entries = [
      user("user msg 1 (summarized by compaction1)".repeat(4)),
      assistant("assistant msg 1".repeat(4)),
      u2,
      assistant("assistant msg 2 ".repeat(12)),
      user("user msg 3 - kept by compaction1 ".repeat(12)),
      assistant("assistant msg 3 ".repeat(12), mockUsage(5000, 1000)),
      comp1,
      user("user msg 4 (new after compaction1) ".repeat(12)),
      assistant("assistant msg 4 ".repeat(12), mockUsage(8000, 2000)),
    ];
    const settings: CompactionSettings = { ...DEFAULT_COMPACTION_SETTINGS, keepRecentTokens: 100 };

    const preparation = prepareCompaction(entries, settings);
    const summarized = (preparation?.messagesToSummarize ?? [])
      .map((message) => message.text)
      .join("\n");
    expect(summarized).toContain("user msg 2 - kept by compaction1");
    expect(summarized).toContain("user msg 3 - kept by compaction1");
    expect(summarized).not.toContain("First summary");
    expect(preparation?.previousSummary).toBe("First summary");
  });
});

describe("pi compaction scenarios — summary serialization (pi test/compaction-serialization.test.ts:5-79)", () => {
  test("pi:6 long tool results truncate at TOOL_RESULT_MAX_CHARS with an explicit marker", () => {
    const long = "x".repeat(5000);
    const result = serializeConversation([{ role: "toolResult", text: long, toolCallId: "tc1" }]);
    expect(result).toContain("[Tool result]:");
    expect(result).toContain("[... 3000 more characters truncated]");
    expect(result).not.toContain("x".repeat(3000));
    expect(result).toContain("x".repeat(2000));
    expect(TOOL_RESULT_MAX_CHARS).toBe(2000);
  });

  test("pi:28 short tool results ride whole", () => {
    const short = "x".repeat(1500);
    const result = serializeConversation([{ role: "toolResult", text: short, toolCallId: "tc1" }]);
    expect(result).toBe(`[Tool result]: ${short}`);
    expect(result).not.toContain("truncated");
  });

  test("pi:47 user and assistant text never truncates", () => {
    const long = "y".repeat(5000);
    const result = serializeConversation([
      { role: "user", text: long },
      { role: "assistant", text: long, usage: mockUsage(0, 0), stopReason: "stop" },
    ]);
    expect(result).not.toContain("truncated");
    expect(result).toContain(long);
  });
});
