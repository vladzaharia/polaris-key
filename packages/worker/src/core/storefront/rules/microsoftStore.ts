/**
 * The Microsoft Store write gate's rule table (A-18f; notes/S-15 §4.2, §6.2, §8.4, owner decision
 * 2). The second storefront rule set on the store-agnostic engine (`../gate.ts`), with the plain
 * JSON body matcher (`../match/json.ts`).
 *
 * The Worker holds the seller account's Partner Center Entra application (`PLATFORM_MS_PARTNER_CENTER`,
 * A-16) with the **Manager** role, which Microsoft requires for the submission APIs and which has no
 * per-app scope: it can rewrite listings, price tiers and rollouts, and delete submissions, flights
 * and add-ons, for EVERY app of the seller account. THIS TABLE is the barrier between a console
 * session (or a compromised Worker path) and those powers. It is deny-by-default:
 *
 *   - `MsStoreWriteClient.request` (`services/distribution/connectors/msstore/write.ts`) consults
 *     the gate **before either token thunk runs**. A refused request throws `MsStoreWriteDenied`:
 *     no token is minted and nothing is sent.
 *   - Two APIs share the one table, told apart by path (they never collide):
 *       - CLASSIC  `https://manage.devcenter.microsoft.com/v1.0/my/…` (MSIX/APPX submissions,
 *         flights, gradual rollout; P5-04 reads it GET-only);
 *       - MSI/EXE  `https://api.store.microsoft.com/submission/v1/product/{id}/…` (metadata
 *         modules, packages by URL, listing assets, submit).
 *   - A write passes only when a rule names its method and template AND its JSON body fits the
 *     rule's declared shape (every key declared, enums, lengths, array sizes) AND the rule's own
 *     check. No rule allows a `DELETE` (all five of the classic API are denied below).
 *   - **Typed confirmation** (the phrase is the app's `primaryName`, `confirm.ts`): a submission
 *     commit (app and flight), the MSI/EXE `submit`, `finalizepackagerollout` (app and flight) and
 *     ANY pricing change (`pricing` in a classic submission update; `availability.pricing` or
 *     `freeTrial` in an MSI/EXE metadata patch, or any `availability` in a full-module PUT).
 *   - **Never**: a `PendingDelete` file status (packages and images stay; a listing asset set is
 *     replaced by an MSI/EXE assets commit, which is an update, §8.4), `listingsToRemove`,
 *     notes for certification (they carry test-account credentials), trailers, add-ons (no P6-01
 *     row), and the five DELETEs. Partner Center users, payout and tax have no API at all.
 *
 * NO MACHINE-READABLE SPEC EXISTS for either API, so the table is classified against a
 * HAND-WRITTEN operation list (`test/fixtures/msstore/operations.json`) transcribed from
 * Microsoft's reference pages, pinned by FETCH DATE and by the SHA-256 of the list itself
 * (`MSSTORE_SPEC_PIN`): editing the list without bumping the pin fails CI, and a new pin is a
 * THREAT-MODEL §9 review trigger (the docs-drift review: re-read the pages the fixture names,
 * re-classify every write). The conformance suite (`test/storefront/conformance.test.ts`)
 * requires every listed write to be allowed here or denied below, exactly once.
 *
 * Request shapes the gate sees: a write with no request body (create a submission, commit,
 * submit, halt, finalize) is checked as `{}` and sent with none (`send: "none"`); the rollout
 * percentage is a QUERY parameter at Microsoft, checked here as the body `{ percentage }` and
 * sent as `?percentage=` (`send: "query"`).
 *
 * A change to this table is a THREAT-MODEL §9 review trigger (any `core/storefront/rules/*`).
 */

import type { SpecPin } from "../../adapters/contract.js";
import {
  compileGate,
  isPlainObject,
  PATH_SEGMENT,
  type DenyReason,
  type GateContext,
  type GateRuleSet,
} from "../gate.js";
import { StoreWriteDenied } from "../errors.js";
import { matchJson, type JsonRule, type JsonShape } from "../match/json.js";

