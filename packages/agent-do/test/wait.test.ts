import { afterEach, describe, expect, test, vi } from "vitest";
import { abortAllDurableObjects, runInDurableObject } from "cloudflare:test";
import { createRig, resetRuntime, type Rig } from "./helpers.js";
import type { AgentEventDataByType, AgentEventType, AnyAgentEvent } from "../src/fsm-events.js";
import { executionIdFor } from "../src/ids.js";
import {
  NOTHING_TO_WAIT_FOR,
  WAIT_LIMIT_REACHED,
  runWaitTool,
  type WaitToolContext,
  type WaitWake,
} from "../src/tools/wait.js";
import {
  peerWaitLadderRungMs,
  projectInbox,
  projectJobs,
  WAIT_WINDOW_EXPIRED_PREFIX,
  type JobSettlement,
} from "../src/tools/job-registry.js";

afterEach(() => {
  resetRuntime();
});

// ---------------------------------------------------------------------------
// Pure layer: deterministic semantics over an in-memory journal (no DO, no
// real timers) — wake ordering, photo-finish, owner filter, ladder rungs.
// ---------------------------------------------------------------------------

const THREAD = "t-pure";
const LADDER = [5_000, 10_000, 30_000, 60_000, 300_000];

class WaitHarness {
  readonly journal: AnyAgentEvent[] = [];
  private nextSeq = 0;
  callSeq = 0;
  readonly windowDeadlines: number[] = [];
  peers: string[] = [];
  nowMs = 1_000_000;
  /** Package-private by design: harnessContext parks waiters here. */
  readonly wakeQueue: ((wake: WaitWake) => void)[] = [];

  append<TType extends AgentEventType>(
    type: TType,
    data: AgentEventDataByType[TType],
    createdAt = this.nowMs,
  ): void {
    this.nextSeq += 1;
    this.journal.push({
      id: `e${this.nextSeq}`,
      threadId: THREAD,
      seq: this.nextSeq,
      type,
      data,
      createdAt,
    } as AnyAgentEvent);
  }

  /** Seeds the wait's own tool.call row (ladder projection anchor). */
  seedWaitCall(): void {
    this.callSeq = this.journal.length + 1;
    this.append("tool.call", {
      turnId: "turn-1",
      modelCallId: 1,
      tool: "wait",
      arguments: {},
      timeoutMs: 60_000,
    });
  }

  registerJob(jobId: string, ownerId: string | null, label = jobId): void {
    this.append("job.registered", { jobId, ownerId, kind: "job", label });
  }

  settle(jobId: string, settlement: JobSettlement): void {
    this.append("job.settled", { jobId, status: settlement.status, output: settlement.output });
    // settle's wake broadcast (AgentDO.settleJob equivalent).
    this.wake({ kind: "job" });
  }

  deliverMessage(messageId: string, from = "PeerA", text = "hello"): void {
    this.append("peer.message", { messageId, ownerId: THREAD, from, text });
  }

  deliver(messageId: string): void {
    this.deliverMessage(messageId);
    this.wake({ kind: "message" });
  }

  wake(wake: WaitWake): void {
    const resolver = this.wakeQueue.shift();
    resolver?.(wake);
  }

  /** Number of runWaitTool calls parked on the wake channel. */
  pendingWakes(): number {
    return this.wakeQueue.length;
  }
}

/** DO-shaped WaitToolContext over the in-memory journal: synchronous fake
 * mutators that still return promises, so the executor code is identical to
 * the AgentDO-bound path. */
