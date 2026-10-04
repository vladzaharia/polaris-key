/**
 * App Store in-app purchases from the commerce mappings (A-17e; notes/S-14 §8.3, §7, §10).
 *
 * P6-01's commerce bridge maps a store product id to the licence flag a purchase grants
 * (`dist_store_products`, operator rows: rule 5). This module creates the App Store side of the
 * `app-store` rows, as **non-consumable** in-app purchases of the product's pinned app, through
 * named handlers under `…/distribution/connectors/asc/` (the App Store Connect connector's
 * control table; there is no generic proxy):
 *
 *   GET  iap/products                    one row per `app-store` mapping, beside Apple's state read
 *                                        by `filter[productId]`: `missing`, `MISSING_METADATA`,
 *                                        `READY_TO_SUBMIT`, `WAITING_FOR_REVIEW`, `APPROVED`, …
 *   GET  iap/price-points?productId=&territory=
 *                                        the price-point picker, filtered to one territory
 *   GET  distribute/submission-items?platform=
 *                                        the IAP versions and Background Asset versions Distribute's
 *                                        submission can carry (`distribute/submit` takes their ids)
 *
 *   POST iap/create        { productId, referenceName, reviewNote?, familySharable?,
 *                            localizations: [{ locale, name, description? }] }
 *                          the IAP (`POST /v2/inAppPurchases`), its version, one localization per
 *                          locale (`/v2/inAppPurchaseLocalizations`)
 *   POST iap/localization  { productId, locale, name, description? }   add or edit one locale
 *   POST iap/price         { productId, baseTerritory, pricePointId | customerPrice, confirm? }
 *                          the first price, or a price change: TYPED (`confirm` = the app's name)
 *   POST iap/availability  { productId }   every territory, and new ones (only while none is set)
 *
 * The write discipline is S-14 §7's, through A-17a's substrate and A-17d's flow plumbing:
 *
 *   - **Mapped and pinned only.** A `productId` must be an `app-store` row of this product's
 *     commerce map (404 `unmapped_product` otherwise): what Polaris Key creates at Apple is what the
 *     operator mapped, never request input alone. The IAP is then found under the PINNED app
 *     (`GET /v1/apps/{pinned}/inAppPurchasesV2?filter[productId]=`), so an IAP id is never taken
 *     from a request and another app's IAP is unreachable. An IAP version or Background Asset
 *     version offered to a submission is re-read and walked back to the pinned app (version → IAP
 *     → mapped product id → the pinned app's IAP; version → asset → `include=app`).
 *   - **Non-consumable only** (the gate refuses any other `inAppPurchaseType`); an existing IAP of
 *     another type under a mapped id is refused (409 `iap_type_mismatch`), never changed.
 *   - **Idempotent.** Every write needs the console's `Idempotency-Key` and runs as a ledger step:
 *     the natural key is read first (the product id; the IAP's editable version; the locale within
 *     the version; the IAP's current price schedule; its availability) and nothing is sent when
 *     Apple already has it.
 *   - **Typed confirmation for price changes** (owner decision, 2026-10-04): the first price is a
 *     first-time set (`initial`, asserted only when the pre-read found no price); any later
 *     schedule is a change, which needs `confirm` = the app's name as App Store Connect reports it
 *     now (`checkTypedConfirmation`), and only then is `typedConfirmation` asserted to the write
 *     gate, which refuses the schedule otherwise. Apple warns that a price increase cannot be
 *     reverted once it takes effect; every refusal and the products read carry that warning.
 *   - **The first IAP is portal-only.** Apple requires an app's first in-app purchase to be
 *     submitted with an app version in App Store Connect; until one of the app's IAPs has been
 *     approved, IAP versions are not offered to a submission (409 `first_iap_portal`) and the
 *     products read says so.
 *
 * Out of this file: the review screenshot (a deep link in v1, A-17g), subscriptions and
 * consumables (not granted by P6-01), uploading Background Asset files (P5-08), and the console
 * UI (A-17g).
 */

import {
  ascPath,
  ascPathV,
  attr,
  findIncluded,
  relId,
  single,
  type AscResource,
} from "../../../core/asc/client.js";
import { checkTypedConfirmation } from "../connectors/asc/controls.js";
import type {
  ConnectorControl,
  ConnectorRead,
} from "../connectors/asc/controls.js";
import {
  ID,
  LOCALE,
  distributeControl,
  distributeRead,
  step,
  stepView,
  stop,
  type Flow,
  type StepResult,
} from "../connectors/asc/flow.js";
import {
  getStoreProduct,
  isStoreProductId,
  listStoreProducts,
} from "./state.js";

type Pinned = Pick<Flow, "c" | "run" | "setup">;

// ── Vocabulary ───────────────────────────────────────────────────────────────────────────────

/** The only IAP type A-17 creates (the write gate refuses any other). */
export const IAP_TYPE = "NON_CONSUMABLE";

/** Apple's limits: reference name 64, display name 35, description 55, review note 4,000. */
const REFERENCE_NAME_MAX = 64;
const DISPLAY_NAME_MAX = 35;
const DESCRIPTION_MAX = 55;
const REVIEW_NOTE_MAX = 4000;
const MAX_LOCALIZATIONS = 10;
/** Product ids per `filter[productId]` request. */
const PRODUCT_ID_CHUNK = 50;
/** Items of each kind one submission may add. */
const MAX_ITEMS = 20;