/**
 * The hand-written operation list the table is classified against: Microsoft's reference pages as
 * read on `version` (the fetch date), and the SHA-256 of the list's `operations` array
 * (`JSON.stringify`, as stored). `test/storefront/msstore.test.ts` recomputes it.
 */
export const MSSTORE_SPEC_PIN = {
  title: "Microsoft Store submission APIs (hand-written operation list)",
  version: "2026-10-04",
  sha256: "75d4349577abc74b6d41b831a713bb743b03b90fc8a0157a48078ddef6b3c10c",
} as const satisfies SpecPin;

/** A request the Microsoft Store gate refused. Thrown before any token is minted or request sent. */
export class MsStoreWriteDenied extends StoreWriteDenied {
  constructor(method: string, target: string, reason: DenyReason) {
    super(
      "microsoft-store",
      method,
      target,
      reason,
      `Microsoft Store write gate refused ${method} ${target}: ${reason}`,
    );
    this.name = "MsStoreWriteDenied";
  }
}

/** How the client sends what the gate checked (see the file comment). */
export type MsSend = "json" | "query" | "none";

export interface MsStoreRule extends JsonRule {
  send: MsSend;
}

// ── Shapes ───────────────────────────────────────────────────────────────────────────────────

const str = (max: number, values?: readonly string[]): JsonShape =>
  values ? { kind: "string", max, values } : { kind: "string", max };
const bool: JsonShape = { kind: "boolean" };
const num = (min: number, max: number): JsonShape => ({
  kind: "number",
  min,
  max,
});
const obj = (keys: Record<string, JsonShape>): JsonShape => ({
  kind: "object",
  keys,
});
const arr = (items: JsonShape, max: number): JsonShape => ({
  kind: "array",
  items,
  max,
});

/** A language tag as Microsoft keys listings (`en-us`, `zh-hans-cn`). */
export const LOCALE = "[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}";
/** An ISO 3166-1 alpha-2 market. */
const MARKET = "[A-Z]{2}";
/** A classic price tier (`Base`, `NotAvailable`, `Free`, `Tier2`…`Tier1424`). */
export const PRICE_TIER = /^(?:Base|NotAvailable|Free|Tier[0-9]{1,4})$/;
const LOCALE_RE = new RegExp(`^${LOCALE}$`);

const URL_MAX = 2048;
const TEXT = 10_000;

/** The file statuses a request may carry: never `PendingDelete`. */
const KEEP: readonly string[] = ["Uploaded"];
const KEEP_OR_ADD: readonly string[] = ["Uploaded", "PendingUpload"];

const rolloutOptions = obj({
  packageRollout: obj({
    isPackageRollout: bool,
    packageRolloutPercentage: num(0, 100),
    // Assigned by Partner Center and ignored on input (Microsoft's note); accepted so a body
    // built from a read need not strip them.
    packageRolloutStatus: str(64),
    fallbackSubmissionId: str(64),
  }),
  isMandatoryUpdate: bool,
  mandatoryUpdateEffectiveDate: str(40),
});

const PACKAGE_FIELDS = {
  fileName: str(260),
  // Packages already in the submission only: an MSIX goes up through CI (decision 2), and a
  // package is never removed by the Worker.
  fileStatus: str(16, KEEP),
  id: str(64),
  version: str(32),
  architecture: str(32),
  languages: arr(str(16), 200),
  capabilities: arr(str(128), 200),
  minimumDirectXVersion: str(32),
  minimumSystemRam: str(32),
};

const classicPackage = obj({
  ...PACKAGE_FIELDS,
  targetDeviceFamilies: arr(str(128), 20),
});
const flightPackage = obj(PACKAGE_FIELDS);

const classicImage = obj({
  fileName: str(260),
  fileStatus: str(16, KEEP_OR_ADD),
  id: str(64),
  description: str(200),
  imageType: str(64),
});

const baseListing = obj({
  copyrightAndTrademarkInfo: str(200),
  keywords: arr(str(100), 7),
  licenseTerms: str(TEXT),
  description: str(TEXT),
  features: arr(str(200), 20),
  releaseNotes: str(1500),
  images: arr(classicImage, 100),
  recommendedHardware: arr(str(200), 11),
  minimumHardware: arr(str(200), 11),
  title: str(256),
  shortDescription: str(1000),
  shortTitle: str(256),
  sortTitle: str(256),
  voiceTitle: str(256),
  devStudio: str(256),
});

