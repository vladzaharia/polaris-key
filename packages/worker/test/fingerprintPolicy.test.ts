// Policy ownership + the admin escape hatch.
//
// The source guard is what makes "configured in the manifest AND editable by an operator"
// coherent: without it, a live admin change silently evaporates on the next push to the
// product repo, which is arguably worse than being manifest-only.

import { beforeEach, describe, expect, it } from "vitest";
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
import type { Env } from "../src/platform/env.js";
import { loadProduct, type Product } from "../src/core/products.js";
import { handleActivate } from "../src/services/license/activation.js";
import { handleAdmin } from "../src/console/index.js";
import {
  ADMIN_COOKIE,
  CSRF_HEADER,
  issueSession,
} from "../src/core/console/session.js";
import { getFingerprint } from "../src/core/devices/store.js";
import {
  getProduct,
  setFingerprintPolicy,
} from "../src/core/products/store.js";
import { parseFingerprintPolicy } from "../src/core/fingerprint.js";
import { SETTINGS } from "../src/mount.js";
import { writeSetting } from "../src/core/settings/write.js";
import { ROOT_PRINCIPAL } from "./rbacFixtures.js";

const PLATFORM_GROUP = "admins";

describe("fingerprint policy ownership", () => {
  let db: SqliteDb;

  beforeEach(async () => {
    db = makeTestDb();
    await seedProduct(db, "djdl");
  });

  async function policyOf(): Promise<{ json: string | null; source: string }> {
    const row = await getProduct(db, "djdl");
    return {
      json: row?.fingerprint_policy_json ?? null,
      source: row?.fingerprint_policy_source ?? "manifest",
    };
  }

  it("defaults to manifest-owned, enabled, normal", async () => {
    const { json, source } = await policyOf();
    expect(source).toBe("manifest");
    expect(parseFingerprintPolicy(json)).toEqual({
      enabled: true,
      defaultMode: "normal",
      probes: [],
    });
  });

  it("lets a manifest resync write while the row is still manifest-owned", async () => {
    await setFingerprintPolicy(
      db,
      "djdl",
      JSON.stringify({ enabled: true, defaultMode: "strict", probes: [] }),
      "manifest",
      NOW,
    );
    expect(parseFingerprintPolicy((await policyOf()).json).defaultMode).toBe(
      "strict",
    );
  });

  it("refuses to let a resync clobber an operator's live edit", async () => {
    await setFingerprintPolicy(
      db,
      "djdl",
      JSON.stringify({ enabled: false, defaultMode: "off", probes: [] }),
      "admin",
      NOW,
    );
    expect((await policyOf()).source).toBe("admin");

    // A push to the product repo now re-applies the manifest — and must be ignored.
    await setFingerprintPolicy(
      db,
      "djdl",
      JSON.stringify({ enabled: true, defaultMode: "strict", probes: [] }),
      "manifest",
      NOW + 10,
    );
    const policy = parseFingerprintPolicy((await policyOf()).json);
    expect(policy.enabled).toBe(false);
    expect(policy.defaultMode).toBe("off");
  });

  it("hands ownership back on revert, and the next resync then applies", async () => {
    await setFingerprintPolicy(
      db,
      "djdl",
      JSON.stringify({ enabled: false, defaultMode: "off", probes: [] }),
      "admin",
      NOW,
    );
    // The revert is a `license.fingerprint` reset through `writeSetting()` (ST-04): it flips the
    // owner marker back to `manifest` and leaves the value for the next resync.
    expect(
      await writeSetting(
        { env: {}, db, registry: SETTINGS },
        { key: "license.fingerprint", op: "reset" },
        {
          actor: { sub: "u1", name: null, email: null },
          origin: "revert",
          principal: ROOT_PRINCIPAL,
          now: NOW + 5,
          product: "djdl",
          strict: false,
        },
      ),
    ).toMatchObject({ ok: true });
    await setFingerprintPolicy(
      db,
      "djdl",
      JSON.stringify({ enabled: true, defaultMode: "lenient", probes: [] }),
      "manifest",
      NOW + 10,
    );
    expect(parseFingerprintPolicy((await policyOf()).json).defaultMode).toBe(
      "lenient",
    );
  });

  it("survives malformed policy JSON rather than taking licensing offline", async () => {
    await db.run(
      "UPDATE products SET fingerprint_policy_json = ? WHERE slug = ?",
      "{not json",
      "djdl",
    );
    expect(parseFingerprintPolicy((await policyOf()).json).defaultMode).toBe(
      "normal",
    );
  });
});