/** Apple's warning on an IAP price change (S-14 §4, [V]). */
export const PRICE_CHANGE_WARNING =
  "Once a price increase goes into effect, the change can't be reverted (App Store Connect).";

/** Apple's rule for the first in-app purchase of an app (S-14 §4, [V]). */
export const FIRST_IAP_NOTE =
  "Submit your first In-App Purchase with your next app version in App Store Connect.";

/** IAP states that mean one of the app's IAPs has passed review (so it is not the first). */
const EVER_APPROVED = [
  "APPROVED",
  "DEVELOPER_REMOVED_FROM_SALE",
  "REMOVED_FROM_SALE",
];

/** IAP version states in which its localizations can change and it can join a submission. */
const EDITABLE_IAP_VERSION_STATES = new Set([
  "PREPARE_FOR_SUBMISSION",
  "READY_FOR_REVIEW",
  "REJECTED",
  "DEVELOPER_REJECTED",
]);

/** IAP states in which its version can be submitted (complete metadata, not with Apple). */
const SUBMITTABLE_IAP_STATES = new Set([
  "READY_TO_SUBMIT",
  "DEVELOPER_ACTION_NEEDED",
  "REJECTED",
]);

/** A Background Asset version's App Store release states that can still join a submission. */
const SUBMITTABLE_BA_RELEASE_STATES = new Set([
  "PREPARE_FOR_SUBMISSION",
  "READY_FOR_REVIEW",
  "REJECTED",
]);

const PLATFORMS = ["IOS", "MAC_OS", "TV_OS", "VISION_OS"] as const;
const TERRITORY = /^[A-Z]{3}$/;
/** A price point id as Apple issues it (opaque, URL-safe). */
const PRICE_POINT_ID = /^[A-Za-z0-9_-]{1,256}$/;
/** A customer price as Apple spells it (`0.99`, `1000`). */
const CUSTOMER_PRICE = /^\d{1,7}(\.\d{1,2})?$/;

// ── Validation ───────────────────────────────────────────────────────────────────────────────

function text(
  body: Record<string, unknown>,
  name: string,
  max: number,
  required: boolean,
): string | undefined {
  const v = body[name];
  if (v === undefined && !required) return undefined;
  if (typeof v !== "string" || v.trim() === "" || v.length > max)
    stop(
      422,
      "invalid_body",
      `${name} must be text of 1 to ${max} characters`,
      [name],
    );
  return v;
}

interface Localization {
  locale: string;
  name: string;
  description?: string;
}

function localization(o: unknown, field: string): Localization {
  if (!o || typeof o !== "object" || Array.isArray(o))
    stop(422, "invalid_body", `${field} must be an object`, [field]);
  const b = o as Record<string, unknown>;
  if (typeof b.locale !== "string" || !LOCALE.test(b.locale))
    stop(422, "invalid_body", "locale must be a locale code such as en-US", [
      `${field}.locale`,
    ]);
  const name = text(b, "name", DISPLAY_NAME_MAX, true)!;
  const description = text(b, "description", DESCRIPTION_MAX, false);
  return {
    locale: b.locale,
    name,
    ...(description !== undefined ? { description } : {}),
  };
}

/**
 * The body's `productId`, which must be an `app-store` row of this product's commerce map: the
 * operator's mapping (rule 5), not request input, decides what exists at Apple.
 */
async function mappedProductId(
  f: Pinned,
  raw: unknown,
): Promise<{ productId: string; flag: string; deliverableId: string }> {
  if (!isStoreProductId("app-store", raw))
    stop(422, "invalid_body", "productId must be an App Store product id", [
      "productId",
    ]);
  const row = await getStoreProduct(f.c.db, f.c.product, "app-store", raw);
  if (!row)
    stop(
      404,
      "unmapped_product",
      `${raw} is not an App Store product in this product's commerce map`,
    );
  return {
    productId: raw,
    flag: row.flag,
    deliverableId: row.deliverable_id,
  };
}

// ── Apple reads ──────────────────────────────────────────────────────────────────────────────

/** The pinned app's IAP with this product id, or null (Apple's filter, matched exactly). */
async function findIap(
  f: Pinned,
  productId: string,
): Promise<AscResource | null> {
  const doc = await f.run.client.get(
    ascPath("apps", f.setup.appleId, "inAppPurchasesV2"),
    { "filter[productId]": productId, limit: "5" },
  );
  const data = Array.isArray(doc?.data) ? doc.data : [];
  return data.find((i) => attr(i, "productId") === productId) ?? null;
}

/** The pinned app's non-consumable IAP for a mapped product id, or a refusal. */
async function requireIap(f: Pinned, productId: string): Promise<AscResource> {
  const iap = await findIap(f, productId);
  if (!iap)
    stop(
      404,
      "iap_missing",
      `no In-App Purchase ${productId} on this app yet: create it first`,
    );
  if (attr(iap, "inAppPurchaseType") !== IAP_TYPE)
    stop(
      409,
      "iap_type_mismatch",
      `${productId} exists in App Store Connect as ${attr(iap, "inAppPurchaseType") ?? "another type"}, not ${IAP_TYPE}`,
    );
  return iap;
}