const classicPricing = obj({
  trialPeriod: str(32, [
    "NoFreeTrial",
    "OneDay",
    "TrialNeverExpires",
    "SevenDays",
    "FifteenDays",
    "ThirtyDays",
  ]),
  marketSpecificPricings: {
    kind: "map",
    key: MARKET,
    values: str(32),
    max: 250,
  },
  priceId: str(32),
  isAdvancedPricingModel: bool,
});

const gamingOptions = obj({
  genres: arr(str(64), 30),
  isLocalMultiplayer: bool,
  isLocalCooperative: bool,
  isOnlineMultiplayer: bool,
  isOnlineCooperative: bool,
  localMultiplayerMinPlayers: num(0, 64),
  localMultiplayerMaxPlayers: num(0, 64),
  localCooperativeMinPlayers: num(0, 64),
  localCooperativeMaxPlayers: num(0, 64),
  isBroadcastingPrivilegeGranted: bool,
  isCrossPlayEnabled: bool,
  kinectDataForExternal: str(16, ["NotSet", "Unknown", "Enabled", "Disabled"]),
});

/** The classic app submission update (PUT): the writable fields, minus the never-list. */
const CLASSIC_SUBMISSION: Record<string, JsonShape> = {
  applicationCategory: str(100),
  pricing: classicPricing,
  visibility: str(16, ["Public", "Private", "Hidden"]),
  targetPublishMode: str(16, ["Immediate", "Manual", "SpecificDate"]),
  targetPublishDate: str(40),
  listings: {
    kind: "map",
    key: LOCALE,
    values: obj({ baseListing }),
    max: 110,
  },
  hardwarePreferences: arr(str(32), 10),
  automaticBackupEnabled: bool,
  canInstallOnRemovableMedia: bool,
  isGameDvrEnabled: bool,
  gamingOptions: arr(gamingOptions, 1),
  hasExternalInAppProducts: bool,
  meetAccessibilityGuidelines: bool,
  applicationPackages: arr(classicPackage, 100),
  packageDeliveryOptions: rolloutOptions,
  enterpriseLicensing: str(32, ["None", "Online", "OnlineAndOffline"]),
  allowMicrosoftDecideAppAvailabilityToFutureDeviceFamilies: bool,
  allowTargetFutureDeviceFamilies: obj({
    Desktop: bool,
    Mobile: bool,
    Holographic: bool,
    Xbox: bool,
    Team: bool,
  }),
};

const FLIGHT_SUBMISSION: Record<string, JsonShape> = {
  flightPackages: arr(flightPackage, 100),
  packageDeliveryOptions: rolloutOptions,
  targetPublishMode: str(16, ["Immediate", "Manual", "SpecificDate"]),
  targetPublishDate: str(40),
};

const HARDWARE_FEATURES = [
  "Touch",
  "Keyboard",
  "Mouse",
  "Camera",
  "NFC_HCE",
  "NFC_Proximity",
  "Bluetooth_LE",
  "Telephony",
  "Microphone",
];
const HARDWARE_REQUIREMENTS = [
  "Memory",
  "DirectX",
  "Video_Memory",
  "Processor",
  "Graphics",
];

