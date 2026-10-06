/**
 * HA-07 (notes/S-20 §6.2, §8): the manifest's hosted art as `dist_listing_assets` rows with
 * `source = 'manifest'` (`services/distribution/listing/manifestAssets.ts`): which slot each copy
 * fills, the `listing-asset` refs they hold, precedence (an `admin` or `import` row is never
 * replaced), a changed or vanished copy, idempotence, and the queue consumer's immediate sync.
 */

import { createHash } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeTestDb } from "./helpers.js";
import { NOW, seedProduct } from "./seed.js";
import { seedHosted } from "./hostedFixture.js";
import { R2Mock, asR2, installDigestStream } from "./r2Mock.js";
import type { Env } from "../src/env.js";
import type { SqliteDb } from "../src/db/sqlite.js";
import { serializeServices } from "../src/core/services.js";
import { setServices } from "../src/repo.js";
import {
  screenshotClass,
  syncManifestListingAssets,
} from "../src/services/distribution/listing/manifestAssets.js";
import { stmtUpsertAsset } from "../src/services/distribution/listing/store.js";
import { syncHostedAssets } from "../src/core/hostedAssetPulls.js";
import type { AssetPullMessage } from "../src/core/hostedAssetPulls.js";
import { handleAssetQueue } from "../src/assetQueue.js";
import type { FetchImpl } from "../src/core/safeFetch.js";

beforeAll(() => installDigestStream());

const P = "djdl";
const ICON = "1".repeat(64);
const HEADER = "2".repeat(64);
const PHONE_1 = "3".repeat(64);
const PHONE_2 = "4".repeat(64);
const WIDE = "5".repeat(64);
const SQUARE = "6".repeat(64);

let db: SqliteDb;

async function distribution(on: boolean): Promise<void> {
  await setServices(
    db,
    P,
    serializeServices({
      services: {
        license: { enabled: true },
        config: { enabled: true },
        release: { enabled: false },
        distribution: { enabled: on },
        update: { enabled: false },
        identity: { enabled: false },
        sync: { enabled: false },
      },
    }),
    "manifest",
    NOW,
  );
}

beforeEach(async () => {
  db = makeTestDb();
  await seedProduct(db, P);
});

const rows = () =>
  db.all<Record<string, unknown>>(
    `SELECT slot, locale, blob, sha256, width, height, alpha, text_allowed, source, modified_by
       FROM dist_listing_assets WHERE product = ? ORDER BY slot`,
    P,
  );
const listingRefs = () =>
  db.all<{ storage_key: string; ref_id: string }>(
    `SELECT storage_key, ref_id FROM blob_refs
      WHERE product = ? AND ref_kind = 'listing-asset' ORDER BY ref_id`,
    P,
  );
const audits = () =>
  db.all<{ summary: string }>(
    "SELECT summary FROM audit WHERE product = ? AND action = 'distribution.listing.manifest'",
    P,
  );

async function seedArt(): Promise<void> {
  await seedHosted(db, P, "listing.icon", {
    sha256: ICON,
    width: 1024,
    height: 1024,
  });
  await seedHosted(db, P, "listing.header", {
    sha256: HEADER,
    width: 1920,
    height: 1080,
    contentType: "image/jpeg",
  });
  await seedHosted(db, P, "listing.screenshot:1", {
    sha256: PHONE_1,
    width: 1290,
    height: 2796,
  });
  await seedHosted(db, P, "listing.screenshot:2", {
    sha256: PHONE_2,
    width: 1290,
    height: 2796,
  });
  await seedHosted(db, P, "listing.screenshot:3", {
    sha256: WIDE,
    width: 2560,
    height: 1440,
  });
  await seedHosted(db, P, "listing.screenshot:4", {
    sha256: SQUARE,
    width: 800,
    height: 800,
  });
}

