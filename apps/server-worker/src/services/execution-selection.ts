/**
 * #351 thread-level execution selection: the server bridge's fail-closed
 * validation + drift classification over the catalog directory (roadmap §2.2
 * consumption-gap row, §3 L4 row).
 *
 * Resolution reads ONE source: the provider-app catalog projection
 * (resolveRelayCatalog — the same resolution the picker face and the relay
 * registry run), so an unknown value 422s with a NAMED error exactly when
 * the directory has no such row — there is no second answer to drift from
 * (ROADMAP red line: never silently relax onto another provider/model row).
 *
 * Drift goes through the bb classifyExecutionSettingsChange three-value
 * vocabulary (control-plane-layer.md four-layer chain, layer 4): model /
 * reasoningLevel are `live` fields — the change persists to the threads row
 * overrides and RIDES the dispatched turn; `unchanged` writes and journals
 * nothing.
 */

import {
  relayReasoningLevelSchema,
  RelaySelectionError,
  resolveRelaySelection,
  type RelayCatalogProvider,
  type RelayReasoningLevel,
  type RelaySelection,
} from "@cap/agent-do";
import {
  classifyExecutionSettingsChange,
  resolveRelayCatalog,
  resolveRelayCatalogWithOverlay,
  type RelayCatalogResolution,
} from "@cap/provider-app";
import type { RuntimeThreadExecutionOptions } from "../../../daemon-worker/src/provider-types.js";
import type { HarnessEnv } from "@cap/provider-app";
import { ApiError } from "../shared/api-error.js";

/** The create/send payload slice this service validates (all optional). */
export interface ThreadExecutionSelectionInput {
  providerId?: string;
  model?: string;
  /** Contract-validated upstream (reasoningLevelSchema) — the bb vocabulary. */
  reasoningLevel?: RelayReasoningLevel;
}

/** The resolved selection the thread dispatches under (total — defaults filled). */
export interface ResolvedThreadExecutionSelection {
  providerId: string;
  model: string;
  reasoningLevel: RelayReasoningLevel;
}

/** The explicit selection that rides the DO journal (null = payload had none). */
export interface ValidatedThreadExecutionSelection {
  explicit: RelaySelection | null;
  resolved: ResolvedThreadExecutionSelection;
}

function selectionErrorToApiError(error: RelaySelectionError): ApiError {
  return new ApiError({
    status: 422,
    code: error.code,
    message: error.message,
    details: { field: error.field },
    retryable: false,
  });
}

function explicitOf(input: ThreadExecutionSelectionInput): RelaySelection | null {
  const explicit: RelaySelection = {};
  if (input.providerId !== undefined) explicit.providerId = input.providerId;
  if (input.model !== undefined) explicit.model = input.model;
  if (input.reasoningLevel !== undefined) explicit.reasoningLevel = input.reasoningLevel;
  return Object.keys(explicit).length > 0 ? explicit : null;
}

/**
 * Validate one selection against the catalog directory. A payload without
 * selection fields resolves against the DECLARATION's defaultProvider
 * (#434 point 3 — never an "omp" sentinel: a deployment that declares no
 * defaultProvider fails the create/send with the named
 * provider_default_undeclared 422). Throws 422 named errors:
 * provider_default_undeclared / provider_unknown / model_unknown /
 * reasoning_level_unknown (fail-closed including the empty catalog state —
 * no synthesis admits anything).
 */
export function validateThreadExecutionSelection(
  env: HarnessEnv,
  input: ThreadExecutionSelectionInput,
  overlayProviders?: Record<string, RelayCatalogProvider>,
): ValidatedThreadExecutionSelection {
  const explicit = explicitOf(input);
  const catalog: RelayCatalogResolution =
    overlayProviders === undefined
      ? resolveRelayCatalog(env)
      : resolveRelayCatalogWithOverlay(env, overlayProviders);
  if (explicit === null) {
    try {
      return { explicit: null, resolved: resolveRelayCatalogSelection(catalog, {}) };
    } catch (error) {
      if (error instanceof RelaySelectionError) throw selectionErrorToApiError(error);
      throw error;
    }
  }
  try {
    const resolved = resolveRelayCatalogSelection(catalog, explicit);
    return { explicit, resolved };
  } catch (error) {
    if (error instanceof RelaySelectionError) throw selectionErrorToApiError(error);
    throw error;
  }
}

function resolveRelayCatalogSelection(
  catalog: RelayCatalogResolution,
  selection: RelaySelection,
): ResolvedThreadExecutionSelection {
  const resolved = resolveRelaySelection(
    {
      rows: catalog.models,
      defaultProviderId: catalog.defaultProviderId,
      defaultModelId: catalog.harness.relay.model,
      thinkingEnabled: catalog.harness.relay.thinking.type === "enabled",
    },
    selection,
  );
  return {
    providerId: resolved.providerId,
    model: resolved.modelId,
    reasoningLevel: resolved.reasoningLevel,
  };
}

/**
 * The resolved selection of a thread's STORED state (row overrides with
 * unset members resolved against the catalog). Fails closed with the same
 * named errors when the catalog drifted away from a stored override — a
 * stored selection the directory no longer declares must 422 the next
 * selection-bearing write, never silently fall back.
 */
export function resolveStoredThreadExecution(
  env: HarnessEnv,
  stored: {
    providerId: string;
    modelOverride: string | null;
    reasoningLevelOverride: string | null;
  },
  overlayProviders?: Record<string, RelayCatalogProvider>,
): ResolvedThreadExecutionSelection {
  const catalog: RelayCatalogResolution =
    overlayProviders === undefined
      ? resolveRelayCatalog(env)
      : resolveRelayCatalogWithOverlay(env, overlayProviders);
  const storedLevel =
    stored.reasoningLevelOverride !== null
      ? relayReasoningLevelSchema.safeParse(stored.reasoningLevelOverride)
      : undefined;
  if (storedLevel !== undefined && !storedLevel.success) {
    throw new ApiError({
      status: 422,
      code: "reasoning_level_unknown",
      message: `stored reasoning level "${stored.reasoningLevelOverride}" is not in the reasoning vocabulary`,
      details: { field: "reasoningLevel" },
      retryable: false,
    });
  }
  const explicit: RelaySelection = {
    providerId: stored.providerId,
    ...(stored.modelOverride !== null ? { model: stored.modelOverride } : {}),
    ...(storedLevel?.data !== undefined ? { reasoningLevel: storedLevel.data } : {}),
  };
  try {
    return resolveRelayCatalogSelection(catalog, explicit);
  } catch (error) {
    if (error instanceof RelaySelectionError) throw selectionErrorToApiError(error);
    throw error;
  }
}

/** Constant permission/serviceTier fill: only model/reasoning can drift here. */
function executionOptionsOf(
  resolved: ResolvedThreadExecutionSelection,
): RuntimeThreadExecutionOptions {
  return {
    model: resolved.model,
    serviceTier: "default",
    reasoningLevel: resolved.reasoningLevel,
    workflowsEnabled: false,
    permissionMode: "full",
    permissionScope: "full",
    approvalReviewer: null,
    permissionEscalation: null,
  };
}

/**
 * The bb three-value verdict over a selection change (model/reasoningLevel
 * are `live` — permission is constant in this fill, so `session` cannot
 * arise from a selection payload; the classifier keeps the full vocabulary
 * for the faces where it can).
 */
export function classifyThreadSelectionChange(
  current: ResolvedThreadExecutionSelection,
  next: ResolvedThreadExecutionSelection,
): "unchanged" | "live" | "session" {
  return classifyExecutionSettingsChange(executionOptionsOf(current), executionOptionsOf(next));
}
