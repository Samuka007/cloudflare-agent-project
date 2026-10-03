import { beforeEach, describe, expect, it } from "vitest";
import {
  ADAPTER_COMMAND_TYPES,
  flattenPromptInputGroups,
  type AdapterCommand,
} from "../../src/provider-adapter.js";
import {
  fakeExecutionContext,
  fakeExecutionOptions,
} from "../../src/testing/fake-provider.js";
import type {
  CommandDispatchOutcome,
  HostDaemonCommandRow,
} from "../../src/host-orchestrator-do.js";
import type { RuntimeThreadExecutionOptions } from "../../src/provider-types.js";
import {
  installFakes,
  openRequest,
  orchestratorFor,
  type InstalledFakes,
  type OrchestratorStub,
} from "../helpers.js";

/**
 * AdapterCommand full suite (issue #27 acceptance): every command variant
 * round-trips the typed in-process seam through the orchestrator's dispatch
 * journal against the deterministic fake provider, and the bb-verbatim
 * helpers keep their contract shapes.
 */

let fakes: InstalledFakes;
const orchestrator = (): OrchestratorStub => orchestratorFor();

beforeEach(() => {
  fakes = installFakes();
});

async function enqueueAndDispatch(
  command: AdapterCommand,
  threadId?: string,
): Promise<{ outcome: CommandDispatchOutcome; row: HostDaemonCommandRow | null }> {
  const orch = orchestrator();
  await orch.openSession(openRequest({ leaseTimeoutMs: 30_000 }));
  const { commandId } = await orch.enqueueCommand({
    type: command.type,
    command,
    threadId,
  });
  const outcome = await orch.dispatchCommand({ commandId });
  return { outcome, row: await orch.getCommand({ commandId }) };
}

