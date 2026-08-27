// The fingerprint feature driven through the REAL handler chain (handleActivate /
// handleReport / handleDevices) against the real migrations, so schema, matcher, and HTTP
// contract are verified together rather than in isolation.

import { beforeEach, describe, expect, it } from "vitest";
import { FINGERPRINT_COMPONENT_LENGTH } from "@plrs/protocol";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import {
  makeEnv,
  mkReq,
  NOW,
  seedLicenseWithKey,
  seedProduct,
  seedTier,
  setProductFingerprintPolicy,
} from "./seed.js";
import { loadProduct, type Product } from "../src/core/products.js";
import { handleActivate } from "../src/services/license/activation.js";
import { handleDevices, handleReport } from "../src/core/devices.js";
import type { Env } from "../src/env.js";
import type { SqliteDb } from "../src/db/sqlite.js";
import {
  getDeviceFacts,
  getFingerprint,
  listAudit,
  type FingerprintRow,
} from "../src/repo.js";

const DEVICE = "device-fixture-01";

function hash(seed: string): string {
  return seed
    .padEnd(FINGERPRINT_COMPONENT_LENGTH, "x")
    .slice(0, FINGERPRINT_COMPONENT_LENGTH);
}

const FULL = {
  machineUuid: hash("uuid"),
  boardSerial: hash("board"),
  cpuModel: hash("cpu"),
  primaryMac: hash("mac"),
  bootVolumeUuid: hash("boot"),
  ramBucket: hash("ram"),
  machineModel: hash("model"),
};

describe("fingerprinted activation", () => {
  let db: SqliteDb;
  let env: Env;
  let product: Product;

  beforeEach(async () => {
    db = makeTestDb();
    env = makeEnv(new KvMock(), ["djdl"]);
    await seedProduct(db, "djdl");
    product = (await loadProduct(env, db, "djdl"))!;
  });

  async function reload(): Promise<Product> {
    return (await loadProduct(env, db, "djdl"))!;
  }

  function activate(
    key: string,
    components?: Record<string, string>,
    device = DEVICE,
    p: Product = product,
  ): Promise<Response> {
    return handleActivate(
      mkReq(
        "POST",
        { authorization: `Bearer ${key}`, "x-polaris-device": device },
        components
          ? { fingerprint: { components, hwid: "ignored" } }
          : undefined,
      ),
      env,
      db,
      p,
      NOW,
    );
  }

  async function fp(device = DEVICE): Promise<FingerprintRow | null> {
    return getFingerprint(db, "djdl", device);
  }

  it("stores a verified fingerprint when the client supplies one", async () => {
    const { key } = await seedLicenseWithKey(db, "djdl");
    expect((await activate(key, FULL)).status).toBe(200);

    const row = await fp();
    expect(row?.status).toBe("verified");
    expect(row?.anchor_hash).toBe(FULL.machineUuid);
    expect(JSON.parse(row!.components_json)).toEqual(FULL);
    expect(row?.hwid).toHaveLength(32);
  });

  it("recomputes the hwid rather than trusting the client's", async () => {
    // A forged hwid must not be able to reach the dedupe index.
    const { key } = await seedLicenseWithKey(db, "djdl");
    await activate(key, FULL);
    expect((await fp())?.hwid).not.toBe("ignored");
  });

  it("accepts a client that sends no fingerprint and marks it unverified", async () => {
    // Every already-shipped SDK is in this bucket; activation must not regress.
    const { key } = await seedLicenseWithKey(db, "djdl");
    expect((await activate(key)).status).toBe(200);

    const row = await fp();
    expect(row?.status).toBe("unverified");
    expect(row?.components_json).toBe("{}");
  });

  it("rejects a missing fingerprint only when the tier is strict", async () => {
    await seedTier(db, "djdl", "pro", { fingerprint: "strict" });
    const { key } = await seedLicenseWithKey(db, "djdl", { tierId: "pro" });

    const denied = await activate(key);
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({
      error: "fingerprint_required",
    });

    expect((await activate(key, FULL)).status).toBe(200);
  });

  it("collects nothing when the product opts out", async () => {
    await setProductFingerprintPolicy(db, "djdl", { enabled: false });
    const { key } = await seedLicenseWithKey(db, "djdl");
    expect(
      (await activate(key, undefined, DEVICE, await reload())).status,
    ).toBe(200);
    expect(await fp()).toBeNull();
  });

  it("tolerates drift inside the tier's threshold and audits it", async () => {
    const { key } = await seedLicenseWithKey(db, "djdl");
    await activate(key, FULL);

    const drifted = {
      ...FULL,
      ramBucket: hash("ram2"),
      cpuModel: hash("cpu2"),
    };
    expect((await activate(key, drifted)).status).toBe(200);

    const row = await fp();
    expect(row?.last_drift_count).toBe(2);
    expect(JSON.parse(row!.components_json)).toEqual(drifted);

    const audit = await listAudit(db, "djdl");
    expect(audit.map((a) => a.action)).toContain("device.fingerprint.drift");
  });

  it("rejects drift past the threshold, retires the binding, and lets the retry rebind", async () => {
    const { key } = await seedLicenseWithKey(db, "djdl");
    await activate(key, FULL);

    const swapped = {
      machineUuid: hash("new-uuid"),
      boardSerial: hash("new-board"),
      cpuModel: hash("new-cpu"),
      primaryMac: hash("new-mac"),
      bootVolumeUuid: hash("new-boot"),
      ramBucket: hash("new-ram"),
      machineModel: hash("new-model"),
    };
    const denied = await activate(key, swapped);
    expect(denied.status).toBe(409);
    expect(await denied.json()).toMatchObject({
      error: "hardware_mismatch",
      drift: 7,
    });

    // The binding is retired: the old machine must not keep holding a seat, and the purge
    // removes the stale fingerprint so the retry can bind cleanly.
    expect(await fp()).toBeNull();

    const retry = await activate(key, swapped);
    expect(retry.status).toBe(200);
    expect(JSON.parse((await fp())!.components_json)).toEqual(swapped);
  });

  it("reports hardware_mismatch before device_limit", async () => {
    // A swapped machine should get a precise error, not a confusing seat error.
    await seedTier(db, "djdl", "solo", { deviceLimit: 1 });
    const { key } = await seedLicenseWithKey(db, "djdl", { tierId: "solo" });
    await activate(key, FULL);

    const res = await activate(key, {
      machineUuid: hash("z1"),
      boardSerial: hash("z2"),
      cpuModel: hash("z3"),
      primaryMac: hash("z4"),
      bootVolumeUuid: hash("z5"),
      ramBucket: hash("z6"),
      machineModel: hash("z7"),
    });
    expect(res.status).toBe(409);
  });

  it("upgrades an unverified device to verified with no drift penalty", async () => {
    // The SDK-upgrade path: a device that activated before fingerprinting now sends one.
    await seedTier(db, "djdl", "strictly", { fingerprint: "strict" });
    const { key } = await seedLicenseWithKey(db, "djdl");
    await activate(key);
    expect((await fp())?.status).toBe("unverified");

    expect((await activate(key, FULL)).status).toBe(200);
    expect((await fp())?.status).toBe("verified");
  });
});

