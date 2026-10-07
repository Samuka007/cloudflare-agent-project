import { afterEach, expect, test } from "vitest";
import { env } from "cloudflare:workers";
import { createRig, resetRuntime, type Rig } from "./helpers.js";
import type { RecordedHubCall } from "../src/testing/recording-hub.js";
import { askOptionValue, type AskQuestion } from "../src/tools/ask.js";

/**
 * #225: the SPA's interactions query refetches ONLY on the hub's
 * `interactions-changed` change kind, and reads the row bodies from the
 * journal via the DO read face. These tests pin the hub notify frames the
 * agent DO produces (RecordingHubDO = the composed NotificationHubDO's RPC
 * surface) and the `listInteractions` fold the control-plane routes serve.
 */

const hubNamespace = (env as { HUB: DurableObjectNamespace }).HUB;
// Test-fixture view of the recording hub (peer of stream-hub.test.ts); the
// fixture DO is repo-owned, so the cast names the whole shape once. Re-resolved
// per access like the rig's stubFor(): abortAllDurableObjects poisons old stubs.
interface RecordingHubStub {
  peekCalls(): Promise<RecordedHubCall[]>;
}
const recordingHub = () =>
  hubNamespace.get(hubNamespace.idFromName("hub")) as unknown as RecordingHubStub;

const ASK_QUESTION: AskQuestion = {
  id: "storage",
  question: "Database?",
  options: [{ label: "SQLite" }, { label: "Postgres" }],
  recommended: 1,
};

async function startAskTurn(rig: Rig, clientRequestId: string): Promise<string> {
  const sent = await rig.stub.sendMessage({
    clientRequestId,
    content: [{ type: "text", text: "ask the user" }],
    mode: "auto",
  });
  return sent.turnId;
}

/** This thread's recorded interactions-changed notifies (peek = monotonic). */
async function interactionCallsFor(threadId: string): Promise<RecordedHubCall[]> {
  let calls: RecordedHubCall[] = [];
  await expect
    .poll(
      async () => {
        const all = await recordingHub().peekCalls();
        calls = all.filter(
          (call) =>
            call.kind === "changed" &&
            call.threadId === threadId &&
            call.changes?.includes("interactions-changed") === true,
        );
        return calls.length;
      },
      { timeout: 10_000 },
    )
    .toBeGreaterThanOrEqual(1);
  return calls;
}

afterEach(() => {
  resetRuntime();
});

test("#225 register → interactions-changed(true); resolve → (false); listInteractions folds the row", async () => {
  const rig = await createRig({
    // The rig's default create-time pin (the mock's single row): the
    // interaction provenance reads the journaled selection (#434 retired
    // the "omp" sentinel; the honest "unknown" fallback is defensive-only
    // now that #496 refuses pinless sends outright).
    turns: [
      { toolCalls: [{ name: "ask", arguments: { questions: [ASK_QUESTION] } }] },
      { deltas: ["ok"] },
    ],
  });
  const turnId = await startAskTurn(rig, "in-ask-hub");
  await rig.waitFor((events) => events.some((event) => event.type === "interaction.registered"));
  const registered = (await rig.events()).find(
    (event): event is Extract<typeof event, { type: "interaction.registered" }> =>
      event.type === "interaction.registered",
  );
  if (registered === undefined) throw new Error("no registered row");

  // The register row carries the interaction patch: pending, badge on.
  const calls = await interactionCallsFor(rig.threadId);
  const registerCall = calls.find((call) => call.metadata?.hasPendingInteraction === true);
  expect(registerCall).toBeDefined();
  expect(typeof registerCall?.metadata?.latestSeq).toBe("number");

  // The read face folds the same row the SPA will render: full provenance,
  // payload verbatim, no resolution yet.
  const pending = await rig.stub.listInteractions();
  expect(pending.interactions).toHaveLength(1);
  const row = pending.interactions[0];
  if (row === undefined) throw new Error("no folded row");
  expect(row.id).toBe(registered.data.interactionId);
  expect(row.threadId).toBe(rig.threadId);
  expect(row.turnId).toBe(registered.data.turnId);
  expect(row.executionId).toBe(registered.data.executionId);
  expect(row.status).toBe("pending");
  expect(row.statusReason).toBeNull();
  expect(row.resolvedAt).toBeNull();
  expect(row.resolution).toBeNull();
  expect(row.origin).toEqual({
    kind: "provider",
    providerId: "omp",
    providerThreadId: rig.threadId,
    providerRequestId: registered.data.executionId,
  });
  expect(row.payload).toEqual(registered.data.payload);

  // The ruling backflow lands `interaction.resolved`: badge off, fold settled.
  const answer = { storage: { selected: [askOptionValue(registered.data.executionId, 1)] } };
  await expect(
    rig.stub.resolveInteraction({
      interactionId: row.id,
      resolution: { kind: "user_answer", answers: answer },
    }),
  ).resolves.toEqual({ accepted: true, duplicated: false });
  await rig.waitTurnComplete(turnId);

  const after = await interactionCallsFor(rig.threadId);
  expect(after.some((call) => call.metadata?.hasPendingInteraction === false)).toBe(true);

  const settled = await rig.stub.listInteractions();
  expect(settled.interactions).toHaveLength(1);
  const settledRow = settled.interactions[0];
  if (settledRow === undefined) throw new Error("fold lost the row");
  expect(settledRow.status).toBe("resolved");
  expect(settledRow.resolution).toEqual({ kind: "user_answer", answers: answer });
  expect(settledRow.resolvedAt).not.toBeNull();
});