function harnessContext(harness: WaitHarness): WaitToolContext {
  return {
    executionId: "exec-wait",
    threadId: THREAD,
    callSeq: harness.callSeq,
    ownerId: THREAD,
    events: (): Promise<readonly AnyAgentEvent[]> => Promise.resolve(harness.journal),
    registry: {
      register: (input): Promise<void> => {
        harness.append("job.registered", {
          jobId: input.jobId,
          ownerId: input.ownerId,
          kind: input.kind,
          label: input.label,
        });
        return Promise.resolve();
      },
      settle: (jobId, settlement): Promise<void> => {
        harness.settle(jobId, settlement);
        return Promise.resolve();
      },
      markDelivered: (jobId, byExecutionId): Promise<void> => {
        harness.append("job.delivered", { jobId, byExecutionId });
        return Promise.resolve();
      },
    },
    inbox: {
      deliver: (message) => {
        harness.deliverMessage(message.messageId, message.from, message.text);
        harness.wake({ kind: "message" });
        return Promise.resolve({ messageId: message.messageId, duplicated: false });
      },
      consume: (messageId, byExecutionId): Promise<void> => {
        harness.append("peer.message_consumed", { messageId, byExecutionId });
        return Promise.resolve();
      },
    },
    runningPeers: () => harness.peers,
    registerWindowDeadline: (deadlineAt: number) => {
      harness.windowDeadlines.push(deadlineAt);
    },
    wake: () =>
      new Promise<WaitWake>((resolve) => {
        harness.wakeQueue.push(resolve);
      }),
    config: {
      waitMaxMs: 30 * 60_000,
      peerWaitLadderMs: LADDER,
      peerLadderResetGapMs: 60_000,
    },
    now: () => harness.nowMs,
  };
}

/** Runs runWaitTool to its blocking point before the test fires wake legs —
 * the wake channel registers a tick after the call, so poll, never assume. */
async function blocked(harness: WaitHarness): Promise<void> {
  await vi.waitFor(() => {
    expect(harness.pendingWakes()).toBeGreaterThan(0);
  });
}

