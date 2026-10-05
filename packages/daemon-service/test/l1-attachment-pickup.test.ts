import { describe, expect, test } from "vitest";
import type { ProjectAttachmentContentResult, ProjectAttachmentReader } from "../src/worker.js";
import { setAttachmentReader } from "../src/worker.js";
import { SimulatedClient, uniqueHostId, testEnv, workerFetch } from "./helpers.js";

/**
 * L1 attachment pickup route (#318) — the daemon face's
 * /internal/session/project-attachment-content (bb internal/session.ts:149-192,
 * bytes from the #316 R2 family through the deployment bridge). The route's
 * own three gates answer here: Bearer hostKey, the DO's live-session binding,
 * and the storage-bridge contract; the bridge's D1 cross-checks are the
 * composed entry's (attachment-pickup.ts) and carry their own compat test.
 *
 * The bridge is installed through setAttachmentReader — the vitest pool
 * drives exports.default.fetch with the deployment env, so an env-carried
 * fake cannot reach the route (apps/daemon-worker injection.ts posture).
 */

const PICKUP_PATH = "/internal/session/project-attachment-content";

/** Query for a dialed client: the binding legs + fixed thread/project/path. */
function pickupQueryFor(client: SimulatedClient): Record<string, string> {
  return {
    hostId: client.hostId,
    sessionId: client.sessionId ?? "",
    threadId: "thr_pickup",
    projectId: "prj_pickup",
    path: "abc123.png",
  };
}

function bridgeOf(
  result: ProjectAttachmentContentResult,
  seen?: Parameters<ProjectAttachmentReader>[0][],
): ProjectAttachmentReader {
  return (args) => {
    seen?.push(args);
    return Promise.resolve(result);
  };
}

function pickupUrl(query: Record<string, string>): string {
  const params = new URLSearchParams(query);
  return `https://daemon-service.test${PICKUP_PATH}?${params.toString()}`;
}

const AUTH = { headers: { authorization: `Bearer ${testEnv.DAEMON_HOST_KEY}` } };

describe("L1 attachment pickup route (#318)", () => {
  test("requires the bearer hostKey before anything else", async () => {
    const fullQuery = {
      hostId: "any",
      sessionId: "sess_x",
      threadId: "thr_pickup",
      projectId: "prj_pickup",
      path: "abc123.png",
    };
    const none = await workerFetch(new Request(pickupUrl(fullQuery)));
    expect(none.status).toBe(401);

    const wrong = await workerFetch(
      new Request(pickupUrl(fullQuery), {
        headers: { authorization: "Bearer not-the-key" },
      }),
    );
    expect(wrong.status).toBe(401);
  });

  test("422s an incomplete query like the daemon-face validation posture", async () => {
    const client = new SimulatedClient(uniqueHostId("pickup"));
    await client.dial();
    const { path: _missing, ...noPath } = pickupQueryFor(client);
    const response = await workerFetch(new Request(pickupUrl(noPath), AUTH));
    expect(response.status).toBe(422);
    const body = await response.json<{ code: string }>();
    expect(body.code).toBe("validation_failed");
  });

  test("refuses a session that is not live for the claimed host", async () => {
    const client = new SimulatedClient(uniqueHostId("pickup"));
    await client.dial();
    const headers = AUTH;

    // Fabricated sessionId for the right host: no session vouches for it.
    const fabricated = await workerFetch(
      new Request(pickupUrl({ ...pickupQueryFor(client), sessionId: "sess_fabricated" }), headers),
    );
    expect(fabricated.status).toBe(403);

    // Right sessionId claimed under a different host's DO (never dialed):
    // that DO has no live session at all.
    const other = await workerFetch(
      new Request(pickupUrl({ ...pickupQueryFor(client), hostId: uniqueHostId("other") }), headers),
    );
    expect(other.status).toBe(403);
  });

  test("serves bridge bytes for the bound session with content-length", async () => {
    const client = new SimulatedClient(uniqueHostId("pickup"));
    await client.dial();
    const seen: Parameters<ProjectAttachmentReader>[0][] = [];
    const bytes = new TextEncoder().encode("png-bytes-here");
    try {
      setAttachmentReader(bridgeOf({ ok: true, bytes, mimeType: "image/png" }, seen));
      const response = await workerFetch(new Request(pickupUrl(pickupQueryFor(client)), AUTH));
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("image/png");
      expect(response.headers.get("content-length")).toBe(String(bytes.byteLength));
      const body = new Uint8Array(await response.arrayBuffer());
      expect([...body]).toEqual([...bytes]);
    } finally {
      setAttachmentReader(undefined);
    }
    // The bridge receives the whole query — the thread→project cross-check
    // is its job (composed entry), the session binding was the route's.
    expect(seen).toEqual([
      {
        hostId: client.hostId,
        query: {
          hostId: client.hostId,
          sessionId: client.sessionId,
          path: "abc123.png",
          projectId: "prj_pickup",
          threadId: "thr_pickup",
        },
      },
    ]);
  });

  test("maps bridge rejections verbatim", async () => {
    const client = new SimulatedClient(uniqueHostId("pickup"));
    await client.dial();
    try {
      setAttachmentReader(
        bridgeOf({
          ok: false,
          status: 404,
          code: "not_found",
          message: "Attachment not found",
        }),
      );
      const response = await workerFetch(new Request(pickupUrl(pickupQueryFor(client)), AUTH));
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({
        code: "not_found",
        message: "Attachment not found",
        retryable: false,
      });
    } finally {
      setAttachmentReader(undefined);
    }
  });

  test("answers 500 with an explicit message when no bridge is configured", async () => {
    const client = new SimulatedClient(uniqueHostId("pickup"));
    await client.dial();
    const response = await workerFetch(new Request(pickupUrl(pickupQueryFor(client)), AUTH));
    expect(response.status).toBe(500);
    const body = await response.json<{ code: string; message: string }>();
    expect(body.code).toBe("internal");
    expect(body.message).toContain("readProjectAttachment");
  });
});
