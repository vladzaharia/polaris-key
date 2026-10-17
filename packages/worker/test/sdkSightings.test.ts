/**
 * ST-40 (OB-04): SDK sightings and the Integration read model.
 *
 *   - a sighting needs a known SDK id and a 2xx, and nothing identifying is stored;
 *   - writes happen at most once per key per isolate per five minutes;
 *   - Verified flips per feature and platform, only once the prerequisites are met;
 *   - the backfill seeds sightings from devices and writes no setup choice;
 *   - the 90-day prune, and every service has a stable bit.
 */

import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { makeEnv, NOW, seedProduct } from "./seed.js";
import { dispatch } from "../src/dispatch.js";
import { SERVICES } from "../src/mount.js";
import { serviceContext } from "../src/core/registry.js";
import { loadProductPublic } from "../src/core/products.js";
import { SERVICE_SLUGS } from "../src/core/services.js";
import { buildIntegrationView } from "../src/core/integration/readModel.js";
import {
  SIGHTING_BITS,
  SIGHTING_RETENTION_SECONDS,
  SIGHTING_WRITE_INTERVAL_SECONDS,
  listSightings,
  pruneSightings,
  recordSighting,
  resetSightingThrottle,
  sightingFromHeaders,
  sightingNamespace,
} from "../src/core/integration/sightings.js";

const sdkHeaders = (o: Record<string, string>) =>
  new Headers({
    "X-PKey-SDK": "node",
    "X-PKey-SDK-Version": "1.2.3",
    "X-PKey-Platform": "darwin",
    "X-PKey-Arch": "arm64",
    ...o,
  });

beforeEach(() => resetSightingThrottle());

describe("sightingFromHeaders", () => {
  it("canonicalises the metadata and drops what the wire does not list", () => {
    expect(sightingFromHeaders(sdkHeaders({}))).toEqual({
      sdk: "node",
      platform: "macos",
      arch: "arm64",
      version: "1.2.3",
    });
    expect(
      sightingFromHeaders(
        sdkHeaders({ "X-PKey-Platform": "plan9", "X-PKey-Arch": "mips" }),
      ),
    ).toMatchObject({ platform: "", arch: "" });
    expect(
      sightingFromHeaders(sdkHeaders({ "X-PKey-SDK": "evil" })),
    ).toBeNull();
    expect(sightingFromHeaders(new Headers())).toBeNull();
    // A pre-§5.2 SDK name is read as its id.
    expect(
      sightingFromHeaders(sdkHeaders({ "X-PKey-SDK": "@polaris-key/node" }))
        ?.sdk,
    ).toBe("node");
  });
});

describe("hardening", () => {
  it("keeps only registry-shaped SDK versions", () => {
    const v = (x: string) =>
      sightingFromHeaders(sdkHeaders({ "X-PKey-SDK-Version": x }))?.version;
    expect(v("1.2.3-beta.1+build5")).toBe("1.2.3-beta.1+build5");
    expect(v("1 2")).toBe("");
    expect(v("x".repeat(65))).toBe("");
    expect(v("<script>")).toBe("");
  });

  it("skips writes, never clears, when the throttle map is full of live keys", () => {
    let writes = 0;
    const db = {
      run: async () => {
        writes++;
      },
    } as unknown as Parameters<typeof recordSighting>[0];
    const nss = ["license", "config", "identity", "sync"] as const;
    const sdks = ["node", "react", "python", "swift", "godot", "kotlin"];
    for (let round = 0; round < 2; round++)
      for (let p = 0; p < 400; p++)
        for (const ns of nss)
          for (const sdk of sdks)
            recordSighting(
              db,
              `prod${p}`,
              sdkHeaders({ "X-PKey-SDK": sdk }),
              ns,
              NOW,
            );
    // 9600 distinct keys: at most 4096 are taken inside the window, and the second round
    // (every key already live or skipped) adds none.
    expect(writes).toBe(4096);
    // Expired entries free room again.
    expect(
      recordSighting(
        db,
        "p1",
        sdkHeaders({}),
        "license",
        NOW + SIGHTING_WRITE_INTERVAL_SECONDS + 1,
      ),
    ).not.toBeNull();
  });
});

describe("namespaces and bits", () => {
  it("gives every service a distinct, fixed bit", () => {
    const bits = SERVICE_SLUGS.map((s) => SIGHTING_BITS[s]);
    expect(bits.every((b) => typeof b === "number")).toBe(true);
    const all = Object.values(SIGHTING_BITS);
    expect(new Set(all).size).toBe(all.length);
    expect(all.every((b) => (b & (b - 1)) === 0)).toBe(true);
    // Stored numbers: these never move.
    expect(SIGHTING_BITS).toMatchObject({
      license: 1,
      sync: 64,
      commerce: 128,
    });
  });

  it("maps routes to namespaces", () => {
    const svc = (slug: string, rest: string[]) =>
      sightingNamespace({ kind: "service", slug, rest });
    expect(svc("license", ["activate"])).toBe("license");
    expect(svc("distribution", ["commerce", "x"])).toBe("commerce");
    expect(svc("distribution", ["packs", "p"])).toBe("packs");
    expect(svc("distribution", ["dl", "x"])).toBe("distribution");
    expect(sightingNamespace({ kind: "trustManifest" })).toBe("trust");
    expect(sightingNamespace({ kind: "discovery" })).toBeNull();
  });
});

