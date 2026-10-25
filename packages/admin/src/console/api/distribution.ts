/**
 * The distribution slice of the console API (P0-32.22): delivery access and rollouts, the matrix, outlets, keys, connectors, storefronts and the listing, App Store Distribute, outlet credentials.
 * Types and the `distributionApi` methods live together; `api.ts` re-exports the types and spreads the methods.
 */
import {
  DELIVERY_ACCESS_KEY,
  deliveryAccessOf,
  getSetting,
  writeSetting,
} from "./settings.js";
import { call, enc, p } from "./transport.js";
import type { ReleaseAccess, SettingsSource } from "./update.js";

/** A store credential's kind (P5-01; worker `core/outletCredentials.ts`). */
export type OutletCredentialKind =
  | "asc-api-key"
  | "asc-webhook-secret"
  | "google-service-account"
  | "ms-partner-center"
  | "sentry-integration"
  | "app-store-server-key"
  | "steam-publisher-key";

/** One outlet credential as the admin API lists it: metadata and health, never the value. */
export interface OutletCredentialInfo {
  id: string;
  kind: OutletCredentialKind | string;
  outletId: string | null;
  /** Non-secret display fields (key id, issuer id, client email, tenant id, …). */
  meta: Record<string, string>;
  status: string;
  createdAt: number;
  createdBy: string;
  rotatedAt: number | null;
  expiresAt: number | null;
  lastUsedAt: number | null;
  lastOkAt: number | null;
  lastError: string | null;
}

/** A kind's operator-owned pin (P5-02f): the `meta` field it is kept under and its label. */
export interface OutletCredentialPinSpec {
  field: string;
  label: string;
}

export interface OutletCredentialsResponse {
  ok: true;
  kinds: OutletCredentialKind[];
  /** Kind → its pin, for the kinds that carry one (an `asc-api-key`'s app id). */
  pins?: Record<string, OutletCredentialPinSpec>;
  credentials: OutletCredentialInfo[];
}

export interface PutOutletCredentialBody {
  kind: OutletCredentialKind;
  /** The kind's value object; a Google key may be its JSON file as a string. Omitted with `pin`
   *  alone, to re-pin a stored credential without its value. */
  value?: Record<string, unknown> | string;
  /** The operator's pin: the one store app the credential may be used for (P5-02f). */
  pin?: string;
  outletId?: string | null;
  expiresAt?: number | null;
  /** `asc-webhook-secret` only: the Worker generates the secret and never returns it. */
  generate?: boolean;
}

// ── distribution: delivery access + rollouts (P2b-04) ────────────────────────
/**
 * Who may download a deliverable (worker `services/distribution/access.ts`): the ONE answer the
 * downloads, the appcast and the portal read. The `app` row is manifest-owned until an operator
 * saves it; a pack with no row inherits the app's.
 */
export interface DeliveryAccess {
  /** The row version this view read: a write names it as `expectedVersion`. */
  version: number;
  modes: ReleaseAccess[];
  app: { deliverableId: string; mode: ReleaseAccess; source: SettingsSource };
  deliverables: Array<{
    deliverableId: string;
    mode: ReleaseAccess;
    entitlement: string | null;
    source: SettingsSource;
    modifiedAt: number;
  }>;
}

export type RolloutState = "active" | "paused" | "halted" | "complete";

/** One outlet rollout (worker `core/hooks.ts` `RolloutRecord`). */
export interface Rollout {
  deliverableId: string;
  outletId: string;
  channel: string;
  releaseId: string;
  /** Basis points, 0–10000. */
  rolloutBp: number;
  state: RolloutState;
  /** A store connector owns it; direct edits are refused. */
  mirrored: boolean;
  source: string;
  startedAt: number;
  updatedAt: number;
  updatedBy: string;
}

export interface RolloutsResponse {
  rollouts: Rollout[];
}

// ── distribution: the matrix (P2b-06) ────────────────────────────────────────
export type RolloutVerb = "pause" | "resume" | "halt" | "complete";

/** One availability record (worker `core/hooks.ts` `AvailabilityRecord`). */
export interface AvailabilityRecordDto {
  releaseId: string;
  /** `''` = the whole release. */
  buildId: string;
  outletId: string;
  transport: string;
  state: string;
  since: number | null;
  source: string;
  /** No report: a self-hosted outlet is live wherever our bytes are. */
  derived: boolean;
  updatedAt: number | null;
}

/** One submission record (worker `core/hooks.ts` `SubmissionRecord`). */
export interface SubmissionRecordDto {
  releaseId: string;
  outletId: string;
  state: string;
  submittedAt: number | null;
  reviewedAt: number | null;
  source: string;
  updatedAt: number;
}