/** Whether any IAP of the pinned app has passed review (so the next one is not the first). */
async function hasApprovedIap(f: Pinned): Promise<boolean> {
  const doc = await f.run.client.get(
    ascPath("apps", f.setup.appleId, "inAppPurchasesV2"),
    { "filter[state]": EVER_APPROVED.join(","), limit: "1" },
  );
  return Array.isArray(doc?.data) && doc.data.length > 0;
}

/** The IAP's newest version still editable, or null. */
async function editableVersion(
  f: Pinned,
  iapId: string,
): Promise<AscResource | null> {
  const doc = await f.run.client.get(
    ascPathV("v2", "inAppPurchases", iapId, "versions"),
    { "filter[state]": [...EDITABLE_IAP_VERSION_STATES].join(","), limit: "5" },
  );
  const data = Array.isArray(doc?.data) ? doc.data : [];
  return (
    data
      .filter((v) => EDITABLE_IAP_VERSION_STATES.has(attr(v, "state") ?? ""))
      .sort(
        (a, b) =>
          (Number(b.attributes?.version) || 0) -
          (Number(a.attributes?.version) || 0),
      )[0] ?? null
  );
}

interface PriceSchedule {
  scheduleId: string;
  baseTerritory: string | null;
  /** The base territory's price in effect today (manual), or null. */
  pricePointId: string | null;
  customerPrice: string | null;
  /** Manual prices of every territory (a schedule exists only when there is at least one). */
  manualPrices: number;
}

/** Today as Apple's `startDate` spells it. */
const day = (now: number) => new Date(now * 1000).toISOString().slice(0, 10);

/** The IAP's current price schedule, or null when it has no manual price. */
async function readPriceSchedule(
  f: Pinned,
  iapId: string,
): Promise<PriceSchedule | null> {
  const sched = single(
    await f.run.client.getOrNull(
      ascPathV("v2", "inAppPurchases", iapId, "iapPriceSchedule"),
      { include: "baseTerritory" },
    ),
  );
  if (!sched) return null;
  const prices = await f.run.client.getOrNull(
    ascPath("inAppPurchasePriceSchedules", sched.id, "manualPrices"),
    { include: "inAppPurchasePricePoint,territory", limit: "50" },
  );
  const list = Array.isArray(prices?.data) ? prices.data : [];
  if (list.length === 0) return null;
  const base = relId(sched, "baseTerritory");
  const today = day(f.c.now);
  const current = list.find((p) => {
    const start = attr(p, "startDate");
    const end = attr(p, "endDate");
    return (
      relId(p, "territory") === base &&
      (start === null || start <= today) &&
      (end === null || end > today)
    );
  });
  const pointId = relId(current, "inAppPurchasePricePoint");
  const point = findIncluded(
    prices?.included,
    "inAppPurchasePricePoints",
    pointId,
  );
  return {
    scheduleId: sched.id,
    baseTerritory: base,
    pricePointId: pointId,
    customerPrice: attr(point, "customerPrice"),
    manualPrices: list.length,
  };
}

/** A schedule as the ledger records it (before and after are projected through `audit.ts`). */
function scheduleResource(s: PriceSchedule): AscResource {
  return {
    type: "inAppPurchasePriceSchedules",
    id: s.scheduleId,
    attributes: {
      baseTerritory: s.baseTerritory,
      customerPrice: s.customerPrice,
      pricePointId: s.pricePointId,
    },
  };
}

/** The IAP's price points in one territory (the picker), cheapest first. */
async function pricePoints(
  f: Pinned,
  iapId: string,
  territory: string,
): Promise<
  { id: string; customerPrice: string | null; proceeds: string | null }[]
> {
  const { data } = await f.run.client.getAll(
    ascPathV("v2", "inAppPurchases", iapId, "pricePoints"),
    { "filter[territory]": territory, limit: "800" },
    2,
  );
  return data
    .map((p) => ({
      id: p.id,
      customerPrice: attr(p, "customerPrice"),
      proceeds: attr(p, "proceeds"),
    }))
    .sort(
      (a, b) => (Number(a.customerPrice) || 0) - (Number(b.customerPrice) || 0),
    );
}

// ── Reads ────────────────────────────────────────────────────────────────────────────────────