describe("M1.5 T2 — wait pure semantics (omp wait.ts port)", () => {
  test("no wakable work errors Nothing to wait for immediately (wait.ts:92-96)", async () => {
    const harness = new WaitHarness();
    harness.seedWaitCall();
    const result = await runWaitTool(harnessContext(harness));
    expect(result.status).toBe("error");
    expect(result.output).toBe(NOTHING_TO_WAIT_FOR);
    expect(harness.windowDeadlines).toEqual([]);
  });

  test("a foreign job never sustains the wait — owner filter rejects it", async () => {
    const harness = new WaitHarness();
    harness.seedWaitCall();
    harness.registerJob("foreign-1", "agent-other", "not mine");
    const result = await runWaitTool(harnessContext(harness));
    expect(result.status).toBe("error");
    expect(result.output).toBe(NOTHING_TO_WAIT_FOR);
  });

  test("unowned jobs are invisible to an owned waiter and vice versa", () => {
    const harness = new WaitHarness();
    harness.registerJob("owned-1", THREAD);
    harness.registerJob("free-1", null);
    const events = harness.journal;
    expect(
      projectJobs(events)
        .runningJobs(THREAD)
        .map((job) => job.jobId),
    ).toEqual(["owned-1"]);
    expect(
      projectJobs(events)
        .runningJobs(undefined)
        .map((job) => job.jobId),
    ).toEqual(["free-1"]);
  });

  test("settled-but-undelivered owned job returns without blocking and is consumed", async () => {
    const harness = new WaitHarness();
    harness.seedWaitCall();
    harness.registerJob("job-1", THREAD, "review");
    harness.append("job.settled", { jobId: "job-1", status: "ok", output: "3 findings" });
    const result = await runWaitTool(harnessContext(harness));
    expect(result.status).toBe("ok");
    expect(result.output).toContain("## Completed (1)");
    expect(result.output).toContain("### job-1 [job] — ok");
    expect(result.output).toContain("3 findings");
    expect(projectJobs(harness.journal).job("job-1")?.status).toBe("delivered");
    // A second wait must not redeliver (retry-matrix §2.4: 消费语义).
    const second = await runWaitTool(harnessContext(harness));
    expect(second.output).toBe(NOTHING_TO_WAIT_FOR);
  });

  test("blocked wait returns when the owned job settles; message stays pending", async () => {
    const harness = new WaitHarness();
    harness.seedWaitCall();
    harness.registerJob("job-1", THREAD);
    const pending = runWaitTool(harnessContext(harness));
    await blocked(harness);
    harness.settle("job-1", { status: "ok", output: "done" });
    const result = await pending;
    expect(result.status).toBe("ok");
    expect(result.output).toContain("job-1");
    expect(result.output).toContain("Delivery: not auto-delivered; recovered by this snapshot.");
    expect(projectJobs(harness.journal).job("job-1")?.status).toBe("delivered");
    expect(projectInbox(harness.journal).pendingMessages(THREAD)).toHaveLength(0);
  });

  test("photo-finish: a landed message beats the settled job, which stays deliverable", async () => {
    const harness = new WaitHarness();
    harness.seedWaitCall();
    harness.registerJob("job-1", THREAD);
    const pending = runWaitTool(harnessContext(harness));
    await blocked(harness);
    // Both wake sources land inside one wake window: the message journal row
    // arrives without its own wake, then the settle broadcast resolves the
    // race. omp wait.ts:156-159 — the dequeued message wins; the job remains
    // deliverable because a lost message cannot be recovered from the bus.
    harness.deliverMessage("m-1", "PeerA", "steer now");
    harness.settle("job-1", { status: "ok", output: "done" });
    const result = await pending;
    expect(result.status).toBe("ok");
    expect(result.output).toBe("[m-1] PeerA: steer now");
    expect(projectJobs(harness.journal).job("job-1")?.status).toBe("settled");
    // The job is still returned by the next wait (no double delivery of the
    // message — it was consumed).
    const second = await runWaitTool(harnessContext(harness));
    expect(second.output).toContain("job-1");
  });

  test("a message arriving mid-wait ends it (omp wait.ts:74-75 order)", async () => {
    const harness = new WaitHarness();
    harness.seedWaitCall();
    harness.registerJob("job-1", THREAD);
    const pending = runWaitTool(harnessContext(harness));
    await blocked(harness);
    harness.deliver("m-1");
    const result = await pending;
    expect(result.output).toBe("[m-1] PeerA: hello");
    expect(projectInbox(harness.journal).pendingMessages(THREAD)).toHaveLength(0);
  });

  test("cap wake returns the omp still-running snapshot", async () => {
    const harness = new WaitHarness();
    harness.seedWaitCall();
    harness.registerJob("job-1", THREAD);
    const pending = runWaitTool(harnessContext(harness));
    await blocked(harness);
    harness.wake({ kind: "cap" });
    const result = await pending;
    expect(result.status).toBe("ok");
    expect(result.output).toBe(WAIT_LIMIT_REACHED);
    expect(projectJobs(harness.journal).runningJobs(THREAD)).toHaveLength(1);
  });

  test("cancelled wake lands a cancelled result (call abort)", async () => {
    const harness = new WaitHarness();
    harness.seedWaitCall();
    harness.registerJob("job-1", THREAD);
    const pending = runWaitTool(harnessContext(harness));
    await blocked(harness);
    harness.wake({ kind: "cancelled" });
    const result = await pending;
    expect(result.status).toBe("cancelled");
  });

  test("message-only wait registers the ladder window and names running peers", async () => {
    const harness = new WaitHarness();
    harness.seedWaitCall();
    harness.peers = ["PeerA", "PeerB"];
    const pending = runWaitTool(harnessContext(harness));
    await blocked(harness);
    expect(harness.windowDeadlines).toEqual([harness.nowMs + 5_000]);
    harness.wake({ kind: "window" });
    const result = await pending;
    expect(result.status).toBe("ok");
    expect(result.output).toBe(
      `${WAIT_WINDOW_EXPIRED_PREFIX} (5000 ms window); no message arrived. Running peers: PeerA, PeerB.`,
    );
  });
});