export interface MatrixRolloutDto extends Rollout {
  /** The verbs the state allows; empty for a mirrored rollout. */
  controls: RolloutVerb[];
}

export interface MatrixCellDto {
  releaseId: string;
  outletId: string;
  /** The best state among the records, or `null`. */
  availability: string | null;
  records: AvailabilityRecordDto[];
  submission: SubmissionRecordDto | null;
  rollouts: MatrixRolloutDto[];
  /**
   * P4-14: the app release's readiness on this outlet (worker `distribution/readiness.ts`
   * `OutletReadiness`, abridged); null for a pack's cells and a product without packs. Absent from
   * a worker that predates P4-14.
   */
  readiness?: MatrixReadinessDto | null;
}

/** The fields of `OutletReadiness` the console renders. */
export interface MatrixReadinessDto {
  /** `pending`, `blocked`, `ready` or `overridden` (an operator released the hold). */
  state: string;
  /** The computed state, whatever the override (absent from an older worker). */
  computed?: string;
  holds: boolean;
  holdable: boolean;
  warning: string | null;
  blockers: {
    pack: string;
    /** The pack release that blocks, when one exists (`null` for `unsatisfied`). */
    packReleaseId?: string | null;
    version: string | null;
    reason: string;
    detail: string;
  }[];
  pendingReason: string | null;
  /** Packs the CDN serves in place of Background Assets (P4-33.2); absent from an older worker. */
  notes?: { pack: string; note: string }[];
  /** The operator's override, when one is in force. */
  override?: { by: string; at: number; reason: string | null } | null;
}

/** `GET …/distribution/matrix` (worker `services/distribution/matrix.ts`). */
export interface DistributionMatrix {
  deliverableId: string;
  limit: number;
  outlets: Array<{
    outletId: string;
    kind: string;
    transport: string;
    derives: boolean;
    /** Whether Polaris Key acts on the transport (delivers it, P4-05, or tracks a store transport through reports, P5-08); an unsupported one is stored only. */
    supported: boolean;
  }>;
  releases: Array<{
    releaseId: string;
    version: string;
    channel: string | null;
    publishedAt: number | null;
    yanked: boolean;
  }>;
  cells: MatrixCellDto[];
  states: { availability: string[]; submission: string[]; rollout: string[] };
}

// ── distribution: outlets, keys, readiness and connectors (admin chunk 9) ─────
/** The capability keys an outlet carries (worker `services/distribution/capabilities.ts`). */
export type CapabilityKey =
  | "binaryUpdates"
  | "codeUpdates"
  | "dataUpdates"
  | "channelSwitch"
  | "commerce"
  | "downloadedScripts";

/** What an outlet permits: `binaryUpdates` self > store > none; `commerce` own, store-iap or none. */
export interface OutletCapabilitiesDto {
  binaryUpdates: string;
  codeUpdates: boolean;
  dataUpdates: boolean;
  channelSwitch: boolean;
  commerce: string;
  downloadedScripts: boolean;
}

/** One outlet as the admin API lists it (worker `distribution/admin.ts` `outletView`). */
export interface OutletDto {
  outletId: string;
  kind: string;
  identity: Record<string, unknown>;
  listing: unknown;
  /** The capabilities in force; `null` for a kind this build has no defaults for. */
  capabilities: OutletCapabilitiesDto | null;
  defaultCapabilities: OutletCapabilitiesDto | null;
  /** `manifest`, or `admin` once an operator narrowed it. */
  capabilitiesSource: string;
  capabilityOverride: Partial<OutletCapabilitiesDto> | null;
  transports: Array<{
    deliverableId: string;
    transport: string;
    supported: boolean;
  }>;
  removedAt: number | null;
  createdAt: number;
  modifiedAt: number;
}

export interface OutletsResponse {
  capabilityKeys: CapabilityKey[];
  outlets: OutletDto[];
}

/** One distribution signing-key inventory entry (worker `availability.ts` `keyRecord`). */
export interface DistributionKeyDto {
  purpose: string;
  sha256: string;
  outletId: string | null;
  notes: string | null;
  registered: boolean;
  registeredAt: number | null;
  observed: Record<string, unknown> | null;
  /** CI observed a key of this purpose that matches no entry. */
  flagged: boolean;
}

/** A key CI observed that matches no inventory entry. */
export interface DistributionKeyObservationDto {
  purpose: string;
  sha256: string;
  outletId: string | null;
  observed: Record<string, unknown> | null;
  firstSeenAt: number;
}

