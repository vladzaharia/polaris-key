// The frame reader costs linear work however a peer splits the stream, and the record chain is
// bounded. Operations are counted, not timed, so machine load cannot flip the result.
import { describe, expect, it } from "vitest";
import {
  FrameReader,
  MAX_RECORD_BODY,
  RecordAssembler,
  encodeFrame,
  decodeRelay,
} from "../src/peer/index.js";

describe("FrameReader", () => {
  it("reads a frame trickled one byte at a time with linear copying", () => {
    const frame = encodeFrame(new Uint8Array(65535).fill(7));
    const r = new FrameReader();
    let got = 0;
    for (const b of frame) got += r.push(Uint8Array.of(b))!.length;
    expect(got).toBe(1);
    expect(r.copied).toBeLessThan(frame.length * 4);
  });

  it("returns null on a zero length", () => {
    expect(new FrameReader().push(Uint8Array.of(0, 0))).toBeNull();
  });
});

describe("RecordAssembler chains", () => {
  const ping = (flags: number, n: number) => ({
    type: 0x0100,
    flags,
    body: new Uint8Array(n),
  });
  it("refuses a chain over the record cap", () => {
    const a = new RecordAssembler("a");
    let last;
    let n = 0;
    do {
      last = a.push(ping(1, 0));
      n++;
    } while (last.kind === "pending" && n < 100);
    expect(last).toEqual({ kind: "close", code: "peer_bad_frame" });
    expect(n).toBe(19);
    expect(MAX_RECORD_BODY).toBe(65516);
  });
});

describe("relay RING epoch", () => {
  it("refuses an epoch above the safe integer range", () => {
    const b = new Uint8Array(9);
    b[0] = 0x83;
    b.set([0, 0x20, 0, 0, 0, 0, 0, 1], 1);
    expect(decodeRelay("toClient", b)).toBeNull();
  });
});
