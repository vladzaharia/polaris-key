import { describe, expect, it } from "vitest";
import {
  CdcChunker,
  MANIFEST_HEADER_BYTES,
  SYNC_CDC_PARAMS,
  cdcLengths,
  cdcParams,
  cdcStream,
  chunkId,
  chunkIdBytes,
  chunkIdHex,
  encodeManifest,
  openChunk,
  parseManifest,
  sealChunk,
  webCryptoSyncPort as port,
  zstdContentSize,
} from "../src/sync/index.js";

const KIB = 1024;
const MIB = KIB * KIB;

/** xorshift32 bytes: cheap, deterministic, no hashing in the loop. */
function noise(length: number, seed = 1): Uint8Array {
  const out = new Uint8Array(length);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < length; i++) {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    out[i] = x & 255;
  }
  return out;
}

const root = noise(32, 7);

describe("cdc: parameters", () => {
  it("defaults to 64 KiB / 256 KiB / 1 MiB", () => {
    expect(SYNC_CDC_PARAMS).toEqual({
      avg: 256 * KIB,
      min: 64 * KIB,
      max: MIB,
    });
  });
  it("refuses an average that is not a power of two", () => {
    expect(() => cdcParams(1000)).toThrow(RangeError);
    expect(() => cdcParams(32)).toThrow(RangeError);
  });
});

describe("cdc: boundary sizes", () => {
  const p = cdcParams(1024); // min 256, max 4096
  it("an empty input has no chunks", () => {
    expect(cdcLengths(new Uint8Array(0), p)).toEqual([]);
  });
  it("min bytes or fewer is one chunk", () => {
    expect(cdcLengths(noise(1), p)).toEqual([1]);
    expect(cdcLengths(noise(256), p)).toEqual([256]);
  });
  it("zeros never match a mask, so the cut is at max", () => {
    expect(cdcLengths(new Uint8Array(4096), p)).toEqual([4096]);
    expect(cdcLengths(new Uint8Array(4097), p)).toEqual([4096, 1]);
    expect(cdcLengths(new Uint8Array(3 * 4096 + 5), p)).toEqual([
      4096, 4096, 4096, 5,
    ]);
  });
  it("chunks tile the input and stay within [min, max] except the tail", () => {
    const lens = cdcLengths(noise(300 * KIB), p);
    expect(lens.reduce((a, b) => a + b, 0)).toBe(300 * KIB);
    lens.forEach((n, i) => {
      expect(n).toBeLessThanOrEqual(p.max);
      if (i < lens.length - 1) expect(n).toBeGreaterThanOrEqual(p.min + 1);
    });
  });
  it("the cuts do not depend on how the input is split", () => {
    const data = noise(200 * KIB, 3);
    const whole = cdcLengths(data, p);
    for (const piece of [1, 7, 255, 256, 257, 4095, 4096, 4097, 100_000]) {
      const c = new CdcChunker(p);
      const lens: number[] = [];
      for (let at = 0; at < data.length; at += piece)
        for (const ch of c.push(data.subarray(at, at + piece)))
          lens.push(ch.length);
      for (const ch of c.finish()) lens.push(ch.length);
      expect(lens).toEqual(whole);
    }
  });
  it("an insertion moves only nearby cuts", () => {
    const a = noise(256 * KIB, 5);
    const b = new Uint8Array(a.length + 10);
    b.set(a.subarray(0, 1000));
    b.set(noise(10, 9), 1000);
    b.set(a.subarray(1000), 1010);
    const la = cdcLengths(a, p);
    const lb = cdcLengths(b, p);
    expect(la.slice(-5)).toEqual(lb.slice(-5));
  });
});