const products: ConnectorRead = distributeRead(async (f) => {
  const rows = (await listStoreProducts(f.c.db, f.c.product)).filter(
    (r) => r.store === "app-store",
  );
  const byProductId = new Map<string, AscResource>();
  for (let i = 0; i < rows.length; i += PRODUCT_ID_CHUNK) {
    const chunk = rows.slice(i, i + PRODUCT_ID_CHUNK);
    const doc = await f.run.client.get(
      ascPath("apps", f.setup.appleId, "inAppPurchasesV2"),
      {
        "filter[productId]": chunk.map((r) => r.store_product_id).join(","),
        limit: "200",
      },
    );
    for (const iap of Array.isArray(doc?.data) ? doc.data : []) {
      const pid = attr(iap, "productId");
      if (pid) byProductId.set(pid, iap);
    }
  }
  const first = rows.length > 0 ? !(await hasApprovedIap(f)) : false;
  return {
    ok: true,
    appleId: f.setup.appleId,
    firstInAppPurchase: first,
    ...(first ? { firstInAppPurchaseNote: FIRST_IAP_NOTE } : {}),
    priceChangeWarning: PRICE_CHANGE_WARNING,
    products: rows.map((r) => {
      const iap = byProductId.get(r.store_product_id) ?? null;
      const type = attr(iap, "inAppPurchaseType");
      return {
        storeProductId: r.store_product_id,
        flag: r.flag,
        deliverableId: r.deliverable_id,
        status: iap ? (attr(iap, "state") ?? "unknown") : "missing",
        typeMismatch: iap !== null && type !== IAP_TYPE,
        iap: iap
          ? {
              id: iap.id,
              name: attr(iap, "name"),
              inAppPurchaseType: type,
              state: attr(iap, "state"),
              familySharable: iap.attributes?.familySharable === true,
            }
          : null,
      };
    }),
  };
});

const pricePointsRead: ConnectorRead = distributeRead(async (f, q) => {
  const { productId } = await mappedProductId(f, q.get("productId"));
  const territory = q.get("territory") ?? "USA";
  if (!TERRITORY.test(territory))
    stop(
      422,
      "invalid_query",
      "territory must be a territory code such as USA",
      ["territory"],
    );
  const iap = await requireIap(f, productId);
  const points = await pricePoints(f, iap.id, territory);
  const current = await readPriceSchedule(f, iap.id);
  return {
    ok: true,
    productId,
    iapId: iap.id,
    territory,
    current: current
      ? {
          baseTerritory: current.baseTerritory,
          pricePointId: current.pricePointId,
          customerPrice: current.customerPrice,
        }
      : null,
    // A change of an existing price is typed; the first one is not.
    priceChange: current !== null,
    priceChangeWarning: PRICE_CHANGE_WARNING,
    pricePoints: points,
  };
});

/** Background assets whose versions the submission-items read looks at (one request each). */
const MAX_ASSETS_CHECKED = 20;

const submissionItems: ConnectorRead = distributeRead(async (f, q) => {
  const platform = q.get("platform") ?? "IOS";
  if (!(PLATFORMS as readonly string[]).includes(platform))
    stop(
      422,
      "invalid_query",
      "platform must be IOS, MAC_OS, TV_OS or VISION_OS",
      ["platform"],
    );
  const mapped = new Set(
    (await listStoreProducts(f.c.db, f.c.product))
      .filter((r) => r.store === "app-store")
      .map((r) => r.store_product_id),
  );
  const first = mapped.size > 0 ? !(await hasApprovedIap(f)) : false;
  const iaps = [];
  if (mapped.size > 0) {
    const doc = await f.run.client.get(
      ascPath("apps", f.setup.appleId, "inAppPurchasesV2"),
      {
        "filter[inAppPurchaseType]": IAP_TYPE,
        "filter[state]": [...SUBMITTABLE_IAP_STATES].join(","),
        limit: "50",
      },
    );
    for (const iap of Array.isArray(doc?.data) ? doc.data : []) {
      const pid = attr(iap, "productId");
      if (!pid || !mapped.has(pid)) continue;
      const version = await editableVersion(f, iap.id);
      if (!version) continue;
      iaps.push({
        inAppPurchaseVersionId: version.id,
        productId: pid,
        iapId: iap.id,
        name: attr(iap, "name"),
        state: attr(iap, "state"),
        versionState: attr(version, "state"),
      });
    }
  }
  const assets = await f.run.client.get(
    ascPath("apps", f.setup.appleId, "backgroundAssets"),
    { "filter[archived]": "false", limit: String(MAX_ASSETS_CHECKED) },
  );
  const bas = [];
  for (const a of Array.isArray(assets?.data) ? assets.data : []) {
    const doc = await f.run.client.get(
      ascPath("backgroundAssets", a.id, "versions"),
      { "filter[state]": "COMPLETE", include: "appStoreRelease", limit: "5" },
    );
    for (const v of Array.isArray(doc?.data) ? doc.data : []) {
      const release = findIncluded(
        doc?.included,
        "backgroundAssetVersionAppStoreReleases",
        relId(v, "appStoreRelease"),
      );
      const releaseState = attr(release, "state");
      const platforms = v.attributes?.platforms;
      if (
        !releaseState ||
        !SUBMITTABLE_BA_RELEASE_STATES.has(releaseState) ||
        (Array.isArray(platforms) && !platforms.includes(platform))
      )
        continue;
      bas.push({
        backgroundAssetVersionId: v.id,
        assetPackIdentifier: attr(a, "assetPackIdentifier"),
        version: attr(v, "version"),
        appStoreReleaseState: releaseState,
      });
    }
  }
  return {
    ok: true,
    platform,
    firstInAppPurchase: first,
    ...(first ? { firstInAppPurchaseNote: FIRST_IAP_NOTE } : {}),
    // The first IAP rides the portal, not this submission.
    inAppPurchaseVersions: first ? [] : iaps,
    backgroundAssetVersions: bas,
  };
});

