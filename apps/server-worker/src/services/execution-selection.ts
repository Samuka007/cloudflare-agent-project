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
  resolveOverlayCatalog,
  type RelayCatalogResolution,
} from "@cap/provider-app";
import type { RuntimeThreadExecutionOptions } from "../../../daemon-worker/src/provider-types.js";
import {
  resolvedThreadExecutionOptionsSchema,
  type PermissionMode,
  type ResolvedThreadExecutionOptions,
} from "../contract/domain/shared-types.js";
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
  input: ThreadExecutionSelectionInput,
  overlayProviders: Record<string, RelayCatalogProvider>,
): ValidatedThreadExecutionSelection {
  const explicit = explicitOf(input);
  const catalog: RelayCatalogResolution = resolveOverlayCatalog(overlayProviders);
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
      // #500: no deployment model / thinking scalar exists — a model-less
      // selection fails closed (named 422) and each row's ladder is decided
      // by its own thinkingBudgetTokens.
      defaultModelId: "",
      thinkingEnabled: false,
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
  stored: {
    providerId: string;
    modelOverride: string | null;
    reasoningLevelOverride: string | null;
  },
  overlayProviders: Record<string, RelayCatalogProvider>,
): ResolvedThreadExecutionSelection {
  const catalog: RelayCatalogResolution = resolveOverlayCatalog(overlayProviders);
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

/**
 * bb GET /threads/:id/default-execution-options (routes/threads/data.ts:531-543
 * → thread-execution-plan.ts:295-386 `defaultView`): the thread composer's
 * stored-selection face. bb's model chain is input.model ?? modelOverride ??
 * lastExecution ?? projectExecution (project defaults gated on the row's
 * provider, :312-315); the port has no per-request input and no stored project
 * defaults, so the face is the row's overrides resolved against the SAME
 * merged catalog a send validates against (#486) — the displayed model is the
 * dispatched model by construction.
 *
 * bb's read face trusts the stored row and never catalog-validates it; the
 * port keeps that display honesty: a stored selection the directory no longer
 * declares (or an undeclared default under the row's provider) returns the
 * stored strings verbatim / null (bb's stored-defaults-absent shape) — never
 * a re-projection onto the harness default model. The DISPATCH half stays
 * fail-closed (#351): the next selection-bearing send 422s with the named
 * error instead of silently running another model.
 */
export function resolveThreadDefaultExecutionOptions(
  permissionMode: PermissionMode,
  row: {
    providerId: string;
    modelOverride: string | null;
    reasoningLevelOverride: string | null;
  },
  overlayProviders: Record<string, RelayCatalogProvider>,
): ResolvedThreadExecutionOptions | null {
  const parse = (model: string, reasoningLevel: RelayReasoningLevel) =>
    resolvedThreadExecutionOptionsSchema.parse({
      model,
      serviceTier: "default",
      reasoningLevel,
      // #500: the stored-thread display default is the D1 seat's posture
      // (the server route reads it per request — hot, no redeploy).
      permissionMode,
      source: "client/turn/requested",
    });
  const storedLevel =
    row.reasoningLevelOverride !== null
      ? relayReasoningLevelSchema.safeParse(row.reasoningLevelOverride)
      : undefined;
  try {
    const resolved = resolveStoredThreadExecution(row, overlayProviders);
    return parse(resolved.model, resolved.reasoningLevel);
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    if (
      error.code !== "model_unknown" &&
      error.code !== "provider_unknown" &&
      error.code !== "provider_default_undeclared"
    ) {
      throw error;
    }
    // Catalog drifted away from the stored row. With a stored model the
    // display keeps it verbatim (bb read-face parity; the ladder degrades to
    // the vocabulary-checked stored rung); without one, bb serves null and
    // the composer falls to the picker's own default instead of a silently
    // re-projected row.
    if (row.modelOverride !== null) {
      return parse(row.modelOverride, storedLevel?.data ?? "none");
    }
    return null;
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

/**
 * Presence-sensitive model/reasoning patch slice for PATCH /threads/:id
 * (#499). `undefined` leaves a field untouched; `null` clears it.
 */
export interface ThreadExecutionOverridePatch {
  model?: string | null;
  reasoningLevel?: RelayReasoningLevel | null;
}

/**
 * #499 the one-click fallback card's write face: resolve the next stored
 * execution override for a model/reasoningLevel patch. The gate is the SAME
 * resolveStoredThreadExecution the read face runs — the pair about to be
 * stored must resolve against the directory, so a model the directory no
 * longer declares fails closed with the named 422 (model_unknown /
 * provider_unknown) and nothing persists: the thread truth is only ever
 * rewritten to a dispatchable row by an explicit user action.
 *
 * A model-only patch that strands a stored rung the new model's ladder no
 * longer supports reconciles onto that model's default rung instead of
 * persisting an unreadable pair (bb parity:
 * thread-execution-override.ts:121-132 "reconcile rather than failing").
 */
export function resolveThreadExecutionOverridePatch(
  row: {
    providerId: string;
    modelOverride: string | null;
    reasoningLevelOverride: string | null;
  },
  patch: ThreadExecutionOverridePatch,
  overlayProviders: Record<string, RelayCatalogProvider>,
): { modelOverride: string | null; reasoningLevelOverride: string | null } {
  const candidate = {
    providerId: row.providerId,
    modelOverride: "model" in patch ? (patch.model ?? null) : row.modelOverride,
    reasoningLevelOverride:
      "reasoningLevel" in patch
        ? (patch.reasoningLevel ?? null)
        : row.reasoningLevelOverride,
  };
  try {
    resolveStoredThreadExecution(candidate, overlayProviders);
    return candidate;
  } catch (error) {
    const reconcilable =
      "model" in patch &&
      !("reasoningLevel" in patch) &&
      candidate.reasoningLevelOverride !== null &&
      error instanceof ApiError &&
      error.code === "reasoning_level_unknown";
    if (!reconcilable) throw error;
    const resolved = validateThreadExecutionSelection(
      {
        providerId: row.providerId,
        ...(candidate.modelOverride !== null
          ? { model: candidate.modelOverride }
          : {}),
      },
      overlayProviders,
    );
    return {
      modelOverride: candidate.modelOverride,
      reasoningLevelOverride: resolved.resolved.reasoningLevel,
    };
  }
}
