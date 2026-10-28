// @vitest-environment node
//
// @pkey-feature sync.keyring
//
// U-38.2: the browser key ring engine against a small fake of the Worker's /devices/keyring routes
// (real crypto, no mocks of it): create, unlock from this device's wrap, wrap to another device,
// recover with the code, set a new code, reset and adopt, the lock, the memory-only browser, the
// non-extractable root, the derived codec keys, the typed N/A on the other transports, and the
// hooks. The seven keyring-* transcripts replay through the same engine in transcripts.test.ts.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createWebDeviceKeyStore,
  memoryDeviceKeyStorage,
  type DeviceKeyPort,
} from "@polaris-key/client-core";
import {
  deriveCollKey,
  deriveKid,
  deriveNamesKey,
  openAdopt,
  unwrapRootWithDh,
  webCryptoSyncPort as P,
} from "@polaris-key/client-core/sync";
import { RingEngine } from "../src/browser/ring/engine.js";
import {
  indexedDbRootVault,
  memoryRootVault,
  type RootVault,
} from "../src/browser/ring/rootVault.js";
import { UnsupportedError } from "../src/core/caps.js";
import { PolarisError } from "../src/core/types.js";
import { bindRingToMachine, lazyKeyring } from "../src/core/keyring.js";
import { browserAdapter } from "../src/browser/browserAdapter.js";
import { DesktopAdapter } from "../src/desktop/desktopAdapter.js";
import { makeFakeBridge, okBridgeState } from "./fixtures.js";

afterEach(() => {
  vi.useRealTimers();
});

// ── A fake of the Worker's key ring ──────────────────────────────────────────────────────────

interface Wrap {
  epoch: number;
  kid: string;
  kem: string;
  enc: string;
  ct: string;
  by: string;
}
class FakeRingServer {
  ring: {
    ringId: string;
    epoch: number;
    rootKid: string;
    recoveryCt: string | null;
    previous: string | null;
    adopted: { ringId: string; epoch: number; kid: string; ct: string }[];
  } | null = null;
  wraps = new Map<string, Wrap>();
  log: { method: string; path: string; body: unknown }[] = [];
  recoveryReads = 0;

  transport(deviceId: string) {
    return {
      request: async (
        path: string,
        init: { method: string; body?: string },
      ): Promise<Response> => {
        const body = init.body ? JSON.parse(init.body) : undefined;
        this.log.push({ method: init.method, path, body });
        const res = (status: number, b?: unknown) =>
          new Response(b === undefined ? null : JSON.stringify(b), { status });
        const r = this.ring;
        if (path === "devices/keyring" && init.method === "GET")
          return res(200, {
            ring: r && {
              ringId: r.ringId,
              epoch: r.epoch,
              rootKid: r.rootKid,
              state: "active",
              createdAt: 1,
              recovery: { set: r.recoveryCt !== null, createdAt: 1 },
              adopted: r.adopted,
              ...(r.previous
                ? {
                    previous: {
                      ringId: r.previous,
                      kid: "0".repeat(32),
                      until: 9,
                    },
                  }
                : {}),
            },
            wrap: r ? (this.wraps.get(deviceId) ?? null) : null,
          });
        if (path === "devices/keyring" || path === "devices/keyring/reset") {
          const reset = path.endsWith("reset");
          if (r && !reset)
            return res(409, { error: { code: "keyring_conflict" } });
          this.ring = {
            ringId: body.ringId,
            epoch: 1,
            rootKid: body.rootKid,
            recoveryCt: body.recovery?.ct ?? null,
            previous: r?.ringId ?? null,
            adopted: [],
          };
          this.wraps = new Map([
            [
              deviceId,
              { epoch: 1, kid: body.rootKid, by: deviceId, ...body.wrap },
            ],
          ]);
          return res(201, { ringId: body.ringId, epoch: 1 });
        }
        if (path.startsWith("devices/keyring/wraps/")) {
          const target = decodeURIComponent(path.split("/").pop()!);
          if (init.method === "DELETE") {
            if (target !== deviceId)
              return res(403, { error: { code: "forbidden" } });
            this.wraps.delete(target);
            return res(204);
          }
          if (this.wraps.has(target))
            return res(409, { error: { code: "keyring_conflict" } });
          this.wraps.set(target, { ...body, by: deviceId });
          return res(204);
        }
        if (path === "devices/keyring/recovery" && init.method === "PUT") {
          this.ring!.recoveryCt = body.ct;
          return res(204);
        }
        if (path === "devices/keyring/recovery") {
          this.recoveryReads += 1;
          if (!r?.recoveryCt) return res(404, { error: "not_found" });
          return res(200, { ct: r.recoveryCt, epoch: r.epoch, kid: r.rootKid });
        }
        if (path === "devices/keyring/adopt") {
          this.ring!.adopted.push(body);
          return res(204);
        }
        return res(404, { error: "not_found" });
      },
    };
  }
}