/** The MSI/EXE metadata modules (PUT replaces the modules sent; PATCH merges). */
const MSI_METADATA: Record<string, JsonShape> = {
  availability: obj({
    markets: arr(str(8), 250),
    discoverability: str(16, ["DISCOVERABLE", "DEEPLINK_ONLY"]),
    enableInFutureMarkets: bool,
    pricing: str(16, ["FREE", "FREEMIUM", "SUBSCRIPTION", "PAID"]),
    freeTrial: str(16, ["NO_FREE_TRIAL", "FREE_TRIAL"]),
  }),
  properties: obj({
    isPrivacyPolicyRequired: bool,
    privacyPolicyUrl: str(URL_MAX),
    website: str(URL_MAX),
    supportContactInfo: str(URL_MAX),
    category: str(100),
    subcategory: str(100),
    productDeclarations: obj({
      dependsOnDriversOrNT: bool,
      accessibilitySupport: bool,
      penAndInkSupport: bool,
    }),
    isSystemFeatureRequired: arr(
      obj({
        isRequired: bool,
        isRecommended: bool,
        hardwareItemType: str(32, HARDWARE_FEATURES),
      }),
      20,
    ),
    systemRequirementDetails: arr(
      obj({
        minimumRequirement: str(200),
        recommendedRequirement: str(200),
        hardwareItemType: str(32, HARDWARE_REQUIREMENTS),
      }),
      10,
    ),
  }),
  listings: obj({
    language: str(32),
    description: str(TEXT),
    whatsNew: str(1500),
    productFeatures: arr(str(200), 20),
    shortDescription: str(1000),
    searchTerms: arr(str(100), 7),
    additionalLicenseTerms: str(TEXT),
    copyright: str(200),
    developedBy: str(256),
    sortTitle: str(256),
    requirements: arr(
      obj({ minimumHardware: str(200), recommendedHardware: str(200) }),
      11,
    ),
    contactInfo: str(URL_MAX),
  }),
  listingsToAdd: arr(str(32), 110),
};

const ERROR_SCENARIOS = [
  "installationCancelledByUser",
  "applicationAlreadyExists",
  "installationAlreadyInProgress",
  "diskSpaceIsFull",
  "rebootRequired",
  "networkFailure",
  "packageRejectedDuringInstallation",
  "installationSuccessful",
  "miscellaneous",
];

const MSI_PACKAGE: Record<string, JsonShape> = {
  packageUrl: str(URL_MAX),
  languages: arr(str(32), 110),
  architectures: arr(str(8, ["Neutral", "X86", "X64", "Arm", "Arm64"]), 5),
  isSilentInstall: bool,
  installerParameters: str(1024),
  genericDocUrl: str(URL_MAX),
  errorDetails: arr(
    obj({
      errorScenario: str(64, ERROR_SCENARIOS),
      errorScenarioDetails: arr(
        obj({ errorValue: str(100), errorUrl: str(URL_MAX) }),
        10,
      ),
    }),
    10,
  ),
  packageType: str(8, ["exe", "msi"]),
};

const assetRefs = arr(obj({ id: str(128), assetUrl: str(URL_MAX) }), 10);

// ── Value checks ─────────────────────────────────────────────────────────────────────────────

/** An `https:` URL with no credentials and no fragment. */
export function isHttpsUrl(v: unknown): boolean {
  if (typeof v !== "string" || v.length > URL_MAX) return false;
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return false;
  }
  return (
    u.protocol === "https:" &&
    u.username === "" &&
    u.password === "" &&
    u.hash === ""
  );
}

const optionalUrl = (v: unknown) =>
  v === undefined || v === "" || isHttpsUrl(v);

/** A file name inside the submission ZIP: relative, no traversal, no drive or scheme. */
const ZIP_NAME =
  /^(?![\\/])(?!.*(?:^|[\\/])\.\.(?:[\\/]|$))[A-Za-z0-9 ._()\\/-]{1,260}$/;

const typed = (ctx: GateContext): DenyReason | null =>
  ctx.typedConfirmation === true ? null : "typed_confirmation_required";

function checkClassicSubmission(
  b: Record<string, unknown>,
  ctx: GateContext,
): DenyReason | null {
  if (
    b.applicationCategory !== undefined &&
    !/^[A-Za-z]+(?:_[A-Za-z]+)*$/.test(b.applicationCategory as string)
  )
    return "value_not_allowed";
  if (isPlainObject(b.listings))
    for (const l of Object.values(b.listings)) {
      const images = (l as { baseListing?: { images?: unknown[] } }).baseListing
        ?.images;
      for (const img of images ?? [])
        if (!ZIP_NAME.test((img as { fileName?: string }).fileName ?? "x"))
          return "value_not_allowed";
    }
  if (b.pricing !== undefined) {
    const p = b.pricing as Record<string, unknown>;
    if (p.priceId !== undefined && !PRICE_TIER.test(p.priceId as string))
      return "value_not_allowed";
    if (isPlainObject(p.marketSpecificPricings))
      for (const t of Object.values(p.marketSpecificPricings))
        if (!PRICE_TIER.test(t as string)) return "value_not_allowed";
    // Any pricing in an update is a price change (owner rule): typed.
    return typed(ctx);
  }
  return null;
}

