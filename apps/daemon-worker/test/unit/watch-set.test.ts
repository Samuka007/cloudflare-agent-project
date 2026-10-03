import { describe, expect, it } from "vitest";
import {
  watchSetFingerprint,
  type WatchInterest,
} from "../../src/watch-set.js";
import type { OrchestratorStub } from "../helpers.js";
import { openRequest, orchestratorFor } from "../helpers.js";

/**
 * Watch-set aggregation — bb watch-interests.ts generation+fingerprint state
 * machine: identical fingerprint keeps the old generation and sends nothing;
 * any target change emits `watch-set.replace` at last+1; reconcile (session
 * open) resolves without emitting.
 */

const orchestrator = (): OrchestratorStub =>
  orchestratorFor();

const workspace = (environmentId: string): WatchInterest => ({
  kind: "environment-detail",
  target: { environmentId, workspaceContext: `ctx:${environmentId}` },
});

const threadStorage = (threadId: string): WatchInterest => ({
  kind: "thread-detail",
  target: { environmentId: "env-1", threadId },
});

describe("watch-set generation+fingerprint machine (bb §1.5)", () => {
  it("resolves an empty set at generation 0 before any interest", async () => {
    const orch = orchestrator();
    expect(await orch.reconcileWatchSet()).toEqual({
      generation: 0,
      workspaceTargets: [],
      threadStorageTargets: [],
    });
  });

  it("emits watch-set.replace at generation 1 on the first interest", async () => {
    const orch = orchestrator();
    const applied = await orch.applyWatchInterests({
      upserts: [{ key: "environment-detail:env-1", interest: workspace("env-1") }],
      removals: [],
    });
    expect(applied).toEqual({ emitted: true, generation: 1 });
    const frames = await orch.drainDaemonOutbox();
    expect(frames).toEqual([
      {
        type: "watch-set.replace",
        generation: 1,
        workspaceTargets: [
          { environmentId: "env-1", workspaceContext: "ctx:env-1" },
        ],
        threadStorageTargets: [],
      },
    ]);
  });

  it("keeps the generation and sends nothing when the fingerprint is unchanged", async () => {
    const orch = orchestrator();
    const args = {
      upserts: [{ key: "thread-detail:thr_1", interest: threadStorage("thr_1") }],
      removals: [],
    };
    expect(await orch.applyWatchInterests(args)).toEqual({
      emitted: true,
      generation: 1,
    });
    // Identical re-apply (bb duplicate subscription): fingerprint equal to the
    // last *sent* set — no frame, no generation bump.
    expect(await orch.applyWatchInterests(args)).toEqual({
      emitted: false,
      generation: 1,
    });
    await orch.drainDaemonOutbox();
    expect(await orch.drainDaemonOutbox()).toEqual([]);
  });

  it("re-emits when the set returns to a previously sent fingerprint (A→B→A)", async () => {
    const orch = orchestrator();
    const withOne = {
      upserts: [{ key: "thread-detail:thr_1", interest: threadStorage("thr_1") }],
      removals: [],
    };
    const withTwo = {
      upserts: [
        { key: "thread-detail:thr_1", interest: threadStorage("thr_1") },
        { key: "thread-detail:thr_2", interest: threadStorage("thr_2") },
      ],
      removals: [],
    };
    await orch.applyWatchInterests(withOne); // gen 1
    await orch.applyWatchInterests(withTwo); // gen 2
    const backToOne = await orch.applyWatchInterests({
      upserts: [],
      removals: ["thread-detail:thr_2"],
    });
    // bb compares against the last SENT fingerprint — A after B is a change.
    expect(backToOne).toEqual({ emitted: true, generation: 3 });
  });

  it("reconcile (session-open response) resolves at the current generation without emitting", async () => {
    const orch = orchestrator();
    await orch.applyWatchInterests({
      upserts: [{ key: "environment-detail:env-1", interest: workspace("env-1") }],
      removals: [],
    });
    await orch.drainDaemonOutbox();
    const opened = await orch.openSession(openRequest({}));
    expect(opened.kind).toBe("opened");
    if (opened.kind !== "opened") return;
    expect(opened.watchSet).toEqual({
      generation: 1,
      workspaceTargets: [
        { environmentId: "env-1", workspaceContext: "ctx:env-1" },
      ],
      threadStorageTargets: [],
    });
    expect(await orch.drainDaemonOutbox()).toEqual([]);
  });

  it("sorts targets deterministically and exposes the bb fingerprint formula", async () => {
    const orch = orchestrator();
    await orch.applyWatchInterests({
      upserts: [
        { key: "thread-detail:thr_2", interest: threadStorage("thr_2") },
        { key: "thread-detail:thr_1", interest: threadStorage("thr_1") },
        { key: "environment-detail:env-2", interest: workspace("env-2") },
        { key: "environment-detail:env-1", interest: workspace("env-1") },
      ],
      removals: [],
    });
    const set = await orch.reconcileWatchSet();
    expect(set.workspaceTargets.map((t) => t.environmentId)).toEqual([
      "env-1",
      "env-2",
    ]);
    expect(set.threadStorageTargets.map((t) => t.threadId)).toEqual([
      "thr_1",
      "thr_2",
    ]);
    expect(watchSetFingerprint(set)).toBe(
      JSON.stringify({
        workspaceTargets: set.workspaceTargets,
        threadStorageTargets: set.threadStorageTargets,
      }),
    );
  });
});