const durableKeys = (): DeviceKeyPort =>
  createWebDeviceKeyStore({ storage: memoryDeviceKeyStorage() });
const memoryOnlyKeys = (): DeviceKeyPort => ({
  ...durableKeys(),
  persistence: () => "memory",
});

interface Device {
  id: string;
  engine: RingEngine;
  keys: DeviceKeyPort;
  vault: RootVault;
}
function device(
  server: FakeRingServer,
  id: string,
  o: {
    keys?: DeviceKeyPort;
    vault?: RootVault;
    now?: () => number;
    sessionRootSeconds?: number;
  } = {},
): Device {
  const keys = o.keys ?? durableKeys();
  const vault = o.vault ?? memoryRootVault();
  const engine = new RingEngine({
    product: "djdl",
    deviceId: () => id,
    transport: server.transport(id),
    keys,
    vault,
    ...(o.now ? { now: o.now } : {}),
    ...(o.sessionRootSeconds
      ? { sessionRootSeconds: o.sessionRootSeconds }
      : {}),
  });
  return { id, engine, keys, vault };
}
const A = "DEVICEAAAAAAAAAAAAAAAAAAAAAAAAAA";
const B = "DEVICEBBBBBBBBBBBBBBBBBBBBBBBBBB";

const b64dec = (s: string) =>
  Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) =>
    c.charCodeAt(0),
  );
const unhex = (h: string) =>
  Uint8Array.from(h.match(/../g)!, (x) => parseInt(x, 16));

/** The raw root, opened from device `d`'s wrap with its own agreement key (a test-only view). */
async function rootOfWrap(server: FakeRingServer, d: Device) {
  const w = server.wraps.get(d.id)!;
  const pub = (await d.keys.publicKeys())!;
  return (await unwrapRootWithDh(
    P,
    { publicKey: b64dec(pub.agreeKey), dh: (peer) => d.keys.dh(peer) },
    {
      product: "djdl",
      deviceId: d.id,
      ringId: server.ring!.ringId,
      epoch: server.ring!.epoch,
    },
    unhex(w.kid),
    { kem: 0x20, enc: b64dec(w.enc), ct: b64dec(w.ct) },
  ))!;
}