// ── Writes ───────────────────────────────────────────────────────────────────────────────────

/** The IAP's editable version, or a new one: one ledger step. */
async function ensureVersion(
  f: Flow,
  iapId: string,
): Promise<{ id: string; step: StepResult }> {
  const r = await step(f, "iap.version", iapId, {
    request: { iapId },
    find: () => editableVersion(f, iapId),
    write: async () =>
      single(
        await f.run.client.post(ascPath("inAppPurchaseVersions"), {
          data: {
            type: "inAppPurchaseVersions",
            relationships: {
              inAppPurchase: { data: { type: "inAppPurchases", id: iapId } },
            },
          },
        }),
      ),
    reread: async (id) =>
      single(await f.run.client.get(ascPath("inAppPurchaseVersions", id))),
    resultIds: (v) => ({ versionId: v.id, iapId }),
    summary: (v, outcome) =>
      `${outcome === "written" ? "Created" : "Reused"} version ${v.id} of In-App Purchase ${iapId}`,
  });
  const id = r.ids.versionId;
  if (!id)
    stop(502, "store_refused", "App Store Connect created no IAP version");
  return { id, step: r };
}

/** One localization of an IAP version (create or edit): one ledger step. */
function putLocalization(
  f: Flow,
  productId: string,
  versionId: string,
  l: Localization,
): Promise<StepResult> {
  const find = async () => {
    const doc = await f.run.client.get(
      ascPath("inAppPurchaseVersions", versionId, "localizations"),
      { limit: "50" },
    );
    const data = Array.isArray(doc?.data) ? doc.data : [];
    return data.find((x) => attr(x, "locale") === l.locale) ?? null;
  };
  const attributes = {
    name: l.name,
    ...(l.description !== undefined ? { description: l.description } : {}),
  };
  return step(f, "iap.localization", `${versionId}:${l.locale}`, {
    request: { versionId, ...l },
    find,
    satisfied: (x) =>
      attr(x, "name") === l.name &&
      (l.description === undefined || attr(x, "description") === l.description),
    write: async (existing) =>
      single(
        existing
          ? await f.run.client.patch(
              ascPathV("v2", "inAppPurchaseLocalizations", existing.id),
              {
                data: {
                  type: "inAppPurchaseLocalizations",
                  id: existing.id,
                  attributes,
                },
              },
            )
          : await f.run.client.post(
              ascPathV("v2", "inAppPurchaseLocalizations"),
              {
                data: {
                  type: "inAppPurchaseLocalizations",
                  attributes: { locale: l.locale, ...attributes },
                  relationships: {
                    version: {
                      data: { type: "inAppPurchaseVersions", id: versionId },
                    },
                  },
                },
              },
            ),
      ),
    reread: async (id) =>
      single(
        await f.run.client.get(
          ascPathV("v2", "inAppPurchaseLocalizations", id),
        ),
      ),
    resultIds: (x) => ({ localizationId: x.id, versionId }),
    summary: () =>
      `Set the ${l.locale} name and description of In-App Purchase ${productId}`,
  });
}

const create: ConnectorControl = distributeControl(async (f, body) => {
  const referenceName = text(body, "referenceName", REFERENCE_NAME_MAX, true)!;
  const reviewNote = text(body, "reviewNote", REVIEW_NOTE_MAX, false);
  if (
    body.familySharable !== undefined &&
    typeof body.familySharable !== "boolean"
  )
    stop(422, "invalid_body", "familySharable must be a boolean", [
      "familySharable",
    ]);
  const familySharable = body.familySharable as boolean | undefined;
  const raw = body.localizations;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_LOCALIZATIONS)
    stop(
      422,
      "invalid_body",
      `localizations must list 1 to ${MAX_LOCALIZATIONS} locales`,
      ["localizations"],
    );
  const locs = raw.map((o, i) => localization(o, `localizations[${i}]`));
  if (new Set(locs.map((l) => l.locale)).size !== locs.length)
    stop(422, "invalid_body", "each locale may appear once", ["localizations"]);
  const { productId } = await mappedProductId(f, body.productId);

  const find = async () => {
    const hit = await findIap(f, productId);
    // A mapped id that already exists as another type is the operator's to resolve in the portal:
    // an IAP's type cannot change, and its product id cannot be reused.
    if (hit && attr(hit, "inAppPurchaseType") !== IAP_TYPE)
      stop(
        409,
        "iap_type_mismatch",
        `${productId} exists in App Store Connect as ${attr(hit, "inAppPurchaseType") ?? "another type"}, not ${IAP_TYPE}`,
      );
    return hit;
  };
  const created = await step(f, "iap.create", productId, {
    request: { productId, referenceName, reviewNote, familySharable },
    find,
    write: async () =>
      single(
        await f.run.client.post(ascPathV("v2", "inAppPurchases"), {
          data: {
            type: "inAppPurchases",
            attributes: {
              name: referenceName,
              productId,
              inAppPurchaseType: IAP_TYPE,
              ...(reviewNote !== undefined ? { reviewNote } : {}),
              ...(familySharable !== undefined ? { familySharable } : {}),
            },
            // The pinned app, never the request's.
            relationships: {
              app: { data: { type: "apps", id: f.setup.appleId } },
            },
          },
        }),
      ),
    reread: async (id) =>
      single(await f.run.client.get(ascPathV("v2", "inAppPurchases", id))),
    resultIds: (i) => ({ iapId: i.id }),
    summary: (i, outcome) =>
      `${outcome === "written" ? "Created" : "Found"} the non-consumable In-App Purchase ${productId} (${i.id})`,
  });
  const iapId = created.ids.iapId;
  if (!iapId)
    stop(502, "store_refused", "App Store Connect created no In-App Purchase");
  const version = await ensureVersion(f, iapId);
  const localizations = [];
  for (const l of locs)
    localizations.push({
      locale: l.locale,
      ...stepView(await putLocalization(f, productId, version.id, l)),
    });
  const after = single(
    await f.run.client.getOrNull(ascPathV("v2", "inAppPurchases", iapId)),
  );
  return {
    ok: true,
    productId,
    iapId,
    versionId: version.id,
    state: attr(after, "state"),
    steps: {
      create: stepView(created),
      version: stepView(version.step),
      localizations,
    },
  };
});

