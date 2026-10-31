// @vitest-environment node
//
// @pkey-feature sync.keyring sync.saves
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
    ...(o.sessionRootSeconds !== undefined
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

describe("sessionRootSeconds", () => {
  const delayFor = async (secs?: number) => {
    const spy = vi.spyOn(globalThis, "setTimeout");
    try {
      const d = device(new FakeRingServer(), A, {
        ...(secs === undefined ? {} : { sessionRootSeconds: secs }),
      });
      await d.engine.create();
      return spy.mock.calls
        .map((c) => c[1])
        .filter((ms) => typeof ms === "number" && ms >= 60_000);
    } finally {
      spy.mockRestore();
    }
  };
  it("clamps 901 to 900, keeps 900 and the default", async () => {
    expect(await delayFor(901)).toContain(900_000);
    expect(await delayFor(900)).toContain(900_000);
    expect(await delayFor(60)).toContain(60_000);
    expect(await delayFor()).toContain(300_000);
  });
  it.each([NaN, Infinity, 0, -1, "600" as unknown as number])(
    "an invalid sessionRootSeconds (%s) is raised by the ring verbs, before any request",
    async (v) => {
      const server = new FakeRingServer();
      const d = device(server, A, { sessionRootSeconds: v }); // construction does not throw
      const bad = { code: "invalid-options" };
      for (const f of [
        () => d.engine.status(),
        () => d.engine.inspect(),
        () => d.engine.create(),
        () => d.engine.reset(),
        () => d.engine.adoptPrevious(),
        () => d.engine.recover("X"),
        () => d.engine.getRecoveryBlob(),
        () => d.engine.setRecoveryCode(),
        () => d.engine.wrapTo(B, new Uint8Array(32)),
        () => d.engine.removeWrap(B),
        () =>
          d.engine.acceptRingChange({ ringId: "r", epoch: 1, rootKid: "0" }),
      ])
        await expect(f()).rejects.toMatchObject(bad);
      expect(server.log).toEqual([]);
    },
  );
  it.each([NaN, Infinity, 0, -1, "600" as unknown as number])(
    "sign-out removes the stored root and its pin when sessionRootSeconds is invalid (%s)",
    async (v) => {
      const server = new FakeRingServer();
      const vault = memoryRootVault();
      await device(server, A, { vault }).engine.create();
      expect(await vault.get()).not.toBeNull();
      const bad = device(server, A, { vault, sessionRootSeconds: v });
      const lazy = lazyKeyring(async () => bad.engine);
      server.log.length = 0;
      await lazy.forget();
      expect(await vault.get()).toBeNull();
      expect(await vault.getPin()).toBeNull();
      await expect(lazy.create()).rejects.toMatchObject({
        code: "invalid-options",
      });
      expect(server.log).toEqual([]);
    },
  );
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

  it("the file codec derives from the vault root and refuses sync-locked on every method and stream piece once the ring locks (SAVES.R)", async () => {
    const server = new FakeRingServer();
    const a = device(server, A);
    expect(await a.engine.fileCodec("saves")).toBeNull();
    await a.engine.create();
    const codec = (await a.engine.fileCodec("saves"))!;
    expect(codec.enc).toBe("e2e");
    const plain = Uint8Array.from({ length: 64 }, (_, i) => i);
    const id = await codec.chunkId(plain);
    const object = await codec.sealChunk(id, plain);
    expect(await codec.openChunk(id, object)).toMatchObject({ ok: true });
    const manifest = await codec.sealManifest(plain);
    const pieces = async function* () {
      for (let i = 0; i < 4; i++) yield plain;
    };
    const sealed: Uint8Array[] = [];
    for await (const p of codec.sealStream(pieces())) sealed.push(p);
    expect(sealed.length).toBeGreaterThan(1);
    const stored = async function* () {
      yield* sealed;
    };
    // A stream already running stops at its next piece.
    const seal = codec.sealStream(pieces());
    const open = codec.openStream(stored());
    await seal.next();
    await open.next();
    await a.engine.lock();
    const locked = { code: "sync-locked" };
    await expect(seal.next()).rejects.toMatchObject(locked);
    await expect(open.next()).rejects.toMatchObject(locked);
    // Every method of the codec built before the lock refuses after it.
    await expect(codec.chunkId(plain)).rejects.toMatchObject(locked);
    await expect(codec.sealChunk(id, plain)).rejects.toMatchObject(locked);
    await expect(codec.openChunk(id, object)).rejects.toMatchObject(locked);
    await expect(codec.sealManifest(plain)).rejects.toMatchObject(locked);
    await expect(codec.openManifest(manifest)).rejects.toMatchObject(locked);
    await expect(codec.sealStream(pieces()).next()).rejects.toMatchObject(
      locked,
    );
    await expect(codec.openStream(stored()).next()).rejects.toMatchObject(
      locked,
    );
    expect(() => codec.chunkObjectBytes(10)).toThrow(/locked/);
    expect(() => codec.storedSize(10)).toThrow(/locked/);
    expect(() => codec.plainSize(100)).toThrow(/locked/);
    // And no new codec is handed out.
    expect(await a.engine.fileCodec("saves")).toBeNull();
  });

  it("a codec built for a root stops when another root is accepted while one is held (SAVES.R)", async () => {
    const server = new FakeRingServer();
    const a = device(server, A);
    await a.engine.create();
    const codec = (await a.engine.fileCodec("saves"))!;
    const plain = Uint8Array.from({ length: 32 }, (_, i) => i);
    const id = await codec.chunkId(plain);
    const pieces = async function* () {
      for (let i = 0; i < 4; i++) yield plain;
    };
    const running = codec.sealStream(pieces());
    await running.next();
    const root = await rootOfWrap(server, a);
    const ring = server.ring!;
    await (
      a.engine as unknown as {
        accept(
          r: Uint8Array,
          i: string,
          e: number,
          k: string,
        ): Promise<boolean>;
      }
    ).accept(root, ring.ringId, ring.epoch, ring.rootKid);
    expect(a.engine.hasRoot()).toBe(true);
    await expect(codec.sealChunk(id, plain)).rejects.toMatchObject({
      code: "sync-locked",
    });
    await expect(running.next()).rejects.toMatchObject({
      code: "sync-locked",
    });
    // A codec built after it works.
    const fresh = (await a.engine.fileCodec("saves"))!;
    await expect(fresh.sealChunk(id, plain)).resolves.toBeInstanceOf(
      Uint8Array,
    );
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

// ── K0-FIX: a root or pin that cannot be read is not absent (K1-D1 rules 3-5) ────────────────

describe("the root store faults", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** A signed-in browser on IndexedDB, then a Worker ring that another device reset. */
  async function setup(name: string) {
    const fdb = await import("fake-indexeddb");
    const idb = new fdb.IDBFactory();
    const server = new FakeRingServer();
    const vault = indexedDbRootVault(name, idb);
    const victim = device(server, A, { vault });
    const made = await victim.engine.create();
    const oldKid = server.ring!.rootKid;
    const attacker = device(server, B);
    await attacker.engine.reset();
    await attacker.engine.wrapTo(A, (await victim.keys.publicKeys())!.agreeKey);
    const reopen = () =>
      device(server, A, {
        keys: victim.keys,
        vault: indexedDbRootVault(name, idb),
      });
    return { fdb, idb, server, vault, victim, made, oldKid, reopen };
  }
  const plant = async (
    idb: IDBFactory,
    name: string,
    key: string,
    value: unknown,
  ) =>
    new Promise<void>((res, rej) => {
      const req = idb.open(name, 1);
      req.onsuccess = () => {
        const tx = req.result.transaction("root", "readwrite");
        if (value === undefined) tx.objectStore("root").delete(key);
        else tx.objectStore("root").put(value, key);
        tx.oncomplete = () => {
          req.result.close();
          res();
        };
        tx.onerror = () => rej(tx.error);
      };
    });

  it("a stored root that cannot be read is not an absent root", async () => {
    const t = await setup("t-fault-root");
    // Control: a healthy store answers ring-changed.
    expect((await t.reopen().engine.status()).state).toBe("ring-changed");
    // A read transaction that fails.
    const tx = vi
      .spyOn(t.fdb.IDBDatabase.prototype, "transaction")
      .mockImplementation(() => {
        throw new Error("lost connection");
      });
    const dh = vi.spyOn(t.victim.keys, "dh");
    const r = t.reopen();
    await expect(r.engine.status()).rejects.toMatchObject({
      code: "store-failed",
    });
    expect(dh).not.toHaveBeenCalled();
    expect(r.engine.hasRoot()).toBe(false);
    tx.mockRestore();
    // open() itself failing is a read fault too.
    const broken = new t.fdb.IDBFactory();
    vi.spyOn(broken, "open").mockImplementation(() => {
      throw new Error("VersionError");
    });
    const o = device(t.server, A, {
      keys: t.victim.keys,
      vault: indexedDbRootVault("t-fault-root", broken),
    });
    await expect(o.engine.status()).rejects.toMatchObject({
      code: "store-failed",
    });
    expect(dh).not.toHaveBeenCalled();
    // Nothing was written: the root and the pin are still there and still pin the old ring.
    expect((await indexedDbRootVault("t-fault-root", t.idb).get())!.kid).toBe(
      t.oldKid,
    );
    expect((await t.reopen().engine.status()).state).toBe("ring-changed");
  });

  it("a pin that cannot be read is not an absent pin", async () => {
    const t = await setup("t-fault-pin");
    const realGet = t.fdb.IDBObjectStore.prototype.get;
    vi.spyOn(t.fdb.IDBObjectStore.prototype, "get").mockImplementation(
      function (this: IDBObjectStore, key: IDBValidKey | IDBKeyRange) {
        if (key === "pin") throw new Error("pin unreadable");
        return realGet.call(this, key);
      } as never,
    );
    const dh = vi.spyOn(t.victim.keys, "dh");
    await expect(t.reopen().engine.status()).rejects.toMatchObject({
      code: "store-failed",
    });
    expect(dh).not.toHaveBeenCalled();
  });

  it("a present root that is not a usable key is device-keys-unreadable with no pin, and the pinned ring's own wrap replaces it with a pin", async () => {
    const name = "t-bad-root";
    const fdb = await import("fake-indexeddb");
    const idb = new fdb.IDBFactory();
    const server = new FakeRingServer();
    const a = device(server, A, { vault: indexedDbRootVault(name, idb) });
    await a.engine.create();
    const mk = () =>
      device(server, A, {
        keys: a.keys,
        vault: indexedDbRootVault(name, idb),
      });
    await plant(idb, name, "current", { v: 2, junk: true });
    // A pin stands: the pinned ring's own wrap replaces the unusable root.
    expect((await mk().engine.status()).state).toBe("unlocked");
    expect((await indexedDbRootVault(name, idb).get())!.kid).toBe(
      server.ring!.rootKid,
    );
    // No pin: unknown is not absent. Nothing is written.
    await plant(idb, name, "current", { v: 2, junk: true });
    await plant(idb, name, "pin", undefined);
    const dh = vi.spyOn(a.keys, "dh");
    await expect(mk().engine.status()).rejects.toMatchObject({
      code: "device-keys-unreadable",
    });
    expect(dh).not.toHaveBeenCalled();
    expect(await indexedDbRootVault(name, idb).getPin()).toBeNull();
    vi.restoreAllMocks();
  });

  it("a stored handle whose kid is not the record's kid is device-keys-unreadable", async () => {
    const name = "t-planted";
    const fdb = await import("fake-indexeddb");
    const idb = new fdb.IDBFactory();
    const server = new FakeRingServer();
    const a = device(server, A, { vault: indexedDbRootVault(name, idb) });
    await a.engine.create();
    const planted = await crypto.subtle.importKey(
      "raw",
      crypto.getRandomValues(new Uint8Array(32)),
      "HKDF",
      false,
      ["deriveBits"],
    );
    await plant(idb, name, "current", {
      v: 1,
      ringId: server.ring!.ringId,
      epoch: 1,
      kid: server.ring!.rootKid,
      key: planted,
    });
    await plant(idb, name, "pin", undefined);
    const fresh = indexedDbRootVault(name, idb);
    await expect(fresh.get()).rejects.toMatchObject({
      code: "device-keys-unreadable",
    });
    await expect(
      device(server, A, { keys: a.keys, vault: fresh }).engine.status(),
    ).rejects.toMatchObject({ code: "device-keys-unreadable" });
  });

  it("the recovery code still unlocks while the root store faults", async () => {
    const t = await setup("t-fault-recover");
    const fresh = await device(
      t.server,
      "DEVICECCCCCCCCCCCCCCCCCCCCCCCCCC",
    ).engine.reset();
    vi.spyOn(t.fdb.IDBDatabase.prototype, "transaction").mockImplementation(
      () => {
        throw new Error("lost connection");
      },
    );
    const r = t.reopen();
    await expect(r.engine.status()).rejects.toMatchObject({
      code: "store-failed",
    });
    const s = await r.engine.recover(fresh.recoveryCode);
    expect(s.state).toBe("unlocked");
    expect(r.engine.hasRoot()).toBe(true);
  });

  it("forget keeps the pin and throws when the root cannot be removed", async () => {
    const t = await setup("t-fault-forget");
    const bytes = (
      t.victim.engine as unknown as {
        session: { bytes: Uint8Array };
      }
    ).session.bytes;
    expect(bytes.some((b) => b !== 0)).toBe(true);
    const real = t.fdb.IDBDatabase.prototype.transaction;
    vi.spyOn(t.fdb.IDBDatabase.prototype, "transaction").mockImplementation(
      function (this: IDBDatabase, store: never, mode: IDBTransactionMode) {
        if (mode === "readwrite") throw new Error("write refused");
        return real.call(this, store, mode);
      } as never,
    );
    await expect(t.victim.engine.forget()).rejects.toMatchObject({
      code: "store-failed",
    });
    vi.restoreAllMocks();
    const check = indexedDbRootVault("t-fault-forget", t.idb);
    expect(await check.get()).not.toBeNull();
    expect(await check.getPin()).not.toBeNull();
    expect(t.victim.engine.hasRoot()).toBe(false);
    expect(bytes.every((b) => b === 0)).toBe(true);
  });

  it("forget keeps the pin when the root's delete did not run (open() rejected once)", async () => {
    const t = await setup("t-fault-open-once");
    let calls = 0;
    const flaky = {
      open: (n: string, v?: number) => {
        calls += 1;
        if (calls === 1) throw new Error("blocked");
        return t.idb.open(n, v);
      },
    } as unknown as IDBFactory;
    const r = device(t.server, A, {
      keys: t.victim.keys,
      vault: indexedDbRootVault("t-fault-open-once", flaky),
    });
    await r.engine.forget();
    const check = indexedDbRootVault("t-fault-open-once", t.idb);
    expect(await check.get()).not.toBeNull();
    expect(await check.getPin()).not.toBeNull();
  });

  it("ring-changed zeroes the session bytes and wrapTo then refuses", async () => {
    const server = new FakeRingServer();
    const a = device(server, A);
    await a.engine.create();
    const bytes = (a.engine as unknown as { session: { bytes: Uint8Array } })
      .session.bytes;
    await device(server, B).engine.reset();
    expect((await a.engine.status()).state).toBe("ring-changed");
    expect(bytes.every((b) => b === 0)).toBe(true);
    await expect(
      a.engine.wrapTo(B, new Uint8Array(32).fill(9)),
    ).rejects.toBeInstanceOf(UnsupportedError);
  });
});

describe("the root kept across a reset", () => {
  it("the previous root is zeroed when its own session window ends", async () => {
    vi.useFakeTimers();
    const server = new FakeRingServer();
    const a = device(server, A, {
      sessionRootSeconds: 30,
      now: () => Date.now(),
    });
    await a.engine.create();
    vi.advanceTimersByTime(10_000);
    await a.engine.reset();
    const prev = (
      a.engine as unknown as {
        previous: { bytes: Uint8Array } | null;
      }
    ).previous!;
    expect(prev.bytes.some((b) => b !== 0)).toBe(true);
    vi.advanceTimersByTime(21_000);
    expect((a.engine as unknown as { previous: unknown }).previous).toBeNull();
    expect(prev.bytes.every((b) => b === 0)).toBe(true);
    await expect(a.engine.adoptPrevious()).rejects.toBeInstanceOf(
      UnsupportedError,
    );
  });

  it("adoptPrevious refuses once the window has passed even if no timer ran", async () => {
    let now = 1_000_000;
    const server = new FakeRingServer();
    const a = device(server, A, { sessionRootSeconds: 30, now: () => now });
    await a.engine.create();
    now += 20_000;
    await a.engine.reset(); // the old root's window ends at +30 s, the new session's at +50 s
    now += 11_000;
    await a.engine.setRecoveryCode(); // the new session is still inside its own window
    await expect(a.engine.adoptPrevious()).rejects.toBeInstanceOf(
      UnsupportedError,
    );
    expect(server.ring!.adopted).toEqual([]);
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
