/**
 * One-time host join codes (#258) — the "非 key 版" mint layer that lets the
 * SPA's Add-a-machine dialog enroll a daemon without the M1 per-host key
 * registry (#195 S7 keeps that cropped). bb anchors (fork @ dc2778d):
 *
 * - `POST /hosts/join-codes` → 201 `{joinCode, hostId, expiresAt}` with a
 *   15-minute TTL (`apps/server/src/routes/hosts.ts:111-124` +
 *   `services/machine-auth.ts:15` ENROLL_KEY_TTL_SECONDS = 60 * 15).
 * - Minting names a hostId but creates NO host row — "a mint must not leave
 *   phantom 'pending' machines behind" (`services/hosts/host-enrollment.ts:12-17`);
 *   the row is born at enroll time via the attach bridge.
 * - The key is single-use: bb issues it with `remaining: 1`
 *   (`machine-auth.ts:430`); a fresh enroll consumes it.
 *
 * Deviation from bb (documented, POC credential model): the issued code
 * redeems the deployment-wide `DAEMON_HOST_KEY`, not a per-host key — the
 * registry, revocation and rotation land with M1. Storage is the edge KV the
 * auth cache already uses, hash-keyed so raw codes are never stored or logged
 * (same layout discipline as `edge.ts` authKvKey); KV's own expirationTtl is
 * the expiry authority and the stored record double-checks it.
 */

/** bb ENROLL_KEY_TTL_SECONDS (machine-auth.ts:15): 15 minutes. */
export const JOIN_CODE_TTL_S = 15 * 60;

export interface JoinCodeRecord {
  /** The minted hostId the daemon enrolls as (bb key-metadata authority). */
  hostId: string;
  /** Epoch ms after which the code is dead (mirrors the KV TTL). */
  expiresAt: number;
}

/** KV key layout: hash-keyed so raw codes are never stored or logged. */
export function joinCodeKvKey(codeHash: string): string {
  return `join:v1:${codeHash}`;
}

export interface MintedJoinCode extends JoinCodeRecord {
  code: string;
}

/** Same digest layout as edge.ts's auth-cache hashes. */
export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** 128 bits of URL-safe entropy — the code is the enrollment capability. */
function generateJoinCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const encoded = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `capjc_${encoded}`;
}

/**
 * Mint a one-time code bound to `hostId`. Fail closed on KV errors — a mint
 * whose record never lands would hand the user a code that 401s at enroll.
 */
export async function mintJoinCode(
  kv: KVNamespace,
  hostId: string,
  now: number = Date.now(),
): Promise<MintedJoinCode> {
  const code = generateJoinCode();
  const expiresAt = now + JOIN_CODE_TTL_S * 1000;
  const record: JoinCodeRecord = { hostId, expiresAt };
  await kv.put(joinCodeKvKey(await sha256Hex(code)), JSON.stringify(record), {
    expirationTtl: JOIN_CODE_TTL_S,
  });
  return { code, hostId, expiresAt };
}

/**
 * Redeem `code`: returns the minted hostId when the code is alive, else
 * null. A hit is consumed first (bb `remaining: 1`); if the delete itself
 * fails the enroll still succeeds — the residual replay window is KV
 * propagation latency, accepted for the POC model and documented in
 * docs/ops/host-onboarding.md.
 */
export async function consumeJoinCode(
  kv: KVNamespace,
  code: string,
  now: number = Date.now(),
): Promise<string | null> {
  const raw = await kv.get(joinCodeKvKey(await sha256Hex(code)));
  if (raw === null) return null;
  let record: JoinCodeRecord | null = null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      typeof (parsed as JoinCodeRecord).hostId === "string" &&
      typeof (parsed as JoinCodeRecord).expiresAt === "number"
    ) {
      record = parsed as JoinCodeRecord;
    }
  } catch {
    record = null;
  }
  // Record shape garbage or an already-expired straggler → dead code either way.
  if (record === null || record.expiresAt <= now) return null;
  await kv.delete(joinCodeKvKey(await sha256Hex(code))).catch(() => undefined);
  return record.hostId;
}
