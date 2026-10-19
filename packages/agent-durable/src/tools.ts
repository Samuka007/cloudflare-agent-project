import type { Static, TSchema } from "@earendil-works/pi-ai";
import {
  defineTool,
  type ToolDiagnostic,
  type ToolExecutionApi,
  type ToolExecutionResult,
  type ToolRegistration,
} from "@earendil-works/pi-durable";

export const DEFAULT_HOST_TOOL_TIMEOUT_MS = 600_000;

export type HostToolStatus = "ok" | "error" | "timeout" | "cancelled" | "outcome_unknown";

/** The daemon-service dispatch frame, structurally (no @cap/agent-do import). */
export interface HostToolFrame {
  tool: string;
  arguments: Record<string, unknown>;
  executionId: string;
  machineId: string;
  threadId: string;
  turnId: string;
  timeoutMs: number;
  workspace?: { id: string; path: string };
}

export interface HostToolResultPayload {
  status: HostToolStatus;
  exitCode: number | null;
  output: string;
  outputTruncated?: boolean;
  errorCode?: string;
}

export type HostExecutionUpdate =
  | { kind: "started"; executionId: string; pid?: number }
  | { kind: "output"; executionId: string; offset: number; chunk: string }
  | { kind: "exited"; executionId: string; result: HostToolResultPayload };

export type HostDispatchOutcome =
  | { kind: "accepted" }
  | { kind: "completed_cached"; result: HostToolResultPayload }
  | { kind: "host_offline" };

export interface HostDispatchClient {
  dispatch(frame: HostToolFrame): Promise<HostDispatchOutcome>;
}

export interface HostToolTransport {
  dispatch(
    frame: HostToolFrame,
    onUpdate: (update: HostExecutionUpdate) => void,
  ): Promise<HostDispatchOutcome>;
}

/**
 * Routes daemon `onExecutionUpdate` frames to the waiting tool wrapper and
 * keeps the dispatch journal dedup key visible to the caller.
 */
export class HostToolDispatcher implements HostToolTransport {
  readonly #client: HostDispatchClient;
  readonly #listeners = new Map<string, (update: HostExecutionUpdate) => void>();

  constructor(client: HostDispatchClient) {
    this.#client = client;
  }

  async dispatch(
    frame: HostToolFrame,
    onUpdate: (update: HostExecutionUpdate) => void,
  ): Promise<HostDispatchOutcome> {
    this.#listeners.set(frame.executionId, onUpdate);
    let outcome: HostDispatchOutcome;
    try {
      outcome = await this.#client.dispatch(frame);
    } catch (error) {
      this.#listeners.delete(frame.executionId);
      throw error;
    }
    if (outcome.kind !== "accepted") this.#listeners.delete(frame.executionId);
    return outcome;
  }

  onUpdate(update: HostExecutionUpdate): void {
    const listener = this.#listeners.get(update.executionId);
    if (listener === undefined) return;
    listener(update);
    if (update.kind === "exited") this.#listeners.delete(update.executionId);
  }
}

export interface HostToolScope {
  machineId: string;
  threadId: string;
  turnId: string;
  workspace?: { id: string; path: string };
}

export interface HostToolSpec {
  name: string;
  description: string;
  parameters: TSchema;
  scope: HostToolScope;
  /** Read-only tools are safe to rerun; side-effecting tools are not (#579). */
  replay: "safe" | "unsafe";
  /** Cap's schedule class → pi executionMode (exclusive over-serializes conservatively). */
  schedule: "read" | "detached" | "exclusive";
  timeoutMs?: number;
  mapArguments?: (args: Record<string, unknown>) => Record<string, unknown>;
}

const HOST_OFFLINE_TEXT = "Tool not executed: the target host is offline.";

function hostOfflineResult(): HostToolResultPayload {
  return {
    status: "error",
    exitCode: null,
    output: HOST_OFFLINE_TEXT,
    errorCode: "host_offline",
  };
}

function mapResult(result: HostToolResultPayload): ToolExecutionResult {
  const isError = result.status !== "ok" || (result.exitCode !== null && result.exitCode !== 0);
  const diagnostics: ToolDiagnostic[] = [];
  if (result.outputTruncated === true) {
    diagnostics.push({
      severity: "warn",
      code: "truncated",
      message: "Output was truncated; the full output may be available as an artifact.",
    });
  }
  if (result.errorCode !== undefined) {
    diagnostics.push({
      severity: "error",
      code: result.errorCode,
      message: result.output.length === 0 ? result.errorCode : result.output,
    });
  }
  return {
    ...(result.output.length === 0
      ? {}
      : { output: [{ type: "text" as const, text: result.output }] }),
    details: {
      status: result.status,
      exitCode: result.exitCode,
      ...(result.outputTruncated === true ? { outputTruncated: true } : {}),
      ...(result.errorCode === undefined ? {} : { errorCode: result.errorCode }),
    },
    isError,
    ...(diagnostics.length === 0 ? {} : { diagnostics }),
  };
}

export function createHostTool(spec: HostToolSpec, transport: HostToolTransport): ToolRegistration {
  return defineTool({
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters,
    replay: spec.replay,
    executionMode: spec.schedule === "exclusive" ? "sequential" : "parallel",
    execute: async (args: Static<TSchema>, api: ToolExecutionApi) => {
      const executionId = `cap:${api.conversationId}:${api.taskId}`;
      const frame: HostToolFrame = {
        tool: spec.name,
        arguments:
          spec.mapArguments === undefined
            ? (args as Record<string, unknown>)
            : spec.mapArguments(args as Record<string, unknown>),
        executionId,
        machineId: spec.scope.machineId,
        threadId: spec.scope.threadId,
        turnId: spec.scope.turnId,
        timeoutMs: spec.timeoutMs ?? DEFAULT_HOST_TOOL_TIMEOUT_MS,
        ...(spec.scope.workspace === undefined ? {} : { workspace: spec.scope.workspace }),
      };

      const { promise, resolve, reject } = Promise.withResolvers<HostToolResultPayload>();
      let outcome: HostDispatchOutcome;
      try {
        outcome = await transport.dispatch(frame, (update) => {
          if (update.kind === "output") api.output(update.chunk);
          else if (update.kind === "exited") resolve(update.result);
        });
      } catch (error) {
        reject(error);
        return promise.then(mapResult);
      }
      if (outcome.kind === "completed_cached") resolve(outcome.result);
      else if (outcome.kind === "host_offline") resolve(hostOfflineResult());
      return promise.then(mapResult);
    },
  });
}