describe("M1.5 T2 — message-only ladder rungs (omp wait.md:17)", () => {
  test("consecutive window-expired waits step 5/10/30/60/300 and stay at 300", () => {
    const base = 1_000_000;
    const rungAt = (count: number, gap = 1_000): number => {
      const journal = new WaitHarness();
      for (let index = 0; index < count; index++) {
        const priorCallSeq = journal.journal.length + 1;
        journal.append(
          "tool.call",
          {
            turnId: "turn-1",
            modelCallId: 1,
            tool: "wait",
            arguments: {},
            timeoutMs: 60_000,
          },
          base + index * gap,
        );
        journal.append(
          "tool.result",
          {
            turnId: "turn-1",
            executionId: executionIdFor(THREAD, priorCallSeq),
            status: "ok",
            exitCode: null,
            output: `${WAIT_WINDOW_EXPIRED_PREFIX} (5000 ms window); no message arrived.`,
          },
          base + index * gap + 100,
        );
        // Rung-to-rung spacing stays under the 60s reset gap (gap - 100ms).
      }
      const callSeq = journal.journal.length + 1;
      journal.append(
        "tool.call",
        {
          turnId: "turn-1",
          modelCallId: 1,
          tool: "wait",
          arguments: {},
          timeoutMs: 60_000,
        },
        base + count * gap,
      );
      return peerWaitLadderRungMs(journal.journal, THREAD, callSeq, LADDER, 60_000);
    };
    expect(rungAt(0)).toBe(5_000);
    expect(rungAt(1)).toBe(10_000);
    expect(rungAt(2)).toBe(30_000);
    expect(rungAt(3)).toBe(60_000);
    expect(rungAt(4)).toBe(300_000);
    expect(rungAt(6)).toBe(300_000);
    expect(rungAt(3, 61_000)).toBe(5_000);
  });

  test("a non-window outcome breaks the consecutive chain", () => {
    const journal = new WaitHarness();
    const priorCallSeq = journal.journal.length + 1;
    journal.append(
      "tool.call",
      {
        turnId: "turn-1",
        modelCallId: 1,
        tool: "wait",
        arguments: {},
        timeoutMs: 60_000,
      },
      1_000_000,
    );
    journal.append(
      "tool.result",
      {
        turnId: "turn-1",
        executionId: executionIdFor(THREAD, priorCallSeq),
        status: "ok",
        exitCode: null,
        output: "job result",
      },
      1_000_100,
    );
    const callSeq = journal.journal.length + 1;
    journal.append(
      "tool.call",
      {
        turnId: "turn-1",
        modelCallId: 1,
        tool: "wait",
        arguments: {},
        timeoutMs: 60_000,
      },
      1_000_200,
    );
    expect(peerWaitLadderRungMs(journal.journal, THREAD, callSeq, LADDER, 60_000)).toBe(5_000);
  });
});

// ---------------------------------------------------------------------------
// DO integration: synthetic jobs through the frozen registry RPC surface,
// alarm-carried cap, cancellation, replay-consistency (proposal §3 T2
// acceptance + §1 replay assertions).
// ---------------------------------------------------------------------------

async function startWaitTurn(rig: Rig, clientRequestId: string): Promise<string> {
  const sent = await rig.stub.sendMessage({
    clientRequestId,
    content: [{ type: "text", text: "wait for it" }],
    mode: "start",
  });
  await rig.waitFor((events) =>
    events.some((event) => event.type === "tool.call" && event.data.tool === "wait"),
  );
  // Sync on the blocking marker (executeEdgeLocal journals tool.exec_started
  // exactly when the wait parks on its wake legs): RPCs fired after this land
  // against a blocked waiter, never inside the entry-query window.
  await rig.waitFor((events) =>
    events.some((event) => {
      if (event.type !== "tool.exec_started") return false;
      const call = events.find(
        (candidate) =>
          candidate.type === "tool.call" &&
          candidate.data.tool === "wait" &&
          executionIdFor(rig.threadId, candidate.seq) === event.data.executionId,
      );
      return call !== undefined;
    }),
  );
  return sent.turnId;
}

function waitResults(events: readonly AnyAgentEvent[], threadId: string) {
  return events.filter((event) => {
    if (event.type !== "tool.result") return false;
    const call = events.find(
      (candidate) =>
        candidate.type === "tool.call" &&
        candidate.data.tool === "wait" &&
        executionIdFor(threadId, candidate.seq) === event.data.executionId,
    );
    return call !== undefined;
  });
}

