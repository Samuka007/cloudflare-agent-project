/**
 * Harness minimal three keys (#17 ruling Q4, #28 ruling 2026-10-03) — the
 * provider application's entire M0 configuration surface:
 *
 *   1. 模型中转配置 — the legacy deployment channel, a pure env scalar
 *      projection (#496): the channel EXISTS only when the deployment named
 *      it (MODEL_RELAY_* env); zero channel env = no channel, nothing is
 *      invented. The key
 *      VALUE rides env (`.dev.vars` locally, Worker Secret in deployment) and
 *      never enters code, tests, or the durable registry snapshot.
 *   2. host 绑定声明 — which machine a thread's tool executions route to
 *      (`machineId`); this is the value the agent DO carries into
 *      daemon-service dispatch (`ToolDispatchRequest.machineId`).
 *   3. session 执行配置解析 — the minimal `RuntimeThreadExecutionOptions`
 *      subset the M0 loop can honor (model/serviceTier/reasoningLevel plus a
 *      permission policy).
 *
 * `resolveHarness` is a total pure function over the worker env record.
 * #496 (user ruling 2026-10-07, no-special-case): NO invented defaults — an
 * unnamed model/baseUrl stays empty, the channel reports `unconfigured`, and
 * the key-less mock mode survives only for a channel the deployment
 * explicitly configured. (The mock PROVIDER is gone entirely: turns dispatch
 * through the fail-closed registry — relayProviderFrom is retired.) #450:
 * the provider DIRECTORY is not a harness concern — the picker's truth is
 * the D1 provider_configs rows (catalog.ts resolveOverlayCatalog).
 */

import {
  envFlag,
  deriveRelayReasoning,
  DEFAULT_RELAY_API,
  type RelayApi,
  type ResponsesEffort,
  type RelayReasoningLevel,
  type RelayConfig,
} from "@cap/agent-do";
import { CLOUD_PLACEHOLDER_HOST_ID } from "@cap/protocol";
import type { RuntimeThreadExecutionOptions } from "../../daemon-worker/src/provider-types.js";

/** Environment variables this harness reads (all optional). */
export interface HarnessEnv {
  /** Anthropic-protocol relay base; unset = the channel names no endpoint. */
  MODEL_RELAY_BASE_URL_ANTHROPIC?: string;
  /** Relay key — presence flips the relay from mock to the real client. */
  MODEL_RELAY_API_KEY?: string;
  /** Relay model — the "running model" fill; unset = no default model. */
  MODEL_RELAY_MODEL?: string;
  /**
   * #308 context window denominator for the usage percentage (protocol
   * scalar with the inline 200K fallback — docs.bigmodel.cn GLM-5
   * family「上下文窗口 200K」; not a deployment identity: a wrong value only
   * skews usage percentages, never routes a turn).
   */
  MODEL_RELAY_CONTEXT_WINDOW?: string;
  /** Per-call completion budget; reasoning counts against it on glm-5.3. */
  MODEL_RELAY_MAX_TOKENS?: string;
  /** When set (integer), turns on extended thinking with this token budget. */
  MODEL_RELAY_THINKING_BUDGET_TOKENS?: string;
  /**
   * A4 image-input capability declaration (#319, 1/true/on): does the relay
   * model accept image input? Unset = not declared → every prompt image
   * degrades to its acp text (safe default; a wrong `true` turns into an
   * upstream 400 on the first image turn, so the deployment opts in).
   */
  MODEL_RELAY_IMAGE_INPUT?: string;
  /** Host binding pin; unset = the cloud placeholder (#377, no fabricated machine). */
  DAEMON_MACHINE_ID?: string;
  /** `accept-edits` | `auto` | `full` (default `full`). */
  HARNESS_PERMISSION_MODE?: string;
}

export type ThinkingConfig = NonNullable<RelayConfig["thinking"]>;

export interface ResolvedHarness {
  relay: {
    /**
     * #496 honest channel vocabulary: `anthropic` = configured + keyed,
     * `mock` = configured but key-less (the #28 posture, kept only for that
     * explicit scenario), `unconfigured` = zero channel env (the panel hides
     * the block, #484).
     */
    mode: "anthropic" | "mock" | "unconfigured";
    baseUrl: string;
    apiKey: string;
    model: string;
    maxTokens: number;
    contextWindow: number;
    thinking: ThinkingConfig;
    supportsImageInput: boolean;
    /**
     * #361: the protocol face the deployment default relay speaks. With the
     * #450 env-seed removal there is no declared running row, so the
     * deployment channel always speaks the incumbent anthropic face; the D1
     * rows carry their own api fold on the registry side.
     */
    api: RelayApi;
    /**
     * The deployment default reasoning rung mapped to the Responses effort.
     * The anthropic channel consumes no effort map → constant "none"
     * (ResponsesRelayProvider ignores it; kept for shape parity).
     */
    reasoningEffort: ResponsesEffort;
  };
  hostBinding: { machineId: string };
  execution: RuntimeThreadExecutionOptions;
}

