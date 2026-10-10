// Client-local trust: device binding to the hardware anchor, a hard 401 or a build block
// deleting the document it answered for, the network path running on the effective clock,
// and anchor probes run by absolute path. The gate input is pinned in capabilities.test.ts,
// the required anti-replay floor in client-core's verify.test.ts.

import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { signJws } from "@polaris-key/jws";
import { ISSUER } from "@polaris-key/protocol/core";
import type { ConfigDoc } from "@polaris-key/protocol/config";
import type { LicenseDoc } from "@polaris-key/protocol/license";
import type { CacheRecordV3 } from "@polaris-key/client-core";
import { PolarisKeyClient } from "../src/client.js";
import { bindDeviceId } from "../src/core/deviceBinding.js";
import { CACHE_VERSION, FileStore, InMemoryStore } from "../src/core/store.js";
import { deviceIdFromRaw, rawDeviceId } from "../src/devices/deviceId.js";
import {
  windowsRegPath,
  type FingerprintIo,
} from "../src/devices/fingerprint.js";

const KID = "pkey-test-prod-2026";
const PUB = "kDJF6Deuexo91hFZ9TAPr2SmjUEuTXdia67UogTEpkI";
const PEM =
  "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIBlV9cXFJlt08+qaVvnIkgRmgao8P0rhkVh3onqOXPW1\n-----END PRIVATE KEY-----";
const PRODUCT = "djdl";
const DEVICE = "dev-fixed";
const nowSec = (): number => Math.floor(Date.now() / 1000);

const base = {
  productSlug: PRODUCT,
  baseUrl: "https://k.test",
  version: "1.2.3",
  trust: { pinnedKeys: { [KID]: PUB } },
  trustRefresh: false,
  license: { fingerprint: false },
  devices: { fingerprint: false },
  config: { env: {} },
} as const;

const licenseDoc = (deviceId: string, at: number): LicenseDoc => ({
  iss: ISSUER,
  aud: PRODUCT,
  deviceId,
  issuedAt: at,
  expiresAt: at + 3600,
  graceUntil: at + 30 * 86400,
  licenseId: "lic_1",
  entitlements: { pro: { state: "enforced", value: true, updatedAt: at } },
});

const configDoc = (deviceId: string, at: number, ttl = 3600): ConfigDoc => ({
  iss: ISSUER,
  aud: PRODUCT,
  deviceId,
  issuedAt: at,
  expiresAt: at + ttl,
  graceUntil: at + 30 * 86400,
  schemaVersion: 1,
  config: { k: { state: "enforced", value: "v", updatedAt: at } },
  secrets: {},
});

const signLicense = (deviceId: string, at: number) =>
  signJws(licenseDoc(deviceId, at), PEM, KID, "pkey-license+jws");
const signConfig = (deviceId: string, at: number, ttl?: number) =>
  signJws(configDoc(deviceId, at, ttl), PEM, KID, "pkey-config+jws");

const jws = (body: string, etag = '"e"') =>
  new Response(body, { status: 200, headers: { etag } });

type Handler = (path: string) => Promise<Response> | Response;
function fetchWith(handlers: { license?: Handler; config?: Handler }) {
  return (async (input: string | URL | Request) => {
    const p = new URL(typeof input === "string" ? input : input.toString())
      .pathname;
    if (p.endsWith("/license/document") && handlers.license)
      return handlers.license(p);
    if (p.endsWith("/config/document") && handlers.config)
      return handlers.config(p);
    if (p.endsWith("/license/token")) return new Response("", { status: 401 });
    if (p.endsWith("/devices/report"))
      return new Response("{}", { status: 200 });
    return new Response("", { status: 404 });
  }) as typeof fetch;
}

async function activatedStore(
  at: number,
): Promise<{ store: InMemoryStore; device: string }> {
  const store = new InMemoryStore(PRODUCT);
  const device = await store.getDeviceId();
  await store.setToken("pkeyt_tok");
  await store.writeCache({
    v: CACHE_VERSION,
    docs: {
      license: await signLicense(device, at),
      config: await signConfig(device, at),
    },
    etags: { license: '"l"', config: '"c"' },
  });
  return { store, device };
}