describe("screenshotClass", () => {
  it("reads the class from the dimensions, and never guesses tv, wear or xr", () => {
    expect(screenshotClass(1290, 2796)).toBe("phone-portrait");
    expect(screenshotClass(1080, 1920)).toBe("phone-portrait");
    expect(screenshotClass(2048, 2732)).toBe("tablet");
    expect(screenshotClass(2732, 2048)).toBe("tablet");
    expect(screenshotClass(1920, 1080)).toBe("desktop-16x9");
    expect(screenshotClass(2880, 1800)).toBe("desktop-16x10");
    expect(screenshotClass(800, 800)).toBeNull();
    expect(screenshotClass(3000, 1000)).toBeNull();
    expect(screenshotClass(null, 1080)).toBeNull();
  });
});

describe("syncManifestListingAssets", () => {
  it("fills icon-master, key-art and one master per screenshot class, each holding its ref", async () => {
    await seedArt();
    const out = await syncManifestListingAssets(db, P, NOW);
    expect(out).toEqual({
      written: [
        "icon-master",
        "key-art",
        "screenshot:phone-portrait",
        "screenshot:desktop-16x9",
      ],
      removed: [],
      kept: [],
    });
    const b = (h: string) => `blobs/sha256/${h}`;
    expect(await rows()).toEqual([
      {
        slot: "icon-master",
        locale: "",
        blob: b(ICON),
        sha256: ICON,
        width: 1024,
        height: 1024,
        alpha: 1,
        text_allowed: "free",
        source: "manifest",
        modified_by: "manifest",
      },
      {
        slot: "key-art",
        locale: "",
        blob: b(HEADER),
        sha256: HEADER,
        width: 1920,
        height: 1080,
        // A JPEG has no alpha channel; anything else may.
        alpha: 0,
        text_allowed: "none",
        source: "manifest",
        modified_by: "manifest",
      },
      expect.objectContaining({
        slot: "screenshot:desktop-16x9",
        sha256: WIDE,
        text_allowed: "free",
      }),
      // The first phone screenshot in the manifest's order is the class's master.
      expect.objectContaining({
        slot: "screenshot:phone-portrait",
        sha256: PHONE_1,
      }),
    ]);
    expect(await listingRefs()).toEqual([
      { storage_key: b(ICON), ref_id: "icon-master@" },
      { storage_key: b(HEADER), ref_id: "key-art@" },
      { storage_key: b(WIDE), ref_id: "screenshot:desktop-16x9@" },
      { storage_key: b(PHONE_1), ref_id: "screenshot:phone-portrait@" },
    ]);
    expect(await audits()).toHaveLength(1);

    // Idempotent: nothing to write, no second audit row.
    expect(await syncManifestListingAssets(db, P, NOW + 1)).toEqual({
      written: [],
      removed: [],
      kept: [],
    });
    expect(await audits()).toHaveLength(1);
  });

  it("never replaces an operator's upload or a CI row; never reads a console claim or a copy without its ref", async () => {
    await seedArt();
    for (const [slot, source] of [
      ["icon-master", "admin"],
      ["key-art", "import"],
    ] as const)
      await db.batch([
        stmtUpsertAsset(
          P,
          {
            slot,
            locale: null,
            blob: `blobs/sha256/${"9".repeat(64)}`,
            sha256: "9".repeat(64),
            width: 10,
            height: 10,
            alpha: false,
            derivedFrom: null,
            textAllowed: slot === "key-art" ? "none" : "free",
          },
          source,
          NOW,
          "someone",
        ),
      ]);
    await db.run(
      "UPDATE hosted_assets SET origin = 'console' WHERE product = ? AND slot = 'listing.screenshot:3'",
      P,
    );
    await db.run(
      "DELETE FROM blob_refs WHERE product = ? AND ref_id = 'listing.screenshot:1@'",
      P,
    );
    const out = await syncManifestListingAssets(db, P, NOW);
    expect(out.kept).toEqual(["icon-master", "key-art"]);
    // screenshot:1 has no ref (not served), so the second phone screenshot is the master.
    expect(out.written).toEqual(["screenshot:phone-portrait"]);
    const byslot = Object.fromEntries((await rows()).map((r) => [r.slot, r]));
    expect(byslot["icon-master"]).toMatchObject({ source: "admin" });
    expect(byslot["key-art"]).toMatchObject({ source: "import" });
    expect(byslot["screenshot:phone-portrait"]).toMatchObject({
      sha256: PHONE_2,
    });
    expect(byslot).not.toHaveProperty("screenshot:desktop-16x9");
  });

  it("a new copy replaces the row (so it is unaccepted again) and its ref; a vanished copy removes both", async () => {
    await seedArt();
    await syncManifestListingAssets(db, P, NOW);
    await db.run(
      `UPDATE dist_listing_assets SET accepted_sha256 = sha256, accepted_at = ?, accepted_by = 'u1'
        WHERE product = ? AND slot = 'icon-master'`,
      NOW,
      P,
    );
    const NEW = "7".repeat(64);
    await db.run(
      "DELETE FROM hosted_assets WHERE product = ? AND slot = 'listing.icon'",
      P,
    );
    await db.run(
      "DELETE FROM blob_refs WHERE product = ? AND ref_id = 'listing.icon@'",
      P,
    );
    await seedHosted(db, P, "listing.icon", {
      sha256: NEW,
      width: 512,
      height: 512,
    });
    // The header's slot is gone from the manifest (HA-05's planner drops the row and its refs).
    await db.run(
      "DELETE FROM hosted_assets WHERE product = ? AND slot = 'listing.header'",
      P,
    );
    await db.run(
      "DELETE FROM blob_refs WHERE product = ? AND ref_id = 'listing.header@'",
      P,
    );
    const out = await syncManifestListingAssets(db, P, NOW + 10);
    expect(out).toMatchObject({
      written: ["icon-master"],
      removed: ["key-art"],
    });
    const icon = await db.first<Record<string, unknown>>(
      "SELECT sha256, accepted_sha256 FROM dist_listing_assets WHERE product = ? AND slot = 'icon-master'",
      P,
    );
    expect(icon).toEqual({ sha256: NEW, accepted_sha256: ICON });
    const refs = await listingRefs();
    expect(refs).toContainEqual({
      storage_key: `blobs/sha256/${NEW}`,
      ref_id: "icon-master@",
    });
    expect(refs.map((r) => r.storage_key)).not.toContain(
      `blobs/sha256/${ICON}`,
    );
    expect(refs.map((r) => r.ref_id)).not.toContain("key-art@");
    expect((await rows()).map((r) => r.slot)).not.toContain("key-art");
  });
});

