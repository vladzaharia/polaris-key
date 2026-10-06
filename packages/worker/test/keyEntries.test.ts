// PX-W9 (G21; WIRE-CONTRACT-V4 §12.2, plans/PX-W9.md §6): key-entry counting.
//
//   - the limit reader and the Identity scope;
//   - the device surfaces: counted exactly once per enrolment, in the seat claim's batch (the
//     concurrency tests), never for a refused or failed attempt or an enrolled re-entry;
//   - the refusal (step 4): only with the switch on, only for a usable licence in no account, and
//     never for an enrolled device; logged with the other licence refusals;
//   - installs unaffected: token refresh and the licence document (offline grace) are byte-for-byte
//     the same with counting on;
//   - the portal: both previews report `keyEntries`, a claim records one `portal` entry, and the
//     signed-out preview never counts and never answers an email, a licence id or a device.

import { beforeEach, describe, expect, it } from "vitest";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import {
  makeEnv,
  mkReq,
  NOW,
  seedLicenseWithKey,
  seedProduct,
} from "./seed.js";
import { issuePortalSessionRow } from "./portalSessionRow.js";
import { handlePortalApi } from "./portalHarness.js";
import { loadProduct, type Product } from "../src/core/products.js";
import {
  countKeyEntries,
  KEY_ENTRY_LIMIT_SETTING,
  keyEntryLimit,
  keyEntryState,
  parseKeyEntryLimit,
} from "../src/core/keyEntries.js";
import { serializeServices } from "../src/core/services.js";
import { SETTINGS } from "../src/mount.js";
import { invalidatePlatformSettings } from "../src/core/platformSettings.js";
import { claimDeviceSeat, getLicense, setServices } from "../src/repo.js";
import { authorizeDevice } from "../src/core/authz.js";
import {
  handleActivate,
  handleToken,
} from "../src/services/license/activation.js";
import { handleLicenseDocument } from "../src/services/license/document.js";
import { handleBrowserSessionLicense } from "../src/services/identity/browserSession.js";
import {
  getOrCreateAccountByEmail,
  upsertPortalProductSettings,
} from "../src/services/identity/portal/repo.js";
import {
  PORTAL_COOKIE,
  PORTAL_CSRF_HEADER,
} from "../src/services/identity/portal/session.js";
import { KEY_PREVIEW_LIMIT_PER_MINUTE } from "../src/services/identity/portal/selfService.js";
import type { Env } from "../src/env.js";
import type { SqliteDb } from "../src/db/sqlite.js";
import type { ServiceSlug } from "../src/core/services.js";

const SLUG = "djdl";

let db: SqliteDb;
let env: Env;

beforeEach(async () => {
  db = makeTestDb();
  env = makeEnv(new KvMock(), [SLUG]);
  env.PORTAL_SESSION_SECRET = "test-portal-session-secret";
  await seedProduct(db, SLUG);
});

async function setIdentity(on: boolean): Promise<Product> {
  const enabled: ServiceSlug[] = on
    ? ["license", "config", "identity"]
    : ["license", "config"];
  const services = Object.fromEntries(
    [
      "license",
      "config",
      "release",
      "distribution",
      "update",
      "identity",
      "sync",
    ].map((s) => [s, { enabled: enabled.includes(s as ServiceSlug) }]),
  );
  await setServices(
    db,
    SLUG,
    serializeServices({ services } as never),
    "manifest",
    NOW,
  );
  return (await loadProduct(env, db, SLUG))!;
}

async function setLimit(limit: number | string): Promise<void> {
  await db.run(
    `INSERT INTO product_settings (product, key, value_json, source, updated_at, updated_by)
     VALUES (?, ?, ?, 'console', ?, 'test')
     ON CONFLICT(product, key) DO UPDATE SET value_json = excluded.value_json`,
    SLUG,
    KEY_ENTRY_LIMIT_SETTING,
    typeof limit === "number" ? JSON.stringify(limit) : limit,
    NOW,
  );
}

async function setRefusals(on: boolean): Promise<void> {
  await db.run(
    `INSERT INTO platform_settings (key, value_json, version, updated_at, updated_by)
     VALUES ('KEYENTRY_REFUSALS', ?, 1, ?, 'test')
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`,
    JSON.stringify(on ? "on" : "off"),
    NOW,
  );
  // As a console write does: this isolate sees its own change at once.
  invalidatePlatformSettings(env, db);
}

