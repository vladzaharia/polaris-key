/// <reference types="@cloudflare/workers-types" />
/**
 * P0-10 — the streaming Sparkle verifier.
 *
 * `verifySparkleSignature` used to buffer the whole DMG (`res.arrayBuffer()`) before checking
 * its size, against a 256 MiB cap inside a 128 MB isolate. It now streams the body through an
 * incremental SHA-512 and finishes PureEdDSA with two scalar multiplications
 * (`services/release/ed25519Stream.ts`). These tests pin three things:
 *
 *   1. it agrees with WebCrypto — on the RFC 8032 §7.1 vectors and on 200 random cases, with a
 *      flipped bit in M, R and S each, so the rewrite is not a looser verifier;
 *   2. it verifies a 300 MiB body while holding at most one chunk of it;
 *   3. the byte cap holds with, without, and against a lying `Content-Length`, and S >= L is
 *      refused — all as `false`, never a throw;
 *   4. a final negative verdict is memoised like a positive one, so an unauthenticated appcast
 *      request for a release whose signature fails cannot re-download the DMG every time,
 *      while a verdict that was never reached (mid-stream failure, body past the cap) is not.
 *
 * The R6-03 route fixtures (valid, tampered, wrong key, missing sidecar) live in
 * `release.test.ts` and `attack/R6-release.test.ts` and run unchanged against the new path.
 */

import { createHash } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519.js";
import { describe, expect, it } from "vitest";
import type { Env } from "../src/platform/env.js";
import {
  ed25519SignaturePrecheck,
  streamingEd25519Check,
  streamingEd25519Verify,
} from "../src/services/release/ed25519Stream.js";
import {
  NEGATIVE_VERIFY_CACHE_TTL_SECONDS,
  VERIFY_CACHE_TTL_SECONDS,
  verifySparkleSignature,
} from "../src/services/release/sparkle.js";
import { asKv, KvMock } from "./kvMock.js";

const Point = ed25519.Point;
const L = Point.Fn.ORDER;
const MiB = 1024 * 1024;

// ── helpers ─────────────────────────────────────────────────────────────────────────────────

const hex = (s: string): Uint8Array =>
  new Uint8Array((s.match(/../g) ?? []).map((b) => parseInt(b, 16)));
const b64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));

/** One chunk, served as a stream. */
function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

/** A tiny deterministic PRNG (xorshift32), so a failing random case is reproducible. */
function prng(seed: number): () => number {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    return x;
  };
}

/** Split `bytes` into randomly sized chunks and serve them as a stream. */
function chunkedStream(
  bytes: Uint8Array,
  rand: () => number,
): ReadableStream<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for (let off = 0; off < bytes.length; ) {
    const n = 1 + (rand() % 97);
    chunks.push(bytes.slice(off, off + n));
    off += n;
  }
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = chunks.shift();
      if (next) controller.enqueue(next);
      else controller.close();
    },
  });
}

async function webcryptoVerify(
  pub: Uint8Array,
  sig: Uint8Array,
  msg: Uint8Array,
): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      pub as BufferSource,
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify(
      { name: "Ed25519" },
      key,
      sig as BufferSource,
      msg as BufferSource,
    );
  } catch {
    return false;
  }
}

async function freshKeypair(): Promise<{
  pub: Uint8Array;
  sign: (m: Uint8Array) => Promise<Uint8Array>;
}> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const pub = new Uint8Array(
    (await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer,
  );
  return {
    pub,
    sign: async (m) =>
      new Uint8Array(
        await crypto.subtle.sign(
          { name: "Ed25519" },
          pair.privateKey,
          m as BufferSource,
        ),
      ),
  };
}

const flip = (bytes: Uint8Array, bit: number): Uint8Array => {
  const out = bytes.slice();
  out[bit >> 3]! ^= 1 << (bit & 7);
  return out;
};

const leToBigInt = (bytes: Uint8Array): bigint => {
  let n = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(bytes[i]!);
  return n;
};
const bigIntToLe32 = (n: bigint): Uint8Array => {
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
};

interface LazyBodyStats {
  /** Pull calls that produced a chunk. */
  chunks: number;
  /** The most chunks ever sitting in the stream's queue, unread. */
  maxQueued: number;
  /** Bytes handed to the consumer so far. */
  produced: number;
  cancelled: boolean;
}