function checkMsiMetadata(full: boolean) {
  return (b: Record<string, unknown>, ctx: GateContext): DenyReason | null => {
    const props = b.properties as Record<string, unknown> | undefined;
    if (
      props &&
      !(optionalUrl(props.privacyPolicyUrl) && optionalUrl(props.website))
    )
      return "value_not_allowed";
    const listing = b.listings as Record<string, unknown> | undefined;
    if (
      listing?.language !== undefined &&
      !LOCALE_RE.test(listing.language as string)
    )
      return "value_not_allowed";
    for (const l of (b.listingsToAdd as unknown[] | undefined) ?? [])
      if (!LOCALE_RE.test(l as string)) return "value_not_allowed";
    const avail = b.availability as Record<string, unknown> | undefined;
    if (avail) {
      for (const m of (avail.markets as unknown[] | undefined) ?? [])
        if (!/^[A-Z]{2}$/.test(m as string)) return "value_not_allowed";
      // A full-module PUT replaces availability, pricing model included; a patch is a price
      // change only when it names the pricing model or the trial.
      if (full || avail.pricing !== undefined || avail.freeTrial !== undefined)
        return typed(ctx);
    }
    return null;
  };
}

function checkMsiPackage(p: Record<string, unknown>): DenyReason | null {
  if (p.packageUrl !== undefined && !isHttpsUrl(p.packageUrl))
    return "value_not_allowed";
  if (!optionalUrl(p.genericDocUrl)) return "value_not_allowed";
  for (const e of (p.errorDetails as Record<string, unknown>[] | undefined) ??
    [])
    for (const d of (e.errorScenarioDetails as
      | Record<string, unknown>[]
      | undefined) ?? [])
      if (!optionalUrl(d.errorUrl)) return "value_not_allowed";
  for (const l of (p.languages as unknown[] | undefined) ?? [])
    if (!LOCALE_RE.test(l as string)) return "value_not_allowed";
  return null;
}

function checkAssetCommit(b: Record<string, unknown>): DenyReason | null {
  const a = b.listingAssets as Record<string, unknown> | undefined;
  if (!a) return "invalid_body";
  if (typeof a.language !== "string" || !LOCALE_RE.test(a.language))
    return "value_not_allowed";
  for (const k of ["storeLogos", "screenshots"])
    for (const r of (a[k] as Record<string, unknown>[] | undefined) ?? [])
      if (r.assetUrl !== undefined && !isHttpsUrl(r.assetUrl))
        return "value_not_allowed";
  return null;
}

// ── The allow table ──────────────────────────────────────────────────────────────────────────

const C = "/v1.0/my/applications/{id}";
const M = "/submission/v1/product/{id}";

/**
 * The approved write surface (S-15 §4.2, §11 A-18f). Everything not here is refused. Keep rules
 * exact: one method, one template, the narrowest body the flow needs.
 */