export interface DistributionKeysResponse {
  purposes: string[];
  keys: DistributionKeyDto[];
  observations: DistributionKeyObservationDto[];
}

export interface PutDistributionKeyBody {
  purpose: string;
  sha256: string;
  outlet?: string | null;
  notes?: string | null;
  registered?: boolean;
}

/** A store connector's status (worker `distribution/connectors/*` `status`). */
export interface ConnectorStatusDto {
  /** `asc`, `play` or `ms-store`. */
  kind: string;
  label: string;
  outletKinds: string[];
  configured: boolean;
  /** Why it does not run, when it does not. */
  inert?: { reason: string; message: string } | null;
  setup?: Record<string, unknown> | null;
  /** The control paths it answers (`phased-release/pause`, `rollout/fraction`, …). */
  controls: string[];
  notes?: string[];
  /** Google Play: the operator's settings. */
  settings?: {
    priority?: { default?: number };
    vitals?: Record<string, unknown>;
  };
  /**
   * Where its key comes from, `product` or `platform` (A-16). The App Store Connect connector
   * reports it inside `setup` (with `platformSource`); this top-level field is the fallback.
   */
  credentialSource?: string;
}

// ── distribution: storefronts and the listing (A-18j; worker `services/distribution/storefronts/`) ──

/** How an adapter performs one operation (`core/adapters/contract.ts` `Support`), as declared. */
export type SupportDto =
  | { mode: "api"; plane: "worker"; rules: string[] }
  | { mode: "ci"; plane: "ci"; tool: string; commands: string[] }
  | { mode: "pr"; plane: "pr"; repo: string }
  | {
      mode: "deep-link";
      link: string;
      verify:
        | { read: string; every: number; until: number }
        | "operator-assertion";
    }
  | { mode: "unsupported"; reason: string }
  /** PS-01: run on Polaris Key's own tables (the built-in storefront); shown as "Built in". */
  | { mode: "first-party"; plane: "worker"; handler: string };

export type StorefrontStepState =
  | "todo"
  | "pending"
  | "done"
  | "failed"
  | "ambiguous";

/** One input a step's request asks for. */
export interface StorefrontStepField {
  name: string;
  label: string;
  help?: string;
  value: string;
  required: boolean;
  options?: { value: string; label: string }[];
  maxLength?: number;
}

/** A console request a step names: an admin route, its body, its fields and its confirmation. */
export interface StorefrontStepRequest {
  method: "POST" | "PUT";
  path: string;
  body: Record<string, unknown>;
  fields: StorefrontStepField[];
  confirm: "plain" | "typed";
  verb: string;
  consequences: string[];
}

export interface StorefrontStepDto {
  id: string;
  ops: string[];
  phase: "setup" | "listing" | "assets" | "store" | "submit";
  label: string;
  mode: SupportDto["mode"];
  typed: boolean;
  state: StorefrontStepState;
  stateAt: number | null;
  writes: string[];
  link: {
    url: string | null;
    verify: "read" | "operator-assertion";
    every: number | null;
    until: number | null;
    missing: string[];
  } | null;
  ci: { tool: string; commands: string[] } | null;
  pr: { repo: string } | null;
  run: StorefrontStepRequest | null;
  assert: StorefrontStepRequest | null;
  next: StorefrontStepRequest | null;
  handoff: { page: string; label: string } | null;
  copy: { label: string; value: string }[];
  detail: string | null;
  blockedBy: string | null;
}

export interface StorefrontDto {
  id: string;
  label: string;
  /**
   * A built-in store (PS-06): it runs on Polaris Key's own tables, so it has nothing to connect
   * and no flow; its tile opens the store's own panel. Optional for older Workers.
   */
  builtIn?: boolean;
  listingStore: string | null;
  connection: {
    state: "connected" | "not-configured" | "keyless";
    credential: string | null;
    credentialLabel: string | null;
    source: "console" | "secret" | null;
    lastError: string | null;
  };
  app: { id: string; name: string | null } | null;
  outlets: string[];
  readOnly: string | null;
  capabilities: { op: string; label: string; support: SupportDto }[];
  prerequisites: {
    id: string;
    label: string;
    state: "met" | "unmet" | "unknown";
    detail: string;
    page: string | null;
  }[];
  steps: StorefrontStepDto[];
  pushListing: { stageOnly: boolean } | null;
  confirmationLabel: string;
  /** Identifiers the flow shows; a value the manifest leaves empty is filled from the assignment. */
  identifiers?: Record<
    string,
    { value: string; source: "manifest" | "assigned" }
  >;
}