describe("AdapterCommand suite (provider route, typed in-process seam)", () => {
  it("round-trips every command variant with settled ok outcomes", async () => {
    const orch = orchestrator();
    const open = await orch.openSession(openRequest({ leaseTimeoutMs: 30_000 }));
    expect(open.kind).toBe("opened");

    const ctx = fakeExecutionContext(fakeExecutionOptions());
    const seq: AdapterCommand[] = [
      { type: "initialize" },
      {
        type: "skills/configure",
        skillRoots: [
          { id: "sr-1", providerId: "codex", skillDirectoryRootPath: "/skills" },
        ],
      },
      { type: "model/list", cwd: "/workspace" },
      {
        type: "thread/start",
        threadId: "thr_1",
        cwd: "/workspace",
        options: ctx,
        instructionMode: "append",
      },
      {
        type: "thread/name/set",
        threadId: "thr_1",
        providerThreadId: "pthr_1",
        title: "Renamed",
      },
      { type: "thread/goal/clear", threadId: "thr_1", providerThreadId: "pthr_1" },
      {
        type: "turn/start",
        threadId: "thr_1",
        providerThreadId: "pthr_1",
        input: [{ type: "text", text: "hello", mentions: [] }],
        clientRequestId: "creq_abcdefghij",
        options: ctx,
      },
      {
        type: "turn/steer",
        threadId: "thr_1",
        providerThreadId: "pthr_1",
        expectedTurnId: "creq_abcdefghij",
        input: [{ type: "text", text: "steer", mentions: [] }],
        clientRequestId: "creq_bcdefghija",
        options: ctx,
      },
      {
        type: "thread/stop",
        threadId: "thr_1",
        providerThreadId: "pthr_1",
        activeTurnId: "creq_abcdefghij",
      },
      {
        type: "thread/fork",
        threadId: "thr_2",
        cwd: "/workspace",
        sourceProviderThreadId: "pthr_1",
        options: ctx,
        instructionMode: "append",
      },
      {
        type: "thread/resume",
        threadId: "thr_1",
        cwd: "/workspace",
        providerThreadId: "pthr_1",
        // The stop above poisoned pthr_1 — resume round-trips the recovery
        // descriptor (the bare-resume rejection has its own named test).
        ompRecovery: { sessionId: "pthr_1", sessionFile: "/sessions/pthr_1.jsonl" },
        options: ctx,
        instructionMode: "append",
      },
      { type: "thread/archive", threadId: "thr_1", providerThreadId: "pthr_1" },
      { type: "thread/unarchive", threadId: "thr_1", providerThreadId: "pthr_1" },
      { type: "thread/discard", threadId: "thr_2", providerThreadId: "pthr_2" },
    ];
    const distinctTypes = new Set(seq.map((c) => c.type));
    expect(distinctTypes.size).toBe(ADAPTER_COMMAND_TYPES.length);

    const commandIds: string[] = [];
    for (const command of seq) {
      const { commandId } = await orch.enqueueCommand({
        type: command.type,
        command,
        threadId: "threadId" in command ? command.threadId : undefined,
      });
      commandIds.push(commandId);
      const outcome = await orch.dispatchCommand({ commandId });
      expect(outcome.kind).toBe("settled");
      if (outcome.kind !== "settled") continue;
      expect(outcome.outcome.ok).toBe(true);
    }

    // The fake saw every command, in journal order.
    expect(fakes.provider.commands.map((c) => c.type)).toEqual(
      seq.map((c) => c.type),
    );

    // Journal audit: completed with result payload + timestamps + one ok
    // attempt each; thread/stop with activeTurnId poisoned the session.
    for (const commandId of commandIds) {
      const row = await orch.getCommand({ commandId });
      expect(row?.state).toBe("completed");
      expect(row?.resultPayload?.ok).toBe(true);
      expect(row?.fetchedAt).not.toBeNull();
      expect(row?.completedAt).not.toBeNull();
      const attempts = await orch.listAttempts({ commandId });
      expect(attempts).toHaveLength(1);
      expect(attempts[0]?.status).toBe("ok");
      expect(attempts[0]?.settledAt).not.toBeNull();
    }

    const stopped = fakes.provider.thread("pthr_1");
    expect(stopped?.poisoned).toBe(true);
    expect(stopped?.title).toBe("Renamed");
    expect(stopped?.steers).toHaveLength(1);
    // thr_2's fork (pthr_2) was discarded at the end of the sequence.
    expect(fakes.provider.providerThreadIds()).toEqual(["pthr_1"]);
  });

  it("gates turns through the fake's session registry with typed errors", async () => {
    const ctx = fakeExecutionContext(fakeExecutionOptions());
    const started = await enqueueAndDispatch(
      {
        type: "thread/start",
        threadId: "thr_10",
        cwd: "/w",
        options: ctx,
        instructionMode: "append",
      },
      "thr_10",
    );
    expect(started.row?.resultPayload).toMatchObject({
      ok: true,
      result: { providerThreadId: "pthr_1", sessionRestorable: true },
    });

    const idleTurn = await enqueueAndDispatch(
      {
        type: "turn/start",
        threadId: "thr_10",
        providerThreadId: "pthr_1",
        input: [{ type: "text", text: "one", mentions: [] }],
        clientRequestId: "creq_aaaaaaaaaa",
        options: ctx,
      },
      "thr_10",
    );
    expect(idleTurn.row?.state).toBe("completed");

    const busyTurn = await enqueueAndDispatch(
      {
        type: "turn/start",
        threadId: "thr_10",
        providerThreadId: "pthr_1",
        input: [{ type: "text", text: "two", mentions: [] }],
        clientRequestId: "creq_bbbbbbbbbb",
        options: ctx,
      },
      "thr_10",
    );
    expect(busyTurn.row?.state).toBe("failed");
    expect(busyTurn.row?.resultPayload).toMatchObject({
      ok: false,
      errorCode: "turn_already_active",
    });

    // Steer against a non-active turn id is a typed provider error too.
    const badSteer = await enqueueAndDispatch(
      {
        type: "turn/steer",
        threadId: "thr_10",
        providerThreadId: "pthr_1",
        expectedTurnId: "creq_zzzzzzzzzz",
        input: [{ type: "text", text: "late", mentions: [] }],
        clientRequestId: "creq_cccccccccc",
        options: ctx,
      },
      "thr_10",
    );
    expect(badSteer.row?.resultPayload).toMatchObject({
      ok: false,
      errorCode: "steer_no_active_turn",
    });
  });

  it("resumes poisoned sessions only with a recovery descriptor (bb ompRecovery)", async () => {
    const ctx = fakeExecutionContext(fakeExecutionOptions());
    await enqueueAndDispatch(
      {
        type: "thread/start",
        threadId: "thr_20",
        cwd: "/w",
        options: ctx,
        instructionMode: "append",
      },
      "thr_20",
    );
    await enqueueAndDispatch(
      {
        type: "turn/start",
        threadId: "thr_20",
        providerThreadId: "pthr_1",
        input: [{ type: "text", text: "go", mentions: [] }],
        clientRequestId: "creq_dddddddddd",
        options: ctx,
      },
      "thr_20",
    );
    await enqueueAndDispatch(
      {
        type: "thread/stop",
        threadId: "thr_20",
        providerThreadId: "pthr_1",
        activeTurnId: "creq_dddddddddd",
      },
      "thr_20",
    );

    const bareResume = await enqueueAndDispatch(
      {
        type: "thread/resume",
        threadId: "thr_20",
        cwd: "/w",
        providerThreadId: "pthr_1",
        options: ctx,
        instructionMode: "append",
      },
      "thr_20",
    );
    expect(bareResume.row?.resultPayload).toMatchObject({
      ok: false,
      errorCode: "session_recovery_required",
    });

    const recoveredResume = await enqueueAndDispatch(
      {
        type: "thread/resume",
        threadId: "thr_20",
        cwd: "/w",
        providerThreadId: "pthr_1",
        ompRecovery: { sessionId: "pthr_1", sessionFile: "/sessions/pthr_1.jsonl" },
        options: ctx,
        instructionMode: "append",
      },
      "thr_20",
    );
    expect(recoveredResume.row?.resultPayload).toMatchObject({
      ok: true,
      result: { providerThreadId: "pthr_1" },
    });
  });

  it("classifies execution-settings drift bb-style (live vs session)", () => {
    const provider = fakes.provider;
    const current = fakeExecutionOptions();
    const classify = (next: RuntimeThreadExecutionOptions) =>
      provider.classifyExecutionSettingsChange({ current, next });
    expect(classify(fakeExecutionOptions({ model: "fake-other" }))).toBe("live");
    expect(classify(fakeExecutionOptions({ reasoningLevel: "high" }))).toBe(
      "live",
    );
    expect(classify(fakeExecutionOptions({ permissionMode: "full" }))).toBe(
      "session",
    );
    expect(classify(fakeExecutionOptions())).toBe("unchanged");
  });
});

describe("bb-verbatim helpers", () => {
  it("flattenPromptInputGroups inserts the group separator verbatim", () => {
    const mk = (text: string) => ({ type: "text" as const, text, mentions: [] });
    const input = [mk("a")];
    const groups = [[mk("a")], [mk("b")]];
    expect(flattenPromptInputGroups(input, undefined)).toEqual(input);
    expect(flattenPromptInputGroups(input, groups)).toEqual([
      mk("a"),
      { type: "text", text: "\n\n", mentions: [] },
      mk("b"),
    ]);
  });
});