/** A seat limit high enough that only the key-entry limit can refuse. */
const SEATS = (n: number) => ({
  entitlements: {
    deviceLimit: { state: "enforced" as const, value: n, updatedAt: NOW },
  },
});

function activate(
  product: Product,
  key: string,
  device: string,
  now = NOW,
): Promise<Response> {
  return handleActivate(
    mkReq("POST", {
      authorization: `Bearer ${key}`,
      "x-pkey-device": device,
      "x-pkey-platform": "linux",
      "x-pkey-arch": "x64",
    }),
    env,
    db,
    product,
    now,
  );
}

async function rows(licenseId: string) {
  return db.all<{ surface: string; device_id: string | null }>(
    "SELECT surface, device_id FROM license_key_entries WHERE product = ? AND license_id = ? ORDER BY created_at, id",
    SLUG,
    licenseId,
  );
}

describe("the limit (§12.2 rule 5)", () => {
  it("parses only an integer from 1 to 100", () => {
    expect(parseKeyEntryLimit("5")).toBe(5);
    expect(parseKeyEntryLimit("1")).toBe(1);
    expect(parseKeyEntryLimit("100")).toBe(100);
    for (const bad of ["0", "101", "2.5", '"5"', "null", "x", "-1"])
      expect(parseKeyEntryLimit(bad), bad).toBeNull();
    expect(parseKeyEntryLimit(null)).toBeNull();
  });

  it("is resolved through ST-04's resolver: the product_settings row, else 10", async () => {
    const ctx = { env, db, registry: SETTINGS };
    expect(await keyEntryLimit(ctx, SLUG)).toBe(10);
    await setLimit(3);
    expect(await keyEntryLimit(ctx, SLUG)).toBe(3);
    // A stored value that is not one (outside 1 to 100) is ignored, as the resolver ignores it.
    await setLimit(500);
    expect(await keyEntryLimit(ctx, SLUG)).toBe(10);
  });

  it("ignores an expired break-glass claim (ST-20), as the resolver does", async () => {
    await setLimit(3);
    await db.run(
      "UPDATE product_settings SET expires_at = ? WHERE product = ? AND key = ?",
      NOW - 1,
      SLUG,
      KEY_ENTRY_LIMIT_SETTING,
    );
    expect(await keyEntryLimit({ env, db, registry: SETTINGS }, SLUG)).toBe(10);
  });

  it("without a registry (a context built by hand) reads the stored row, else 10", async () => {
    expect(await keyEntryLimit({ env, db }, SLUG)).toBe(10);
    await setLimit(3);
    expect(await keyEntryLimit({ env, db }, SLUG)).toBe(3);
    await setLimit(500);
    expect(await keyEntryLimit({ env, db }, SLUG)).toBe(10);
  });

  it("exists only while Identity is on", async () => {
    const ctx = { env, db, registry: SETTINGS };
    const { licenseId } = await seedLicenseWithKey(db, SLUG);
    expect(await keyEntryState(ctx, SLUG, licenseId)).toBeNull();
    await setIdentity(true);
    expect(await keyEntryState(ctx, SLUG, licenseId)).toEqual({
      used: 0,
      limit: 10,
    });
  });
});

