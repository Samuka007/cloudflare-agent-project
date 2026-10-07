/**
 * #506 the browser-origin allowlist persistence: the single-row D1 seat
 * (id = 'origin_allowlist', the image_source/web_search/tool_capabilities
 * precedent) behind GET/PUT /system/origin-allowlist. The row is the sole
 * 正本 for the extra browser origins the Origin guard / CORS leg accept
 * beyond the request-target derivation; it is ABSENT until an operator adds
 * one, and the absent row is the ruled default posture: zero extra origins
 * (plain same-origin behavior). The deployment env input (APP_EXTRA_ORIGINS)
 * is deleted (#506 zero-env ruling): D1 is the only 正本, hot-editable
 * without a redeploy — the guard re-reads the row per Origin-carrying
 * request, so a face write applies on the next request.
 *
 * Decode is fail-closed (a security face): a cell that does not parse as a
 * JSON array, and entries that are not strict http(s) origins, never widen
 * the gate — they are dropped with a console warning, the provider-rows
 * skip-with-warning posture.
 */

import { parseOriginLike } from "../contract/domain/origin-allowlist.js";

/** The capability slice this module needs (the worker Env satisfies it). */
export interface OriginAllowlistEnv {
  DB?: D1Database;
}

const ORIGIN_ALLOWLIST_ROW_ID = "origin_allowlist";

const EMPTY_ALLOWLIST: ReadonlySet<string> = new Set();

/** Decode the stored cell into the trusted origin set; garbage never widens the gate. */
function decodeOriginAllowlistCell(raw: string | null): ReadonlySet<string> {
  if (raw === null || raw.trim() === "") {
    return EMPTY_ALLOWLIST;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    console.warn(
      `[origin-allowlist] seat cell is not JSON — treating as empty (${String(error)})`,
    );
    return EMPTY_ALLOWLIST;
  }
  if (!Array.isArray(parsed)) {
    console.warn("[origin-allowlist] seat cell is not a JSON array — treating as empty");
    return EMPTY_ALLOWLIST;
  }
  const origins = new Set<string>();
  for (const entry of parsed) {
    const url = typeof entry === "string" ? parseOriginLike(entry) : null;
    if (url === null) {
      console.warn(`[origin-allowlist] dropping non-origin seat entry: ${JSON.stringify(entry)}`);
      continue;
    }
    origins.add(url.origin);
  }
  return origins;
}

/**
 * The trusted extra origins (canonical forms). Absent row = the ruled
 * default posture (zero extra origins), never an env override.
 */
export async function getOriginAllowlist(
  env: OriginAllowlistEnv,
): Promise<ReadonlySet<string>> {
  if (env.DB === undefined) {
    return EMPTY_ALLOWLIST;
  }
  const row = await env.DB.prepare("SELECT origins FROM origin_allowlist WHERE id = ?")
    .bind(ORIGIN_ALLOWLIST_ROW_ID)
    .first<{ origins: string | null }>();
  if (row === null) {
    return EMPTY_ALLOWLIST;
  }
  return decodeOriginAllowlistCell(row.origins);
}

/** Upsert the whole seat (canonical origins; updated_at always moves). */
export async function setOriginAllowlist(
  env: OriginAllowlistEnv,
  origins: string[],
): Promise<void> {
  if (env.DB === undefined) return;
  await env.DB.prepare(
    `INSERT INTO origin_allowlist (id, origins, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       origins = excluded.origins,
       updated_at = excluded.updated_at`,
  )
    .bind(ORIGIN_ALLOWLIST_ROW_ID, JSON.stringify(origins), Date.now())
    .run();
}
