/**
 * P4-27: `rsccBody`'s bounds beyond the shared fixtures (godotFixtures.test.ts holds the verdict
 * lines): the decoder sees only structurally whole frames, always with the block's exact size as
 * its output bound, and the real engine-written imports decode to resource bodies.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  RSCC_MAX_TOTAL,
  RSCC_PACK_BUDGET,
  rsccBody,
  rsccBodyIsResource,
  zstdFrameOk,
} from "../src/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const real = (dir: string, name: string) =>
  new Uint8Array(readFileSync(path.join(here, "fixtures", dir, name)));
const TRI = real(
  "godot-real-imports",
  "tri.glb-6ed0665643de460f848bf1abf5ed7ae0.scn",
);
const GRIDS = [
  real("godot-real-imports", "grid.glb-9b02adf25d7711b0ef870695e4d4a20b.scn"),
  real(
    "godot-real-imports-4.4.1",
    "grid.glb-9b02adf25d7711b0ef870695e4d4a20b.scn",
  ),
];

describe("rsccBody (P4-27)", () => {
  it("decodes the real 4.7.2 and 4.4.1 imports to binary resource bodies", () => {
    for (const f of [TRI, ...GRIDS]) {
      const r = rsccBody(f);
      if ("why" in r) throw new Error(r.why);
      expect(r.body.length).toBe(new DataView(f.buffer).getUint32(12, true));
      expect(rsccBodyIsResource(r.body)).toBe(true);
    }
  });

  it("hands the decoder each block with exactly its size, and nothing malformed", () => {
    const calls: number[] = [];
    const r = rsccBody(TRI, (frame, size) => {
      calls.push(size);
      return new Uint8Array(size);
    });
    expect("body" in r).toBe(true);
    expect(calls).toEqual([4096, 4347 - 4096]);

    const bad = TRI.slice();
    bad[24] = 0; // block 0's frame magic
    let called = false;
    const r2 = rsccBody(bad, (_f, size) => {
      called = true;
      return new Uint8Array(size);
    });
    expect(r2).toEqual({
      why: "whose block 0 is not one zstd frame of 4096 bytes",
    });
    expect(called).toBe(false);
  });

  it("refuses a decoder result of another length, and a decoder that throws", () => {
    expect(rsccBody(TRI, (_f, size) => new Uint8Array(size - 1))).toEqual({
      why: "whose block 0 does not decode to 4096 bytes",
    });
    expect(
      rsccBody(TRI, () => {
        throw new Error("corrupt");
      }),
    ).toEqual({ why: "whose block 0 does not decode to 4096 bytes" });
  });

  it("bounds the total before reading the table", () => {
    const h = new Uint8Array(16);
    h.set(new TextEncoder().encode("RSCC"));
    const dv = new DataView(h.buffer);
    dv.setUint32(4, 2, true);
    dv.setUint32(8, 4096, true);
    dv.setUint32(12, RSCC_MAX_TOTAL, true);
    expect(rsccBody(h)).toEqual({
      why: "whose block table runs past the end",
    });
    // The pack budget counts the declared total before the table is read.
    const budget = { used: RSCC_PACK_BUDGET - RSCC_MAX_TOTAL + 1 };
    expect(rsccBody(h, undefined, budget)).toEqual({
      why: `that takes the pack's declared RSCC bytes to ${RSCC_PACK_BUDGET + 1}, past the ${RSCC_PACK_BUDGET}-byte budget`,
    });
    dv.setUint32(12, RSCC_MAX_TOTAL + 1, true);
    expect(rsccBody(h)).toEqual({
      why: `that declares ${RSCC_MAX_TOTAL + 1} bytes, above the ${RSCC_MAX_TOTAL}-byte cap`,
    });
  });

  it("reads the frame header's content size in every width", () => {
    const frame = (fhd: number, fcs: number[], blocks: number[]) =>
      new Uint8Array([0x28, 0xb5, 0x2f, 0xfd, fhd, ...fcs, ...blocks]);
    // 1 byte (single segment), 2 bytes (+256), 4 bytes, 8 bytes; an RLE block of 5.
    const rle5 = [0x2b, 0x00, 0x00, 0x41];
    expect(zstdFrameOk(frame(0x20, [5], rle5), 5)).toBe(true);
    // 2 bytes, +256: structure only (an empty raw block; the decoder would refuse the length).
    expect(zstdFrameOk(frame(0x60, [0xff, 0xff], [0x01, 0, 0]), 65791)).toBe(
      true,
    );
    expect(zstdFrameOk(frame(0x60, [0xff, 0xff], [0x01, 0, 0]), 65535)).toBe(
      false,
    );
    expect(zstdFrameOk(frame(0xa0, [5, 0, 0, 0], rle5), 5)).toBe(true);
    expect(zstdFrameOk(frame(0xe0, [5, 0, 0, 0, 0, 0, 0, 0], rle5), 5)).toBe(
      true,
    );
    expect(zstdFrameOk(frame(0xe0, [5, 0, 0, 0, 1, 0, 0, 0], rle5), 5)).toBe(
      false,
    );
    // A window descriptor (not single segment) is refused (P4-27 audit GAP 1a).
    expect(zstdFrameOk(frame(0x80, [0x00, 5, 0, 0, 0], rle5), 5)).toBe(false);
    // No block may declare more than the frame's size or 128 KiB (GAP 1b).
    expect(zstdFrameOk(frame(0x20, [4], rle5), 4)).toBe(false);
    const rle128k1 = [0x0b, 0x00, 0x10, 0x41]; // RLE, last, 131073
    expect(zstdFrameOk(frame(0xa0, [1, 0, 2, 0], rle128k1), 131073)).toBe(
      false,
    );
  });
});
