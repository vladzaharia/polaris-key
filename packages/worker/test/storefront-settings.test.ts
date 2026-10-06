/**
 * PS-02 (notes/S-21 §6.2): the Polaris Key listing state.
 *
 *   - migration 0078 backfills `store_listed = 'unlisted'` where `discover_enabled = 0` and leaves
 *     every other product `auto`;
 *   - it is expand-only: a Worker from before it (its exact INSERT/UPSERT and `SELECT *`) reads and
 *     writes `portal_product_settings` unaffected;
 *   - `storefrontListing` resolves the row with the `discover_enabled` dual-read, and the writer
 *     keeps the two columns in step;
 *   - the portal-settings admin route accepts the new fields, validates them, audits a change and
 *     asks for a typed confirmation to widen the audience to `everyone`.
 */

import Database from "better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SqliteDb } from "../src/db/sqlite.js";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { makeEnv, NOW, seedProduct } from "./seed.js";
import type { Env } from "../src/env.js";
import type { Db } from "../src/db/types.js";
import { handleAdmin } from "../src/admin/index.js";
import {
  ADMIN_COOKIE,
  CSRF_HEADER,
  issueSession,
} from "../src/admin/session.js";
import { listAudit } from "../src/repo.js";
import {
  getPortalProductSettings,
  portalProductSettingsView,
  upsertPortalProductSettings,
} from "../src/services/identity/portal/repo.js";
import { storefrontListing } from "../src/services/identity/portal/storefrontListing.js";
import {
  DEFAULT_LISTING,
  OBTAIN_PATH_KINDS,
  parseGroupLabels,
  parseOfferPaths,
  resolveListing,
} from "../src/core/storefront/polarisKeyListing.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = join(HERE, "..", "migrations");
const FILES = readdirSync(DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort();
const PS02 = "0078_storefront_listing.sql";
const BEFORE = FILES.filter((f) => f < PS02);
const AFTER = FILES.filter((f) => f > PS02);
const sql = (f: string) => readFileSync(join(DIR, f), "utf8");

/** The pre-PS-02 Worker's upsert, verbatim (its column list stops at `discover_enabled`). */
const LEGACY_UPSERT = `INSERT INTO portal_product_settings
   (product, portal_enabled, oidc_enabled, magic_enabled,
    license_key_claim_enabled, releases_enabled, auto_link_enabled,
    key_reissue_enabled, claim_by_key, discover_enabled, branding_json, created_at,
    modified_at)
 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
 ON CONFLICT(product) DO UPDATE SET
   portal_enabled = excluded.portal_enabled,
   oidc_enabled = excluded.oidc_enabled,
   magic_enabled = excluded.magic_enabled,
   license_key_claim_enabled = excluded.license_key_claim_enabled,
   releases_enabled = excluded.releases_enabled,
   auto_link_enabled = excluded.auto_link_enabled,
   key_reissue_enabled = excluded.key_reissue_enabled,
   claim_by_key = excluded.claim_by_key,
   discover_enabled = excluded.discover_enabled,
   branding_json = excluded.branding_json,
   modified_at = excluded.modified_at`;

function legacyUpsert(
  raw: Database.Database,
  product: string,
  discover: 0 | 1,
) {
  raw
    .prepare(LEGACY_UPSERT)
    .run(product, 1, 1, 1, 1, 1, null, 0, 0, discover, null, NOW, NOW);
}

/** A database at 0073 holding three products: Discover on, Discover off, and no settings row. */
async function beforePs02(): Promise<Database.Database> {
  const raw = new Database(":memory:");
  for (const f of BEFORE) raw.exec(sql(f));
  for (const slug of ["on", "off", "bare"])
    await seedProduct(new SqliteDb(raw), slug);
  legacyUpsert(raw, "on", 1);
  legacyUpsert(raw, "off", 0);
  return raw;
}

describe("migration 0078 (PS-02)", () => {
  it("backfills unlisted where Discover was off; every other product reads auto", async () => {
    const raw = await beforePs02();
    raw.exec(sql(PS02));
    for (const f of AFTER) raw.exec(sql(f));
    const db = new SqliteDb(raw);

    const stored = raw
      .prepare(
        "SELECT product, store_listed, store_audience, store_offer_paths_json, store_group_labels_json FROM portal_product_settings ORDER BY product",
      )
      .all();
    expect(stored).toEqual([
      {
        product: "off",
        store_listed: "unlisted",
        store_audience: "eligible",
        store_offer_paths_json: null,
        store_group_labels_json: null,
      },
      {
        product: "on",
        store_listed: "auto",
        store_audience: "eligible",
        store_offer_paths_json: null,
        store_group_labels_json: null,
      },
    ]);
    expect((await storefrontListing(db, "off")).listed).toBe("unlisted");
    expect(await storefrontListing(db, "on")).toEqual(DEFAULT_LISTING);
    expect(await storefrontListing(db, "bare")).toEqual(DEFAULT_LISTING);
  });

  it("refuses a listing state or audience outside the CHECK lists", async () => {
    const raw = await beforePs02();
    raw.exec(sql(PS02));
    expect(() =>
      raw.exec(
        "UPDATE portal_product_settings SET store_listed = 'public' WHERE product = 'on'",
      ),
    ).toThrow(/CHECK/);
    expect(() =>
      raw.exec(
        "UPDATE portal_product_settings SET store_audience = 'anyone' WHERE product = 'on'",
      ),
    ).toThrow(/CHECK/);
  });

  it("is expand-only: a pre-PS-02 Worker reads and writes the table unaffected", async () => {
    const raw = await beforePs02();
    raw.exec(sql(PS02));
    const db = new SqliteDb(raw);
    // The new Worker narrows a product's paths and labels a group…
    await upsertPortalProductSettings(
      db,
      "on",
      {
        storeListed: "listed",
        storeOfferPaths: ["group"],
        storeGroupLabels: { staff: "Staff copy" },
      },
      NOW,
    );
    // …then the old Worker writes the row (its UPSERT never names the new columns) and inserts a
    // fresh one, which takes the column defaults.
    legacyUpsert(raw, "on", 1);
    legacyUpsert(raw, "bare", 1);
    const on = raw
      .prepare("SELECT * FROM portal_product_settings WHERE product = 'on'")
      .get() as Record<string, unknown>;
    expect(on).toMatchObject({
      discover_enabled: 1,
      store_listed: "listed",
      store_offer_paths_json: '["group"]',
      store_group_labels_json: '{"staff":"Staff copy"}',
    });
    expect((await storefrontListing(db, "bare")).listed).toBe("auto");

    // The old Worker turning Discover off is still obeyed (dual-read), whatever store_listed says.
    legacyUpsert(raw, "on", 0);
    expect((await storefrontListing(db, "on")).listed).toBe("unlisted");
  });
});

describe("storefrontListing and the writer (PS-02)", () => {
  it("reads the defaults for a product without a settings row", async () => {
    const db = makeTestDb();
    await seedProduct(db, "mossgarden");
    expect(await storefrontListing(db, "mossgarden")).toEqual({
      listed: "auto",
      audience: "eligible",
      offerPaths: OBTAIN_PATH_KINDS,
      offerPathsAll: true,
      groupLabels: {},
    });
  });

  it("writes and reads every value back, normalising the path order", async () => {
    const db = makeTestDb();
    await seedProduct(db, "mossgarden");
    await upsertPortalProductSettings(
      db,
      "mossgarden",
      {
        storeListed: "listed",
        storeAudience: "everyone",
        storeOfferPaths: parseOfferPaths(["open", "group", "open"])!,
        storeGroupLabels: { "aperture-7": "Included with Aperture Seven" },
      },
      NOW,
    );
    expect(await storefrontListing(db, "mossgarden")).toEqual({
      listed: "listed",
      audience: "everyone",
      offerPaths: ["group", "open"],
      offerPathsAll: false,
      groupLabels: { "aperture-7": "Included with Aperture Seven" },
    });
    // null restores every kind; an empty label map stores NULL.
    await upsertPortalProductSettings(
      db,
      "mossgarden",
      { storeOfferPaths: null, storeGroupLabels: {} },
      NOW,
    );
    const row = await getPortalProductSettings(db, "mossgarden");
    expect(row.store_offer_paths_json).toBeNull();
    expect(row.store_group_labels_json).toBeNull();
    expect((await storefrontListing(db, "mossgarden")).offerPathsAll).toBe(
      true,
    );
  });

  it("keeps discover_enabled in step with the listing state (dual-write)", async () => {
    const db = makeTestDb();
    await seedProduct(db, "mossgarden");
    const up = (patch: Parameters<typeof upsertPortalProductSettings>[2]) =>
      upsertPortalProductSettings(db, "mossgarden", patch, NOW);

    let row = await up({ storeListed: "unlisted" });
    expect([row.store_listed, row.discover_enabled]).toEqual(["unlisted", 0]);
    row = await up({ storeListed: "listed" });
    expect([row.store_listed, row.discover_enabled]).toEqual(["listed", 1]);
    // Discover on, unchanged, keeps an explicit state; off makes it unlisted; on again is auto.
    row = await up({ discoverEnabled: true });
    expect(row.store_listed).toBe("listed");
    row = await up({ discoverEnabled: false });
    expect([row.store_listed, row.discover_enabled]).toEqual(["unlisted", 0]);
    row = await up({ discoverEnabled: true });
    expect([row.store_listed, row.discover_enabled]).toEqual(["auto", 1]);
    // The listing state wins over the Discover switch in one patch.
    row = await up({ discoverEnabled: false, storeListed: "listed" });
    expect([row.store_listed, row.discover_enabled]).toEqual(["listed", 1]);
  });

  it("validates submitted values and fails closed on a stored value that no longer parses", () => {
    expect(parseOfferPaths(null)).toBeNull();
    expect(parseOfferPaths(["group", "nope"])).toBeUndefined();
    expect(parseOfferPaths("group")).toBeUndefined();
    expect(parseOfferPaths([])).toEqual([]);
    expect(parseGroupLabels({ g: "  Staff  " })).toEqual({ g: "Staff" });
    expect(parseGroupLabels({ g: "x".repeat(41) })).toBeUndefined();
    expect(parseGroupLabels({ g: "   " })).toBeUndefined();
    expect(parseGroupLabels({ "": "Staff" })).toBeUndefined();
    expect(parseGroupLabels({ g: 1 })).toBeUndefined();
    expect(parseGroupLabels(["Staff"])).toBeUndefined();
    expect(
      parseGroupLabels(
        Object.fromEntries(
          Array.from({ length: 101 }, (_, i) => [`g${i}`, "L"]),
        ),
      ),
    ).toBeUndefined();

    const base = {
      discover_enabled: 1,
      store_listed: "auto",
      store_audience: "eligible",
      store_offer_paths_json: null,
      store_group_labels_json: null,
    };
    expect(
      resolveListing({ ...base, store_offer_paths_json: "{not json" }),
    ).toMatchObject({ offerPaths: [], offerPathsAll: false });
    // A kind written by a newer Worker is dropped, not refused.
    expect(
      resolveListing({
        ...base,
        store_offer_paths_json: '["open","future_kind"]',
      }).offerPaths,
    ).toEqual(["open"]);
    expect(
      resolveListing({ ...base, store_group_labels_json: '{"g":42}' })
        .groupLabels,
    ).toEqual({});
    // An unknown listing state fails closed; a missing column is the default.
    expect(resolveListing({ ...base, store_listed: "public" }).listed).toBe(
      "unlisted",
    );
    expect(resolveListing({ ...base, store_listed: null }).listed).toBe("auto");
  });

  it("derives discoverEnabled from the resolved state (deploy-window row)", async () => {
    const db = makeTestDb();
    await seedProduct(db, "mossgarden");
    await upsertPortalProductSettings(
      db,
      "mossgarden",
      { storeListed: "unlisted" },
      NOW,
    );
    // A pre-0078 Worker turns Discover back on without naming store_listed.
    await db.run(
      "UPDATE portal_product_settings SET discover_enabled = 1 WHERE product = ?",
      "mossgarden",
    );
    const view = portalProductSettingsView(
      await getPortalProductSettings(db, "mossgarden"),
    );
    expect([view.discoverEnabled, view.storeListed]).toEqual([
      false,
      "unlisted",
    ]);
  });
});

// ── The admin route ──────────────────────────────────────────────────────────────────────────

const ADMIN_SECRET = "test-admin-session-secret";
const PLATFORM_GROUP = "platform-admins";
const SLUG = "djdl";
const PATH = `/api/products/${SLUG}/identity/portal`;

async function fixture() {
  const db = makeTestDb();
  const env: Env = makeEnv(new KvMock(), [SLUG]);
  env.ADMIN_SESSION_SECRET = ADMIN_SECRET;
  env.PLATFORM_ADMIN_GROUP = PLATFORM_GROUP;
  await seedProduct(db, SLUG);
  const { token, session } = await issueSession(
    env,
    { sub: "u1", name: "Ada", email: "ada@x.io", groups: [PLATFORM_GROUP] },
    NOW,
  );
  const patch = (body: unknown) =>
    handleAdmin(
      new Request(`https://key.plrs.im/manage${PATH}`, {
        method: "PATCH",
        headers: {
          cookie: `${ADMIN_COOKIE}=${token}`,
          [CSRF_HEADER]: session.csrf,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      }) as unknown as Request,
      env,
      db as Db,
      PATH,
      { now: NOW },
    );
  return { db, patch };
}

describe("the portal-settings route's listing fields (PS-02)", () => {
  it("accepts and returns the listing fields, and audits the change", async () => {
    const { db, patch } = await fixture();
    const res = await patch({
      storeListed: "listed",
      storeOfferPaths: ["open", "group"],
      storeGroupLabels: { staff: "Staff copy" },
    });
    expect(res.status).toBe(200);
    const { settings } = (await res.json()) as {
      settings: Record<string, unknown>;
    };
    expect(settings).toMatchObject({
      discoverEnabled: true,
      storeListed: "listed",
      storeAudience: "eligible",
      storeOfferPaths: ["group", "open"],
      storeGroupLabels: { staff: "Staff copy" },
    });
    const rows = await listAudit(db, SLUG, { limit: 10 });
    const listing = rows.find(
      (r) => r.action === "storefront.polarisKey.update",
    );
    expect(listing?.summary).toBe(
      "Changed the Polaris Key listing for djdl: listing auto → listed; ways to obtain all → group, open; group labels for 1 group(s)",
    );
    expect(listing?.actor_sub).toBe("u1");
  });

  it("writes no listing audit row when no listing value changed", async () => {
    const { db, patch } = await fixture();
    expect((await patch({ magicEnabled: false })).status).toBe(200);
    const rows = await listAudit(db, SLUG, { limit: 10 });
    expect(rows.map((r) => r.action)).toEqual(["portal.settings.update"]);
  });

  it("refuses invalid listing values and names each field", async () => {
    const { db, patch } = await fixture();
    const res = await patch({
      storeListed: "public",
      storeAudience: "anyone",
      storeOfferPaths: ["teleport"],
      storeGroupLabels: { g: "x".repeat(41) },
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { details?: { fields?: string[] } };
    expect(JSON.stringify(body)).toContain("storeListed");
    for (const f of [
      "storeListed",
      "storeAudience",
      "storeOfferPaths",
      "storeGroupLabels",
    ])
      expect(JSON.stringify(body)).toContain(f);
    expect((await storefrontListing(db, SLUG)).listed).toBe("auto");
  });

  it("asks for the typed key to widen the audience to everyone (L2), not to narrow it", async () => {
    const { db, patch } = await fixture();
    const refused = await patch({ storeAudience: "everyone" });
    expect(refused.status).toBe(400);
    expect(JSON.stringify(await refused.json())).toContain("confirm_required");
    expect((await storefrontListing(db, SLUG)).audience).toBe("eligible");

    const wrong = await patch({ storeAudience: "everyone", confirm: "yes" });
    expect(wrong.status).toBe(400);

    const ok = await patch({
      storeAudience: "everyone",
      confirm: "storefront.polarisKey.audience",
    });
    expect(ok.status).toBe(200);
    expect((await storefrontListing(db, SLUG)).audience).toBe("everyone");
    // Already everyone: no second confirmation; narrowing needs none.
    expect((await patch({ storeAudience: "everyone" })).status).toBe(200);
    expect((await patch({ storeAudience: "eligible" })).status).toBe(200);
    expect((await storefrontListing(db, SLUG)).audience).toBe("eligible");
  });
});
