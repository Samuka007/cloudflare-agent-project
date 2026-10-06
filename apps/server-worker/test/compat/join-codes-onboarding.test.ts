import { beforeAll, describe, expect, it } from "vitest";
import { env, exports } from "cloudflare:workers";
import { ensureMigrations } from "../migrate.js";
import { createHostJoinCodeResponseSchema } from "../../src/contract/api/hosts.js";
import { hostSchema } from "../../src/contract/domain/host.js";
import { BASE, apiGet, TEST_ENROLL_KEY } from "../helpers.js";

/**
 * #258 host-onboarding end to end: mint (POST /hosts/join-codes, the
 * Add-a-machine call the #193 walkthrough found 404ing) → the daemon face
 * redeems the code at /enroll → the attach bridge lands the host in the
 * registry, which is the moment the dialog flips "connected" live (S1
 * broadcast). Minting itself must stay rowless — bb issuePersistentHostEnrollKey:
 * "a mint must not leave phantom 'pending' machines behind".
 */
beforeAll(ensureMigrations);

// The rig's edge KV (wrangler.jsonc); typed optional on Env — defined here.
const edgeKv = env.DAEMON_EDGE_KV;

async function mint(): Promise<{ joinCode: string; hostId: string; expiresAt: number }> {
  const response = await exports.default.fetch(`${BASE}/api/v1/hosts/join-codes`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  expect(response.status).toBe(201);
  return createHostJoinCodeResponseSchema.parse(await response.json());
}

async function enroll(credential: string, hostId?: string): Promise<Response> {
  return exports.default.fetch(`${BASE}/enroll`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enrollKey: credential, hostName: "walkthrough-box", ...(hostId ? { hostId } : {}) }),
  });
}

async function listedHosts(): Promise<{ id: string; name: string; status: string }[]> {
  const response = await apiGet("/api/v1/hosts");
  expect(response.status).toBe(200);
  const body = await response.json<unknown[]>();
  return body.map((entry) => {
    const host = hostSchema.parse(entry);
    return { id: host.id, name: host.name, status: host.status };
  });
}

describe("join-code onboarding end to end (#258)", () => {
  it("mint answers the bb contract shape with a 15-minute one-time code", async () => {
    const before = Date.now();
    const issued = await mint();
    expect(issued.joinCode).toMatch(/^capjc_[A-Za-z0-9_-]{22}$/);
    expect(issued.hostId).toMatch(/^host_[23456789abcdefghijkmnpqrstuvwxyz]{10}$/);
    // bb ENROLL_KEY_TTL_SECONDS = 60 * 15 (machine-auth.ts:15).
    expect(issued.expiresAt).toBeGreaterThanOrEqual(before + 15 * 60 * 1000 - 5_000);
    expect(issued.expiresAt).toBeLessThanOrEqual(Date.now() + 15 * 60 * 1000);
  });

  it("minting leaves no phantom host row in /hosts", async () => {
    const { hostId } = await mint();
    const ids = (await listedHosts()).map((host) => host.id);
    expect(ids).not.toContain(hostId);
  });

  it("enroll with the minted code lands the host in /hosts with its self-reported name", async () => {
    const issued = await mint();
    // A body hostId claim must not override the mint (bb key-metadata authority).
    const response = await enroll(issued.joinCode, "host_squatter999");
    expect(response.status).toBe(201);
    const enrolled = await response.json<{ hostId: string; hostKey: string }>();
    expect(enrolled.hostId).toBe(issued.hostId);
    const hosts = await listedHosts();
    const row = hosts.find((host) => host.id === issued.hostId);
    expect(row).toBeDefined();
    expect(row?.name).toBe("walkthrough-box");
  });

  it("the code is spent after one enroll and unknown codes are 401", async () => {
    const issued = await mint();
    expect((await enroll(issued.joinCode)).status).toBe(201);
    expect((await enroll(issued.joinCode)).status).toBe(401);
    expect((await enroll("capjc_never-minted-code")).status).toBe(401);
  });

  it("the static env key path is untouched", async () => {
    const response = await enroll(TEST_ENROLL_KEY, "host_static_join");
    expect(response.status).toBe(201);
    const body = await response.json<{ hostId: string }>();
    expect(body.hostId).toBe("host_static_join");
  });

  it("GET /install.sh serves the dialog's pairing-command contract", async () => {
    const response = await exports.default.fetch(`${BASE}/install.sh`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/x-shellscript; charset=utf-8");
    const script = await response.text();
    for (const needle of ["--join-code", "--host-id", "--server", "nix run", "cap-daemon"]) {
      expect(script).toContain(needle);
    }
    // The KV-backed mint path must exist for the served flow to be real.
    expect(edgeKv).toBeDefined();
  });
});
