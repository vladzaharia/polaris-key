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

/** A stateful reader over a socket's chunks. Returns frames, or null after a zero length. */
export class FrameReader {
  private buf: Uint8Array = new Uint8Array(0);
  push(chunk: Uint8Array): Uint8Array[] | null {
    const joined = new Uint8Array(this.buf.length + chunk.length);
    joined.set(this.buf);
    joined.set(chunk, this.buf.length);
    const d = decodeFrames(joined);
    if ("error" in d) {
      this.buf = new Uint8Array(0);
      return null;
    }
    this.buf = d.rest;
    return d.frames;
  }
}
