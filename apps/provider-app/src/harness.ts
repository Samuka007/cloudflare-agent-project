/**
 * Harness minimal three keys (#17 ruling Q4, #28 ruling 2026-10-03) — the
 * provider application's entire M0 configuration surface:
 *
 *   1. 模型中转配置 — Anthropic-protocol relay toward the GLM coding plan
 *      (`https://open.bigmodel.cn/api/anthropic`, model `glm-5.3`). The key
 *      VALUE rides env (`.dev.vars` locally, Worker Secret in deployment) and
 *      never enters code, tests, or the durable registry snapshot.
 *   2. host 绑定声明 — which machine a thread's tool executions route to
 *      (`machineId`); this is the value the agent DO carries into
 *      daemon-service dispatch (`ToolDispatchRequest.machineId`).
 *   3. session 执行配置解析 — the minimal `RuntimeThreadExecutionOptions`
 *      subset the M0 loop can honor (model/serviceTier/reasoningLevel plus a
 *      permission policy).
 *
 * `resolveHarness` is a total pure function over the worker env record:
 * missing values fall to the ruled defaults, and a missing API key degrades
 * the relay to the fixed-reply mock (mock-first ruling on #28) instead of
 * failing thread starts.
 */

import {
  AnthropicRelayProvider,
  type ModelProvider,
  type ModelRequest,
  type ModelStreamChunk,
  type RelayConfig,
} from "@cap/agent-do";
import type { RuntimeThreadExecutionOptions } from "../../daemon-worker/src/provider-types.js";

/** Environment variables this harness reads (all optional). */
export interface HarnessEnv {
  /** Anthropic-protocol relay base (default: the ruled bigmodel endpoint). */
  MODEL_RELAY_BASE_URL_ANTHROPIC?: string;
  /** Relay key — presence flips the relay from mock to the real client. */
  MODEL_RELAY_API_KEY?: string;
  /** Relay model (default `glm-5.3`). */
  MODEL_RELAY_MODEL?: string;
  /** Per-call completion budget; reasoning counts against it on glm-5.3. */
  MODEL_RELAY_MAX_TOKENS?: string;
  /** When set (integer), turns on extended thinking with this token budget. */
  MODEL_RELAY_THINKING_BUDGET_TOKENS?: string;
  /** Host binding default (default `local`). */
  DAEMON_MACHINE_ID?: string;
  /** `accept-edits` | `auto` | `full` (default `full`). */
  HARNESS_PERMISSION_MODE?: string;
}

export type ThinkingConfig = NonNullable<RelayConfig["thinking"]>;

export interface ResolvedHarness {
  relay: {
    mode: "anthropic" | "mock";
    baseUrl: string;
    apiKey: string;
    model: string;
    maxTokens: number;
    thinking: ThinkingConfig;
  };
  hostBinding: { machineId: string };
  execution: RuntimeThreadExecutionOptions;
}

export const HARNESS_DEFAULTS = {
  baseUrl: "https://open.bigmodel.cn/api/anthropic",
  model: "glm-5.3",
  maxTokens: 8192,
  machineId: "local",
} as const;

function executionOptionsOf(
  mode: string | undefined,
  model: string,
): RuntimeThreadExecutionOptions {
  const base = {
    model,
    serviceTier: "default" as const,
    reasoningLevel: "none" as const,
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
  const model = env.MODEL_RELAY_MODEL?.trim() || HARNESS_DEFAULTS.model;
  const baseUrl = env.MODEL_RELAY_BASE_URL_ANTHROPIC?.trim() || HARNESS_DEFAULTS.baseUrl;
  const apiKey = env.MODEL_RELAY_API_KEY?.trim() ?? "";
  const maxTokensRaw = Number.parseInt(env.MODEL_RELAY_MAX_TOKENS ?? "", 10);
  const maxTokens =
    Number.isFinite(maxTokensRaw) && maxTokensRaw > 0 ? maxTokensRaw : HARNESS_DEFAULTS.maxTokens;
  const budgetRaw = Number.parseInt(env.MODEL_RELAY_THINKING_BUDGET_TOKENS ?? "", 10);
  const thinking: ThinkingConfig =
    Number.isFinite(budgetRaw) && budgetRaw > 0
      ? { type: "enabled", budget_tokens: budgetRaw }
      : { type: "disabled" };
  return {
    relay: {
      mode: apiKey === "" ? "mock" : "anthropic",
      baseUrl,
      apiKey,
      model,
      maxTokens,
      thinking,
    },
    hostBinding: {
      machineId: env.DAEMON_MACHINE_ID?.trim() || HARNESS_DEFAULTS.machineId,
    },
    // M0 deterministic budget (relay thinking defaults off — glm-5.3 burns
    // completion budget on reasoning; re-enable via the thinking env only).
    execution: executionOptionsOf(env.HARNESS_PERMISSION_MODE, model),
  };
}

/**
 * The relay client a harness resolution stands for (ticket #28: mock first,
 * real endpoint swaps in without changing the bone). The mock is a product
 * mode here, not a test fixture: it keeps threads alive with a fixed reply
 * until a key is provisioned, and records calls for billing-parity probes.
 */
export class FixedReplyProvider implements ModelProvider {
  readonly calls: ModelRequest[] = [];

  constructor(private readonly reply: string) {}

  async *streamTurn(
    request: ModelRequest,
    _options: { signal: AbortSignal },
  ): AsyncIterable<ModelStreamChunk> {
    this.calls.push(request);
    yield { kind: "text-delta", text: this.reply };
  }
}

/** Build the ModelProvider a resolved harness stands for. */
export function relayProviderFrom(harness: ResolvedHarness): ModelProvider {
  if (harness.relay.mode === "anthropic") {
    return new AnthropicRelayProvider({
      baseUrl: harness.relay.baseUrl,
      apiKey: harness.relay.apiKey,
      model: harness.relay.model,
      maxTokens: harness.relay.maxTokens,
      thinking: harness.relay.thinking,
    });
  }
  return new FixedReplyProvider(
    "model relay not configured (MODEL_RELAY_API_KEY missing) — fixed-reply mock in service (ticket #28 M0)",
  );
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
  relayBaseUrl: string;
  relayKeyPresent: boolean;
  relayModel: string;
  relayMaxTokens: number;
  relayThinking: string;
  machineId: string;
  executionModel: string;
  executionServiceTier: string;
  executionReasoningLevel: string;
  permissionMode: string;
}

export function projectHarness(harness: ResolvedHarness): HarnessProjection {
  return {
    relayMode: harness.relay.mode,
    relayBaseUrl: harness.relay.baseUrl,
    relayKeyPresent: harness.relay.apiKey !== "",
    relayModel: harness.relay.model,
    relayMaxTokens: harness.relay.maxTokens,
    // Budget-bearing string so a thinking-budget drift classifies as `live`.
    relayThinking:
      harness.relay.thinking.type === "enabled"
        ? `enabled:${harness.relay.thinking.budget_tokens}`
        : "disabled",
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
    "relayBaseUrl",
    "relayKeyPresent",
    "relayModel",
    "relayMaxTokens",
    "relayThinking",
    "executionModel",
    "executionServiceTier",
    "executionReasoningLevel",
  ] as const;
  return liveKeys.some((key) => current[key] !== next[key]) ? "live" : "unchanged";
}