const localizationControl: ConnectorControl = distributeControl(
  async (f, body) => {
    const l = localization(body, "body");
    const { productId } = await mappedProductId(f, body.productId);
    const iap = await requireIap(f, productId);
    const version = await ensureVersion(f, iap.id);
    const r = await putLocalization(f, productId, version.id, l);
    return {
      ok: true,
      productId,
      iapId: iap.id,
      versionId: version.id,
      locale: l.locale,
      ...stepView(r),
      steps: { version: stepView(version.step), localization: stepView(r) },
    };
  },
);

const price: ConnectorControl = distributeControl(async (f, body) => {
  const territory = body.baseTerritory;
  if (typeof territory !== "string" || !TERRITORY.test(territory))
    stop(
      422,
      "invalid_body",
      "baseTerritory must be a territory code such as USA",
      ["baseTerritory"],
    );
  const wantId = body.pricePointId;
  const wantPrice = body.customerPrice;
  if ((wantId === undefined) === (wantPrice === undefined))
    stop(
      422,
      "invalid_body",
      "send exactly one of pricePointId or customerPrice",
      ["pricePointId", "customerPrice"],
    );
  if (
    wantId !== undefined &&
    (typeof wantId !== "string" || !PRICE_POINT_ID.test(wantId))
  )
    stop(422, "invalid_body", "pricePointId must be a price point id", [
      "pricePointId",
    ]);
  if (
    wantPrice !== undefined &&
    (typeof wantPrice !== "string" || !CUSTOMER_PRICE.test(wantPrice))
  )
    stop(422, "invalid_body", "customerPrice must be a price such as 0.99", [
      "customerPrice",
    ]);
  const { productId } = await mappedProductId(f, body.productId);
  const iap = await requireIap(f, productId);

  // The point must be one Apple offers for THIS IAP in the base territory (the picker's list).
  const points = await pricePoints(f, iap.id, territory);
  const point =
    wantId !== undefined
      ? points.find((p) => p.id === wantId)
      : points.find((p) => Number(p.customerPrice) === Number(wantPrice));
  if (!point)
    stop(
      422,
      "unknown_price_point",
      `no ${territory} price point ${String(wantId ?? wantPrice)} for ${productId}`,
      [wantId !== undefined ? "pricePointId" : "customerPrice"],
    );

  // A change of an existing price is typed (compared server-side with Apple's app name). The
  // decision comes from Apple's schedule, never from the request.
  const current = await readPriceSchedule(f, iap.id);
  const unchanged =
    current !== null &&
    current.baseTerritory === territory &&
    current.pricePointId === point.id;
  let confirmed = false;
  if (current && !unchanged) {
    if (typeof body.confirm !== "string" || body.confirm.trim() === "")
      stop(
        422,
        "confirmation_required",
        `type the app's name in confirm to change the price. ${PRICE_CHANGE_WARNING}`,
        ["confirm"],
      );
    const unconfirmed = await checkTypedConfirmation(
      f.run,
      f.setup,
      body.confirm,
      "change the price",
    );
    if (unconfirmed) return unconfirmed;
    confirmed = true;
  }

  const r = await step(f, "iap.price", iap.id, {
    request: { iapId: iap.id, territory, pricePointId: point.id },
    find: async () => {
      const s = await readPriceSchedule(f, iap.id);
      return s ? scheduleResource(s) : null;
    },
    satisfied: (s) =>
      attr(s, "baseTerritory") === territory &&
      attr(s, "pricePointId") === point.id,
    write: async (existing) => {
      // `initial` only when Apple's own pre-read found no price; a change carries the typed
      // assertion, and without it (a price that appeared since the check) the gate refuses.
      const gate = existing
        ? confirmed
          ? { typedConfirmation: true }
          : {}
        : { initial: true };
      const local = "${price-0}";
      await f.run.client.post(
        ascPath("inAppPurchasePriceSchedules"),
        {
          data: {
            type: "inAppPurchasePriceSchedules",
            relationships: {
              inAppPurchase: { data: { type: "inAppPurchases", id: iap.id } },
              baseTerritory: { data: { type: "territories", id: territory } },
              manualPrices: {
                data: [{ type: "inAppPurchasePrices", id: local }],
              },
            },
          },
          included: [
            {
              type: "inAppPurchasePrices",
              id: local,
              attributes: { startDate: null },
              relationships: {
                inAppPurchaseV2: {
                  data: { type: "inAppPurchases", id: iap.id },
                },
                inAppPurchasePricePoint: {
                  data: { type: "inAppPurchasePricePoints", id: point.id },
                },
              },
            },
          ],
        },
        gate,
      );
      const s = await readPriceSchedule(f, iap.id);
      return s ? scheduleResource(s) : null;
    },
    reread: async () => {
      const s = await readPriceSchedule(f, iap.id);
      return s ? scheduleResource(s) : null;
    },
    resultIds: (s) => ({
      iapId: iap.id,
      scheduleId: s.id,
      pricePointId: point.id,
    }),
    summary: () =>
      current
        ? `Changed the price of In-App Purchase ${productId} from ${current.customerPrice ?? "?"} (${current.baseTerritory ?? "?"}) to ${point.customerPrice ?? "?"} (${territory}), typed confirmation`
        : `Set the first price of In-App Purchase ${productId}: ${point.customerPrice ?? "?"} (${territory})`,
  });
  return {
    ok: true,
    ...stepView(r),
    productId,
    iapId: iap.id,
    baseTerritory: territory,
    pricePointId: point.id,
    customerPrice: point.customerPrice,
    change: current !== null && !unchanged,
    ...(current !== null && !unchanged
      ? { priceChangeWarning: PRICE_CHANGE_WARNING }
      : {}),
  };
});