describe("app entries (POST /<p>/license/activate)", () => {
  it("Identity off: no member, nothing counted, never refused", async () => {
    const product = await setIdentity(false);
    const { key, licenseId } = await seedLicenseWithKey(db, SLUG, SEATS(5));
    await setLimit(1);
    await setRefusals(true);
    await db.run(
      `INSERT INTO license_key_entries (product, license_id, id, surface, device_id, created_at)
       VALUES (?, ?, 'ke_old', 'app', 'old', ?)`,
      SLUG,
      licenseId,
      NOW,
    );
    const res = await activate(product, key, "dev-1");
    expect(res.status).toBe(200);
    expect(await res.json()).not.toHaveProperty("keyEntries");
    expect(await countKeyEntries(db, SLUG, licenseId)).toBe(1);
  });

  it("counts a new device once, and an enrolled device's re-entry never", async () => {
    const product = await setIdentity(true);
    const { key, licenseId } = await seedLicenseWithKey(db, SLUG, SEATS(5));
    const first = await activate(product, key, "dev-1");
    expect(first.status).toBe(200);
    const body = (await first.json()) as Record<string, unknown>;
    expect(body.keyEntries).toEqual({ used: 1, limit: 10 });
    // The member rides beside the four ActivationResult fields; nothing else changes.
    expect(Object.keys(body)).toEqual([
      "token",
      "schemaVersion",
      "device",
      "license",
      "keyEntries",
    ]);

    const again = await activate(product, key, "dev-1", NOW + 60);
    expect(
      ((await again.json()) as { keyEntries: unknown }).keyEntries,
    ).toEqual({ used: 1, limit: 10 });
    const second = await activate(product, key, "dev-2", NOW + 120);
    expect(
      ((await second.json()) as { keyEntries: unknown }).keyEntries,
    ).toEqual({ used: 2, limit: 10 });
    expect(await rows(licenseId)).toEqual([
      { surface: "app", device_id: "dev-1" },
      { surface: "app", device_id: "dev-2" },
    ]);
  });

  it("concurrency: N parallel new devices write exactly as many rows as there are successes", async () => {
    const product = await setIdentity(true);
    // Five seats, eight devices: three are refused `device_limit` and write nothing.
    const { key, licenseId } = await seedLicenseWithKey(db, SLUG, SEATS(5));
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => activate(product, key, `dev-${i}`)),
    );
    const ok = results.filter((r) => r.status === 200).length;
    expect(ok).toBe(5);
    expect(results.filter((r) => r.status === 403).length).toBe(3);
    expect(await countKeyEntries(db, SLUG, licenseId)).toBe(ok);
  });

  it("concurrency: N parallel calls from one device write one row", async () => {
    const product = await setIdentity(true);
    const { key, licenseId } = await seedLicenseWithKey(db, SLUG, SEATS(5));
    const results = await Promise.all(
      Array.from({ length: 8 }, () => activate(product, key, "dev-1")),
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(await rows(licenseId)).toEqual([
      { surface: "app", device_id: "dev-1" },
    ]);
  });

  // The two tests above go through the route, whose rate limiter serialises the calls a little.
  // These call `authorizeDevice` itself, so every call reads "not enrolled" and computes the same
  // free ordinal before any of them commits: the seat claims race for real.
  it("concurrency at the seat claim: one device's racing claims write one row", async () => {
    const product = await setIdentity(true);
    const { licenseId } = await seedLicenseWithKey(db, SLUG, SEATS(5));
    const license = (await getLicense(db, SLUG, licenseId))!;
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        authorizeDevice(env, db, product, license, "dev-1", NOW, {
          keyEntry: { surface: "app" },
        }),
      ),
    );
    expect(results.every((r) => !("error" in r))).toBe(true);
    expect(await rows(licenseId)).toEqual([
      { surface: "app", device_id: "dev-1" },
    ]);
  });

  it("concurrency at the seat claim: racing new devices write exactly one row per seat won", async () => {
    const product = await setIdentity(true);
    const { licenseId } = await seedLicenseWithKey(db, SLUG, SEATS(3));
    const license = (await getLicense(db, SLUG, licenseId))!;
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        authorizeDevice(env, db, product, license, `dev-${i}`, NOW, {
          keyEntry: { surface: "app" },
        }),
      ),
    );
    const won = results.filter((r) => !("error" in r)).length;
    expect(won).toBe(3);
    // Every loser of an ordinal race rolled its entry back with its seat.
    expect(await countKeyEntries(db, SLUG, licenseId)).toBe(won);
    const seated = await db.all<{ device_id: string }>(
      "SELECT device_id FROM devices WHERE product = ? AND license_id = ? AND status = 'authorized' ORDER BY device_id",
      SLUG,
      licenseId,
    );
    expect((await rows(licenseId)).map((r) => r.device_id).sort()).toEqual(
      seated.map((d) => d.device_id),
    );
  });

  it("a seat claim retries only a lost ordinal race: a failed entry write is an error, not device_limit", async () => {
    await setIdentity(true);
    const { licenseId } = await seedLicenseWithKey(db, SLUG, SEATS(5));
    // A write the table refuses (a CHECK, not a UNIQUE loss) must not be read as "every seat is
    // taken" and retried into a `device_limit`.
    await expect(
      claimDeviceSeat(db, SLUG, licenseId, "dev-1", 5, NOW, {
        withClaim: () => ({
          sql: `INSERT INTO license_key_entries (product, license_id, id, surface, device_id, created_at)
                VALUES (?, ?, 'ke_bad', 'bogus', 'dev-1', ?)`,
          params: [SLUG, licenseId, NOW],
        }),
      }),
    ).rejects.toThrow(/CHECK constraint failed/i);
    // The batch rolled back: no seat, no entry.
    expect(
      await db.first(
        "SELECT 1 FROM devices WHERE product = ? AND device_id = 'dev-1'",
        SLUG,
      ),
    ).toBeNull();
    expect(await countKeyEntries(db, SLUG, licenseId)).toBe(0);
  });

  it("a refused or failed attempt writes nothing", async () => {
    const product = await setIdentity(true);
    const { key, licenseId } = await seedLicenseWithKey(db, SLUG, SEATS(1));
    expect((await activate(product, key, "dev-1")).status).toBe(200);
    // The only seat is taken: `device_limit`, not counted.
    expect((await activate(product, key, "dev-2")).status).toBe(403);
    // An unknown key never reaches the counter.
    expect(
      (await activate(product, `pkey_${SLUG}_${"x".repeat(22)}`, "dev-3"))
        .status,
    ).toBe(401);
    expect(await countKeyEntries(db, SLUG, licenseId)).toBe(1);
  });

  it("re-enrolling after a deauthorization counts again (a new enrolment)", async () => {
    const product = await setIdentity(true);
    const { key, licenseId } = await seedLicenseWithKey(db, SLUG, SEATS(5));
    expect((await activate(product, key, "dev-1")).status).toBe(200);
    await db.run(
      "UPDATE devices SET status = 'deauthorized', seat_no = NULL WHERE product = ? AND device_id = ?",
      SLUG,
      "dev-1",
    );
    expect((await activate(product, key, "dev-1", NOW + 60)).status).toBe(200);
    expect(await countKeyEntries(db, SLUG, licenseId)).toBe(2);
  });
});

