// Auto-issued ("always free") licenses, driven through the real handler chain.

import { beforeEach, describe, expect, it } from "vitest";
import { FINGERPRINT_COMPONENT_LENGTH } from "@polaris-key/protocol";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { makeEnv, mkReq, NOW, seedProduct, seedTier } from "./seed.js";
import type { SqliteDb } from "../src/db/sqlite.js";
import type { Env } from "../src/env.js";
import { loadProduct, type Product } from "../src/product.js";
import { handleEnroll } from "../src/enroll.js";
import { handleConfig } from "../src/licensing.js";
import { activateFromIdentity } from "../src/oidc.js";
import { countActiveDevices, getLicense, listAudit } from "../src/repo.js";

function hash(seed: string): string {
  return seed
    .padEnd(FINGERPRINT_COMPONENT_LENGTH, "x")
    .slice(0, FINGERPRINT_COMPONENT_LENGTH);
}

const MACHINE_A = {
  machineUuid: hash("uuidA"),
  boardSerial: hash("boardA"),
  cpuModel: hash("cpuA"),
};
const MACHINE_B = {
  machineUuid: hash("uuidB"),
  boardSerial: hash("boardB"),
  cpuModel: hash("cpuB"),
};

async function setAutoIssue(
  db: SqliteDb,
  policy: Record<string, unknown> | null,
): Promise<void> {
  await db.run(
    "UPDATE products SET auto_issue_json = ? WHERE slug = ?",
    policy === null ? null : JSON.stringify(policy),
    "djdl",
  );
}

describe("POST /<product>/enroll", () => {
  let db: SqliteDb;
  let env: Env;

  beforeEach(async () => {
    db = makeTestDb();
    env = makeEnv(new KvMock(), ["djdl"]);
    await seedProduct(db, "djdl");
    await seedTier(db, "djdl", "free", { deviceLimit: 2 });
    await setAutoIssue(db, {
      enabled: true,
      tierId: "free",
      mode: "anonymous",
      rateLimitPerHour: 10,
    });
  });

  async function product(): Promise<Product> {
    return (await loadProduct(env, db, "djdl"))!;
  }

  async function enroll(
    components: Record<string, string> | null,
    device: string,
    p?: Product,
  ): Promise<Response> {
    return handleEnroll(
      mkReq(
        "POST",
        { "x-pkey-device": device },
        components
          ? { fingerprint: { components, hwid: "ignored" } }
          : undefined,
      ),
      env,
      db,
      p ?? (await product()),
      NOW,
    );
  }

  it("mints a keyless license bound to the machine", async () => {
    const res = await enroll(MACHINE_A, "dev-a");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      token: string;
      license: { id: string; tierId: string };
    };
    expect(body.token).toMatch(/^pkeyt_/);
    expect(body.license.tierId).toBe("free");

    const row = await getLicense(db, "djdl", body.license.id);
    expect(row?.origin).toBe("enroll");
    expect(row?.enroll_hwid).toBeTruthy();
    // Anonymous: no identity is attached and no key is minted.
    expect(row?.sub).toBeNull();
    expect(row?.email).toBeNull();
    const keys = await db.all(
      "SELECT * FROM keys_index WHERE product = ? AND license_id = ?",
      "djdl",
      body.license.id,
    );
    expect(keys).toHaveLength(0);
  });

  it("returns the SAME license for a second enrolment from one machine", async () => {
    const first = (await (await enroll(MACHINE_A, "dev-a")).json()) as {
      license: { id: string };
    };
    // A different device id, same hardware — e.g. the user wiped their config directory.
    const second = (await (await enroll(MACHINE_A, "dev-a2")).json()) as {
      license: { id: string };
    };
    expect(second.license.id).toBe(first.license.id);

    const licenses = await db.all(
      "SELECT id FROM licenses WHERE product = ? AND origin = 'enroll'",
      "djdl",
    );
    expect(licenses).toHaveLength(1);
  });

  it("mints separate licenses for genuinely different machines", async () => {
    const a = (await (await enroll(MACHINE_A, "dev-a")).json()) as {
      license: { id: string };
    };
    const b = (await (await enroll(MACHINE_B, "dev-b")).json()) as {
      license: { id: string };
    };
    expect(b.license.id).not.toBe(a.license.id);
  });

  it("enforces the tier's device limit across the shared free license", async () => {
    await enroll(MACHINE_A, "dev-a");
    // A second device on the same machine's license is fine (limit 2)…
    expect((await enroll(MACHINE_A, "dev-a2")).status).toBe(200);
    // …a third is refused.
    const third = await enroll(MACHINE_A, "dev-a3");
    expect(third.status).toBe(403);
    expect(await third.json()).toMatchObject({ error: "device_limit" });
  });

  it("requires a fingerprint, because dedupe is impossible without one", async () => {
    const res = await enroll(null, "dev-a");
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "fingerprint_required" });
  });

  it("404s when the product has not opted in", async () => {
    await setAutoIssue(db, null);
    const res = await enroll(MACHINE_A, "dev-a", await product());
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "enroll_disabled" });
  });

  it("404s when the policy names a tier that no longer exists", async () => {
    // Fail closed: never issue a license whose entitlements nobody configured.
    await setAutoIssue(db, {
      enabled: true,
      tierId: "ghost",
      mode: "anonymous",
    });
    const res = await enroll(MACHINE_A, "dev-a", await product());
    expect(res.status).toBe(404);
  });

  it("treats a policy with no tier as disabled", async () => {
    await setAutoIssue(db, { enabled: true, mode: "anonymous" });
    expect((await enroll(MACHINE_A, "dev-a", await product())).status).toBe(
      404,
    );
  });

  it("rate limits enrolment per IP", async () => {
    await setAutoIssue(db, {
      enabled: true,
      tierId: "free",
      mode: "anonymous",
      rateLimitPerHour: 1,
    });
    const p = await product();
    expect((await enroll(MACHINE_A, "dev-a", p)).status).toBe(200);
    const second = await enroll(MACHINE_B, "dev-b", p);
    expect(second.status).toBe(429);
  });

  it("audits the mint exactly once per machine", async () => {
    await enroll(MACHINE_A, "dev-a");
    await enroll(MACHINE_A, "dev-a2");
    const enrolls = (await listAudit(db, "djdl")).filter(
      (a) => a.action === "license.enroll",
    );
    expect(enrolls).toHaveLength(1);
  });

  it("issues a config doc the client can actually use", async () => {
    const body = (await (await enroll(MACHINE_A, "dev-a")).json()) as {
      token: string;
    };
    const res = await handleConfig(
      mkReq("GET", {
        authorization: `Bearer ${body.token}`,
        "x-pkey-device": "dev-a",
      }),
      env,
      db,
      await product(),
      NOW,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/jwt");
  });
});

