import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  HPKE_KEM_X25519,
  SYNC_LABELS,
  deriveKid,
  encodeRecoveryCode,
  hpkeEncap,
  hpkeKeySchedule,
  hpkeOpen,
  hpkeSeal,
  newRecoveryCode,
  openAdopt,
  parseRecoveryCode,
  sealAdopt,
  unwrapRecovery,
  unwrapRoot,
  webCryptoSyncPort as port,
  wrapInfo,
  wrapRecovery,
  wrapRoot,
  type WrapContext,
} from "../src/sync/index.js";

const hex = (b: Uint8Array) =>
  Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const unhex = (h: string) =>
  Uint8Array.from(h.match(/../g) ?? [], (x) => Number.parseInt(x, 16));
const seq = (n: number, from: number) =>
  new Uint8Array(n).map((_, i) => (from + i) & 0xff);

// The RFC 9180 vector for this suite, vendored for the generator. Its raw-bytes shape is what
// CryptoKit's HPKE exposes (enc, then ciphertext followed by the tag) and what the Swift and
// Kotlin ports will compare against.
const anchor = JSON.parse(
  readFileSync(
    new URL("../../../tools/corpus/inputs/hpke-anchors.json", import.meta.url),
    "utf8",
  ),
).vector as Record<string, string> & {
  encryption: { aad: string; ct: string; nonce: string; pt: string };
};

const root = seq(32, 1);
const ctx: WrapContext = {
  product: "demo",
  deviceId: "dev_abc",
  ringId: "rg_AAAAAAAAAAAAAAAAAAAAAA",
  epoch: 1,
};

describe("HPKE (RFC 9180 mode_base, KEM 0x0020, KDF 0x0001, AEAD 0x0002)", () => {
  it("reproduces the RFC 9180 intermediates and sequence-0 ciphertext", async () => {
    const pkR = unhex(anchor.pkRm!);
    const skE = unhex(anchor.skEm!);
    const encap = await hpkeEncap(port, pkR, skE);
    expect(hex(encap.enc)).toBe(anchor.enc);
    expect(hex(encap.sharedSecret)).toBe(anchor.shared_secret);
    const ks = await hpkeKeySchedule(
      port,
      encap.sharedSecret,
      unhex(anchor.info!),
    );
    expect(hex(ks.key)).toBe(anchor.key);
    expect(hex(ks.nonce)).toBe(anchor.base_nonce);
    expect(anchor.encryption.nonce).toBe(anchor.base_nonce);

    const sealed = await hpkeSeal(
      port,
      pkR,
      unhex(anchor.info!),
      unhex(anchor.encryption.aad),
      unhex(anchor.encryption.pt),
      skE,
    );
    expect(hex(sealed.ct)).toBe(anchor.encryption.ct);
    const pt = await hpkeOpen(
      port,
      unhex(anchor.skRm!),
      sealed.enc,
      unhex(anchor.info!),
      unhex(anchor.encryption.aad),
      sealed.ct,
    );
    expect(hex(pt!)).toBe(anchor.encryption.pt);
  });
});

describe("pkey-sync-wrap/1", () => {
  const skR = seq(32, 100);
  it("lays out info as label, product, deviceId, ringId and a big-endian epoch", () => {
    const info = wrapInfo({ ...ctx, epoch: 0x01020304 });
    const text = new TextDecoder().decode(info.subarray(0, info.length - 4));
    expect(text).toBe(
      "pkey-sync/1 wrap\0demo\0dev_abc\0rg_AAAAAAAAAAAAAAAAAAAAAA\0",
    );
    expect(Array.from(info.subarray(info.length - 4))).toEqual([1, 2, 3, 4]);
  });

  it("wraps and unwraps a root, and is deterministic for a fixed ephemeral key", async () => {
    const pkR = await port.x25519.publicKey(skR);
    const kid = await deriveKid(port, root);
    const a = await wrapRoot(port, pkR, ctx, kid, root, seq(32, 7));
    const b = await wrapRoot(port, pkR, ctx, kid, root, seq(32, 7));
    expect(hex(a.ct)).toBe(hex(b.ct));
    expect(a.kem).toBe(HPKE_KEM_X25519);
    expect(a.ct.length).toBe(48);
    expect(await unwrapRoot(port, skR, ctx, kid, a)).toEqual(root);
    const fresh = await wrapRoot(port, pkR, ctx, kid, root);
    expect(hex(fresh.enc)).not.toBe(hex(a.enc));
    expect(await unwrapRoot(port, skR, ctx, kid, fresh)).toEqual(root);
  });

  it("refuses a wrong key, context, kid, kem, or tampering", async () => {
    const pkR = await port.x25519.publicKey(skR);
    const kid = await deriveKid(port, root);
    const w = await wrapRoot(port, pkR, ctx, kid, root);
    expect(await unwrapRoot(port, seq(32, 3), ctx, kid, w)).toBeNull();
    for (const bad of [
      { ...ctx, product: "other" },
      { ...ctx, deviceId: "dev_x" },
      { ...ctx, ringId: "rg_BBBBBBBBBBBBBBBBBBBBBB" },
      { ...ctx, epoch: 2 },
    ]) {
      expect(await unwrapRoot(port, skR, bad, kid, w)).toBeNull();
    }
    expect(await unwrapRoot(port, skR, ctx, seq(16, 0), w)).toBeNull();
    expect(await unwrapRoot(port, skR, ctx, kid, { ...w, kem: 16 })).toBeNull();
    const ct = w.ct.slice();
    ct[0]! ^= 1;
    expect(await unwrapRoot(port, skR, ctx, kid, { ...w, ct })).toBeNull();
    const enc = w.enc.slice();
    enc[0]! ^= 1;
    expect(await unwrapRoot(port, skR, ctx, kid, { ...w, enc })).toBeNull();
    expect(
      await unwrapRoot(port, skR, ctx, kid, { ...w, enc: w.enc.slice(1) }),
    ).toBeNull();
  });

  it("refuses a low-order recipient key", async () => {
    await expect(
      wrapRoot(port, new Uint8Array(32), ctx, seq(16, 0), root),
    ).rejects.toThrow();
  });
});