describe("the refusal (§12.2 step 4)", () => {
  async function atLimit(opts: { refusals: boolean }) {
    const product = await setIdentity(true);
    const seeded = await seedLicenseWithKey(db, SLUG, SEATS(10));
    await setLimit(2);
    await setRefusals(opts.refusals);
    expect((await activate(product, seeded.key, "dev-1")).status).toBe(200);
    expect((await activate(product, seeded.key, "dev-2")).status).toBe(200);
    return { product, ...seeded };
  }

  it("refuses a new device past the limit with keyEntries and the portal link, writing only the refusal log", async () => {
    const { product, key, licenseId } = await atLimit({ refusals: true });
    const res = await activate(product, key, "dev-3", NOW + 60);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: "key_entry_limit",
      message: "key entry limit reached",
      manageUrl: `https://key.plrs.im/activate?product=${SLUG}`,
      keyEntries: { used: 2, limit: 2 },
    });
    expect(await countKeyEntries(db, SLUG, licenseId)).toBe(2);
    const device = await db.first(
      "SELECT 1 FROM devices WHERE product = ? AND device_id = 'dev-3'",
      SLUG,
    );
    expect(device).toBeNull();
    const logged = await db.all<{ reason: string }>(
      "SELECT reason FROM license_refusals WHERE product = ? AND license_id = ?",
      SLUG,
      licenseId,
    );
    expect(logged.map((r) => r.reason)).toEqual(["key_entry_limit"]);
  });

  it("never refuses an enrolled device, and its token refresh and documents are unchanged", async () => {
    const { product, key, licenseId } = await atLimit({ refusals: true });
    const enrolled = await activate(product, key, "dev-1", NOW + 60);
    expect(enrolled.status).toBe(200);
    const { token } = (await enrolled.json()) as { token: string };
    const refreshed = await handleToken(
      mkReq("POST", {
        authorization: `Bearer ${token}`,
        "x-pkey-device": "dev-1",
      }),
      env,
      db,
      product,
      NOW + 120,
    );
    expect(refreshed.status).toBe(200);
    expect(await refreshed.json()).not.toHaveProperty("keyEntries");
    expect(await countKeyEntries(db, SLUG, licenseId)).toBe(2);
  });

  it("drops the link while the portal is off", async () => {
    const { product, key } = await atLimit({ refusals: true });
    await db.run(
      `INSERT INTO portal_product_settings (product, portal_enabled, created_at, modified_at)
       VALUES (?, 0, ?, ?)`,
      SLUG,
      NOW,
      NOW,
    );
    const res = await activate(product, key, "dev-3", NOW + 60);
    expect(res.status).toBe(403);
    expect(await res.json()).not.toHaveProperty("manageUrl");
  });

  it("switch off: counted past the limit, never refused", async () => {
    const { product, key, licenseId } = await atLimit({ refusals: false });
    const res = await activate(product, key, "dev-3", NOW + 60);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { keyEntries: unknown }).keyEntries).toEqual({
      used: 3,
      limit: 2,
    });
    expect(await countKeyEntries(db, SLUG, licenseId)).toBe(3);
  });

  it("applies only to a licence in no account (§8 Q3); a licence in an account is still counted", async () => {
    const { product, key, licenseId } = await atLimit({ refusals: true });
    await db.run(
      "UPDATE licenses SET account_id = 'acct_x' WHERE product = ? AND id = ?",
      SLUG,
      licenseId,
    );
    const res = await activate(product, key, "dev-3", NOW + 60);
    expect(res.status).toBe(200);
    expect(await countKeyEntries(db, SLUG, licenseId)).toBe(3);
  });

  it("an unusable licence keeps its 401", async () => {
    const { product, key, licenseId } = await atLimit({ refusals: true });
    await db.run(
      "UPDATE licenses SET status = 'disabled' WHERE product = ? AND id = ?",
      SLUG,
      licenseId,
    );
    expect((await activate(product, key, "dev-3", NOW + 60)).status).toBe(401);
  });
});