/** Territories an availability names at most (the gate's linkage bound). */
const MAX_TERRITORIES = 200;

const availability: ConnectorControl = distributeControl(async (f, body) => {
  const { productId } = await mappedProductId(f, body.productId);
  const iap = await requireIap(f, productId);
  const path = ascPathV(
    "v2",
    "inAppPurchases",
    iap.id,
    "inAppPurchaseAvailability",
  );
  const r = await step(f, "iap.availability", iap.id, {
    request: { iapId: iap.id, allTerritories: true },
    // An availability already set (here or in the portal) is the operator's: never changed.
    find: async () => single(await f.run.client.getOrNull(path)),
    write: async () => {
      const { data } = await f.run.client.getAll(
        ascPath("territories"),
        { limit: "200" },
        2,
      );
      const territories = data.filter((t) => t.type === "territories");
      if (territories.length === 0 || territories.length > MAX_TERRITORIES)
        stop(
          502,
          "store_refused",
          "App Store Connect listed no usable territories",
        );
      return single(
        await f.run.client.post(ascPath("inAppPurchaseAvailabilities"), {
          data: {
            type: "inAppPurchaseAvailabilities",
            attributes: { availableInNewTerritories: true },
            relationships: {
              inAppPurchase: { data: { type: "inAppPurchases", id: iap.id } },
              availableTerritories: {
                data: territories.map((t) => ({
                  type: "territories",
                  id: t.id,
                })),
              },
            },
          },
        }),
      );
    },
    reread: async (id) =>
      single(
        await f.run.client.getOrNull(
          ascPath("inAppPurchaseAvailabilities", id),
        ),
      ),
    resultIds: (a) => ({ iapId: iap.id, availabilityId: a.id }),
    summary: () =>
      `Made In-App Purchase ${productId} available in every territory, and in new ones`,
  });
  return {
    ok: true,
    ...stepView(r),
    productId,
    iapId: iap.id,
    availabilityId: r.ids.availabilityId ?? null,
  };
});

// ── Submission items (offered to A-17d's `distribute/submit`) ────────────────────────────────

export interface SubmissionExtras {
  inAppPurchaseVersionIds: string[];
  backgroundAssetVersionIds: string[];
}

function idList(body: Record<string, unknown>, name: string): string[] {
  const v = body[name];
  if (v === undefined) return [];
  if (
    !Array.isArray(v) ||
    v.length > MAX_ITEMS ||
    !v.every((x) => typeof x === "string" && ID.test(x)) ||
    new Set(v).size !== v.length
  )
    stop(
      422,
      "invalid_body",
      `${name} must list at most ${MAX_ITEMS} distinct ids`,
      [name],
    );
  return v as string[];
}

/** The optional IAP and Background Asset version ids of a `distribute/submit` body. */
export function submissionExtras(
  body: Record<string, unknown>,
): SubmissionExtras {
  return {
    inAppPurchaseVersionIds: idList(body, "inAppPurchaseVersionIds"),
    backgroundAssetVersionIds: idList(body, "backgroundAssetVersionIds"),
  };
}