describe("recovery code", () => {
  const code = seq(16, 0x10);

  it("encodes 8 hyphenated groups of 4 and parses them back", async () => {
    const text = await encodeRecoveryCode(port, code);
    expect(text).toMatch(/^([0-9A-HJKMNP-TV-Z]{4}-){7}[0-9A-HJKMNP-TV-Z]{4}$/);
    expect(await parseRecoveryCode(port, text)).toEqual(code);
    expect(await parseRecoveryCode(port, text.toLowerCase())).toEqual(code);
    expect(await parseRecoveryCode(port, text.replaceAll("-", " "))).toEqual(
      code,
    );
    expect(await parseRecoveryCode(port, text.replaceAll("-", ""))).toEqual(
      code,
    );
  });

  it("encodes the all-zero code with the checksum of 16 zero bytes", async () => {
    const text = await encodeRecoveryCode(port, new Uint8Array(16));
    expect(text.replaceAll("-", "").slice(0, 26)).toBe("0".repeat(26));
    expect(await parseRecoveryCode(port, text)).toEqual(new Uint8Array(16));
  });

  it("maps I, L to 1 and O to 0, and refuses a bad checksum, length or character", async () => {
    const zero = await encodeRecoveryCode(port, new Uint8Array(16));
    expect(await parseRecoveryCode(port, zero.replaceAll("0", "o"))).toEqual(
      new Uint8Array(16),
    );
    const text = (await encodeRecoveryCode(port, code)).replaceAll("-", "");
    const flipped = (text[0] === "0" ? "1" : "0") + text.slice(1);
    expect(await parseRecoveryCode(port, flipped)).toBeNull();
    expect(await parseRecoveryCode(port, text.slice(1))).toBeNull();
    expect(await parseRecoveryCode(port, `${text}0`)).toBeNull();
    expect(await parseRecoveryCode(port, `U${text.slice(1)}`)).toBeNull();
    expect(await parseRecoveryCode(port, "")).toBeNull();
  });

  it("draws 16 random bytes", () => {
    expect(newRecoveryCode(port).length).toBe(16);
  });

  it("wraps the root under K_rec and unwraps it, bound to ring, epoch and kid", async () => {
    const kid = await deriveKid(port, root);
    const blob = await wrapRecovery(
      port,
      code,
      ctx.ringId,
      1,
      kid,
      root,
      seq(12, 0x40),
    );
    expect(blob.length).toBe(1 + 12 + 32 + 16);
    expect(blob[0]).toBe(1);
    expect(hex(blob.subarray(1, 13))).toBe(hex(seq(12, 0x40)));
    expect(await unwrapRecovery(port, code, ctx.ringId, 1, kid, blob)).toEqual(
      root,
    );
    expect(
      await unwrapRecovery(port, seq(16, 0), ctx.ringId, 1, kid, blob),
    ).toBeNull();
    expect(
      await unwrapRecovery(
        port,
        code,
        "rg_BBBBBBBBBBBBBBBBBBBBBB",
        1,
        kid,
        blob,
      ),
    ).toBeNull();
    expect(
      await unwrapRecovery(port, code, ctx.ringId, 2, kid, blob),
    ).toBeNull();
    expect(
      await unwrapRecovery(port, code, ctx.ringId, 1, seq(16, 0), blob),
    ).toBeNull();
    const v2 = blob.slice();
    v2[0] = 2;
    expect(await unwrapRecovery(port, code, ctx.ringId, 1, kid, v2)).toBeNull();
    expect(
      await unwrapRecovery(port, code, ctx.ringId, 1, kid, blob.slice(1)),
    ).toBeNull();
  });
});

describe("adopt", () => {
  const oldRoot = seq(32, 90);
  it("seals an old root under K_adopt of the new one and opens it", async () => {
    const from = {
      fromRingId: "rg_BBBBBBBBBBBBBBBBBBBBBB",
      epoch: 3,
      kid: await deriveKid(port, oldRoot),
    };
    const blob = await sealAdopt(port, root, from, oldRoot, seq(12, 5));
    expect(await openAdopt(port, root, from, blob)).toEqual(oldRoot);
    expect(await openAdopt(port, oldRoot, from, blob)).toBeNull();
    expect(await openAdopt(port, root, { ...from, epoch: 4 }, blob)).toBeNull();
    expect(
      await openAdopt(port, root, { ...from, fromRingId: ctx.ringId }, blob),
    ).toBeNull();
    // A recovery blob never opens as an adopt blob: the labels differ.
    expect(SYNC_LABELS.adopt).not.toBe(SYNC_LABELS.recovery);
  });
});
