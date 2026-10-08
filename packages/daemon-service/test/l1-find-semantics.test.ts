import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  createToolHost,
  executeDispatch,
  type ToolDispatchFrame,
  type ToolHost,
} from "../src/client/tool-runtime.js";
import { findExecPayloadSchema, type FindExecPayload } from "@cap/agent-do/find-protocol";

/**
 * L1 per-tool semantics for find's EXECUTION phase (#523, user ruling
 * 2026-10-08) — the vendored omp jfind cascade with the judge leg removed:
 * lexical scan, read selection, windows, sketches, survivor selection all
 * run on the host with ZERO model infrastructure; the result is a
 * structured candidate payload (find-protocol v1) the edge judges through
 * its relay registry. The host pins:
 *
 * 1. zero ModelRegistry dependency — the session carries no registry, no
 *    auth storage, and execution never dials a model;
 * 2. payload fidelity — the omp cascade's degraded-judge fallbacks
 *    (lexical read selection, all-cards-kept survivors, per-file
 *    verification batching) arrive with full line coordinates;
 * 3. deterministic execution — the same query yields the same candidates;
 * 4. honest degradation — an empty scope yields zero batches, not an
 *    error; a cancelled caller surfaces as a cancelled result.
 *
 * omp module imports stay DYNAMIC in this file (exception to the static
 * import rule): omp ships raw TS over the native addon — static specifiers
 * would evaluate the omp module graph before beforeAll's addon-version gate
 * can refuse a stale addon (the tool-runtime.ts constraint, restated per
 * test file; same pattern as tool-runtime.test.ts).
 */

const MACHINE = "machine-l1-find";

let root: string;
let fixture: string;
let host: ToolHost;

function frameOf(
  tool: string,
  executionId: string,
  args: Record<string, unknown>,
  timeoutMs = 60_000,
): ToolDispatchFrame {
  return { tool, arguments: args, executionId, machineId: MACHINE, timeoutMs };
}

/** One workspace file with `hits` mentions of the query keyword. */
function codeFile(name: string, hits: number): string {
  return [
    `// ${name}: login session handling`,
    ...Array.from(
      { length: hits },
      (_, i) => `export function loginHandler${i}(session: string) {`,
    ),
    "  return session;",
    "}",
  ].join("\n");
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "omp-find-l1-"));
  fixture = join(root, "workspace");
  mkdirSync(join(fixture, "src"), { recursive: true });
  writeFileSync(
    join(fixture, "src", "login.ts"),
    ["export function loginUser(name: string) {", "  return `session for ${name}`;", "}"].join(
      "\n",
    ),
  );
  writeFileSync(
    join(fixture, "src", "logout.ts"),
    ["export function logoutUser(session: string) {", "  session.length = 0;", "}"].join("\n"),
  );
  writeFileSync(join(fixture, "notes.md"), "plain documentation, no code\n");
  // Enough eligible files to exercise the read cap (20 files) and the
  // survivor budget (40 passages).
  const bulk = join(fixture, "src", "bulk");
  mkdirSync(bulk, { recursive: true });
  for (let i = 0; i < 30; i += 1) {
    writeFileSync(join(bulk, `mod${i}.ts`), codeFile(`mod${i}`, 3));
  }
  host = await createToolHost(fixture, join(root, "omp-agent"), MACHINE);
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

async function execFind(
  executionId: string,
  args: Record<string, unknown>,
): Promise<
  | { kind: "payload"; payload: FindExecPayload; raw: string }
  | { kind: "status"; status: string; output: string }
> {
  const result = await executeDispatch(host, frameOf("find", executionId, args));
  if (result.status !== "ok")
    return { kind: "status", status: result.status, output: result.output };
  const payload = findExecPayloadSchema.parse(JSON.parse(result.output));
  return { kind: "payload", payload, raw: result.output };
}

