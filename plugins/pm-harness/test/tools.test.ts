import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  _spawnFallbackInstalled,
  _inject,
  lane,
  lease,
  registerSpawn,
  registerSpawnFallback,
  walk,
  walkDone,
  type GqlFn,
  type SpawnRequest,
} from "../src/core.js";
import { createPmHarnessTools, detachedLaneSpawn } from "../src/tools.js";
import type { CustomTool, CustomToolAPI, ToolResult, ZodBuilder, ZodNode } from "../src/host-types.js";
import { LABEL_IDS, MockBoard, PRIORITY_FIELD_ID, STATUS_FIELD_ID } from "./fixtures/mock-board.js";

// The child_process mock is hoisted so the static import of tools.js below
// binds the mocked spawn — no dynamic import needed to exercise the detached
// transport. core.ts's execFileSync binding is included for module integrity;
// every core path that would call it is injected away in this file.
const spawnMock = vi.hoisted(() =>
  vi.fn((_command: string, _args: string[], _options: { detached?: boolean; stdio?: unknown[] }) => ({
    pid: 4242,
    unref: () => undefined,
  })),
);
vi.mock("node:child_process", () => ({
  spawn: spawnMock,
  execFileSync: () => {
    throw new Error("mock child_process: execFileSync must stay injected away in tools.test");
  },
}));

/**
 * L1 for the #270 custom-tool family (plugins/pm-harness/src/tools.ts). Same
 * discipline as core.test.ts: zero network — the GitHub transport is the
 * shared in-memory MockBoard, git is an injected recorder, and the lease
 * ledger runs on a real tmp file (this file does NOT mock node:fs, unlike
 * core.test.ts's wholesale mock — the tools' ledger/release path exercises
 * real fs on tmp).
 *
 * Covered: factory surface (six discoverable tools), pm_apply preflight
 * rejection of closed-state drift + guarded write + per-batch verify-drift
 * refusal, pm_audit → pm_apply reconcile loop, pm_lane dry-run/refusal/
 * confirm dispatch through the registered transport, the #270 detached-omp
 * fallback ladder (unit + factory-install + lane-level + PM_LANE_NO_DETACH
 * escape hatch), the pm_release/pm_ledger ledger pair, and the pm_walk
 * 走查挂账 ledger + pm_audit's always-armed rule 8 (#391).
 */

// ---------------------------------------------------------------------------
// Fixtures — fake host API + board
// ---------------------------------------------------------------------------

/** Chainable no-op schema node: the factory only BUILDS schemas; omp does the
 *  real validation host-side, so the test builder just has to answer the
 *  chain calls. */
function chainNode(): ZodNode {
  const node: ZodNode = {
    describe: () => node,
    optional: () => node,
    default: () => node,
    int: () => node,
    positive: () => node,
  };
  return node;
}

const fakeZod: ZodBuilder = {
  object: () => chainNode(),
  array: () => chainNode(),
  union: () => chainNode(),
  number: () => chainNode(),
  string: () => chainNode(),
  boolean: () => chainNode(),
  null: () => chainNode(),
  enum: () => chainNode(),
};

function fakeApi(): CustomToolAPI {
  return {
    cwd: "/tmp/pm-harness-tools-test",
    exec: () => Promise.resolve({ stdout: "", stderr: "", code: 0, killed: false }),
    hasUI: false,
    zod: fakeZod,
  };
}

function toolByName(tools: CustomTool[], name: string): CustomTool {
  const found = tools.find((t) => t.name === name);
  if (found === undefined) throw new Error(`tool ${name} not registered`);
  return found;
}


/** omp invokes execute with the full 5-arg signature; tests pass the host's
 *  no-UI shape (no update callback, inert ctx, no signal). Async bridge: a
 *  sync execute throw surfaces as a rejection, like the host's adapter. */
async function callTool(tool: CustomTool, params: unknown): Promise<ToolResult> {
  const ctx = {
    sessionManager: null,
    modelRegistry: null,
    model: null,
    isIdle: () => true,
    hasQueuedMessages: () => false,
    abort: () => undefined,
  };
  return await tool.execute("t", params, undefined, ctx, undefined);
}

/** Tool details are opaque (unknown) at the CustomTool boundary. Every shape
 *  read here is one this file's own detail pickers rendered; the keys list is
 *  the lightweight runtime check that keeps the cast honest (missing key ⇒
 *  loud failure, not a silently-wrong read). */
