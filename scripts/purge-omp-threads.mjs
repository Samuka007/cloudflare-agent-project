// #508 one-shot staging purge (DO side): DELETE every staging thread whose
// stored selection names the retired synthetic relay provider id "omp" —
// through the EXISTING app deletion face (DELETE /api/v1/threads/:id), so
// the live worker settles the thread-deleted broadcasts while it still runs.
// The durable half of the ruling is the 0009 migration
// (apps/server-worker/migrations/0009_purge_omp_sentinel.sql), which
// hard-DELETEs every omp reference row from D1 and replays automatically on
// every deploy (#295). This script is the face-driven half; it is
// idempotent — run before or after that deploy, a second run finds nothing.
//
// After both halves, the purged thread ids' per-thread AgentDO journals are
// unreachable archives: no D1 row routes to them and thr_ ids are random,
// never recycled — every addressable surface is clean (migration header).
//
// Enumeration reads staging D1 remotely (wrangler d1 execute --remote); the
// credentials are the same ones scripts/deploy-staging.sh needs
// (CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID). Deletion authenticates
// through the Cloudflare Access wall with a service-token pair — the same
// two headers the daemon seam rides (cf-access.ts); Access is the wall, the
// app's own auth the door (engineering.md practice 7).
//
// Usage (repo root):
//   STAGING_BASE_URL=https://bb-staging.samuka007.com \
//   CF_ACCESS_CLIENT_ID=... CF_ACCESS_CLIENT_SECRET=... \
//   CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... \
//   node scripts/purge-omp-threads.mjs [--list]
//
//   --list  dry run: enumerate the doomed threads, delete nothing.
import { spawnSync } from "node:child_process";

const base = process.env.STAGING_BASE_URL ?? "https://bb-staging.samuka007.com";
const clientId = process.env.CF_ACCESS_CLIENT_ID ?? "";
const clientSecret = process.env.CF_ACCESS_CLIENT_SECRET ?? "";
const dryList = process.argv.includes("--list");

function die(message) {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

if ((clientId === "") !== (clientSecret === "")) {
  die("CF Access is a credential pair: set both CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET");
}
if (!dryList && (clientId === "" || process.env.CLOUDFLARE_API_TOKEN === undefined)) {
  die("deletion mode needs CF_ACCESS_CLIENT_ID/CF_ACCESS_CLIENT_SECRET and CLOUDFLARE_API_TOKEN");
}

/** Live (not yet soft-deleted) threads carrying the retired id, via remote D1. */
function enumerateOmpThreads() {
  const sql =
    "SELECT id, project_id, title, created_at FROM threads " +
    "WHERE provider_id = 'omp' AND deleted_at IS NULL ORDER BY created_at";
  const proc = spawnSync(
    "pnpm",
    [
      "exec",
      "wrangler",
      "d1",
      "execute",
      "cap-control-plane",
      "--remote",
      "--json",
      "-c",
      "wrangler.staging.jsonc",
      "--command",
      sql,
    ],
    { cwd: "apps/server-worker", encoding: "utf8" },
  );
  if (proc.error !== undefined || proc.status !== 0) {
    die(`wrangler d1 execute failed: ${proc.error?.message ?? proc.stderr.trim()}`);
  }
  const start = proc.stdout.indexOf("[");
  if (start < 0) die(`unparseable wrangler output: ${proc.stdout.trim()}`);
  const parsed = JSON.parse(proc.stdout.slice(start));
  return parsed[0]?.results ?? [];
}

async function deleteThread(threadId) {
  const response = await fetch(`${base}/api/v1/threads/${threadId}`, {
    method: "DELETE",
    headers: {
      "content-type": "application/json",
      "CF-Access-Client-Id": clientId,
      "CF-Access-Client-Secret": clientSecret,
    },
    // Purges take whole families: an omp parent's assigned children are
    // omp-era trajectories by construction (selection inheritance).
    body: JSON.stringify({ childThreadsConfirmed: true }),
  });
  if (!response.ok) {
    die(`DELETE ${threadId} failed: HTTP ${response.status} ${await response.text()}`);
  }
  console.log(`deleted ${threadId}`);
}

const doomed = enumerateOmpThreads();
if (doomed.length === 0) {
  console.log("no live omp threads on staging — nothing to purge");
  process.exit(0);
}
console.log(`${doomed.length} live omp thread(s):`);
for (const row of doomed) {
  console.log(`  ${row.id}  project=${row.project_id}  title=${row.title ?? "(untitled)"}`);
}
if (dryList) {
  console.log("--list: dry run, nothing deleted");
  process.exit(0);
}
for (const row of doomed) {
  await deleteThread(row.id);
}
const residue = enumerateOmpThreads();
if (residue.length > 0) {
  die(`residue after purge: ${residue.map((row) => row.id).join(", ")}`);
}
console.log("purge complete: no live omp threads remain (0009 finishes the D1 rows on deploy)");
