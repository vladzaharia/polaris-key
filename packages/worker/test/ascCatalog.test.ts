/**
 * A-17e — App Store in-app purchases from the commerce mappings, through the real admin API,
 * against the fake server (`ascDistributeFake.ts`). Nothing here reaches Apple.
 *
 *   - Only an `app-store` row of the product's commerce map can be created, priced or made
 *     available, and the IAP is always the PINNED app's (found by `filter[productId]` under it).
 *   - Every write needs the Idempotency-Key, sends the documented request once, is answered from
 *     the ledger on a replay and from Apple's natural key on a new key, and writes one audit row.
 *   - The first price is a first-time set; a price change is TYPED (the app's name, compared with
 *     Apple's), and the write gate refuses it without that assertion.
 *   - IAP and Background Asset versions join Distribute's submission only once proven the pinned
 *     app's; the app's first IAP stays a portal step.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AscResource } from "../src/core/asc/client.js";
import { checkAscRequest } from "../src/core/asc/writeGate.js";
import { runConnectorPolls } from "../src/scheduled.js";
import { upsertStoreProduct } from "../src/services/distribution/commerce/state.js";
import { DistributeFake } from "./ascDistributeFake.js";
import {
  admin,
  ascWorld,
  audits,
  withFetch,
  APPLE_ID,
  NOW,
  type AscWorld,
} from "./ascWorld.js";
import { SLUG } from "./releaseRoutesFixture.js";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW * 1000 });
});
afterEach(() => {
  vi.useRealTimers();
});

const BASE = "/distribution/connectors/asc";
const OTHER_APP = "9999999999";
const FULL = "gg.acme.djdl.full";
const SOUNDTRACK = "gg.acme.djdl.soundtrack";
const LEGACY = "gg.acme.djdl.legacy";

interface World extends AscWorld {
  fake: DistributeFake;
}

async function map(w: World, storeProductId: string, store = "app-store") {
  await upsertStoreProduct(w.db, {
    product: SLUG,
    store: store as "app-store",
    store_product_id: storeProductId,
    deliverable_id: "app",
    flag: storeProductId.split(".").at(-1)!,
    modified_at: NOW,
    modified_by: "admin-1",
  });
}

async function world(
  opts: { pin?: string | null; mapped?: string[] } = {},
): Promise<World> {
  const fake = new DistributeFake();
  const w = (await ascWorld({ ...opts, fake })) as World;
  for (const id of opts.mapped ?? [FULL]) await map(w, id);
  await withFetch(w, () => runConnectorPolls(w.env, w.db, NOW));
  w.fake.requests.length = 0;
  return w;
}

let keyN = 0;
const newKey = () =>
  `00000000-0000-4000-9000-${String(++keyN).padStart(12, "0")}`;

async function post(
  w: World,
  path: string,
  body: Record<string, unknown>,
  key: string | null = newKey(),
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await admin(
    w,
    "POST",
    `${BASE}/${path}`,
    body,
    key === null ? {} : { "Idempotency-Key": key },
  );
  return {
    status: res.status,
    json: (await res.json()) as Record<string, unknown>,
  };
}

async function get(
  w: World,
  path: string,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await admin(w, "GET", `${BASE}/${path}`);
  return {
    status: res.status,
    json: (await res.json()) as Record<string, unknown>,
  };
}

const writes = (w: World) =>
  w.fake
    .writes()
    .map((r) => ({ method: r.method, path: r.path, body: r.body }));

async function ascAudits(w: World) {
  return (await audits(w.db)).filter((a) =>
    a.action.startsWith("distribution.asc."),
  );
}

const app = (id = APPLE_ID) => ({ data: { type: "apps", id } });

function iap(
  id: string,
  productId: string,
  state: string,
  opts: { type?: string; appId?: string } = {},
): AscResource {
  return {
    type: "inAppPurchases",
    id,
    attributes: {
      name: productId,
      productId,
      inAppPurchaseType: opts.type ?? "NON_CONSUMABLE",
      state,
      familySharable: false,
    },
    relationships: {
      app: app(opts.appId),
      iapPriceSchedule: { data: null },
      inAppPurchaseAvailability: { data: null },
    },
  };
}

function iapVersion(id: string, iapId: string, state: string): AscResource {
  return {
    type: "inAppPurchaseVersions",
    id,
    attributes: { state, version: 1 },
    relationships: {
      inAppPurchase: { data: { type: "inAppPurchases", id: iapId } },
    },
  };
}

const LOCS = [
  { locale: "en-US", name: "Full game", description: "Every level, forever" },
  { locale: "de-DE", name: "Vollversion" },
];

/** Create FULL through the API (IAP, version, two localizations). */
async function created(w: World): Promise<string> {
  const r = await post(w, "iap/create", {
    productId: FULL,
    referenceName: "Full game",
    localizations: LOCS,
  });
  expect(r.status).toBe(200);
  w.fake.requests.length = 0;
  return r.json.iapId as string;
}

