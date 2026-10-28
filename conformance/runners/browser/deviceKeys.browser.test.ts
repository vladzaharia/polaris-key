// The browser device key store in a real engine (CC-26.1): WebCrypto Ed25519 and X25519 keys held
// non-extractable in IndexedDB, signing what the CC-03.4 verifier accepts. Where the engine has no
// Ed25519 or X25519 (Chromium before 137, Firefox before 129, Safari before 17) the suites skip
// with that reason, and the unsupported path is asserted instead.
import { describe, expect, it } from "vitest";
import vectors from "../../corpus/v2/device-proof.json";
import {
  DeviceKeyUnsupportedError,
  buildDeviceKeysRequest,
  createWebDeviceKeyStore,
  deviceProofKeysValue,
  indexedDbDeviceKeyStorage,
  signDeviceProof,
  verifyDeviceProof,
  webCryptoX25519,
} from "@polaris-key/client-core";

const DEVICE = "AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH";

async function hasCurves(): Promise<boolean> {
  try {
    await crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign"]);
    await crypto.subtle.generateKey({ name: "X25519" }, false, ["deriveBits"]);
    return true;
  } catch {
    return false;
  }
}
// Does this engine keep a CryptoKey pair of both curves in IndexedDB? WebKit (Playwright 2359)
// takes the write of an X25519 key and keeps null; there the durable suites skip with that
// reason and the store falls back to memory (asserted below).
async function idbKeepsKeys(): Promise<boolean> {
  try {
    const st = indexedDbDeviceKeyStorage(`pkey-probe-${Date.now()}`);
    const sign = await crypto.subtle.generateKey({ name: "Ed25519" }, false, [
      "sign",
    ]);
    const agree = await crypto.subtle.generateKey({ name: "X25519" }, false, [
      "deriveBits",
    ]);
    await st.put({ v: 1, generation: 1, sign, agree } as never);
    return (await st.get()) !== null;
  } catch {
    return false;
  }
}
const supported = await hasCurves();
const durable = supported && (await idbKeepsKeys());
const run = durable ? describe : describe.skip;
let n = 0;
const dbName = () => `pkey-test-${Date.now()}-${n++}`;

run("browser device key store (IndexedDB)", () => {
  it("persists across store instances without exposing the private keys", async () => {
    const name = dbName();
    const a = createWebDeviceKeyStore({
      storage: indexedDbDeviceKeyStorage(name),
    });
    const k = await a.ensure();
    // A new instance over the same database is the page after a reload.
    const b = createWebDeviceKeyStore({
      storage: indexedDbDeviceKeyStorage(name),
    });
    expect(await b.publicKeys()).toEqual(k);
    const stored = await indexedDbDeviceKeyStorage(name).get();
    expect(stored!.sign.privateKey.extractable).toBe(false);
    expect(stored!.agree.privateKey.extractable).toBe(false);
    await expect(
      crypto.subtle.exportKey("pkcs8", stored!.sign.privateKey),
    ).rejects.toThrow();
    await expect(
      crypto.subtle.exportKey("pkcs8", stored!.agree.privateKey),
    ).rejects.toThrow();
    await b.wipe();
    expect(await a.publicKeys()).toBeNull();
  });

  it("races two tabs to one pair", async () => {
    const name = dbName();
    const [x, y] = await Promise.all([
      createWebDeviceKeyStore({
        storage: indexedDbDeviceKeyStorage(name),
      }).ensure(),
      createWebDeviceKeyStore({
        storage: indexedDbDeviceKeyStorage(name),
      }).ensure(),
    ]);
    expect(x).toEqual(y);
  });

  it("signs a keys proof the verifier accepts and agrees on DH", async () => {
    const s = createWebDeviceKeyStore({
      storage: indexedDbDeviceKeyStorage(dbName()),
    });
    const now = Math.floor(Date.now() / 1000);
    const { body } = await buildDeviceKeysRequest(s, {
      product: "djdl",
      deviceId: DEVICE,
      issuedAt: now,
    });
    expect(
      await verifyDeviceProof(
        {
          purpose: "keys",
          product: "djdl",
          deviceId: DEVICE,
          value: deviceProofKeysValue(body.signKey, body.agreeKey, now),
          tokenHash: "-",
          signKey: body.signKey,
          sig: body.sig,
        },
        { now },
      ),
    ).toBe(true);
    const proof = await signDeviceProof(s, {
      purpose: "nonce",
      product: "djdl",
      deviceId: DEVICE,
      value: "n",
    });
    expect(await verifyDeviceProof(proof)).toBe(true);

    const peerPriv = crypto.getRandomValues(new Uint8Array(32));
    const peerPub = await webCryptoX25519.publicKey(peerPriv);
    const mine = await s.dh(peerPub);
    const agree = Uint8Array.from(
      atob(body.agreeKey.replace(/-/g, "+").replace(/_/g, "/") + "="),
      (c) => c.charCodeAt(0),
    );
    expect(mine).toEqual(await webCryptoX25519.dh(peerPriv, agree));
    expect(vectors.line1).toBe("pkey-proof/1");
  });

  it("rotates in the database", async () => {
    const name = dbName();
    const s = createWebDeviceKeyStore({
      storage: indexedDbDeviceKeyStorage(name),
    });
    const a = await s.ensure();
    const b = await s.rotate();
    expect(b.generation).toBe(2);
    expect(
      await createWebDeviceKeyStore({
        storage: indexedDbDeviceKeyStorage(name),
      }).publicKeys(),
    ).toEqual(b);
    expect(b.signKey).not.toBe(a.signKey);
  });
});

describe("browser device key store (fallbacks)", () => {
  it("default storage works and says where the keys live", async () => {
    const s = createWebDeviceKeyStore();
    if (!supported) {
      await expect(s.ensure()).rejects.toBeInstanceOf(
        DeviceKeyUnsupportedError,
      );
      return;
    }
    const k = await s.ensure();
    // Where IndexedDB keeps the keys they are durable; where it does not, memory-only.
    expect(await s.persistence()).toBe(durable ? "durable" : "memory");
    expect(await s.ensure()).toEqual(k);
    await s.wipe();
  });

  it("falls back to memory when IndexedDB cannot open", async () => {
    if (!supported) return;
    const real = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
    Object.defineProperty(globalThis, "indexedDB", {
      configurable: true,
      value: {
        open: () => {
          throw new Error("blocked");
        },
      },
    });
    try {
      const s = createWebDeviceKeyStore();
      const k = await s.ensure();
      expect(await s.persistence()).toBe("memory");
      expect(await s.ensure()).toEqual(k);
    } finally {
      if (real) Object.defineProperty(globalThis, "indexedDB", real);
    }
  });

  it("an explicit storage that fails is the host's to see", async () => {
    if (!supported) return;
    const dead = {
      open: () => {
        throw new Error("blocked");
      },
    } as unknown as IDBFactory;
    const s = createWebDeviceKeyStore({
      storage: indexedDbDeviceKeyStorage(dbName(), dead),
    });
    await expect(s.ensure()).rejects.toThrow();
  });
});
