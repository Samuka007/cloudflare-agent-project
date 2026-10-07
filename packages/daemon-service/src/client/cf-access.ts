/**
 * Cloudflare Access service-token seam (#420, docs/research/
 * cf-access-agent-compat.md §5.2): Access is the wall, hostKey the door
 * lock (engineering.md practice 7) — the two service-token headers ride
 * ALONGSIDE the Bearer hostKey on every daemon-seam request: /enroll,
 * /session/open, and the /ws attach. Access terminates at the edge and
 * never sees hostKey; the hostKey ladder inside the worker is unchanged.
 */

export interface CfAccessConfig {
  clientId: string;
  clientSecret: string;
}

/**
 * Decode the resolved CLI/env pair (`--cf-client-id`/`--cf-client-secret`
 * or `DAEMON_CF_ACCESS_CLIENT_ID`/`DAEMON_CF_ACCESS_CLIENT_SECRET`) into
 * the config. Both halves or neither: a one-headed pair is a
 * misconfiguration Access will always refuse (service auth checks both
 * headers), so it fails at start (agent-auth posture: rejection, not
 * silent fallback) instead of dialing with half a credential. Unset pair
 * → undefined — the no-Access direct-dial wire is unchanged (same bytes as
 * pre-#420).
 */
export function decodeCfAccessConfig(
  clientId: string | undefined,
  clientSecret: string | undefined,
): CfAccessConfig | undefined {
  const id = clientId ?? "";
  const secret = clientSecret ?? "";
  if ((id === "") !== (secret === "")) {
    throw new Error(
      "[daemon-client] CF Access is a credential pair: set both DAEMON_CF_ACCESS_CLIENT_ID and DAEMON_CF_ACCESS_CLIENT_SECRET (or neither)",
    );
  }
  return id === "" ? undefined : { clientId: id, clientSecret: secret };
}

/** The two service-token headers (Cloudflare service-credentials shape),
 * spread-ready: empty when unconfigured, so call sites stay a plain
 * header merge. Sent in parallel with `authorization: Bearer <hostKey>`. */
export function cfAccessHeaders(cfAccess: CfAccessConfig | undefined): Record<string, string> {
  return cfAccess === undefined
    ? {}
    : {
        "CF-Access-Client-Id": cfAccess.clientId,
        "CF-Access-Client-Secret": cfAccess.clientSecret,
      };
}