/** `GET …/distribution/storefronts`. */
export interface StorefrontsResponse {
  stores: StorefrontDto[];
  listing: {
    name: string | null;
    defaultLocale: string;
    locales: string[];
  } | null;
}

/** A step's or a push's outcome: the vendor's re-read, never the request. */
export interface StorefrontRunResult {
  ok: true;
  outcome: "written" | "existing" | "replayed";
  opId: string;
  resultIds: Record<string, string>;
  after: unknown;
  /** What the operator still finishes in the store's own console (decision 6: the older Play
   *  images a replaced set leaves, which Polaris Key never deletes). */
  followUp?: StorefrontFollowUp;
}

/** A run's follow-up: one sentence with the count, and the store page (or what its link lacks). */
export interface StorefrontFollowUp {
  count: number;
  text: string;
  url: string | null;
  missing: string[];
}

/** `POST …/steps/<op>/check`. */
export interface StorefrontCheckResult {
  ok: true;
  state: StorefrontStepState;
  satisfied: boolean;
  resultIds?: Record<string, string>;
  detail?: string | null;
}

export interface ListingSlotDto {
  slot: string;
  locale: string | null;
  group: string;
  kind: "human" | "derived" | "composed";
  state: "missing" | "review" | "accepted";
  spec: string | null;
  textAllowed: string;
  asset: {
    sha256: string;
    width: number | null;
    height: number | null;
    alpha: boolean;
    derivedFrom: string | null;
    source: string;
    modifiedAt: number;
    image: string;
    acceptedAt: number | null;
    acceptedBy: string | null;
  } | null;
}

export interface ListingLocaleDto {
  locale: string;
  name?: string;
  subtitle?: string;
  shortDescription?: string;
  description?: string;
  keywords?: string[];
  features?: string[];
  promotionalText?: string;
  source: string;
  provenance: Record<string, string>;
  modifiedAt: number;
  modifiedBy: string;
}

/** `GET …/distribution/listing` (A-18b). */
export interface ListingResponse {
  listing: {
    app: {
      defaultLocale: string;
      name?: string;
      developerName?: string;
      category?: string;
      contactEmail?: string;
      copyright?: string;
      urls?: Record<string, string>;
    };
    source: string;
    provenance: Record<string, string>;
    modifiedAt: number;
    modifiedBy: string;
  } | null;
  locales: ListingLocaleDto[];
  /** Fields a projection fills from the product (A-27.9): the name, accents and icon. */
  inherited?: Partial<
    Record<"name" | "tint" | "tintDark" | "icon-master", "presentation">
  >;
  overrides: {
    store: string;
    locale: string | null;
    field: string;
    value: string | string[];
  }[];
  limits: Record<string, number | { maxItems: number; maxItemChars: number }>;
  stores: { store: string; label: string }[];
  overrideStores: string[];
  modelFields: string[];
}

export interface ListingFitIssue {
  store: string;
  field: string;
  from: string;
  locale: string | null;
  issue: string;
  severity: "warn" | "block";
  limit: number | null;
  actual: number | null;
  unit: string | null;
  proposal?: string;
}

/** `GET …/distribution/listing/fit`. */
export interface ListingFitResponse {
  exists: boolean;
  release: string | null;
  stores: {
    store: string;
    label: string;
    status: "green" | "amber" | "red";
    issues: ListingFitIssue[];
    cells: {
      field: string;
      from: string;
      locale: string | null;
      plane: "api" | "copy" | "manual";
      status: "green" | "amber" | "red";
      present: boolean;
    }[];
  }[];
}

/** One field of an import's diff (A-18c `ImportChange`). */
export interface ListingImportChange {
  /** `name`, `urls.website`, `locales.de-DE.description`. */
  field: string;
  locale: string | null;
  action: "add" | "replace" | "keep";
  current: string | string[] | Record<string, unknown> | null;
  currentSource: string | null;
  proposed: string | string[] | Record<string, unknown>;
  proposedSource: string;
  reason: string | null;
}

/** The import's preview (or, with `confirm`, what it applied). */
export interface ListingImportPreview {
  applied: boolean;
  digest: string;
  createsListing: boolean;
  defaultLocale: string;
  sources: {
    source: string;
    ref: string | null;
    ok: boolean;
    reason?: string;
    message?: string;
  }[];
  changes: ListingImportChange[];
  refused: { field: string; message?: string; [key: string]: unknown }[];
  skipped: { source: string; field: string; reason: string }[];
  written: string[];
}

/** `POST …/distribution/listing/import`: the preview (or result) and the model after it. */
export type ListingImportResponse = ListingResponse & {
  import: ListingImportPreview;
};