describe("merge on sign-in", () => {
  let db: SqliteDb;
  let env: Env;

  const IDENTITY = {
    sub: "user-1",
    email: "ada@example.com",
    name: "Ada Lovelace",
    groups: ["family"],
    claims: {},
  };

  beforeEach(async () => {
    db = makeTestDb();
    env = makeEnv(new KvMock(), ["djdl"]);
    await seedProduct(db, "djdl");
    await seedTier(db, "djdl", "free", { deviceLimit: 5 });
    await seedTier(db, "djdl", "standard", { deviceLimit: 5 });
    await db.run(
      `INSERT INTO oidc_config (product, issuer, client_id, group_role_map_json, provider)
       VALUES (?, ?, ?, ?, 'platform')`,
      "djdl",
      "https://id.example",
      "client",
      JSON.stringify({ family: { role: "user", tier: "standard" } }),
    );
    await db.run(
      "UPDATE products SET auto_issue_json = ? WHERE slug = ?",
      JSON.stringify({ enabled: true, tierId: "free", mode: "both" }),
      "djdl",
    );
  });

  async function product(): Promise<Product> {
    return (await loadProduct(env, db, "djdl"))!;
  }

  async function enrolledLicenseId(device = "dev-a"): Promise<string> {
    const res = await handleEnroll(
      mkReq(
        "POST",
        { "x-pkey-device": device },
        { fingerprint: { components: MACHINE_A, hwid: "x" } },
      ),
      env,
      db,
      await product(),
      NOW,
    );
    const body = (await res.json()) as { license: { id: string } };
    return body.license.id;
  }

  it("claims the enrolled license in place when the identity is new", async () => {
    const licenseId = await enrolledLicenseId();
    const result = await activateFromIdentity(
      db,
      await product(),
      IDENTITY,
      NOW,
      { enrolledLicenseId: licenseId },
    );
    expect(result).toMatchObject({ licenseId, merged: "claimed" });

    // Same row — the user's devices and local state survive.
    const row = await getLicense(db, "djdl", licenseId);
    expect(row?.sub).toBe("user-1");
    expect(row?.email).toBe("ada@example.com");
    expect(row?.origin).toBe("oidc");
    expect(row?.tier_id).toBe("standard");
    // The hwid is released so the machine can enroll again after a sign-out.
    expect(row?.enroll_hwid).toBeNull();
    expect(await countActiveDevices(db, "djdl", licenseId)).toBe(1);
  });

  it("migrates devices when the identity already has a license", async () => {
    // The identity signs in on another machine first, creating its own license…
    const first = await activateFromIdentity(
      db,
      await product(),
      IDENTITY,
      NOW,
    );
    const identityLicense = (first as { licenseId: string }).licenseId;

    // …then signs in on the enrolled machine.
    const enrolled = await enrolledLicenseId("dev-a");
    expect(enrolled).not.toBe(identityLicense);

    const result = await activateFromIdentity(
      db,
      await product(),
      IDENTITY,
      NOW,
      { enrolledLicenseId: enrolled },
    );
    expect(result).toMatchObject({
      licenseId: identityLicense,
      merged: "migrated",
    });

    // The device followed the user; the free row is retired and releases its hwid.
    expect(await countActiveDevices(db, "djdl", identityLicense)).toBe(1);
    const old = await getLicense(db, "djdl", enrolled);
    expect(old?.status).toBe("disabled");
    expect(old?.enroll_hwid).toBeNull();
  });

  it("leaves a non-enrolled license alone", async () => {
    const first = await activateFromIdentity(
      db,
      await product(),
      IDENTITY,
      NOW,
    );
    const identityLicense = (first as { licenseId: string }).licenseId;

    const again = await activateFromIdentity(
      db,
      await product(),
      IDENTITY,
      NOW,
      { enrolledLicenseId: identityLicense },
    );
    expect(again).toMatchObject({ licenseId: identityLicense });
    expect(again).not.toHaveProperty("merged");
    expect((await getLicense(db, "djdl", identityLicense))?.status).toBe(
      "active",
    );
  });
});

