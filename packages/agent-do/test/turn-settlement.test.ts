import { env } from "cloudflare:workers";
import { expect } from "vitest";
import { afterEach, beforeAll, describe, it } from "vitest";
import type { RecordedHubCall } from "../src/testing/recording-hub.js";
import { createRig, resetRuntime, type Rig } from "./helpers.js";

/**
 * #238 L2: terminal turn → control-plane row settlement at the source of
 * truth. The send route flips the coarse thread row `active` on dispatch;
 * the DO is the only actor alive when the turn actually settles, so it must
 * write the transition itself (completed/cancelled → idle, failed → error)
 * and announce it — the old lazy GET /timeline settlement left every thread
 * GET (reload's first render included) deriving "working" from a stale
 * `active` row.
 *
 * Schema note: only the settlement-touched columns are pinned here; the full
 * threads DDL is owned by apps/server-worker/migrations (compat tests).
 */

interface SettlementRow {
  id: string;
  status: string;
  deleted_at: number | null;
  archived_at: number | null;
}

/** Narrowed once at the boundary: the binding is absent in non-rig suites. */
function rigDb(): D1Database {
  if (typeof env !== "object" || !("DB" in env)) {
    throw new Error("DB binding missing from the vitest rig");
  }
  const candidate = env.DB;
  if (candidate === undefined || typeof candidate !== "object") {
    throw new Error("DB binding missing from the vitest rig");
  }
  return candidate as D1Database;
}

function rigHubNamespace(): DurableObjectNamespace {
  if (typeof env !== "object" || !("HUB" in env)) {
    throw new Error("HUB binding missing from the vitest rig");
  }
  return env.HUB as DurableObjectNamespace;
}

interface RecordingHubStub {
  peekCalls(): Promise<RecordedHubCall[]>;
}

// D1 exec is single-statement per line here; keep the fixture on one line.
const SCHEMA =
  "CREATE TABLE IF NOT EXISTS threads (id TEXT PRIMARY KEY NOT NULL, status TEXT NOT NULL DEFAULT 'starting', deleted_at INTEGER, archived_at INTEGER, updated_at INTEGER NOT NULL);";

async function seedThreadRow(threadId: string, status: string): Promise<void> {
  await rigDb()
    .prepare(
      "INSERT INTO threads (id, status, deleted_at, archived_at, updated_at) VALUES (?, ?, NULL, NULL, ?) " +
        "ON CONFLICT(id) DO UPDATE SET status = excluded.status, deleted_at = NULL, archived_at = NULL",
    )
    .bind(threadId, status, Date.now())
    .run();
}

async function readRow(threadId: string): Promise<SettlementRow | null> {
  const row = await rigDb()
    .prepare("SELECT id, status, deleted_at, archived_at FROM threads WHERE id = ?")
    .bind(threadId)
    .first<SettlementRow>();
  return row ?? null;
}

async function runTurnToCompletion(rig: Rig): Promise<string> {
  const sent = await rig.stub.sendMessage({
    clientRequestId: `req-${Math.random().toString(36).slice(2)}`,
    content: [{ type: "text", text: "count" }],
    mode: "start",
  });
  expect(sent.duplicated).toBe(false);
  await rig.waitTurnComplete(sent.turnId);
  return sent.turnId;
}

async function waitForRowStatus(threadId: string, expected: string): Promise<void> {
  await expect
    .poll(async () => (await readRow(threadId))?.status, { timeout: 10_000, interval: 100 })
    .toBe(expected);
}

async function statusChangedCall(threadId: string): Promise<RecordedHubCall | undefined> {
  const hubNamespace = rigHubNamespace();
  const stub = hubNamespace.get(hubNamespace.idFromName("hub")) as unknown as RecordingHubStub;
  const calls: RecordedHubCall[] = await stub.peekCalls();
  return calls.find(
    (call) => call.kind === "changed" && call.threadId === threadId && call.changes?.includes("status-changed"),
  );
}

beforeAll(async () => {
  await rigDb().exec(SCHEMA);
});

afterEach(() => {
  resetRuntime();
});

describe("#238 terminal-turn control-plane settlement", () => {
  it("settles an active row to idle and announces status-changed on turn.completed", async () => {
    const rig = await createRig();
    await seedThreadRow(rig.threadId, "active");
    await runTurnToCompletion(rig);
    await waitForRowStatus(rig.threadId, "idle");
    await expect.poll(async () => (await statusChangedCall(rig.threadId)) !== undefined, {
      timeout: 10_000,
      interval: 100,
    }).toBe(true);
  });

  it("settles a failed turn to error", async () => {
    const rig = await createRig({ turns: [{ failBeforeFirstByte: { message: "model_error" } }] });
    await seedThreadRow(rig.threadId, "active");
    await runTurnToCompletion(rig);
    await waitForRowStatus(rig.threadId, "error");
  });

  it("leaves deleted, archived, stopping, and already-idle rows untouched", async () => {
    const rig = await createRig();
    for (const status of ["idle", "stopping", "error"]) {
      await seedThreadRow(rig.threadId, status);
      await runTurnToCompletion(rig);
      expect((await readRow(rig.threadId))?.status).toBe(status);
    }
    await seedThreadRow(rig.threadId, "active");
    await rigDb().prepare("UPDATE threads SET deleted_at = ? WHERE id = ?").bind(Date.now(), rig.threadId).run();
    await runTurnToCompletion(rig);
    await expect.poll(async () => (await readRow(rig.threadId))?.status, {
      timeout: 5_000,
      interval: 100,
    }).toBe("active");
  });
});
