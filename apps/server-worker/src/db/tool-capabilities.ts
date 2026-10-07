/**
 * #502 the experimental tool-capability persistence: the single-row D1 seat
 * (id = 'tool_capabilities', the image_source/web_search precedent) behind
 * GET/PUT /system/tool-capabilities. The three columns are the #150 gates —
 * external_thinking (`think`), context_notes (context_notes + new_context),
 * checkpoint (checkpoint + rewind); the row is ABSENT until an operator
 * flips a gate, and the absent state is the omp posture: all five tool
 * families OFF. The deployment env inputs are deleted (#502 zero-env
 * ruling): D1 is the sole 正本, no env fallback exists.
 */

import type { ExperimentalToolConfig } from "@cap/agent-do";

/** The capability slice this module needs (the worker Env satisfies it). */
export interface ToolCapabilitiesEnv {
  DB?: D1Database;
}

const TOOL_CAPABILITIES_ROW_ID = "tool_capabilities";

/** The read shape: the three gates + whether the row exists at all. */
export interface ToolCapabilitiesState extends ExperimentalToolConfig {
  /** True when the D1 row exists (false = the absent-row omp posture). */
  configured: boolean;
}

export async function getToolCapabilities(
  env: ToolCapabilitiesEnv,
): Promise<ToolCapabilitiesState> {
  if (env.DB === undefined) {
    return { configured: false, externalThinking: false, contextNotes: false, checkpoint: false };
  }
  const row = await env.DB.prepare(
    `SELECT external_thinking, context_notes, checkpoint
     FROM tool_capabilities WHERE id = ?`,
  )
    .bind(TOOL_CAPABILITIES_ROW_ID)
    .first<{
      external_thinking: number | null;
      context_notes: number | null;
      checkpoint: number | null;
    }>();
  if (row === null) {
    // Absent row = the ruled default posture (omp: all gates off), never an
    // env override.
    return { configured: false, externalThinking: false, contextNotes: false, checkpoint: false };
  }
  // Strict 0/1 decode (the service_tier precedent): a hand-edited value that
  // is not exactly 1 stays off.
  return {
    configured: true,
    externalThinking: row.external_thinking === 1,
    contextNotes: row.context_notes === 1,
    checkpoint: row.checkpoint === 1,
  };
}

/** Upsert the whole seat (three booleans; updated_at always moves). */
export async function setToolCapabilities(
  env: ToolCapabilitiesEnv,
  capabilities: ExperimentalToolConfig,
): Promise<void> {
  if (env.DB === undefined) return;
  await env.DB.prepare(
    `INSERT INTO tool_capabilities (id, external_thinking, context_notes, checkpoint, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       external_thinking = excluded.external_thinking,
       context_notes = excluded.context_notes,
       checkpoint = excluded.checkpoint,
       updated_at = excluded.updated_at`,
  )
    .bind(
      TOOL_CAPABILITIES_ROW_ID,
      capabilities.externalThinking ? 1 : 0,
      capabilities.contextNotes ? 1 : 0,
      capabilities.checkpoint ? 1 : 0,
      Date.now(),
    )
    .run();
}
