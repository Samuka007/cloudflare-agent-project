/**
 * Deterministic in-process provider (test fixture — plain TS). Implements the
 * full AdapterCommand seam with real session-registry semantics so the
 * dispatch + audit tests exercise actual behavior, not echo stubs. The real
 * provider application is #28; this class is also its shape reference.
 *
 * Determinism: ids are counters, model catalog is fixed, failure/hang modes
 * are opted in per command type by the test.
 */

import type {
  AdapterCommand,
  AdapterCommandOutcome,
  AdapterModelListResult,
  ClassifyProviderExecutionSettingsChangeArgs,
  ProviderExecutionContext,
  ProviderAdapter,
  ProviderExecutionSettingsChange,
} from "../provider-adapter.js";
import type {
  AvailableModel,
  ProviderCapabilities,
  RuntimeThreadExecutionOptions,
} from "../provider-types.js";
import type {
  MachineCommandDispatchOutcome,
  MachineCommandDispatchRequest,
} from "../seam/machine-dispatch.js";

interface FakeProviderThread {
  threadId: string;
  providerThreadId: string;
  cwd: string;
  ompRecovery: { sessionId: string; sessionFile: string };
  activeTurnClientRequestId: string | null;
  poisoned: boolean;
  title: string | null;
  archived: boolean;
  steers: Array<{ expectedTurnId: string; clientRequestId: string }>;
}

export class FakeProviderAdapter implements ProviderAdapter {
  readonly id = "fake-omp";
  readonly displayName = "Fake provider (deterministic)";
  readonly approvalRequestPolicy = "runtime" as const;
  readonly capabilities: ProviderCapabilities = {
    supportsArchive: true,
    supportsRename: true,
    supportsServiceTier: true,
    supportsUserQuestion: true,
    supportsFork: true,
    supportedPermissionModes: ["accept-edits", "auto", "full"],
  };

  /** Every command seen, in dispatch order — the assertion surface. */
  readonly commands: AdapterCommand[] = [];
  /** Command types whose handleCommand never settles (journal timeout path). */
  readonly hangCommandTypes = new Set<string>();
  /** Command types answered with a deterministic failure. */
  readonly failCommandTypes = new Set<string>();
  /**
   * `releaseHangs()` flips this; the hung `handleCommand` polls it from the
   * DO context it is executing in. A deferred resolved directly from the
   * runner would cross the workerd per-DO I/O boundary ("Cannot perform I/O
   * on behalf of a different Durable Object").
   */
  private releaseRequested = false;

  private providerThreadCounter = 0;
  private readonly threadsByProviderId = new Map<string, FakeProviderThread>();

  private readonly models: AvailableModel[] = [
    {
      id: "fake-model-default",
      model: "fake-default",
      displayName: "Fake Default",
      description: "Deterministic default model",
      supportedReasoningEfforts: [
        { reasoningEffort: "low", description: "Fast" },
        { reasoningEffort: "high", description: "Thorough" },
      ],
      defaultReasoningEffort: "low",
      isDefault: true,
    },
  ];