describe("cdc: streaming", () => {
  it("chunks 64 MiB of generated input without buffering it", async () => {
    const total = 64 * MIB;
    const piece = 100_000;
    let produced = 0;
    async function* source(): AsyncGenerator<Uint8Array> {
      while (produced < total) {
        const n = Math.min(piece, total - produced);
        yield noise(n, (produced % 997) + 1);
        produced += n;
      }
    }
    let seen = 0;
    let count = 0;
    let longest = 0;
    let producedAhead = 0;
    for await (const ch of cdcStream(source())) {
      seen += ch.length;
      count++;
      longest = Math.max(longest, ch.length);
      // The chunker never reads more than one chunk ahead (max bytes plus one piece).
      producedAhead = Math.max(producedAhead, produced - seen);
    }
    expect(seen).toBe(total);
    expect(longest).toBeLessThanOrEqual(SYNC_CDC_PARAMS.max);
    expect(count).toBeGreaterThan(total / SYNC_CDC_PARAMS.max);
    expect(producedAhead).toBeLessThanOrEqual(SYNC_CDC_PARAMS.max + piece);
  });
  it("accepts a sync iterable and empty pieces", async () => {
    const out: number[] = [];
    for await (const ch of cdcStream(
      [new Uint8Array(0), noise(10), new Uint8Array(0)],
      cdcParams(1024),
    ))
      out.push(ch.length);
    expect(out).toEqual([10]);
  });
  it("emits copies: a later push never rewrites an earlier chunk", () => {
    const p = cdcParams(1024);
    const c = new CdcChunker(p);
    const first = c.push(new Uint8Array(4096).fill(0));
    expect(first).toHaveLength(1);
    c.push(new Uint8Array(4096).fill(9));
    expect(first[0]!.every((b) => b === 0)).toBe(true);
  });
});

describe("chunk ids and objects", () => {
  const plain = noise(5000, 11);

  it("E2E ids are keyed per collection; server ids are the plain SHA-256", async () => {
    const a = await chunkIdHex(port, root, "saves", plain);
    const b = await chunkIdHex(port, root, "other", plain);
    const s = await chunkIdHex(port, null, "saves", plain);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
    expect(s).toBe(
      Array.from(new Uint8Array(await port.sha256(plain)), (x) =>
        x.toString(16).padStart(2, "0"),
      ).join(""),
    );
    expect(chunkIdBytes(a)).toHaveLength(32);
    expect(chunkIdBytes("AB")).toBeNull();
  });

  it("seals and opens a raw chunk", async () => {
    const id = await chunkId(port, root, "saves", plain);
    const obj = await sealChunk(port, root, "saves", id, 0, plain);
    expect(obj.length).toBe(2 + plain.length + 16);
    expect([obj[0], obj[1]]).toEqual([1, 0]);
    const r = await openChunk(port, root, "saves", id, obj);
    expect(r.ok && r.plain).toEqual(plain);
  });

  it("opens codec 1 through the decoder and checks the declared size", async () => {
    // One zstd frame of a raw block with a 1-byte content size: 'A'.
    const frame = Uint8Array.of(
      0x28,
      0xb5,
      0x2f,
      0xfd,
      0x20,
      1,
      0x09,
      0,
      0,
      0x41,
    );
    expect(zstdContentSize(frame)).toBe(1);
    const a = new Uint8Array([0x41]);
    const id = await chunkId(port, root, "saves", a);
    const obj = await sealChunk(port, root, "saves", id, 1, frame);
    expect(await openChunk(port, root, "saves", id, obj, () => a)).toEqual({
      ok: true,
      plain: a,
      codec: 1,
    });
    expect(await openChunk(port, root, "saves", id, obj)).toEqual({
      ok: false,
      reason: "decode",
    });
    expect(
      await openChunk(port, root, "saves", id, obj, () => new Uint8Array(2)),
    ).toEqual({ ok: false, reason: "decode" });
    expect(
      await openChunk(port, root, "saves", id, obj, () => {
        throw new Error("bad frame");
      }),
    ).toEqual({ ok: false, reason: "decode" });
  });

  it("refuses a raw body over the maximum, then a wrong id", async () => {
    const big = noise(MIB + 1, 2);
    const id = await chunkId(port, root, "saves", big);
    const obj = await sealChunk(port, root, "saves", id, 0, big);
    expect(await openChunk(port, root, "saves", id, obj)).toEqual({
      ok: false,
      reason: "size",
    });
    const wrong = await chunkId(port, root, "saves", noise(10));
    const obj2 = await sealChunk(port, root, "saves", wrong, 0, plain);
    expect(await openChunk(port, root, "saves", wrong, obj2)).toEqual({
      ok: false,
      reason: "id",
    });
  });

  it("refuses by shape, version, codec and tag, in that order", async () => {
    const id = await chunkId(port, root, "saves", plain);
    const obj = await sealChunk(port, root, "saves", id, 0, plain);
    const open = (o: Uint8Array) => openChunk(port, root, "saves", id, o);
    expect(await open(obj.subarray(0, 17))).toEqual({
      ok: false,
      reason: "shape",
    });
    const v = obj.slice();
    v[0] = 2;
    v[1] = 9;
    expect(await open(v)).toEqual({ ok: false, reason: "version" });
    const c = obj.slice();
    c[1] = 2;
    expect(await open(c)).toEqual({ ok: false, reason: "codec" });
    const t = obj.slice();
    t[t.length - 1] = t[t.length - 1]! ^ 1;
    expect(await open(t)).toEqual({ ok: false, reason: "auth" });
    expect(await openChunk(port, noise(32, 8), "saves", id, obj)).toEqual({
      ok: false,
      reason: "auth",
    });
  });

  it("zstdContentSize reads the header widths", () => {
    const hdr = (fhd: number, ...rest: number[]) =>
      Uint8Array.of(0x28, 0xb5, 0x2f, 0xfd, fhd, ...rest);
    expect(zstdContentSize(hdr(0x20, 200))).toBe(200);
    expect(zstdContentSize(hdr(0x60, 1, 0))).toBe(257);
    expect(zstdContentSize(hdr(0xa0, 0, 0, 16, 0))).toBe(1 << 20);
    expect(zstdContentSize(hdr(0x00, 0x10, 1))).toBeNull();
    expect(zstdContentSize(Uint8Array.of(1, 2, 3, 4, 5, 6))).toBeNull();
  });
});

