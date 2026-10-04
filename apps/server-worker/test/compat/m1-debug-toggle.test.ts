import { beforeAll, describe, expect, it } from "vitest";
import { exports } from "cloudflare:workers";
import { ensureMigrations } from "../migrate.js";
import { BASE, createThread, send } from "../helpers.js";
import {
  threadTimelineResponseSchema,
  type ThreadTimelineResponse,
} from "../../src/contract/api/threads.js";
import type { TimelineRow } from "../../src/contract/thread-timeline.js";
import { defaultAppSettings } from "../../src/contract/domain/app-settings.js";

/**
 * #149: the SPA Settings → Debug toggle (`showUnhandledProviderEvents`)
 * must change what the timeline serves — bb gates its provider-unhandled
 * diagnostic rows on exactly this flag (routes/threads/data.ts:331-334).
 * Toggle off → no diagnostic rows; toggle on → every raw journal event the
 * UX projection omits surfaces as an `Unhandled agent event` row carrying
 * the byte-transparent payload.
 */
beforeAll(ensureMigrations);

function isUnhandledRow(row: TimelineRow): boolean {
  return (
    row.kind === "system" &&
    row.systemKind === "operation" &&
    row.operationKind === "provider-unhandled"
  );
}

async function setUnhandledToggle(enabled: boolean): Promise<void> {
  const response = await exports.default.fetch(`${BASE}/api/v1/settings/general`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...defaultAppSettings, showUnhandledProviderEvents: enabled }),
  });
  if (response.status !== 200) {
    throw new Error(`settings write failed: ${response.status} ${await response.text()}`);
  }
}

async function fetchTimeline(threadId: string): Promise<ThreadTimelineResponse> {
  const response = await exports.default.fetch(
    `${BASE}/api/v1/threads/${threadId}/timeline?segmentLimit=100&includeNestedRows=true`,
  );
  expect(response.status).toBe(200);
  return threadTimelineResponseSchema.parse(await response.json());
}

describe("#149 debug toggle → provider-unhandled timeline rows", () => {
  it("serves no provider-unhandled rows while the toggle is off", async () => {
    await setUnhandledToggle(false);
    const thread = await createThread();
    const timeline = await fetchTimeline(thread.id);
    expect(timeline.rows.some(isUnhandledRow)).toBe(false);
  });

  it("surfaces raw journal events as provider-unhandled rows when the toggle is on", async () => {
    await setUnhandledToggle(true);
    try {
      const thread = await createThread();
      await send(thread.id);
      const timeline = await fetchTimeline(thread.id);

      const index = timeline.rows.findIndex(isUnhandledRow);
      expect(index).toBeGreaterThanOrEqual(0);
      const row = timeline.rows[index];
      if (row?.kind !== "system" || row.systemKind !== "operation") {
        throw new Error("unreachable: findIndex above proved a provider-unhandled row exists");
      }
      // thread.created is the log's first append and the UX projection omits
      // it, so the first diagnostic row is its provider-unhandled projection.
      expect(row.title).toBe("Unhandled agent event");
      expect(row.status).toBe("completed");
      expect(row.id).toBe(`${thread.id}:op:provider-unhandled:${row.sourceSeqStart}`);
      const detail = row.detail;
      expect(detail).not.toBeNull();
      if (detail === null) {
        throw new Error("unreachable: detail assertion above");
      }
      expect(detail).toContain("Raw event: thread.created");
      // bb buildProviderUnhandledDetail: humanized type header, raw token,
      // then the byte-transparent payload.
      const payloadStart = detail.indexOf("Payload:\n");
      expect(payloadStart).toBeGreaterThan(0);
      const payload = JSON.parse(detail.slice(payloadStart + "Payload:\n".length)) as {
        type: string;
        threadId: string;
        seq: number;
      };
      expect(payload.type).toBe("thread.created");
      expect(payload.threadId).toBe(thread.id);
      expect(payload.seq).toBe(row.sourceSeqStart);

      // The delta cache is keyed on the toggle (bb data.ts:334-337 — a
      // per-request gate must key the cache): after the flag flips off, a
      // delta request against the toggle-on window must not serve the
      // diagnostic rows.
      await setUnhandledToggle(false);
      const offResponse = await exports.default.fetch(
        `${BASE}/api/v1/threads/${thread.id}/timeline?segmentLimit=100&afterSequence=${timeline.maxSeq}`,
      );
      expect(offResponse.status).toBe(200);
      const offBody = threadTimelineResponseSchema.parse(await offResponse.json());
      expect(offBody.rows.some(isUnhandledRow)).toBe(false);
    } finally {
      await setUnhandledToggle(false);
    }
  });
});