const hexOf = (b: Uint8Array) =>
  [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

describe("create and unlock", () => {
  it("creates a ring with a wrap and a code that unlocks a second browser", async () => {
    const server = new FakeRingServer();
    const a = device(server, A);
    expect((await a.engine.status()).state).toBe("none");
    const made = await a.engine.create();
    expect(made.recoveryCode).toMatch(/^([0-9A-Z]{4}-){7}[0-9A-Z]{4}$/);
    expect(made.epoch).toBe(1);
    expect(a.engine.hasRoot()).toBe(true);
    // The server holds ciphertext and the string KEM, and the ring's kid is the root's.
    expect(server.wraps.get(A)).toMatchObject({ kem: 32, epoch: 1 });
    expect(server.ring!.rootKid).toMatch(/^[0-9a-f]{32}$/);

    const b = device(server, B);
    const first = await b.engine.status();
    expect(first.state).toBe("locked");
    await expect(
      b.engine.recover("0000-0000-0000-0000-0000-0000-0000-0000"),
    ).rejects.toMatchObject({ code: "recovery-code-invalid" });
    const s = await b.engine.recover(
      made.recoveryCode.toLowerCase().replace(/-/g, " "),
    );
    expect(s.state).toBe("unlocked");
    expect(b.engine.hasRoot()).toBe(true);
    // Both browsers derive the same sealing keys from the same root.
    const ka = await a.engine.ringKeys();
    const kb = await b.engine.ringKeys();
    expect(kb!.kid).toBe(server.ring!.rootKid);
    expect(await kb!.collKey("$settings")).toEqual(
      await ka!.collKey("$settings"),
    );
    expect(await kb!.namesKey()).toEqual(await ka!.namesKey());
    expect(await kb!.chunkIdKey("saves")).toEqual(
      await ka!.chunkIdKey("saves"),
    );
    expect(await kb!.collKey("saves")).not.toEqual(
      await kb!.collKey("$settings"),
    );
    // A browser that can keep keys deposited its own wrap: a fresh engine over the same vault and
    // keys unlocks without the code.
    expect(server.wraps.get(B)).toBeDefined();
    const b2 = device(server, B, { keys: b.keys, vault: memoryRootVault() });
    expect((await b2.engine.status()).state).toBe("unlocked");
  });

  it("derives the same keys as client-core does from the raw root", async () => {
    const server = new FakeRingServer();
    const a = device(server, A);
    // Make the ring through the engine, then rebuild the root's keys through the wrap.
    await a.engine.create();
    const root = await rootOfWrap(server, a);
    expect(hexOf(await deriveKid(P, root))).toBe(server.ring!.rootKid);
    const keys = (await a.engine.ringKeys())!;
    expect(await keys.collKey("c")).toEqual(await deriveCollKey(P, root, "c"));
    expect(await keys.namesKey()).toEqual(await deriveNamesKey(P, root));
  });

  it("opens only a wrap for the ring's own root and epoch", async () => {
    const server = new FakeRingServer();
    const a = device(server, A);
    await a.engine.create();
    server.ring!.rootKid = "f".repeat(32); // a server that lies about the root
    server.wraps.get(A)!.kid = "f".repeat(32);
    const again = device(server, A, { keys: a.keys });
    expect((await again.engine.status()).state).toBe("locked");
    expect(again.engine.hasRoot()).toBe(false);
  });

  it("a second create is keyring_conflict and keeps the first root", async () => {
    const server = new FakeRingServer();
    const a = device(server, A);
    await a.engine.create();
    const kid = server.ring!.rootKid;
    await expect(a.engine.create()).rejects.toMatchObject({
      wireCode: "keyring_conflict",
      status: 409,
    });
    expect(server.ring!.rootKid).toBe(kid);
    expect((await a.engine.ringKeys())!.kid).toBe(kid);
  });
});

describe("the recovery code", () => {
  it("never appears in an error, and a bad checksum costs no request", async () => {
    const server = new FakeRingServer();
    const a = device(server, A);
    const { recoveryCode } = await a.engine.create();
    const b = device(server, B);
    const before = server.log.length;
    const bad =
      recoveryCode.slice(0, -1) + (recoveryCode.endsWith("0") ? "1" : "0");
    const e = (await b.engine.recover(bad).then(
      () => null,
      (x: unknown) => x,
    )) as PolarisError;
    expect(e).toBeInstanceOf(PolarisError);
    expect(e.code).toBe("recovery-code-invalid");
    expect(JSON.stringify([e.message, e.wireCode, e.detail])).not.toContain(
      bad.replace(/-/g, ""),
    );
    expect(server.log.length).toBe(before);
  });

  it("a wrong code with a valid checksum reads the blob once per page", async () => {
    const server = new FakeRingServer();
    const a = device(server, A);
    await a.engine.create();
    const other = await (async () => {
      const x = device(new FakeRingServer(), "X");
      return (await x.engine.create()).recoveryCode;
    })();
    const b = device(server, B);
    for (let i = 0; i < 3; i += 1)
      await expect(b.engine.recover(other)).rejects.toMatchObject({
        code: "recovery-code-invalid",
      });
    expect(server.recoveryReads).toBe(1);
  });

  it("sets a new code that unlocks, and the old code stops working", async () => {
    const server = new FakeRingServer();
    const a = device(server, A);
    const first = await a.engine.create();
    const next = await a.engine.setRecoveryCode();
    expect(next.recoveryCode).not.toBe(first.recoveryCode);
    const b = device(server, B);
    await expect(b.engine.recover(first.recoveryCode)).rejects.toMatchObject({
      code: "recovery-code-invalid",
    });
    const c = device(server, "DEVICECCCCCCCCCCCCCCCCCCCCCCCCCC");
    expect((await c.engine.recover(next.recoveryCode)).state).toBe("unlocked");
  });
});

describe("wrapping to another device", () => {
  it("delivers the root to a device that registered an agreement key", async () => {
    const server = new FakeRingServer();
    const a = device(server, A);
    await a.engine.create();
    const b = device(server, B);
    const pub = (await b.keys.ensure()).agreeKey;
    await a.engine.wrapTo(B, pub);
    expect(server.wraps.get(B)).toMatchObject({ by: A, kem: 32 });
    expect((await b.engine.status()).state).toBe("unlocked");
    await expect(a.engine.wrapTo(B, pub)).rejects.toMatchObject({
      wireCode: "keyring_conflict",
    });
    await expect(a.engine.wrapTo(B, new Uint8Array(5))).rejects.toBeInstanceOf(
      PolarisError,
    );
    await b.engine.removeWrap(B);
    expect(server.wraps.has(B)).toBe(false);
  });
});

describe("the root in the browser", () => {
  it("is a non-extractable key, and its bytes leave memory after the window", async () => {
    let now = 1_000_000;
    const server = new FakeRingServer();
    const vault = memoryRootVault();
    const a = device(server, A, {
      vault,
      now: () => now,
      sessionRootSeconds: 60,
    });
    await a.engine.create();
    const rec = (await vault.get())!;
    expect(rec.key.extractable).toBe(false);
    expect(rec.key.algorithm.name).toBe("HKDF");
    await expect(crypto.subtle.exportKey("raw", rec.key)).rejects.toBeTruthy();
    // Inside the window the bytes serve a wrap and a new code.
    await a.engine.setRecoveryCode();
    now += 61_000;
    for (const f of [
      () => a.engine.setRecoveryCode(),
      () => a.engine.wrapTo(B, new Uint8Array(32).fill(9)),
    ])
      await expect(f()).rejects.toBeInstanceOf(UnsupportedError);
    // The handle still derives: the codec keeps working.
    expect((await a.engine.ringKeys())!.kid).toBe(server.ring!.rootKid);
    expect(a.engine.hasRoot()).toBe(true);
  });

  it("codec() is null while locked, seals under the vault root, and refuses once locked (U-20.1)", async () => {
    const server = new FakeRingServer();
    const a = device(server, A);
    expect(a.engine.codec()).toBeNull();
    await a.engine.create();
    const codec = a.engine.codec()!;
    expect(codec.locked).toBe(false);
    const env = await codec.seal("$settings", "k", { n: 1 });
    const keys = (await a.engine.ringKeys())!;
    expect(hexOf(env.subarray(1, 17))).toBe(keys.kid);
    expect(await codec.open("$settings", "k", env)).toEqual({
      ok: true,
      name: "k",
      value: { n: 1 },
    });
    // A second browser with the same ring (recovery) opens it.
    const lazy = lazyKeyring(async () => a.engine);
    expect(lazy.codec()).toBeNull(); // the engine is not loaded: nothing pulled in
    await lazy.status();
    expect(lazy.codec()).toBe(codec);
    await a.engine.lock();
    expect(a.engine.codec()).toBeNull();
    expect(codec.locked).toBe(true);
    await expect(codec.seal("$settings", "k", 1)).rejects.toMatchObject({
      code: "sync-locked",
    });
  });

  it("lock() forgets the root and tells subscribers", async () => {
    const server = new FakeRingServer();
    const a = device(server, A);
    await a.engine.create();
    const seen: boolean[] = [];
    const off = a.engine.subscribe(() => seen.push(a.engine.hasRoot()));
    await a.engine.lock();
    off();
    expect(seen).toEqual([false]);
    expect(await a.engine.ringKeys()).toBeNull();
    await expect(a.engine.setRecoveryCode()).rejects.toBeInstanceOf(
      UnsupportedError,
    );
  });

  it("drives the sync machine's lock", async () => {
    const server = new FakeRingServer();
    const a = device(server, A);
    const calls: boolean[] = [];
    const off = bindRingToMachine(a.engine, { setRoot: (p) => calls.push(p) });
    await a.engine.create();
    await a.engine.lock();
    off();
    expect(calls).toEqual([false, true, false]);
  });

  it("is kept in IndexedDB, and a store that keeps nothing degrades to memory", async () => {
    const { IDBFactory } = await import("fake-indexeddb");
    const server = new FakeRingServer();
    const idb = new IDBFactory();
    const vault = indexedDbRootVault("t-ring", idb);
    const a = device(server, A, { vault });
    await a.engine.create();
    expect(vault.persistence()).toBe("durable");
    // A new page: the same database still holds the handle.
    const page2 = indexedDbRootVault("t-ring", idb);
    expect((await page2.get())!.kid).toBe(server.ring!.rootKid);
    await page2.clear();
    expect(await indexedDbRootVault("t-ring", idb).get()).toBeNull();
    // An engine that accepts the write and keeps nothing.
    const lossy = indexedDbRootVault("t-lossy", {
      open: () => {
        throw new Error("no storage");
      },
    } as unknown as IDBFactory);
    const c = device(new FakeRingServer(), "C", { vault: lossy });
    await c.engine.create();
    expect(lossy.persistence()).toBe("memory");
    expect(c.engine.hasRoot()).toBe(true);
  });
});

describe("a browser that cannot keep its device keys (WebKit)", () => {
  it("cannot create or reset, unlocks with the code, and never persists the root", async () => {
    const server = new FakeRingServer();
    const a = device(server, A);
    const { recoveryCode } = await a.engine.create();

    const durable = memoryRootVault();
    const put = vi.spyOn(durable, "put");
    const w = device(server, B, { keys: memoryOnlyKeys(), vault: durable });
    const status = await w.engine.status();
    expect(status).toMatchObject({
      state: "locked",
      persistence: "memory",
      canCreate: false,
    });
    await expect(w.engine.create()).rejects.toMatchObject({
      unsupported: { feature: "sync.keyring", reason: "runtime" },
    });
    await expect(w.engine.reset()).rejects.toBeInstanceOf(UnsupportedError);
    const s = await w.engine.recover(recoveryCode);
    expect(s).toMatchObject({
      state: "unlocked",
      persistence: "memory",
      canCreate: false,
    });
    // The root lives in the memory vault only, and no wrap was deposited for the ephemeral key.
    expect(put).not.toHaveBeenCalled();
    expect(server.wraps.has(B)).toBe(false);
    expect(server.log.some((l) => l.path.includes("wraps/" + B))).toBe(false);
    // The next load starts locked again.
    const reload = device(server, B, {
      keys: memoryOnlyKeys(),
      vault: durable,
    });
    expect((await reload.engine.status()).state).toBe("locked");
  });

  it("a host with no key store cannot create either", async () => {
    const e = new RingEngine({
      product: "djdl",
      deviceId: () => A,
      transport: new FakeRingServer().transport(A),
      keys: null,
      vault: memoryRootVault(),
    });
    await expect(e.create()).rejects.toBeInstanceOf(UnsupportedError);
  });
});

describe("start over", () => {
  it("makes a new ring, keeps the old one and adopts its root under the new one", async () => {
    const server = new FakeRingServer();
    const a = device(server, A);
    await a.engine.create();
    const oldId = server.ring!.ringId;
    const oldKid = server.ring!.rootKid;
    const made = await a.engine.reset();
    expect(server.ring!.previous).toBe(oldId);
    expect(server.ring!.rootKid).not.toBe(oldKid);
    expect(made.recoveryCode).toMatch(/^[0-9A-Z-]+$/);
    await a.engine.adoptPrevious();
    const posted = server.ring!.adopted[0]!;
    expect(posted).toMatchObject({ fromRingId: oldId, epoch: 1, kid: oldKid });
    expect(posted.ct.length).toBe(82); // 61 bytes, base64url
    // Only the holder of the new root opens the sealed old one, and it is the old root.
    const fresh = await rootOfWrap(server, a);
    const old = await openAdopt(
      P,
      fresh,
      {
        fromRingId: oldId,
        epoch: 1,
        kid: unhex(oldKid),
      },
      b64dec(posted.ct),
    );
    expect(hexOf(await deriveKid(P, old!))).toBe(oldKid);
  });

  it("adopt without an earlier root held is the typed N/A", async () => {
    const server = new FakeRingServer();
    const a = device(server, A);
    await a.engine.create();
    await expect(a.engine.adoptPrevious()).rejects.toBeInstanceOf(
      UnsupportedError,
    );
  });
});

describe("the pin: a changed ring is never adopted silently", () => {
  /** The victim (B) holds ring 1. An attacker's device resets the ring and wraps its own root to
   *  the victim's agreement key. */
  async function attacked() {
    const server = new FakeRingServer();
    const vault = memoryRootVault();
    const victim = device(server, B, { vault });
    const made = await victim.engine.create();
    const oldKid = server.ring!.rootKid;
    const oldRing = server.ring!.ringId;
    const attacker = device(server, A);
    await attacker.engine.reset();
    await attacker.engine.wrapTo(B, (await victim.keys.publicKeys())!.agreeKey);
    // The victim's page loads again over the same vault and keys.
    const reload = device(server, B, { keys: victim.keys, vault });
    return { server, vault, victim, reload, made, oldKid, oldRing, attacker };
  }

  it("leaves the victim at ring-changed with its stored root intact", async () => {
    const { server, vault, reload, oldKid, oldRing } = await attacked();
    const s = await reload.engine.status();
    expect(s.state).toBe("ring-changed");
    expect(s.changed).toMatchObject({
      pinned: { ringId: oldRing, rootKid: oldKid },
      served: { ringId: server.ring!.ringId, rootKid: server.ring!.rootKid },
    });
    expect(reload.engine.hasRoot()).toBe(false);
    // Nothing was overwritten: the vault still holds the old root, and the pin is unchanged.
    expect((await vault.get())!.kid).toBe(oldKid);
    expect((await vault.getPin())!.ringId).toBe(oldRing);
  });

  it("a wrong code does not touch it; the code of the new ring re-pins", async () => {
    const { server, vault, reload, made, oldKid } = await attacked();
    await reload.engine.status();
    // The attacker's ring has no blob the victim's code opens.
    await expect(
      reload.engine.recover(made.recoveryCode),
    ).rejects.toMatchObject({ code: "recovery-code-invalid" });
    expect((await vault.get())!.kid).toBe(oldKid);
    // The person starts over from another device of theirs and gets a code for the new ring.
    const other = device(server, "DEVICECCCCCCCCCCCCCCCCCCCCCCCCCC");
    const fresh = await other.engine.reset();
    const s = await reload.engine.recover(fresh.recoveryCode);
    expect(s.state).toBe("unlocked");
    expect((await vault.getPin())!.ringId).toBe(fresh.ringId);
    expect((await vault.get())!.kid).toBe(server.ring!.rootKid);
    expect((await reload.engine.status()).state).toBe("unlocked");
  });

  it("acceptRingChange() re-pins after the person confirms", async () => {
    const { server, vault, reload } = await attacked();
    expect((await reload.engine.status()).state).toBe("ring-changed");
    const served = server.ring!;
    const shown = {
      ringId: served.ringId,
      epoch: served.epoch,
      rootKid: served.rootKid,
    };
    // The served ring switches between the prompt and the accept: refused, nothing changes.
    server.ring = { ...served, rootKid: "e".repeat(32) };
    expect((await reload.engine.acceptRingChange(shown)).state).toBe(
      "ring-changed",
    );
    expect((await vault.getPin())!.ringId).not.toBe(served.ringId);
    server.ring = served;
    const s = await reload.engine.acceptRingChange(shown);
    expect(s.state).toBe("unlocked");
    expect((await vault.getPin())!.ringId).toBe(server.ring!.ringId);
    expect((await reload.engine.status()).state).toBe("unlocked");
  });

  it("an accept whose wrap does not open keeps the old root and the old pin", async () => {
    const { server, vault, reload, oldKid, oldRing } = await attacked();
    const status = await reload.engine.status();
    server.wraps.get(B)!.ct = "AAAA"; // a wrap that will not open
    const s = await reload.engine.acceptRingChange(status.changed!.served);
    expect(s.state).toBe("ring-changed");
    expect((await vault.get())!.kid).toBe(oldKid);
    expect((await vault.getPin())!.ringId).toBe(oldRing);
  });

  it("another epoch or root kid for the same ring id is not adopted either", async () => {
    const server = new FakeRingServer();
    const vault = memoryRootVault();
    const a = device(server, A, { vault });
    await a.engine.create();
    server.ring!.epoch = 2;
    expect((await a.engine.status()).state).toBe("ring-changed");
    server.ring!.epoch = 1;
    server.ring!.rootKid = "f".repeat(32);
    expect((await a.engine.status()).state).toBe("ring-changed");
  });

  it("a reset by this device re-pins itself", async () => {
    const server = new FakeRingServer();
    const vault = memoryRootVault();
    const a = device(server, A, { vault });
    await a.engine.create();
    const fresh = await a.engine.reset();
    expect((await vault.getPin())!.ringId).toBe(fresh.ringId);
    expect((await a.engine.status()).state).toBe("unlocked");
  });

  it("a root stored before pins existed pins itself on the first status", async () => {
    const server = new FakeRingServer();
    const vault = memoryRootVault();
    const a = device(server, A, { vault });
    await a.engine.create();
    await vault.clearPin();
    expect((await a.engine.status()).state).toBe("unlocked");
    expect(await vault.getPin()).not.toBeNull();
    // And a pinless vault root against a different served ring is a change, not an overwrite.
    await vault.clearPin();
    server.ring!.ringId = "rg_" + "Z".repeat(22);
    expect((await a.engine.status()).state).toBe("ring-changed");
  });

  it("status() with no ring never clears the stored root", async () => {
    const server = new FakeRingServer();
    const vault = memoryRootVault();
    const a = device(server, A, { vault });
    await a.engine.create();
    const ring = server.ring;
    server.ring = null;
    expect((await a.engine.status()).state).toBe("none");
    expect(await vault.get()).not.toBeNull();
    expect(a.engine.hasRoot()).toBe(true);
    server.ring = ring;
    expect((await a.engine.status()).state).toBe("unlocked");
  });

  it("keeps the pin in IndexedDB beside the root", async () => {
    const { IDBFactory } = await import("fake-indexeddb");
    const idb = new IDBFactory();
    const server = new FakeRingServer();
    const a = device(server, A, { vault: indexedDbRootVault("t-pin", idb) });
    const made = await a.engine.create();
    const page2 = indexedDbRootVault("t-pin", idb);
    expect(await page2.getPin()).toMatchObject({ ringId: made.ringId });
    await page2.clear();
    expect(await page2.getPin()).not.toBeNull();
    await page2.clearPin();
    expect(await indexedDbRootVault("t-pin", idb).getPin()).toBeNull();
  });

  it("forget() (sign-out) locks, clears the vault and drops the pin", async () => {
    const server = new FakeRingServer();
    const vault = memoryRootVault();
    const a = device(server, A, { vault });
    await a.engine.create();
    await a.engine.forget();
    expect(a.engine.hasRoot()).toBe(false);
    expect(await vault.get()).toBeNull();
    expect(await vault.getPin()).toBeNull();
  });
});

describe("the other transports", () => {
  it("a cookie page answers the typed runtime N/A on every verb", async () => {
    const adapter = browserAdapter({
      productSlug: "djdl",
      baseUrl: "https://key.plrs.im",
      fetchImpl: (async () =>
        new Response("{}", { status: 404 })) as typeof fetch,
      autoStart: false,
    });
    const ring = adapter.keyring;
    expect(ring.unsupported).toMatchObject({
      feature: "sync.keyring",
      reason: "runtime",
    });
    for (const f of [
      () => ring.status(),
      () => ring.create(),
      () => ring.recover("x"),
      () => ring.reset(),
      () => ring.lock(),
      () => ring.forget(),
      () => ring.acceptRingChange({ ringId: "rg_x", epoch: 1, rootKid: "0" }),
    ])
      await expect(f()).rejects.toMatchObject({
        name: "UnsupportedError",
        feature: "sync.keyring",
      });
    expect(ring.hasRoot()).toBe(false);
    expect(ring.codec()).toBeNull();
  });

  it("the desktop bridge answers the typed version N/A (no ring verb yet)", async () => {
    const adapter = new DesktopAdapter({
      bridge: makeFakeBridge(okBridgeState()),
    });
    expect(adapter.keyring.unsupported).toMatchObject({
      feature: "sync.keyring",
      reason: "version",
    });
    await expect(adapter.keyring.status()).rejects.toBeInstanceOf(
      UnsupportedError,
    );
  });
});