describe("find execution wiring (#523)", () => {
  test("the host carries find with ZERO model infrastructure", () => {
    expect(host.tools.find?.name).toBe("find");
    // The #523 cut: no ModelRegistry, no auth storage on the host session —
    // the old "find has no model registry" seam cannot exist.
    expect("modelRegistry" in host.session).toBe(false);
    expect("authStorage" in host.session).toBe(false);
  });

  test("execution returns the candidate payload with no model dialed", async () => {
    const outcome = await execFind("fd-1", { query: "login flow", grep_keywords: ["login"] });
    expect(outcome.kind).toBe("payload");
    if (outcome.kind !== "payload") return;
    const { payload } = outcome;
    expect(payload.v).toBe(1);
    expect(payload.query).toBe("login flow");
    expect(payload.threshold).toBe(0.2);
    expect(payload.keywords).toContain("login");
    expect(payload.cwd).toBe(fixture);
    // Reads happened (the lexical prior ranks login.ts first).
    expect(payload.stats.listed).toBe(33);
    expect(payload.stats.filesRead).toBe(20);
    // Verification candidates exist with full line coordinates.
    expect(payload.batches.length).toBeGreaterThan(0);
    const withHits = payload.batches.filter((batch) => batch.rel.endsWith("login.ts"));
    expect(withHits.length).toBeGreaterThan(0);
    for (const batch of payload.batches) {
      expect(batch.passages.length).toBeLessThanOrEqual(3);
      expect(batch.system.length).toBeGreaterThan(0);
      expect(batch.user).toContain(batch.passages[0].key);
      for (const passage of batch.passages) {
        expect(passage.start).toBeGreaterThanOrEqual(1);
        expect(passage.end).toBeGreaterThanOrEqual(passage.start);
        expect(passage.bytes).toBeGreaterThan(0);
      }
    }
  });

  test("survivor budget: at most 40 passages across at most 40-passage files", async () => {
    const outcome = await execFind("fd-2", { query: "login flow", grep_keywords: ["login"] });
    if (outcome.kind !== "payload") throw new Error("expected payload");
    const passages = outcome.payload.batches.reduce(
      (total, batch) => total + batch.passages.length,
      0,
    );
    expect(passages).toBeLessThanOrEqual(40);
    // Read cap: the cascade reads at most 20 files.
    expect(outcome.payload.files.length).toBeLessThanOrEqual(20);
  });

  test("execution is deterministic — the same query yields the same candidates", async () => {
    const first = await execFind("fd-3a", { query: "login flow", grep_keywords: ["login"] });
    const second = await execFind("fd-3b", { query: "login flow", grep_keywords: ["login"] });
    if (first.kind !== "payload" || second.kind !== "payload") throw new Error("expected payloads");
    const strip = (payload: FindExecPayload): string => {
      const clone = structuredClone(payload);
      clone.stats.elapsedMs = 0;
      return JSON.stringify(clone);
    };
    expect(strip(second.payload)).toBe(strip(first.payload));
  });

  test("an empty scope yields zero batches — a useless find, not an error", async () => {
    const emptyRoot = join(root, "empty");
    mkdirSync(emptyRoot, { recursive: true });
    // The host is rooted at the fixture; an empty DIRECTORY scope narrows
    // the search and lists nothing.
    const outcome = await execFind("fd-4", {
      query: "anything",
      grep_keywords: [],
      path: join(emptyRoot),
    });
    if (outcome.kind !== "payload") throw new Error(`expected payload: ${JSON.stringify(outcome)}`);
    expect(outcome.payload.stats.listed).toBe(0);
    expect(outcome.payload.batches).toHaveLength(0);
  });

  test("an absolute scope outside the workspace resolves through internal URLs honestly", async () => {
    // `find` scopes resolve via omp's resolveSearchRoot: a missing scope is
    // an execution error (the edge renders it as a structured find error).
    const outcome = await execFind("fd-5", {
      query: "anything",
      grep_keywords: [],
      path: join(root, "does-not-exist"),
    });
    expect(outcome.kind).toBe("status");
    if (outcome.kind !== "status") return;
    expect(outcome.status).toBe("error");
  });

  test("a cancelled caller aborts out of the execution — never a payload", async () => {
    const controller = new AbortController();
    controller.abort();
    // The tool-level contract (omp throwIfAborted discipline): an aborted
    // caller signal surfaces as a thrown abort at the next phase boundary —
    // never a "successful" payload built after the cancel landed.
    // (executeDispatch maps a live abort onto status cancelled/timeout; a
    // pre-aborted cancelSignal never fires its listener, so the throw is
    // pinned directly against the tool.)
    const tool = host.tools.find;
    let thrown: unknown;
    try {
      await tool.execute("fd-6", { query: "login", grep_keywords: [] }, controller.signal);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).name).toMatch(/Abort|abort/);
  });
});
