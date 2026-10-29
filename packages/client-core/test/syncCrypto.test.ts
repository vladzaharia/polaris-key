import { describe, expect, it } from "vitest";
import {
  SYNC_LABELS,
  blind,
  canonicalJson,
  deriveCollKey,
  deriveKid,
  deriveValueKey,
  isBlindedName,
  openValue,
  sealValue,
  webCryptoSyncPort as port,
  type SyncJson,
} from "../src/sync/index.js";

const root = new Uint8Array(32).map((_, i) => i + 1);
const otherRoot = new Uint8Array(32).map((_, i) => 200 - i);
const salt = new Uint8Array(16).map((_, i) => 0xa0 + i);
const hex = (b: Uint8Array) =>
  Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

const seal = (v: SyncJson = "dark") =>
  sealValue(port, root, "$settings", "theme", v, salt);
const open = (e: Uint8Array, name = "theme", aliases: string[] = []) =>
  openValue(port, root, "$settings", name, e, aliases);

describe("SyncCryptoPort on WebCrypto", () => {
  it("hkdf with an empty salt equals a zero salt of the hash length", async () => {
    const info = new TextEncoder().encode("x");
    expect(hex(await port.hkdf(root, new Uint8Array(0), info, 32))).toBe(
      hex(await port.hkdf(root, new Uint8Array(32), info, 32)),
    );
  });

  it("aes-gcm round-trips and refuses a wrong key, nonce, aad or tampering", async () => {
    const key = root;
    const nonce = new Uint8Array(12);
    const aad = Uint8Array.of(1, 2);
    const ct = await port.aesGcmSeal(key, nonce, aad, Uint8Array.of(9, 8));
    expect(ct.length).toBe(2 + 16);
    expect(await port.aesGcmOpen(key, nonce, aad, ct)).toEqual(
      Uint8Array.of(9, 8),
    );
    expect(await port.aesGcmOpen(otherRoot, nonce, aad, ct)).toBeNull();
    expect(
      await port.aesGcmOpen(key, nonce, Uint8Array.of(1, 3), ct),
    ).toBeNull();
    const bad = ct.slice();
    bad[0]! ^= 1;
    expect(await port.aesGcmOpen(key, nonce, aad, bad)).toBeNull();
  });

  it("x25519 agrees from both sides", async () => {
    const a = root;
    const b = otherRoot;
    const pa = await port.x25519.publicKey(a);
    const pb = await port.x25519.publicKey(b);
    expect(hex((await port.x25519.dh(a, pb))!)).toBe(
      hex((await port.x25519.dh(b, pa))!),
    );
  });

  it("hmac and sha256 match known answers", async () => {
    expect(hex(await port.sha256(new TextEncoder().encode("abc")))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    // RFC 4231 test case 2.
    expect(
      hex(
        await port.hmac(
          new TextEncoder().encode("Jefe"),
          new TextEncoder().encode("what do ya want for nothing?"),
        ),
      ),
    ).toBe("5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843");
  });
});

describe("labels and derivations", () => {
  it("keeps the ASCII labels", () => {
    expect(SYNC_LABELS.kid).toBe("pkey-sync/1 kid");
    expect(SYNC_LABELS.coll).toBe("pkey-sync/1 coll");
    expect(SYNC_LABELS.chunkId).toBe("pkey-sync/1 chunk-id");
  });

  it("scopes by collection and by salt", async () => {
    const a = await deriveCollKey(port, root, "a");
    const b = await deriveCollKey(port, root, "b");
    expect(hex(a)).not.toBe(hex(b));
    expect(hex(await deriveValueKey(port, a, salt))).not.toBe(
      hex(await deriveValueKey(port, a, new Uint8Array(16))),
    );
    expect((await deriveKid(port, root)).length).toBe(16);
  });
});

describe("pkey-sync-value/1", () => {
  it("round-trips with a random salt, and two seals differ", async () => {
    const a = await sealValue(port, root, "saves", "s1", { b: [1, null] });
    const b = await sealValue(port, root, "saves", "s1", { b: [1, null] });
    expect(hex(a)).not.toBe(hex(b));
    expect(await openValue(port, root, "saves", "s1", a)).toEqual({
      ok: true,
      name: "s1",
      value: { b: [1, null] },
    });
  });

  it("pads to a multiple of 64 with at least one byte", async () => {
    for (const len of [0, 1, 20, 21, 22, 60, 100]) {
      const e = await seal("x".repeat(len));
      expect((e.length - 49) % 64).toBe(0);
      expect(e.length).toBeGreaterThanOrEqual(113);
      expect((await open(e)).ok).toBe(true);
    }
  });

  it("rejects a salt of the wrong length", async () => {
    await expect(
      sealValue(port, root, "$settings", "k", 1, new Uint8Array(15)),
    ).rejects.toThrow(RangeError);
  });

  it("checks shape, then version, kid, auth in that order", async () => {
    const e = await seal();
    const bad = (mutate: (b: Uint8Array) => void, trim = 0) => {
      const b = e.slice(0, e.length - trim);
      mutate(b);
      return b;
    };
    // Every defect at once: the shape check answers first.
    expect(
      await open(
        bad((b) => {
          b[0] = 2;
          b[1]! ^= 1;
          b[40]! ^= 1;
        }, 1),
      ),
    ).toEqual({ ok: false, reason: "shape" });
    // Version, kid and ciphertext wrong: the version answers.
    expect(
      await open(
        bad((b) => {
          b[0] = 2;
          b[1]! ^= 1;
          b[40]! ^= 1;
        }),
      ),
    ).toEqual({ ok: false, reason: "version" });
    // Kid and ciphertext wrong: the kid answers, before any decryption.
    expect(
      await open(
        bad((b) => {
          b[1]! ^= 1;
          b[40]! ^= 1;
        }),
      ),
    ).toEqual({ ok: false, reason: "kid" });
    expect(
      await open(
        bad((b) => {
          b[40]! ^= 1;
        }),
      ),
    ).toEqual({ ok: false, reason: "auth" });
    // Another root has another kid.
    expect(await openValue(port, otherRoot, "$settings", "theme", e)).toEqual({
      ok: false,
      reason: "kid",
    });
  });

  it("refuses the wrong collection, and a name that is not the expected one or an alias", async () => {
    const e = await seal();
    expect(await openValue(port, root, "saves", "theme", e)).toEqual({
      ok: false,
      reason: "auth",
    });
    expect(await open(e, "language")).toEqual({ ok: false, reason: "name" });
    expect(await open(e, "language", ["theme"])).toEqual({
      ok: true,
      name: "theme",
      value: "dark",
    });
  });

  it("refuses padding and JSON defects in an authentic envelope, padding first", async () => {
    // Build authentic envelopes around hand-made plaintext by reusing the seal path's keys.
    const kid = await deriveKid(port, root);
    const key = await deriveValueKey(
      port,
      await deriveCollKey(port, root, "$settings"),
      salt,
    );
    const header = new Uint8Array(33);
    header[0] = 1;
    header.set(kid, 1);
    header.set(salt, 17);
    const make = async (p: Uint8Array) => {
      const ct = await port.aesGcmSeal(key, new Uint8Array(12), header, p);
      return Uint8Array.from([...header, ...ct]);
    };
    const padded = (text: string, fill: (b: Uint8Array) => void) => {
      const t = new TextEncoder().encode(text);
      const b = new Uint8Array(64);
      b.set(t);
      fill(b);
      return b;
    };
    const ok = '{"k":"theme","v":1}';
    // Not JSON and not padded either: padding answers first.
    expect(
      await open(await make(padded("not json", (b) => (b[63] = 1)))),
    ).toEqual({ ok: false, reason: "padding" });
    expect(
      await open(
        await make(
          padded(ok, (b) => {
            b[ok.length] = 0x80;
            b[63] = 7;
          }),
        ),
      ),
    ).toEqual({ ok: false, reason: "padding" });
    expect(await open(await make(padded(ok, () => undefined)))).toEqual({
      ok: false,
      reason: "padding",
    });
    for (const text of [
      "not json",
      '{"k":"theme"}',
      '{"k":1,"v":1}',
      '{"k":"theme","v":1,"z":1}',
      '["theme",1]',
    ]) {
      expect(
        await open(await make(padded(text, (b) => (b[text.length] = 0x80)))),
      ).toEqual({ ok: false, reason: "json" });
    }
    expect(
      await open(await make(padded(ok, (b) => (b[ok.length] = 0x80)))),
    ).toEqual({ ok: true, name: "theme", value: 1 });
  });
});

describe("canonicalJson", () => {
  it("sorts keys at every level and keeps text as UTF-8", () => {
    expect(
      canonicalJson({ z: 1, a: [true, null, "é"], m: { b: 2, a: 1 } }),
    ).toBe('{"a":[true,null,"é"],"m":{"a":1,"b":2},"z":1}');
  });

  it("refuses a number that is not finite and a lone surrogate", () => {
    for (const bad of [NaN, Infinity, -Infinity, "\ud800", [{ "\udc00": 1 }]])
      expect(() => canonicalJson(bad as never)).toThrow(RangeError);
    expect(canonicalJson("\ud83d\ude00")).toBe('"\u{1F600}"');
  });

  it("pins the lone-surrogate boundary (start, middle, end, doubled, reversed)", () => {
    const bad = [
      "\udc00",
      "a\udc00",
      "\udc00a",
      "\ud800a",
      "a\ud800",
      "\ud800\ud800",
      "\udc00\udc00",
      "\ud83d\ude00\udc00",
      "\ud83d\ude00\ud83d",
      "\ude00\ud83d",
    ];
    for (const s of bad) expect(() => canonicalJson(s)).toThrow(RangeError);
    const good = [
      "",
      "a",
      "\ud83d\ude00",
      "x\ud83d\ude00y",
      "\ud83d\ude00\ud83d\ude00",
    ];
    for (const s of good) expect(canonicalJson(s)).toBe(JSON.stringify(s));
  });
});

describe("blind", () => {
  it("is deterministic, shaped, and separated by kind, context and name", async () => {
    const a = await blind(port, root, "record", "saves", "slot-1");
    expect(a).toBe(await blind(port, root, "record", "saves", "slot-1"));
    expect(isBlindedName(a)).toBe(true);
    const others = [
      await blind(port, root, "field", "saves", "slot-1"),
      await blind(port, root, "record", "autosaves", "slot-1"),
      await blind(port, root, "record", "saves", "slot-2"),
      await blind(port, otherRoot, "record", "saves", "slot-1"),
      // The NUL framing: a shifted boundary is another name.
      await blind(port, root, "record", "save", "s\0slot-1"),
    ];
    for (const o of others) expect(o).not.toBe(a);
  });

  it("isBlindedName refuses declared names and wrong lengths", () => {
    expect(isBlindedName("theme")).toBe(false);
    expect(isBlindedName("x:abc")).toBe(false);
    expect(isBlindedName(`x:${"A".repeat(43)}`)).toBe(true);
    expect(isBlindedName(`x:${"A".repeat(44)}`)).toBe(false);
  });
});
