// @pkey-feature connect.identity
// Cloud Connect identity (CC-08.1; WIRE-CONTRACT-V5 §15.2, §15.3, §15.4, §15.8): keys on first
// need, registration, the identity fetch, verification against the pinned set, the
// `pkey.connect.v1` state record and its file mode, the previous-K_disc rule, the stale and foreign
// roster refusals and the typed errors, against a small fake of the Worker's connect routes.

import { randomBytes, generateKeyPairSync } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { base64UrlEncodeBytes, signJws } from "@polaris-key/jws";
import { PolarisError, type DeviceKeyPort } from "@polaris-key/client-core";
import { ISSUER } from "@polaris-key/protocol/core";
import { PolarisKeyClient } from "../src/client.js";
import { createNodeDeviceKeyStore } from "../src/devices/deviceKeys.js";
import { CONNECT_STATE_FILE } from "../src/connect/state.js";
import { InMemoryStore } from "../src/core/store.js";
import { TEST_KID, TEST_PEM, TEST_PUB } from "./parityFixtures.js";

const PRODUCT = "djdl";
const BASE = "https://k.test";
const T0 = 1_761_300_000;
const id = (n: string): string => "CONNECTDEVICE".padEnd(31, "0") + n;
const ME = id("1");
const OTHER = id("2");
const SUB = "ps_AAAAAAAAAAAAAAAAAAAAAA";
const TOKEN = `pkeyt_${"T".repeat(43)}`;

const b64 = (b: Uint8Array): string => base64UrlEncodeBytes(b);
const randKey = (): string => b64(randomBytes(32));
/** A valid Ed25519 public key and X25519 key for a roster member that is not this device. */
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

/** A store answering one device id. */
function memStore(id: string): InMemoryStore {
  return Object.assign(new InMemoryStore(), {
    getDeviceId: async () => id,
  });
}

interface Member {
  deviceId: string;
  signKey: string;
  agreeKey: string;
}

const LISTED = [
  { deviceId: ME, label: "This", platform: "macos", lastSeen: T0, self: true },
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
  ringSpan = 604_800;
  ringIssuedAt = T0;
  certKeys: { signKey: string; agreeKey: string } | null = null;
  keysRegistered = false;
  /** Forgets the registration on demand (the Worker purged the device row). */
  fail: { status: number; code: string } | null = null;
  connectOn = true;
  reqs: string[] = [];
  mine: { signKey: string; agreeKey: string } | null = null;

  async ring(): Promise<string> {
    const devices = [
      ...(this.mine ? [{ deviceId: ME, ...this.mine }] : []),
      ...this.others,
    ].sort((a, b) => (a.deviceId < b.deviceId ? -1 : 1));
    return signJws(
      {
        iss: ISSUER,
        aud: this.aud,
        sub: this.sub,
        epoch: this.epoch,
        issuedAt: this.ringIssuedAt,
        expiresAt: this.ringIssuedAt + this.ringSpan,
        devices,
      },
      TEST_PEM,
      TEST_KID,
      "pkey-ring+jws",
    );
  }

  async cert(): Promise<string> {
    const k = this.certKeys ?? this.mine!;
    return signJws(
      {
        iss: ISSUER,
        aud: this.aud,
        sub: this.sub,
        deviceId: ME,
        signKey: k.signKey,
        agreeKey: k.agreeKey,
        ringEpoch: this.epoch,
        issuedAt: T0,
        expiresAt: T0 + 604_800,
      },
      TEST_PEM,
      TEST_KID,
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
    if (path === ".well-known/polaris.json")
      return j({
        product: PRODUCT,
        services: {
          connect: this.connectOn
            ? {
                enabled: true,
                endpoints: { identity: `${BASE}/${PRODUCT}/connect/identity` },
              }
            : { enabled: false },
        },
      });
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
  }) as typeof fetch;
}

let dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "pkey-connect-"));
  dirs.push(d);
  return d;
};

