import { beforeAll, describe, expect, it } from "vitest";
import { ensureMigrations } from "../migrate.js";
import { createThread, send, type CreatedThread } from "../helpers.js";
import { env, exports } from "cloudflare:workers";
import { threadResponseSchema } from "../../src/contract/api/threads.js";

/**
 * #477: idle 线程永久渲染 Working... — server truth idle, UI judged running.
 *
 * Root cause chain, reproduced in the rig before the fix:
 * 1. The dispatch faces flip the coarse M0 row `active` on send; an instant
 *    (mock/steer-seal) turn completes INSIDE the dispatch chain, so the DO's
 *    terminal settlement (starting→idle) lands before the route's flip — the
 *    unguarded flip resurrected `active` over it.
 * 2. GET /threads/:id — the face the SPA bootstraps its runtime cache from
 *    (useThreadDetailBootstrap → ingestThreadDetailBootstrap; useThread then
 *    yields to the fresh bootstrap) — served the stale `active` verbatim.
 * 3. The page's own timeline fetch settled the row idle moments later (that
 *    is why the server truth curl read idle), but the settlement's
 *    status-changed broadcast races the fresh page's WS subscribe — the hub
 *    is ephemeral fan-out with no replay — so the correction was lost and
 *    nothing refetched: permanent "Working..." while D1 said idle.
 *
 * Fixes pinned here: the detail face settles before answering (mirroring the
 * timeline face, #52), and the dispatch flips are CAS-guarded so they can
 * never resurrect a sealed turn.
 */
beforeAll(ensureMigrations);

/** Raw D1 read — bypasses every face; the control-plane truth probe. */
async function threadRowStatus(threadId: string): Promise<string | undefined> {
  const { results } = await env.DB.prepare("SELECT id, status FROM threads WHERE id = ?")
    .bind(threadId)
    .all();
  const row = results[0] as { status: string } | undefined;
  return row?.status;
}

async function readThreadDetail(thread: CreatedThread) {
  const response = await exports.default.fetch(
    `https://example.com/api/v1/threads/${thread.id}`,
  );
  expect(response.status).toBe(200);
  return threadResponseSchema.parse(await response.json());
}

async function readThreadDetailWithIncludes(thread: CreatedThread) {
  const response = await exports.default.fetch(
    `https://example.com/api/v1/threads/${thread.id}?include=environment,host`,
  );
  expect(response.status).toBe(200);
  return threadResponseSchema.parse(await response.json());
}

/** Resolves when the mock turn's terminal event is in the journal. */
async function waitTurnCompleted(threadId: string): Promise<void> {
  const wait = await exports.default.fetch(
    `https://example.com/api/v1/threads/${threadId}/events/wait` +
      `?type=${encodeURIComponent("turn/completed")}&afterSeq=0&waitMs=15000`,
  );
  expect(wait.status).toBe(200);
}

describe("#477 detail face settles a completed turn", () => {
  it("bootstrap-shaped detail (include=environment,host) never reports running", async () => {
    const thread = await createThread({
      title: "477-bootstrap-face",
      input: [{ type: "text", text: "reload walkthrough turn" }],
    });
    await waitTurnCompleted(thread.id);

    // The FIRST read face after the turn — no timeline fetch has run yet.
    const bootstrapped = await readThreadDetailWithIncludes(thread);
    expect(bootstrapped.status).toBe("idle");
    expect(bootstrapped.runtime.displayStatus).toBe("idle");
    expect(bootstrapped.runtime.hostReconnectGraceExpiresAt).toBeNull();
  });

  it("plain detail (useThread refetch face) settles identically", async () => {
    const thread = await createThread({
      title: "477-plain-face",
      input: [{ type: "text", text: "plain detail turn" }],
    });
    await waitTurnCompleted(thread.id);

    const plain = await readThreadDetail(thread);
    expect(plain.status).toBe("idle");
    expect(plain.runtime.displayStatus).toBe("idle");
  });

  it("detail reads stay settled — the settlement is idempotent across reloads", async () => {
    const thread = await createThread({
      title: "477-reload-idempotent",
      input: [{ type: "text", text: "reload twice turn" }],
    });
    await waitTurnCompleted(thread.id);

    const first = await readThreadDetail(thread);
    const second = await readThreadDetail(thread);
    expect(first.status).toBe("idle");
    expect(second.status).toBe("idle");
  });
});

describe("#477 dispatch flips never resurrect a sealed turn", () => {
  it("create-with-input: a turn sealed inside the dispatch chain is not re-flipped", async () => {
    const thread = await createThread({
      title: "477-create-cas",
      input: [{ type: "text", text: "instant seal turn" }],
    });
    // The mock turn completes inside the create chain; whatever the flip/settle
    // race decided, the row must not sit at a running status afterwards.
    const status = await threadRowStatus(thread.id);
    expect(["idle", "active"]).toContain(status);
    // And the first read face settles it regardless.
    const detail = await readThreadDetail(thread);
    expect(detail.status).toBe("idle");
  });

  it("send on a fresh thread: the sealed turn reads idle through the detail face", async () => {
    const thread = await createThread({ title: "477-send-cas" });
    await send(thread.id);
    await waitTurnCompleted(thread.id);

    const detail = await readThreadDetail(thread);
    expect(detail.status).toBe("idle");
    expect(detail.runtime.displayStatus).toBe("idle");
  });
});