describe("admin fingerprint reset", () => {
  let db: SqliteDb;
  let env: Env;
  let product: Product;
  const device = "device-fixture-01";

  beforeEach(async () => {
    db = makeTestDb();
    env = makeEnv(new KvMock(), ["djdl"]);
    env.ADMIN_SESSION_SECRET = "test-admin-session-secret";
    env.PLATFORM_ADMIN_GROUP = PLATFORM_GROUP;
    await seedProduct(db, "djdl");
    product = (await loadProduct(env, db, "djdl"))!;
  });

  it("clears a device's binding without deauthorizing it", async () => {
    const { licenseId, key } = await seedLicenseWithKey(db, "djdl");
    const activated = await handleActivate(
      mkReq(
        "POST",
        { authorization: `Bearer ${key}`, "x-pkey-device": device },
        {
          fingerprint: {
            components: { machineUuid: "a".repeat(22) },
            hwid: "ignored",
          },
        },
      ),
      env,
      db,
      product,
      NOW,
    );
    expect(activated.status).toBe(200);
    expect(await getFingerprint(db, "djdl", device)).not.toBeNull();

    const { token, session } = await issueSession(
      env,
      { sub: "u1", name: "Ada", email: "a@x.io", groups: [PLATFORM_GROUP] },
      NOW,
    );
    const path = `/api/products/djdl/license/licenses/${licenseId}/devices/${device}/fingerprint/reset`;
    const res = await handleAdmin(
      mkReq("POST", {
        cookie: `${ADMIN_COOKIE}=${token}`,
        [CSRF_HEADER]: session.csrf,
      }),
      env,
      db,
      path,
      { now: NOW },
    );
    expect(res.status).toBe(200);

    // Binding gone, but the device is still authorized — a false-positive lockout must not
    // cost the user their seat.
    expect(await getFingerprint(db, "djdl", device)).toBeNull();
    const row = await db.first<{ status: string }>(
      "SELECT status FROM devices WHERE product = ? AND device_id = ?",
      "djdl",
      device,
    );
    expect(row?.status).toBe("authorized");
  });
});