/**
 * A `total`-byte body generated on demand into ONE reused `chunkSize` buffer. `highWaterMark: 0`
 * means a chunk is produced only when the consumer asks for one, and reusing the buffer means
 * a consumer that kept a reference to an earlier chunk (instead of hashing it on the spot) would
 * see it overwritten — so a buffering verifier fails the signature, not just a memory budget.
 */
function lazyBody(
  total: number,
  chunkSize: number,
  stats: LazyBodyStats,
): ReadableStream<Uint8Array> {
  const buf = new Uint8Array(chunkSize);
  return new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        const remaining = total - stats.produced;
        if (remaining <= 0) {
          controller.close();
          return;
        }
        const n = Math.min(chunkSize, remaining);
        const i = stats.chunks;
        buf.fill((i * 31 + 7) & 0xff);
        buf[0] = i & 0xff;
        buf[1] = (i >> 8) & 0xff;
        stats.chunks++;
        stats.produced += n;
        controller.enqueue(n === chunkSize ? buf : buf.subarray(0, n));
        stats.maxQueued = Math.max(
          stats.maxQueued,
          -(controller.desiredSize ?? 0),
        );
      },
      cancel() {
        stats.cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
}

const newStats = (): LazyBodyStats => ({
  chunks: 0,
  maxQueued: 0,
  produced: 0,
  cancelled: false,
});

/** Drain a stream through a SHA-512 seeded with `prefix`, returning the digest mod L. */
async function hashToScalar(
  prefix: Uint8Array[],
  body: ReadableStream<Uint8Array>,
): Promise<bigint> {
  const h = createHash("sha512");
  for (const p of prefix) h.update(p);
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    h.update(value);
  }
  return leToBigInt(new Uint8Array(h.digest())) % L;
}

/**
 * RFC 8032 §5.1.6 signing, streamed: the message is read twice (for r, then for k), so a
 * multi-hundred-MiB body can be signed in a test without materialising it. Checked against
 * WebCrypto's own signature below — Ed25519 is deterministic, so they must be byte-identical.
 */
async function streamingSign(
  seed: Uint8Array,
  body: () => ReadableStream<Uint8Array>,
): Promise<{ pub: Uint8Array; sig: Uint8Array }> {
  const { prefix, scalar, pointBytes } =
    ed25519.utils.getExtendedPublicKey(seed);
  const r = await hashToScalar([prefix], body());
  const R = Point.BASE.multiplyUnsafe(r).toBytes();
  const k = await hashToScalar([R, pointBytes], body());
  const S = (r + k * scalar) % L;
  const sig = new Uint8Array(64);
  sig.set(R, 0);
  sig.set(bigIntToLe32(S), 32);
  return { pub: pointBytes, sig };
}

const PKCS8_ED25519_PREFIX = hex("302e020100300506032b657004220420");

// ── RFC 8032 §7.1 ────────────────────────────────────────────────────────────────────────────

