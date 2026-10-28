// @vitest-environment node
//
// @pkey-feature connect.identity
//
// Cloud Connect identity in the browser (CC-09.1; WIRE-CONTRACT-V5 §15.2 to §15.4): keys on first
// need, registration, the identity fetch, verification against the pinned set, the `pkey.connect.v1`
// record in IndexedDB, the previous-K_disc rule, the stale and foreign roster refusals, the typed
// errors, the cookie page's N/A and the sign-out hook, through the browser adapter against a small
// fake of the Worker's connect routes. Mirrors sdk-node's connect.test.ts.

import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign,
} from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import type { DeviceKeyPort } from "@polaris-key/client-core";
import { signJws } from "@polaris-key/jws";
import { BrowserAdapter } from "../src/browser/browserAdapter.js";
import { indexedDbStore } from "../src/browser/bearer/store.js";
import { indexedDbOfflineStore } from "../src/browser/offline.js";
import { CONNECT_STATE_SCHEMA } from "../src/browser/connect/state.js";
import { discoveryBody, services } from "./fixtures.js";

const PRODUCT = "acme";
const BASE = "https://key.plrs.im";
const T0 = 1_761_300_000;
const WEEK = 604_800;
const id = (n: string): string => "CONNECTDEVICE".padEnd(31, "0") + n;
const ME = id("1");
const OTHER = id("2");
const SUB = "ps_AAAAAAAAAAAAAAAAAAAAAA";
const TOKEN = `pkeyt_${"T".repeat(43)}`;

const HERE = dirname(fileURLToPath(import.meta.url));
const CORPUS = JSON.parse(
  readFileSync(join(HERE, "../../../conformance/corpus/v2/cases.json"), "utf8"),
) as {
  keys: { kid: string; publicKeyRaw: string; privateKeyPkcs8Pem: string }[];
};
const PIN = CORPUS.keys.find((k) => k.kid === "pkey-test-prod-2026")!;

const b64 = (b: Uint8Array): string => Buffer.from(b).toString("base64url");
const randKey = (): string => b64(randomBytes(32));
function peerKeys(): { signKey: string; agreeKey: string } {
  const ed = generateKeyPairSync("ed25519").publicKey.export({
    format: "der",
    type: "spki",
  });
  const x = generateKeyPairSync("x25519").publicKey.export({
    format: "der",
    type: "spki",
  });
  return {
    signKey: b64(new Uint8Array(ed.subarray(ed.length - 32))),
    agreeKey: b64(new Uint8Array(x.subarray(x.length - 32))),
  };
}

/** A device key port with fixed fixture keys; `persistence` says where they "live". */
function keyPort(
  persistence: "durable" | "memory" = "durable",
): DeviceKeyPort & { made: () => boolean } {
  const pair = generateKeyPairSync("ed25519");
  const priv = pair.privateKey;
  const der = pair.publicKey.export({ format: "der", type: "spki" });
  const keys = {
    signKey: b64(new Uint8Array(der.subarray(der.length - 32))),
    agreeKey: peerKeys().agreeKey,
    generation: 1,
  };
  let made = false;
  return {
    made: () => made,
    ensure: async () => {
      made = true;
      return keys;
    },
    publicKeys: async () => (made ? keys : null),
    sign: async (m) => new Uint8Array(sign(null, Buffer.from(m), priv)),
    dh: async () => null,
    rotate: async () => keys,
    persistence: () => persistence,
    wipe: async () => undefined,
  };
}

interface Member {
  deviceId: string;
  signKey: string;
  agreeKey: string;
}
const LISTED = [
  { deviceId: ME, label: "This", platform: "web", lastSeen: T0, self: true },
  {
    deviceId: OTHER,
    label: null,
    platform: null,
    lastSeen: T0 - 5,
    self: false,
  },
];