describe("installs are unaffected", () => {
  it("the licence document is byte-for-byte the same with counting on (offline grace included)", async () => {
    const product = await setIdentity(true);
    const { key, licenseId } = await seedLicenseWithKey(db, SLUG, SEATS(5));
    const { token } = (await (
      await activate(product, key, "dev-1")
    ).json()) as {
      token: string;
    };
    const doc = async () =>
      (
        await handleLicenseDocument(
          mkReq("GET", {
            authorization: `Bearer ${token}`,
            "x-pkey-version": "1.2.3",
          }),
          env,
          db,
          product,
          NOW + 300,
        )
      ).text();
    const before = await doc();
    // Push the licence past its limit and turn refusals on: the enrolled device's document and
    // its grace window do not move.
    await setLimit(1);
    await setRefusals(true);
    for (let i = 0; i < 3; i++)
      await db.run(
        `INSERT INTO license_key_entries (product, license_id, id, surface, device_id, created_at)
         VALUES (?, ?, ?, 'portal', NULL, ?)`,
        SLUG,
        licenseId,
        `ke_p${i}`,
        NOW,
      );
    expect(await doc()).toBe(before);
  });
});

describe("browser entries (POST /<p>/identity/session/license)", () => {
  function session(key: string, now = NOW): Promise<Response> {
    return handleBrowserSessionLicense(
      new Request(`https://key.plrs.im/${SLUG}/identity/session/license`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key }),
      }) as unknown as Request,
      env,
      db,
      productRef!,
      now,
    );
  }
  let productRef: Product | null = null;

  it("answers 201 {ok, keyEntries}, counts once per enrolment, and refuses at the limit", async () => {
    productRef = await setIdentity(true);
    const { key, licenseId } = await seedLicenseWithKey(db, SLUG, SEATS(5));
    const first = await session(key);
    expect(first.status).toBe(201);
    expect(await first.json()).toEqual({
      ok: true,
      keyEntries: { used: 1, limit: 10 },
    });
    // The browser device is `browser:<licenseId>`: a second session is an enrolled re-entry.
    const again = await session(key, NOW + 60);
    expect(await again.json()).toEqual({
      ok: true,
      keyEntries: { used: 1, limit: 10 },
    });
    expect(await rows(licenseId)).toEqual([
      { surface: "browser", device_id: `browser:${licenseId}` },
    ]);

    // Sign out (it deauthorizes the browser device), then the limit is 1.
    await db.run(
      "UPDATE devices SET status = 'deauthorized', seat_no = NULL WHERE product = ? AND device_id = ?",
      SLUG,
      `browser:${licenseId}`,
    );
    await setLimit(1);
    await setRefusals(true);
    const refused = await session(key, NOW + 120);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({
      error: "key_entry_limit",
      keyEntries: { used: 1, limit: 1 },
      manageUrl: `https://key.plrs.im/activate?product=${SLUG}`,
    });
    expect(await countKeyEntries(db, SLUG, licenseId)).toBe(1);
  });
});