const RFC8032_VECTORS = [
  {
    name: "TEST 1 (empty message)",
    pub: "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a",
    msg: "",
    sig: "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b",
  },
  {
    name: "TEST 2 (one byte)",
    pub: "3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c",
    msg: "72",
    sig: "92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00",
  },
  {
    name: "TEST 3 (two bytes)",
    pub: "fc51cd8e6218a1a38da47ed00230f0580816ed13ba3303ac5deb911548908025",
    msg: "af82",
    sig: "6291d657deec24024827e69c3abe01a30ce548a284743a445e3680d7db5ac3ac18ff9b538d16f290ae67f760984dc6594a7c15e9716ed28dc027beceea1ec40a",
  },
  {
    name: "TEST 1024 (1023 bytes, many chunks)",
    pub: "278117fc144c72340f67d0f2316e8386ceffbf2b2428c9c51fef7c597f1d426e",
    msg: [
      "08b8b2b733424243760fe426a4b54908632110a66c2f6591eabd3345e3e4eb98",
      "fa6e264bf09efe12ee50f8f54e9f77b1e355f6c50544e23fb1433ddf73be84d8",
      "79de7c0046dc4996d9e773f4bc9efe5738829adb26c81b37c93a1b270b20329d",
      "658675fc6ea534e0810a4432826bf58c941efb65d57a338bbd2e26640f89ffbc",
      "1a858efcb8550ee3a5e1998bd177e93a7363c344fe6b199ee5d02e82d522c4fe",
      "ba15452f80288a821a579116ec6dad2b3b310da903401aa62100ab5d1a36553e",
      "06203b33890cc9b832f79ef80560ccb9a39ce767967ed628c6ad573cb116dbef",
      "efd75499da96bd68a8a97b928a8bbc103b6621fcde2beca1231d206be6cd9ec7",
      "aff6f6c94fcd7204ed3455c68c83f4a41da4af2b74ef5c53f1d8ac70bdcb7ed1",
      "85ce81bd84359d44254d95629e9855a94a7c1958d1f8ada5d0532ed8a5aa3fb2",
      "d17ba70eb6248e594e1a2297acbbb39d502f1a8c6eb6f1ce22b3de1a1f40cc24",
      "554119a831a9aad6079cad88425de6bde1a9187ebb6092cf67bf2b13fd65f270",
      "88d78b7e883c8759d2c4f5c65adb7553878ad575f9fad878e80a0c9ba63bcbcc",
      "2732e69485bbc9c90bfbd62481d9089beccf80cfe2df16a2cf65bd92dd597b07",
      "07e0917af48bbb75fed413d238f5555a7a569d80c3414a8d0859dc65a46128ba",
      "b27af87a71314f318c782b23ebfe808b82b0ce26401d2e22f04d83d1255dc51a",
      "ddd3b75a2b1ae0784504df543af8969be3ea7082ff7fc9888c144da2af58429e",
      "c96031dbcad3dad9af0dcbaaaf268cb8fcffead94f3c7ca495e056a9b47acdb7",
      "51fb73e666c6c655ade8297297d07ad1ba5e43f1bca32301651339e22904cc8c",
      "42f58c30c04aafdb038dda0847dd988dcda6f3bfd15c4b4c4525004aa06eeff8",
      "ca61783aacec57fb3d1f92b0fe2fd1a85f6724517b65e614ad6808d6f6ee34df",
      "f7310fdc82aebfd904b01e1dc54b2927094b2db68d6f903b68401adebf5a7e08",
      "d78ff4ef5d63653a65040cf9bfd4aca7984a74d37145986780fc0b16ac451649",
      "de6188a7dbdf191f64b5fc5e2ab47b57f7f7276cd419c17a3ca8e1b939ae49e4",
      "88acba6b965610b5480109c8b17b80e1b7b750dfc7598d5d5011fd2dcc5600a3",
      "2ef5b52a1ecc820e308aa342721aac0943bf6686b64b2579376504ccc493d97e",
      "6aed3fb0f9cd71a43dd497f01f17c0e2cb3797aa2a2f256656168e6c496afc5f",
      "b93246f6b1116398a346f1a641f3b041e989f7914f90cc2c7fff357876e506b5",
      "0d334ba77c225bc307ba537152f3f1610e4eafe595f6d9d90d11faa933a15ef1",
      "369546868a7f3a45a96768d40fd9d03412c091c6315cf4fde7cb68606937380d",
      "b2eaaa707b4c4185c32eddcdd306705e4dc1ffc872eeee475a64dfac86aba41c",
      "0618983f8741c5ef68d3a101e8a3b8cac60c905c15fc910840b94c00a0b9d0",
    ].join(""),
    sig: "0aab4c900501b3e24d7cdf4663326a3a87df5e4843b2cbdb67cbf6e460fec350aa5371b1508f9f4528ecea23c436d94b5e8fcd4f681e30a6ac00a9704a188a03",
  },
  {
    name: "TEST SHA(abc)",
    pub: "ec172b93ad5e563bf4932c70e1245034c35467ef2efd4d64ebf819683467e2bf",
    msg: "ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f",
    sig: "dc2a4459e7369633a52b1bf277839a00201009a3efbf3ecb69bea2186c26b58909351fc9ac90b3ecfdfbc7c66431e0303dca179c138ac17ad9bef1177331a704",
  },
];

