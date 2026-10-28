import { describe, expect, it } from "vitest";
import {
  FILE_HEADER_BYTES,
  FILE_SEGMENT_BYTES,
  FileStreamError,
  Sha256,
  deriveCollKey,
  deriveKid,
  openFile,
  openFileRange,
  openFileStream,
  partRange,
  planTransfer,
  plainFileSize,
  sealFile,
  sealFileStream,
  sealedFileSize,
  verifyReassembly,
  webCryptoSyncPort as port,
} from "../src/sync/index.js";

const MIB = 1024 * 1024;
const root = new Uint8Array(32).fill(7);
const salt = new Uint8Array(32).fill(9);

function noise(length: number, seed = 1): Uint8Array {
  const out = new Uint8Array(length);
  let x = (seed | 1) >>> 0;
  for (let i = 0; i < length; i++) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    out[i] = x >>> 24;
  }
  return out;
}

const setup = async () => ({
  collKey: await deriveCollKey(port, root, "saves"),
  kid: await deriveKid(port, root),
});

const hexOf = (b: Uint8Array): string =>
  Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

async function reason(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof FileStreamError) return e.reason;
    throw e;
  }
  return "ok";
}

describe("Sha256 (incremental)", () => {
  it("matches the port at awkward lengths and piece sizes", async () => {
    for (const n of [0, 1, 55, 56, 63, 64, 65, 119, 120, 1000, 70_000]) {
      const data = noise(n, n + 1);
      const want = await port.sha256(data);
      for (const piece of [1, 7, 64, 100, 100_000]) {
        const h = new Sha256();
        for (let at = 0; at < n; at += piece)
          h.update(data.subarray(at, at + piece));
        expect(hexOf(h.digest())).toBe(hexOf(want));
      }
    }
  });
});