/** The Worker's connect routes, reduced to what the client depends on. */
class FakeWorker {
  epoch = 1;
  others: Member[] = [{ deviceId: OTHER, ...peerKeys() }];
  disc: string[] = [randKey()];
  sub = SUB;
  aud = PRODUCT;
  ringSpan = WEEK;
  ringIssuedAt = T0;
  certIssuedAt = T0;
  certKeys: { signKey: string; agreeKey: string } | null = null;
  keysRegistered = false;
  fail: { status: number; code: string } | null = null;
  connectOn = true;
  reqs: string[] = [];
  mine: { signKey: string; agreeKey: string } | null = null;
  inFlight = 0;
  maxInFlight = 0;
  delay = 0;

  async ring(): Promise<string> {
    const devices = [
      ...(this.mine ? [{ deviceId: ME, ...this.mine }] : []),
      ...this.others,
    ].sort((a, b) => (a.deviceId < b.deviceId ? -1 : 1));
    return signJws(
      {
        iss: "key.plrs.im",
        aud: this.aud,
        sub: this.sub,
        epoch: this.epoch,
        issuedAt: this.ringIssuedAt,
        expiresAt: this.ringIssuedAt + this.ringSpan,
        devices,
      },
      PIN.privateKeyPkcs8Pem,
      PIN.kid,
      "pkey-ring+jws",
    );
  }

  async cert(): Promise<string> {
    const k = this.certKeys ?? this.mine!;
    return signJws(
      {
        iss: "key.plrs.im",
        aud: this.aud,
        sub: this.sub,
        deviceId: ME,
        signKey: k.signKey,
        agreeKey: k.agreeKey,
        ringEpoch: this.epoch,
        issuedAt: this.certIssuedAt,
        expiresAt: this.certIssuedAt + WEEK,
      },
      PIN.privateKeyPkcs8Pem,
      PIN.kid,
      "pkey-peer+jws",
    );
  }

  fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const path = url.pathname.replace(`/${PRODUCT}/`, "");
    this.reqs.push(`${method} ${path}`);
    const j = (b: unknown, s = 200) =>
      new Response(JSON.stringify(b), { status: s });
    if (path === ".well-known/polaris.json") {
      const doc = JSON.parse(discoveryBody(services("license"), PRODUCT));
      doc.services.connect = this.connectOn
        ? {
            enabled: true,
            endpoints: { identity: `${BASE}/${PRODUCT}/connect/identity` },
          }
        : { enabled: false };
      return j(doc);
    }
    if (path === ".well-known/polaris-trust.jws")
      return new Response("", { status: 404 });
    if (!path.startsWith("connect/") && !path.startsWith("devices/"))
      return j({}, 404);
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      if (this.delay > 0) await new Promise((r) => setTimeout(r, this.delay));
      if (this.fail)
        return j({ error: { code: this.fail.code } }, this.fail.status);
      const h = new Headers(init?.headers);
      if (h.get("authorization") !== `Bearer ${TOKEN}`) return j({}, 401);
      if (method === "PUT" && path === "devices/keys") {
        const body = JSON.parse(String(init!.body)) as {
          signKey: string;
          agreeKey: string;
        };
        this.mine = { signKey: body.signKey, agreeKey: body.agreeKey };
        this.keysRegistered = true;
        return j({ keySeq: 1 });
      }
      if (!this.keysRegistered)
        return j({ error: { code: "device_keys_required" } }, 409);
      if (path === "connect/identity")
        return j({
          ring: await this.ring(),
          certificate: await this.cert(),
          discKeys: this.disc,
        });
      if (path === "connect/devices") return j({ devices: LISTED });
      return j({}, 404);
    } finally {
      this.inFlight -= 1;
    }
  }) as typeof fetch;
}

let clock = T0;
const realIdb = (globalThis as { indexedDB?: unknown }).indexedDB;

beforeEach(() => {
  clock = T0;
});
afterEach(() => {
  (globalThis as { indexedDB?: unknown }).indexedDB = realIdb;
});