describe("A-17e: the products read", () => {
  it("shows every App Store mapping beside Apple's state, read by filter[productId]", async () => {
    const w = await world({ mapped: [FULL, SOUNDTRACK, LEGACY] });
    await map(w, "gg.acme.djdl.play_full", "play");
    w.fake.put(iap("iap-legacy", LEGACY, "APPROVED"));
    w.fake.put(
      iap("iap-sound", SOUNDTRACK, "READY_TO_SUBMIT", { type: "CONSUMABLE" }),
    );
    // Another app's IAP with a mapped id is not this app's.
    w.fake.put(iap("iap-foreign", FULL, "APPROVED", { appId: OTHER_APP }));
    const r = await get(w, "iap/products");
    expect(r.status).toBe(200);
    const list = w.fake.requests.find(
      (q) =>
        q.path === `/v1/apps/${APPLE_ID}/inAppPurchasesV2` &&
        q.query["filter[productId]"],
    )!;
    expect(list.query["filter[productId]"]!.split(",").sort()).toEqual(
      [FULL, LEGACY, SOUNDTRACK].sort(),
    );
    expect(r.json.firstInAppPurchase).toBe(false);
    expect(r.json.priceChangeWarning).toMatch(/can't be reverted/);
    const rows = r.json.products as Record<string, unknown>[];
    expect(
      rows.map((p) => [p.storeProductId, p.status, p.typeMismatch]),
    ).toEqual([
      [FULL, "missing", false],
      [LEGACY, "APPROVED", false],
      [SOUNDTRACK, "READY_TO_SUBMIT", true],
    ]);
    expect(rows[1]).toMatchObject({ flag: "legacy", deliverableId: "app" });
    expect(writes(w)).toEqual([]);
  });

  it("says when the next IAP is the app's first (a portal submission)", async () => {
    const w = await world();
    const r = await get(w, "iap/products");
    expect(r.json.firstInAppPurchase).toBe(true);
    expect(r.json.firstInAppPurchaseNote).toMatch(/App Store Connect/);
  });

  it("refuses on an unpinned key, before any request to Apple", async () => {
    const w = await world({ pin: null });
    const r = await get(w, "iap/products");
    expect(r.status).toBe(409);
    expect(r.json.reason).toBe("credential_pin_missing");
    expect(w.fake.requests).toEqual([]);
  });
});

describe("A-17e: create a non-consumable IAP", () => {
  it("needs an Idempotency-Key and a mapped product id, sending nothing otherwise", async () => {
    const w = await world();
    const noKey = await post(
      w,
      "iap/create",
      { productId: FULL, referenceName: "Full", localizations: LOCS },
      null,
    );
    expect(noKey.status).toBe(422);
    expect(noKey.json.reason).toBe("idempotency_key_required");
    const unmapped = await post(w, "iap/create", {
      productId: "gg.acme.djdl.unmapped",
      referenceName: "Nope",
      localizations: LOCS,
    });
    expect(unmapped.status).toBe(404);
    expect(unmapped.json.reason).toBe("unmapped_product");
    const bad = await post(w, "iap/create", {
      productId: FULL,
      referenceName: "Full",
      localizations: [{ locale: "en-US", name: "x".repeat(36) }],
    });
    expect(bad.status).toBe(422);
    expect(w.fake.requests).toEqual([]);
  });

  it("creates the IAP for the pinned app, its version and one localization per locale", async () => {
    const w = await world();
    const key = newKey();
    const r = await post(
      w,
      "iap/create",
      {
        productId: FULL,
        referenceName: "Full game",
        reviewNote: "Unlocks every level",
        familySharable: true,
        localizations: LOCS,
      },
      key,
    );
    expect(r.status).toBe(200);
    const iapId = r.json.iapId as string;
    const versionId = r.json.versionId as string;
    expect(r.json).toMatchObject({
      productId: FULL,
      state: "MISSING_METADATA",
      steps: {
        create: { outcome: "written" },
        version: { outcome: "written" },
        localizations: [
          { locale: "en-US", outcome: "written" },
          { locale: "de-DE", outcome: "written" },
        ],
      },
    });
    expect(writes(w)).toEqual([
      {
        method: "POST",
        path: "/v2/inAppPurchases",
        body: {
          data: {
            type: "inAppPurchases",
            attributes: {
              name: "Full game",
              productId: FULL,
              inAppPurchaseType: "NON_CONSUMABLE",
              reviewNote: "Unlocks every level",
              familySharable: true,
            },
            relationships: { app: app() },
          },
        },
      },
      {
        method: "POST",
        path: "/v1/inAppPurchaseVersions",
        body: {
          data: {
            type: "inAppPurchaseVersions",
            relationships: {
              inAppPurchase: { data: { type: "inAppPurchases", id: iapId } },
            },
          },
        },
      },
      {
        method: "POST",
        path: "/v2/inAppPurchaseLocalizations",
        body: {
          data: {
            type: "inAppPurchaseLocalizations",
            attributes: {
              locale: "en-US",
              name: "Full game",
              description: "Every level, forever",
            },
            relationships: {
              version: {
                data: { type: "inAppPurchaseVersions", id: versionId },
              },
            },
          },
        },
      },
      {
        method: "POST",
        path: "/v2/inAppPurchaseLocalizations",
        body: {
          data: {
            type: "inAppPurchaseLocalizations",
            attributes: { locale: "de-DE", name: "Vollversion" },
            relationships: {
              version: {
                data: { type: "inAppPurchaseVersions", id: versionId },
              },
            },
          },
        },
      },
    ]);
    expect((await ascAudits(w)).map((a) => a.action)).toEqual([
      "distribution.asc.iap.create",
      "distribution.asc.iap.version",
      "distribution.asc.iap.localization",
      "distribution.asc.iap.localization",
    ]);
    expect((await ascAudits(w))[0]!.summary).toContain(FULL);

    // The same key replays from the ledger; a new key finds everything at Apple. No write.
    w.fake.requests.length = 0;
    const replay = await post(
      w,
      "iap/create",
      {
        productId: FULL,
        referenceName: "Full game",
        reviewNote: "Unlocks every level",
        familySharable: true,
        localizations: LOCS,
      },
      key,
    );
    expect(replay.status).toBe(200);
    expect(replay.json.steps).toMatchObject({
      create: { outcome: "replayed" },
      version: { outcome: "replayed" },
    });
    const again = await post(w, "iap/create", {
      productId: FULL,
      referenceName: "Full game",
      localizations: LOCS,
    });
    expect(again.status).toBe(200);
    expect(again.json.steps).toMatchObject({
      create: { outcome: "existing" },
      version: { outcome: "existing" },
      localizations: [{ outcome: "existing" }, { outcome: "existing" }],
    });
    expect(writes(w)).toEqual([]);
    expect(await ascAudits(w)).toHaveLength(4);
  });

  it("refuses a mapped id that exists as another type, sending nothing", async () => {
    const w = await world();
    w.fake.put(iap("iap-c", FULL, "READY_TO_SUBMIT", { type: "CONSUMABLE" }));
    const r = await post(w, "iap/create", {
      productId: FULL,
      referenceName: "Full",
      localizations: LOCS,
    });
    expect(r.status).toBe(409);
    expect(r.json.reason).toBe("iap_type_mismatch");
    expect(writes(w)).toEqual([]);
  });

  it("edits one locale of an existing IAP in place", async () => {
    const w = await world();
    await created(w);
    const r = await post(w, "iap/localization", {
      productId: FULL,
      locale: "de-DE",
      name: "Vollversion",
      description: "Alle Level",
    });
    expect(r.status).toBe(200);
    const loc = w.fake
      .all("inAppPurchaseLocalizations")
      .find((l) => l.attributes?.locale === "de-DE")!;
    expect(writes(w)).toEqual([
      {
        method: "PATCH",
        path: `/v2/inAppPurchaseLocalizations/${loc.id}`,
        body: {
          data: {
            type: "inAppPurchaseLocalizations",
            id: loc.id,
            attributes: { name: "Vollversion", description: "Alle Level" },
          },
        },
      },
    ]);
  });
});

describe("A-17e: price (first set plain, change typed) and availability", () => {
  it("lists the IAP's price points for a territory, cheapest first", async () => {
    const w = await world();
    const iapId = await created(w);
    const r = await get(w, `iap/price-points?productId=${FULL}&territory=GBR`);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({
      iapId,
      territory: "GBR",
      priceChange: false,
    });
    expect(
      (r.json.pricePoints as { customerPrice: string }[]).map(
        (p) => p.customerPrice,
      ),
    ).toEqual(["0.99", "1.99", "4.99"]);
    expect(
      w.fake.requests.find((q) => q.path.endsWith("/pricePoints"))!.query[
        "filter[territory]"
      ],
    ).toBe("GBR");
    const missing = await get(
      w,
      `iap/price-points?productId=${SOUNDTRACK}&territory=USA`,
    );
    expect(missing.status).toBe(404);
  });

  it("sets the first price without confirmation; a change needs the app's name", async () => {
    const w = await world();
    const iapId = await created(w);
    const first = await post(w, "iap/price", {
      productId: FULL,
      baseTerritory: "USA",
      customerPrice: "0.99",
    });
    expect(first.status).toBe(200);
    expect(first.json).toMatchObject({
      outcome: "written",
      change: false,
      customerPrice: "0.99",
      pricePointId: `pp-${iapId}-USA-0`,
    });
    expect(writes(w)).toEqual([
      {
        method: "POST",
        path: "/v1/inAppPurchasePriceSchedules",
        body: {
          data: {
            type: "inAppPurchasePriceSchedules",
            relationships: {
              inAppPurchase: { data: { type: "inAppPurchases", id: iapId } },
              baseTerritory: { data: { type: "territories", id: "USA" } },
              manualPrices: {
                data: [{ type: "inAppPurchasePrices", id: "${price-0}" }],
              },
            },
          },
          included: [
            {
              type: "inAppPurchasePrices",
              id: "${price-0}",
              attributes: { startDate: null },
              relationships: {
                inAppPurchaseV2: {
                  data: { type: "inAppPurchases", id: iapId },
                },
                inAppPurchasePricePoint: {
                  data: {
                    type: "inAppPurchasePricePoints",
                    id: `pp-${iapId}-USA-0`,
                  },
                },
              },
            },
          ],
        },
      },
    ]);
    const priceAudit = (await ascAudits(w)).at(-1)!;
    expect(priceAudit.action).toBe("distribution.asc.iap.price");
    expect(priceAudit.summary).toMatch(/first price .*0\.99 \(USA\)/);

    // The same price again: nothing to confirm and nothing sent.
    w.fake.requests.length = 0;
    const same = await post(w, "iap/price", {
      productId: FULL,
      baseTerritory: "USA",
      pricePointId: `pp-${iapId}-USA-0`,
    });
    expect(same.status).toBe(200);
    expect(same.json.outcome).toBe("existing");

    // A change: no confirm, a wrong one, then the app's name.
    const none = await post(w, "iap/price", {
      productId: FULL,
      baseTerritory: "USA",
      customerPrice: "1.99",
    });
    expect(none.status).toBe(422);
    expect(none.json.reason).toBe("confirmation_required");
    expect(String(none.json.message)).toMatch(/can't be reverted/);
    const wrong = await post(w, "iap/price", {
      productId: FULL,
      baseTerritory: "USA",
      customerPrice: "1.99",
      confirm: "DJDL",
    });
    expect(wrong.status).toBe(422);
    expect(wrong.json.reason).toBe("confirmation_mismatch");
    expect(writes(w)).toEqual([]);
    const ok = await post(w, "iap/price", {
      productId: FULL,
      baseTerritory: "USA",
      customerPrice: "1.99",
      confirm: "djdl",
    });
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({
      outcome: "written",
      change: true,
      customerPrice: "1.99",
    });
    expect(ok.json.priceChangeWarning).toMatch(/can't be reverted/);
    expect(writes(w)).toHaveLength(1);
    expect((await ascAudits(w)).at(-1)!.summary).toMatch(
      /Changed the price .* from 0\.99 \(USA\) to 1\.99 \(USA\), typed/,
    );
    const priceRows = await w.db.all<{
      before_json: string;
      after_json: string;
    }>(
      "SELECT before_json, after_json FROM asc_operations WHERE op = 'iap.price' AND state = 'done' ORDER BY created_at, rowid",
    );
    expect(JSON.parse(priceRows.at(-1)!.before_json).attributes).toMatchObject({
      customerPrice: "0.99",
    });
    expect(JSON.parse(priceRows.at(-1)!.after_json).attributes).toMatchObject({
      customerPrice: "1.99",
      baseTerritory: "USA",
    });
  });

  it("refuses a price point Apple does not offer for this IAP", async () => {
    const w = await world();
    const iapId = await created(w);
    const r = await post(w, "iap/price", {
      productId: FULL,
      baseTerritory: "USA",
      pricePointId: `pp-${iapId}-GBR-0`,
    });
    expect(r.status).toBe(422);
    expect(r.json.reason).toBe("unknown_price_point");
    expect(writes(w)).toEqual([]);
  });

  it("the write gate refuses a price schedule with neither the initial nor the typed assertion", () => {
    const body = {
      data: {
        type: "inAppPurchasePriceSchedules",
        relationships: {
          inAppPurchase: { data: { type: "inAppPurchases", id: "iap-1" } },
          baseTerritory: { data: { type: "territories", id: "USA" } },
          manualPrices: {
            data: [{ type: "inAppPurchasePrices", id: "${price-0}" }],
          },
        },
      },
      included: [{ type: "inAppPurchasePrices", id: "${price-0}" }],
    };
    expect(() =>
      checkAscRequest("POST", "/v1/inAppPurchasePriceSchedules", body),
    ).toThrow(/typed_confirmation_required/);
    expect(
      checkAscRequest("POST", "/v1/inAppPurchasePriceSchedules", body, {
        initial: true,
      })?.path,
    ).toBe("/v1/inAppPurchasePriceSchedules");
  });

  it("makes the IAP available in every territory once, and then it is READY_TO_SUBMIT", async () => {
    const w = await world();
    const iapId = await created(w);
    await post(w, "iap/price", {
      productId: FULL,
      baseTerritory: "USA",
      customerPrice: "4.99",
    });
    w.fake.requests.length = 0;
    const r = await post(w, "iap/availability", { productId: FULL });
    expect(r.status).toBe(200);
    expect(writes(w)).toEqual([
      {
        method: "POST",
        path: "/v1/inAppPurchaseAvailabilities",
        body: {
          data: {
            type: "inAppPurchaseAvailabilities",
            attributes: { availableInNewTerritories: true },
            relationships: {
              inAppPurchase: { data: { type: "inAppPurchases", id: iapId } },
              availableTerritories: {
                data: expect.arrayContaining([
                  { type: "territories", id: "USA" },
                  { type: "territories", id: "GBR" },
                  { type: "territories", id: "CAN" },
                ]),
              },
            },
          },
        },
      },
    ]);
    expect(w.fake.get("inAppPurchases", iapId).attributes?.state).toBe(
      "READY_TO_SUBMIT",
    );
    w.fake.requests.length = 0;
    const again = await post(w, "iap/availability", { productId: FULL });
    expect(again.json.outcome).toBe("existing");
    expect(writes(w)).toEqual([]);
  });
});

describe("A-17e: IAP and Background Asset versions ride Distribute's submission", () => {
  /** A held version, an approved older IAP (so FULL is not the first), FULL ready, a BA ready. */
  function seed(w: World): void {
    w.fake.put({
      type: "appStoreVersions",
      id: "asv-120",
      attributes: {
        platform: "IOS",
        versionString: "1.2.0",
        appStoreState: "PREPARE_FOR_SUBMISSION",
        appVersionState: "PREPARE_FOR_SUBMISSION",
        createdDate: "2026-10-01T10:00:00.000Z",
      },
      relationships: {
        app: app(),
        build: { data: { type: "builds", id: "bld-110-42" } },
        appStoreVersionPhasedRelease: { data: null },
      },
    });
    w.fake.put(iap("iap-legacy", LEGACY, "APPROVED"));
    w.fake.put(iap("iap-full", FULL, "READY_TO_SUBMIT"));
    w.fake.put(iapVersion("iapv-full", "iap-full", "PREPARE_FOR_SUBMISSION"));
    w.fake.put({
      type: "backgroundAssets",
      id: "ba-1",
      attributes: { assetPackIdentifier: "levels-2", archived: false },
      relationships: { app: app() },
    });
    w.fake.put({
      type: "backgroundAssetVersionAppStoreReleases",
      id: "bar-1",
      attributes: { state: "READY_FOR_REVIEW" },
    });
    w.fake.put({
      type: "backgroundAssetVersions",
      id: "bav-1",
      attributes: { state: "COMPLETE", version: "3", platforms: ["IOS"] },
      relationships: {
        backgroundAsset: { data: { type: "backgroundAssets", id: "ba-1" } },
        appStoreRelease: {
          data: { type: "backgroundAssetVersionAppStoreReleases", id: "bar-1" },
        },
      },
    });
  }

  it("lists the versions a submission can carry", async () => {
    const w = await world();
    seed(w);
    const r = await get(w, "distribute/submission-items?platform=IOS");
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({
      firstInAppPurchase: false,
      inAppPurchaseVersions: [
        {
          inAppPurchaseVersionId: "iapv-full",
          productId: FULL,
          iapId: "iap-full",
          versionState: "PREPARE_FOR_SUBMISSION",
        },
      ],
      backgroundAssetVersions: [
        {
          backgroundAssetVersionId: "bav-1",
          assetPackIdentifier: "levels-2",
          appStoreReleaseState: "READY_FOR_REVIEW",
        },
      ],
    });
    expect(writes(w)).toEqual([]);
  });

  it("adds them to the submission after the version, then submits (typed)", async () => {
    const w = await world();
    seed(w);
    const r = await post(w, "distribute/submit", {
      versionId: "asv-120",
      confirm: "djdl",
      inAppPurchaseVersionIds: ["iapv-full"],
      backgroundAssetVersionIds: ["bav-1"],
    });
    expect(r.status).toBe(200);
    const sid = r.json.submissionId as string;
    expect(r.json.steps).toMatchObject({
      items: [
        { inAppPurchaseVersionId: "iapv-full", outcome: "written" },
        { backgroundAssetVersionId: "bav-1", outcome: "written" },
      ],
      submit: { outcome: "written" },
    });
    const items = writes(w).filter(
      (q) => q.path === "/v1/reviewSubmissionItems",
    );
    expect(items.map((q) => q.body)).toEqual([
      {
        data: {
          type: "reviewSubmissionItems",
          relationships: {
            reviewSubmission: { data: { type: "reviewSubmissions", id: sid } },
            appStoreVersion: {
              data: { type: "appStoreVersions", id: "asv-120" },
            },
          },
        },
      },
      {
        data: {
          type: "reviewSubmissionItems",
          relationships: {
            reviewSubmission: { data: { type: "reviewSubmissions", id: sid } },
            inAppPurchaseVersion: {
              data: { type: "inAppPurchaseVersions", id: "iapv-full" },
            },
          },
        },
      },
      {
        data: {
          type: "reviewSubmissionItems",
          relationships: {
            reviewSubmission: { data: { type: "reviewSubmissions", id: sid } },
            backgroundAssetVersion: {
              data: { type: "backgroundAssetVersions", id: "bav-1" },
            },
          },
        },
      },
    ]);
    expect(writes(w).at(-1)).toMatchObject({
      method: "PATCH",
      path: `/v1/reviewSubmissions/${sid}`,
    });
    expect(w.fake.get("inAppPurchases", "iap-full").attributes?.state).toBe(
      "WAITING_FOR_REVIEW",
    );
  });

  it("keeps the app's first IAP a portal step, sending nothing", async () => {
    const w = await world();
    seed(w);
    w.fake.set("inAppPurchases", "iap-legacy", { state: "MISSING_METADATA" });
    const items = await get(w, "distribute/submission-items");
    expect(items.json).toMatchObject({
      firstInAppPurchase: true,
      inAppPurchaseVersions: [],
    });
    const r = await post(w, "distribute/submit", {
      versionId: "asv-120",
      confirm: "djdl",
      inAppPurchaseVersionIds: ["iapv-full"],
    });
    expect(r.status).toBe(409);
    expect(r.json.reason).toBe("first_iap_portal");
    expect(writes(w)).toEqual([]);
    const pre = await get(w, "distribute/preflight?versionId=asv-120");
    expect(
      (pre.json.checks as { id: string; ok: unknown }[]).find(
        (c) => c.id === "firstInAppPurchase",
      ),
    ).toMatchObject({ ok: null });
  });

  it("refuses another app's IAP version or Background Asset version before touching the submission", async () => {
    const w = await world();
    seed(w);
    // Another app's IAP under the mapped id, with a version.
    w.fake.put(
      iap("iap-other", SOUNDTRACK, "READY_TO_SUBMIT", { appId: OTHER_APP }),
    );
    await map(w, SOUNDTRACK);
    w.fake.put(iapVersion("iapv-other", "iap-other", "PREPARE_FOR_SUBMISSION"));
    const iapRefused = await post(w, "distribute/submit", {
      versionId: "asv-120",
      confirm: "djdl",
      inAppPurchaseVersionIds: ["iapv-full", "iapv-other"],
    });
    expect(iapRefused.status).toBe(404);
    expect(iapRefused.json.reason).toBe("unknown_iap_version");

    w.fake.put({
      type: "backgroundAssets",
      id: "ba-other",
      attributes: { assetPackIdentifier: "x", archived: false },
      relationships: { app: app(OTHER_APP) },
    });
    w.fake.put({
      ...w.fake.get("backgroundAssetVersions", "bav-1"),
      id: "bav-other",
      relationships: {
        ...w.fake.get("backgroundAssetVersions", "bav-1").relationships,
        backgroundAsset: { data: { type: "backgroundAssets", id: "ba-other" } },
      },
    });
    const baRefused = await post(w, "distribute/submit", {
      versionId: "asv-120",
      confirm: "djdl",
      backgroundAssetVersionIds: ["bav-other"],
    });
    expect(baRefused.status).toBe(404);
    expect(baRefused.json.reason).toBe("unknown_background_asset_version");
    expect(writes(w)).toEqual([]);
    expect(await ascAudits(w)).toEqual([]);
  });

  it("refuses an IAP version that is not ready", async () => {
    const w = await world();
    seed(w);
    w.fake.set("inAppPurchases", "iap-full", { state: "MISSING_METADATA" });
    const r = await post(w, "distribute/submit", {
      versionId: "asv-120",
      confirm: "djdl",
      inAppPurchaseVersionIds: ["iapv-full"],
    });
    expect(r.status).toBe(409);
    expect(r.json.reason).toBe("iap_not_ready");
    expect(writes(w)).toEqual([]);
  });
});

describe("A-17e: the connector advertises the IAP surface", () => {
  it("lists the IAP controls and reads in the connector status", async () => {
    const w = await world();
    const res = await admin(w, "GET", "/distribution/connectors/asc");
    const json = (await res.json()) as { controls: string[]; reads: string[] };
    expect(json.controls).toEqual(
      expect.arrayContaining([
        "iap/create",
        "iap/localization",
        "iap/price",
        "iap/availability",
        "distribute/submit",
      ]),
    );
    expect(json.reads).toEqual(
      expect.arrayContaining([
        "iap/products",
        "iap/price-points",
        "distribute/submission-items",
      ]),
    );
    expect((await admin(w, "GET", `${BASE}/iap/create`)).status).toBe(405);
  });
});