describe("pkey-sync-file/1", () => {
  it("round trips around every segment boundary", async () => {
    const { collKey, kid } = await setup();
    for (const n of [
      0,
      1,
      FILE_SEGMENT_BYTES - 1,
      FILE_SEGMENT_BYTES,
      FILE_SEGMENT_BYTES + 1,
      2 * FILE_SEGMENT_BYTES,
    ]) {
      const plain = noise(n, n + 3);
      const sealed = await sealFile(port, collKey, kid, plain);
      expect(sealed.length).toBe(sealedFileSize(n));
      expect(plainFileSize(sealed.length)).toBe(n);
      const opened = await openFile(port, collKey, kid, sealed);
      expect(opened.ok && hexOf(opened.plain)).toBe(hexOf(plain));
    }
  });

  it("seals the same bytes however the plaintext arrives", async () => {
    const { collKey, kid } = await setup();
    const plain = noise(FILE_SEGMENT_BYTES + 5000);
    const whole = await sealFile(port, collKey, kid, plain, salt);
    for (const piece of [
      1000,
      65_537,
      FILE_SEGMENT_BYTES,
      3 * FILE_SEGMENT_BYTES,
    ]) {
      const parts: Uint8Array[] = [];
      const src = (function* () {
        for (let at = 0; at < plain.length; at += piece)
          yield plain.subarray(at, at + piece);
      })();
      for await (const p of sealFileStream(port, collKey, kid, src, salt))
        parts.push(p);
      expect(hexOf(new Uint8Array(Buffer.concat(parts)))).toBe(hexOf(whole));
    }
  });

  it("draws a fresh salt every seal, so identical content never repeats a key", async () => {
    const { collKey, kid } = await setup();
    const plain = noise(5000, 4);
    const a = await sealFile(port, collKey, kid, plain);
    const b = await sealFile(port, collKey, kid, plain);
    expect(hexOf(a.subarray(32, 64))).not.toBe(hexOf(b.subarray(32, 64)));
    expect(hexOf(a.subarray(64))).not.toBe(hexOf(b.subarray(64)));
    const opened = await openFile(port, collKey, kid, b);
    expect(opened.ok && hexOf(opened.plain)).toBe(hexOf(plain));
    // The port supplies the randomness, nothing derived from the content.
    const fixed = { ...port, random: (n: number) => new Uint8Array(n).fill(3) };
    const c = await sealFile(fixed, collKey, kid, plain);
    expect(Array.from(c.subarray(32, 64))).toEqual(Array(32).fill(3));
  });

  it("streams a large synthetic file without holding it", async () => {
    const { collKey, kid } = await setup();
    const total = 48 * MIB;
    const block = noise(MIB, 5);
    let produced = 0;
    let consumed = 0;
    let maxAhead = 0;
    const source = (async function* () {
      for (let i = 0; i < total / MIB; i++) {
        produced += MIB;
        maxAhead = Math.max(maxAhead, produced - consumed);
        yield block;
      }
    })();
    const sealedIn = new Sha256();
    const sealedPieces = (async function* () {
      for await (const p of sealFileStream(port, collKey, kid, source)) {
        consumed = produced - 0; // the sealer has taken everything produced so far
        sealedIn.update(p);
        yield p;
      }
    })();
    // Open straight off the sealer: nothing is buffered in between by this test.
    const expected = new Sha256();
    for (let i = 0; i < total / MIB; i++) expected.update(block);
    const plainSha = expected.digest();
    let n = 0;
    const opened = (async function* () {
      for await (const p of openFileStream(port, collKey, kid, sealedPieces)) {
        n += p.length;
        yield p;
      }
    })();
    for await (const _ of verifyReassembly(opened, {
      plainSize: total,
      plainSha256: plainSha,
    }))
      void _;
    expect(n).toBe(total);
    expect(maxAhead).toBeLessThanOrEqual(3 * MIB);
  });

  it("refuses a bad header before any segment", async () => {
    const { collKey, kid } = await setup();
    const sealed = await sealFile(port, collKey, kid, noise(10));
    const at = async (mut: (b: Uint8Array) => void, k = kid) => {
      const b = Uint8Array.from(sealed);
      mut(b);
      const r = await openFile(port, collKey, k, b);
      return r.ok ? "ok" : r.reason;
    };
    expect(await at((b) => (b[0] = 0))).toBe("magic");
    expect(await at((b) => (b[8] = 2))).toBe("version");
    expect(await at((b) => (b[10] = 1))).toBe("flags");
    expect(await at((b) => (b[14] = 1))).toBe("segmentSize");
    expect(await at(() => {}, new Uint8Array(16))).toBe("kid");
    expect(await at((b) => (b[50] = b[50]! ^ 1))).toBe("auth");
  });

  it("does not take a short or oddly sized tail for a file", async () => {
    const { collKey, kid } = await setup();
    const sealed = await sealFile(
      port,
      collKey,
      kid,
      noise(FILE_SEGMENT_BYTES + 1),
    );
    for (const [len, want] of [
      [0, "shape"],
      [FILE_HEADER_BYTES, "shape"],
      [FILE_HEADER_BYTES + 15, "shape"],
      [sealed.length - 1, "size"],
      [sealed.length - 2, "shape"],
    ] as const) {
      const r = await openFile(port, collKey, kid, sealed.subarray(0, len));
      expect(r.ok ? "ok" : r.reason).toBe(want);
    }
  });

  describe("ranged open", () => {
    it("reads and decrypts only the segments a range overlaps", async () => {
      const { collKey, kid } = await setup();
      const plain = noise(5 * FILE_SEGMENT_BYTES + 123, 11);
      const sealed = await sealFile(port, collKey, kid, plain);
      for (const [s, e, segs] of [
        [0, 0, 0],
        [0, 1, 1],
        [FILE_SEGMENT_BYTES - 1, FILE_SEGMENT_BYTES + 1, 2],
        [3 * FILE_SEGMENT_BYTES, 4 * FILE_SEGMENT_BYTES, 1],
        [5 * FILE_SEGMENT_BYTES, plain.length, 1],
        [0, plain.length, 6],
        [plain.length, plain.length, 0],
      ] as const) {
        const reads: Array<[number, number]> = [];
        const got = await openFileRange(
          port,
          collKey,
          kid,
          async (o, l) => {
            reads.push([o, l]);
            return sealed.slice(o, o + l);
          },
          sealed.length,
          s,
          e,
        );
        expect(hexOf(got)).toBe(hexOf(plain.subarray(s, e)));
        expect(reads.length).toBe(1 + segs);
        expect(reads[0]).toEqual([0, FILE_HEADER_BYTES]);
      }
    });

    it("refuses a range outside the file and a reader that answers short", async () => {
      const { collKey, kid } = await setup();
      const sealed = await sealFile(port, collKey, kid, noise(100));
      const read = async (o: number, l: number) => sealed.slice(o, o + l);
      const r = (s: number, e: number, rd = read, size = sealed.length) =>
        reason(openFileRange(port, collKey, kid, rd, size, s, e));
      expect(await r(0, 101)).toBe("range");
      expect(await r(5, 4)).toBe("range");
      expect(await r(-1, 4)).toBe("range");
      expect(await r(0, 10, async (o, l) => sealed.slice(o, o + l - 1))).toBe(
        "size",
      );
      expect(await r(0, 10, read, FILE_HEADER_BYTES + 8)).toBe("shape");
    });
  });

  describe("reassembly", () => {
    it("checks the length and the hash after the last piece", async () => {
      const data = noise(1000, 2);
      const sha = await port.sha256(data);
      const run = async (parts: Uint8Array[], size: number, h: Uint8Array) => {
        const out: Uint8Array[] = [];
        const r = await reason(
          (async () => {
            for await (const p of verifyReassembly(parts, {
              plainSize: size,
              plainSha256: h,
            }))
              out.push(p);
          })(),
        );
        return r;
      };
      expect(
        await run([data.subarray(0, 400), data.subarray(400)], 1000, sha),
      ).toBe("ok");
      expect(await run([data.subarray(0, 999)], 1000, sha)).toBe("plainSize");
      expect(await run([data, new Uint8Array(1)], 1000, sha)).toBe("plainSize");
      const bad = Uint8Array.from(data);
      bad[500] = bad[500]! ^ 1;
      expect(await run([bad], 1000, sha)).toBe("plainSha256");
    });
  });
});