// @pkey-feature core.cache core.sync license.gate
describe("a hard 401 / a build block deletes the document it answered for", () => {
  it("401 on the license deletes docs.license and its ETag; clearing the hint yields needs-activation, not ok", async () => {
    const at = nowSec() - 60;
    const { store } = await activatedStore(at);
    const client = await PolarisKeyClient.create({
      ...base,
      store,
      fetchImpl: fetchWith({
        license: () => new Response("", { status: 401 }),
        config: async () => new Response(null, { status: 304 }),
      }),
    });
    expect(client.status().status).toBe("ok");

    const res = await client.sync();
    expect(res.unauthorized).toBe(true);
    expect(client.status().status).toBe("revoked");
    const rec = (await store.readCache())!;
    expect(rec.lastSyncUnauthorized).toBe(true);
    expect(rec.docs?.license).toBeUndefined();
    expect(rec.etags?.license).toBeUndefined();
    expect(rec.docs?.config).toBeDefined();

    // The attack: delete the display hint from the plain JSON, restart.
    const tampered: CacheRecordV3 = { ...rec };
    delete tampered.lastSyncUnauthorized;
    await store.writeCache(tampered);
    const restarted = await PolarisKeyClient.create({
      ...base,
      store,
      fetchImpl: fetchWith({}),
    });
    expect(restarted.status().status).toBe("needs-activation");
    expect(restarted.isLicensed()).toBe(false);
    expect(restarted.license.isEntitled("pro")).toBe(false);
  });

  it("401 on the config deletes docs.config and leaves the license alone", async () => {
    const at = nowSec() - 60;
    const { store } = await activatedStore(at);
    const client = await PolarisKeyClient.create({
      ...base,
      store,
      fetchImpl: fetchWith({
        license: async () => new Response(null, { status: 304 }),
        config: () => new Response("", { status: 401 }),
      }),
    });
    expect(client.getConfig("k", "none")).toBe("v");
    await client.sync();
    const rec = (await store.readCache())!;
    expect(rec.docs?.config).toBeUndefined();
    expect(rec.etags?.config).toBeUndefined();
    expect(rec.docs?.license).toBeDefined();
    expect(client.getConfig("k", "none")).toBe("none");
  });

  it("a 403 build block deletes docs.license; clearing `blocked` yields needs-activation", async () => {
    const at = nowSec() - 60;
    const { store } = await activatedStore(at);
    const client = await PolarisKeyClient.create({
      ...base,
      store,
      fetchImpl: fetchWith({
        license: () =>
          new Response(
            JSON.stringify({
              error: { code: "version_blocked", reason: "version-too-old" },
              allowedRange: { min: "2.0.0" },
            }),
            { status: 403 },
          ),
        config: async () => new Response(null, { status: 304 }),
      }),
    });
    expect(client.status().status).toBe("ok");
    expect((await store.readCache())?.docs?.license).toBeDefined();
    await client.sync();
    expect(client.status().status).toBe("version-too-old");
    const rec = (await store.readCache())!;
    expect(rec.blocked?.reason).toBe("version-too-old");
    expect(rec.docs?.license).toBeUndefined();

    const tampered: CacheRecordV3 = { ...rec };
    delete tampered.blocked;
    await store.writeCache(tampered);
    const restarted = await PolarisKeyClient.create({
      ...base,
      store,
      fetchImpl: fetchWith({}),
    });
    expect(restarted.status().status).toBe("needs-activation");
    expect(restarted.isLicensed()).toBe(false);
  });
});

describe("the network path runs on the effective clock", () => {
  afterEach(() => vi.useRealTimers());

  async function clientBehindFloor(
    configJws: (device: string, floor: number) => Promise<string>,
  ) {
    const floor = nowSec();
    const { store, device } = await activatedStore(floor);
    // No cached config slice: its floor must not be what refuses the document under test.
    const rec = (await store.readCache())!;
    delete rec.docs!.config;
    await store.writeCache(rec);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime((floor - 86_400) * 1000); // the system clock is a day behind the floor
    return PolarisKeyClient.create({
      ...base,
      store,
      fetchImpl: fetchWith({
        license: async () => new Response(null, { status: 304 }),
        config: async () => jws(await configJws(device, floor)),
      }),
    });
  }

  it("a config document the effective clock calls expired is refused although the rolled-back system clock calls it fresh", async () => {
    const client = await clientBehindFloor((device, floor) =>
      signConfig(device, floor - 86_400 - 100, 3600),
    );
    const res = await client.sync({ force: true });
    expect(res.documents.config?.kind).toBe("error");
  });

  it("a genuine document stamped at the floor is accepted although the system clock is behind it", async () => {
    const client = await clientBehindFloor((device, floor) =>
      signConfig(device, floor + 10),
    );
    const res = await client.sync({ force: true });
    expect(res.documents.config?.kind).toBe("applied");
  });
});