async function setup(
  opts: {
    worker?: FakeWorker;
    keys?: DeviceKeyPort;
    allowEphemeralKeys?: boolean;
    stateDir?: string;
    signedIn?: boolean;
    pinned?: Record<string, string>;
    defaultKeys?: boolean;
  } = {},
) {
  const worker = opts.worker ?? new FakeWorker();
  const stateDir = opts.stateDir ?? tmp();
  const store = memStore(ME);
  if (opts.signedIn !== false) await store.setToken(TOKEN);
  const keys =
    opts.keys ?? createNodeDeviceKeyStore({ product: PRODUCT, stateDir });
  const connect = opts.defaultKeys
    ? {}
    : {
        deviceKeys: keys,
        ...(opts.allowEphemeralKeys ? { allowEphemeralKeys: true } : {}),
      };
  const make = async () => {
    const client = new PolarisKeyClient({
      productSlug: PRODUCT,
      baseUrl: BASE,
      version: "1.0.0",
      trust: { pinnedKeys: opts.pinned ?? { [TEST_KID]: TEST_PUB } },
      trustRefresh: false,
      license: { fingerprint: false },
      devices: { fingerprint: false },
      store,
      fetchImpl: worker.fetch,
      stateDir,
      connect,
    });
    await client.init();
    return client;
  };
  const client = await make();
  const state = join(stateDir, `${PRODUCT}@k.test`);
  const file = join(state, CONNECT_STATE_FILE);
  return { worker, client, make, keys, stateDir, state, file };
}