describe("streamingEd25519Verify — RFC 8032 §7.1 vectors", () => {
  for (const v of RFC8032_VECTORS) {
    it(`${v.name}: verifies, and agrees with WebCrypto on it and on a tampered copy`, async () => {
      const pub = hex(v.pub);
      const sig = hex(v.sig);
      const msg = hex(v.msg);
      const rand = prng(0x8032);
      expect(await webcryptoVerify(pub, sig, msg)).toBe(true);
      expect(
        await streamingEd25519Verify(pub, sig, chunkedStream(msg, rand), MiB),
      ).toBe(true);
      const tampered = flip(sig, 3);
      expect(
        await streamingEd25519Verify(
          pub,
          tampered,
          chunkedStream(msg, rand),
          MiB,
        ),
      ).toBe(await webcryptoVerify(pub, tampered, msg));
    });
  }
});

// ── property test ────────────────────────────────────────────────────────────────────────────

describe("streamingEd25519Verify agrees with WebCrypto", () => {
  it("on 200 random cases, each with a flipped bit in M, R and S", async () => {
    const rand = prng(0x5eed_0010);
    let accepted = 0;
    for (let i = 0; i < 200; i++) {
      const { pub, sign } = await freshKeypair();
      const len = rand() % 2048;
      const msg = new Uint8Array(len);
      for (let j = 0; j < len; j++) msg[j] = rand() & 0xff;
      const sig = await sign(msg);

      const variants: Array<[string, Uint8Array, Uint8Array]> = [
        ["valid", sig, msg],
        ["R bit", flip(sig, rand() % 256), msg],
        ["S bit", flip(sig, 256 + (rand() % 256)), msg],
      ];
      if (len > 0) variants.push(["M bit", sig, flip(msg, rand() % (len * 8))]);

      for (const [label, s, m] of variants) {
        const expected = await webcryptoVerify(pub, s, m);
        const actual = await streamingEd25519Verify(
          pub,
          s,
          chunkedStream(m, rand),
          MiB,
        );
        if (actual !== expected) {
          throw new Error(
            `case ${i} (${label}): streaming=${actual} webcrypto=${expected}`,
          );
        }
        if (actual) accepted++;
      }
    }
    // Exactly the 200 untampered signatures verify; every tampered one is refused by both.
    expect(accepted).toBe(200);
    // ~800 pure-JS point multiplications: well under a second alone, but give a loaded CI
    // runner room rather than the 5 s default.
  }, 60_000);

  it("refuses S >= L (the malleable S + L twin WebCrypto also refuses)", async () => {
    const { pub, sign } = await freshKeypair();
    const msg = new TextEncoder().encode("malleability");
    const sig = await sign(msg);
    const twin = sig.slice();
    twin.set(bigIntToLe32(leToBigInt(sig.subarray(32)) + L), 32);
    expect(await webcryptoVerify(pub, twin, msg)).toBe(false);
    expect(
      await streamingEd25519Verify(pub, twin, chunkedStream(msg, prng(1)), MiB),
    ).toBe(false);
    // …while the reduced original still verifies, so the refusal is the S check.
    expect(
      await streamingEd25519Verify(pub, sig, chunkedStream(msg, prng(1)), MiB),
    ).toBe(true);
  });

  it("refuses a wrong key, a small-order key, an undecodable key and bad lengths without throwing", async () => {
    const a = await freshKeypair();
    const b = await freshKeypair();
    const msg = new TextEncoder().encode("DMG-BYTES");
    const sig = await a.sign(msg);
    const body = () => chunkedStream(msg, prng(2));
    expect(await streamingEd25519Verify(b.pub, sig, body(), MiB)).toBe(false);
    // The identity point (y = 1): small order.
    const identity = new Uint8Array(32);
    identity[0] = 1;
    expect(await streamingEd25519Verify(identity, sig, body(), MiB)).toBe(
      false,
    );
    // y = p (non-canonical): 2^255 - 19, little-endian.
    const yEqualsP = bigIntToLe32((1n << 255n) - 19n);
    expect(await streamingEd25519Verify(yEqualsP, sig, body(), MiB)).toBe(
      false,
    );
    expect(
      await streamingEd25519Verify(a.pub.subarray(0, 31), sig, body(), MiB),
    ).toBe(false);
    expect(
      await streamingEd25519Verify(a.pub, sig.subarray(0, 63), body(), MiB),
    ).toBe(false);
  });

  it("refuses a small-order R (WIRE-CONTRACT-V4 §1.1 check 3), and the precheck agrees", async () => {
    const { pub, sign } = await freshKeypair();
    const msg = new TextEncoder().encode("small-order R");
    const sig = await sign(msg);
    expect(ed25519SignaturePrecheck(pub, sig)).toBe(true);
    for (const enc of [
      Point.ZERO.toBytes(),
      hex("ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f"),
      hex("26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05"),
    ]) {
      const bad = sig.slice();
      bad.set(enc, 0);
      expect(ed25519SignaturePrecheck(pub, bad)).toBe(false);
      expect(await streamingEd25519Check(pub, bad, streamOf(msg), 1024)).toBe(
        "invalid",
      );
    }
  });

  it("treats a body that errors mid-stream as false, not a throw", async () => {
    const { pub, sign } = await freshKeypair();
    const sig = await sign(new Uint8Array(8));
    const broken = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new TypeError("connection reset"));
      },
    });
    expect(await streamingEd25519Verify(pub, sig, broken, MiB)).toBe(false);
  });

  it("says which failures are final (invalid) and which reached no verdict (incomplete)", async () => {
    const { pub, sign } = await freshKeypair();
    const msg = new Uint8Array(4096).fill(7);
    const sig = await sign(msg);
    const rand = prng(0x0ca5e);
    const check = (
      p: Uint8Array,
      s: Uint8Array,
      m: Uint8Array | ReadableStream<Uint8Array>,
      cap = MiB,
    ) =>
      streamingEd25519Check(
        p,
        s,
        m instanceof Uint8Array ? chunkedStream(m, rand) : m,
        cap,
      );

    expect(await check(pub, sig, msg)).toBe("valid");
    // Final: the whole body was read within the cap and the signature does not cover it.
    expect(await check(pub, sig, flip(msg, 100))).toBe("invalid");
    // Final: refused before a byte of body is needed.
    const sPlusL = new Uint8Array(sig);
    sPlusL.set(bigIntToLe32(leToBigInt(sig.subarray(32)) + L), 32);
    expect(await check(pub, sPlusL, msg)).toBe("invalid");
    expect(await check(bigIntToLe32((1n << 255n) - 19n), sig, msg)).toBe(
      "invalid",
    );
    // No verdict: the body ran past the cap, or broke off mid-stream.
    expect(await check(pub, sig, msg, 1024)).toBe("incomplete");
    let sent = false;
    const breaksAfterOneChunk = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent) controller.error(new TypeError("connection reset"));
        else {
          sent = true;
          controller.enqueue(msg.slice(0, 1000));
        }
      },
    });
    expect(await check(pub, sig, breaksAfterOneChunk)).toBe("incomplete");
  });
});

