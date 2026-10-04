import { CLIENT_RING_BUFFER_BYTES, OUTPUT_CHUNK_BYTES } from "../constants.js";

/**
 * Per-execution output buffer (§8.1/§8.3): the retransmit source. Byte
 * offsets are absolute in the merged stream; the ring evicts from the front
 * at 1MiB (declared via output_gap on the next resume — never silently);
 * the trim point never exceeds the service's ackedOffset (I25) and nothing
 * at all is dropped before exec.forget (I27).
 */
export class ExecutionBuffer {
  private bytes = Buffer.alloc(0);
  /** Absolute offset of bytes[0] (ring start; grows on eviction). */
  private baseOffset = 0;
  /** Absolute offset one past the last appended byte. */
  private endOffset = 0;
  /** Absolute offset one past the last byte handed to the WS. */
  private sentOffset = 0;
  /** True once the ring evicted anything (a gap marker is owed on resume). */
  evicted = false;
  /** Set when the process exited; carries closure for ended re-reports. */
  exited: { exitCode: number | null; signal: string | null; finalOffset: number } | null = null;

  append(text: string): void {
    const chunk = Buffer.from(text, "utf8");
    this.bytes = Buffer.concat([this.bytes, chunk]);
    this.endOffset += chunk.length;
    const overflow = this.bytes.length - CLIENT_RING_BUFFER_BYTES;
    if (overflow > 0) {
      this.bytes = this.bytes.subarray(overflow);
      this.baseOffset += overflow;
      this.evicted = true;
    }
  }

  get end(): number {
    return this.endOffset;
  }

  get bufferedFrom(): number {
    return this.baseOffset;
  }

  get sent(): number {
    return this.sentOffset;
  }

  /**
   * Trim behind the ack (I25): the trim point can never exceed what the
   * service actually acked; when the service's journal frontier is ahead of
   * our sent mark (dedup window collapse after resume), the sent mark jumps.
   */
  trimTo(ackedOffset: number): void {
    const clamped = Math.min(ackedOffset, this.endOffset);
    const cut = clamped - this.baseOffset;
    if (cut <= 0) return;
    this.sentOffset = Math.max(this.sentOffset, clamped);
    this.bytes = this.bytes.subarray(cut);
    this.baseOffset += cut;
  }

  /**
   * Slices ≤256KiB whole frames starting at `fromOffset`; null entries are
   * never produced — a requested range below the ring base is the caller's
   * output_gap obligation (§8.3).
   */
  sliceFrames(fromOffset: number): { offset: number; base64: string; byteLength: number }[] {
    const start = Math.max(fromOffset, this.baseOffset);
    const frames: { offset: number; base64: string; byteLength: number }[] = [];
    let cursor = start;
    while (cursor < this.endOffset && frames.length < 4096) {
      const take = Math.min(OUTPUT_CHUNK_BYTES, this.endOffset - cursor);
      const slice = this.bytes.subarray(cursor - this.baseOffset, cursor - this.baseOffset + take);
      frames.push({ offset: cursor, base64: slice.toString("base64"), byteLength: take });
      cursor += take;
    }
    return frames;
  }

  markSent(byteLength: number): void {
    this.sentOffset += byteLength;
  }
}