  /**
   * bb classification shape: route-affecting settings (model/serviceTier/
   * reasoningLevel) ride the next turn (`live`); permission policy needs a
   * rebuilt session (`session`); otherwise unchanged.
   */
  classifyExecutionSettingsChange(
    args: ClassifyProviderExecutionSettingsChangeArgs,
  ): ProviderExecutionSettingsChange {
    const { current, next } = args;
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

  async handleCommand(
    command: AdapterCommand,
    options: { timeoutMs: number },
  ): Promise<AdapterCommandOutcome> {
    void options;
    this.commands.push(command);
    if (this.hangCommandTypes.has(command.type)) {
      return this.hangUntilReleased();
    }
    if (this.failCommandTypes.has(command.type)) {
      return {
        ok: false,
        errorCode: "fake_failure",
        errorMessage: `deterministic failure for ${command.type}`,
        retryable: false,
      };
    }
    switch (command.type) {
      case "initialize":
        return { ok: true, result: { protocolVersion: 1, provider: this.id } };
      case "skills/configure":
        return {
          ok: true,
          result: { configuredRoots: command.skillRoots.length },
        };
      case "model/list":
        return {
          ok: true,
          result: {
            models: this.models,
            selectedOnlyModels: [],
          } satisfies AdapterModelListResult,
        };
      case "thread/start":
        return this.startThread(command);
      case "thread/resume":
        return this.resumeThread(command);
      case "thread/fork":
        return this.forkThread(command);
      case "turn/start":
        return this.startTurn(command);
      case "turn/steer":
        return this.steerTurn(command);
      case "thread/stop":
        return this.stopThread(command);
      case "thread/discard":
        return this.discardThread(command.providerThreadId);
      case "thread/goal/clear":
        return this.requireThread(command.providerThreadId, () => ({
          ok: true,
          result: { cleared: true },
        }));
      case "thread/name/set": {
        const thread = this.threadsByProviderId.get(command.providerThreadId);
        if (thread === undefined) {
          return this.threadNotFound(command.providerThreadId);
        }
        thread.title = command.title;
        return { ok: true, result: { title: command.title } };
      }
      case "thread/archive":
      case "thread/unarchive": {
        const thread = this.threadsByProviderId.get(command.providerThreadId);
        if (thread === undefined) {
          return this.threadNotFound(command.providerThreadId);
        }
        thread.archived = command.type === "thread/archive";
        return { ok: true, result: { archived: thread.archived } };
      }
    }
  }

  // -- assertions helpers ---------------------------------------------------

  providerThreadIds(): string[] {
    return [...this.threadsByProviderId.keys()];
  }

  /** Release every hung command with a deterministic late outcome. */
  releaseHangs(): void {
    this.releaseRequested = true;
  }

  private async hangUntilReleased(): Promise<AdapterCommandOutcome> {
    while (!this.releaseRequested) {
      await delay(5);
    }
    return { ok: true, result: { releasedLate: true } };
  }

  thread(providerThreadId: string): FakeProviderThread | undefined {
    return this.threadsByProviderId.get(providerThreadId);
  }

  // -- command bodies ---------------------------------------------------------

  private threadNotFound(providerThreadId: string): AdapterCommandOutcome {
    return {
      ok: false,
      errorCode: "thread_not_found",
      errorMessage: `unknown provider thread ${providerThreadId}`,
      retryable: false,
    };
  }

  private requireThread(
    providerThreadId: string,
    body: () => AdapterCommandOutcome,
  ): AdapterCommandOutcome {
    const thread = this.threadsByProviderId.get(providerThreadId);
    if (thread === undefined) {
      return this.threadNotFound(providerThreadId);
    }
    return body();
  }

  private startThread(command: Extract<AdapterCommand, { type: "thread/start" }>): AdapterCommandOutcome {
    this.providerThreadCounter += 1;
    const providerThreadId = `pthr_${this.providerThreadCounter}`;
    const ompRecovery = {
      sessionId: providerThreadId,
      sessionFile: `/sessions/${providerThreadId}.jsonl`,
    };
    this.threadsByProviderId.set(providerThreadId, {
      threadId: command.threadId,
      providerThreadId,
      cwd: command.cwd,
      ompRecovery,
      activeTurnClientRequestId: null,
      poisoned: false,
      title: null,
      archived: false,
      steers: [],
    });
    return {
      ok: true,
      result: { threadId: command.threadId, providerThreadId, sessionRestorable: true },
    };
  }

  private resumeThread(command: Extract<AdapterCommand, { type: "thread/resume" }>): AdapterCommandOutcome {
    const thread = this.threadsByProviderId.get(command.providerThreadId);
    if (thread === undefined) {
      return this.threadNotFound(command.providerThreadId);
    }
    if (thread.poisoned && command.ompRecovery === undefined) {
      return {
        ok: false,
        errorCode: "session_recovery_required",
        errorMessage: "poisoned session requires ompRecovery descriptor",
        retryable: false,
      };
    }
    return {
      ok: true,
      result: {
        threadId: command.threadId,
        providerThreadId: thread.providerThreadId,
        ompRecovery: command.ompRecovery ?? thread.ompRecovery,
      },
    };
  }

  private forkThread(command: Extract<AdapterCommand, { type: "thread/fork" }>): AdapterCommandOutcome {
    const source = this.threadsByProviderId.get(command.sourceProviderThreadId);
    if (source === undefined) {
      return this.threadNotFound(command.sourceProviderThreadId);
    }
    this.providerThreadCounter += 1;
    const providerThreadId = `pthr_${this.providerThreadCounter}`;
    this.threadsByProviderId.set(providerThreadId, {
      ...source,
      threadId: command.threadId,
      providerThreadId,
      ompRecovery: {
        sessionId: providerThreadId,
        sessionFile: `/sessions/${providerThreadId}.jsonl`,
      },
      activeTurnClientRequestId: null,
      steers: [],
    });
    return {
      ok: true,
      result: {
        threadId: command.threadId,
        providerThreadId,
        forkedFrom: command.sourceProviderThreadId,
      },
    };
  }

  private startTurn(command: Extract<AdapterCommand, { type: "turn/start" }>): AdapterCommandOutcome {
    const thread = this.threadsByProviderId.get(command.providerThreadId);
    if (thread === undefined) {
      return this.threadNotFound(command.providerThreadId);
    }
    if (thread.activeTurnClientRequestId !== null) {
      return {
        ok: false,
        errorCode: "turn_already_active",
        errorMessage: `turn ${thread.activeTurnClientRequestId} still active`,
        retryable: false,
      };
    }
    thread.activeTurnClientRequestId = command.clientRequestId;
    return {
      ok: true,
      result: { turnId: command.clientRequestId, agentInvoked: true },
    };
  }

  private steerTurn(command: Extract<AdapterCommand, { type: "turn/steer" }>): AdapterCommandOutcome {
    const thread = this.threadsByProviderId.get(command.providerThreadId);
    if (thread === undefined) {
      return this.threadNotFound(command.providerThreadId);
    }
    if (thread.activeTurnClientRequestId !== command.expectedTurnId) {
      return {
        ok: false,
        errorCode: "steer_no_active_turn",
        errorMessage: `expected active turn ${command.expectedTurnId}`,
        retryable: false,
      };
    }
    thread.steers.push({
      expectedTurnId: command.expectedTurnId,
      clientRequestId: command.clientRequestId,
    });
    return { ok: true, result: { steered: true } };
  }

  private stopThread(command: Extract<AdapterCommand, { type: "thread/stop" }>): AdapterCommandOutcome {
    const thread = this.threadsByProviderId.get(command.providerThreadId);
    if (thread === undefined) {
      return this.threadNotFound(command.providerThreadId);
    }
    const interrupted = command.activeTurnId !== null;
    if (interrupted) {
      // bb contract: an interrupted provider turn poisons the session for
      // future resume without a recovery descriptor.
      thread.poisoned = true;
      thread.activeTurnClientRequestId = null;
    }
    return { ok: true, result: { stopped: true, interrupted } };
  }

  private discardThread(providerThreadId: string): AdapterCommandOutcome {
    const thread = this.threadsByProviderId.get(providerThreadId);
    if (thread === undefined) {
      return this.threadNotFound(providerThreadId);
    }
    this.threadsByProviderId.delete(providerThreadId);
    return { ok: true, result: { discarded: true } };
  }
}

/**
 * Deterministic machine dispatcher (#30/#34 stand-in). Queue outcomes per
 * dispatch; default `accepted` mirrors the at-least-once journal semantics.
 */
export class FakeMachineDispatcher {
  readonly requests: MachineCommandDispatchRequest[] = [];
  private readonly outcomes: MachineCommandDispatchOutcome[] = [];