describe("the device id is bound to the hardware anchor", () => {
  const ANCHOR = "HW-ANCHOR-1";
  const dirs = () => mkdtempSync(join(tmpdir(), "pkey-bind-"));

  async function plant(dir: string, anchor: string | null) {
    const planted = new FileStore(PRODUCT, dir, { readAnchor: () => null });
    // A state directory copied from another machine: a foreign id, its token and its grants.
    await planted.setDeviceId(DEVICE);
    await planted.setToken("pkeyt_foreign");
    await planted.writeCache({
      v: CACHE_VERSION,
      trustJws: "t.t.t",
      docs: { license: "a.b.c", config: "d.e.f" },
      etags: { license: '"l"' },
      bundle: "b.b.b",
      lastSyncUnauthorized: true,
      feeds: { stable: "f.f.f" },
      releaseRecords: { abc: "r.r.r" },
      pinRevocations: { x: "p.p.p" },
    } as CacheRecordV3);
    return new FileStore(PRODUCT, dir, { readAnchor: () => anchor });
  }

  it("a stored id that disagrees with the anchor is discarded with the token and the grant slices; update slices survive", async () => {
    const store = await plant(dirs(), ANCHOR);
    const r = await bindDeviceId(PRODUCT, store);
    expect(r.discarded).toBe(true);
    expect(r.deviceId).toBe(deviceIdFromRaw(PRODUCT, ANCHOR));
    expect(await store.getDeviceId()).toBe(r.deviceId);
    expect(await store.getToken()).toBeNull();
    const rec = (await store.readCache()) as unknown as Record<string, unknown>;
    for (const k of [
      "trustJws",
      "docs",
      "etags",
      "bundle",
      "lastSyncUnauthorized",
    ])
      expect(rec[k], k).toBeUndefined();
    expect(rec.feeds).toEqual({ stable: "f.f.f" });
    expect(rec.releaseRecords).toEqual({ abc: "r.r.r" });
    expect(rec.pinRevocations).toEqual({ x: "p.p.p" });

    // Idempotent: the second start keeps what was re-activated since.
    await store.setToken("pkeyt_new");
    const again = await bindDeviceId(PRODUCT, store);
    expect(again.discarded).toBe(false);
    expect(await store.getToken()).toBe("pkeyt_new");
  });

  it("a stored id that agrees is kept, with its token and cache", async () => {
    const store = new FileStore(PRODUCT, dirs(), { readAnchor: () => ANCHOR });
    await store.setDeviceId(deviceIdFromRaw(PRODUCT, ANCHOR));
    await store.setToken("pkeyt_mine");
    const r = await bindDeviceId(PRODUCT, store);
    expect(r.discarded).toBe(false);
    expect(await store.getToken()).toBe("pkeyt_mine");
  });

  it("with no readable anchor the stored id is used", async () => {
    const store = await plant(dirs(), null);
    const r = await bindDeviceId(PRODUCT, store);
    expect(r).toEqual({ deviceId: DEVICE, discarded: false });
    expect(await store.getToken()).toBe("pkeyt_foreign");
  });

  it("a store that cannot rewrite its id (in-memory, host-owned) is not bound", async () => {
    const store = new InMemoryStore(PRODUCT);
    const id = await store.getDeviceId();
    expect(await bindDeviceId(PRODUCT, store)).toEqual({
      deviceId: id,
      discarded: false,
    });
  });

  it("a copied state directory starts as an unactivated device (client level)", async () => {
    const store = await plant(dirs(), ANCHOR);
    const client = await PolarisKeyClient.create({
      ...base,
      store,
      fetchImpl: fetchWith({}),
    });
    expect(client.core.deviceId).toBe(deviceIdFromRaw(PRODUCT, ANCHOR));
    expect(client.license.activation()).toBeNull();
    expect(client.status().status).toBe("needs-activation");
  });
});

describe("anchor probes run by absolute path, never through PATH", () => {
  function recorder(): { io: FingerprintIo; cmds: string[] } {
    const cmds: string[] = [];
    return {
      cmds,
      io: {
        run(cmd) {
          cmds.push(cmd);
          return null;
        },
        read: () => null,
      },
    };
  }

  it("macOS reads /usr/sbin/ioreg", () => {
    const r = recorder();
    rawDeviceId("darwin", r.io);
    expect(r.cmds).toEqual(["/usr/sbin/ioreg"]);
  });

  it("Windows reads %SystemRoot%\\System32\\reg.exe (stock path when SystemRoot is not absolute)", () => {
    const r = recorder();
    rawDeviceId("win32", r.io);
    expect(r.cmds).toHaveLength(1);
    expect(r.cmds[0]).toMatch(/^[A-Za-z]:[\\/].*System32[\\/]reg\.exe$/i);
    expect(windowsRegPath({ SystemRoot: "D:\\Win" })).toBe(
      "D:\\Win\\System32\\reg.exe",
    );
    expect(windowsRegPath({ SystemRoot: "relative" })).toBe(
      "C:\\Windows\\System32\\reg.exe",
    );
  });

  it.skipIf(process.platform !== "darwin")(
    "a fake `ioreg` first on PATH does not choose the device id",
    () => {
      const bin = mkdtempSync(join(tmpdir(), "pkey-fakebin-"));
      const fake = join(bin, "ioreg");
      writeFileSync(
        fake,
        '#!/bin/sh\necho \'"IOPlatformUUID" = "FAKE-PATH-UUID"\'\n',
      );
      chmodSync(fake, 0o755);
      const saved = process.env.PATH;
      process.env.PATH = `${bin}${delimiter}${saved ?? ""}`;
      try {
        expect(rawDeviceId("darwin")).not.toBe("FAKE-PATH-UUID");
      } finally {
        process.env.PATH = saved;
      }
    },
  );
});