export const MSSTORE_WRITE_ALLOW: readonly MsStoreRule[] = [
  // ── Classic: the app submission ──
  {
    method: "POST",
    path: `${C}/submissions`,
    body: {},
    send: "none",
    confirm: "plain",
    why: "create the pending submission, a copy of the last published one (natural key: the app's pendingApplicationSubmission, reused only when the ledger created it)",
  },
  {
    method: "PUT",
    path: `${C}/submissions/{id}`,
    body: CLASSIC_SUBMISSION,
    send: "json",
    confirm: "plain",
    check: checkClassicSubmission,
    why: "update the pending submission: listings and images, category, visibility, publish mode, rollout settings; pricing only typed",
  },
  {
    method: "POST",
    path: `${C}/submissions/{id}/commit`,
    body: {},
    send: "none",
    confirm: "typed",
    why: "commit the submission to certification (submit for review: typed on every store)",
  },
  {
    method: "POST",
    path: `${C}/submissions/{id}/updatepackagerolloutpercentage`,
    body: { percentage: num(0, 100) },
    send: "query",
    confirm: "plain",
    why: "move a gradual rollout's percentage (finalize, which releases to everyone, is typed)",
  },
  {
    method: "POST",
    path: `${C}/submissions/{id}/haltpackagerollout`,
    body: {},
    send: "none",
    confirm: "plain",
    why: "halt a gradual rollout (the safe direction)",
  },
  {
    method: "POST",
    path: `${C}/submissions/{id}/finalizepackagerollout`,
    body: {},
    send: "none",
    confirm: "typed",
    why: "finalize a gradual rollout: release to every customer (typed)",
  },
  // ── Classic: package flights ──
  {
    method: "POST",
    path: `${C}/flights`,
    body: {
      friendlyName: str(50),
      groupIds: arr(str(32), 20),
      rankHigherThan: str(50),
    },
    send: "json",
    confirm: "plain",
    check: (b) =>
      ((b.groupIds as unknown[] | undefined) ?? []).every((g) =>
        /^[0-9]{1,30}$/.test(g as string),
      )
        ? null
        : "value_not_allowed",
    why: "create a package flight for existing flight groups (groups and their members stay in Partner Center)",
  },
  {
    method: "POST",
    path: `${C}/flights/{id}/submissions`,
    body: {},
    send: "none",
    confirm: "plain",
    why: "create a flight submission (a copy of the flight's last published one)",
  },
  {
    method: "PUT",
    path: `${C}/flights/{id}/submissions/{id}`,
    body: FLIGHT_SUBMISSION,
    send: "json",
    confirm: "plain",
    why: "update a flight submission's packages already uploaded, rollout settings and publish mode",
  },
  {
    method: "POST",
    path: `${C}/flights/{id}/submissions/{id}/commit`,
    body: {},
    send: "none",
    confirm: "typed",
    why: "commit a flight submission to certification (submit for review: typed)",
  },
  {
    method: "POST",
    path: `${C}/flights/{id}/submissions/{id}/updatepackagerolloutpercentage`,
    body: { percentage: num(0, 100) },
    send: "query",
    confirm: "plain",
    why: "move a flight's gradual rollout percentage",
  },
  {
    method: "POST",
    path: `${C}/flights/{id}/submissions/{id}/haltpackagerollout`,
    body: {},
    send: "none",
    confirm: "plain",
    why: "halt a flight's gradual rollout",
  },
  {
    method: "POST",
    path: `${C}/flights/{id}/submissions/{id}/finalizepackagerollout`,
    body: {},
    send: "none",
    confirm: "typed",
    why: "finalize a flight's gradual rollout (typed)",
  },
  // ── MSI/EXE ──
  {
    method: "PUT",
    path: `${M}/metadata`,
    body: MSI_METADATA,
    send: "json",
    confirm: "plain",
    check: checkMsiMetadata(true),
    why: "replace the draft's metadata modules (listing text, properties, category); availability only typed",
  },
  {
    method: "PATCH",
    path: `${M}/metadata`,
    body: MSI_METADATA,
    send: "json",
    confirm: "plain",
    check: checkMsiMetadata(false),
    why: "patch the draft's metadata modules; a pricing-model or trial change only typed",
  },
  {
    method: "PUT",
    path: `${M}/packages`,
    body: { packages: arr(obj(MSI_PACKAGE), 25) },
    send: "json",
    confirm: "plain",
    check: (b) => {
      for (const p of (b.packages as Record<string, unknown>[] | undefined) ??
        []) {
        const r = checkMsiPackage(p);
        if (r) return r;
      }
      return null;
    },
    why: "point the draft at the release's own installer URL (a URL, not an upload: S-15 §4.2)",
  },
  {
    method: "PATCH",
    path: `${M}/packages/{id}`,
    body: MSI_PACKAGE,
    send: "json",
    confirm: "plain",
    check: checkMsiPackage,
    why: "update one draft package's URL and installer settings",
  },
  {
    method: "POST",
    path: `${M}/packages/commit`,
    body: {},
    send: "none",
    confirm: "plain",
    why: "commit the draft's package configuration (not a submission)",
  },
  {
    method: "POST",
    path: `${M}/listings/assets/create`,
    body: {
      language: str(32),
      createAssetRequest: obj({ Screenshot: num(0, 10), Logo: num(0, 10) }),
    },
    send: "json",
    confirm: "plain",
    check: (b) =>
      LOCALE_RE.test(b.language as string) ? null : "value_not_allowed",
    why: "reserve SAS upload URLs for listing images (listing assets only: decision 2)",
  },
  {
    method: "PUT",
    path: `${M}/listings/assets/commit`,
    body: {
      listingAssets: obj({
        language: str(32),
        storeLogos: assetRefs,
        screenshots: assetRefs,
      }),
    },
    send: "json",
    confirm: "plain",
    check: checkAssetCommit,
    why: "commit a language's listing images: replacing the set is an update, not a deletion (S-15 §8.4), plain confirm",
  },
  {
    method: "POST",
    path: `${M}/submit`,
    body: {},
    send: "none",
    confirm: "typed",
    why: "submit the draft to certification (typed)",
  },
];