async function setup(
  opts: {
    worker?: FakeWorker;
    keys?: DeviceKeyPort;
    allowEphemeralKeys?: boolean;
    signedIn?: boolean;
    pinned?: Record<string, string>;
    durable?: boolean;
    factory?: IDBFactory;
    auth?: "bearer" | "cookie";
  } = {},
) {
  const worker = opts.worker ?? new FakeWorker();
  const factory = opts.factory ?? new IDBFactory();
  // The connect record's database is the page's `indexedDB`; the bearer store gets the same one.
  if (opts.durable !== false)
    (globalThis as { indexedDB?: unknown }).indexedDB = factory;
  await indexedDbOfflineStore(factory)!.write(PRODUCT, { deviceId: ME });
  const bearer = indexedDbStore(PRODUCT, { factory })!;
  if (opts.signedIn !== false) await bearer.setToken(TOKEN);
  const keys = opts.keys ?? keyPort();
  const adapter = new BrowserAdapter({
    productSlug: PRODUCT,
    auth: opts.auth ?? "bearer",
    trust: { pinnedKeys: opts.pinned ?? { [PIN.kid]: PIN.publicKeyRaw } },
    fetchImpl: worker.fetch,
    now: () => clock,
    store: bearer,
    connect: {
      deviceKeys: keys,
      ...(opts.allowEphemeralKeys ? { allowEphemeralKeys: true } : {}),
    },
    autoStart: false,
  });
  const connect = adapter.connect;
  /** What the database holds, as text (all of it that a script could read). */
  const held = async (): Promise<string | null> => {
    const db = await new Promise<IDBDatabase>((res, rej) => {
      const r = factory.open(`pkey-connect-${PRODUCT}`, 1);
      r.onupgradeneeded = () => r.result.createObjectStore("connect");
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    const v = await new Promise<unknown>((res, rej) => {
      const q = db
        .transaction("connect", "readonly")
        .objectStore("connect")
        .get("state");
      q.onsuccess = () => res(q.result);
      q.onerror = () => rej(q.error);
    });
    db.close();
    return (v as string | undefined) ?? null;
  };
  return { worker, adapter, connect, keys, factory, held };
}

const badRefresh = (c: {
  identity(o?: { refresh?: boolean }): Promise<unknown>;
}) =>
  expect(c.identity({ refresh: true })).rejects.toMatchObject({
    code: "peer-cert-invalid",
  });

describe("adapter.connect.identity", () => {
  it("makes and registers keys on first need, fetches, verifies and stores the identity", async () => {
    const keys = keyPort();
    const s = await setup({ keys });
    expect(await keys.publicKeys()).toBeNull();
    const idn = await s.connect.identity();
    expect(idn.sub).toBe(SUB);
    expect(idn.deviceId).toBe(ME);
    expect(idn.epoch).toBe(1);
    expect(idn.devices.map((d) => d.deviceId)).toEqual([ME, OTHER]);
    expect(idn.certificateExpiresAt).toBe(T0 + WEEK);
    expect(s.worker.reqs.filter((r) => r === "PUT devices/keys")).toHaveLength(
      1,
    );
    const rec = JSON.parse((await s.held())!);
    expect(rec.schema).toBe(CONNECT_STATE_SCHEMA);
    expect(rec.discKeys).toEqual(s.worker.disc);
    // Held and fresh: a second call sends nothing.
    const before = s.worker.reqs.length;
    expect((await s.connect.identity()).epoch).toBe(1);
    expect(s.worker.reqs).toHaveLength(before);
    // A reload (a new adapter over the same database) finds it.
    const again = await setup({ factory: s.factory, keys, worker: s.worker });
    expect((await again.connect.current())?.epoch).toBe(1);
  });

  it("short-circuits for 3.5 days and fetches again after, and refresh bypasses it", async () => {
    const s = await setup();
    await s.connect.identity();
    const gets = () =>
      s.worker.reqs.filter((r) => r === "GET connect/identity").length;
    expect(gets()).toBe(1);
    clock = T0 + 302_400 - 10;
    await s.connect.identity();
    expect(gets()).toBe(1);
    await s.connect.identity({ refresh: true });
    expect(gets()).toBe(2);
    clock = T0 + 302_400 + 10;
    s.worker.certIssuedAt = clock;
    s.worker.ringIssuedAt = clock;
    await s.connect.identity();
    expect(gets()).toBe(3);
  });

  it("never shows K_disc in a value, an error or a print", async () => {
    const s = await setup();
    const idn = await s.connect.identity();
    const secret = s.worker.disc[0]!;
    const keys = await s.connect.discoveryKeys();
    for (const view of [
      JSON.stringify(idn),
      inspect(idn, { depth: 9 }),
      JSON.stringify(s.connect),
      inspect(s.connect, { depth: 9 }),
      JSON.stringify(keys),
    ])
      expect(view).not.toContain(secret);
    expect(b64(keys!.current)).toBe(secret);
    expect(keys!.previous).toBeNull();
    s.worker.fail = { status: 403, code: "account_required" };
    try {
      await s.connect.identity({ refresh: true });
    } catch (e) {
      expect(JSON.stringify(e) + String((e as Error).message)).not.toContain(
        secret,
      );
    }
  });

  it("refuses a memory-only key store unless the host opts in", async () => {
    const mem = keyPort("memory");
    const s = await setup({ keys: mem });
    await expect(s.connect.identity()).rejects.toMatchObject({
      code: "invalid-options",
    });
    expect(s.worker.reqs.filter((r) => r.startsWith("PUT"))).toHaveLength(0);
    expect(mem.made()).toBe(false);

    const ok = await setup({ keys: mem, allowEphemeralKeys: true });
    expect((await ok.connect.identity()).epoch).toBe(1);
    // The record stays in memory with memory keys: nothing in the database.
    expect(await ok.held()).toBeNull();
    expect((await ok.connect.current())?.epoch).toBe(1);
  });

  it("maps the Worker's refusals to their codes", async () => {
    const s = await setup();
    s.worker.fail = { status: 403, code: "account_required" };
    await expect(s.connect.identity()).rejects.toMatchObject({
      code: "account_required",
    });
    s.worker.fail = { status: 409, code: "ring_too_large" };
    await expect(s.connect.identity()).rejects.toMatchObject({
      code: "ring_too_large",
    });
    s.worker.fail = { status: 409, code: "device_keys_required" };
    await expect(s.connect.identity({ refresh: true })).rejects.toMatchObject({
      code: "device_keys_required",
    });
    const bare = await setup({ signedIn: false });
    await expect(bare.connect.identity()).rejects.toMatchObject({
      code: "no-token",
    });
  });

  it("answers bad_response only for a malformed answer", async () => {
    const s = await setup();
    const real = s.worker.fetch;
    const broken = (async (input: string | URL, init?: RequestInit) => {
      const res = await real(input, init);
      return String(input).endsWith("connect/identity")
        ? new Response(JSON.stringify({ ring: 1 }), { status: 200 })
        : res;
    }) as typeof fetch;
    const t = await setup({
      worker: Object.assign(new FakeWorker(), { fetch: broken }),
    });
    await expect(t.connect.identity()).rejects.toMatchObject({
      code: "bad_response",
    });
  });

  it("registers again once when the Worker forgot the keys", async () => {
    const s = await setup();
    await s.connect.identity();
    s.worker.keysRegistered = false;
    const puts = () =>
      s.worker.reqs.filter((r) => r === "PUT devices/keys").length;
    expect(puts()).toBe(1);
    expect((await s.connect.identity({ refresh: true })).epoch).toBe(1);
    expect(puts()).toBe(2);
  });

  it("is unavailable when discovery has Connect off, and sends nothing", async () => {
    const s = await setup();
    s.worker.connectOn = false;
    await expect(s.connect.identity()).rejects.toMatchObject({
      code: "connect-unavailable",
      name: "UnsupportedError",
    });
    expect(s.worker.reqs.some((r) => r.includes("connect/identity"))).toBe(
      false,
    );
    expect(s.worker.reqs.some((r) => r.startsWith("PUT"))).toBe(false);
  });

  it("lists the person's devices", async () => {
    const s = await setup();
    expect(await s.connect.listDevices()).toEqual(LISTED);
    expect(s.worker.keysRegistered).toBe(true);
    expect(await s.held()).toBeNull();
  });

  it("runs one identity call at a time", async () => {
    const s = await setup();
    s.worker.delay = 5;
    await Promise.all([
      s.connect.identity({ refresh: true }),
      s.connect.identity({ refresh: true }),
      s.connect.listDevices(),
    ]);
    expect(s.worker.maxInFlight).toBe(1);
  });

  it("a cookie page answers the typed runtime N/A", async () => {
    const s = await setup({ auth: "cookie" });
    await expect(s.connect.identity()).rejects.toMatchObject({
      name: "UnsupportedError",
      code: "connect-unavailable",
      feature: "connect.identity",
      reason: "runtime",
    });
    expect(await s.connect.current()).toBeNull();
    await s.connect.leave();
  });
});

describe("verification and replacement", () => {
  it("refuses documents that do not verify, and stores nothing", async () => {
    const cases: [string, (w: FakeWorker) => void][] = [
      ["another product", (w) => (w.aud = "other")],
      ["an expired roster", (w) => (w.ringIssuedAt = T0 - 700_000)],
      ["a roster outliving its horizon", (w) => (w.ringSpan = WEEK + 1)],
      ["other keys than this device's", (w) => (w.certKeys = peerKeys())],
    ];
    for (const [name, mutate] of cases) {
      const s = await setup();
      mutate(s.worker);
      await expect(s.connect.identity(), name).rejects.toMatchObject({
        code: "peer-cert-invalid",
      });
      expect(await s.held(), name).toBeNull();
      expect(await s.connect.current(), name).toBeNull();
    }
  });

  it("refuses a document signed by a key that is not pinned", async () => {
    const s = await setup({ pinned: { other: "A".repeat(43) } });
    await expect(s.connect.identity()).rejects.toMatchObject({
      code: "peer-cert-invalid",
    });
    expect(await s.held()).toBeNull();
  });

  it("refuses a stale roster and a roster for another subject, keeping the held one", async () => {
    const s = await setup();
    s.worker.epoch = 5;
    await s.connect.identity();
    const held = await s.held();

    s.worker.epoch = 4;
    await badRefresh(s.connect);
    s.worker.epoch = 6;
    s.worker.sub = "ps_BBBBBBBBBBBBBBBBBBBBBB";
    await badRefresh(s.connect);
    s.worker.sub = SUB;
    s.worker.epoch = 5;
    s.worker.others = [{ deviceId: OTHER, ...peerKeys() }];
    await badRefresh(s.connect);
    expect(await s.held()).toBe(held);
    s.worker.epoch = 6;
    expect((await s.connect.identity({ refresh: true })).epoch).toBe(6);
  });

  it("reads no identity once the held roster has lapsed", async () => {
    const s = await setup();
    await s.connect.identity();
    clock = T0 + WEEK + 400;
    expect(await s.connect.current()).toBeNull();
  });
});

async function bump(
  s: Awaited<ReturnType<typeof setup>>,
  epoch: number,
  prev: string,
): Promise<void> {
  s.worker.epoch = epoch;
  s.worker.disc = [randKey(), prev];
  await s.connect.identity({ refresh: true });
}

describe("K_disc: the previous key", () => {
  it("keeps the previous key while devices only joined, and drops it after 24 hours", async () => {
    const s = await setup();
    const old = s.worker.disc[0]!;
    await s.connect.identity();
    s.worker.others.push({ deviceId: id("3"), ...peerKeys() });
    await bump(s, 2, old);
    let keys = await s.connect.discoveryKeys();
    expect(b64(keys!.current)).toBe(s.worker.disc[0]);
    expect(b64(keys!.previous!)).toBe(old);
    clock = T0 + 86_400 + 1;
    keys = await s.connect.discoveryKeys();
    expect(keys!.previous).toBeNull();
  });

  it("drops the previous key after a leave of a device, even if the Worker sent one", async () => {
    const s = await setup();
    const old = s.worker.disc[0]!;
    await s.connect.identity();
    s.worker.others = [];
    await bump(s, 2, old);
    const keys = await s.connect.discoveryKeys();
    expect(b64(keys!.current)).toBe(s.worker.disc[0]);
    expect(keys!.previous).toBeNull();
    expect(await s.held()).not.toContain(old);
  });

  it("drops it when a device changed its keys, and never carries an old key forward", async () => {
    const s = await setup();
    const first = s.worker.disc[0]!;
    await s.connect.identity();
    s.worker.others = [{ deviceId: OTHER, ...peerKeys() }];
    await bump(s, 2, first);
    expect((await s.connect.discoveryKeys())!.previous).toBeNull();
    const second = s.worker.disc[0]!;
    s.worker.epoch = 3;
    s.worker.disc = [randKey()];
    await s.connect.identity({ refresh: true });
    const text = (await s.held())!;
    expect(text).not.toContain(first);
    expect(text).not.toContain(second);
  });
});

describe("leave, and the state record", () => {
  it("forgets the state, and is a no-op when none is held", async () => {
    const s = await setup();
    await s.connect.leave();
    await s.connect.identity();
    expect(await s.held()).not.toBeNull();
    await s.connect.leave();
    expect(await s.held()).toBeNull();
    expect(await s.connect.current()).toBeNull();
    expect(await s.connect.discoveryKeys()).toBeNull();
  });

  it("treats an unreadable record as an error, never replaces it, and leave clears it", async () => {
    const s = await setup();
    await s.connect.identity();
    const factory = s.factory;
    const put = async (text: string) => {
      const db = await new Promise<IDBDatabase>((res) => {
        const r = factory.open(`pkey-connect-${PRODUCT}`, 1);
        r.onsuccess = () => res(r.result);
      });
      await new Promise<void>((res) => {
        const tx = db.transaction("connect", "readwrite");
        tx.objectStore("connect").put(text, "state");
        tx.oncomplete = () => res();
      });
      db.close();
    };
    await put("{ not json");
    await expect(s.connect.identity({ refresh: true })).rejects.toMatchObject({
      code: "store-failed",
    });
    await expect(s.connect.current()).rejects.toMatchObject({
      code: "store-failed",
    });
    expect(await s.held()).toBe("{ not json");
    await s.connect.leave();
    expect(await s.held()).toBeNull();
    expect((await s.connect.identity()).epoch).toBe(1);
  });
});

describe("sign-out", () => {
  it("leaves Connect: the roster, certificate and K_disc go", async () => {
    const s = await setup();
    await s.adapter.snapshot();
    await s.connect.identity();
    expect(await s.held()).not.toBeNull();
    await s.adapter.signOut();
    expect(await s.held()).toBeNull();
  });

  it("fails closed when the record cannot be cleared", async () => {
    const s = await setup();
    await s.connect.identity();
    // A new adapter (a reload) has no open connection to reuse; its database cannot be opened.
    const t = await setup({ factory: s.factory, worker: s.worker });
    const broken = vi
      .spyOn((globalThis as { indexedDB: IDBFactory }).indexedDB, "open")
      .mockImplementation(() => {
        throw new Error("blocked");
      });
    await expect(t.adapter.signOut()).rejects.toMatchObject({
      code: "store-failed",
    });
    broken.mockRestore();
  });

  it("signs out when no state is held, without touching the database", async () => {
    const s = await setup({ durable: false });
    await expect(s.adapter.signOut()).resolves.toBeDefined();
  });
});