describe("recording", () => {
  it("writes at most once per key per isolate per five minutes", async () => {
    const db = makeTestDb();
    await seedProduct(db, "p1");
    const rec = (ns: "license" | "config", at: number) =>
      recordSighting(db, "p1", sdkHeaders({}), ns, at);
    expect(rec("license", NOW)).not.toBeNull();
    await rec("license", NOW + 1)?.then(() => undefined);
    expect(rec("license", NOW + 10)).toBeNull();
    expect(
      rec("license", NOW + SIGHTING_WRITE_INTERVAL_SECONDS - 1),
    ).toBeNull();
    // Another namespace is its own key.
    const other = rec("config", NOW + 10);
    expect(other).not.toBeNull();
    await other;
    const again = rec("license", NOW + SIGHTING_WRITE_INTERVAL_SECONDS);
    expect(again).not.toBeNull();
    await again;
    const rows = await listSightings(db, "p1");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sdk: "node",
      platform: "macos",
      arch: "arm64",
      sdkVersion: "1.2.3",
      servicesOk: SIGHTING_BITS.license | SIGHTING_BITS.config,
      firstSeenAt: NOW,
      lastOkAt: NOW + SIGHTING_WRITE_INTERVAL_SECONDS,
    });
  });

  it("records nothing without a known SDK or a namespace", () => {
    const db = makeTestDb();
    expect(recordSighting(db, "p1", new Headers(), "license", NOW)).toBeNull();
    expect(recordSighting(db, "p1", sdkHeaders({}), null, NOW)).toBeNull();
  });

  it("stores no identifying column", () => {
    const sql = readFileSync(
      new URL("../migrations/0121_sdk_sightings.sql", import.meta.url),
      "utf8",
    );
    const table = sql.slice(sql.indexOf("CREATE TABLE"), sql.indexOf(");"));
    const columns = [...table.matchAll(/^\s+(\w+)\s+(?:TEXT|INTEGER)/gm)].map(
      (m) => m[1],
    );
    expect(columns).toEqual([
      "product",
      "sdk",
      "platform",
      "arch",
      "first_seen",
      "last_seen",
      "sdk_version",
      "services_ok",
      "last_ok_at",
    ]);
  });

  it("a 2xx product route records after the response, a refusal does not", async () => {
    const db = makeTestDb();
    const env = makeEnv(new KvMock(), []);
    await seedProduct(db, "p1");
    const waits: Promise<unknown>[] = [];
    const exec = { waitUntil: (p: Promise<unknown>) => void waits.push(p) };
    const get = (path: string) =>
      dispatch(
        new Request(`https://key.plrs.im${path}`, {
          headers: sdkHeaders({ "X-PKey-SDK": "node-server" }),
        }) as unknown as Request,
        env,
        db,
        exec,
      );
    const bad = await get("/nope/.well-known/polaris-trust.jws");
    expect(bad.status).toBe(404);
    expect(waits).toHaveLength(0);
    const ok = await get("/p1/.well-known/polaris-trust.jws");
    expect(ok.status).toBe(200);
    await Promise.all(waits);
    const rows = await listSightings(db, "p1");
    expect(rows.map((r) => r.sdk)).toEqual(["node-server"]);
    expect(rows[0]!.servicesOk).toBe(SIGHTING_BITS.trust);
  });
});

async function view(db: ReturnType<typeof makeTestDb>, slug: string) {
  const env = makeEnv(new KvMock(), []);
  const product = (await loadProductPublic(db, slug))!;
  const hooks = serviceContext("host", SERVICES, product.services, {
    env,
    db,
    product,
    now: NOW,
  }).hooks;
  return buildIntegrationView({
    env,
    db,
    registry: SERVICES,
    product,
    hooks,
    now: NOW,
  });
}