describe("pkey-sync-chunks/1 manifest", () => {
  const sha = noise(32, 4);
  const rec = (n: number, len: number) => ({ id: noise(32, n), plainLen: len });

  it("encodes the documented layout", () => {
    const b = encodeManifest({
      plainSize: 300,
      plainSha256: sha,
      records: [rec(1, 100), rec(2, 200)],
    });
    expect(b.length).toBe(MANIFEST_HEADER_BYTES + 96);
    expect(new TextDecoder().decode(b.subarray(0, 8))).toBe("PKSYNCCH");
    expect(Array.from(b.subarray(8, 24))).toEqual([
      1, 0, 48, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0,
    ]);
    expect(Array.from(b.subarray(24, 32))).toEqual([44, 1, 0, 0, 0, 0, 0, 0]);
    expect(Array.from(b.subarray(64 + 32, 64 + 40))).toEqual([
      100, 0, 0, 0, 0, 0, 0, 0,
    ]);
  });

  it("round-trips, including an empty file and repeated ids", () => {
    for (const m of [
      { plainSize: 0, plainSha256: sha, records: [] },
      {
        plainSize: 30,
        plainSha256: sha,
        records: [rec(1, 10), rec(2, 10), rec(1, 10)],
      },
    ]) {
      const p = parseManifest(encodeManifest(m));
      expect(p).toEqual({ ok: true, manifest: m });
    }
  });

  it("refuses the first violation", () => {
    const base = encodeManifest({
      plainSize: 20,
      plainSha256: sha,
      records: [rec(1, 10), rec(2, 10)],
    });
    const edit = (f: (b: Uint8Array) => void) => {
      const b = base.slice();
      f(b);
      return parseManifest(b);
    };
    expect(parseManifest(base.subarray(0, 10))).toEqual({
      ok: false,
      reason: "shape",
    });
    expect(edit((b) => (b[0] = 0))).toEqual({ ok: false, reason: "magic" });
    expect(edit((b) => (b[8] = 2))).toEqual({ ok: false, reason: "version" });
    expect(edit((b) => (b[10] = 40))).toEqual({
      ok: false,
      reason: "recordSize",
    });
    expect(edit((b) => (b[12] = 1))).toEqual({ ok: false, reason: "flags" });
    expect(edit((b) => (b[20] = 1))).toEqual({ ok: false, reason: "reserved" });
    expect(edit((b) => ((b[16] = 0xff), (b[17] = 0xff)))).toEqual({
      ok: false,
      reason: "count",
    });
    expect(edit((b) => (b[16] = 3))).toEqual({ ok: false, reason: "length" });
    expect(edit((b) => (b[31] = 1))).toEqual({ ok: false, reason: "size" });
    expect(edit((b) => (b[64 + 36] = 1))).toEqual({
      ok: false,
      reason: "record",
    });
    expect(edit((b) => (b[64 + 32] = 0))).toEqual({
      ok: false,
      reason: "chunkLen",
    });
    expect(edit((b) => (b[64 + 34] = 0x11))).toEqual({
      ok: false,
      reason: "chunkLen",
    });
    expect(edit((b) => (b[24] = 21))).toEqual({ ok: false, reason: "size" });
  });

  it("a plainSize beyond 2^53 is refused, not rounded into range", () => {
    const b = encodeManifest({ plainSize: 0, plainSha256: sha, records: [] });
    b.fill(0xff, 24, 32);
    expect(parseManifest(b)).toEqual({ ok: false, reason: "size" });
  });
});