// ── large bodies and the cap ─────────────────────────────────────────────────────────────────

describe("streamingEd25519Verify over large bodies", () => {
  it("the test's streaming signer matches WebCrypto byte for byte", async () => {
    const seed = crypto.getRandomValues(new Uint8Array(32));
    const pkcs8 = new Uint8Array(48);
    pkcs8.set(PKCS8_ED25519_PREFIX, 0);
    pkcs8.set(seed, 16);
    const key = await crypto.subtle.importKey(
      "pkcs8",
      pkcs8 as BufferSource,
      { name: "Ed25519" },
      false,
      ["sign"],
    );
    const body = () => lazyBody(200_000, 4096, newStats());
    // Materialise the same bytes for WebCrypto.
    const whole = new Uint8Array(200_000);
    {
      const reader = body().getReader();
      let off = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        whole.set(value, off);
        off += value.byteLength;
      }
    }
    const expected = new Uint8Array(
      await crypto.subtle.sign({ name: "Ed25519" }, key, whole as BufferSource),
    );
    const { sig } = await streamingSign(seed, body);
    expect(b64(sig)).toBe(b64(expected));
  });

  it("verifies a lazily generated 300 MiB body while holding at most one chunk", async () => {
    const TOTAL = 300 * MiB;
    const CHUNK = 64 * 1024;
    const seed = crypto.getRandomValues(new Uint8Array(32));
    const { pub, sig } = await streamingSign(seed, () =>
      lazyBody(TOTAL, CHUNK, newStats()),
    );

    const before = process.memoryUsage().arrayBuffers;
    const stats = newStats();
    const ok = await streamingEd25519Verify(
      pub,
      sig,
      lazyBody(TOTAL, CHUNK, stats),
      2048 * MiB,
    );
    const grown = process.memoryUsage().arrayBuffers - before;

    expect(ok).toBe(true);
    expect(stats.produced).toBe(TOTAL);
    expect(stats.chunks).toBe(TOTAL / CHUNK);
    // Every chunk went straight to a waiting read: the stream never queued one ahead, so the
    // bytes held on the reader side never exceeded the single chunk being hashed. (And since the
    // generator reuses one buffer, a verifier that kept chunks around would have hashed garbage.)
    expect(stats.maxQueued).toBe(0);
    // Belt and braces: nowhere near 300 MiB of ArrayBuffer was retained.
    expect(grown).toBeLessThan(32 * MiB);
  }, 120_000);

  it("stops reading and returns false the moment the body passes the cap", async () => {
    const seed = crypto.getRandomValues(new Uint8Array(32));
    const { pub, sig } = await streamingSign(seed, () =>
      lazyBody(MiB, 16 * 1024, newStats()),
    );
    // Exactly at the cap: verifies.
    expect(
      await streamingEd25519Verify(
        pub,
        sig,
        lazyBody(MiB, 16 * 1024, newStats()),
        MiB,
      ),
    ).toBe(true);
    // One byte over: refused, the stream cancelled, and nothing past the cap pulled.
    const stats = newStats();
    await expect(
      streamingEd25519Verify(
        pub,
        sig,
        lazyBody(64 * MiB, 16 * 1024, stats),
        MiB - 1,
      ),
    ).resolves.toBe(false);
    expect(stats.cancelled).toBe(true);
    expect(stats.produced).toBeLessThanOrEqual(MiB);
  });
});

