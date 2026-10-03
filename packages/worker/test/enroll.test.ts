// Auto-issued ("always free") licenses, driven through the real handler chain.

import { beforeEach, describe, expect, it } from "vitest";
import { FINGERPRINT_COMPONENT_LENGTH } from "@polaris-key/protocol";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import {
  makeEnv,
  mkReq,
  NOW,
  seedLicenseWithKey,
  seedProduct,
  seedTier,
} from "./seed.js";
import type { SqliteDb } from "../src/db/sqlite.js";
import type { Env } from "../src/env.js";
import { loadProduct, type Product } from "../src/core/products.js";
import { handleEnroll } from "../src/services/license/enroll.js";
import { handleActivate } from "../src/services/license/activation.js";
import { handleLicenseDocument } from "../src/services/license/document.js";
import { handleConfigDocument } from "../src/services/config/document.js";
import { activateFromIdentity } from "../src/services/identity/oidc.js";
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
const MACHINE_C = {
  machineUuid: hash("uuidC"),
  boardSerial: hash("boardC"),
  cpuModel: hash("cpuC"),
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

  it("refuses re-enrolment when the machine's license was disabled by an operator", async () => {
    const first = (await (await enroll(MACHINE_A, "dev-a")).json()) as {
      license: { id: string };
    };
    await db.run(
      "UPDATE licenses SET status = 'disabled' WHERE product = ? AND id = ?",
      "djdl",
      first.license.id,
    );

    // Disabling is deliberate; handing the row back would resurrect it, and "claimed"'s
    // sign-in guidance would be a lie — no identity holds this license.
    const res = await enroll(MACHINE_A, "dev-a2");
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe(
      "license_disabled",
    );

    // …and no second row was minted around the disable.
    const rows = await db.all(
      "SELECT id FROM licenses WHERE product = 'djdl' AND origin = 'enroll'",
    );
    expect(rows).toHaveLength(1);
  });

  it("the race arm applies the same fate as the first read (disabled winner refused)", async () => {
    const first = (await (await enroll(MACHINE_A, "dev-a")).json()) as {
      license: { id: string };
    };
    await db.run(
      "UPDATE licenses SET status = 'disabled' WHERE product = ? AND id = ?",
      "djdl",
      first.license.id,
    );

    // Simulate the LOSER of an enrolment race: its pre-INSERT read misses (the winner's row
    // is not visible to it yet), the INSERT then violates idx_licenses_enroll_hwid, and the
    // catch arm re-reads the winner — which must face exactly the first read's predicate.
    let missed = false;
    const racedDb = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === "first") {
          return async (...args: Parameters<SqliteDb["first"]>) => {
            if (!missed && args[0].includes("enroll_hwid = ?")) {
              missed = true;
              return null;
            }
            return target.first(...args);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as SqliteDb;

    const res = await handleEnroll(
      mkReq(
        "POST",
        { "x-pkey-device": "dev-a3" },
        { fingerprint: { components: MACHINE_A, hwid: "ignored" } },
      ),
      env,
      racedDb,
      await product(),
      NOW,
    );
    expect(missed).toBe(true);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe(
      "license_disabled",
    );
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

  it("FIXED (R3-11): one machine holds exactly one seat however many device ids it presents", async () => {
    // Was: each new device id from the same machine consumed another seat, so this test
    // asserted that the THIRD enrolment hit the tier's limit of 2. `X-PKey-Device` is a
    // client-chosen string, so that made the seat count a function of how many times the
    // caller cleared its config. `authorizeDevice` now coalesces on the server-computed hwid:
    // the newest device id wins and the stale one is retired.
    const first = (await (await enroll(MACHINE_A, "dev-a")).json()) as {
      license: { id: string };
    };
    for (const dev of ["dev-a2", "dev-a3", "dev-a4"])
      expect((await enroll(MACHINE_A, dev)).status).toBe(200);

    expect(await countActiveDevices(db, "djdl", first.license.id)).toBe(1);
    const rows = await db.all<{ device_id: string; status: string }>(
      "SELECT device_id, status FROM devices WHERE product = ? AND license_id = ? AND status = 'authorized'",
      "djdl",
      first.license.id,
    );
    expect(rows.map((r) => r.device_id)).toEqual(["dev-a4"]);
  });

  it("still enforces the tier's device limit when distinct machines share a license", async () => {
    // The enrol path mints one license per machine, so the shared-license case is reached by
    // pointing a second machine's device at the first machine's license directly.
    const { key } = await seedLicenseWithKey(db, "djdl", {
      id: "lic_shared",
      tierId: "free",
    });
    const p = await product();
    for (const [i, machine] of [MACHINE_A, MACHINE_B].entries()) {
      const res = await handleActivate(
        mkReq(
          "POST",
          { authorization: `Bearer ${key}`, "x-pkey-device": `shared-${i}` },
          { fingerprint: { components: machine, hwid: "x" } },
        ),
        env,
        db,
        p,
        NOW,
      );
      expect(res.status).toBe(200);
    }
    const third = await handleActivate(
      mkReq(
        "POST",
        { authorization: `Bearer ${key}`, "x-pkey-device": "shared-2" },
        { fingerprint: { components: MACHINE_C, hwid: "x" } },
      ),
      env,
      db,
      p,
      NOW,
    );
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

  it("issues documents the client can actually use", async () => {
    const body = (await (await enroll(MACHINE_A, "dev-a")).json()) as {
      token: string;
    };
    const req = mkReq("GET", {
      authorization: `Bearer ${body.token}`,
      "x-pkey-device": "dev-a",
    });
    const p = await product();
    // An enrolled device holds an ordinary licence, so BOTH halves of the split document are
    // reachable with the token enrolment handed back.
    for (const handler of [handleLicenseDocument, handleConfigDocument]) {
      const res = await handler(req, env, db, p, NOW);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("application/jwt");
    }
  });
});

describe("merge on sign-in", () => {
  let db: SqliteDb;
  let env: Env;

  const IDENTITY = {
    sub: "user-1",
    email: "ada@example.com",
    name: "Ada Lovelace",
    groups: ["members"],
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
      JSON.stringify({ members: { role: "user", tier: "standard" } }),
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
    // FIXED (R3-05): the hwid is NOT released. `idx_licenses_enroll_hwid` is the only guard
    // on "one free license per machine", so freeing it on claim let the machine enrol again
    // and be claimed by a second identity, without limit. The binding is permanent.
    expect(row?.enroll_hwid).toBeTruthy();
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

    // The device followed the user; the free row is retired but KEEPS its hwid (R3-05), so
    // the retired row goes on occupying the unique index and the machine cannot re-enrol.
    expect(await countActiveDevices(db, "djdl", identityLicense)).toBe(1);
    const old = await getLicense(db, "djdl", enrolled);
    expect(old?.status).toBe("disabled");
    expect(old?.enroll_hwid).toBeTruthy();
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
      JSON.stringify({ members: { role: "user", tier: "standard" } }),
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