describe("OIDC default tier", () => {
  let db: SqliteDb;
  let env: Env;

  const UNMAPPED = {
    sub: "user-2",
    email: "grace@example.com",
    name: "Grace",
    groups: ["nobody"],
    claims: {},
  };

  beforeEach(async () => {
    db = makeTestDb();
    env = makeEnv(new KvMock(), ["djdl"]);
    await seedProduct(db, "djdl");
    await seedTier(db, "djdl", "free", {});
    await db.run(
      `INSERT INTO oidc_config (product, issuer, client_id, group_role_map_json, provider)
       VALUES (?, ?, ?, ?, 'platform')`,
      "djdl",
      "https://id.example",
      "client",
      JSON.stringify({ family: { role: "user", tier: "standard" } }),
    );
  });

  it("still denies an unmapped identity when no default is configured", async () => {
    // The pre-existing behaviour must be byte-for-byte unchanged with the policy unset.
    const product = (await loadProduct(env, db, "djdl"))!;
    expect(await activateFromIdentity(db, product, UNMAPPED, NOW)).toEqual({
      error: "not-entitled",
    });
  });

  it("falls back to the free tier when the product opts in", async () => {
    await db.run(
      "UPDATE products SET auto_issue_json = ? WHERE slug = ?",
      JSON.stringify({ enabled: true, tierId: "free", mode: "oidcDefault" }),
      "djdl",
    );
    const product = (await loadProduct(env, db, "djdl"))!;
    const result = await activateFromIdentity(db, product, UNMAPPED, NOW);
    expect(result).toHaveProperty("licenseId");

    const row = await getLicense(
      db,
      "djdl",
      (result as { licenseId: string }).licenseId,
    );
    expect(row?.tier_id).toBe("free");
    expect(row?.sub).toBe("user-2");
  });

  it("does not open the OIDC default when the mode is anonymous-only", async () => {
    await db.run(
      "UPDATE products SET auto_issue_json = ? WHERE slug = ?",
      JSON.stringify({ enabled: true, tierId: "free", mode: "anonymous" }),
      "djdl",
    );
    const product = (await loadProduct(env, db, "djdl"))!;
    expect(await activateFromIdentity(db, product, UNMAPPED, NOW)).toEqual({
      error: "not-entitled",
    });
  });
});
