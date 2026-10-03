// @polaris-key/zstd-wasm/encoder through its Node entry (P4-17, notes/S-08 §5(4) and §6): the
// committed module is the recorded one, it refuses levels above 15, its frame decodes back to
// the target through the package's own decoder, a pair at the 32 MiB cap stays under 96 MiB of
// linear memory (workerd will not fail it, S-08 §2.5), and the content corpus's real v1 → v2
// pack payload encodes to the pinned frame whether its inputs are raw or zstd-coded.
import { createHash, randomFillSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ZstdEncodeError,
  encoderVersion,
  patchFrom,
  wasmWindowLogMax,
  type EncodeInput,
} from "../src/encoder-node.js";
import { decode, decodeWithPrefix } from "../src/node.js";

const wasm = readFileSync(new URL("../src/zenc.wasm", import.meta.url));
const sha = (b: Uint8Array): string =>
  createHash("sha256").update(b).digest("hex");

const BLOBS = new URL(
  "../../../conformance/corpus/v2/content/blobs/",
  import.meta.url,
);
const blob = (path: string): Uint8Array =>
  new Uint8Array(readFileSync(new URL(path, BLOBS)));

// The content corpus's real pack pair (content/cases.json `blobs`: v1 and v2 payloads). v1 is
// stored as `payload/v1.full.zst` (zstd -19); v2 is rebuilt from the committed CI delta.
const V1_SIZE = 5258960;
const V2_SIZE = 5256232;
const V1_SHA =
  "088ba75347d2547fc182f2dc6ab646ccfd860bbd5823ee7c70f04e21050b5b32";
const V2_SHA =
  "b99424aa618ad7f8dd715d4227a71ee860419be86b00a1b40557cfa91c6aebd9";
const v1Full = blob("payload/v1.full.zst");
const v1 = decode(v1Full, V1_SIZE);
const v2 = decodeWithPrefix(blob("deltas/v1-v2.pf.zst"), v1, V2_SIZE, 24);

/**
 * The level-9 frame of v1 → v2, pinned (unchanged by the streamed verify: decoding never alters
 * the frame). It is NOT the zstd CLI's bytes: the encoder reads the
 * target from a stable input buffer (ZSTD_c_stableInBuffer) instead of copying it into a window
 * of its own, which saves a target-sized buffer (the difference between ~84 and ~116 MiB at the
 * 32 MiB cap) and changes 9 bytes of this frame. `zstd --single-thread -9 --patch-from=v1 v2`
 * gives 325,267 bytes; the same module with a buffered input gave exactly those bytes (S-08
 * §4.2's byte identity). A rebuild of zenc.wasm that changes this frame is a reviewed change.
 */
const V1_V2_L9 = {
  bytes: 325258,
  sha256: "a618117da98f3766005409376dd214a4a7b3b7dfd62dc5e53d903ba76d09586a",
};

function input(
  raw: Uint8Array,
  stored: Uint8Array = raw,
  codec: "zstd" | "none" = "none",
  chunk = 65536,
): EncodeInput {
  return {
    size: raw.byteLength,
    bytes: stored.byteLength,
    codec,
    sha256: sha(raw),
    read: async function* () {
      for (let o = 0; o < stored.byteLength; o += chunk)
        yield stored.subarray(o, Math.min(stored.byteLength, o + chunk));
    },
  };
}

const codeOf = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(ZstdEncodeError);
    return (e as ZstdEncodeError).code;
  }
  return "encoded";
};

const CAP = 32 * 1024 * 1024;

describe("the committed zenc.wasm", () => {
  it("is the module whose SHA-256 build.sh recorded", () => {
    const recorded = readFileSync(
      new URL("../src/zenc.wasm.sha256", import.meta.url),
      "utf8",
    ).trim();
    expect(sha(wasm)).toBe(recorded);
  });
  it("imports nothing and exports only the encoder and its decoder", () => {
    const m = new WebAssembly.Module(wasm);
    expect(WebAssembly.Module.imports(m)).toEqual([]);
    expect(
      WebAssembly.Module.exports(m)
        .map((e) => e.name)
        .sort(),
    ).toEqual([
      "memory",
      "ze_alloc",
      "ze_begin",
      "ze_dbegin",
      "ze_decode",
      "ze_dpos",
      "ze_dstep",
      "ze_info",
      "ze_input",
      "ze_mark",
      "ze_remaining",
      "ze_reset",
      "ze_step",
      "ze_version",
    ]);
  });
  it("is libzstd 1.5.7", () => {
    expect(encoderVersion()).toBe(10507);
  });
});

