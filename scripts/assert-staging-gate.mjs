// SEC-W5-001 (#397): deploy-time gate-armed assertion, exec'd by
// scripts/deploy-staging.sh (and therefore also by the GHA CD workflow) before
// any staging deploy. #505 removed the ACCESS_CHECK_ENABLED flag — gate state
// IS the credential pair (middleware/access.ts accessGateEnabled derives it
// from ACCESS_TEAM_DOMAIN ∧ ACCESS_AUD): both secrets present = JWT
// verification on /api/v1 + /ws; either missing = the control plane answers
// 503 access_gate_disabled — dead on arrival. Block both failure shapes here:
//   1. the retired flag reintroduced into the wrangler config (a drift back
//      to the two-sources-of-state era), and
//   2. either Access secret missing from the worker (live `wrangler secret
//      list` lookup — the same store `wrangler deploy` reads).
//
// The config is JSONC, so comments are stripped before the var lookup; a bash
// grep would false-trip on the relay catalog URL's "//" and cannot verify the
// value. Trailing commas stay — the lookup is a targeted regex, not a JSON
// parse, so the var is read exactly as wrangler would bake it.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const configPath = "apps/server-worker/wrangler.staging.jsonc";
const workerName = "cap-server-staging";
const requiredSecrets = ["ACCESS_TEAM_DOMAIN", "ACCESS_AUD"];

const raw = readFileSync(configPath, "utf8");
const stripped = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

if (/"ACCESS_CHECK_ENABLED"\s*:/.test(stripped)) {
  console.error(
    `ERROR: refusing to deploy: ACCESS_CHECK_ENABLED is retired (#505) but present in ${configPath} ` +
      "(SEC-W5-001 #397). Gate state derives from the ACCESS_TEAM_DOMAIN / " +
      "ACCESS_AUD secrets, not a flag — remove the var and provision the " +
      "secrets (`wrangler secret put`) instead.",
  );
  process.exit(1);
}
console.log("gate config clean: ACCESS_CHECK_ENABLED absent (retired #505)");

// Live credential-presence check. Runs from apps/server-worker so the -c
// config path resolves; the deploy flow guarantees CLOUDFLARE_API_TOKEN /
// CLOUDFLARE_ACCOUNT_ID are set (deploy-staging.sh gates on them above).
const listing = spawnSync(
  "pnpm",
  ["exec", "wrangler", "secret", "list", "-c", "wrangler.staging.jsonc"],
  { cwd: "apps/server-worker", encoding: "utf8" },
);
if (listing.error !== undefined || listing.status !== 0) {
  console.error(
    "ERROR: refusing to deploy: `wrangler secret list` failed — cannot verify " +
      `the Access credentials (SEC-W5-001 #397). Detail: ${
        listing.error?.message ?? listing.stderr?.trim() ?? `exit ${listing.status}`
      }`,
  );
  process.exit(1);
}

let secretNames;
try {
  secretNames = JSON.parse(listing.stdout).map((secret) => secret.name ?? "");
} catch {
  console.error(
    "ERROR: refusing to deploy: could not parse `wrangler secret list` output — " +
      `stdout: ${listing.stdout.trim()}`,
  );
  process.exit(1);
}

const missing = requiredSecrets.filter((name) => !secretNames.includes(name));
if (missing.length > 0) {
  console.error(
    `ERROR: refusing to deploy: Access secret(s) ${missing.join(" + ")} not found on ` +
      `${workerName} (SEC-W5-001 #397). Without the pair the gate stays unarmed ` +
      "and the control plane answers 503 access_gate_disabled. Provision with " +
      "`wrangler secret put` first.",
  );
  process.exit(1);
}
console.log(`gate armed: ${requiredSecrets.join(" + ")} present on ${workerName}`);
