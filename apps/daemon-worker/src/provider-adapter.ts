/**
 * AdapterCommand / ProviderAdapter — the daemon ⇄ provider seam (#27).
 *
 * Command shapes ported verbatim from bb
 * `packages/agent-runtime/src/provider-adapter.ts:111-230` @ 8473d8c33.
 * The ProviderAdapter contract keeps bb's identity/classification surface
 * (`:272-300`) and replaces the child_process half (`process` spawn descriptor
 * + stdio JSON-RPC bridge) with in-process typed delivery (`handleCommand`) —
 * the port ruling: the daemon's spawn half is substituted by the worker-side
 * provider application (#28), never ported.
 *
 * Delivery semantics per command mirror bb's transport split: provider-route
 * commands are request/response (settled by the handleCommand promise);
 * machine-route commands are settled asynchronously via the command journal
 * (`settleCommand`) after the dispatcher accepts them.
 */

import type {
  AgentRuntimeSkillRoot,
  AvailableModel,
  ClaudeCodeMockCliTrafficConfig,
  ClientTurnRequestId,
  DynamicTool,
  InstructionMode,
  OmpSessionRecoveryDescriptor,
  PromptInput,
  ProviderCapabilities,
  ReasoningLevel,
  RuntimePermissionPolicy,
  RuntimeThreadExecutionOptions,
  ServiceTier,
} from "./provider-types.js";

/** bb ProviderExecutionContext (provider-adapter.ts:115-132). */
export type ProviderExecutionContext = {
  model?: string;
  serviceTier?: ServiceTier;
  reasoningLevel?: ReasoningLevel;
  claudeCodePermissionMode?: "plan";
  claudeCodeMockCliTraffic: ClaudeCodeMockCliTrafficConfig;
  /**
   * Server-owned workflows policy. Passed through required end-to-end;
   * providers without the concept receive (and ignore) an explicit false.
   */
  workflowsEnabled: boolean;
  memoryEnabled?: boolean;
  providerSubagentsEnabled?: boolean;
  instructions?: string;
  envVars?: Record<string, string>;
  skillRoots?: readonly AgentRuntimeSkillRoot[];
} & RuntimePermissionPolicy;

/**
 * bb AdapterCommand (provider-adapter.ts:134-230) — verbatim variants. The
 * `thread/stop` `activeTurnId` split matters: non-null means the stop
 * interrupted an active provider turn (adapters may treat the session as
 * poisoned for resume); null means an idle stop and must not invalidate the
 * session.
 */
export type AdapterCommand =
  | { type: "initialize" }
  | {
      type: "skills/configure";
      skillRoots: readonly AgentRuntimeSkillRoot[];
    }
  | { type: "model/list"; cwd?: string }
  | {
      type: "thread/start";
      threadId: string;
      cwd: string;
      input?: PromptInput[];
      options: ProviderExecutionContext;
      dynamicTools?: DynamicTool[];
      disallowedTools?: readonly string[];
      instructionMode: InstructionMode;
    }
  | {
      type: "thread/resume";
      threadId: string;
      cwd: string;
      providerThreadId: string;
      /** Required by providers whose native identity cannot rebuild a session. */
      ompRecovery?: OmpSessionRecoveryDescriptor;
      options: ProviderExecutionContext;
      dynamicTools?: DynamicTool[];
      disallowedTools?: readonly string[];
      instructionMode: InstructionMode;
    }
  | {
      type: "thread/fork";
      threadId: string;
      cwd: string;
      sourceProviderThreadId: string;
      sourceProviderCheckpointId?: string;
      options: ProviderExecutionContext;
      dynamicTools?: DynamicTool[];
      disallowedTools?: readonly string[];
      instructionMode: InstructionMode;
    }
  | {
      type: "turn/start";
      threadId: string;
      providerThreadId: string;
      input: PromptInput[];
      inputGroups?: PromptInput[][];
      clientRequestId: ClientTurnRequestId;
      options: ProviderExecutionContext;
    }
  | {
      type: "turn/steer";
      threadId: string;
      providerThreadId: string;
      expectedTurnId: string;
      input: PromptInput[];
      inputGroups?: PromptInput[][];
      clientRequestId: ClientTurnRequestId;
      options: ProviderExecutionContext;
    }
  | {
      type: "thread/stop";
      threadId: string;
      providerThreadId: string;
      activeTurnId: string | null;
    }
  | { type: "thread/discard"; threadId: string; providerThreadId: string }
  | { type: "thread/goal/clear"; threadId: string; providerThreadId: string }
  | {
      type: "thread/name/set";
      threadId: string;
      providerThreadId: string;
      title: string;
    }
  | { type: "thread/archive"; threadId: string; providerThreadId: string }
  | { type: "thread/unarchive"; threadId: string; providerThreadId: string };

