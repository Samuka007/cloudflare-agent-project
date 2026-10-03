import {
  ModelProviderError,
  type ModelProvider,
  type ModelRequest,
  type ModelStreamChunk,
} from "../provider.js";

/**
 * Deterministic mock model relay (test fixture — plain object, not Effect).
 * Each `streamTurn` call consumes the next script entry; the last entry
 * repeats. `calls` records every request for billing-conservation assertions
 * (I11: calls.length must equal `model.call_started` event count, always).
 */

export interface MockTurn {
  deltas?: string[];
  /** Terminal tool-calls chunk (complete calls only — §2.2). */
  toolCalls?: Array<{ name: string; arguments: Record<string, unknown> }>;
  /** Throw before any byte (retryable-class failure, §4.2.3). */
  failBeforeFirstByte?: { message: string; retryable?: boolean };
  /** Yield this many deltas, then throw a post-first-byte stream break. */
  failMidStreamAfter?: number;
  /** Accept the call but produce nothing until aborted (cap/seal tests). */
  hang?: boolean;
}

export class MockModelProvider implements ModelProvider {
  readonly calls: ModelRequest[] = [];
  private cursor = 0;

  constructor(public turns: MockTurn[]) {}

  async *streamTurn(
    request: ModelRequest,
    options: { signal: AbortSignal },
  ): AsyncIterable<ModelStreamChunk> {
    this.calls.push(request);
    const turn = this.turns[Math.min(this.cursor, this.turns.length - 1)];
    this.cursor += 1;
    if (turn === undefined) return;
    if (turn.failBeforeFirstByte !== undefined) {
      throw new ModelProviderError({
        message: turn.failBeforeFirstByte.message,
        retryable: turn.failBeforeFirstByte.retryable ?? true,
        afterFirstByte: false,
      });
    }
    const deltas = turn.deltas ?? [];
    for (let i = 0; i < deltas.length; i++) {
      const delta = deltas[i];
      if (delta === undefined) continue;
      if (options.signal.aborted) {
        throw new ModelProviderError({
          message: "aborted",
          retryable: false,
          afterFirstByte: true,
        });
      }
      yield { kind: "text-delta", text: delta };
      if (turn.failMidStreamAfter !== undefined && i + 1 >= turn.failMidStreamAfter) {
        throw new ModelProviderError({
          message: "stream broken mid-call",
          retryable: false,
          afterFirstByte: true,
        });
      }
    }
    if (turn.hang === true) {
      await new Promise<never>((_resolve, reject) => {
        if (options.signal.aborted) {
          reject(
            new ModelProviderError({
              message: "aborted",
              retryable: false,
              afterFirstByte: deltas.length > 0,
            }),
          );
          return;
        }
        options.signal.addEventListener(
          "abort",
          () => {
            reject(
              new ModelProviderError({
                message: "aborted",
                retryable: false,
                afterFirstByte: deltas.length > 0,
              }),
            );
          },
          { once: true },
        );
      });
    }
    if (turn.toolCalls !== undefined && turn.toolCalls.length > 0) {
      yield { kind: "tool-calls", toolCalls: turn.toolCalls };
    }
  }

  /** Total call attempts — the billing probe for I11. */
  callCount(): number {
    return this.calls.length;
  }
}
