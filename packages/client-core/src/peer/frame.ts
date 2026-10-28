// WIRE-CONTRACT-V5 §15.6: TCP framing, `u16be len ‖ Noise message`, len 1 to 65,535.

export const MAX_FRAME = 65535;

export function encodeFrame(noise: Uint8Array): Uint8Array {
  if (noise.length < 1 || noise.length > MAX_FRAME)
    throw new RangeError("frame length");
  const out = new Uint8Array(2 + noise.length);
  out[0] = noise.length >> 8;
  out[1] = noise.length & 0xff;
  out.set(noise, 2);
  return out;
}

export type FrameDecode =
  | { frames: Uint8Array[]; rest: Uint8Array }
  | { error: "peer_bad_frame" };

/** Cut a byte stream into frames; a trailing partial frame is `rest`. A zero length closes. */
export function decodeFrames(stream: Uint8Array): FrameDecode {
  const frames: Uint8Array[] = [];
  let i = 0;
  while (stream.length - i >= 2) {
    const len = (stream[i]! << 8) | stream[i + 1]!;
    if (len === 0) return { error: "peer_bad_frame" };
    if (stream.length - i - 2 < len) break;
    frames.push(stream.slice(i + 2, i + 2 + len));
    i += 2 + len;
  }
  return { frames, rest: stream.slice(i) };
}

/**
 * A stateful reader over a socket's chunks. Returns frames, or null after a zero length. One
 * growing buffer and an offset: every byte is copied in once and out once, so a peer that trickles
 * a frame one byte at a time costs linear work (`copied` counts the bytes moved, for the test).
 */
export class FrameReader {
  private buf = new Uint8Array(1024);
  private start = 0;
  private end = 0;
  copied = 0;

  push(chunk: Uint8Array): Uint8Array[] | null {
    if (this.end + chunk.length > this.buf.length) {
      const live = this.end - this.start;
      const need = live + chunk.length;
      let cap = this.buf.length;
      while (cap < need) cap *= 2;
      const next = cap === this.buf.length ? this.buf : new Uint8Array(cap);
      next.set(this.buf.subarray(this.start, this.end), 0);
      this.copied += live;
      this.buf = next;
      this.start = 0;
      this.end = live;
    }
    this.buf.set(chunk, this.end);
    this.end += chunk.length;
    this.copied += chunk.length;
    const frames: Uint8Array[] = [];
    while (this.end - this.start >= 2) {
      const len = (this.buf[this.start]! << 8) | this.buf[this.start + 1]!;
      if (len === 0) {
        this.start = this.end = 0;
        return null;
      }
      if (this.end - this.start - 2 < len) break;
      frames.push(this.buf.slice(this.start + 2, this.start + 2 + len));
      this.copied += len;
      this.start += 2 + len;
    }
    if (this.start === this.end) this.start = this.end = 0;
    return frames;
  }
}
