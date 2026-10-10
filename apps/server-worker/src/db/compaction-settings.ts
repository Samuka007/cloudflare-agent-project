/**
 * #547 the compaction-preference persistence: the single-row D1 seat
 * (id = 'compaction_settings', the tool_capabilities/permission_mode
 * precedent) behind GET/PUT /system/compaction-settings. `method_order` is
 * the deployment's omp compact preference order (first entry tried first);
 * `remote_provider_id`/`remote_model` name the delegated summarizer the
 * `remote` mode pins (omp RemoteCompactionConfig analog — the endpoint is the
 * row's own relay channel config, so only the selection lives here). The row
 * is ABSENT until an operator writes it: absent = the omp default order with
 * remote ineligible. Reads happen per compact face, so a write hot-applies.
 */

import { compactModeSchema, resolveCompactionMethodOrder, type CompactMode } from "@cap/agent-do";

/** The capability slice this module needs (the worker Env satisfies it). */
export interface CompactionSettingsEnv {
  DB?: D1Database;
}

const COMPACTION_SETTINGS_ROW_ID = "compaction_settings";

/** The configured remote summarizer (omp RemoteCompactionConfig analog). */
export interface RemoteCompactionSelection {
  providerId?: string;
  model: string;
}

/** The read shape: the order, the remote selection, and row existence. */
export interface CompactionSettingsState {
  /** True when the D1 row exists (false = the absent-row omp posture). */
  configured: boolean;
  methodOrder: CompactMode[];
  remote: RemoteCompactionSelection | null;
}

/**
 * The absent-row posture: the #309 status quo (soft — the compact button's
 * shipped semantics), remote ineligible. The omp canonical order
 * (DEFAULT_COMPACTION_METHOD_ORDER) is what an operator writes into the seat
 * to opt in — a fresh deployment never silently swaps its manual compact face
 * to a snapshot cut.
 */
export function absentCompactionSettings(): CompactionSettingsState {
  return { configured: false, methodOrder: ["soft"], remote: null };
}

export async function getCompactionSettings(
  env: CompactionSettingsEnv,
): Promise<CompactionSettingsState> {
  if (env.DB === undefined) return absentCompactionSettings();
  const row = await env.DB.prepare(
    `SELECT method_order, remote_provider_id, remote_model
     FROM compaction_settings WHERE id = ?`,
  )
    .bind(COMPACTION_SETTINGS_ROW_ID)
    .first<{
      method_order: string;
      remote_provider_id: string | null;
      remote_model: string | null;
    }>();
  if (row === null) return absentCompactionSettings();
  // The seat is operator input re-decoded at every read: a hand-edited
  // method_order filters/dedupes through the omp resolution (never throws);
  // a remote_model that vanished leaves remote ineligible rather than
  // poisoning the whole row.
  let parsedOrder: unknown = [];
  try {
    parsedOrder = JSON.parse(row.method_order) as unknown;
  } catch {
    parsedOrder = [];
  }
  const remote =
    row.remote_model !== null && row.remote_model !== ""
      ? {
          ...(row.remote_provider_id !== null && row.remote_provider_id !== ""
            ? { providerId: row.remote_provider_id }
            : {}),
          model: row.remote_model,
        }
      : null;
  return {
    configured: true,
    methodOrder: resolveCompactionMethodOrder(parsedOrder),
    remote,
  };
}

/** Upsert the whole seat (wholesale replace; updated_at always moves). */
export async function setCompactionSettings(
  env: CompactionSettingsEnv,
  settings: { methodOrder: CompactMode[]; remote: RemoteCompactionSelection | null },
): Promise<void> {
  if (env.DB === undefined) return;
  // Round-trip through the mode schema so the stored JSON is the vocabulary,
  // not the caller's spelling.
  const order = settings.methodOrder.map((mode) => compactModeSchema.parse(mode));
  await env.DB.prepare(
    `INSERT INTO compaction_settings (id, method_order, remote_provider_id, remote_model, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       method_order = excluded.method_order,
       remote_provider_id = excluded.remote_provider_id,
       remote_model = excluded.remote_model,
       updated_at = excluded.updated_at`,
  )
    .bind(
      COMPACTION_SETTINGS_ROW_ID,
      JSON.stringify(order),
      settings.remote?.providerId ?? null,
      settings.remote?.model ?? null,
      Date.now(),
    )
    .run();
}