function executionOptionsOf(
  mode: string | undefined,
  model: string,
  defaultReasoningLevel: RelayReasoningLevel,
): RuntimeThreadExecutionOptions {
  const base = {
    model,
    serviceTier: "default" as const,
    // #350: the declared reasoning default follows the same derivation the
    // directory rows use (deriveRelayReasoning over the budget flag) — the
    // harness face and the picker face can no longer disagree (roadmap
    // §2.3 contradiction 1). Budget off → "none"; budget on → the declared
    // default or bb's medium rung. #361: the level is derived ONCE in
    // resolveHarness and shared with the relay's effort fold below.
    reasoningLevel: defaultReasoningLevel,
    workflowsEnabled: false,
  };
  if (mode === "accept-edits") {
    return {
      ...base,
      permissionMode: "accept-edits",
      permissionScope: "workspace",
      approvalReviewer: "user",
      permissionEscalation: "deny",
    };
  }
  if (mode === "auto") {
    return {
      ...base,
      permissionMode: "auto",
      permissionScope: "workspace",
      approvalReviewer: "automatic",
      permissionEscalation: "deny",
    };
  }
  return {
    ...base,
    permissionMode: "full",
    permissionScope: "full",
    approvalReviewer: null,
    permissionEscalation: null,
  };
}

/** Key 1+2+3 in one total resolution. Never throws on env content. */
export function resolveHarness(env: HarnessEnv): ResolvedHarness {
  // #496: the deployment channel is a pure env scalar projection — NOTHING
  // is invented. An unnamed model/endpoint stays "" (the channel does not
  // exist); the only inline fallbacks left are the wire-safety protocol
  // scalars (maxTokens/contextWindow: a wrong value degrades a usage
  // percentage or clamps a reply, it never routes a turn to another model).
  // Empty-after-trim counts as unset (kept explicit — `??` alone would let
  // an empty string through).
  const modelRaw = env.MODEL_RELAY_MODEL?.trim() ?? "";
  const model = modelRaw;
  const relayApi: RelayApi = DEFAULT_RELAY_API;
  const baseUrlRaw = env.MODEL_RELAY_BASE_URL_ANTHROPIC?.trim() ?? "";
  const baseUrl = baseUrlRaw;
  const apiKey = env.MODEL_RELAY_API_KEY?.trim() ?? "";
  const maxTokensRaw = Number.parseInt(env.MODEL_RELAY_MAX_TOKENS ?? "", 10);
  const maxTokens =
    Number.isFinite(maxTokensRaw) && maxTokensRaw > 0 ? maxTokensRaw : 8192;
  const contextWindowRaw = Number.parseInt(env.MODEL_RELAY_CONTEXT_WINDOW ?? "", 10);
  const contextWindow =
    Number.isFinite(contextWindowRaw) && contextWindowRaw > 0 ? contextWindowRaw : 200_000;
  const budgetRaw = Number.parseInt(env.MODEL_RELAY_THINKING_BUDGET_TOKENS ?? "", 10);
  const machineIdRaw = env.DAEMON_MACHINE_ID?.trim() ?? "";
  const thinking: ThinkingConfig =
    Number.isFinite(budgetRaw) && budgetRaw > 0
      ? { type: "enabled", budget_tokens: budgetRaw }
      : { type: "disabled" };
  const thinkingEnabled = thinking.type === "enabled";
  const derivedLadder = deriveRelayReasoning({ thinkingEnabled });
  // The deployment channel speaks the incumbent anthropic face, which
  // consumes no effort map → the Responses effort is the "none" identity.
  const reasoningEffort: ResponsesEffort = "none";
  return {
    relay: {
      // #496: `unconfigured` = zero channel env (no model, no endpoint);
      // `mock` survives only for a channel the deployment explicitly named
      // but did not key — an honest projection, never a synthesized default.
      mode:
        model === "" && baseUrl === ""
          ? "unconfigured"
          : apiKey === ""
            ? "mock"
            : "anthropic",
      baseUrl,
      apiKey,
      model,
      maxTokens,
      contextWindow,
      thinking,
      supportsImageInput: envFlag(env.MODEL_RELAY_IMAGE_INPUT),
      api: relayApi,
      reasoningEffort,
    },
    hostBinding: {
      // #377: the placeholder binds honestly until a real host (or the
      // tier-0/tier-1 cloud carrier, #307) takes the thread — a binding
      // identity, not a channel default.
      machineId: machineIdRaw === "" ? CLOUD_PLACEHOLDER_HOST_ID : machineIdRaw,
    },
    // M0 deterministic budget (relay thinking defaults off — glm-5.3 burns
    // completion budget on reasoning; re-enable via the thinking env only).
  execution: executionOptionsOf(
    env.HARNESS_PERMISSION_MODE,
    model,
    derivedLadder.defaultLevel,
  ),
  };
}