// ── verifySparkleSignature: Content-Length, the cap and the memo ────────────────────────────

describe("verifySparkleSignature (streaming path)", () => {
  const ASSET_URL = "https://api.github.com/repos/o/r/releases/assets/100";

  async function setup(bodyBytes: number) {
    const seed = crypto.getRandomValues(new Uint8Array(32));
    const { pub, sig } = await streamingSign(seed, () =>
      lazyBody(bodyBytes, 16 * 1024, newStats()),
    );
    const kv = new KvMock();
    const env = { HOT: asKv(kv) } as unknown as Env;
    return { env, kv, publicKey: b64(pub), signature: b64(sig) };
  }

  function serving(
    stats: LazyBodyStats,
    total: number,
    contentLength?: string,
  ): (url: string) => Promise<Response> {
    return async (url) => {
      if (url !== ASSET_URL) return new Response("not found", { status: 404 });
      const headers: Record<string, string> = {};
      if (contentLength !== undefined)
        headers["Content-Length"] = contentLength;
      return new Response(lazyBody(total, 16 * 1024, stats), { headers });
    };
  }

  const input = (
    publicKey: string,
    signature: string,
    fetchImpl: (url: string) => Promise<Response>,
    maxBytes?: number,
  ) => ({
    token: "t",
    owner: "o",
    repo: "r",
    assetId: 100,
    signature,
    publicKey,
    fetchImpl,
    ...(maxBytes === undefined ? {} : { maxBytes }),
  });

  it("verifies a streamed DMG and memoises the verdict for 30 days", async () => {
    const { env, kv, publicKey, signature } = await setup(3 * MiB);
    const stats = newStats();
    const ok = await verifySparkleSignature(
      env,
      "djdl",
      input(publicKey, signature, serving(stats, 3 * MiB, String(3 * MiB))),
    );
    expect(ok).toBe(true);
    expect(VERIFY_CACHE_TTL_SECONDS).toBe(30 * 86_400);
    const [key] = kv.keys();
    expect(key).toContain("sparkle-sig");
    expect(kv.ttlOf(key!)).toBe(30 * 86_400);

    // The memo answers the second request without touching GitHub.
    const again = await verifySparkleSignature(
      env,
      "djdl",
      input(publicKey, signature, async () => {
        throw new Error("must not fetch");
      }),
    );
    expect(again).toBe(true);
  });

  it("refuses an honest Content-Length over the cap before reading a byte", async () => {
    const { env, kv, publicKey, signature } = await setup(2 * MiB);
    const stats = newStats();
    const ok = await verifySparkleSignature(
      env,
      "djdl",
      input(
        publicKey,
        signature,
        serving(stats, 2 * MiB, String(2 * MiB)),
        MiB,
      ),
    );
    expect(ok).toBe(false);
    expect(stats.produced).toBe(0);
    expect(kv.keys()).toEqual([]);
  });

  it("refuses a Content-Length over GitHub's 2 GiB maximum with the default cap", async () => {
    const { env, publicKey, signature } = await setup(MiB);
    const stats = newStats();
    const ok = await verifySparkleSignature(
      env,
      "djdl",
      input(
        publicKey,
        signature,
        serving(stats, MiB, String(2 * 1024 * MiB + 1)),
      ),
    );
    expect(ok).toBe(false);
    expect(stats.produced).toBe(0);
  });

  it("enforces the cap while streaming when Content-Length is absent", async () => {
    const { env, kv, publicKey, signature } = await setup(2 * MiB);
    const stats = newStats();
    await expect(
      verifySparkleSignature(
        env,
        "djdl",
        input(publicKey, signature, serving(stats, 2 * MiB), MiB),
      ),
    ).resolves.toBe(false);
    expect(stats.cancelled).toBe(true);
    expect(stats.produced).toBeLessThanOrEqual(MiB + 16 * 1024);
    expect(kv.keys()).toEqual([]);
  });

  it("enforces the cap while streaming when Content-Length lies", async () => {
    const { env, kv, publicKey, signature } = await setup(2 * MiB);
    const stats = newStats();
    await expect(
      verifySparkleSignature(
        env,
        "djdl",
        input(publicKey, signature, serving(stats, 2 * MiB, "1024"), MiB),
      ),
    ).resolves.toBe(false);
    expect(stats.cancelled).toBe(true);
    expect(stats.produced).toBeLessThanOrEqual(MiB + 16 * 1024);
    expect(kv.keys()).toEqual([]);
  });

  it("returns false for a missing asset without memoising anything", async () => {
    const { env, kv, publicKey, signature } = await setup(MiB);
    expect(
      await verifySparkleSignature(
        env,
        "djdl",
        input(
          publicKey,
          signature,
          async () => new Response("", { status: 404 }),
        ),
      ),
    ).toBe(false);
    expect(kv.keys()).toEqual([]);
  });

  it("memoises a final negative verdict for a day, so the next request does not fetch", async () => {
    const { env, kv, publicKey, signature } = await setup(MiB);
    // The signature covers MiB bytes; GitHub serves MiB - 1, read to the end within the cap.
    const stats = newStats();
    expect(
      await verifySparkleSignature(
        env,
        "djdl",
        input(publicKey, signature, serving(stats, MiB - 1, String(MiB - 1))),
      ),
    ).toBe(false);
    expect(stats.produced).toBe(MiB - 1);
    const [key] = kv.keys();
    expect(key).toContain("sparkle-sig");
    expect(await kv.get(key!)).toBe("0");
    expect(NEGATIVE_VERIFY_CACHE_TTL_SECONDS).toBe(86_400);
    expect(kv.ttlOf(key!)).toBe(86_400);

    // The second (unauthenticated, cache-missing) appcast request costs a KV read, not a DMG.
    const again = await verifySparkleSignature(
      env,
      "djdl",
      input(publicKey, signature, async () => {
        throw new Error("must not fetch");
      }),
    );
    expect(again).toBe(false);
  });

  // ── P3-03 (P0-10 follow-ups) ──────────────────────────────────────────────────────────

  it("a body shorter or longer than the listed asset size is incomplete and writes no memo", async () => {
    const { env, kv, publicKey, signature } = await setup(MiB);
    for (const served of [MiB - 1, MiB + 1]) {
      expect(
        await verifySparkleSignature(env, "djdl", {
          ...input(
            publicKey,
            signature,
            serving(newStats(), served, String(served)),
          ),
          expectedSize: MiB,
        }),
      ).toBe(false);
      expect(kv.keys()).toEqual([]);
    }
    // The listed length verifies (and only then is a verdict memoised).
    expect(
      await verifySparkleSignature(env, "djdl", {
        ...input(publicKey, signature, serving(newStats(), MiB, String(MiB))),
        expectedSize: MiB,
      }),
    ).toBe(true);
    expect(kv.keys()).toHaveLength(1);
  });

  it("a malformed key or signature opens no download", async () => {
    const { env, kv, publicKey, signature } = await setup(MiB);
    const sig = Uint8Array.from(atob(signature), (c) => c.charCodeAt(0));
    const sPlusL = sig.slice();
    let s = 0n;
    for (let i = 63; i >= 32; i--) s = (s << 8n) | BigInt(sig[i]!);
    s += L;
    for (let i = 32; i < 64; i++) {
      sPlusL[i] = Number(s & 0xffn);
      s >>= 8n;
    }
    const smallOrderR = sig.slice();
    smallOrderR.set(Point.ZERO.toBytes(), 0); // the identity: order 1
    const cases: [string, string][] = [
      [publicKey, b64(sPlusL)], // S >= L
      [publicKey, b64(smallOrderR)], // small-order R
      [b64(Point.ZERO.toBytes()), signature], // small-order key
      [b64(new Uint8Array(32).fill(0xff)), signature], // non-canonical key
    ];
    for (const [key, sg] of cases) {
      expect(
        await verifySparkleSignature(
          env,
          "djdl",
          input(key, sg, async () => {
            throw new Error("must not fetch");
          }),
        ),
      ).toBe(false);
    }
    expect(kv.keys()).toEqual([]);
  });

  it("a failing KV put does not turn a completed verification into an error", async () => {
    const { publicKey, signature } = await setup(MiB);
    const env = {
      HOT: {
        get: async () => null,
        put: () => {
          throw new Error("KV is down");
        },
      },
    } as unknown as Env;
    await expect(
      verifySparkleSignature(
        env,
        "djdl",
        input(publicKey, signature, serving(newStats(), MiB, String(MiB))),
      ),
    ).resolves.toBe(true);
    const rejecting = {
      HOT: {
        get: async () => null,
        put: async () => Promise.reject(new Error("KV is down")),
      },
    } as unknown as Env;
    await expect(
      verifySparkleSignature(
        rejecting,
        "djdl",
        input(
          publicKey,
          signature,
          serving(newStats(), MiB - 1, String(MiB - 1)),
        ),
      ),
    ).resolves.toBe(false);
  });

  it("finishes the stream and the memo under waitUntil, so an aborted request still memoises", async () => {
    const { env, kv, publicKey, signature } = await setup(MiB);
    const pending: Promise<unknown>[] = [];
    const ok = await verifySparkleSignature(env, "djdl", {
      ...input(publicKey, signature, serving(newStats(), MiB, String(MiB))),
      waitUntil: (p) => pending.push(p),
    });
    expect(ok).toBe(true);
    expect(pending).toHaveLength(1);
    await Promise.all(pending);
    expect(kv.keys()).toHaveLength(1);
  });

  it("does not memoise a verification that broke off mid-stream", async () => {
    const { env, kv, publicKey, signature } = await setup(MiB);
    let pulls = 0;
    const flaky = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            if (pulls++ > 3)
              controller.error(new TypeError("connection reset"));
            else controller.enqueue(new Uint8Array(16 * 1024));
          },
        }),
      );
    expect(
      await verifySparkleSignature(
        env,
        "djdl",
        input(publicKey, signature, flaky),
      ),
    ).toBe(false);
    expect(kv.keys()).toEqual([]);

    // The next request tries again, and a good body verifies.
    expect(
      await verifySparkleSignature(
        env,
        "djdl",
        input(publicKey, signature, serving(newStats(), MiB, String(MiB))),
      ),
    ).toBe(true);
  });
});