export type TurnStartAdapterCommand = Extract<
  AdapterCommand,
  { type: "turn/start" }
>;

/** bb parseModelListResult projection for `model/list` outcomes. */
export interface AdapterModelListResult {
  models: AvailableModel[];
  selectedOnlyModels: AvailableModel[];
}

/** All AdapterCommand discriminants — exhaustiveness aid for FSM switches. */
export const ADAPTER_COMMAND_TYPES = [
  "initialize",
  "skills/configure",
  "model/list",
  "thread/start",
  "thread/resume",
  "thread/fork",
  "turn/start",
  "turn/steer",
  "thread/stop",
  "thread/discard",
  "thread/goal/clear",
  "thread/name/set",
  "thread/archive",
  "thread/unarchive",
] as const;
export type AdapterCommandType = (typeof ADAPTER_COMMAND_TYPES)[number];

/** JSON-serializable outcome payload carried in the command journal. */
export type AdapterCommandResultValue =
  | string
  | number
  | boolean
  | null
  | AdapterCommandResultValue[]
  | { [key: string]: AdapterCommandResultValue | undefined };

/**
 * bb flattenPromptInputGroups (provider-adapter.ts:237-249) — ported verbatim
 * for providers that flatten grouped input.
 */
export function flattenPromptInputGroups(
  input: PromptInput[],
  inputGroups: PromptInput[][] | undefined,
): PromptInput[] {
  if (inputGroups === undefined) {
    return input;
  }
  return inputGroups.flatMap((group, index) =>
    index === 0
      ? group
      : [
          { type: "text" as const, text: "\n\n", mentions: [] },
          ...group,
        ],
  );
}

// ---------------------------------------------------------------------------
// Outcome + adapter contract.
// ---------------------------------------------------------------------------

export type AdapterCommandOutcome =
  | { ok: true; result: AdapterCommandResultValue }
  | {
      ok: false;
      /** bb error envelope vocabulary; `timeout` is set by the journal, not here. */
      errorCode: string;
      errorMessage: string;
      retryable?: boolean;
    };

export type ProviderExecutionSettingsChange = "unchanged" | "live" | "session";

export interface ClassifyProviderExecutionSettingsChangeArgs {
  current: RuntimeThreadExecutionOptions;
  next: RuntimeThreadExecutionOptions;
}

/**
 * The in-process extension contract (#28 implements this; the fake provider in
 * `src/testing/fake-provider.ts` is the deterministic reference). bb fields
 * kept verbatim; bb's `process` spawn descriptor and translation hooks
 * (`translateEvent`, `buildCommandPlan`, …) are intentionally absent — the
 * spawn half is replaced by this delivery seam and event translation belongs
 * to the provider application. `model/list` results are `{models: AvailableModel[]}`.
 */
export interface ProviderAdapter {
  id: string;
  displayName: string;
  capabilities: ProviderCapabilities;
  /**
   * Where approval escalation is enforced: `runtime` adapters emit every
   * request for the runtime's thread policy; `provider` adapters enforce the
   * policy before forwarding (a forwarded approval already requires input).
   */
  approvalRequestPolicy: "runtime" | "provider";
  /** Collapses accepted no-op values onto their effective setting. */
  normalizeExecutionOptions?(
    options: RuntimeThreadExecutionOptions,
  ): RuntimeThreadExecutionOptions;
  /**
   * `live` settings ride the next turn command; `session` settings require
   * rebuilding the provider session (bb provider-adapter.ts:292-299).
   */
  classifyExecutionSettingsChange(
    args: ClassifyProviderExecutionSettingsChangeArgs,
  ): ProviderExecutionSettingsChange;
  /**
   * Typed in-process JSON-RPC-style delivery. Implementations must settle
   * within the given budget or the journal expires the attempt; late
   * settlements are rejected as stale.
   */
  handleCommand(
    command: AdapterCommand,
    options: { timeoutMs: number },
  ): Promise<AdapterCommandOutcome>;
}