const badRefresh = (c: PolarisKeyClient): Promise<void> =>
  expect(c.connect.identity({ refresh: true })).rejects.toMatchObject({
    code: "bad_response",
  });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0 * 1000);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("client.connect.identity", () => {
  it("makes and registers keys on first need, fetches, verifies and stores the identity", async () => {
    const s = await setup();
    expect(await s.keys.publicKeys()).toBeNull();
    const id = await s.client.connect.identity();
    expect(id.sub).toBe(SUB);
    expect(id.deviceId).toBe(ME);
    expect(id.epoch).toBe(1);
    expect(id.devices.map((d) => d.deviceId)).toEqual([ME, OTHER]);
    expect(id.certificateExpiresAt).toBe(T0 + 604_800);
    expect(s.worker.reqs.filter((r) => r === "PUT devices/keys")).toHaveLength(
      1,
    );
    expect(await s.keys.publicKeys()).not.toBeNull();

    const rec = JSON.parse(readFileSync(s.file, "utf8"));
    expect(rec.schema).toBe("pkey.connect.v1");
    expect(rec.discKeys).toEqual(s.worker.disc);
    if (process.platform !== "win32") {
      expect(statSync(s.file).mode & 0o777).toBe(0o600);
      expect(statSync(s.state).mode & 0o077).toBe(0);
    }
    // A second call sends nothing: the identity is held and fresh.
    const before = s.worker.reqs.length;
    expect((await s.client.connect.identity()).epoch).toBe(1);
    expect(s.worker.reqs).toHaveLength(before);
    // A restart finds it too.
    const again = await s.make();
    expect((await again.connect.current())?.epoch).toBe(1);
  });

  it("never shows K_disc in a value, an error or a print", async () => {
    const s = await setup();
    const id = await s.client.connect.identity();
    const secret = s.worker.disc[0]!;
    for (const view of [
      JSON.stringify(id),
      inspect(id, { depth: 9 }),
      JSON.stringify(s.client.connect),
      inspect(s.client.connect, { depth: 9 }),
    ])
      expect(view).not.toContain(secret);
    const keys = await s.client.connect.discoveryKeys();
    expect(b64(keys!.current)).toBe(secret);
    expect(keys!.previous).toBeNull();
    s.worker.fail = { status: 403, code: "account_required" };
    try {
      await s.client.connect.identity({ refresh: true });
    } catch (e) {
      expect(String((e as Error).message)).not.toContain(secret);
    }
  });

  it("refuses a memory-only key store unless the host opts in", async () => {
    const mem = createNodeDeviceKeyStore({ memory: true });
    const s = await setup({ keys: mem });
    await expect(s.client.connect.identity()).rejects.toMatchObject({
      code: "invalid-options",
    });
    expect(s.worker.reqs.filter((r) => r.startsWith("PUT"))).toHaveLength(0);
    expect(await mem.publicKeys()).toBeNull();

    const ok = await setup({ keys: mem, allowEphemeralKeys: true });
    expect((await ok.client.connect.identity()).epoch).toBe(1);
    expect(existsSync(ok.file)).toBe(false);
    expect((await ok.client.connect.current())?.epoch).toBe(1);
  });

  it("maps the Worker's refusals to their codes", async () => {
    const s = await setup();
    s.worker.fail = { status: 403, code: "account_required" };
    await expect(s.client.connect.identity()).rejects.toMatchObject({
      code: "account_required",
    });
    s.worker.fail = { status: 409, code: "ring_too_large" };
    await expect(s.client.connect.identity()).rejects.toMatchObject({
      code: "ring_too_large",
    });
    s.worker.fail = { status: 409, code: "device_keys_required" };
    await expect(
      s.client.connect.identity({ refresh: true }),
    ).rejects.toMatchObject({ code: "device_keys_required" });
    const bare = await setup({ signedIn: false });
    await expect(bare.client.connect.identity()).rejects.toMatchObject({
      code: "no-token",
    });
  });

  it("registers again once when the Worker forgot the keys", async () => {
    const s = await setup();
    await s.client.connect.identity();
    s.worker.keysRegistered = false;
    const puts = () =>
      s.worker.reqs.filter((r) => r === "PUT devices/keys").length;
    expect(puts()).toBe(1);
    expect((await s.client.connect.identity({ refresh: true })).epoch).toBe(1);
    expect(puts()).toBe(2);
  });

  it("is unavailable when discovery has Connect off", async () => {
    const s = await setup();
    s.worker.connectOn = false;
    await expect(s.client.connect.identity()).rejects.toMatchObject({
      code: "service-unavailable",
    });
    expect(s.worker.reqs.some((r) => r.includes("connect/identity"))).toBe(
      false,
    );
  });

  it("uses the file key store of the product when the host gave none", async () => {
    const s = await setup({ defaultKeys: true });
    await s.client.connect.identity();
    const same = createNodeDeviceKeyStore({
      product: PRODUCT,
      stateDir: s.stateDir,
    });
    expect((await same.publicKeys())?.signKey).toBe(s.worker.mine?.signKey);
  });

  it("lists the person's devices", async () => {
    const s = await setup();
    expect(await s.client.connect.listDevices()).toEqual(LISTED);
    // First need registered the keys; nothing was stored (no identity was fetched).
    expect(s.worker.keysRegistered).toBe(true);
  });
});

