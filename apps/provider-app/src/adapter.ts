/**
 * EdgeAgentProviderAdapter (ticket #28) — the provider application half of the
 * daemon ⇄ provider seam (#27). Implements the `ProviderAdapter` contract
 * verbatim (compile-time conformance via the imported interface) and replaces
 * bb's child_process spawn half with typed in-process delivery: every
 * stateful command is delegated to the ManagerDo, which owns the durable
 * session registry and the per-thread agent DOs.
 *
 * Delivery semantics mirror bb's transport split: provider-route commands are
 * request/response (settled by the handleCommand promise); the journal owns
 * the `timeout` vocabulary, so the adapter's own budget race emits
 * `deadline_exceeded` — a distinct code for "the adapter gave up waiting".
 */

import type {
  AdapterCommand,
  AdapterCommandOutcome,
  AdapterModelListResult,
  ClassifyProviderExecutionSettingsChangeArgs,
  ProviderAdapter,
  ProviderExecutionSettingsChange,
} from "../../daemon-worker/src/provider-adapter.js";
import type {
  AvailableModel,
  ProviderCapabilities,
  RuntimeThreadExecutionOptions,
} from "../../daemon-worker/src/provider-types.js";
import { classifyHarnessProjection, projectHarness } from "./harness.js";
import type { ResolvedHarness } from "./harness.js";

/**
 * bb classification semantics (provider-adapter.ts:292-299, fake parity):
 * route-affecting execution settings ride the next turn (`live`); the
 * permission policy needs a rebuilt provider session (`session`). Module
 * function so every consumer shares the one vocabulary — the adapter
 * command face AND the #351 server bridge's thread-selection drift both
 * classify here.
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

/** The manager surface the adapter delegates to (a MANAGER binding stub). */
export interface ManagerFacade {
  handleAdapterCommand(command: AdapterCommand): Promise<AdapterCommandOutcome>;
}

export class EdgeAgentProviderAdapter implements ProviderAdapter {
  readonly id = "edge-agent";
  readonly displayName = "CAP edge agent (agent-do loop)";
  readonly approvalRequestPolicy = "runtime" as const;
  readonly capabilities: ProviderCapabilities;

  constructor(
    private readonly manager: ManagerFacade,
    private readonly harness: ResolvedHarness,
  ) {
    // A4: the image-input bit mirrors the harness relay verdict — the
    // adapter's capabilities and the relay's wire dispatch can never disagree.
    this.capabilities = {
      supportsArchive: true,
      supportsRename: true,
      supportsServiceTier: false,
      supportsUserQuestion: false,
      supportsFork: false,
      supportsImageInput: harness.relay.supportsImageInput,
      supportedPermissionModes: ["accept-edits", "auto", "full"],
    };
  }

  /**
   * Collapses accepted no-op values onto their effective setting: the M0
   * relay has no service-tier concept and ignores provider-only flags, so
   * they normalize away instead of registering as classification drift.
   */
  normalizeExecutionOptions(options: RuntimeThreadExecutionOptions): RuntimeThreadExecutionOptions {
    const {
      claudeCodePermissionMode: _permissionMode,
      claudeCodeMockCliTraffic: _mockTraffic,
      memoryEnabled: _memory,
      providerSubagentsEnabled: _subagents,
      ...effective
    } = options;
    return {
      ...effective,
      serviceTier: this.capabilities.supportsServiceTier ? options.serviceTier : "default",
    };
  }

  /**
   * Adapter-face delegate — the module classifier is the single vocabulary
   * (see classifyExecutionSettingsChange above).
   */
  classifyExecutionSettingsChange(
    args: ClassifyProviderExecutionSettingsChangeArgs,
  ): ProviderExecutionSettingsChange {
    return classifyExecutionSettingsChange(args.current, args.next);
  }

  /**
   * Provider-application extension of the same vocabulary over the harness
   * three keys: host binding and permission → `session`; relay and live
   * execution fields → `live`.
   */
  classifyHarnessChange(
    current: ResolvedHarness,
    next: ResolvedHarness,
  ): ProviderExecutionSettingsChange {
    return classifyHarnessProjection(projectHarness(current), projectHarness(next));
  }

  async handleCommand(
    command: AdapterCommand,
    options: { timeoutMs: number },
  ): Promise<AdapterCommandOutcome> {
    // State-free answers stay in the caller's context — no DO roundtrip.
    if (command.type === "initialize") {
      return {
        ok: true,
        result: {
          protocolVersion: 1,
          provider: this.id,
          relayMode: this.harness.relay.mode,
          machineId: this.harness.hostBinding.machineId,
        },
      };
    }
    if (command.type === "model/list") {
      const models: AvailableModel[] = [
        {
          id: "edge-agent-default",
          model: this.harness.relay.model,
          displayName: `Edge agent (${this.harness.relay.model})`,
          description:
            this.harness.relay.mode === "mock"
              ? "Fixed-reply mock (relay key not configured)"
              : this.harness.relay.api === "openai-responses"
                ? "OpenAI Responses-protocol relay model (#361 adaptor)"
                : this.harness.relay.api === "openai-completions"
                  ? "OpenAI Chat Completions-protocol relay model (#363 adaptor)"
                : "Anthropic-protocol relay model (GLM coding plan)",
          supportedReasoningEfforts: [
            {
              reasoningEffort: "none",
              description: "Deterministic budget (thinking disabled by default)",
            },
          ],
          defaultReasoningEffort: "none",
          isDefault: true,
        },
      ];
      return {
        ok: true,
        result: { models, selectedOnlyModels: [] } satisfies AdapterModelListResult,
      };
    }
    return this.withBudget(this.manager.handleAdapterCommand(command), options.timeoutMs);
  }

  /**
   * Budget envelope: settle within `timeoutMs` or answer `deadline_exceeded`
   * (the journal's `timeout` vocabulary is reserved for the journal itself).
   * A late manager settlement is discarded here and, if it ever surfaces,
   * rejected as stale by the journal.
   */
  private async withBudget(
    pending: Promise<AdapterCommandOutcome>,
    timeoutMs: number,
  ): Promise<AdapterCommandOutcome> {
    let timer: number | null = null;
    const expired = new Promise<AdapterCommandOutcome>((resolve) => {
      timer = setTimeout(() => {
        resolve({
          ok: false,
          errorCode: "deadline_exceeded",
          errorMessage: `provider command exceeded its ${timeoutMs}ms budget`,
          retryable: true,
        });
      }, timeoutMs);
    });
    try {
      return await Promise.race([pending, expired]);
    } finally {
      clearTimeout(timer);
    }
  }
}