describe("the Integration read model", () => {
  it("flips Verified per feature and platform, once the prerequisites are met", async () => {
    const db = makeTestDb();
    await seedProduct(db, "p1");
    await recordSighting(db, "p1", sdkHeaders({}), "license", NOW);
    await recordSighting(
      db,
      "p1",
      sdkHeaders({ "X-PKey-SDK": "swift", "X-PKey-Platform": "ios" }),
      "license",
      NOW,
    );
    await recordSighting(db, "p1", sdkHeaders({}), "config", NOW);

    let v = await view(db, "p1");
    const licensing = v.features.find((f) => f.id === "licensing")!;
    // No tier yet: seen but blocked, and nothing is shown as Verified.
    expect(licensing.prerequisites).toEqual([{ id: "tiers", met: false }]);
    expect(licensing.status).toBe("blocked");
    expect(licensing.verifiedOn).toEqual([]);

    await db.run(
      "INSERT INTO tiers (product, id, label, modified_at) VALUES (?, ?, ?, ?)",
      "p1",
      "pro",
      "Pro",
      NOW,
    );
    v = await view(db, "p1");
    const l2 = v.features.find((f) => f.id === "licensing")!;
    expect(l2.status).toBe("verified");
    expect(l2.verifiedOn.map((x) => `${x.sdk}/${x.platform}`).sort()).toEqual([
      "node/macos",
      "swift/ios",
    ]);
    // Identity and Sync saw nothing.
    for (const id of ["identity", "sync"] as const) {
      const f = v.features.find((x) => x.id === id);
      if (f) expect(f.verifiedOn).toEqual([]);
    }
    expect(v.verified).toBe(true);
    expect(v.snippet.slug).toBe("p1");
    expect(v.snippet.pins).toHaveLength(1);
  });

  it("lists a server sighting under the server lane", async () => {
    const db = makeTestDb();
    await seedProduct(db, "p1");
    await recordSighting(
      db,
      "p1",
      sdkHeaders({ "X-PKey-SDK": "python-server", "X-PKey-Platform": "linux" }),
      "trust",
      NOW,
    );
    const v = await view(db, "p1");
    expect(v.server.map((s) => s.sdk)).toEqual(["python-server"]);
    expect(v.features.every((f) => f.verifiedOn.length === 0)).toBe(true);
  });
});

describe("backfill and prune", () => {
  it("seeds sightings from devices and writes no setup choice", async () => {
    const db = makeTestDb();
    await seedProduct(db, "p1");
    const nowSec = Math.floor(Date.now() / 1000);
    const dev = (id: string, sdk: string | null, plat: string, seen: number) =>
      db.run(
        `INSERT INTO devices (product, device_id, license_id, status, first_seen, last_seen, platform, arch, sdk_name, sdk_version)
         VALUES ('p1', ?, 'L', 'authorized', ?, ?, ?, 'arm64', ?, '1.0.0')`,
        id,
        seen - 10,
        seen,
        plat,
        sdk,
      );
    await dev("a", "node", "macos", nowSec - 100);
    await dev("b", "node", "macos", nowSec - 50);
    await dev("c", "swift", "ios", nowSec - 60);
    await dev("old", "python", "linux", nowSec - 200 * 86400);
    await dev("none", null, "linux", nowSec - 5);
    const settingsBefore = await db.all("SELECT * FROM product_settings");
    const sql = readFileSync(
      new URL("../migrations/0121_sdk_sightings.sql", import.meta.url),
      "utf8",
    );
    await db.run("DELETE FROM sdk_sightings");
    const insert = sql.slice(sql.indexOf("INSERT OR IGNORE INTO"));
    await db.run(insert);
    await db.run(insert); // replay-safe
    const rows = await listSightings(db, "p1");
    expect(rows.map((r) => `${r.sdk}/${r.platform}`).sort()).toEqual([
      "node/macos",
      "swift/ios",
    ]);
    expect(rows.every((r) => r.servicesOk === SIGHTING_BITS.license)).toBe(
      true,
    );
    expect(await db.all("SELECT * FROM product_settings")).toEqual(
      settingsBefore,
    );
    expect(
      await db.all(
        "SELECT 1 FROM product_settings WHERE key LIKE 'core.setup%'",
      ),
    ).toEqual([]);
  });

  it("backfill drops free-text platform, arch and version", async () => {
    const db = makeTestDb();
    await seedProduct(db, "p1");
    const nowSec = Math.floor(Date.now() / 1000);
    await db.run(
      `INSERT INTO devices (product, device_id, license_id, status, first_seen, last_seen, platform, arch, sdk_name, sdk_version)
       VALUES ('p1', 'x', 'L', 'authorized', ?, ?, ?, ?, 'node', ?)`,
      nowSec - 5,
      nowSec - 1,
      "Plan 9 <b>" + "z".repeat(5000),
      "mips",
      "1.0 bad",
    );
    await db.run("DELETE FROM sdk_sightings");
    const sql = readFileSync(
      new URL("../migrations/0121_sdk_sightings.sql", import.meta.url),
      "utf8",
    );
    await db.run(sql.slice(sql.indexOf("INSERT OR IGNORE INTO")));
    const rows = await listSightings(db, "p1");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ platform: "", arch: "", sdkVersion: "" });
  });

  it("prunes rows last seen past retention", async () => {
    const db = makeTestDb();
    await seedProduct(db, "p1");
    await recordSighting(db, "p1", sdkHeaders({}), "license", NOW);
    await recordSighting(
      db,
      "p1",
      sdkHeaders({ "X-PKey-SDK": "swift" }),
      "license",
      NOW + 100 * 86400,
    );
    const n = await pruneSightings(
      db,
      "p1",
      NOW + 100 * 86400 - SIGHTING_RETENTION_SECONDS,
      10,
    );
    expect(n).toBe(1);
    expect((await listSightings(db, "p1")).map((r) => r.sdk)).toEqual([
      "swift",
    ]);
  });
});