/** `GET …/distribution/listing/release-notes/<release>`. */
export interface ListingReleaseNotesResponse {
  notes: {
    releaseId: string;
    version: string;
    locales: {
      locale: string;
      text: string;
      short: string | null;
      /** `default` for the release record's own notes, shown until saved. */
      source: string;
      proposedShort: string | null;
      modifiedAt: number | null;
      modifiedBy: string | null;
    }[];
  };
  limits: { short: number; text: number };
}

export interface ConnectorsResponse {
  connectors: ConnectorStatusDto[];
}

// ── distribution: App Store Distribute and in-app purchases (A-17d, A-17e; console A-17g) ──
// Reads under `GET …/distribution/connectors/asc/<path>` (worker `connectors/asc/distribute.ts`,
// `commerce/appleCatalog.ts`). Every Apple field is passed through as Apple states it.

/** A note on a build upload (`{ code, description }`, Apple's text bounded by the Worker). */
export interface AscUploadNote {
  code: string;
  description: string;
}

/** One unexpired build of the pinned app (`distribute/builds`). */
export interface AscBuildDto {
  id: string;
  buildNumber: string | null;
  version: string | null;
  platform: string | null;
  /** `PROCESSING`, `FAILED`, `INVALID` or `VALID`. */
  processingState: string | null;
  usesNonExemptEncryption: boolean | null;
  exportComplianceNeeded: boolean;
  uploadedDate: string | null;
  expirationDate: string | null;
  internalBuildState: string | null;
  externalBuildState: string | null;
  upload: {
    id: string;
    state: string | null;
    warnings: AscUploadNote[];
    errors: AscUploadNote[];
    uploadedDate: string | null;
  } | null;
  /** The Polaris Key release the connector linked the build to, when it did. */
  releaseId: string | null;
}

export interface AscBuildsResponse {
  ok: true;
  appleId: string;
  builds: AscBuildDto[];
}

export interface AscBetaGroupDto {
  id: string;
  name: string | null;
  isInternalGroup: boolean;
  hasAccessToAllBuilds: boolean;
  publicLinkEnabled: boolean;
}

export interface AscBetaGroupsResponse {
  ok: true;
  betaGroups: AscBetaGroupDto[];
}

/** One App Store version (`distribute/versions`). */
export interface AscVersionDto {
  id: string;
  platform: string | null;
  versionString: string | null;
  state: string | null;
  appStoreState: string | null;
  releaseType: string | null;
  earliestReleaseDate: string | null;
  /** Metadata, build and release type can still change. */
  editable: boolean;
  buildId: string | null;
  phasedReleaseId: string | null;
  phasedReleaseState: string | null;
}

/** A review submission that is open or with Apple. */
export interface AscSubmissionDto {
  id: string;
  platform: string | null;
  state: string | null;
  submittedDate: string | null;
  cancelable: boolean;
}

export interface AscVersionsResponse {
  ok: true;
  versions: AscVersionDto[];
  submissions: AscSubmissionDto[];
}

/** One preflight line; `ok: null` is a portal step the API cannot see. */
export interface AscPreflightCheck {
  id: string;
  ok: boolean | null;
  detail?: string;
  missing?: string[];
}

export interface AscPreflightResponse {
  ok: true;
  versionId: string;
  state: string | null;
  ready: boolean;
  checks: AscPreflightCheck[];
}

/** What can ride the next review submission (`distribute/submission-items`). */
export interface AscSubmissionItemsResponse {
  ok: true;
  platform: string;
  firstInAppPurchase: boolean;
  firstInAppPurchaseNote?: string;
  inAppPurchaseVersions: {
    inAppPurchaseVersionId: string;
    productId: string;
    iapId: string;
    name: string | null;
    state: string | null;
    versionState: string | null;
  }[];
  backgroundAssetVersions: {
    backgroundAssetVersionId: string;
    assetPackIdentifier: string | null;
    version: string | null;
    appStoreReleaseState: string | null;
  }[];
}

/** One `app-store` commerce mapping beside Apple's state (`iap/products`). */
export interface AscIapProductDto {
  storeProductId: string;
  flag: string;
  deliverableId: string;
  /** `missing`, or Apple's state (`MISSING_METADATA`, `READY_TO_SUBMIT`, `APPROVED`, …). */
  status: string;
  typeMismatch: boolean;
  iap: {
    id: string;
    name: string | null;
    inAppPurchaseType: string | null;
    state: string | null;
    familySharable: boolean;
  } | null;
}

export interface AscIapProductsResponse {
  ok: true;
  appleId: string;
  firstInAppPurchase: boolean;
  firstInAppPurchaseNote?: string;
  priceChangeWarning: string;
  products: AscIapProductDto[];
}