  queueOutcome(outcome: MachineCommandDispatchOutcome): void {
    this.outcomes.push(outcome);
  }

  async dispatch(
    request: MachineCommandDispatchRequest,
  ): Promise<MachineCommandDispatchOutcome> {
    this.requests.push(request);
    return this.outcomes.shift() ?? { kind: "accepted" };
  }
}

/**
 * bb-shaped execution options builder for tests — full permission policy
 * required by ProviderExecutionContext, so tests share one lockstep factory.
 */
export function fakeExecutionOptions(
  overrides?: Partial<Pick<RuntimeThreadExecutionOptions, "model" | "reasoningLevel" | "serviceTier">> & {
    permissionMode?: RuntimeThreadExecutionOptions["permissionMode"];
  },
): RuntimeThreadExecutionOptions {
  const permissionMode = overrides?.permissionMode ?? "accept-edits";
  const base = {
    model: overrides?.model ?? "fake-default",
    serviceTier: overrides?.serviceTier ?? ("default" as const),
    reasoningLevel: overrides?.reasoningLevel ?? ("low" as const),
    workflowsEnabled: false,
  };
  if (permissionMode === "full") {
    return {
      ...base,
      permissionMode: "full",
      permissionScope: "full",
      approvalReviewer: null,
      permissionEscalation: null,
    };
  }
  if (permissionMode === "auto") {
    return {
      ...base,
      permissionMode: "auto",
      permissionScope: "workspace",
      approvalReviewer: "automatic",
      permissionEscalation: "ask",
    };
  }
  return {
    ...base,
    permissionMode,
    permissionScope: "workspace",
    approvalReviewer: "user",
    permissionEscalation: "ask",
  };
}

/**
 * bb's runtime fills `claudeCodeMockCliTraffic` (required in
 * ProviderExecutionContext, optional in RuntimeThreadExecutionOptions) from
 * app settings before dispatch (execution-options.ts:180) — the fake does the
 * same fill with the bb default config.
 */
export function fakeExecutionContext(
  options: RuntimeThreadExecutionOptions,
): ProviderExecutionContext {
  return {
    ...options,
    claudeCodeMockCliTraffic: { enabled: false, endpoint: "https://api.anthropic.com" },
  };
}

function delay(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

