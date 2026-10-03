/**
 * Minimal text/event-stream parser (Anthropic Message SSE). Yields one
 * message per blank-line-terminated block; multi-line `data:` fields join
 * with "\n" per the HTML SSE spec. Comment lines (`:` prefix) and unknown
 * fields are skipped. Byte-level work is incremental — nothing buffers the
 * whole stream, so first-token latency and abort propagation stay real.
 */

export interface SseMessage {
  /** `event:` field value, `"message"` when absent (spec default). */
  event: string;
  /** Joined `data:` payload. */
  data: string;
}

const DECODER = new TextDecoder();

export async function* parseSseStream(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<SseMessage> {
  const reader = stream.getReader();
  try {
    let buffer = "";
    let event = "message";
    const dataLines: string[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += DECODER.decode(value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (line === "") {
          if (dataLines.length > 0) {
            yield { event, data: dataLines.join("\n") };
          }
          event = "message";
          dataLines.length = 0;
        } else if (line.startsWith(":")) {
          // comment — ignored
        } else {
          const colon = line.indexOf(":");
          const field = colon === -1 ? line : line.slice(0, colon);
          const value_ = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
          if (field === "event") {
            event = value_;
          } else if (field === "data") {
            dataLines.push(value_);
          }
        }
        newline = buffer.indexOf("\n");
      }
    }
    // A trailing block without its blank terminator still dispatches — but a
    // truncated stream is the caller's signal to treat as a break (it checks
    // for `message_stop` itself).
    if (dataLines.length > 0) {
      yield { event, data: dataLines.join("\n") };
    }
  } finally {
    // Release the socket on early exit (abort, error, generator return).
    await reader.cancel().catch(() => undefined);
  }
}
