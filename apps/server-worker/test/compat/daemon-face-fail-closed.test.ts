import { beforeAll, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { DAEMON_PROTOCOL_VERSION } from "@cap/daemon-service";
import composedWorker from "../../src/index.js";
import { ensureMigrations } from "../migrate.js";
import { TEST_ENROLL_KEY, TEST_HOST_KEY } from "../helpers.js";
import type { Env } from "../../src/env.js";

/**
 * #398/SEC-W5-002: the composed daemon face fails closed when the deployment
 * secrets are absent — the repo-public POC literals authenticate nothing and
 * no fallback path exists. This is the server-side mirror of the daemon
 * client's start-time refusal (client/index.ts:32-36); the composition seam
 * (src/index.ts requireDaemonCredentials) refuses the first daemon-face
 * request because a Worker has no startup phase to gate.
 */

beforeAll(ensureMigrations);

// The helpers' env carries the wrangler-generated namespace types; the
// handler is typed against the app's structural Env — the rig object IS the
// deployment env, so the seam is a named one-line cast, not a re-wrap
// (attachment-pickup.test.ts precedent).
const rigObject = env as unknown as Env;

// The daemon face never touches ExecutionContext (only the app face forwards
// ctx); the handler's generated typing still requires the slot.
const ctx = undefined as unknown as ExecutionContext;

/** The rig env with the daemon credentials stripped (unset-secret posture). */
function envWithoutDaemonSecrets(): Env {
  return { ...rigObject, ENROLL_KEY: undefined, DAEMON_HOST_KEY: undefined };
}

/** The rig env carrying explicit test secrets (mirrors vitest.config.ts). */
function envWithTestSecrets(): Env {
  return { ...rigObject, ENROLL_KEY: TEST_ENROLL_KEY, DAEMON_HOST_KEY: TEST_HOST_KEY };
}

function enrollRequest(enrollKey: string, hostId: string): Request {
  return new Request("https://example.com/enroll", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enrollKey, hostId }),
  });
}

describe("daemon face fail-closed (#398/SEC-W5-002)", () => {
  it("a stripped-secret env fails the daemon face with the credential error", async () => {
    await expect(
      composedWorker.fetch(
        enrollRequest(TEST_ENROLL_KEY, "host_failcl_a1"),
        envWithoutDaemonSecrets(),
        ctx,
      ),
    ).rejects.toThrow(/ENROLL_KEY secret is not set/);
  });

  it("the retired POC literal takes no fallback path on a stripped env", async () => {
    await expect(
      composedWorker.fetch(
        enrollRequest("[REDACTED-staging-secret]", "host_failcl_a2"),
        envWithoutDaemonSecrets(),
        ctx,
      ),
    ).rejects.toThrow(/ENROLL_KEY secret is not set/);
  });

  it("with secrets set the static key enrolls and hands the matching hostKey", async () => {
    const enroll = await composedWorker.fetch(
      enrollRequest(TEST_ENROLL_KEY, "host_failcl_b1"),
      envWithTestSecrets(),
      ctx,
    );
    expect(enroll.status).toBe(201);
    const body = await enroll.json<{ hostId: string; hostKey: string }>();
    expect(body.hostId).toBe("host_failcl_b1");
    expect(body.hostKey).toBe(TEST_HOST_KEY);
  });

  it("the POC literals authenticate nothing when real secrets are set", async () => {
    const enroll = await composedWorker.fetch(
      enrollRequest("[REDACTED-staging-secret]", "host_failcl_c1"),
      envWithTestSecrets(),
      ctx,
    );
    expect(enroll.status).toBe(401);
    const open = await composedWorker.fetch(
      new Request("https://example.com/session/open", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer [REDACTED-staging-secret]" },
        body: JSON.stringify({
          hostId: "host_failcl_c1",
          bootId: `boot_failcl_${Date.now()}`,
          protocolVersion: DAEMON_PROTOCOL_VERSION,
        }),
      }),
      envWithTestSecrets(),
      ctx,
    );
    expect(open.status).toBe(401);
  });
});