describe("M1.5 T2 — wait DO integration (journal-backed JobRegistry)", () => {
  test("synthetic job settlement wakes the blocked wait and lands one delivery", async () => {
    const rig = await createRig({
      turns: [{ toolCalls: [{ name: "wait", arguments: {} }] }, { deltas: ["done"] }],
      watchdog: { waitMaxMs: 60_000 },
    });
    // The job runs before the wait starts: "Nothing to wait for" is the
    // correct immediate return when no owned work exists at entry (omp
    // wait.ts:92-96), so the blocked-wait path needs pre-existing work.
    await rig.stub.registerJob({
      jobId: "job-1",
      ownerId: rig.threadId,
      kind: "job",
      label: "synthetic review",
    });
    const turnId = await startWaitTurn(rig, "in-wait-job");
    await rig.stub.settleJob("job-1", { status: "ok", output: "review finished: 3 findings" });
    const events = await rig.waitTurnComplete(turnId);
    const results = waitResults(events, rig.threadId);
    expect(results).toHaveLength(1);
    const result = results[0];
    if (result?.type !== "tool.result") throw new Error("unreachable");
    expect(result.data.status).toBe("ok");
    expect(result.data.output).toContain("### job-1 [job] — ok");
    expect(result.data.output).toContain("review finished: 3 findings");

    // Journal order: registered → settled → delivered (persist, then wake).
    const kinds = events
      .filter((event) => event.type.startsWith("job."))
      .map((event) => event.type);
    expect(kinds).toEqual(["job.registered", "job.settled", "job.delivered"]);

    // DO budget (proposal §1 edge row): the whole wait lifecycle consumed
    // this DO only — zero daemon dispatches, zero service journal rows.
    await expect(rig.service.journal()).resolves.toEqual([]);
    await expect(rig.service.clientSpawnCalls()).resolves.toEqual([]);
    expect(events.some((event) => event.type === "tool.dispatch")).toBe(false);

    // Replay consistency (§1): re-asking the terminal wait executionId
    // answers from the journal — zero second execution, zero re-delivery.
    const callSeq = events.find(
      (event) => event.type === "tool.call" && event.data.tool === "wait",
    )?.seq;
    if (callSeq === undefined) throw new Error("no wait call");
    const executionId = executionIdFor(rig.threadId, callSeq);
    await abortAllDurableObjects();
    await rig.afterAbort(async () => {
      await runInDurableObject(rig.stub, async (instance) => {
        const seam = instance as unknown as {
          dispatchExecution: (turnId: string, executionId: string) => Promise<void>;
        };
        await seam.dispatchExecution(turnId, executionId);
      });
    });
    const after = await rig.events();
    expect(after.filter((event) => event.type === "job.delivered")).toHaveLength(1);
    expect(waitResults(after, rig.threadId)).toHaveLength(1);
    expect(after).toHaveLength(events.length);
  });

  test("the 30-minute cap is carried by the DO alarm and fires once", async () => {
    const rig = await createRig({
      turns: [{ toolCalls: [{ name: "wait", arguments: {} }] }, { deltas: ["done"] }],
      watchdog: { waitMaxMs: 1_000 },
    });
    await rig.stub.registerJob({
      jobId: "slow-1",
      ownerId: rig.threadId,
      kind: "job",
      label: "never settles",
    });
    const turnId = await startWaitTurn(rig, "in-wait-cap");
    const events = await rig.waitTurnComplete(turnId);
    const results = waitResults(events, rig.threadId);
    expect(results).toHaveLength(1);
    const result = results[0];
    if (result?.type !== "tool.result") throw new Error("unreachable");
    expect(result.data.status).toBe("ok");
    expect(result.data.output).toBe(WAIT_LIMIT_REACHED);
    // The job is untouched: the cap is a still-running snapshot, not a settle.
    expect(
      events.some((event) => event.type === "job.settled" && event.data.jobId === "slow-1"),
    ).toBe(false);
  });

  test("peer message wakes the wait; delivery is idempotent by messageId", async () => {
    const rig = await createRig({
      turns: [{ toolCalls: [{ name: "wait", arguments: {} }] }, { deltas: ["done"] }],
      watchdog: { waitMaxMs: 60_000 },
    });
    await rig.stub.registerJob({
      jobId: "bg-1",
      ownerId: rig.threadId,
      kind: "job",
      label: "running in background",
    });
    const turnId = await startWaitTurn(rig, "in-wait-msg");
    const first = await rig.stub.deliverPeerMessage({
      messageId: "m-1",
      ownerId: rig.threadId,
      from: "PeerA",
      text: "steer: check the logs",
    });
    // T19: the receipt gained `revived` (this Main-thread delivery revives
    // nothing — no subagent identity on the DO).
    expect(first).toEqual({ messageId: "m-1", duplicated: false, revived: false });
    const events = await rig.waitTurnComplete(turnId);
    const results = waitResults(events, rig.threadId);
    expect(results).toHaveLength(1);
    const result = results[0];
    if (result?.type !== "tool.result") throw new Error("unreachable");
    expect(result.data.output).toBe("[m-1] PeerA: steer: check the logs");
    expect(events.some((event) => event.type === "peer.message_consumed")).toBe(true);
    // Duplicate delivery appends nothing (I2 pattern).
    const duplicate = await rig.stub.deliverPeerMessage({
      messageId: "m-1",
      ownerId: rig.threadId,
      from: "PeerA",
      text: "steer: check the logs",
    });
    expect(duplicate.duplicated).toBe(true);
    expect(await rig.of("peer.message")).toHaveLength(1);
  });

  test("a foreign job never sustains the wait — Nothing to wait for", async () => {
    const rig = await createRig({
      turns: [{ toolCalls: [{ name: "wait", arguments: {} }] }, { deltas: ["done"] }],
      watchdog: { waitMaxMs: 60_000 },
    });
    const turnId = await startWaitTurn(rig, "in-wait-foreign");
    await rig.stub.registerJob({
      jobId: "foreign-1",
      ownerId: "agent-someone-else",
      kind: "job",
      label: "not mine",
    });
    const events = await rig.waitTurnComplete(turnId);
    const results = waitResults(events, rig.threadId);
    expect(results).toHaveLength(1);
    const result = results[0];
    if (result?.type !== "tool.result") throw new Error("unreachable");
    expect(result.data.status).toBe("error");
    expect(result.data.output).toBe(NOTHING_TO_WAIT_FOR);
    // The foreign job stays running and undelivered.
    expect(
      events.some((event) => event.type === "job.settled" && event.data.jobId === "foreign-1"),
    ).toBe(false);
    expect(events.some((event) => event.type === "job.delivered")).toBe(false);
  });

  test("cancelling the turn resolves the blocked wait as cancelled", async () => {
    const rig = await createRig({
      turns: [{ toolCalls: [{ name: "wait", arguments: {} }] }, { deltas: ["done"] }],
      watchdog: { waitMaxMs: 60_000 },
    });
    await rig.stub.registerJob({
      jobId: "bg-1",
      ownerId: rig.threadId,
      kind: "job",
      label: "running",
    });
    const turnId = await startWaitTurn(rig, "in-wait-cancel");
    await rig.stub.cancelTurn({ turnId });
    const events = await rig.waitTurnComplete(turnId);
    expect(events.some((event) => event.type === "turn.cancelled")).toBe(true);
    const results = waitResults(events, rig.threadId);
    expect(results).toHaveLength(1);
    const result = results[0];
    if (result?.type !== "tool.result") throw new Error("unreachable");
    expect(result.data.status).toBe("cancelled");
    // The cancelled turn leaves no dangling job delivery.
    expect(events.some((event) => event.type === "job.delivered")).toBe(false);
  });

  test("message-only ladder window is armed on the DO alarm and wakes with peers named", async () => {
    const rig = await createRig({ turns: [{ deltas: ["idle"] }] });
    // In-DO plumbing check (no peer registry exists at M1.5 — T19 binds it):
    // drive the real wait context inside the DO with synthetic running peers
    // and a 50 ms window; the alarm must fire the window wake.
    const output = await runInDurableObject(rig.stub, async (instance) => {
      const seam = instance as unknown as {
        waitToolContext: (execution: { executionId: string; callSeq: number }) => WaitToolContext;
        state: { latestSeq: number };
      };
      const ctx = seam.waitToolContext({
        executionId: "exec-window-probe",
        callSeq: seam.state.latestSeq,
      });
      ctx.runningPeers = () => ["PeerA"];
      ctx.config.peerWaitLadderMs = [50];
      const result = await runWaitTool(ctx);
      return result.output;
    });
    expect(output).toBe(
      `${WAIT_WINDOW_EXPIRED_PREFIX} (50 ms window); no message arrived. Running peers: PeerA.`,
    );
  });
});
