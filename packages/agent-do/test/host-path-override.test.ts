import { env } from "cloudflare:workers";
import { afterEach, describe, expect, test } from "vitest";
import { newThreadId, toolNotExecutedMessage } from "@cap/protocol";
import { createRig, resetRuntime, type Rig } from "./helpers.js";
import type { TestDaemonServiceStub } from "../src/testing/test-daemon-do.js";
import type { FakeJournalOp } from "../src/testing/fake-daemon.js";
import { replayEvents } from "../src/turn-state.js";
import type { AnyAgentEvent } from "../src/fsm-events.js";
import { parseSshOverrideUrl, resolveHostPathOverride } from "../src/tools/host-path.js";

/**
 * #289 host:path parameter-level override (inventory #282 §2.B B1–B5):
 *
 * - B1 grammar + per-tool field resolution (pure units below);
 * - B2 single-dispatch machineId switch + `tool.dispatch` deviation row;
 * - B3 unroutable targets fail explicitly (unknown_host / host_offline),
 *   never a fallback to the bound machine;
 * - B4 exec-tier gate on the TARGET host's permission ceiling, before the
 *   remote DO stub resolves;
 * - B5 bash `cwd` joins the same grammar (the unified escape hatch).
 */

// ---------------------------------------------------------------------------
// Pure resolver units — B1 grammar + per-tool field map
// ---------------------------------------------------------------------------

/** Unwraps an expected-error URL resolution (test seam: the union narrows via guard). */
function sshUrlError(value: string): string {
  const parsed = parseSshOverrideUrl(value);
  if (parsed === null || !("error" in parsed)) {
    throw new Error(`expected an error result for "${value}"`);
  }
  return parsed.error;
}

/** Unwraps an expected-error call resolution (test seam: same union shape). */
function resolutionError(tool: string, args: Record<string, unknown>): string {
  const resolved = resolveHostPathOverride(tool, args);
  if (resolved === null || !("error" in resolved)) {
    throw new Error(`expected an error result for ${tool}`);
  }
  return resolved.error;
}

describe("parseSshOverrideUrl grammar (#289 B1)", () => {
  test("a non-ssh:// string is not an override", () => {
    expect(parseSshOverrideUrl("/abs/path.md")).toBeNull();
    expect(parseSshOverrideUrl("relative/file.txt")).toBeNull();
    expect(parseSshOverrideUrl("agent://thr_x/0")).toBeNull();
    expect(parseSshOverrideUrl("https://example.com")).toBeNull();
  });

  test("host + verbatim path part (read selectors survive)", () => {
    expect(parseSshOverrideUrl("ssh://mach_1/repo/file.md:10-20")).toEqual({
      machineId: "mach_1",
      path: "/repo/file.md:10-20",
    });
    expect(parseSshOverrideUrl("ssh://local/notes")).toEqual({
      machineId: "local",
      path: "/notes",
    });
  });

  test("bare ssh:// and path-less forms are explicit errors (never silent)", () => {
    expect(sshUrlError("ssh://")).toContain("needs a machine id");
    expect(sshUrlError("ssh://mach_1")).toContain("needs a path");
    expect(sshUrlError("ssh:///repo")).toContain("bare registry id");
  });

  test("omp destination escapes (user@, :port) are explicit errors — the override target is a registry id", () => {
    expect(sshUrlError("ssh://user@mach_1/repo")).toContain("bare registry id");
    expect(sshUrlError("ssh://mach_1:2222/repo")).toContain("bare registry id");
  });
});