describe("device facts reporting", () => {
  let db: SqliteDb;
  let env: Env;
  let product: Product;
  let token: string;

  beforeEach(async () => {
    db = makeTestDb();
    env = makeEnv(new KvMock(), ["djdl"]);
    await seedProduct(db, "djdl");
    product = (await loadProduct(env, db, "djdl"))!;
    const { key } = await seedLicenseWithKey(db, "djdl");
    const res = await handleActivate(
      mkReq("POST", {
        authorization: `Bearer ${key}`,
        "x-polaris-device": DEVICE,
      }),
      env,
      db,
      product,
      NOW,
    );
    token = ((await res.json()) as { token: string }).token;
  });

  function report(body: unknown): Promise<Response> {
    return handleReport(
      mkReq("POST", { authorization: `Bearer ${token}` }, body),
      env,
      db,
      product,
      NOW,
    );
  }

  it("persists os, hardware, runtime and probes", async () => {
    // Guards the boundedReport allowlist: an un-allowlisted key is dropped SILENTLY, so
    // every one of these fields needs a test or it can vanish without any error surfacing.
    expect(
      (
        await report({
          os: {
            name: "darwin",
            version: "15.1",
            build: "24B83",
            kernel: "24.1.0",
          },
          hardware: { cpuModel: "Apple M3", cpuCores: 12, ramMb: 36864 },
          runtime: { name: "node", version: "22.13.1" },
          locale: "en-US",
          timezone: "America/Los_Angeles",
          probes: { rekordbox: { present: true, version: "7.0.1" } },
        })
      ).status,
    ).toBe(200);

    const facts = await getDeviceFacts(db, "djdl", DEVICE);
    expect(facts).toMatchObject({
      os_name: "darwin",
      os_version: "15.1",
      os_build: "24B83",
      cpu_model: "Apple M3",
      cpu_cores: 12,
      ram_mb: 36864,
      runtime_name: "node",
      locale: "en-US",
      timezone: "America/Los_Angeles",
    });
    expect(JSON.parse(facts!.probes_json!)).toEqual({
      rekordbox: { present: true, version: "7.0.1" },
    });
  });

  it("still keeps the original v1 report keys", async () => {
    await report({ sdk: "node", appVersion: "1.2.3", gate: { status: "ok" } });
    const row = await db.first<{ reported_json: string }>(
      "SELECT reported_json FROM devices WHERE product = ? AND device_id = ?",
      "djdl",
      DEVICE,
    );
    expect(JSON.parse(row!.reported_json)).toMatchObject({
      sdk: "node",
      appVersion: "1.2.3",
    });
  });

  it("caps the probe map and drops malformed entries", async () => {
    const probes: Record<string, unknown> = { bogus: { present: "yes" } };
    for (let i = 0; i < 50; i++) probes[`app${i}`] = { present: true };
    await report({ probes });

    const facts = await getDeviceFacts(db, "djdl", DEVICE);
    const stored = JSON.parse(facts!.probes_json!) as Record<string, unknown>;
    expect(Object.keys(stored)).toHaveLength(32);
    expect(stored.bogus).toBeUndefined();
  });

  it("purges the fingerprint and facts when the device is deauthorized", async () => {
    await report({ os: { name: "darwin" } });
    expect(await getDeviceFacts(db, "djdl", DEVICE)).not.toBeNull();
    expect(await getFingerprint(db, "djdl", DEVICE)).not.toBeNull();

    const res = await handleDevices(
      mkReq("DELETE", { authorization: `Bearer ${token}` }),
      env,
      db,
      product,
      NOW,
      DEVICE,
    );
    expect(res.status).toBe(200);
    expect(await getDeviceFacts(db, "djdl", DEVICE)).toBeNull();
    expect(await getFingerprint(db, "djdl", DEVICE)).toBeNull();
  });
});