function toolDetails<T extends object>(result: ToolResult, keys: readonly (keyof T)[]): T {
  const details = result.details as T;
  for (const key of keys) {
    if (!(key in details)) throw new Error(`tool details missing key: ${String(key)}`);
  }
  return details;
}

/** A dispatchable Todo ticket (#310) and an open-blocked Todo (#311). */
function seedBoard(): MockBoard {
  const board = new MockBoard();
  // Fresh updatedAt: audit rule 4 (frontier aging) must stay silent — these
  // tests assert the write-drift rules, not the reminder class.
  const fresh = new Date().toISOString();
  board.addIssue({
    number: 310,
    title: "[infra] tools test: dispatchable todo ticket",
    bodyText: "三问：reuse\n验收：observable\n锚点：a",
    updatedAt: fresh,
  });
  board.addIssue({
    number: 311,
    title: "[infra] tools test: blocked todo ticket",
    blockedBy: { nodes: [{ number: 999, state: "OPEN", title: "blocker" }] },
    updatedAt: fresh,
  });
  board.boardIssue(310, "Todo", "P2");
  board.boardIssue(311, "Todo", "P2");
  return board;
}

// ---------------------------------------------------------------------------
// Factory surface
// ---------------------------------------------------------------------------

describe("pm-harness tools factory (#270)", () => {
  it("registers exactly the six tools under stable names", () => {
    const tools = createPmHarnessTools(fakeApi());
    expect(tools.map((t) => t.name)).toEqual([
      "pm_lane",
      "pm_apply",
      "pm_audit",
      "pm_release",
      "pm_ledger",
      "pm_walk",
    ]);
    for (const t of tools) {
      expect(t.label.length).toBeGreaterThan(0);
      expect(t.description.length).toBeGreaterThan(0);
      expect(t.parameters).toBeDefined();
      expect(typeof t.execute).toBe("function");
    }
  });
});

// ---------------------------------------------------------------------------
// pm_apply — the guarded write tool
// ---------------------------------------------------------------------------

