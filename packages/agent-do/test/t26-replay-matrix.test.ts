import { afterEach, beforeAll, afterAll, describe, expect, test } from "vitest";
import { z } from "zod";
import { http, HttpResponse } from "msw";
import { setupNetwork } from "@msw/cloudflare";
import { abortAllDurableObjects, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { newThreadId, parseThreadEvent, type TypedThreadEvent } from "@cap/protocol";
import { createRig, resetRuntime, type Rig } from "./helpers.js";
import type { AgentDO } from "../src/agent-do.js";
import type { AnyAgentEvent } from "../src/fsm-events.js";
import { executionIdFor } from "../src/ids.js";
import { setAgentRuntime } from "../src/injection.js";
import { MockModelProvider } from "../src/testing/mock-provider.js";
import { setAgentDefinitions, BUNDLED_AGENT_DEFINITIONS } from "../src/tools/task/types.js";
import {
  MAIN_WIRE_TOOLS,
  M0_RENDER_FLAGS,
  SUBAGENT_ONLY_TOOLS,
  TOOL_REGISTRY,
  toolRegistryRow,
  toolWireDefinition,
} from "../src/tools/registry.js";
import { askOptionValue } from "../src/tools/ask.js";
import { projectToUxEvents } from "../src/ux-projection.js";

/**
 * M1.5 T26 (#116) — the closing gate: ONE table-driven regression matrix that
 * walks EVERY registered tool row through the replay/eviction injection face
 * and asserts the uniform consistency contract (proposal §3 T26; anchors
 * tool-retry-idempotency-matrix.md §1/§6/§7).
 *
 * Per row the matrix asserts, in order:
 *   1. dispatch face   — a live dispatch through the real agent loop journals
 *      `tool.call` first (I4) and derives executionId = `${threadId}:${seq}`.
 *   2. eviction face   — `abortAllDurableObjects()` (hard kill, whole worker)
 *      and `evictDurableObject()` (targeted, SQLite survives): the journal
 *      replays IDENTICALLY (seq/type/id), per matrix §1 "重放即真相".
 *   3. dedup face      — the recovery verb (same-executionId re-ask) answers
 *      from the journal with ZERO second execution (matrix §6 server/agent
 *      dedup: "the client never spawns twice", I16).
 *   4. non-power face  — bash/eval additionally take the outcome-unknown
 *      cell (new-boot kill-list): the UNKNOWN outcome is a persisted terminal
 *      that the UX renders as "interrupted" and nothing ever silently re-runs
 *      (matrix §6 boundary: dedup protects "不二次 spawn", never "重跑本体").
 *
 * The edge rows additionally assert the DO-budget face (§1 默认约束): edge
 * execution never leaves the DO — zero `tool.dispatch` events, zero rows in
 * the service journal.
 *
 * Completeness guard: every TOOL_REGISTRY row MUST have a matrix entry and
 * every entry MUST name a registered row — a future registry row without
 * matrix coverage fails this suite, so the matrix cannot silently shrink.
 */

afterEach(() => {
  resetRuntime();
  setAgentDefinitions(BUNDLED_AGENT_DEFINITIONS);
});

// ---------------------------------------------------------------------------
// The matrix table — one entry per registered row (dispatch args minimal and
// schema-valid per the row's registry schema; the drive is chosen by class).
// ---------------------------------------------------------------------------

interface MatrixRow {
  args: Record<string, unknown>;
  /** Terminal tool.result status the row's minimal drive produces. */
  status: "ok" | "error";
}

const ASK_QUESTION = {
  id: "storage",
  question: "Database?",
  options: [{ label: "SQLite" }, { label: "Postgres" }],
  recommended: 0,
};

const MATRIX: Record<string, MatrixRow> = {
  // -- host rows (daemon-dispatch; uniform hostDrive) -----------------------
  bash: { args: { command: "ls" }, status: "ok" },
  read: { args: { path: "docs/ROADMAP.md" }, status: "ok" },
  edit: { args: { input: "+ t26 matrix line\n" }, status: "ok" },
  glob: { args: { path: "." }, status: "ok" },
  grep: { args: { pattern: "agent" }, status: "ok" },
  find: { args: { query: "replay", grep_keywords: ["journal"] }, status: "ok" },
  security_scan: { args: { action: "preflight" }, status: "ok" },
  write: { args: { path: "notes/t26-matrix.md", content: "matrix" }, status: "ok" },
  eval: { args: { language: "py", code: "print(1)" }, status: "ok" },
  manage_skill: {
    args: { action: "create", name: "t26-matrix", description: "matrix fixture", body: "body" },
    status: "ok",
  },
  // -- edge rows (do-local; uniform edgeDrive) ------------------------------
  checkpoint: { args: { goal: "t26 matrix checkpoint" }, status: "ok" },
  // rewind without an active checkpoint fails closed — the error result IS a
  // terminal journal row, which is exactly what the matrix replays.
  rewind: { args: { report: "t26 findings" }, status: "error" },
  context_notes: { args: { text: "t26 matrix notebook" }, status: "ok" },
  new_context: { args: {}, status: "ok" },
  todo: {
    args: { op: "init", list: [{ phase: "matrix", items: ["walk the face"] }] },
    status: "ok",
  },
  // No owned work at entry → omp-verbatim immediate error return
  // (wait.ts:95-96 NOTHING_TO_WAIT_FOR) — a terminal journal row either way.
  wait: { args: {}, status: "error" },
  think: { args: { thoughts: "matrix scratchpad" }, status: "ok" },
  // ask / web_search / task / yield carry bespoke drives below (interaction
  // resolution, MSW network, child-DO chain) but the same assertion core.
  ask: { args: { questions: [ASK_QUESTION] }, status: "ok" },
  web_search: { args: { query: "t26 replay matrix" }, status: "ok" },
  task: {
    args: { task: "Report the answer.", solutionSpace: "one fix: none, names given" },
    status: "ok",
  },
  yield: { args: { data: { answer: 42 } }, status: "ok" },
};

const HOST_ROWS = TOOL_REGISTRY.filter((row) => row.class === "host").map((row) => row.name);
const EDGE_ROWS = TOOL_REGISTRY.filter(
  (row) => row.class === "edge" && !["ask", "web_search", "task", "yield"].includes(row.name),
).map((row) => row.name);

// ---------------------------------------------------------------------------
// Assertion core
// ---------------------------------------------------------------------------

/** Replay identity: seq/type/id triples (the established journal fingerprint);
 * ten call sites across the matrix assert this one lockstep shape. */
function fingerprint(events: readonly AnyAgentEvent[]): [number, string, string][] {
  return events.map((event) => [event.seq, event.type, event.id]);
}

/** Wire-schema boundary parse: the registry renderer's JSON-Schema document,
 * validated once so the intent-policy assertions read typed fields. */
const wireSchemaShape = z.object({
  properties: z.record(z.string(), z.unknown()),
  required: z.array(z.string()).optional(),
});

/** Matrix-table lookup with the completeness guarantee stated at runtime:
 * the completeness test fails the suite for a missing entry; these lookups
 * keep the drive sites total without non-null assertions. */
function matrixArgs(name: string): Record<string, unknown> {
  const row = MATRIX[name];
  if (row === undefined) throw new Error(`no T26 matrix entry for ${name}`);
  return row.args;
}

function matrixStatus(name: string): "ok" | "error" {
  const row = MATRIX[name];
  if (row === undefined) throw new Error(`no T26 matrix entry for ${name}`);
  return row.status;
}

function callEventOf(events: readonly AnyAgentEvent[], tool: string) {
  const call = events.find(
    (event): event is Extract<AnyAgentEvent, { type: "tool.call" }> =>
      event.type === "tool.call" && event.data.tool === tool,
  );
  if (call === undefined) throw new Error(`no tool.call journaled for ${tool}`);
  return call;
}

function resultEventOf(events: readonly AnyAgentEvent[], executionId: string) {
  const result = events.find(
    (event): event is Extract<AnyAgentEvent, { type: "tool.result" }> =>
      event.type === "tool.result" && event.data.executionId === executionId,
  );
  if (result === undefined) throw new Error(`no tool.result journaled for ${executionId}`);
  return result;
}

/** In-DO recovery seam: re-drive one execution with the SAME executionId. */
async function redispatch(stub: DurableObjectStub<AgentDO>, turnId: string, executionId: string) {
  await runInDurableObject(stub, async (instance) => {
    const seam = instance as unknown as {
      dispatchExecution: (turnId: string, executionId: string) => Promise<void>;
    };
    await seam.dispatchExecution(turnId, executionId);
  });
}

async function pendingExecutionId(rig: Rig): Promise<string> {
  const events = await rig.waitFor((all) =>
    all.some((event) => event.type === "tool.exec_started"),
  );
  const call = events.find((event) => event.type === "tool.call");
  if (call === undefined) throw new Error("tool.call never persisted");
  return executionIdFor(rig.threadId, call.seq);
}

// ---------------------------------------------------------------------------
// Registry + wire face (compile-time, every row — the §0 interface constraint)
// ---------------------------------------------------------------------------

describe("M1.5 T26 — matrix completeness and registry face", () => {
  test("every registered row has a matrix entry; every entry names a registered row", () => {
    for (const row of TOOL_REGISTRY) {
      expect(MATRIX[row.name], `registry row ${row.name} has no T26 matrix entry`).toBeDefined();
    }
    for (const name of Object.keys(MATRIX)) {
      expect(toolRegistryRow(name), `matrix entry ${name} is not a registry row`).toBeDefined();
    }
  });

  test("every row renders the frozen wire definition with its intent policy", () => {
    for (const row of TOOL_REGISTRY) {
      const def = toolWireDefinition(row, M0_RENDER_FLAGS);
      expect(def.name).toBe(row.name);
      expect(def.description.length).toBeGreaterThan(0);
      const schema = wireSchemaShape.parse(def.input_schema);
      if (row.intent === "require") {
        expect(schema.required).toContain("i");
      } else if (row.intent === "optional") {
        expect(schema.properties.i).toBeDefined();
        expect(schema.required ?? []).not.toContain("i");
      } else {
        expect(schema.properties.i).toBeUndefined();
      }
    }
  });

  test("surfaces are static projections: Main = registry minus hidden tail; subagent = full", () => {
    expect(MAIN_WIRE_TOOLS).toEqual(
      TOOL_REGISTRY.filter((row) => !SUBAGENT_ONLY_TOOLS.includes(row.name)).map((row) => row.name),
    );
    expect(
      TOOL_REGISTRY.filter((row) => SUBAGENT_ONLY_TOOLS.includes(row.name)).map((row) => row.name),
    ).toEqual(["yield"]);
  });
});

// ---------------------------------------------------------------------------
// Host rows — dispatch → mid-run abort dedup → complete → post-completion
// abort → re-ask = journal answer → targeted evict (§1 dispatch layer, §6)
// ---------------------------------------------------------------------------

async function hostRowContract(name: string, args: Record<string, unknown>): Promise<void> {
  const rig = await createRig({
    turns: [{ toolCalls: [{ name, arguments: args }] }, { deltas: ["done"] }],
  });
  const sent = await rig.stub.sendMessage({
    clientRequestId: `t26-host-${name}`,
    content: [{ type: "text", text: "run it" }],
    mode: "auto",
  });
  const executionId = await pendingExecutionId(rig);
  expect(await rig.service.spawnAckCount(executionId)).toBe(1);

  // Injection 1 — hard abort of the whole worker MID-RUNNING. Both DOs revive;
  // the journal is append-only (persisted rows never rewrite) and grows by
  // exactly the recovery verb: one tool.dispatch at attempt 2, answered from
  // records — zero double spawn (I15/I16).
  const before = await rig.events();
  await abortAllDurableObjects();
  const after = await rig.afterAbort(() => rig.events());
  // Append-only: every persisted row survives the kill byte-identical.
  expect(fingerprint(after.slice(0, before.length))).toEqual(fingerprint(before));
  expect(after.slice(before.length).map((event) => event.type)).toEqual(["tool.dispatch"]);
  const recoveryDispatch = after[before.length];
  if (recoveryDispatch?.type !== "tool.dispatch") throw new Error("unreachable");
  expect(recoveryDispatch.data.executionId).toBe(executionId);
  expect(recoveryDispatch.data.attempt).toBe(2);
  expect(await rig.service.spawnAckCount(executionId)).toBe(1);
  expect(await rig.service.derivedState(executionId)).toBe("RUNNING");

  // The one recovery verb closes the execution with exactly one result.
  await rig.service.clientExit(executionId, {
    status: "ok",
    exitCode: 0,
    output: `${name} ok`,
  });
  const done = await rig.waitTurnComplete(sent.turnId);
  const result = resultEventOf(done, executionId);
  expect(result.data.status).toBe("ok");
  expect(
    done.filter((event) => event.type === "tool.result" && event.data.executionId === executionId),
  ).toHaveLength(1);
  expect(await rig.service.spawnAckCount(executionId)).toBe(1);

  // Injection 2 — post-completion hard abort: identical replay, and the
  // result payload replays verbatim — the agent journal IS the payload
  // authority post-ack.
  await abortAllDurableObjects();
  const replayed = await rig.afterAbort(() => rig.events());
  expect(fingerprint(replayed)).toEqual(fingerprint(done));
  expect(resultEventOf(replayed, executionId).data).toEqual(result.data);

  // Dedup face — re-ask of the terminal executionId = journal answer
  // (§3.5 completed_cached), zero additional spawn. Post-ack the payload is
  // a tombstone memory (§5.2.4), so the guarantee here is the outcome KIND
  // + the spawn count, never a re-run; the payload verbatim face is the
  // agent-journal replay above.
  const reAsk = await rig.service.dispatch({
    threadId: rig.threadId,
    turnId: sent.turnId,
    executionId,
    machineId: rig.threadId,
    tool: name,
    arguments: args,
    timeoutMs: 60_000,
  });
  expect(reAsk.kind).toBe("completed_cached");
  // Cross-revival zero-spawn evidence is the journal (spawn_ack op count) —
  // a revived fake client's in-memory spawn list is per-incarnation.
  expect(await rig.service.spawnAckCount(executionId)).toBe(1);

  // Injection 3 — TARGETED eviction of the service DO (the other matrix
  // verb): heap clears, SQLite survives; the cached answer survives with it.
  await evictDurableObject(rig.service, { webSockets: "close" });
  expect(await rig.service.tombstoned(executionId)).toBe(true);
  const reAskAfterEvict = await rig.service.dispatch({
    threadId: rig.threadId,
    turnId: sent.turnId,
    executionId,
    machineId: rig.threadId,
    tool: name,
    arguments: args,
    timeoutMs: 60_000,
  });
  expect(reAskAfterEvict.kind).toBe("completed_cached");
  expect(await rig.service.spawnAckCount(executionId)).toBe(1);
}

describe("M1.5 T26 — host rows × replay/eviction matrix", () => {
  test.each(HOST_ROWS.map((name) => [name, matrixArgs(name)] as const))(
    "%s: journal replay identical; same-executionId re-ask = cached journal answer",
    async (name, args) => {
      await hostRowContract(name, args);
    },
  );
});

// ---------------------------------------------------------------------------
// Edge rows — do-local execution, zero daemon touches, replay identity, and
// the terminal-executionId re-dispatch as a no-op (zero re-execution)
// ---------------------------------------------------------------------------

async function edgeRowContract(
  name: string,
  args: Record<string, unknown>,
  status: "ok" | "error",
) {
  const rig = await createRig({
    turns: [{ toolCalls: [{ name, arguments: args }] }, { deltas: ["done"] }],
  });
  const sent = await rig.stub.sendMessage({
    clientRequestId: `t26-edge-${name}`,
    content: [{ type: "text", text: "run it" }],
    mode: "auto",
  });
  const done = await rig.waitTurnComplete(sent.turnId);
  const call = callEventOf(done, name);
  const executionId = executionIdFor(rig.threadId, call.seq);
  const result = resultEventOf(done, executionId);
  expect(result.data.status).toBe(status);

  // DO-budget face (§1 edge row): the execution never left this DO.
  expect(done.some((event) => event.type === "tool.dispatch")).toBe(false);
  await expect(rig.service.journal()).resolves.toEqual([]);

  // Injection 1 — post-completion hard abort: identical replay.
  await abortAllDurableObjects();
  const after = await rig.afterAbort(() => rig.events());
  expect(fingerprint(after)).toEqual(fingerprint(done));

  // Dedup face — the terminal executionId re-dispatch is a no-op: the
  // journal-derived terminal state guards re-execution (§6 agent dedup).
  await redispatch(rig.stub, sent.turnId, executionId);
  const replayed = await rig.events();
  expect(fingerprint(replayed)).toEqual(fingerprint(after));

  // Injection 2 — TARGETED eviction of THIS agent DO: same contract.
  await evictDurableObject(rig.stub);
  const evicted = await rig.events();
  expect(fingerprint(evicted)).toEqual(fingerprint(after));
  await redispatch(rig.stub, sent.turnId, executionId);
  expect(fingerprint(await rig.events())).toEqual(fingerprint(after));
}

describe("M1.5 T26 — edge rows × replay/eviction matrix", () => {
  test.each(EDGE_ROWS.map((name) => [name, matrixArgs(name), matrixStatus(name)] as const))(
    "%s: zero daemon touches; journal replay identical; re-dispatch is a no-op",
    async (name, args, status) => {
      await edgeRowContract(name, args, status);
    },
  );
});

// ---------------------------------------------------------------------------
// ask — the blocking interaction row IS the journal state; the resolution
// lands after a hard abort (ask T4 shape) and the completed face replays.
// ---------------------------------------------------------------------------

describe("M1.5 T26 — ask row (blocking interaction drive)", () => {
  test("resolution survives a mid-block abort; completed face replays identically", async () => {
    const rig = await createRig({
      turns: [
        { toolCalls: [{ name: "ask", arguments: { questions: [ASK_QUESTION] } }] },
        { deltas: ["done"] },
      ],
    });
    const sent = await rig.stub.sendMessage({
      clientRequestId: "t26-ask",
      content: [{ type: "text", text: "ask the user" }],
      mode: "start",
    });
    const events = await rig.waitFor((all) =>
      all.some((event) => event.type === "interaction.registered"),
    );
    const registered = events.find((event) => event.type === "interaction.registered");
    if (registered?.type !== "interaction.registered") throw new Error("no registered row");
    const call = callEventOf(events, "ask");
    const executionId = executionIdFor(rig.threadId, call.seq);
    const value0 = askOptionValue(executionId, 0);

    // Hard abort while the ask is BLOCKED, then resolve — the interaction row
    // replays from the journal and the resolution still journals (T4 anchor).
    await abortAllDurableObjects();
    await rig.afterAbort(async () => {
      await rig.stub.resolveInteraction({
        interactionId: registered.data.interactionId,
        resolution: { kind: "user_answer", answers: { storage: { selected: [value0] } } },
      });
    });
    const done = await rig.waitTurnComplete(sent.turnId);
    const result = resultEventOf(done, executionId);
    expect(result.data.status).toBe("ok");
    await expect(rig.service.journal()).resolves.toEqual([]);

    // Completed face: identical replay + terminal re-dispatch no-op.
    await abortAllDurableObjects();
    const after = await rig.afterAbort(() => rig.events());
    expect(fingerprint(after)).toEqual(fingerprint(done));
    await redispatch(rig.stub, sent.turnId, executionId);
    expect(fingerprint(await rig.events())).toEqual(fingerprint(after));
  });
});

// ---------------------------------------------------------------------------
// web_search — the outbound fetch IS the re-execution observable: replay
// answers from the journal with zero second fetches (T12 anchor).
// ---------------------------------------------------------------------------

const network = setupNetwork();

beforeAll(() => {
  network.enable();
});

afterAll(() => {
  network.disable();
});

const STARTPAGE_HTML = `<!doctype html><html><body>
<form action="/sp/search"><input type="hidden" name="sc" value="tok-abc"><input type="hidden" name="cat" value="web"></form>
<div class="result">
  <a class="result-link" href="https://example.org/alpha"><h2>Alpha result</h2></a>
  <p class="description">The alpha page.</p>
</div>
</body></html>`;
const DDG_HTML = `<!doctype html><html><body>
<div class="result results_links">
  <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fone&amp;rut=xyz">One</a>
  <a class="result__snippet">First snippet</a>
</div>
</body></html>`;

describe("M1.5 T26 — web_search row (outbound-fetch observable)", () => {
  test("one fan per execution; replay answers from the journal with zero second fetches", async () => {
    let startpageHits = 0;
    let ddgHits = 0;
    network.use(
      http.get("https://www.startpage.com/", () => HttpResponse.html(STARTPAGE_HTML)),
      http.post("https://www.startpage.com/sp/search", () => {
        startpageHits += 1;
        return HttpResponse.html(STARTPAGE_HTML);
      }),
      http.post("https://html.duckduckgo.com/html/", () => {
        ddgHits += 1;
        return HttpResponse.html(DDG_HTML);
      }),
    );
    const rig = await createRig({
      turns: [
        { toolCalls: [{ name: "web_search", arguments: { query: "t26 replay matrix" } }] },
        { deltas: ["done"] },
      ],
    });
    const sent = await rig.stub.sendMessage({
      clientRequestId: "t26-web-search",
      content: [{ type: "text", text: "search" }],
      mode: "start",
    });
    const done = await rig.waitTurnComplete(sent.turnId);
    const call = callEventOf(done, "web_search");
    const executionId = executionIdFor(rig.threadId, call.seq);
    const result = resultEventOf(done, executionId);
    expect(result.data.status).toBe("ok");
    expect(startpageHits).toBe(1);
    expect(ddgHits).toBe(1);
    await expect(rig.service.journal()).resolves.toEqual([]);

    // Hard abort → identical replay → re-dispatch answers from the journal:
    // the fetch counters never move again (zero second fan).
    await abortAllDurableObjects();
    const after = await rig.afterAbort(() => rig.events());
    expect(fingerprint(after)).toEqual(fingerprint(done));
    await redispatch(rig.stub, sent.turnId, executionId);
    const replayed = await rig.events();
    expect(fingerprint(replayed)).toEqual(fingerprint(after));
    expect(resultEventOf(replayed, executionId).data.output).toBe(result.data.output);
    expect(startpageHits).toBe(1);
    expect(ddgHits).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// task + yield — the background spawn chain over real child AgentDOs. The
// parent face: the spawn plan is journal truth — re-dispatch of the settled
// task executionId replays the registration receipt, never a second child.
// The yield face (child DO): the child journal replays identically and the
// child's yield executionId re-dispatch is a no-op.
// ---------------------------------------------------------------------------

const agentNamespace = (env as { AGENT_DO: DurableObjectNamespace }).AGENT_DO;

async function childEventsOf(childThreadId: string): Promise<AnyAgentEvent[]> {
  // Named cast: the namespace binding types the stub as the generic RPC base;
  // every child in this suite is an AgentDO by construction (idFromName of a
  // task.spawn_planned childThreadId).
  const stub = agentNamespace.get(
    agentNamespace.idFromName(childThreadId),
  ) as DurableObjectStub<AgentDO>;
  return stub.getEvents({}).then((response) => response.events);
}

describe("M1.5 T26 — task/yield rows (background spawn chain over real child DOs)", () => {
  test("task: settled plan replays from the journal — zero second spawn", async () => {
    const parentThreadId = newThreadId();
    const parentMock = new MockModelProvider([
      { toolCalls: [{ name: "task", arguments: matrixArgs("task") }] },
      { deltas: ["spawned"] },
    ]);
    const childMock = new MockModelProvider([
      { toolCalls: [{ name: "yield", arguments: matrixArgs("yield") }] },
      { deltas: ["submitted"] },
    ]);
    setAgentRuntime(parentThreadId, { provider: parentMock });
    setAgentRuntime("*", { provider: childMock });
    const rig = await createRig({ threadId: parentThreadId, provider: parentMock });
    const sent = await rig.stub.sendMessage({
      clientRequestId: "t26-task",
      content: [{ type: "text", text: "spawn a worker" }],
      mode: "start",
    });
    await rig.waitFor((all) => all.some((event) => event.type === "task.spawn_planned"));
    await rig.waitFor((all) => all.some((event) => event.type === "task.async_result"));
    const done = await rig.waitTurnComplete(sent.turnId);

    const doneEvents = await rig.events();
    const plans = doneEvents.filter((event) => event.type === "task.spawn_planned");
    expect(plans).toHaveLength(1);
    const call = callEventOf(doneEvents, "task");
    const executionId = executionIdFor(rig.threadId, call.seq);
    const result = resultEventOf(doneEvents, executionId);
    expect(result.data.status).toBe("ok");
    expect(result.data.output).toContain("Background:");
    await expect(rig.service.journal()).resolves.toEqual([]);

    // Hard abort → identical replay → the terminal task executionId re-asks
    // via readopt: the registration receipt replays, plans stay at ONE.
    await abortAllDurableObjects();
    const after = await rig.afterAbort(() => rig.events());
    expect(fingerprint(after)).toEqual(fingerprint(done));
    await redispatch(rig.stub, sent.turnId, executionId);
    const replayed = await rig.events();
    expect(fingerprint(replayed)).toEqual(fingerprint(after));
    expect(replayed.filter((event) => event.type === "task.spawn_planned")).toHaveLength(1);
    expect(resultEventOf(replayed, executionId).data.output).toBe(result.data.output);
  });

  test("yield: the child journal replays identically; the yield executionId re-dispatch is a no-op", async () => {
    const parentThreadId = newThreadId();
    const parentMock = new MockModelProvider([
      { toolCalls: [{ name: "task", arguments: matrixArgs("task") }] },
      { deltas: ["spawned"] },
    ]);
    const childMock = new MockModelProvider([
      { toolCalls: [{ name: "yield", arguments: matrixArgs("yield") }] },
      { deltas: ["submitted"] },
    ]);
    setAgentRuntime(parentThreadId, { provider: parentMock });
    setAgentRuntime("*", { provider: childMock });
    const rig = await createRig({ threadId: parentThreadId, provider: parentMock });
    const sent = await rig.stub.sendMessage({
      clientRequestId: "t26-yield",
      content: [{ type: "text", text: "spawn a worker" }],
      mode: "start",
    });
    await rig.waitFor((all) => all.some((event) => event.type === "task.spawn_planned"));
    await rig.waitFor((all) => all.some((event) => event.type === "task.async_result"));
    await rig.waitTurnComplete(sent.turnId);

    const parentEvents = await rig.events();
    const plan = parentEvents.find((event) => event.type === "task.spawn_planned");
    if (plan?.type !== "task.spawn_planned") throw new Error("no spawn plan");
    const childThreadId = plan.data.childThreadId;

    const childBefore = await childEventsOf(childThreadId);
    const yieldCall = callEventOf(childBefore, "yield");
    const yieldExecutionId = executionIdFor(childThreadId, yieldCall.seq);
    const yieldResult = resultEventOf(childBefore, yieldExecutionId);
    expect(yieldResult.data.status).toBe("ok");
    const childTurnId = yieldCall.data.turnId;

    // Hard abort kills the child DO too: identical replay from its journal.
    await abortAllDurableObjects();
    const childAfter = await childEventsOf(childThreadId);
    expect(fingerprint(childAfter)).toEqual(fingerprint(childBefore));

    // The child's terminal yield executionId re-dispatch is a no-op.
    const childStub = agentNamespace.get(
      agentNamespace.idFromName(childThreadId),
    ) as DurableObjectStub<AgentDO>;
    await redispatch(childStub, childTurnId, yieldExecutionId);
    const childReplayed = await childEventsOf(childThreadId);
    expect(fingerprint(childReplayed)).toEqual(fingerprint(childAfter));
  });
});

// ---------------------------------------------------------------------------
// Non-power rows (matrix §6 boundary) — bash/eval: the new-boot kill path
// exposes the unknowable outcome as a PERSISTED terminal (outcome_unknown),
// the UX renders it "interrupted", and nothing ever silently re-runs.
// ---------------------------------------------------------------------------

async function outcomeUnknownContract(name: string, args: Record<string, unknown>) {
  const rig = await createRig({
    turns: [{ toolCalls: [{ name, arguments: args }] }, { deltas: ["done"] }],
  });
  const sent = await rig.stub.sendMessage({
    clientRequestId: `t26-unknown-${name}`,
    content: [{ type: "text", text: "run it" }],
    mode: "auto",
  });
  const executionId = await pendingExecutionId(rig);
  expect(await rig.service.spawnAckCount(executionId)).toBe(1);

  // §6 boundary: the client restarts under a NEW boot while the body may
  // already have run — the kill-list exposes that as outcome_unknown, never
  // a fabricated ok.
  await rig.service.clientDisconnect();
  await rig.service.clientRestartNewBoot();
  const kills = await rig.service.clientKills();
  expect(kills).toHaveLength(1);
  expect(kills[0]).toMatchObject({ executionId, verified: true });

  const events = await rig.waitFor((all) =>
    all.some(
      (event) =>
        event.type === "tool.result" &&
        event.data.executionId === executionId &&
        event.data.status === "outcome_unknown",
    ),
  );
  expect(await rig.service.derivedState(executionId)).toBe("UNKNOWN");
  expect(await rig.service.spawnAckCount(executionId)).toBe(1);

  // Exposure, not masking: the UX projection renders "interrupted" (the SPA
  // never shows a fake completion).
  const ux = projectToUxEvents(events).map(parseThreadEvent);
  const completed = ux.find(
    (event): event is Extract<TypedThreadEvent, { type: "item/completed" }> =>
      event.type === "item/completed" && event.data.item.type === "toolCall",
  );
  if (completed === undefined) throw new Error("ux projection lost the toolCall item");
  const item = completed.data.item;
  if (item.type !== "toolCall") throw new Error("ux projection rendered a non-toolCall item");
  expect(item.id).toBe(executionId);
  expect(item.status).toBe("interrupted");

  // The recovery verb never re-runs the body: the agent-side terminal guard
  // no-ops the same-executionId re-dispatch (zero new journal rows).
  await redispatch(rig.stub, sent.turnId, executionId);
  expect(fingerprint(await rig.events())).toEqual(fingerprint(events));

  await rig.waitTurnComplete(sent.turnId);

  // Hard abort: the UNKNOWN outcome replays verbatim — a persisted terminal,
  // never rewritten into ok by recovery.
  await abortAllDurableObjects();
  const after = await rig.afterAbort(() => rig.events());
  expect(fingerprint(after)).toEqual(fingerprint(events));
  const replayedResult = resultEventOf(after, executionId);
  expect(replayedResult.data.status).toBe("outcome_unknown");
  expect(
    after.filter((event) => event.type === "tool.result" && event.data.executionId === executionId),
  ).toHaveLength(1);
}

describe("M1.5 T26 — non-power rows: outcome-unknown exposure (matrix §6 boundary)", () => {
  test("bash: kill-list lands a persisted outcome_unknown; ux interrupted; never re-run", async () => {
    await outcomeUnknownContract("bash", matrixArgs("bash"));
  });

  test("eval: kill-list lands a persisted outcome_unknown; ux interrupted; never re-run", async () => {
    await outcomeUnknownContract("eval", matrixArgs("eval"));
  });
});