export interface AscPricePointDto {
  id: string;
  customerPrice: string | null;
  proceeds: string | null;
}

export interface AscPricePointsResponse {
  ok: true;
  productId: string;
  iapId: string;
  territory: string;
  current: {
    baseTerritory: string | null;
    pricePointId: string | null;
    customerPrice: string | null;
  } | null;
  /** A change of an existing price: typed. */
  priceChange: boolean;
  priceChangeWarning: string;
  pricePoints: AscPricePointDto[];
}

/** A readiness refresh: how many rows it recomputed. */
export interface ReadinessRefreshResult {
  refreshed: number;
}

export const distributionApi = {
  // ── outlet credentials (P5-01): platform admin, write-only ──────────────────
  outletCredentials: (slug: string) =>
    call<OutletCredentialsResponse>(`${p(slug)}/outlet-credentials`),
  /** Write-only: the response echoes the id, never the value or its metadata. */
  putOutletCredential: (
    slug: string,
    id: string,
    body: PutOutletCredentialBody,
  ) =>
    call<{ ok: true; id: string }>(`${p(slug)}/outlet-credentials/${enc(id)}`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  deleteOutletCredential: (slug: string, id: string) =>
    call<{ ok: true; id: string }>(`${p(slug)}/outlet-credentials/${enc(id)}`, {
      method: "DELETE",
    }),
  // ── distribution: delivery access + rollouts (P2b-04; the setting `distribution.access`) ──
  deliveryAccess: async (slug: string): Promise<DeliveryAccess> =>
    deliveryAccessOf(await getSetting(slug, DELIVERY_ACCESS_KEY)),
  saveDeliveryAccess: async (
    slug: string,
    body: {
      mode: ReleaseAccess;
      deliverable?: string;
      /** A pack's delivery gate, for `entitled`: the catalog flag a license must grant (`null` clears it). */
      entitlement?: string | null;
    },
    /** The `DeliveryAccess.version` the page loaded. */
    expectedVersion: number,
  ): Promise<DeliveryAccess> => {
    return deliveryAccessOf(
      (
        await writeSetting(slug, DELIVERY_ACCESS_KEY, "PATCH", {
          value: {
            [body.deliverable ?? "app"]: {
              mode: body.mode,
              ...(body.entitlement !== undefined
                ? { entitlement: body.entitlement }
                : {}),
            },
          },
          expectedVersion,
        })
      ).setting,
    );
  },
  /** Hand the app's delivery access back to the manifest; it re-applies on the next resync. */
  revertDeliveryAccess: async (
    slug: string,
    expectedVersion: number,
  ): Promise<DeliveryAccess> => {
    return deliveryAccessOf(
      (
        await writeSetting(slug, DELIVERY_ACCESS_KEY, "DELETE", {
          expectedVersion,
        })
      ).setting,
    );
  },
  rollouts: (slug: string) =>
    call<RolloutsResponse>(`${p(slug)}/distribution/rollouts`),
  /** The release × outlet matrix (P2b-06). */
  distributionMatrix: (
    slug: string,
    opts: { deliverable?: string; limit?: number } = {},
  ) => {
    const q = new URLSearchParams();
    if (opts.deliverable) q.set("deliverable", opts.deliverable);
    if (opts.limit !== undefined) q.set("limit", String(opts.limit));
    const qs = q.toString();
    return call<DistributionMatrix>(
      `${p(slug)}/distribution/matrix${qs ? `?${qs}` : ""}`,
    );
  },
  /** A rollout verb on one outlet's channel (P2b-04's admin route). `releaseId` guards against
   *  acting on a rollout that moved to another release since the matrix was read. */
  rolloutAction: (
    slug: string,
    outlet: string,
    channel: string,
    verb: RolloutVerb,
    body: { deliverable: string; releaseId: string },
  ) =>
    call<{ rollout: Rollout }>(
      `${p(slug)}/distribution/rollouts/${encodeURIComponent(outlet)}/${encodeURIComponent(channel)}/${verb}`,
      { method: "POST", body: JSON.stringify(body) },
    ),
  /** Start a rollout, or set its percentage (`bp`, 0–10 000) — the admin rollout route. */
  setRollout: (
    slug: string,
    outlet: string,
    channel: string,
    body: { deliverable: string; releaseId: string; bp: number },
  ) =>
    call<{ rollout: Rollout }>(
      `${p(slug)}/distribution/rollouts/${encodeURIComponent(outlet)}/${encodeURIComponent(channel)}`,
      { method: "POST", body: JSON.stringify(body) },
    ),
  // ── distribution: readiness (P4-14) ─────────────────────────────────────────
  /** Recompute every app release's readiness on every outlet. */
  refreshReadiness: (slug: string) =>
    call<ReadinessRefreshResult>(`${p(slug)}/distribution/readiness/refresh`, {
      method: "POST",
      body: JSON.stringify({}),
    }),
  /** Release a readiness hold on one outlet, with the reason (audited). */
  overrideReadiness: (
    slug: string,
    appReleaseId: string,
    outletId: string,
    reason: string,
  ) =>
    call<{ appReleaseId: string; readiness: MatrixReadinessDto | null }>(
      `${p(slug)}/distribution/readiness/${enc(appReleaseId)}/${enc(outletId)}/override`,
      { method: "POST", body: JSON.stringify({ reason }) },
    ),
  /** Clear an override: the hold is computed again. */
  clearReadinessOverride: (
    slug: string,
    appReleaseId: string,
    outletId: string,
  ) =>
    call<{ appReleaseId: string; readiness: MatrixReadinessDto | null }>(
      `${p(slug)}/distribution/readiness/${enc(appReleaseId)}/${enc(outletId)}/clear`,
      { method: "POST", body: JSON.stringify({}) },
    ),
  // ── distribution: outlets and capabilities (P2b-02) ─────────────────────────
  distributionOutlets: (slug: string) =>
    call<OutletsResponse>(`${p(slug)}/distribution/outlets`),
  /** Narrow an outlet's capabilities below its kind's default (never wider). */
  narrowOutletCapabilities: (
    slug: string,
    outletId: string,
    capabilities: Partial<OutletCapabilitiesDto>,
  ) =>
    call<{ outlet: OutletDto }>(
      `${p(slug)}/distribution/outlets/${enc(outletId)}/capabilities`,
      { method: "PUT", body: JSON.stringify({ capabilities }) },
    ),
  /** Return an outlet's capabilities to its kind's default. */
  revertOutletCapabilities: (slug: string, outletId: string) =>
    call<{ outlet: OutletDto }>(
      `${p(slug)}/distribution/outlets/${enc(outletId)}/capabilities/revert`,
      { method: "POST", body: JSON.stringify({}) },
    ),
  // ── distribution: the signing-key inventory (P2b-03) ────────────────────────
  distributionKeys: (slug: string) =>
    call<DistributionKeysResponse>(`${p(slug)}/distribution/keys`),
  putDistributionKey: (slug: string, body: PutDistributionKeyBody) =>
    call<DistributionKeysResponse & { key: DistributionKeyDto }>(
      `${p(slug)}/distribution/keys`,
      { method: "PUT", body: JSON.stringify(body) },
    ),
  /** Remove an inventory entry, or dismiss a CI observation. */
  deleteDistributionKey: (slug: string, purpose: string, sha256: string) =>
    call<DistributionKeysResponse>(
      `${p(slug)}/distribution/keys/${enc(purpose)}/${enc(sha256)}`,
      { method: "DELETE" },
    ),
  // ── distribution: storefronts and the listing (A-18j) ─────────────────────
  storefronts: (slug: string) =>
    call<StorefrontsResponse>(`${p(slug)}/distribution/storefronts`),
  storefrontSlots: (slug: string) =>
    call<{ slots: ListingSlotDto[] }>(
      `${p(slug)}/distribution/storefronts/slots`,
    ),
  /** Accept exactly the bytes shown (`sha256`); 409 `asset_changed` when they moved since. */
  acceptListingAsset: (
    slug: string,
    body: { slot: string; locale: string | null; sha256: string },
  ) =>
    call<{ ok: true; accepted: boolean }>(
      `${p(slug)}/distribution/storefronts/slots/accept`,
      { method: "POST", body: JSON.stringify(body) },
    ),
  /**
   * A flow step's request, as the server's plan names it (`run`, `assert`, `next`): an absolute
   * console path under `/manage/api/`, or one relative to the product's API. One
   * `Idempotency-Key` per operator intent.
   */
  storefrontRequest: (
    slug: string,
    path: string,
    method: string,
    body: Record<string, unknown>,
    opts?: { idempotencyKey?: string } | null,
  ) => {
    const absolute = path.startsWith("/");
    if (absolute && (!path.startsWith("/manage/api/") || path.includes("..")))
      throw new Error(`a flow step may only call the console API: ${path}`);
    return call<Record<string, unknown>>(
      absolute ? path : `${p(slug)}/${path.split("/").map(enc).join("/")}`,
      {
        method: method === "PUT" ? "PUT" : "POST",
        body: JSON.stringify(body ?? {}),
        ...(opts?.idempotencyKey
          ? { headers: { "Idempotency-Key": opts.idempotencyKey } }
          : {}),
      },
    );
  },
  /** A deep-linked step: `{}` runs its verifier read, `{assert: true}` records it done. */
  storefrontCheck: (
    slug: string,
    store: string,
    op: string,
    body: { assert?: boolean; poll?: boolean },
  ) =>
    call<StorefrontCheckResult>(
      `${p(slug)}/distribution/storefronts/${enc(store)}/steps/${enc(op)}/check`,
      { method: "POST", body: JSON.stringify(body ?? {}) },
    ),
  /** "Push listing" (text and accepted images; plain confirm; always staged where the store stages, never sent for review). */
  pushListing: (
    slug: string,
    store: string,
    body: { stageOnly?: boolean },
    opts?: { idempotencyKey?: string } | null,
  ) =>
    call<StorefrontRunResult>(
      `${p(slug)}/distribution/storefronts/${enc(store)}/push-listing`,
      {
        method: "POST",
        body: JSON.stringify(body ?? {}),
        ...(opts?.idempotencyKey
          ? { headers: { "Idempotency-Key": opts.idempotencyKey } }
          : {}),
      },
    ),
  listing: (slug: string) =>
    call<ListingResponse>(`${p(slug)}/distribution/listing`),
  putListing: (slug: string, body: Record<string, unknown>) =>
    call<ListingResponse>(`${p(slug)}/distribution/listing`, {
      method: "PUT",
      body: JSON.stringify(body ?? {}),
    }),
  putListingOverride: (
    slug: string,
    body: {
      store: string;
      locale?: string | null;
      field: string;
      value: string | string[] | null;
    },
  ) =>
    call<Record<string, unknown>>(`${p(slug)}/distribution/listing/overrides`, {
      method: "PUT",
      body: JSON.stringify(body ?? {}),
    }),
  listingFit: (slug: string, release?: string | null) =>
    call<ListingFitResponse>(
      `${p(slug)}/distribution/listing/fit${release ? `?release=${enc(release)}` : ""}`,
    ),
  /** Without `confirm`: the field-by-field diff (nothing is written). With the diff's `digest`: apply it. */
  listingImport: (slug: string, body: Record<string, unknown>) =>
    call<ListingImportResponse>(`${p(slug)}/distribution/listing/import`, {
      method: "POST",
      body: JSON.stringify(body ?? {}),
    }),
  listingReleaseNotes: (slug: string, release: string) =>
    call<ListingReleaseNotesResponse>(
      `${p(slug)}/distribution/listing/release-notes/${enc(release)}`,
    ),
  putListingReleaseNotes: (
    slug: string,
    release: string,
    body: { locale: string; text: string | null; short?: string | null },
  ) =>
    call<Record<string, unknown>>(
      `${p(slug)}/distribution/listing/release-notes/${enc(release)}`,
      { method: "PUT", body: JSON.stringify(body ?? {}) },
    ),
  // ── distribution: store connectors (P5-02 to P5-04) ─────────────────────────
  connectors: (slug: string) =>
    call<ConnectorsResponse>(`${p(slug)}/distribution/connectors`),
  /**
   * One connector control (`phased-release/pause`, `rollout/fraction`, `settings`, …). The App
   * Store Connect flows (A-17c to A-17e) also take `idempotencyKey`, one per operator intent: the
   * Worker's ledger answers a retry under the same key from what it already did.
   */
  connectorControl: (
    slug: string,
    connector: string,
    control: string,
    body: Record<string, unknown>,
    opts?: { idempotencyKey?: string } | null,
  ) =>
    call<Record<string, unknown> & { ok: true }>(
      `${p(slug)}/distribution/connectors/${enc(connector)}/${control
        .split("/")
        .map(enc)
        .join("/")}`,
      {
        method: "POST",
        body: JSON.stringify(body),
        ...(opts?.idempotencyKey
          ? { headers: { "Idempotency-Key": opts.idempotencyKey } }
          : {}),
      },
    ),
  /** One connector read (`distribute/builds`, `iap/products`, …; A-17d, A-17e). */
  connectorRead: <T>(
    slug: string,
    connector: string,
    path: string,
    query?: Record<string, string> | null,
  ) => {
    const qs = new URLSearchParams(query ?? {}).toString();
    return call<T>(
      `${p(slug)}/distribution/connectors/${enc(connector)}/${path
        .split("/")
        .map(enc)
        .join("/")}${qs ? `?${qs}` : ""}`,
    );
  },
};
