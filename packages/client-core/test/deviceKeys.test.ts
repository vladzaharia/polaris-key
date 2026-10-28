import { describe, expect, it } from "vitest";
import { base64UrlDecode, base64UrlEncodeBytes } from "@polaris-key/jws";
import {
  DeviceKeyUnsupportedError,
  DeviceProofError,
  buildDeviceKeysRequest,
  createWebDeviceKeyStore,
  deviceProofKeysValue,
  deviceProofMessage,
  memoryDeviceKeyStorage,
  signDeviceProof,
  signKeysProof,
  verifyDeviceProof,
  webCryptoX25519,
  type DeviceKeyPort,
  type DeviceKeyStorage,
} from "../src/index.js";

const NOW = 1_700_000_000;
const DEVICE = "AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH";
const newStore = (storage: DeviceKeyStorage = memoryDeviceKeyStorage()) =>
  createWebDeviceKeyStore({ storage });

describe("web device key store", () => {
  it("makes one pair on first need and keeps it", async () => {
    const s = newStore();
    expect(await s.publicKeys()).toBeNull();
    const [a, b] = await Promise.all([s.ensure(), s.ensure()]);
    expect(a).toEqual(b);
    expect(a.generation).toBe(1);
    expect(base64UrlDecode(a.signKey)).toHaveLength(32);
    expect(base64UrlDecode(a.agreeKey)).toHaveLength(32);
    expect(await s.ensure()).toEqual(a);
    expect(await s.publicKeys()).toEqual(a);
  });

  it("two stores over one storage agree (the tabs race)", async () => {
    const storage = memoryDeviceKeyStorage();
    const [a, b] = await Promise.all([
      newStore(storage).ensure(),
      newStore(storage).ensure(),
    ]);
    expect(a).toEqual(b);
  });

  it("holds non-extractable private keys that cannot be read back", async () => {
    const storage = memoryDeviceKeyStorage();
    const s = newStore(storage);
    await s.ensure();
    const rec = (await storage.get())!;
    expect(rec.sign.privateKey.extractable).toBe(false);
    expect(rec.agree.privateKey.extractable).toBe(false);
    for (const k of [rec.sign.privateKey, rec.agree.privateKey])
      for (const fmt of ["pkcs8", "raw", "jwk"] as const)
        await expect(crypto.subtle.exportKey(fmt, k)).rejects.toThrow();
    // No member of the port returns a private half.
    expect(Object.keys(s).sort()).toEqual(
      [
        "dh",
        "ensure",
        "persistence",
        "publicKeys",
        "rotate",
        "sign",
        "wipe",
      ].sort(),
    );
  });

  it("signs what the CC-03.4 verifier accepts, and only for the public key", async () => {
    const s = newStore();
    const k = await s.ensure();
    const msg = new TextEncoder().encode("hello");
    const sig = await s.sign(msg);
    expect(sig).toHaveLength(64);
    const pub = await crypto.subtle.importKey(
      "raw",
      base64UrlDecode(k.signKey) as BufferSource,
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    expect(
      await crypto.subtle.verify(
        { name: "Ed25519" },
        pub,
        sig as BufferSource,
        msg as BufferSource,
      ),
    ).toBe(true);
  });

  it("refuses to sign before ensure()", async () => {
    await expect(newStore().sign(new Uint8Array(1))).rejects.toThrow();
  });

  it("derives the same secret as the peer, refuses low-order peers", async () => {
    const s = newStore();
    const k = await s.ensure();
    const peerPriv = crypto.getRandomValues(new Uint8Array(32));
    const peerPub = await webCryptoX25519.publicKey(peerPriv);
    const mine = await s.dh(peerPub);
    const theirs = await webCryptoX25519.dh(
      peerPriv,
      base64UrlDecode(k.agreeKey),
    );
    expect(mine).not.toBeNull();
    expect(mine).toEqual(theirs);
    expect(await s.dh(new Uint8Array(32))).toBeNull(); // all-zero point
    const one = new Uint8Array(32);
    one[0] = 1;
    expect(await s.dh(one)).toBeNull(); // order 4
    expect(await s.dh(new Uint8Array(31))).toBeNull();
    expect(await newStore().dh(peerPub)).toBeNull(); // no keys yet
  });

  it("rotates to a new pair and wipes", async () => {
    const s = newStore();
    const a = await s.ensure();
    const b = await s.rotate();
    expect(b.generation).toBe(2);
    expect(b.signKey).not.toBe(a.signKey);
    expect(b.agreeKey).not.toBe(a.agreeKey);
    expect(await s.ensure()).toEqual(b);
    await s.wipe();
    expect(await s.publicKeys()).toBeNull();
    const c = await s.ensure();
    expect(c.generation).toBe(1);
    expect(c.signKey).not.toBe(b.signKey);
  });

  it("replaces a stored record it cannot use", async () => {
    const storage = memoryDeviceKeyStorage();
    await storage.put({ v: 1, generation: 1 } as never);
    const s = newStore(storage);
    expect(await s.publicKeys()).toBeNull();
    const k = await s.ensure();
    expect(await s.publicKeys()).toEqual(k);
  });
});

describe("web device key store fallbacks", () => {
  it("falls back to memory when IndexedDB is absent (the default storage)", async () => {
    const s = createWebDeviceKeyStore();
    const k = await s.ensure();
    expect(await s.persistence()).toBe("memory");
    expect(await s.ensure()).toEqual(k);
  });

  it("does not hide a failing explicit storage", async () => {
    const broken: DeviceKeyStorage = {
      get: async () => null,
      putIfAbsent: async () => {
        throw new DOMException("no clone", "DataCloneError");
      },
      put: async () => {
        throw new Error("no");
      },
      clear: async () => undefined,
    };
    // An explicit storage is the host's: its failure is the host's to see.
    await expect(newStore(broken).ensure()).rejects.toThrow();
  });

  it("reports unsupported where WebCrypto has no Ed25519 or X25519", async () => {
    const noCurve = {
      generateKey: async () => {
        throw new DOMException("unsupported", "NotSupportedError");
      },
    } as unknown as SubtleCrypto;
    const s = createWebDeviceKeyStore({
      subtle: noCurve,
      storage: memoryDeviceKeyStorage(),
    });
    await expect(s.ensure()).rejects.toBeInstanceOf(DeviceKeyUnsupportedError);
    expect(await s.publicKeys()).toBeNull();
  });

  it("refuses an engine that hands out extractable private keys", async () => {
    const real = crypto.subtle;
    const leaky = new Proxy(real, {
      get(t, p) {
        if (p === "generateKey")
          return async (alg: Algorithm, _x: boolean, use: KeyUsage[]) =>
            real.generateKey(alg, true, use);
        const v = Reflect.get(t, p) as unknown;
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
    const s = createWebDeviceKeyStore({
      subtle: leaky,
      storage: memoryDeviceKeyStorage(),
    });
    await expect(s.ensure()).rejects.toBeInstanceOf(DeviceKeyUnsupportedError);
  });
});

describe("proof signer", () => {
  it("signs every purpose and the CC-03.4 verifier accepts it", async () => {
    const s = newStore();
    for (const purpose of [
      "nonce",
      "exchange",
      "link",
      "nearby-start",
      "nearby-poll",
      "nearby-approve",
      "vouch",
      "restore",
    ] as const) {
      const proof = await signDeviceProof(s, {
        purpose,
        product: "djdl",
        deviceId: DEVICE,
        value: "v-" + purpose,
        tokenHash: "Zm9v",
      });
      expect(await verifyDeviceProof(proof)).toBe(true);
      // Another purpose, product, device or hash does not carry the signature over.
      expect(await verifyDeviceProof({ ...proof, purpose: "keys" })).toBe(
        false,
      );
      expect(await verifyDeviceProof({ ...proof, product: "other" })).toBe(
        false,
      );
      expect(
        await verifyDeviceProof({
          ...proof,
          deviceId: DEVICE.replace("A", "B"),
        }),
      ).toBe(false);
      expect(await verifyDeviceProof({ ...proof, tokenHash: "-" })).toBe(false);
    }
  });

  it("signs the exact message bytes", async () => {
    const s = newStore();
    const seen: Uint8Array[] = [];
    const spy: DeviceKeyPort = {
      ...s,
      ensure: () => s.ensure(),
      publicKeys: () => s.publicKeys(),
      sign: (m) => (seen.push(m), s.sign(m)),
    };
    const f = {
      purpose: "link" as const,
      product: "djdl",
      deviceId: DEVICE,
      value: "abc",
      tokenHash: "-",
    };
    await signDeviceProof(spy, f);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual(deviceProofMessage(f));
    expect(new TextDecoder().decode(seen[0])).toBe(
      `pkey-proof/1\nlink\ndjdl\n${DEVICE}\nabc\n-`,
    );
  });

  it("refuses a field that breaks the line format", async () => {
    const s = newStore();
    for (const bad of ["a\nb", "", "a b", "é"])
      await expect(
        signDeviceProof(s, {
          purpose: "nonce",
          product: "djdl",
          deviceId: DEVICE,
          value: bad,
        }),
      ).rejects.toBeInstanceOf(DeviceProofError);
  });

  it("refuses when the keys change while signing", async () => {
    const s = newStore();
    const racy: DeviceKeyPort = {
      ...s,
      ensure: () => s.ensure(),
      publicKeys: () => s.publicKeys(),
      sign: async (m) => {
        const sig = await s.sign(m);
        await s.rotate();
        return sig;
      },
    };
    await expect(
      signDeviceProof(racy, {
        purpose: "nonce",
        product: "djdl",
        deviceId: DEVICE,
        value: "x",
      }),
    ).rejects.toBeInstanceOf(DeviceProofError);
  });

  it("refuses a port whose signature does not verify", async () => {
    const s = newStore();
    const liar: DeviceKeyPort = {
      ...s,
      ensure: () => s.ensure(),
      publicKeys: () => s.publicKeys(),
      sign: async () => new Uint8Array(64),
    };
    await expect(
      signDeviceProof(liar, {
        purpose: "nonce",
        product: "djdl",
        deviceId: DEVICE,
        value: "x",
      }),
    ).rejects.toBeInstanceOf(DeviceProofError);
  });

  it("builds the keys proof and the PUT body the Worker checks", async () => {
    const s = newStore();
    const k = await s.ensure();
    const { path, body } = await buildDeviceKeysRequest(s, {
      product: "djdl",
      deviceId: DEVICE,
      issuedAt: NOW,
    });
    expect(path).toBe("/djdl/devices/keys");
    expect(Object.keys(body).sort()).toEqual(
      ["agreeKey", "issuedAt", "sig", "signKey"].sort(),
    );
    expect(body.signKey).toBe(k.signKey);
    expect(body.agreeKey).toBe(k.agreeKey);
    expect(body.issuedAt).toBe(NOW);
    const proof = {
      purpose: "keys" as const,
      product: "djdl",
      deviceId: DEVICE,
      value: deviceProofKeysValue(body.signKey, body.agreeKey, body.issuedAt),
      tokenHash: "-",
      signKey: body.signKey,
      sig: body.sig,
    };
    expect(await verifyDeviceProof(proof, { now: NOW })).toBe(true);
    expect(await verifyDeviceProof(proof, { now: NOW + 301 })).toBe(false);
    expect(base64UrlDecode(body.sig)).toHaveLength(64);
  });

  it("keys proof for a rotated pair names the new keys", async () => {
    const s = newStore();
    await s.ensure();
    const b = await s.rotate();
    const r = await signKeysProof(s, {
      product: "djdl",
      deviceId: DEVICE,
      issuedAt: NOW,
    });
    expect(r.keys).toEqual(b);
    expect(r.proof.signKey).toBe(b.signKey);
    expect(base64UrlEncodeBytes(base64UrlDecode(r.proof.sig))).toBe(
      r.proof.sig,
    );
  });
});
