// SEC-W5-001 (#397): deploy-time gate-on assertion, exec'd by
// scripts/deploy-staging.sh (and therefore also by the GHA CD workflow) before
// any staging deploy. The runtime gate is fail-closed, so a gate-off staging
// deploy would ship a control plane that answers 503 access_gate_disabled on
// every /api/v1 + /ws request — dead on arrival; block it here with the fix
// instructions instead.
//
// The config is JSONC, so comments are stripped before the var lookup; a bash
// grep would false-trip on the relay catalog URL's "//" and cannot verify the
// value. Trailing commas stay — the lookup is a targeted regex, not a JSON
// parse, so the var is read exactly as wrangler will bake it.
import { readFileSync } from "node:fs";

const configPath = "apps/server-worker/wrangler.staging.jsonc";
const raw = readFileSync(configPath, "utf8");
const stripped = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
const match = stripped.match(/"ACCESS_CHECK_ENABLED"\s*:\s*"([^"]*)"/);

if (match === null || match[1] !== "true") {
  console.error(
    `ERROR: refusing to deploy: ACCESS_CHECK_ENABLED must be "true" in ${configPath} ` +
      "(SEC-W5-001 #397). A gate-off deployment locks /api/v1 + /ws at runtime " +
      "(503 access_gate_disabled). Flip the var and provision the " +
      "ACCESS_TEAM_DOMAIN / ACCESS_AUD secrets (`wrangler secret put`) first.",
  );
  process.exit(1);
}
console.log('gate on: ACCESS_CHECK_ENABLED="true"');