// ---------------------------------------------------------------------------
// Change classification over the three keys ("live" vs "session").
// ---------------------------------------------------------------------------

/**
 * Secret-free projection used for both durable snapshots and drift
 * classification: only key PRESENCE survives, never the key VALUE.
 */
export interface HarnessProjection {
  relayMode: string;
  relayApi: string;
  relayBaseUrl: string;
  relayKeyPresent: boolean;
  relayModel: string;
  relayMaxTokens: number;
  relayContextWindow: number;
  relayThinking: string;
  relayImageInput: boolean;
  machineId: string;
  executionModel: string;
  executionServiceTier: string;
  executionReasoningLevel: string;
  permissionMode: string;
}

export function projectHarness(harness: ResolvedHarness): HarnessProjection {
  return {
    relayMode: harness.relay.mode,
    relayApi: harness.relay.api,
    relayBaseUrl: harness.relay.baseUrl,
    relayKeyPresent: harness.relay.apiKey !== "",
    relayModel: harness.relay.model,
    relayMaxTokens: harness.relay.maxTokens,
    relayContextWindow: harness.relay.contextWindow,
    // Budget-bearing string so a thinking-budget drift classifies as `live`.
    relayThinking:
      harness.relay.thinking.type === "enabled"
        ? `enabled:${harness.relay.thinking.budget_tokens}`
        : "disabled",
    relayImageInput: harness.relay.supportsImageInput,
    machineId: harness.hostBinding.machineId,
    executionModel: harness.execution.model,
    executionServiceTier: harness.execution.serviceTier,
    executionReasoningLevel: harness.execution.reasoningLevel,
    permissionMode: harness.execution.permissionMode,
  };
}

/** Durable snapshot form (JSON) persisted alongside each registry row. */
export function snapshotHarness(harness: ResolvedHarness): string {
  return JSON.stringify(projectHarness(harness));
}

/** @returns null when the stored snapshot is unreadable (treated as drift). */
export function harnessFromSnapshot(json: string): HarnessProjection | null {
  try {
    const parsed = JSON.parse(json) as Partial<HarnessProjection>;
    if (
      typeof parsed.relayModel !== "string" ||
      typeof parsed.machineId !== "string" ||
      typeof parsed.permissionMode !== "string"
    ) {
      return null;
    }
    return parsed as HarnessProjection;
  } catch {
    return null;
  }
}

/**
 * Three-key drift classification (acceptance: harness-key changes take
 * effect with classifyExecutionSettingsChange semantics):
 *
 * - host binding (machineId) → `session`: a thread's tool surface is frozen
 *   at thread start (port-inventory §3); changing machines requires a
 *   rebuilt provider session.
 * - permission policy (carried inside key 3) → `session` (bb semantics).
 * - relay config (key 1) and the live execution fields (key 3) → `live`:
 *   they ride the next turn — the relay client is re-resolved per turn.
 */
export function classifyHarnessProjection(
  current: HarnessProjection,
  next: HarnessProjection,
): "unchanged" | "live" | "session" {
  if (current.machineId !== next.machineId) return "session";
  if (current.permissionMode !== next.permissionMode) return "session";
  const liveKeys = [
    "relayMode",
    "relayApi",
    "relayBaseUrl",
    "relayKeyPresent",
    "relayModel",
    "relayMaxTokens",
    "relayContextWindow",
    "relayThinking",
    "relayImageInput",
    "executionModel",
    "executionServiceTier",
    "executionReasoningLevel",
  ] as const;
  return liveKeys.some((key) => current[key] !== next[key]) ? "live" : "unchanged";
}