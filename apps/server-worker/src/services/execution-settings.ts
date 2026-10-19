import type {
  PermissionMode,
  RuntimePermissionPolicy,
  RuntimeThreadExecutionOptions,
} from "../contract/domain/shared-types";

/**
 * Permission-mode → permission-policy mapping (bb
 * `runtimeThreadExecutionOptionsSchema` semantics): the mode fully determines
 * scope/reviewer/escalation — there is no second decision point per field.
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
 * Default execution posture for provider commands: no deployment model (the
 * journaled thread selection decides the wire model), thinking off (the row's
 * ladder decides), and the passed permission mode.
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

/** `session` requires a provider rebuild; `live` rides the next turn. */
export type ProviderExecutionSettingsChange = "live" | "session" | "unchanged";

/**
 * bb classification semantics: route-affecting settings ride the next turn
 * (`live`); the permission policy needs a rebuilt provider session
 * (`session`).
 */
export function classifyExecutionSettingsChange(
  current: RuntimeThreadExecutionOptions,
  next: RuntimeThreadExecutionOptions,
): ProviderExecutionSettingsChange {
  const policyChanged =
    current.permissionMode !== next.permissionMode ||
    current.permissionScope !== next.permissionScope ||
    current.approvalReviewer !== next.approvalReviewer ||
    current.permissionEscalation !== next.permissionEscalation;
  if (policyChanged) {
    return "session";
  }
  const liveChanged =
    current.model !== next.model ||
    current.serviceTier !== next.serviceTier ||
    current.reasoningLevel !== next.reasoningLevel;
  return liveChanged ? "live" : "unchanged";
}