describe("verification and replacement", () => {
  it("refuses documents that do not verify, and stores nothing", async () => {
    const cases: [string, (w: FakeWorker) => void][] = [
      ["another product", (w) => (w.aud = "other")],
      ["an expired roster", (w) => (w.ringIssuedAt = T0 - 700_000)],
      ["a roster outliving its horizon", (w) => (w.ringSpan = 604_801)],
      ["other keys than this device's", (w) => (w.certKeys = peerKeys())],
    ];
    for (const [name, mutate] of cases) {
      const s = await setup();
      mutate(s.worker);
      await expect(s.client.connect.identity()).rejects.toMatchObject({
        code: "bad_response",
      });
      expect(existsSync(s.file), name).toBe(false);
      expect(await s.client.connect.current()).toBeNull();
    }
  });

  it("refuses a document signed by a key that is not pinned", async () => {
    const s = await setup({ pinned: { other: "A".repeat(43) } });
    await expect(s.client.connect.identity()).rejects.toMatchObject({
      code: "bad_response",
    });
    expect(existsSync(s.file)).toBe(false);
  });

  it("refuses a stale roster and a roster for another subject, keeping the held one", async () => {
    const s = await setup();
    s.worker.epoch = 5;
    await s.client.connect.identity();
    const held = readFileSync(s.file, "utf8");

    s.worker.epoch = 4;
    await badRefresh(s.client);
    s.worker.epoch = 6;
    s.worker.sub = "ps_BBBBBBBBBBBBBBBBBBBBBB";
    await badRefresh(s.client);
    s.worker.sub = SUB;
    s.worker.epoch = 5;
    s.worker.others = [{ deviceId: OTHER, ...peerKeys() }];
    await badRefresh(s.client);
    expect(readFileSync(s.file, "utf8")).toBe(held);
    // A newer epoch of the same subject replaces it.
    s.worker.epoch = 6;
    expect((await s.client.connect.identity({ refresh: true })).epoch).toBe(6);
  });

  it("reads no identity once the held roster has lapsed", async () => {
    const s = await setup();
    await s.client.connect.identity();
    vi.setSystemTime((T0 + 604_800 + 400) * 1000);
    expect(await s.client.connect.current()).toBeNull();
  });
});

/** The Worker moves to `epoch` with a new current key and `prev` as the previous one. */
async function bump(
  s: { worker: FakeWorker; client: PolarisKeyClient },
  epoch: number,
  prev: string,
): Promise<void> {
  s.worker.epoch = epoch;
  s.worker.disc = [randKey(), prev];
  await s.client.connect.identity({ refresh: true });
}

describe("K_disc: the previous key", () => {
  it("keeps the previous key while devices only joined, and drops it after 24 hours", async () => {
    const s = await setup();
    const old = s.worker.disc[0]!;
    await s.client.connect.identity();
    s.worker.others.push({ deviceId: id("3"), ...peerKeys() });
    await bump(s, 2, old);
    let keys = await s.client.connect.discoveryKeys();
    expect(b64(keys!.current)).toBe(s.worker.disc[0]);
    expect(b64(keys!.previous!)).toBe(old);

    vi.setSystemTime((T0 + 86_400 + 1) * 1000);
    keys = await s.client.connect.discoveryKeys();
    expect(keys!.previous).toBeNull();
  });

  it("drops the previous key after a leave, even if the Worker sent one", async () => {
    const s = await setup();
    const old = s.worker.disc[0]!;
    await s.client.connect.identity();
    s.worker.others = []; // OTHER left
    await bump(s, 2, old);
    const keys = await s.client.connect.discoveryKeys();
    expect(b64(keys!.current)).toBe(s.worker.disc[0]);
    expect(keys!.previous).toBeNull();
    expect(readFileSync(s.file, "utf8")).not.toContain(old);
  });

  it("drops it when a device changed its keys, and never carries an old key forward", async () => {
    const s = await setup();
    const first = s.worker.disc[0]!;
    await s.client.connect.identity();
    s.worker.others = [{ deviceId: OTHER, ...peerKeys() }];
    await bump(s, 2, first);
    expect((await s.client.connect.discoveryKeys())!.previous).toBeNull();
    // Later the Worker sends one key: the stored record holds exactly that.
    const second = s.worker.disc[0]!;
    s.worker.epoch = 3;
    s.worker.disc = [randKey()];
    await s.client.connect.identity({ refresh: true });
    const text = readFileSync(s.file, "utf8");
    expect(text).not.toContain(first);
    expect(text).not.toContain(second);
  });
});

describe("leave", () => {
  it("forgets the state and is a no-op when none is held", async () => {
    const s = await setup();
    await s.client.connect.leave();
    expect(existsSync(s.state)).toBe(false);
    await s.client.connect.identity();
    expect(existsSync(s.file)).toBe(true);
    await s.client.connect.leave();
    expect(existsSync(s.file)).toBe(false);
    expect(await s.client.connect.current()).toBeNull();
    expect(await s.client.connect.discoveryKeys()).toBeNull();
  });
});