describe("admin fingerprint policy endpoint", () => {
  let db: SqliteDb;
  let env: Env;

  beforeEach(async () => {
    db = makeTestDb();
    env = makeEnv(new KvMock(), ["djdl"]);
    env.ADMIN_SESSION_SECRET = "test-admin-session-secret";
    env.PLATFORM_ADMIN_GROUP = PLATFORM_GROUP;
    await seedProduct(db, "djdl");
  });

  async function call(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Response> {
    const { token, session } = await issueSession(
      env,
      { sub: "u1", name: "Ada", email: "a@x.io", groups: [PLATFORM_GROUP] },
      NOW,
    );
    const headers: Record<string, string> = {
      cookie: `${ADMIN_COOKIE}=${token}`,
      [CSRF_HEADER]: session.csrf,
    };
    if (body !== undefined) headers["content-type"] = "application/json";
    return handleAdmin(mkReq(method, headers, body), env, db, path, {
      now: NOW,
    });
  }

  const KEY = (key: string) => `/api/products/djdl/settings/${key}`;
  const read = async (key: string) =>
    (
      (await (await call("GET", KEY(key))).json()) as {
        setting: { value: unknown; source: string; version: number };
      }
    ).setting;
  const write = (key: string, value: unknown, expectedVersion = 0) =>
    call("PATCH", KEY(key), { value, expectedVersion });

  it("reports the manifest-owned defaults for both policies", async () => {
    expect(await read("license.fingerprint")).toMatchObject({
      value: { enabled: true, defaultMode: "normal", probes: [] },
      source: "default",
    });
    // Auto-issue is OFF by default — issuing licenses is never a silent default.
    expect(await read("license.autoIssue")).toMatchObject({
      value: {
        enabled: false,
        tierId: null,
        mode: "anonymous",
        rateLimitPerHour: 10,
      },
      source: "default",
    });
  });

  it("enables auto-issue against a real tier", async () => {
    await seedTier(db, "djdl", "free", {});
    const res = await write("license.autoIssue", {
      enabled: true,
      tierId: "free",
      mode: "both",
      rateLimitPerHour: 10,
    });
    expect(res.status).toBe(200);
    expect(await read("license.autoIssue")).toMatchObject({
      value: { enabled: true, tierId: "free", mode: "both" },
      source: "console",
    });
  });

  it("refuses to enable auto-issue against a tier that does not exist", async () => {
    // Otherwise enrolment would mint licenses whose entitlements nobody configured.
    const res = await write("license.autoIssue", {
      enabled: true,
      tierId: "ghost",
      mode: "both",
      rateLimitPerHour: 10,
    });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ fields: ["tierId"] });
  });

  it("refuses to enable auto-issue with no tier at all", async () => {
    const res = await write("license.autoIssue", {
      enabled: true,
      tierId: null,
      mode: "both",
      rateLimitPerHour: 10,
    });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ fields: ["tierId"] });
  });

  it("rejects an unknown auto-issue mode", async () => {
    await seedTier(db, "djdl", "free", {});
    const res = await write("license.autoIssue", {
      enabled: true,
      tierId: "free",
      mode: "everyone",
      rateLimitPerHour: 10,
    });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ fields: ["mode"] });
  });

  it("takes ownership on PATCH so a later resync can't revert it", async () => {
    const res = await write("license.fingerprint", {
      enabled: true,
      defaultMode: "strict",
      probes: [
        { id: "rekordbox", label: "rekordbox", macos: "/Applications/x.app" },
      ],
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      setting: {
        source: "console",
        value: { enabled: true, defaultMode: "strict" },
      },
    });

    await setFingerprintPolicy(
      db,
      "djdl",
      JSON.stringify({ enabled: true, defaultMode: "off", probes: [] }),
      "manifest",
      NOW + 10,
    );
    expect(await read("license.fingerprint")).toMatchObject({
      value: { defaultMode: "strict" },
      source: "console",
    });
  });

  it("rejects an unknown mode with a field list", async () => {
    const res = await write("license.fingerprint", {
      enabled: true,
      defaultMode: "paranoid",
      probes: [],
    });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ fields: ["defaultMode"] });
  });

  it("rejects probes the runtime parser would silently drop", async () => {
    // A probe with no id is discarded by parseFingerprintPolicy; storing it would leave the
    // admin believing they configured something that never runs.
    const res = await write("license.fingerprint", {
      enabled: true,
      defaultMode: "normal",
      probes: [{ label: "no id here" }],
    });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ fields: ["probes"] });
  });

  it("refuses a write without the version it read", async () => {
    const res = await call("PATCH", KEY("license.fingerprint"), {
      value: { enabled: false, defaultMode: "off", probes: [] },
    });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({
      reason: "expected_version_required",
    });
  });

  it("hands ownership back on revert", async () => {
    await write("license.fingerprint", {
      enabled: false,
      defaultMode: "off",
      probes: [],
    });
    const res = await call("DELETE", KEY("license.fingerprint"), {
      expectedVersion: 0,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ applied: false });
    // The owner marker is back with the manifest; the value stays until the next resync.
    expect(
      await db.first("SELECT fingerprint_policy_source AS s FROM products"),
    ).toEqual({
      s: "manifest",
    });

    await setFingerprintPolicy(
      db,
      "djdl",
      JSON.stringify({ enabled: true, defaultMode: "lenient", probes: [] }),
      "manifest",
      NOW + 20,
    );
    expect(await read("license.fingerprint")).toMatchObject({
      value: { enabled: true, defaultMode: "lenient" },
    });
  });
});