describe("pm_apply tool", () => {
  afterEach(() => {
    _inject(null);
  });

  it("rejects closed-state Status on an open ticket as a preflight error — zero writes even with confirm", async () => {
    const board = seedBoard();
    _inject({ gql: board.gql satisfies GqlFn });
    const apply = toolByName(createPmHarnessTools(fakeApi()), "pm_apply");

    const result = await callTool(apply, {
      mutations: [{ op: "setStatus", number: 310, value: "Done" }],
      confirm: true,
    });
    const details = toolDetails<{ ok: boolean; preflight: { errors: string[] } }>(result, ["ok"]);
    expect(details.ok).toBe(false);
    expect(details.preflight.errors.length).toBeGreaterThan(0);
    expect(board.mutations).toEqual([]); // guarded: preflight errors abort everything
  });

  it("dry-run diffs without writing; confirm applies and verifies against the live board", async () => {
    const board = seedBoard();
    _inject({ gql: board.gql satisfies GqlFn });
    const apply = toolByName(createPmHarnessTools(fakeApi()), "pm_apply");

    const dry = await callTool(apply, {
      mutations: [{ op: "setStatus", number: 310, value: "In Progress" }],
    });
    const dryDetails = toolDetails<{
      ok: boolean;
      dryRun: boolean;
      preflight: { willChange: unknown[] };
    }>(dry, ["ok"]);
    expect(dryDetails.ok).toBe(true);
    expect(dryDetails.dryRun).toBe(true);
    expect(dryDetails.preflight.willChange.length).toBe(1);
    expect(board.mutations).toEqual([]);

    const live = await callTool(apply, {
      mutations: [{ op: "setStatus", number: 310, value: "In Progress" }],
      confirm: true,
    });
    const liveDetails = toolDetails<{
      ok: boolean;
      dryRun: boolean;
      appliedBatches: number[][];
      verified: boolean;
    }>(live, ["ok"]);
    expect(liveDetails.ok).toBe(true);
    expect(liveDetails.dryRun).toBe(false);
    expect(liveDetails.appliedBatches).toEqual([[310]]);
    expect(liveDetails.verified).toBe(true);
    expect(board.tickets().find((t) => t.number === 310)?.status).toBe("In Progress");
  });

  it("refuses on per-batch verify drift: board silently ate the write → batches withheld", async () => {
    const board = seedBoard();
    board.failStatusWrites = true; // drift injection: status writes do nothing
    _inject({ gql: board.gql satisfies GqlFn });
    const apply = toolByName(createPmHarnessTools(fakeApi()), "pm_apply");

    const result = await callTool(apply, {
      mutations: [{ op: "setStatus", number: 310, value: "In Progress" }],
      confirm: true,
    });
    const details = toolDetails<{
      ok: boolean;
      appliedBatches: number[][];
      verifyFailure: { detail: string } | null;
    }>(result, ["ok"]);
    expect(details.ok).toBe(false);
    expect(details.appliedBatches).toEqual([]);
    expect(details.verifyFailure).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// pm_audit → pm_apply reconcile loop
// ---------------------------------------------------------------------------

describe("pm_audit tool", () => {
  afterEach(() => {
    _inject(null);
  });

  it("finds inProgressOnClosed drift and its repair mutations reconcile the board", async () => {
    const board = seedBoard();
    board.addIssue({ number: 312, title: "dead lane ticket", state: "CLOSED" });
    board.boardIssue(312, "In Progress", "P1"); // closed issue, lane died
    _inject({ gql: board.gql satisfies GqlFn });
    const auditTool = toolByName(createPmHarnessTools(fakeApi()), "pm_audit");
    const apply = toolByName(createPmHarnessTools(fakeApi()), "pm_apply");

    const first = await callTool(auditTool, { activeLanes: [312] });
    const details = toolDetails<{
      clean: boolean;
      drift: { rule: string; number: number }[];
      mutations: { op: string; number: number; value: string }[];
    }>(first, ["clean"]);
    expect(details.clean).toBe(false);
    expect(details.drift).toContainEqual(
      expect.objectContaining({ rule: "inProgressOnClosed", number: 312 }),
    );
    expect(details.mutations.length).toBeGreaterThan(0);

    const repaired = await callTool(apply, { mutations: details.mutations, confirm: true });
    expect(toolDetails<{ ok: boolean }>(repaired, ["ok"]).ok).toBe(true);

    // The converged ticket leaves the active-lane roster (rule 3 reports it
    // mutation-free: the roster was stale, the board was right).
    const second = await callTool(auditTool, { activeLanes: [] });
    expect(toolDetails<{ clean: boolean }>(second, ["clean"]).clean).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// pm_lane — dispatch tool (dry-run, refusal, confirm through a transport)
// ---------------------------------------------------------------------------

describe("pm_lane tool", () => {
  afterEach(() => {
    _inject(null);
    registerSpawn(null);
    registerSpawnFallback(null);
  });

  it("dry-run plans without creating the worktree or spawning", async () => {
    const board = seedBoard();
    const gitCalls: string[][] = [];
    _inject({
      gql: board.gql satisfies GqlFn,
      runGit: (args) => {
        gitCalls.push(args);
        return "";
      },
    });
    const laneTool = toolByName(createPmHarnessTools(fakeApi()), "pm_lane");

    const result = await callTool(laneTool, { ticket: 310 });
    const details = toolDetails<{
      reports: { dryRun: boolean; refused: boolean; spawned: boolean }[];
    }>(result, ["reports"]);
    expect(details.reports[0]?.dryRun).toBe(true);
    expect(details.reports[0]?.refused).toBe(false);
    expect(details.reports[0]?.spawned).toBe(false);
    expect(gitCalls).toEqual([]); // no worktree provision on a plan
    expect(board.mutations).toEqual([]); // no board flip either
  });

  it("refuses a board-predicate failure (open blocker) without a spawn packet", async () => {
    const board = seedBoard();
    _inject({ gql: board.gql satisfies GqlFn });
    const laneTool = toolByName(createPmHarnessTools(fakeApi()), "pm_lane");

    const result = await callTool(laneTool, { ticket: 311, confirm: true });
    const details = toolDetails<{
      reports: { refused: boolean; refusalReasons: string[]; spawned: boolean }[];
    }>(result, ["reports"]);
    expect(details.reports[0]?.refused).toBe(true);
    expect(details.reports[0]?.refusalReasons.length).toBeGreaterThan(0);
    expect(details.reports[0]?.spawned).toBe(false);
  });

  it("confirm dispatches end-to-end: worktree provision, spawn receipt, guarded board flip", async () => {
    const board = seedBoard();
    const gitCalls: string[][] = [];
    const spawned: SpawnRequest[] = [];
    _inject({
      gql: board.gql satisfies GqlFn,
      runGit: (args) => {
        gitCalls.push(args);
        return "";
      },
    });
    registerSpawn((p) => {
      spawned.push(p);
      return { id: `agent-${spawned.length}` };
    });
    const laneTool = toolByName(createPmHarnessTools(fakeApi()), "pm_lane");

    const result = await callTool(laneTool, { ticket: 310, confirm: true });
    const details = toolDetails<{
      reports: {
        ok: boolean;
        worktreeCreated: boolean;
        spawned: boolean;
        transport: string;
        agentId: string | null;
        statusFlipped: boolean;
        statusError: string | null;
      }[];
    }>(result, ["reports"]);
    const rep = details.reports[0];
    expect(rep?.ok).toBe(true);
    expect(rep?.worktreeCreated).toBe(true);
    expect(gitCalls[0]?.slice(0, 2)).toEqual(["worktree", "add"]);
    expect(rep?.spawned).toBe(true);
    expect(rep?.transport).toBe("registered");
    expect(rep?.agentId).toBe("agent-1");
    expect(rep?.statusFlipped).toBe(true);
    expect(rep?.statusError).toBeNull();
    // The worktree path rides the spawn request for cwd-aware transports (#270).
    expect(spawned[0]?.cwd).toContain(".herdr/worktrees/cloudflare-agent-project/lane-310-");
    // The dispatch pipeline owns the board flip.
    expect(board.tickets().find((t) => t.number === 310)?.status).toBe("In Progress");
  });
});

// ---------------------------------------------------------------------------
// #270 detached-omp fallback ladder
// ---------------------------------------------------------------------------

describe("detached-omp spawn fallback", () => {
  afterEach(() => {
    _inject(null);
    registerSpawn(null);
    registerSpawnFallback(null);
    delete process.env.PM_LANE_NO_DETACH;
    vi.restoreAllMocks();
  });

  it("refuses to spawn without a provisioned worktree cwd", () => {
    expect(() => detachedLaneSpawn({ prompt: "p", label: "l", agent: "task", context: null })).toThrow(
      /no worktree cwd/,
    );
  });

  it("spawns a detached `omp -p --cwd <worktree>` with one append fd for out+err", () => {
    const dir = mkdtempSync(join(tmpdir(), "pm-lane-"));
    try {
      const handle = detachedLaneSpawn({
        prompt: "lane context",
        label: "lane-310-x",
        agent: "task",
        context: null,
        cwd: dir,
      }) as { id: string; pid: number | null; log: string };
      expect(handle.id).toBe("pid-4242");
      expect(handle.pid).toBe(4242);
      expect(spawnMock).toHaveBeenCalledWith(
        "omp",
        ["-p", "lane context", "--cwd", dir],
        expect.objectContaining({ detached: true }),
      );
      const options = spawnMock.mock.calls[0]?.[2];
      // Both stdout and stderr append to the same lane log descriptor.
      expect(options?.stdio?.[1]).toEqual(options?.stdio?.[2]);
      expect(handle.log.startsWith(dir)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("lane() confirm resolves the factory-installed fallback when no kernel/override exists", async () => {
    registerSpawnFallback(null);
    expect(_spawnFallbackInstalled()).toBe(false);
    createPmHarnessTools(fakeApi()); // the factory installs the detached transport
    expect(_spawnFallbackInstalled()).toBe(true);

    // Ladder behavior with a deterministic stub in the same slot.
    registerSpawnFallback((p) => ({ id: "fallback-pid", cwd: p.cwd }));
    const board = seedBoard();
    const gitCalls: string[][] = [];
    _inject({
      gql: board.gql satisfies GqlFn,
      runGit: (args) => {
        gitCalls.push(args);
        return "";
      },
    });
    const report = await lane(310, {}, { confirm: true });
    expect(report.transport).toBe("fallback");
    expect(report.spawned).toBe(true);
    expect(report.agentId).toBe("fallback-pid");
    expect(report.statusFlipped).toBe(true);
  });

  it("PM_LANE_NO_DETACH=1 restores the transport-missing contract", async () => {
    const board = seedBoard();
    _inject({ gql: board.gql satisfies GqlFn, runGit: () => "" });
    registerSpawnFallback((p) => ({ id: "fallback-pid", cwd: p.cwd }));
    process.env.PM_LANE_NO_DETACH = "1";

    const report = await lane(310, {}, { confirm: true });
    expect(report.transport).toBe("missing");
    expect(report.spawned).toBe(false);
    expect(report.ok).toBe(false);
    expect(report.spawnError).toContain("PM_LANE_NO_DETACH");
  });
});

// ---------------------------------------------------------------------------
// pm_release / pm_ledger — the lease pair (real tmp-file ledger)
// ---------------------------------------------------------------------------

describe("pm_release + pm_ledger tools", () => {
  const tmpRoot = mkdtempSync(join(tmpdir(), "pm-ledger-"));

  afterEach(() => {
    _inject(null);
  });

  it("release closes an active lease; ledger replays events and the active set", async () => {
    const ledgerPath = join(tmpRoot, "release-case.jsonl");
    rmSync(ledgerPath, { force: true });
    lease(
      "browser",
      { lane: "lane-310-x", tabName: "l310", threadPrefix: "l310-", number: 310 },
      { path: ledgerPath },
    );
    const api = fakeApi();
    const releaseTool = toolByName(createPmHarnessTools(api), "pm_release");
    const ledgerTool = toolByName(createPmHarnessTools(api), "pm_ledger");

    const before = await callTool(ledgerTool, { leasesPath: ledgerPath });
    const beforeDetails = toolDetails<{ events: unknown[]; active: unknown[] }>(before, ["events"]);
    expect(beforeDetails.events.length).toBe(1);
    expect(beforeDetails.active.length).toBe(1);

    const released = await callTool(releaseTool, {
      type: "browser",
      lane: "lane-310-x",
      leasesPath: ledgerPath,
    });
    expect(toolDetails<{ releasedAt: string | null }>(released, ["releasedAt"]).releasedAt).not.toBeNull();

    const after = await callTool(ledgerTool, { leasesPath: ledgerPath });
    const afterDetails = toolDetails<{ events: unknown[]; active: unknown[] }>(after, ["events"]);
    expect(afterDetails.events.length).toBe(2);
    expect(afterDetails.active).toEqual([]);

    // Release without an active lease is a ledger bug — the tool surfaces it.
    await expect(
      callTool(releaseTool, { type: "browser", lane: "lane-310-x", leasesPath: ledgerPath }),
    ).rejects.toThrow();
  });

  it("ledger tolerates a missing file (empty view, no fabrication)", async () => {
    const ledgerTool = toolByName(createPmHarnessTools(fakeApi()), "pm_ledger");
    const result = await callTool(ledgerTool, { leasesPath: join(tmpRoot, "absent.jsonl") });
    expect(result.details).toEqual({ events: [], active: [] });
  });

  it("appends readable jsonl events at the overridden path", () => {
    const ledgerPath = join(tmpRoot, "append-case.jsonl");
    rmSync(ledgerPath, { force: true });
    lease(
      "browser",
      { lane: "lane-311-y", tabName: "l311", threadPrefix: "l311-", number: 311 },
      { path: ledgerPath },
    );
    const raw = readFileSync(ledgerPath, "utf8").trim().split("\n");
    expect(raw.length).toBe(1);
    expect(JSON.parse(raw[0] ?? "{}")).toMatchObject({
      event: "acquired",
      type: "browser",
      lane: "lane-311-y",
      tabName: "l311",
      number: 311,
    });
  });

  it("board fixture vocabulary stays anchored", () => {
    expect(Object.keys(LABEL_IDS)).toContain("ready-for-human");
    expect(STATUS_FIELD_ID).toBe("F_status");
    expect(PRIORITY_FIELD_ID).toBe("F_priority");
  });
});

// ---------------------------------------------------------------------------
// pm_walk — the 走查挂账 ledger tool + pm_audit's always-armed rule 8 (#391)
// ---------------------------------------------------------------------------

describe("pm_walk tool", () => {
  const tmpRoot = mkdtempSync(join(tmpdir(), "pm-walks-"));

  afterEach(() => {
    _inject(null);
  });

  it("register → done → list drives the ledger; missing args throw before any write", async () => {
    const walksPath = join(tmpRoot, "walk-drive.jsonl");
    rmSync(walksPath, { force: true });
    const tools = createPmHarnessTools(fakeApi());
    const walkTool = toolByName(tools, "pm_walk");

    const registered = await callTool(walkTool, {
      action: "register",
      number: 382,
      due: "2026-10-08",
      face: "staging 真机面板走查（cap-provider-config 两 section）",
      walksPath,
    });
    expect(toolDetails<{ event: string; number: number; due: string }>(registered, [
      "event",
    ])).toMatchObject({ event: "walk-due", number: 382, due: "2026-10-08" });
    expect(registered.content[0]?.text).toContain("registered (due 2026-10-08)");

    await expect(callTool(walkTool, { action: "register", number: 364, walksPath })).rejects.toThrow(
      /requires number, due and face/,
    );
    await expect(callTool(walkTool, { action: "done", number: 382, walksPath })).rejects.toThrow(
      /requires number and evidence/,
    );

    const listed = await callTool(walkTool, { action: "list", walksPath });
    const listDetails = toolDetails<{ events: unknown[]; active: { number: number }[] }>(listed, [
      "events",
    ]);
    expect(listDetails.events).toHaveLength(1);
    expect(listDetails.active.map((w) => w.number)).toEqual([382]);

    const settled = await callTool(walkTool, {
      action: "done",
      number: 382,
      evidence: "walk 报告评论",
      walksPath,
    });
    expect(toolDetails<{ event: string; evidence: string }>(settled, ["event"])).toMatchObject({
      event: "walk-done",
      evidence: "walk 报告评论",
    });

    const after = await callTool(walkTool, { action: "list", walksPath });
    expect(
      toolDetails<{ events: unknown[]; active: unknown[] }>(after, ["events", "active"]).active,
    ).toEqual([]);
  });
});

describe("pm_audit rule 8 wiring (#391)", () => {
  const tmpRoot = mkdtempSync(join(tmpdir(), "pm-audit-walks-"));

  afterEach(() => {
    _inject(null);
  });

  it("always arms from the repo ledger: an overdue deferral surfaces with its red-flip repair", async () => {
    const walksPath = join(tmpRoot, "armed.jsonl");
    rmSync(walksPath, { force: true });
    walk(310, "2020-01-01", "长挂未走的走查面", { path: walksPath });

    const board = seedBoard(); // #310: dispatchable Todo
    _inject({ gql: board.gql satisfies GqlFn });
    const auditTool = toolByName(createPmHarnessTools(fakeApi()), "pm_audit");
    const apply = toolByName(createPmHarnessTools(fakeApi()), "pm_apply");

    const first = await callTool(auditTool, { walksPath });
    const details = toolDetails<{
      clean: boolean;
      drift: { rule: string; number: number; detail: string }[];
      mutations: { op: string; number: number; value: string }[];
    }>(first, ["clean"]);
    expect(details.clean).toBe(false);
    expect(details.drift).toContainEqual(
      expect.objectContaining({ rule: "walkDueOverdue", number: 310 }),
    );
    expect(details.mutations).toContainEqual({
      op: "setStatus",
      number: 310,
      value: "Wait for user",
    });

    // The repair is apply-ready: one guarded write flips the board red.
    const repaired = await callTool(apply, { mutations: details.mutations, confirm: true });
    expect(toolDetails<{ ok: boolean }>(repaired, ["ok"]).ok).toBe(true);

    // Re-audit: already red — the finding stays (unsettled) but mutation-free.
    const second = await callTool(auditTool, { walksPath });
    const secondDetails = toolDetails<{
      clean: boolean;
      drift: { rule: string; number: number; mutation: unknown }[];
    }>(second, ["clean", "drift"]);
    expect(secondDetails.drift).toContainEqual(
      expect.objectContaining({ rule: "walkDueOverdue", number: 310, mutation: null }),
    );
  });

  it("a settled walk keeps the audit clean", async () => {
    const walksPath = join(tmpRoot, "settled.jsonl");
    rmSync(walksPath, { force: true });
    walk(310, "2020-01-01", "已销账的走查面", { path: walksPath });
    walkDone(310, "walk 报告", { path: walksPath });

    _inject({ gql: seedBoard().gql satisfies GqlFn });
    const auditTool = toolByName(createPmHarnessTools(fakeApi()), "pm_audit");
    const result = await callTool(auditTool, { walksPath });
    expect(toolDetails<{ clean: boolean }>(result, ["clean"]).clean).toBe(true);
  });
});