/**
 * Prove every extra item of a submission is the pinned app's and ready, BEFORE the submission is
 * opened or touched: a request naming one foreign or unready object sends nothing.
 *
 *   - IAP version → its IAP (`include=inAppPurchase`) → the IAP's product id must be an `app-store`
 *     row of this product's map, and the PINNED app's IAP with that product id must be this IAP;
 *     non-consumable, its state submittable, the version editable; and not the app's first IAP.
 *   - Background Asset version → its asset → `include=app` must be the pinned app; the version
 *     uploaded (`COMPLETE`), its App Store release still open, its platforms covering `platform`.
 */
export async function proveSubmissionExtras(
  f: Flow,
  platform: string,
  extras: SubmissionExtras,
): Promise<void> {
  if (extras.inAppPurchaseVersionIds.length > 0 && !(await hasApprovedIap(f)))
    stop(409, "first_iap_portal", FIRST_IAP_NOTE);
  for (const id of extras.inAppPurchaseVersionIds) {
    const doc = await f.run.client.getOrNull(
      ascPath("inAppPurchaseVersions", id),
      {
        include: "inAppPurchase",
      },
    );
    const version = single(doc);
    const iapId = relId(version, "inAppPurchase");
    const unknown = () =>
      stop(
        404,
        "unknown_iap_version",
        `no In-App Purchase version ${id} on this app`,
      );
    if (!version || !iapId) unknown();
    const included = findIncluded(doc?.included, "inAppPurchases", iapId);
    const iapRead =
      included ??
      single(
        await f.run.client.getOrNull(ascPathV("v2", "inAppPurchases", iapId!)),
      );
    const productId = attr(iapRead, "productId");
    if (
      !productId ||
      !isStoreProductId("app-store", productId) ||
      !(await getStoreProduct(f.c.db, f.c.product, "app-store", productId))
    )
      unknown();
    // Ownership: the pinned app's IAP with that product id must be this one.
    const owned = await findIap(f, productId!);
    if (!owned || owned.id !== iapId) unknown();
    if (attr(owned, "inAppPurchaseType") !== IAP_TYPE)
      stop(409, "iap_type_mismatch", `${productId} is not ${IAP_TYPE}`);
    const iapState = attr(owned, "state");
    if (!SUBMITTABLE_IAP_STATES.has(iapState ?? ""))
      stop(
        409,
        "iap_not_ready",
        `In-App Purchase ${productId} is ${iapState ?? "in an unknown state"}, not ready to submit`,
      );
    const versionState = attr(version, "state");
    if (!EDITABLE_IAP_VERSION_STATES.has(versionState ?? ""))
      stop(
        409,
        "iap_not_ready",
        `In-App Purchase version ${id} is ${versionState ?? "in an unknown state"}`,
      );
  }
  for (const id of extras.backgroundAssetVersionIds) {
    const doc = await f.run.client.getOrNull(
      ascPath("backgroundAssetVersions", id),
      { include: "backgroundAsset,appStoreRelease" },
    );
    const version = single(doc);
    const assetId = relId(version, "backgroundAsset");
    const unknown = () =>
      stop(
        404,
        "unknown_background_asset_version",
        `no Background Asset version ${id} on this app`,
      );
    if (!version || !assetId) unknown();
    const asset = single(
      await f.run.client.getOrNull(ascPath("backgroundAssets", assetId!), {
        include: "app",
      }),
    );
    if (!asset || relId(asset, "app") !== f.setup.appleId) unknown();
    const release = findIncluded(
      doc?.included,
      "backgroundAssetVersionAppStoreReleases",
      relId(version, "appStoreRelease"),
    );
    const releaseState = attr(release, "state");
    const platforms = version!.attributes?.platforms;
    if (
      attr(version, "state") !== "COMPLETE" ||
      !releaseState ||
      !SUBMITTABLE_BA_RELEASE_STATES.has(releaseState) ||
      (Array.isArray(platforms) && !platforms.includes(platform))
    )
      stop(
        409,
        "background_asset_not_ready",
        `Background Asset version ${id} is not ready for an ${platform} App Store submission`,
      );
  }
}

/**
 * The preflight's first-IAP line (A-17d's preflight leaves it here): `null` when the product maps
 * no App Store product, or one of the app's IAPs has passed review; otherwise a portal note
 * (`ok: null`, not blocking: the app version can be submitted while the first IAP waits).
 */
export async function firstIapCheck(
  f: Pinned,
): Promise<{ id: string; ok: null; detail: string } | null> {
  const mapped = (await listStoreProducts(f.c.db, f.c.product)).some(
    (r) => r.store === "app-store",
  );
  if (!mapped || (await hasApprovedIap(f))) return null;
  return { id: "firstInAppPurchase", ok: null, detail: FIRST_IAP_NOTE };
}

// ── Tables ───────────────────────────────────────────────────────────────────────────────────

/** The IAP writes: path under `…/connectors/asc/` → implementation. */
export const ASC_CATALOG_CONTROLS: Readonly<Record<string, ConnectorControl>> =
  {
    "iap/create": create,
    "iap/localization": localizationControl,
    "iap/price": price,
    "iap/availability": availability,
  };

/** The IAP reads: path under `GET …/connectors/asc/` → implementation. */
export const ASC_CATALOG_READS: Readonly<Record<string, ConnectorRead>> = {
  "iap/products": products,
  "iap/price-points": pricePointsRead,
  "distribute/submission-items": submissionItems,
};
