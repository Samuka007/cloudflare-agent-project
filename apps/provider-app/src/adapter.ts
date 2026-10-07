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
  ProviderCapabilities,
  RuntimeThreadExecutionOptions,
} from "../../daemon-worker/src/provider-types.js";
import { CLOUD_PLACEHOLDER_HOST_ID } from "@cap/protocol";

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

  constructor(private readonly manager: ManagerFacade) {
    // #500: the deployment channel (and its MODEL_RELAY_IMAGE_INPUT
    // declaration) is deleted — the adapter declares no deployment-wide
    // image input; the per-row verdict (provider_configs `input`) rides the
    // relay config and the execution-options projection, the two faces the
    // wire dispatch and the picker actually read.
    this.capabilities = {
      supportsArchive: true,
      supportsRename: true,
      supportsServiceTier: false,
      supportsUserQuestion: false,
      supportsFork: false,
      supportsImageInput: false,
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
          // #377/#500: no channel relay mode exists; the host binding is the
          // cloud placeholder (no deployment machine is fabricated).
          machineId: CLOUD_PLACEHOLDER_HOST_ID,
        },
      };
    }
    if (command.type === "model/list") {
      // #500: the deployment channel is deleted — the face advertises
      // nothing rather than a synthesized row (the D1 catalog is the
      // selection 正本, #450; the picker consumes GET /system/execution-options).
      return {
        ok: true,
        result: { models: [], selectedOnlyModels: [] } satisfies AdapterModelListResult,
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
