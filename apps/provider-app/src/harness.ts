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
  anthropicRequestBody,
  estimateWireRequestTokens,
  envFlag,
  decodeRelayCatalog,
  deriveRelayReasoning,
  findRelayCatalogModel,
  type ModelProvider,
  type ModelRequest,
  type ModelStreamChunk,
  type RelayCatalog,
  type RelayCatalogModel,
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
  /**
   * #308 context window denominator for the usage percentage (default 200K —
   * docs.bigmodel.cn GLM-5 family「上下文窗口 200K」; 1M variants
   * (`glm-5.3[1m]`) and other providers override via this env).
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
  /**
   * #350 catalog declaration (public, zero-secret JSON;
   * packages/agent-do/src/provider-catalog.ts): the multi-provider/multi-model
   * directory the deployment bought. The row for the running model feeds the
   * declared scalars (contextWindow/maxTokens/imageInput/reasoning default)
   * with explicit env scalars keeping precedence; a broken declaration
   * degrades to the env-only synthesis (resolveHarness stays total) and the
   * projection faces report the decode error.
   */
  MODEL_RELAY_CATALOG?: string;
  /**
   * #351 per-provider credential slots (#255 ruling C — the public catalog
   * never carries keys). Strict JSON `{[providerId]: {apiKey?, baseUrl?}}`;
   * a provider without an entry rides the deployment's single-relay slots
   * (MODEL_RELAY_BASE_URL_ANTHROPIC / _API_KEY). Malformed JSON fails loudly
   * at registry construction (deployment-time input, the
   * AGENT_DO_IMAGE_SOURCE posture) — a silent wrong-credential degradation
   * would surface as upstream 403s instead.
   */
  MODEL_RELAY_PROVIDER_CREDENTIALS?: string;
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
    contextWindow: number;
    thinking: ThinkingConfig;
    supportsImageInput: boolean;
  };
  hostBinding: { machineId: string };
  execution: RuntimeThreadExecutionOptions;
}

export const HARNESS_DEFAULTS = {
  baseUrl: "https://open.bigmodel.cn/api/anthropic",
  model: "glm-5.3",
  maxTokens: 8192,
  /** docs.bigmodel.cn GLM-5 family page: 上下文窗口 200K. */
  contextWindow: 200_000,
  machineId: "local",
} as const;

