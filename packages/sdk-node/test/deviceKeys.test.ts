// @pkey-feature core.devicekeys
// The Node device key store (CC-26.2): the same rules as client-core's web store and the Kotlin
// JVM store: one pair on first need, an unreadable record is an error and only `wipe()` resets
// it, a refused path is an error and never "no keys", the lock stops a second pair, the private
// halves are in no return value, and memory-only keys refuse registration.

import { createPublicKey, diffieHellman, verify } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { base64UrlDecode } from "@polaris-key/jws";
import {
  DeviceKeyUnsupportedError,
  buildDeviceKeysRequest,
  deviceProofKeysValue,
  signDeviceProof,
  verifyDeviceProof,
} from "@polaris-key/client-core";
import {
  DeviceKeyStoreError,
  DeviceKeysUnreadableError,
  FileDeviceKeyStorage,
  createNodeDeviceKeyStore,
} from "../src/devices/deviceKeys.js";

const NOW = 1_700_000_000;
const DEVICE = "AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH";
const posix = process.platform !== "win32";
const tmp = (): string => mkdtempSync(join(tmpdir(), "pkey-keys-"));
const fileStore = (dir: string) =>
  createNodeDeviceKeyStore({
    storage: new FileDeviceKeyStorage(join(dir, "state", "device-keys.json")),
  });
const recordPath = (dir: string) => join(dir, "state", "device-keys.json");