describe("the pull consumer syncs a listing slot's new copy at once", () => {
  const SRC = "https://cdn.example.com/listing-icon.png";
  const bytes = (() => {
    const out = new Uint8Array(4000);
    out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    return out;
  })();
  const hex = createHash("sha256").update(bytes).digest("hex");

  async function pull(): Promise<void> {
    const sent: AssetPullMessage[] = [];
    const env = {
      BLOBS: asR2(new R2Mock()),
      HOSTED_ASSET_QUEUE: {
        async sendBatch(msgs: Iterable<{ body: unknown }>) {
          for (const m of msgs) sent.push(m.body as AssetPullMessage);
        },
      } as unknown as Queue<unknown>,
    };
    await syncHostedAssets(env, db, {
      product: P,
      manifest: {
        distribution: {
          listing: { icon: { kind: "url", src: SRC } },
        } as never,
      },
      commit: null,
      now: NOW,
    });
    expect(sent.map((m) => m.slot)).toEqual(["listing.icon"]);
    const fetchImpl = (async () =>
      new Response(bytes, {
        headers: { "content-length": String(bytes.length) },
      })) as FetchImpl;
    await handleAssetQueue(
      {
        queue: "pkey-assets-test",
        messages: sent.map((body) => ({ body, ack() {}, retry() {} })),
      } as unknown as MessageBatch<unknown>,
      env as unknown as Env,
      db,
      fetchImpl,
      () => NOW + 1,
    );
  }

  it("with Distribution on: the copy is the icon-master row", async () => {
    await distribution(true);
    await pull();
    expect(await rows()).toEqual([
      expect.objectContaining({
        slot: "icon-master",
        sha256: hex,
        source: "manifest",
      }),
    ]);
  });

  it("with Distribution off: no row (its cron would not run either)", async () => {
    await distribution(false);
    await pull();
    expect(await rows()).toEqual([]);
  });
});