function executionOptionsOf(
  mode: string | undefined,
  model: string,
  thinkingEnabled: boolean,
  row: RelayCatalogModel | undefined,
): RuntimeThreadExecutionOptions {
  const base = {
    model,
    serviceTier: "default" as const,
    // #350: the declared reasoning default follows the same derivation the
    // directory rows use (deriveRelayReasoning over the budget flag) — the
    // harness face and the picker face can no longer disagree (roadmap
    // §2.3 contradiction 1). Budget off → "none"; budget on → the declared
    // default or bb's medium rung.
    reasoningLevel: deriveRelayReasoning({
      thinkingEnabled,
      declaredLevels: row?.reasoningLevels,
      declaredDefault: row?.defaultReasoningLevel,
    }).defaultLevel,
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

/**
 * The decoded MODEL_RELAY_CATALOG declaration, or undefined when absent or
 * unusable. Totality seam for resolveHarness (never throws on env content):
 * a broken catalog degrades to the env-only synthesis while the projection
 * faces (routes/system.ts) surface the decode error separately.
 */
export function catalogFromEnv(
  env: Pick<HarnessEnv, "MODEL_RELAY_CATALOG">,
): RelayCatalog | undefined {
  try {
    return decodeRelayCatalog(env.MODEL_RELAY_CATALOG) ?? undefined;
  } catch {
    return undefined;
  }
}

/** Key 1+2+3 in one total resolution. Never throws on env content. */
export function resolveHarness(env: HarnessEnv): ResolvedHarness {
  // #350 catalog declaration: locate the row for the model turns actually
  // run (env MODEL_RELAY_MODEL, else the catalog's default model, else the
  // ruled default) and fold its declared scalars under the explicit-env
  // precedence that predates the catalog (#308/#319 contracts unchanged).
  const catalog = catalogFromEnv(env);
  const firstProviderKey = Object.keys(catalog?.providers ?? {})[0];
  const defaultProviderKey = catalog?.defaultProvider ?? firstProviderKey;
  const catalogDefaultModel =
    defaultProviderKey !== undefined
      ? catalog?.providers[defaultProviderKey]?.models[0]?.id
      : undefined;
  // Empty-after-trim counts as unset (same fallback `||` gave, kept explicit
  // because `??` alone would let an empty string through).
  const modelRaw = env.MODEL_RELAY_MODEL?.trim() ?? "";
  const model = modelRaw !== "" ? modelRaw : (catalogDefaultModel ?? HARNESS_DEFAULTS.model);
  const row = catalog !== undefined ? findRelayCatalogModel(catalog, model)?.model : undefined;
  const baseUrlRaw = env.MODEL_RELAY_BASE_URL_ANTHROPIC?.trim() ?? "";
  const baseUrl = baseUrlRaw === "" ? HARNESS_DEFAULTS.baseUrl : baseUrlRaw;
  const apiKey = env.MODEL_RELAY_API_KEY?.trim() ?? "";
  const maxTokensRaw = Number.parseInt(env.MODEL_RELAY_MAX_TOKENS ?? "", 10);
  const maxTokens =
    Number.isFinite(maxTokensRaw) && maxTokensRaw > 0
      ? maxTokensRaw
      : (row?.maxTokens ?? HARNESS_DEFAULTS.maxTokens);
  const contextWindowRaw = Number.parseInt(env.MODEL_RELAY_CONTEXT_WINDOW ?? "", 10);
  const contextWindow =
    Number.isFinite(contextWindowRaw) && contextWindowRaw > 0
      ? contextWindowRaw
      : (row?.contextWindow ?? HARNESS_DEFAULTS.contextWindow);
  const budgetRaw = Number.parseInt(env.MODEL_RELAY_THINKING_BUDGET_TOKENS ?? "", 10);
  const machineIdRaw = env.DAEMON_MACHINE_ID?.trim() ?? "";
  const thinking: ThinkingConfig =
    Number.isFinite(budgetRaw) && budgetRaw > 0
      ? { type: "enabled", budget_tokens: budgetRaw }
      : { type: "disabled" };
  const thinkingEnabled = thinking.type === "enabled";
  return {
    relay: {
      mode: apiKey === "" ? "mock" : "anthropic",
      baseUrl,
      apiKey,
      model,
      maxTokens,
      contextWindow,
      thinking,
      // Capability union (#350): either declaration turns it on — the #319
      // env flag or the catalog row's `input` carrying "image".
      supportsImageInput:
        envFlag(env.MODEL_RELAY_IMAGE_INPUT) || row?.input?.includes("image") === true,
    },
    hostBinding: {
      machineId: machineIdRaw === "" ? HARNESS_DEFAULTS.machineId : machineIdRaw,
    },
    // M0 deterministic budget (relay thinking defaults off — glm-5.3 burns
    // completion budget on reasoning; re-enable via the thinking env only).
    execution: executionOptionsOf(env.HARNESS_PERMISSION_MODE, model, thinkingEnabled, row),
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

  private readonly reply: string;
  /** The relay resolution this mock stands in for (wire options + window). */
  private readonly relay: {
    model: string;
    maxTokens: number;
    thinking: ThinkingConfig;
    contextWindow: number;
    supportsImageInput?: boolean;
  };

  constructor(
    reply: string,
    relay?: {
      model: string;
      maxTokens: number;
      thinking: ThinkingConfig;
      contextWindow: number;
      supportsImageInput?: boolean;
    },
  ) {
    this.reply = reply;
    this.relay = relay ?? {
      model: HARNESS_DEFAULTS.model,
      maxTokens: HARNESS_DEFAULTS.maxTokens,
      thinking: { type: "disabled" },
      contextWindow: HARNESS_DEFAULTS.contextWindow,
    };
  }

  streamTurn(
    request: ModelRequest,
    _options: { signal: AbortSignal },
  ): AsyncIterable<ModelStreamChunk> {
    // Hand-rolled iterator: the ModelProvider signature demands AsyncIterable,
    // but `async *` with no await trips require-await. Frame order: the #308
    // usage estimate (bytes/4 over the exact wire body — the mock's
    // "receipt"), then the fixed reply as the terminal answer text.
    this.calls.push(request);
    const usage = {
      inputTokens: estimateWireRequestTokens(
        JSON.stringify(anthropicRequestBody(request, this.relay)),
      ),
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      contextWindow: this.relay.contextWindow,
      estimated: true,
    };
    const frames: ModelStreamChunk[] = [
      { kind: "usage", usage },
      { kind: "text-delta", text: this.reply },
    ];
    let frame = 0;
    return {
      [Symbol.asyncIterator](): AsyncIterator<ModelStreamChunk> {
        return {
          next: (): Promise<IteratorResult<ModelStreamChunk>> => {
            const current = frames[frame];
            frame += 1;
            if (current === undefined) {
              return Promise.resolve({ done: true, value: undefined });
            }
            return Promise.resolve({ done: false, value: current });
          },
        };
      },
    };
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
      contextWindow: harness.relay.contextWindow,
      thinking: harness.relay.thinking,
      supportsImageInput: harness.relay.supportsImageInput,
    });
  }
  return new FixedReplyProvider(
    "model relay not configured (MODEL_RELAY_API_KEY missing) — fixed-reply mock in service (ticket #28 M0)",
    harness.relay,
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