describe("planTransfer", () => {
  it("takes the mode from the size and files.delta", () => {
    expect(planTransfer(0, false).mode).toBe("single");
    expect(planTransfer(16 * MIB, false).mode).toBe("single");
    expect(planTransfer(16 * MIB + 1, false)).toEqual({
      mode: "multipart",
      partBytes: 8 * MIB,
      parts: 3,
    });
    expect(planTransfer(MIB - 1, true).mode).toBe("single");
    expect(planTransfer(MIB, true).mode).toBe("chunks");
    expect(planTransfer(1024 * MIB, true).mode).toBe("chunks");
    expect(planTransfer(1024 * MIB + 1, true).mode).toBe("too_large");
    expect(planTransfer(1024 * MIB, false).partBytes).toBe(8 * MIB);
    expect(() => planTransfer(-1, false)).toThrow(RangeError);
  });

  it("slices parts that cover the file exactly", () => {
    const size = 100 * MIB + 17;
    const plan = planTransfer(size, false);
    let at = 0;
    for (let n = 1; n <= plan.parts!; n++) {
      const { start, end } = partRange(plan, size, n);
      expect(start).toBe(at);
      at = end;
    }
    expect(at).toBe(size);
    expect(() => partRange(plan, size, plan.parts! + 1)).toThrow(RangeError);
    expect(() => partRange(planTransfer(1, false), 1, 1)).toThrow(RangeError);
  });
});
