/**
 * Session execution posture (#500) — what remains of the retired deployment
 * channel after the MODEL_RELAY_* / DAEMON_MACHINE_ID / HARNESS_PERMISSION_MODE
 * env scalar family died (#496 made the channel a pure env projection; #500
 * removes the projection itself):
 *
 * - the permission-mode → permission-policy mapping is a pure constant table
 *   (bb `runtimePermissionPolicySchema` vocabulary; mode order is the bb
 *   privilege rank). The mode VALUE no longer rides env — the server bridge
 *   reads the D1 `permission_mode` seat and passes the mode in, so the
 *   default hot-applies without a redeploy;
 * - `defaultExecutionOptions` assembles the default execution posture a
 *   provider command rides: NO deployment model (the thread selection is the
 *   model source, #499; an unnamed model stays "") and the D1-read
 *   permission mode;
 * - the two wire-safety protocol fallbacks survive as named constants for
 *   rows that declare no completion budget / context window — a wrong value
 *   only clamps a reply or skews a usage percentage, it never routes a turn
 *   to another model (the #496 wire-safety ruling). The per-row D1
 *   declaration always wins.
 *
 * Everything else the old harness resolved (relay base/key/model, thinking
 * budget, image-input flag, machine binding) has exactly one 正本 elsewhere:
 * the D1 provider_configs rows (dispatch), the row model fields (budget /
 * window / input), and the #377 cloud placeholder (host binding).
 */

import type {
  PermissionMode,
  RuntimePermissionPolicy,
  RuntimeThreadExecutionOptions,
} from "../../daemon-worker/src/provider-types.js";

/** The wire thinking knob (RelayConfig["thinking"] non-null, structurally). */
export type ThinkingConfig = { type: "disabled" } | { type: "enabled"; budget_tokens: number };

/** Completion budget fallback when a row declares none (wire-safety scalar). */
export const RELAY_FALLBACK_MAX_TOKENS = 8192;

/** Context-window fallback when a row declares none (usage-% denominator). */
export const RELAY_FALLBACK_CONTEXT_WINDOW = 200_000;

/**
 * The invariant mode → policy mapping (bb `runtimeThreadExecutionOptionsSchema`
 * semantics): the mode fully determines scope/reviewer/escalation — there is
 * no second decision point per field.
 */
export function permissionPolicyOf(mode: PermissionMode): RuntimePermissionPolicy {
  if (mode === "accept-edits") {
    return {
      permissionMode: "accept-edits",
      permissionScope: "workspace",
      approvalReviewer: "user",
      permissionEscalation: "deny",
    };
  }
  if (mode === "auto") {
    return {
      permissionMode: "auto",
      permissionScope: "workspace",
      approvalReviewer: "automatic",
      permissionEscalation: "deny",
    };
  }
  return {
    permissionMode: "full",
    permissionScope: "full",
    approvalReviewer: null,
    permissionEscalation: null,
  };
}

/**
 * The default execution posture for provider commands: no deployment model
 * (the journaled thread selection decides the wire model), thinking budget
 * off (the row's ladder decides — an unconfigured default stays the honest
 * "none"), and the passed permission mode.
 */
export function defaultExecutionOptions(mode: PermissionMode): RuntimeThreadExecutionOptions {
  return {
    model: "",
    serviceTier: "default",
    reasoningLevel: "none",
    workflowsEnabled: false,
    ...permissionPolicyOf(mode),
  };
}
