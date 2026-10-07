/**
 * #500 the permission-mode persistence: the single-row D1 seat
 * (id = 'permission_mode', the image_source/web_search/tool_capabilities
 * precedent) behind GET/PUT /system/permission-mode. The mode column is the
 * session permission posture (accept-edits | auto | full) turns without an
 * explicit thread-level mode dispatch under; the row is ABSENT until an
 * operator writes it, and the absent state is the ruled default "full".
 * The deployment env scalar is deleted (#500 zero-env ruling): D1 is the
 * sole 正本, no env fallback exists.
 */

import { permissionModeValues, type PermissionMode } from "../contract/domain/shared-types.js";

/** The slice of the worker Env this module needs (the worker Env satisfies it). */
export interface PermissionModeEnv {
  DB?: D1Database;
}

const PERMISSION_MODE_ROW_ID = "permission_mode";

/** The read shape: the stored mode + whether the row exists at all. */
export interface PermissionModeState {
  mode: PermissionMode;
  /** True when the D1 row exists (false = the absent-row "full" default). */
  configured: boolean;
}

/** The ruled absent-row posture (the retired env scalar's default). */
export const DEFAULT_PERMISSION_MODE: PermissionMode = "full";

function decodeMode(raw: string | null): PermissionMode {
  // Strict vocabulary decode (the #502 seat precedent): a hand-edited value
  // outside the enum is not a posture — it falls back to the ruled default.
  return permissionModeValues.find((mode) => mode === raw) ?? DEFAULT_PERMISSION_MODE;
}

export async function getPermissionMode(env: PermissionModeEnv): Promise<PermissionModeState> {
  if (env.DB === undefined) {
    return { configured: false, mode: DEFAULT_PERMISSION_MODE };
  }
  const row = await env.DB.prepare("SELECT mode FROM permission_mode WHERE id = ?")
    .bind(PERMISSION_MODE_ROW_ID)
    .first<{ mode: string | null }>();
  if (row === null) {
    return { configured: false, mode: DEFAULT_PERMISSION_MODE };
  }
  return { configured: true, mode: decodeMode(row.mode) };
}

/** Upsert the whole seat (updated_at always moves). */
export async function setPermissionMode(
  env: PermissionModeEnv,
  mode: PermissionMode,
): Promise<void> {
  if (env.DB === undefined) return;
  await env.DB.prepare(
    `INSERT INTO permission_mode (id, mode, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET mode = excluded.mode, updated_at = excluded.updated_at`,
  )
    .bind(PERMISSION_MODE_ROW_ID, mode, Date.now())
    .run();
}