// ── The portal ──────────────────────────────────────────────────────────────────────────────

interface Session {
  cookie: string;
  csrf: string;
}

async function portalSession(email: string): Promise<Session> {
  const account = await getOrCreateAccountByEmail(db, email, NOW);
  const { token, session } = await issuePortalSessionRow(
    env,
    db,
    {
      accountId: account.id,
      email: account.primary_email,
      name: account.display_name,
    },
    NOW,
  );
  return { cookie: `${PORTAL_COOKIE}=${token}`, csrf: session.csrf };
}

function portal(
  path: string,
  body: unknown,
  s: Session | null,
  headers: Record<string, string> = {},
): Promise<Response> {
  const h: Record<string, string> = {
    "content-type": "application/json",
    ...headers,
  };
  if (s) {
    h.cookie = s.cookie;
    h[PORTAL_CSRF_HEADER] = s.csrf;
  }
  return handlePortalApi(
    new Request(`https://key.plrs.im${path}`, {
      method: "POST",
      headers: h,
      body: JSON.stringify(body),
    }) as unknown as Request,
    env,
    db,
    path,
    NOW,
  );
}

describe("portal entries", () => {
  it("the signed-in preview reports keyEntries; the claim records one portal entry; already_yours none", async () => {
    await setIdentity(true);
    const { key, licenseId } = await seedLicenseWithKey(db, SLUG);
    await upsertPortalProductSettings(db, SLUG, { claimByKey: true }, NOW);
    const s = await portalSession("bob@example.com");

    const preview = await portal("/api/activate/preview", { key }, s);
    expect(preview.status).toBe(200);
    expect(await preview.json()).toMatchObject({
      verdict: "addable",
      keyEntries: { used: 0, limit: 10 },
    });
    expect(await countKeyEntries(db, SLUG, licenseId)).toBe(0);

    const claimed = await portal("/api/claim/license-key", { key }, s);
    expect(claimed.status).toBe(200);
    expect(await claimed.json()).toMatchObject({
      ok: true,
      keyEntries: { used: 1, limit: 10 },
    });
    expect(await rows(licenseId)).toEqual([
      { surface: "portal", device_id: null },
    ]);

    const twice = await portal("/api/claim/license-key", { key }, s);
    expect(twice.status).toBe(200);
    expect(await twice.json()).toMatchObject({
      keyEntries: { used: 1, limit: 10 },
    });
    expect(await countKeyEntries(db, SLUG, licenseId)).toBe(1);
  });

  it("a claim past the limit still commits and writes its row (never refused)", async () => {
    await setIdentity(true);
    const { key, licenseId } = await seedLicenseWithKey(db, SLUG);
    await upsertPortalProductSettings(db, SLUG, { claimByKey: true }, NOW);
    await setLimit(1);
    await setRefusals(true);
    await db.run(
      `INSERT INTO license_key_entries (product, license_id, id, surface, device_id, created_at)
       VALUES (?, ?, 'ke_a', 'app', 'dev-a', ?)`,
      SLUG,
      licenseId,
      NOW,
    );
    const s = await portalSession("bob@example.com");
    const claimed = await portal("/api/claim/license-key", { key }, s);
    expect(claimed.status).toBe(200);
    expect(await countKeyEntries(db, SLUG, licenseId)).toBe(2);
  });

  it("Identity off: the previews answer keyEntries null and the claim counts nothing", async () => {
    await setIdentity(false);
    const { key, licenseId } = await seedLicenseWithKey(db, SLUG);
    await upsertPortalProductSettings(db, SLUG, { claimByKey: true }, NOW);
    const s = await portalSession("bob@example.com");
    expect(
      await (await portal("/api/activate/preview", { key }, s)).json(),
    ).toMatchObject({ keyEntries: null });
    const claimed = await portal("/api/claim/license-key", { key }, s);
    expect(await claimed.json()).not.toHaveProperty("keyEntries");
    expect(await countKeyEntries(db, SLUG, licenseId)).toBe(0);
    expect(
      await (await portal("/api/key/preview", { key }, null)).json(),
    ).toMatchObject({ keyEntries: null, upgrade: "skippable" });
  });
});

