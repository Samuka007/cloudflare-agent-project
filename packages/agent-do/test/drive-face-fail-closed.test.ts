import { describe, expect, test } from "vitest";
import { exports } from "cloudflare:workers";

/**
 * #398/SEC-W5-002: the composed rig's daemon face has no repo-public
 * credential fallback. This default suite's wrangler rig binds no
 * ENROLL_KEY/DAEMON_HOST_KEY, so the /drive surface and the daemon-face
 * composition must refuse with an explicit 500 instead of authenticating
 * against the retired "poc-dev-*" literals. (The positive paths with real
 * rig bindings run in the hookup project — vitest.hookup.config.ts — and
 * against staging; the daemon-service L1 suite covers the auth ladder.)
 */

/** The composed worker front (src/worker.ts default export). */
const front = exports.default;

describe("daemon face fail-closed (#398/SEC-W5-002)", () => {
  test("/drive refuses with an explicit credential error when no secret is bound", async () => {
    const response = await front.fetch("https://rig.test/drive/thr_failclosed", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer anything" },
      body: JSON.stringify({ text: "hello" }),
    });
    expect(response.status).toBe(500);
    const body = await response.json<{ code: string; message: string }>();
    expect(body.code).toBe("internal_error");
    // Both rig credentials are absent; the ENROLL_KEY refusal fires first
    // (requireDaemonCredentials checks in declaration order).
    expect(body.message).toContain("ENROLL_KEY secret is not set");
  });

  test("the daemon-face composition refuses when no secret is bound", async () => {
    const response = await front.fetch("https://rig.test/enroll", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enrollKey: "anything", hostId: "host_failclosed" }),
    });
    expect(response.status).toBe(500);
    const body = await response.json<{ code: string; message: string }>();
    expect(body.message).toContain("ENROLL_KEY secret is not set");
  });
});
