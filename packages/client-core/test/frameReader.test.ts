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

describe("RecordAssembler chains in modes v and p", () => {
  const more = (n: number) => ({
    type: 0x8014,
    flags: 1,
    body: new Uint8Array(n),
  });
  it.each(["v", "p"] as const)(
    "closes an open MORE chain over 16 KiB in mode %s",
    (mode) => {
      const a = new RecordAssembler(mode);
      expect(a.push(more(8192))).toEqual({ kind: "pending" });
      expect(a.push(more(8192))).toEqual({ kind: "pending" });
      expect(a.push(more(1))).toEqual({
        kind: "close",
        code: "peer_bad_frame",
      });
    },
  );
  it("closes a first MORE record over 16 KiB, and takes a 16 KiB chain", () => {
    expect(new RecordAssembler("v").push(more(16385))).toEqual({
      kind: "close",
      code: "peer_bad_frame",
    });
    const a = new RecordAssembler("v");
    expect(a.push(more(16384))).toEqual({ kind: "pending" });
    expect(
      a.push({ type: 0x8014, flags: 0, body: new Uint8Array(0) }).kind,
    ).toBe("message");
  });
  it("leaves mode a to the 1 MiB message cap", () => {
    const a = new RecordAssembler("a");
    const part = { type: 0x0100, flags: 1, body: new Uint8Array(20_000) };
    expect(a.push(part)).toEqual({ kind: "pending" });
    expect(a.push(part)).toEqual({ kind: "pending" });
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