describe("patchFrom on the corpus pair", () => {
  it("has the inputs the corpus names", () => {
    expect([v1.byteLength, sha(v1)]).toEqual([V1_SIZE, V1_SHA]);
    expect([v2.byteLength, sha(v2)]).toEqual([V2_SIZE, V2_SHA]);
  });

  it("encodes raw inputs to the pinned level-9 frame, which decodes back to v2", async () => {
    const r = await patchFrom({
      from: input(v1),
      to: input(v2),
      level: 9,
      maxInputBytes: CAP,
    });
    expect({ bytes: r.frame.byteLength, sha256: sha(r.frame) }).toEqual(
      V1_V2_L9,
    );
    expect(r.sha256).toBe(V1_V2_L9.sha256);
    // The CLI's choice for a 5 MB target: highbit + 1 = 23, and long mode (23 > the cycle).
    expect([r.windowLog, r.longMode]).toEqual([23, true]);
    expect(Array.from(r.baseHead)).toEqual(Array.from(v1.subarray(0, 4)));
    const wlm = wasmWindowLogMax(V1_SIZE + V2_SIZE);
    expect(sha(decodeWithPrefix(r.frame, v1, V2_SIZE, wlm))).toBe(V2_SHA);
  });

  it("decodes a zstd-coded input as it streams (odd chunk sizes) and gets the same frame", async () => {
    const r = await patchFrom({
      from: input(v1, v1Full, "zstd", 4093),
      to: input(v2),
      level: 9,
      maxInputBytes: CAP,
    });
    expect(r.sha256).toBe(V1_V2_L9.sha256);
  });

  it("refuses levels outside 1..15 before reading anything", async () => {
    for (const level of [0, 16, 19, 22, 9.5])
      expect(
        await codeOf(
          patchFrom({
            from: input(v1),
            to: input(v2),
            level,
            maxInputBytes: CAP,
          }),
        ),
      ).toBe("level");
  });

  it("refuses an input over the cap, a wrong digest, a short body and a large frame", async () => {
    expect(
      await codeOf(
        patchFrom({
          from: input(v1),
          to: input(v2),
          level: 9,
          maxInputBytes: V1_SIZE - 1,
        }),
      ),
    ).toBe("input-size");
    expect(
      await codeOf(
        patchFrom({
          from: input(v1),
          to: { ...input(v2), sha256: V1_SHA },
          level: 9,
          maxInputBytes: CAP,
        }),
      ),
    ).toBe("input-digest");
    expect(
      await codeOf(
        patchFrom({
          from: {
            ...input(v1),
            read: async function* () {
              yield v1.subarray(0, 100);
            },
          },
          to: input(v2),
          level: 9,
          maxInputBytes: CAP,
        }),
      ),
    ).toBe("input");
    expect(
      await codeOf(
        patchFrom({
          from: input(v1, v1Full.subarray(0, v1Full.byteLength - 1), "zstd"),
          to: input(v2),
          level: 9,
          maxInputBytes: CAP,
        }),
      ),
    ).toBe("input");
    expect(
      await codeOf(
        patchFrom({
          from: input(v1),
          to: input(v2),
          level: 9,
          maxInputBytes: CAP,
          maxFrameBytes: 100_000,
        }),
      ),
    ).toBe("frame-too-large");
  });
});

describe("the memory budget (S-08 §5(4))", () => {
  it("holds the worst case: 32 MiB of random base, 68% new incompressible target, under 110 MiB with the frame", async () => {
    const rnd = (n: number): Uint8Array => {
      const a = new Uint8Array(n);
      for (let o = 0; o < n; o += 65536)
        randomFillSync(a.subarray(o, Math.min(n, o + 65536)));
      return a;
    };
    const from = rnd(CAP);
    const keep = Math.floor(CAP * 0.32);
    const to = new Uint8Array(CAP);
    to.set(from.subarray(0, keep));
    to.set(rnd(CAP - keep), keep);
    // The consumer's limit against an incompressible full object of the cap's size.
    const maxFrameBytes = Math.min(
      Math.ceil(CAP * 0.7) - 1,
      CAP - 1024 * 1024 - 1,
    );
    const r = await patchFrom({
      from: input(from, from, "none", 1 << 20),
      to: input(to, to, "none", 1 << 20),
      level: 9,
      maxInputBytes: CAP,
      maxFrameBytes,
    });
    // The frame is ~21.8 MiB and lives in ONE preallocated buffer of maxFrameBytes: linear
    // memory at its peak plus that buffer is the job's whole byte footprint (measured 83.8 +
    // 22.4 = 106.2 MiB).
    expect(r.frame.byteLength).toBeGreaterThan(20 * 1024 * 1024);
    expect(r.frame.buffer.byteLength).toBe(maxFrameBytes);
    expect(r.memoryBytes + r.frame.buffer.byteLength).toBeLessThanOrEqual(
      110 * 1024 * 1024,
    );
  }, 120_000);

  it("keeps a 32 MiB pair at level 9 under 96 MiB of linear memory", async () => {
    const a = new Uint8Array(CAP);
    let s = 1;
    for (let i = 0; i < CAP; i++) {
      s = (Math.imul(s, 1103515245) + 12345) >>> 0;
      a[i] = s >>> 24;
    }
    const b = a.slice();
    for (let k = 0; k < 64; k++) b[(k * 524287) % CAP]! ^= 0xff;
    const r = await patchFrom({
      from: input(a, a, "none", 1 << 20),
      to: input(b, b, "none", 1 << 20),
      level: 9,
      maxInputBytes: CAP,
    });
    expect(r.memoryBytes).toBeLessThanOrEqual(96 * 1024 * 1024);
    expect(r.frame.byteLength).toBeLessThan(64 * 1024);
  }, 60_000);
});