// ── The deny classification ──────────────────────────────────────────────────────────────────

/** Why each group is refused. */
export const MSSTORE_DENY_REASONS = {
  delete:
    "No DELETE, ever (owner rule): submissions, flights, flight submissions, add-ons and add-on submissions are removed by hand in Partner Center.",
  addOns:
    "Add-ons wait for a commerce extension: P6-01 has no Microsoft row (`dist_store_products` stores app-store, play and steam), so nothing here creates or submits one.",
} as const;

export type MsStoreDenyGroup = keyof typeof MSSTORE_DENY_REASONS;

/** `"<METHOD> <template>"` per group, as the operation list spells it. */
export const MSSTORE_WRITE_DENIED: Readonly<
  Record<MsStoreDenyGroup, readonly string[]>
> = {
  delete: [
    `DELETE ${C}/submissions/{id}`,
    `DELETE ${C}/flights/{id}`,
    `DELETE ${C}/flights/{id}/submissions/{id}`,
    "DELETE /v1.0/my/inappproducts/{id}",
    "DELETE /v1.0/my/inappproducts/{id}/submissions/{id}",
  ],
  addOns: [
    "POST /v1.0/my/inappproducts",
    "POST /v1.0/my/inappproducts/{id}/submissions",
    "PUT /v1.0/my/inappproducts/{id}/submissions/{id}",
    "POST /v1.0/my/inappproducts/{id}/submissions/{id}/commit",
  ],
};

// ── The rule set ─────────────────────────────────────────────────────────────────────────────

const SEG = PATH_SEGMENT.source.slice(1, -1);
/** Classic: the seller's apps and add-ons, at most six segments below. */
const CLASSIC_PATH = new RegExp(
  `^/v1\\.0/my/(?:applications|inappproducts)(?:/${SEG}){0,6}$`,
);
/** MSI/EXE: one product and at most four segments below it. */
const MSI_PATH = new RegExp(`^/submission/v1/product/${SEG}(?:/${SEG}){0,4}$`);

/** Whether a path is on one of the two APIs at all (the client picks the host from it). */
export function msStoreApiOf(path: string): "classic" | "msi" | null {
  if (CLASSIC_PATH.test(path)) return "classic";
  if (MSI_PATH.test(path)) return "msi";
  return null;
}

export const MICROSOFT_STORE_GATE: GateRuleSet<MsStoreRule> = {
  store: "microsoft-store",
  specPin: MSSTORE_SPEC_PIN,
  allow: MSSTORE_WRITE_ALLOW,
  denied: MSSTORE_WRITE_DENIED,
  denyReasons: MSSTORE_DENY_REASONS,
  validPath: (path) => msStoreApiOf(path) !== null,
  match: matchJson,
  deny: (method, target, reason) =>
    new MsStoreWriteDenied(method, target, reason),
};

export const MICROSOFT_STORE_COMPILED_GATE = compileGate(MICROSOFT_STORE_GATE);
