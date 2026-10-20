import { env } from "cloudflare:workers";
import type { ThreadEventEnvelope } from "@cap/protocol";
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { foldPendingBadge } from "../src/pending";
import { readPendingPushes } from "./support";
import type { TestDurableAgentDO } from "./worker";

/** A minimal journal envelope for the ask channel's interaction vocabulary. */
function interactionRow(
  id: string,
  seq: number,
  type: string,
  data: Record<string, unknown>,
  createdAt: number,
): ThreadEventEnvelope {
  return { id, threadId: "thread-x", seq, type, data, createdAt };
}

describe("foldPendingBadge", () => {
  it("answers null for a journal with no interaction rows — nothing has ever flipped", () => {
    expect(foldPendingBadge([])).toBeNull();
    expect(
      foldPendingBadge([
        interactionRow("e1", 1, "client/thread/start", { title: "T" }, 100),
        interactionRow("e2", 2, "item/started", { turnId: "turn-1" }, 110),
      ]),
    ).toBeNull();
  });

  it("folds a registration into badge-on at the fold position", () => {
    expect(
      foldPendingBadge([
        interactionRow("e1", 1, "client/thread/start", { title: "T" }, 100),
        interactionRow("ask-1", 2, "interaction.registered", { interactionId: "ask-1" }, 200),
      ]),
    ).toEqual({ pendingSince: 200, foldSeq: 2 });
  });

  it("badges the earliest unresolved registration across interactions", () => {
    expect(
      foldPendingBadge([
        interactionRow("ask-1", 1, "interaction.registered", { interactionId: "ask-1" }, 200),
        interactionRow("ask-2", 2, "interaction.registered", { interactionId: "ask-2" }, 150),
      ]),
    ).toEqual({ pendingSince: 150, foldSeq: 2 });
  });

  it("a resolution clears the badge and advances the fold position", () => {
    expect(
      foldPendingBadge([
        interactionRow("ask-1", 1, "interaction.registered", { interactionId: "ask-1" }, 200),
        interactionRow("ask-2", 2, "interaction.registered", { interactionId: "ask-2" }, 150),
        interactionRow("res-1", 3, "interaction.resolved", { interactionId: "ask-2" }, 300),
      ]),
    ).toEqual({ pendingSince: 200, foldSeq: 3 });
    expect(
      foldPendingBadge([
        interactionRow("ask-1", 1, "interaction.registered", { interactionId: "ask-1" }, 200),
        interactionRow("res-1", 2, "interaction.resolved", { interactionId: "ask-1" }, 300),
      ]),
    ).toEqual({ pendingSince: null, foldSeq: 2 });
  });

  it("an interruption clears like a resolution; unknown ids only advance the position", () => {
    expect(
      foldPendingBadge([
        interactionRow("ask-1", 1, "interaction.registered", { interactionId: "ask-1" }, 200),
        interactionRow("int-1", 2, "interaction.interrupted", { interactionId: "ask-1" }, 250),
      ]),
    ).toEqual({ pendingSince: null, foldSeq: 2 });
    expect(
      foldPendingBadge([
        interactionRow("res-x", 1, "interaction.resolved", { interactionId: "ghost" }, 100),
      ]),
    ).toEqual({ pendingSince: null, foldSeq: 1 });
  });
});

describe("DurableAgentDO pending push-write (#591 T8)", () => {
  it("pushes the badge state on a flip and skips re-pushes of the same fold position", async () => {
    const stub = env.AGENT_DO.get(env.AGENT_DO.newUniqueId());
    await runInDurableObject(stub, async (instance: TestDurableAgentDO, state) => {
      instance.script([{ kind: "text", text: "done" }]);
      await instance.createThread({ threadId: "thread-badge", title: "T" });
      // No flips yet: creation itself never pushes.
      expect(readPendingPushes(state)).toEqual([]);

      await instance.journalRow({
        id: "ask-1",
        type: "interaction.registered",
        data: { interactionId: "ask-1" },
        createdAt: 1234,
      });
      await vi.waitFor(
        () => {
          expect(readPendingPushes(state)).toEqual([
            { threadId: "thread-badge", pendingSince: 1234, foldSeq: 2 },
          ]);
        },
        { timeout: 10_000, interval: 20 },
      );

      // An unrelated append re-folds to the same position: the watermark
      // keeps it to exactly the one push.
      await instance.journalRow({
        id: "note-1",
        type: "item/started",
        data: { turnId: "turn-1" },
        createdAt: 1300,
      });
      expect(readPendingPushes(state)).toEqual([
        { threadId: "thread-badge", pendingSince: 1234, foldSeq: 2 },
      ]);
    });
  });

  it("a DO replay re-derives the identical pair — the CAS land-nowhere contract", async () => {
    const stub = env.AGENT_DO.get(env.AGENT_DO.newUniqueId());
    await runInDurableObject(stub, async (instance: TestDurableAgentDO, state) => {
      instance.script([{ kind: "text", text: "done" }]);
      await instance.createThread({ threadId: "thread-replay", title: "T" });
      await instance.journalRow({
        id: "ask-1",
        type: "interaction.registered",
        data: { interactionId: "ask-1" },
        createdAt: 500,
      });
      await instance.journalRow({
        id: "res-1",
        type: "interaction.resolved",
        data: { interactionId: "ask-1" },
        createdAt: 600,
      });
      await vi.waitFor(
        () => {
          expect(readPendingPushes(state)).toEqual([
            { threadId: "thread-replay", pendingSince: 500, foldSeq: 2 },
            { threadId: "thread-replay", pendingSince: null, foldSeq: 3 },
          ]);
        },
        { timeout: 10_000, interval: 20 },
      );
    });

    // Eviction drops the in-memory watermark; the rehydrate fold re-derives
    // the same (pendingSince, foldSeq) pair and re-pushes it — the
    // control-plane monotonic CAS turns that into a no-op (repo pins), so a
    // replay never rewrites the row and never invents a different value.
    await evictDurableObject(stub);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    await runInDurableObject(stub, async (instance: TestDurableAgentDO, state) => {
      await vi.waitFor(
        () => {
          expect(readPendingPushes(state)).toEqual([
            { threadId: "thread-replay", pendingSince: 500, foldSeq: 2 },
            { threadId: "thread-replay", pendingSince: null, foldSeq: 3 },
            // The replay re-push: the identical final pair appended — the
            // control-plane CAS eats it, the row is never rewritten.
            { threadId: "thread-replay", pendingSince: null, foldSeq: 3 },
          ]);
        },
        { timeout: 10_000, interval: 20 },
      );
    });
  });
});