describe("the signed-out key preview (POST /api/key/preview)", () => {
  it("answers the product, tier, term, meter and upgrade, and never counts", async () => {
    await setIdentity(true);
    const { key, licenseId } = await seedLicenseWithKey(db, SLUG, {
      expiresAt: NOW + 86_400,
    });
    const res = await portal("/api/key/preview", { key }, null);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({
      product: expect.objectContaining({ slug: SLUG, name: SLUG }),
      verdict: "addable",
      license: { tierName: null, term: NOW + 86_400 },
      keyEntries: { used: 0, limit: 10 },
      upgrade: "skippable",
    });
    const text = JSON.stringify(body);
    expect(text).not.toContain(licenseId);
    expect(text).not.toContain("ada@example.com");
    expect(text).not.toContain("a•••");
    expect(text).not.toContain(key);
    expect(await countKeyEntries(db, SLUG, licenseId)).toBe(0);
  });

  it("forces the upgrade only at the limit AND with refusals on (§8 Q4)", async () => {
    await setIdentity(true);
    const { key, licenseId } = await seedLicenseWithKey(db, SLUG);
    await setLimit(1);
    await db.run(
      `INSERT INTO license_key_entries (product, license_id, id, surface, device_id, created_at)
       VALUES (?, ?, 'ke_a', 'app', 'dev-a', ?)`,
      SLUG,
      licenseId,
      NOW,
    );
    const upgrade = async () =>
      (
        (await (await portal("/api/key/preview", { key }, null)).json()) as {
          upgrade: string;
        }
      ).upgrade;
    expect(await upgrade()).toBe("skippable"); // at the limit, refusals off
    await setRefusals(true);
    expect(await upgrade()).toBe("forced");
  });

  it("says only that an owned licence is in an account", async () => {
    await setIdentity(true);
    const { key, licenseId } = await seedLicenseWithKey(db, SLUG);
    await db.run(
      "UPDATE licenses SET account_id = 'acct_owner' WHERE product = ? AND id = ?",
      SLUG,
      licenseId,
    );
    const body = (await (
      await portal("/api/key/preview", { key }, null)
    ).json()) as Record<string, unknown>;
    expect(body.verdict).toBe("license_owned");
    expect(body.upgrade).toBe("skippable");
    expect(JSON.stringify(body)).not.toContain("acct_owner");
    expect(JSON.stringify(body)).not.toContain(licenseId);
  });

  it("portal_off, an unusable string (422), an unknown key (401)", async () => {
    await setIdentity(true);
    const { key } = await seedLicenseWithKey(db, SLUG);
    await db.run(
      `INSERT INTO portal_product_settings (product, portal_enabled, created_at, modified_at)
       VALUES (?, 0, ?, ?)`,
      SLUG,
      NOW,
      NOW,
    );
    expect(
      await (await portal("/api/key/preview", { key }, null)).json(),
    ).toMatchObject({
      verdict: "portal_off",
      license: null,
      keyEntries: null,
      upgrade: "skippable",
    });
    expect(
      (await portal("/api/key/preview", { key: "not a key" }, null)).status,
    ).toBe(422);
    expect(
      (
        await portal(
          "/api/key/preview",
          { key: `pkey_${SLUG}_${"y".repeat(22)}` },
          null,
        )
      ).status,
    ).toBe(401);
  });

  it("charges a per-network bucket before any lookup", async () => {
    const headers = { "cf-connecting-ip": "203.0.113.9" };
    for (let i = 0; i < KEY_PREVIEW_LIMIT_PER_MINUTE; i++)
      expect(
        (await portal("/api/key/preview", { key: "x" }, null, headers)).status,
      ).toBe(422);
    expect(
      (await portal("/api/key/preview", { key: "x" }, null, headers)).status,
    ).toBe(429);
  });
});