describe("node device key store", () => {
  it("makes one pair on first need and keeps it", async () => {
    const dir = tmp();
    const s = fileStore(dir);
    expect(await s.publicKeys()).toBeNull();
    const [a, ...rest] = await Promise.all([
      s.ensure(),
      s.ensure(),
      s.ensure(),
    ]);
    for (const r of rest) expect(r).toEqual(a);
    expect(a.generation).toBe(1);
    for (const half of [a.signKey, a.agreeKey])
      expect(base64UrlDecode(half)).toHaveLength(32);
    // A new store over the same file (a restart) sees the same keys.
    expect(await fileStore(dir).ensure()).toEqual(a);
    expect(await s.persistence()).toBe("durable");
  });

  it("returns no private half from any member", async () => {
    const dir = tmp();
    const s = fileStore(dir);
    const k = await s.ensure();
    const rec = JSON.parse(readFileSync(recordPath(dir), "utf8")) as {
      sign: { seed: string };
      agree: { priv: string };
    };
    const sig = await s.sign(new Uint8Array(3));
    const out = JSON.stringify([k, await s.rotate(), Array.from(sig)]);
    expect(out).not.toContain(rec.sign.seed);
    expect(out).not.toContain(rec.agree.priv);
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

  it("signs what a verifier accepts, only for the public key", async () => {
    const s = fileStore(tmp());
    const k = await s.ensure();
    const msg = new TextEncoder().encode("hello");
    const sig = await s.sign(msg);
    expect(sig).toHaveLength(64);
    const pub = createPublicKey({
      key: { kty: "OKP", crv: "Ed25519", x: k.signKey },
      format: "jwk",
    });
    expect(verify(null, msg, pub, sig)).toBe(true);
    expect(verify(null, new Uint8Array(1), pub, sig)).toBe(false);
  });

  it("refuses to sign before ensure()", async () => {
    await expect(fileStore(tmp()).sign(new Uint8Array(1))).rejects.toThrow();
  });

  it("derives the peer's secret, refuses low-order peers", async () => {
    const s = fileStore(tmp());
    const k = await s.ensure();
    const { generateKeyPairSync } = await import("node:crypto");
    const peer = generateKeyPairSync("x25519");
    const peerPub = new Uint8Array(
      base64UrlDecode(peer.publicKey.export({ format: "jwk" }).x as string),
    );
    const mine = await s.dh(peerPub);
    const mineKey = createPublicKey({
      key: { kty: "OKP", crv: "X25519", x: k.agreeKey },
      format: "jwk",
    });
    const theirs = diffieHellman({
      privateKey: peer.privateKey,
      publicKey: mineKey,
    });
    expect(mine).not.toBeNull();
    expect(Buffer.from(mine!).equals(theirs)).toBe(true);
    const lowOrder = [
      new Uint8Array(32),
      Uint8Array.of(1, ...Array(31).fill(0)),
    ];
    for (const bad of [...lowOrder, new Uint8Array(31)])
      expect(await s.dh(bad)).toBeNull();
    expect(await fileStore(tmp()).dh(peerPub)).toBeNull(); // no keys yet
  });

  it("rotates, never regresses the generation, and wipes", async () => {
    const dir = tmp();
    const s = fileStore(dir);
    const a = await s.ensure();
    const b = await s.rotate();
    expect(b.generation).toBe(2);
    expect(b.signKey).not.toBe(a.signKey);
    // Another process over the same file (a different path spelling: its own mutex).
    const other = createNodeDeviceKeyStore({
      storage: new FileDeviceKeyStorage(
        join(dir, "state", ".", "device-keys.json"),
      ),
    });
    const [c, d] = await Promise.all([s.rotate(), other.rotate()]);
    expect([c.generation, d.generation].sort()).toEqual([3, 4]);
    await s.wipe();
    expect(existsSync(recordPath(dir))).toBe(false);
    expect(await s.publicKeys()).toBeNull();
    expect((await s.ensure()).generation).toBe(1);
  });

  it("two processes never make two pairs", async () => {
    const dir = tmp();
    const stores = [0, 1, 2, 3].map((i) =>
      createNodeDeviceKeyStore({
        storage: new FileDeviceKeyStorage(
          join(dir, "state", ...Array(i).fill("."), "device-keys.json"),
        ),
      }),
    );
    const keys = await Promise.all(stores.map((s) => s.ensure()));
    for (const k of keys) expect(k).toEqual(keys[0]);
  });

  it("holds an owner-only file in an owner-only directory, no leftovers", async () => {
    const dir = tmp();
    const s = fileStore(dir);
    await s.ensure();
    await s.rotate();
    if (posix) {
      expect(statSync(recordPath(dir)).mode & 0o777).toBe(0o600);
      expect(statSync(join(dir, "state")).mode & 0o777).toBe(0o700);
    }
    expect(
      readdirSync(join(dir, "state")).filter((n) => n.endsWith(".tmp")),
    ).toEqual([]);
    await s.wipe();
    expect(
      readdirSync(join(dir, "state")).filter((n) => n.endsWith(".tmp")),
    ).toEqual([]);
  });

  it("clears stale temp files holding key bytes on write and wipe", async () => {
    const dir = tmp();
    const s = fileStore(dir);
    await s.ensure();
    const stale = join(dir, "state", ".device-keys.json.deadbeef.tmp");
    writeFileSync(stale, "secret-bytes", { mode: 0o600 });
    await s.rotate();
    expect(existsSync(stale)).toBe(false);
  });
});

describe("node device key store: unreadable and refused", () => {
  const plant = async (dir: string, text: string) => {
    const s = fileStore(dir);
    await s.ensure();
    writeFileSync(recordPath(dir), text, { mode: 0o600 });
    return s;
  };

  it("an unreadable record is an error, kept, and only wipe() resets it", async () => {
    for (const bad of ["not json", "{}", '{"v":1,"generation":1}', "\u0000"]) {
      const dir = tmp();
      const s = await plant(dir, bad);
      for (const call of [
        () => s.publicKeys(),
        () => s.ensure(),
        () => s.rotate(),
        () => s.sign(new Uint8Array(1)),
        () => s.dh(new Uint8Array(32).fill(9)),
      ])
        await expect(call()).rejects.toBeInstanceOf(DeviceKeysUnreadableError);
      expect(readFileSync(recordPath(dir), "utf8")).toBe(bad); // never replaced
      await s.wipe();
      expect((await s.ensure()).generation).toBe(1);
    }
  });

  it("a record whose public halves do not match is unreadable", async () => {
    const dir = tmp();
    const s = fileStore(dir);
    await s.ensure();
    const a = JSON.parse(readFileSync(recordPath(dir), "utf8"));
    const other = tmp();
    const o = fileStore(other);
    await o.ensure();
    const b = JSON.parse(readFileSync(recordPath(other), "utf8"));
    a.sign.pub = b.sign.pub;
    writeFileSync(recordPath(dir), JSON.stringify(a), { mode: 0o600 });
    await expect(s.ensure()).rejects.toBeInstanceOf(DeviceKeysUnreadableError);
  });

  it("an unreadable record's error text names no key or content", async () => {
    const dir = tmp();
    const s = await plant(dir, '{"v":1,"secret":"SENTINEL-TEXT" oops');
    const e = await s.ensure().catch((x: Error) => x);
    expect(String((e as Error).message)).not.toContain("SENTINEL");
  });

  it.runIf(posix)("refuses a record file others can read", async () => {
    const dir = tmp();
    const s = fileStore(dir);
    const before = await s.ensure();
    chmodSync(recordPath(dir), 0o644);
    await expect(s.publicKeys()).rejects.toBeInstanceOf(DeviceKeyStoreError);
    await expect(s.ensure()).rejects.toBeInstanceOf(DeviceKeyStoreError);
    chmodSync(recordPath(dir), 0o600);
    expect(await s.publicKeys()).toEqual(before);
  });

  it.runIf(posix)("refuses a directory others can write", async () => {
    const dir = tmp();
    const s = fileStore(dir);
    await s.ensure();
    chmodSync(join(dir, "state"), 0o777);
    await expect(s.ensure()).rejects.toBeInstanceOf(DeviceKeyStoreError);
    await expect(s.wipe()).rejects.toBeInstanceOf(DeviceKeyStoreError);
    chmodSync(join(dir, "state"), 0o700);
    expect(await s.publicKeys()).not.toBeNull();
  });

  it.runIf(posix)(
    "refuses a symlink in place of the file or the directory",
    async () => {
      const dir = tmp();
      const real = join(dir, "real.json");
      writeFileSync(real, "x", { mode: 0o600 });
      mkdirSync(join(dir, "state"), { mode: 0o700 });
      symlinkSync(real, recordPath(dir));
      const s = fileStore(dir);
      await expect(s.ensure()).rejects.toBeInstanceOf(DeviceKeyStoreError);
      await expect(s.publicKeys()).rejects.toBeInstanceOf(DeviceKeyStoreError);
      expect(readFileSync(real, "utf8")).toBe("x");

      const dir2 = tmp();
      mkdirSync(join(dir2, "elsewhere"), { mode: 0o700 });
      symlinkSync(join(dir2, "elsewhere"), join(dir2, "state"));
      await expect(fileStore(dir2).ensure()).rejects.toBeInstanceOf(
        DeviceKeyStoreError,
      );
    },
  );

  it.runIf(posix && process.getuid?.() !== 0)(
    "an unreadable file is a fault, never an empty store",
    async () => {
      const dir = tmp();
      const s = fileStore(dir);
      await s.ensure();
      chmodSync(recordPath(dir), 0o000);
      await expect(s.publicKeys()).rejects.toBeInstanceOf(DeviceKeyStoreError);
      await expect(s.ensure()).rejects.toBeInstanceOf(DeviceKeyStoreError);
      chmodSync(recordPath(dir), 0o600);
      expect(await s.publicKeys()).not.toBeNull();
    },
  );

  it("a record over the cap is unreadable, not read", async () => {
    const dir = tmp();
    const s = await plant(dir, "x".repeat(70_000));
    await expect(s.ensure()).rejects.toBeInstanceOf(DeviceKeysUnreadableError);
  });

  const deadLock = async (dir: string, ageSeconds: number) => {
    const os = await import("node:os");
    const lock = join(dir, "state", ".device-keys.json.lock");
    writeFileSync(
      lock,
      JSON.stringify({ pid: 2 ** 22 + 12345, host: os.hostname(), token: "x" }),
      { mode: 0o600 },
    );
    const t = new Date(Date.now() - ageSeconds * 1000);
    utimesSync(lock, t, t);
    return lock;
  };

  it("reclaims an expired lock, and leaves a young one to its holder", async () => {
    const dir = tmp();
    const s = fileStore(dir);
    await s.ensure();
    const lock = await deadLock(dir, 60);
    expect(await s.publicKeys()).not.toBeNull();
    expect(existsSync(lock)).toBe(false);
    // A young lock (even with a dead pid and no boot id) is waited on, not taken.
    const young = await deadLock(dir, 1);
    const busy = createNodeDeviceKeyStore({
      storage: new FileDeviceKeyStorage(join(dir, "state", "device-keys.json")),
    });
    const t0 = Date.now();
    const p = busy.publicKeys();
    setTimeout(() => rmSync(young), 300);
    await p;
    expect(Date.now() - t0).toBeGreaterThanOrEqual(250);
  });

  it("three contenders on an expired lock make one pair and contiguous generations", async () => {
    const dir = tmp();
    mkdirSync(join(dir, "state"), { mode: 0o700 });
    await deadLock(dir, 60);
    const stores = [0, 1, 2].map((i) =>
      createNodeDeviceKeyStore({
        storage: new FileDeviceKeyStorage(
          join(dir, "state", ...Array(i).fill("."), "device-keys.json"),
        ),
      }),
    );
    const made = await Promise.all(stores.map((s) => s.ensure()));
    for (const k of made) expect(k).toEqual(made[0]);
    await deadLock(dir, 60);
    const gens = await Promise.all(stores.map((s) => s.rotate()));
    expect(gens.map((g) => g.generation).sort()).toEqual([2, 3, 4]);
    expect(readdirSync(join(dir, "state")).sort()).toEqual([
      "device-keys.json",
    ]);
  });

  it.runIf(posix)(
    "refuses a directory with any group or other bit",
    async () => {
      const dir = tmp();
      const s = fileStore(dir);
      await s.ensure();
      chmodSync(join(dir, "state"), 0o750);
      await expect(s.ensure()).rejects.toBeInstanceOf(DeviceKeyStoreError);
      chmodSync(join(dir, "state"), 0o700);
      expect(await s.publicKeys()).not.toBeNull();
    },
  );

  it.runIf(posix)(
    "refuses a world-writable ancestor without the sticky bit",
    async () => {
      const dir = tmp();
      const open = join(dir, "open");
      mkdirSync(open, { mode: 0o700 });
      chmodSync(open, 0o777);
      const s = createNodeDeviceKeyStore({
        storage: new FileDeviceKeyStorage(
          join(open, "state", "device-keys.json"),
        ),
      });
      await expect(s.ensure()).rejects.toBeInstanceOf(DeviceKeyStoreError);
      chmodSync(open, 0o1777); // sticky: the usual /tmp shape
      expect((await s.ensure()).generation).toBe(1);
    },
  );
});

describe("node device key store: memory and registration", () => {
  it("memory keys are not durable and refuse registration", async () => {
    const s = createNodeDeviceKeyStore({ memory: true });
    const k = await s.ensure();
    expect(await s.ensure()).toEqual(k);
    expect(s.persistence()).toBe("memory");
    const o = { product: "djdl", deviceId: DEVICE, issuedAt: NOW };
    await expect(buildDeviceKeysRequest(s, o)).rejects.toBeInstanceOf(
      DeviceKeyUnsupportedError,
    );
    const ok = await buildDeviceKeysRequest(s, { ...o, allowEphemeral: true });
    expect(ok.body.signKey).toBe(k.signKey);
    expect((await s.rotate()).generation).toBe(2);
    await s.wipe();
    expect(await s.publicKeys()).toBeNull();
  });

  it("builds the PUT body the Worker checks, and signs every proof", async () => {
    const s = fileStore(tmp());
    const { path, body } = await buildDeviceKeysRequest(s, {
      product: "djdl",
      deviceId: DEVICE,
      issuedAt: NOW,
    });
    expect(path).toBe("/djdl/devices/keys");
    expect(
      await verifyDeviceProof(
        {
          purpose: "keys",
          product: "djdl",
          deviceId: DEVICE,
          value: deviceProofKeysValue(body.signKey, body.agreeKey, NOW),
          tokenHash: "-",
          signKey: body.signKey,
          sig: body.sig,
        },
        { now: NOW },
      ),
    ).toBe(true);
    const proof = await signDeviceProof(s, {
      purpose: "nonce",
      product: "djdl",
      deviceId: DEVICE,
      value: "x",
    });
    expect(await verifyDeviceProof(proof)).toBe(true);
  });
});