describe("resolveHostPathOverride per-tool field map (#289 B1/B5)", () => {
  test("participating tools rewrite their path field and keep the rest", () => {
    expect(resolveHostPathOverride("read", { path: "ssh://h1/a.md:2-4:raw" })).toEqual({
      machineId: "h1",
      arguments: { path: "/a.md:2-4:raw" },
    });
    expect(resolveHostPathOverride("write", { path: "ssh://h1/new.txt", content: "body" })).toEqual(
      { machineId: "h1", arguments: { path: "/new.txt", content: "body" } },
    );
    expect(resolveHostPathOverride("find", { query: "q", path: "ssh://h1/src" })).toEqual({
      machineId: "h1",
      arguments: { query: "q", path: "/src" },
    });
  });

  test("bash cwd joins the same grammar (B5 unified escape hatch)", () => {
    expect(resolveHostPathOverride("bash", { command: "ls", cwd: "ssh://h1/sub" })).toEqual({
      machineId: "h1",
      arguments: { command: "ls", cwd: "/sub" },
    });
    // Local cwd (sandbox-relative) is untouched.
    expect(resolveHostPathOverride("bash", { command: "ls", cwd: "sub" })).toBeNull();
    expect(resolveHostPathOverride("bash", { command: "ls" })).toBeNull();
  });

  test("glob/grep ;-separated fields resolve per segment under ONE machine", () => {
    expect(
      resolveHostPathOverride("grep", { pattern: "p", path: "ssh://h1/a;ssh://h1/b" }),
    ).toEqual({
      machineId: "h1",
      arguments: { pattern: "p", path: "/a;/b" },
    });
    // Unqualified segments ride along and resolve on the target like locals.
    expect(resolveHostPathOverride("glob", { path: "plain;ssh://h1/a" })).toEqual({
      machineId: "h1",
      arguments: { path: "plain;/a" },
    });
    // Mixed hosts cannot ride one dispatch — explicit error, no split.
    expect(resolutionError("grep", { pattern: "p", path: "ssh://h1/a;ssh://h2/b" })).toContain(
      "must name one machine",
    );
  });

  test("edit input scans embedded ssh:// paths (hashline wrapper included)", () => {
    const input = "[ssh://h1/repo/a.py#A1B2]\nPUT 1*:\n+x";
    expect(resolveHostPathOverride("edit", { input })).toEqual({
      machineId: "h1",
      arguments: { input: "[/repo/a.py#A1B2]\nPUT 1*:\n+x" },
    });
    expect(resolutionError("edit", { input: "[ssh://h1/a#AAAA][ssh://h2/b#BBBB]" })).toContain(
      "must name one machine",
    );
    expect(resolveHostPathOverride("edit", { input: "[local/a.py#A1B2]" })).toBeNull();
  });

  test("non-participating tools never route on a path", () => {
    // Edge tools execute in the DO mesh.
    expect(resolveHostPathOverride("task", { task: "t", path: "ssh://h1/x" })).toBeNull();
    expect(resolveHostPathOverride("checkpoint", { goal: "ssh://h1/x" })).toBeNull();
    // Host-class tools without a path field stay untouched.
    expect(resolveHostPathOverride("eval", { language: "py", code: "1" })).toBeNull();
    expect(resolveHostPathOverride("security_scan", { action: "plan" })).toBeNull();
    expect(resolveHostPathOverride("manage_skill", { action: "create", name: "n" })).toBeNull();
    // Unknown tools are not overrides either.
    expect(resolveHostPathOverride("nonexistent", { path: "ssh://h1/x" })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// AgentDO routing — B2 deviation row, B3 explicit failures, B4 ceiling gate
// ---------------------------------------------------------------------------

/** The rig worker's bindings (test seam: `env` from cloudflare:workers is untyped). */
interface RigWorkerEnv {
  DAEMON_SERVICE: DurableObjectNamespace;
  DB: D1Database;
}
const rigEnv = env as RigWorkerEnv;
const serviceNamespace = rigEnv.DAEMON_SERVICE;
const db = rigEnv.DB;

/** Per-test unique targets — the rig worker shares one D1 across files. */
const TARGET = "tgt-route-289";
const TARGET_CAPPED = "tgt-capped-289";
const TARGET_GHOST = "tgt-ghost-289";
const TARGET_OFFLINE = "tgt-offline-289";

function serviceStubNamed(name: string): DurableObjectStub<TestDaemonServiceStub> {
  return serviceNamespace.get(
    serviceNamespace.idFromName(name),
  ) as unknown as DurableObjectStub<TestDaemonServiceStub>;
}

/** The DO RPC returns an unknown[]; the journal is this package's own type. */
function journalOf(name: string): Promise<FakeJournalOp[]> {
  return serviceStubNamed(name).journal() as Promise<FakeJournalOp[]>;
}

async function seedHostsTable(): Promise<void> {
  await db.exec(
    "CREATE TABLE IF NOT EXISTS hosts (" +
      "id TEXT PRIMARY KEY NOT NULL, " +
      "max_permission_mode TEXT NOT NULL DEFAULT 'full', " +
      "destroyed_at INTEGER)",
  );
}

async function seedHost(
  id: string,
  ceiling: string,
  destroyedAt: number | null = null,
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO hosts (id, max_permission_mode, destroyed_at) VALUES (?, ?, ?) " +
        "ON CONFLICT (id) DO UPDATE SET max_permission_mode = excluded.max_permission_mode, " +
        "destroyed_at = excluded.destroyed_at",
    )
    .bind(id, ceiling, destroyedAt)
    .run();
}

function dispatchRowsOf(
  events: readonly AnyAgentEvent[],
): Extract<AnyAgentEvent, { type: "tool.dispatch" }>[] {
  return events.filter(
    (event): event is Extract<AnyAgentEvent, { type: "tool.dispatch" }> =>
      event.type === "tool.dispatch",
  );
}

function resultRowsOf(
  events: readonly AnyAgentEvent[],
): Extract<AnyAgentEvent, { type: "tool.result" }>[] {
  return events.filter(
    (event): event is Extract<AnyAgentEvent, { type: "tool.result" }> =>
      event.type === "tool.result",
  );
}

function phaseRowsOf(events: readonly AnyAgentEvent[], turnId: string) {
  return events.filter((event) => event.type === "turn.phase" && event.data.turnId === turnId);
}

/** Waits past the trailing settled phase row (stream-hub waitTurnSettled shape). */
async function waitTurnSettled(rig: Rig, turnId: string): Promise<AnyAgentEvent[]> {
  return rig.waitFor((all) =>
    phaseRowsOf(all, turnId).some(
      (row) => row.type === "turn.phase" && row.data.phase === "settled",
    ),
  );
}

afterEach(() => {
  resetRuntime();
});

describe("override routing + deviation journal (#289 acceptance)", () => {
  test("override dispatch rides the TARGET machine's DO; journal deviation row; binding survives", async () => {
    await seedHostsTable();
    await seedHost(TARGET, "full");
    const target = serviceStubNamed(TARGET);
    await target.dial(TARGET);
    const rig = await createRig({
      turns: [
        { toolCalls: [{ name: "read", arguments: { path: `ssh://${TARGET}/file.txt` } }] },
        { deltas: ["after override"] },
        { toolCalls: [{ name: "read", arguments: { path: "note.txt" } }] },
        { deltas: ["after local"] },
      ],
    });

    // Turn 1: the ssh:// call.
    const sentOverride = await rig.stub.sendMessage({
      clientRequestId: "ovr-1",
      content: [{ type: "text", text: "read remotely" }],
      mode: "auto",
    });
    await rig.waitFor((all) => dispatchRowsOf(all).some((row) => row.data.outcome === "accepted"));
    const [overrideDispatch] = dispatchRowsOf(await rig.events());
    expect(overrideDispatch?.data.overriddenMachineId).toBe(TARGET);
    const executionId = overrideDispatch?.data.executionId ?? "";
    // The frame landed on the TARGET DO with the rewritten path + target machineId.
    let targetOps: Extract<FakeJournalOp, { op: "dispatch" }> | undefined;
    await expect
      .poll(
        async () => {
          const ops = await journalOf(TARGET);
          targetOps = ops.find(
            (op): op is Extract<FakeJournalOp, { op: "dispatch" }> =>
              op.op === "dispatch" && op.executionId === executionId,
          );
          return targetOps !== undefined ? "yes" : "no";
        },
        { timeout: 20_000, interval: 100 },
      )
      .toBe("yes");
    expect(targetOps?.machineId).toBe(TARGET);
    expect(targetOps?.tool).toBe("read");
    expect(JSON.parse(targetOps?.argumentsJson ?? "{}")).toEqual({ path: "/file.txt" });
    // The bound machine's service journal holds NO dispatch for this call.
    expect(
      (await journalOf(rig.threadId)).some(
        (op) => op.op === "dispatch" && op.executionId === executionId,
      ),
    ).toBe(false);

    // Feed the remote result; the turn settles honestly.
    await target.clientExit(executionId, { status: "ok", exitCode: 0, output: "remote note" });
    const events = await waitTurnSettled(rig, sentOverride.turnId);
    const [overrideResult] = resultRowsOf(events);
    expect(overrideResult?.data).toMatchObject({ status: "ok", output: "remote note" });
    // Replay purity: the additive field folds without FSM objections.
    expect(() => replayEvents(events)).not.toThrow();

    // Turn 2: a plain call — the binding was never rewritten (§2.2).
    const sentLocal = await rig.stub.sendMessage({
      clientRequestId: "ovr-2",
      content: [{ type: "text", text: "read locally" }],
      mode: "auto",
    });
    await rig.waitFor((all) =>
      dispatchRowsOf(all).some(
        (row) => row.data.turnId === sentLocal.turnId && row.data.outcome === "accepted",
      ),
    );
    const localDispatch = dispatchRowsOf(await rig.events()).find(
      (row) => row.data.turnId === sentLocal.turnId,
    );
    expect(localDispatch?.data.overriddenMachineId).toBeUndefined();
    const localOps = (await journalOf(rig.threadId)).filter(
      (op): op is Extract<FakeJournalOp, { op: "dispatch" }> =>
        op.op === "dispatch" && op.executionId === localDispatch?.data.executionId,
    );
    expect(localOps).toHaveLength(1);
    expect(localOps[0]?.machineId).toBe(rig.threadId);
    const localExecutionId = localDispatch?.data.executionId ?? "";
    await rig.service.clientExit(localExecutionId, {
      status: "ok",
      exitCode: 0,
      output: "local note",
    });
    await rig.waitTurnComplete(sentLocal.turnId);
  }, 30_000);

  test("same-machine rewrite (ssh://<bound>/…) is not a deviation: no field, no gate, path stripped", async () => {
    const threadId = newThreadId();
    const rig = await createRig({
      threadId,
      turns: [
        { toolCalls: [{ name: "read", arguments: { path: `ssh://${threadId}/x` } }] },
        { deltas: ["done"] },
      ],
    });
    const sent = await rig.stub.sendMessage({
      clientRequestId: "ovr-same-1",
      content: [{ type: "text", text: "same machine" }],
      mode: "auto",
    });
    await rig.waitFor((all) => dispatchRowsOf(all).some((row) => row.data.turnId === sent.turnId));
    const [dispatch] = dispatchRowsOf(await rig.events());
    expect(dispatch?.data.overriddenMachineId).toBeUndefined();
    const ops = (await journalOf(rig.threadId)).filter(
      (op): op is Extract<FakeJournalOp, { op: "dispatch" }> =>
        op.op === "dispatch" && op.executionId === dispatch?.data.executionId,
    );
    expect(JSON.parse(ops[0]?.argumentsJson ?? "{}")).toEqual({ path: "/x" });
    await rig.service.clientExit(dispatch?.data.executionId ?? "", {
      status: "ok",
      exitCode: 0,
      output: "same note",
    });
    await rig.waitTurnComplete(sent.turnId);
  }, 30_000);

  test("unresolvable override (mixed hosts) fails before any dispatch — no deviation row at all", async () => {
    await seedHostsTable();
    const rig = await createRig({
      turns: [
        {
          toolCalls: [{ name: "grep", arguments: { pattern: "p", path: "ssh://a1/x;ssh://a2/y" } }],
        },
        { deltas: ["acknowledged"] },
      ],
    });
    const sent = await rig.stub.sendMessage({
      clientRequestId: "ovr-bad-1",
      content: [{ type: "text", text: "mixed hosts" }],
      mode: "auto",
    });
    const events = await waitTurnSettled(rig, sent.turnId);
    // Explicit error result, journaled straight to the execution (in-DO
    // resolution shape — no dispatch row, no remote stub touched).
    const [result] = resultRowsOf(events);
    expect(result?.data).toMatchObject({
      status: "error",
      exitCode: null,
    });
    expect(result?.data.output).toContain("must name one machine");
    expect(dispatchRowsOf(events)).toHaveLength(0);
    expect((await journalOf(rig.threadId)).some((op) => op.op === "dispatch")).toBe(false);
  }, 30_000);
});

describe("override gates (#289 B3/B4)", () => {
  test("unregistered target: unknown_host, explicit, no fallback dispatch", async () => {
    await seedHostsTable();
    const rig = await createRig({
      turns: [
        { toolCalls: [{ name: "read", arguments: { path: `ssh://${TARGET_GHOST}/x` } }] },
        { deltas: ["ok"] },
      ],
    });
    const sent = await rig.stub.sendMessage({
      clientRequestId: "ovr-ghost-1",
      content: [{ type: "text", text: "ghost target" }],
      mode: "auto",
    });
    const events = await waitTurnSettled(rig, sent.turnId);
    const [result] = resultRowsOf(events);
    expect(result?.data).toMatchObject({
      status: "error",
      errorCode: "unknown_host",
    });
    expect(result?.data.output).toBe(
      toolNotExecutedMessage("unknown_host", `no registered host "${TARGET_GHOST}" for the ssh:// override`),
    );
    expect(dispatchRowsOf(events)).toHaveLength(0);
  }, 30_000);

  test("destroyed target: unknown_host", async () => {
    await seedHostsTable();
    await seedHost(TARGET_GHOST, "full", 123);
    const rig = await createRig({
      turns: [
        { toolCalls: [{ name: "read", arguments: { path: `ssh://${TARGET_GHOST}/x` } }] },
        { deltas: ["ok"] },
      ],
    });
    const sent = await rig.stub.sendMessage({
      clientRequestId: "ovr-ghost-2",
      content: [{ type: "text", text: "destroyed target" }],
      mode: "auto",
    });
    const events = await waitTurnSettled(rig, sent.turnId);
    expect(resultRowsOf(events)[0]?.data.status).toBe("error");
    expect(resultRowsOf(events)[0]?.data.errorCode).toBe("unknown_host");
    expect(resultRowsOf(events)[0]?.data.output).toContain("is destroyed");
  }, 30_000);

  test("ceiling below full: exec_tier_required BEFORE the remote DO resolves (B4 连接前硬拒)", async () => {
    await seedHostsTable();
    await seedHost(TARGET_CAPPED, "auto");
    const rig = await createRig({
      turns: [
        { toolCalls: [{ name: "read", arguments: { path: `ssh://${TARGET_CAPPED}/x` } }] },
        { deltas: ["ok"] },
      ],
    });
    const sent = await rig.stub.sendMessage({
      clientRequestId: "ovr-capped-1",
      content: [{ type: "text", text: "capped target" }],
      mode: "auto",
    });
    const events = await waitTurnSettled(rig, sent.turnId);
    const [result] = resultRowsOf(events);
    expect(result?.data.status).toBe("error");
    expect(result?.data).toMatchObject({ errorCode: "exec_tier_required" });
    expect(result?.data.output).toContain(`ceiling is "auto"`);
    // The rejection never reached the target: no journal ops there at all.
    expect(await journalOf(TARGET_CAPPED)).toHaveLength(0);
    expect(dispatchRowsOf(events)).toHaveLength(0);
  }, 30_000);

  test("registry read failure refuses the override (permission gate never fails open)", async () => {
    await seedHostsTable();
    await db.exec("DROP TABLE hosts");
    const rig = await createRig({
      turns: [
        { toolCalls: [{ name: "read", arguments: { path: `ssh://${TARGET}/x` } }] },
        { deltas: ["ok"] },
      ],
    });
    const sent = await rig.stub.sendMessage({
      clientRequestId: "ovr-regfail-1",
      content: [{ type: "text", text: "registry down" }],
      mode: "auto",
    });
    const events = await waitTurnSettled(rig, sent.turnId);
    expect(resultRowsOf(events)[0]?.data.status).toBe("error");
    expect(resultRowsOf(events)[0]?.data).toMatchObject({
      errorCode: "registry_unavailable",
      exitCode: null,
    });
    expect(resultRowsOf(events)[0]?.data.output).toContain("tool not executed: hosts registry unavailable");
    expect(dispatchRowsOf(events)).toHaveLength(0);
    await seedHostsTable();
  }, 30_000);

  test("override target offline: host_offline deviation row + honest error, NO turn-level host_lost", async () => {
    await seedHostsTable();
    await seedHost(TARGET_OFFLINE, "full");
    const target = serviceStubNamed(TARGET_OFFLINE);
    await target.setHostOnline(false);
    const rig = await createRig({
      turns: [
        { toolCalls: [{ name: "read", arguments: { path: `ssh://${TARGET_OFFLINE}/x` } }] },
        { deltas: ["ok"] },
      ],
    });
    const sent = await rig.stub.sendMessage({
      clientRequestId: "ovr-off-1",
      content: [{ type: "text", text: "offline target" }],
      mode: "auto",
    });
    const events = await waitTurnSettled(rig, sent.turnId);
    // The deviation row journals the failed override dispatch (B2/B3).
    const [dispatch] = dispatchRowsOf(events);
    expect(dispatch?.data).toMatchObject({
      outcome: "host_offline",
      overriddenMachineId: TARGET_OFFLINE,
    });
    const [result] = resultRowsOf(events);
    expect(result?.data).toMatchObject({
      status: "error",
      errorCode: "host_offline",
      exitCode: null,
      output: toolNotExecutedMessage(
        "host_offline",
        `override target "${TARGET_OFFLINE}" has no live daemon session`,
      ),
    });
    // host_lost stays the BOUND-machine marker — the bound host is alive.
    const phases = phaseRowsOf(events, sent.turnId).map((row) =>
      row.type === "turn.phase" ? row.data.phase : "",
    );
    expect(phases).not.toContain("host_lost");
  }, 30_000);
});
