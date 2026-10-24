/**
 * The core slice of the console API (P0-32.21): users, keys and secrets, CI publishing, hosted assets, services, commerce, integration and the Polaris Key storefront.
 * Types and the `coreApi` methods live together; `api.ts` re-exports the types and spreads the methods.
 */
import type { ServiceSlug } from "../../services.generated.js";
import type { LicenseHolderMoveKind } from "./license.js";
import type { SettingConfirmSpec, SettingValueSpec } from "./settings.js";
import type {
  ManagedEntry,
  ManagedSecretView,
  OverrideUpdate,
} from "./config.js";
import type { SecretUsage } from "./platform.js";
import { call, enc, p } from "./transport.js";

/** A product's hosted icon on the image host (worker `console/lib/presentation.ts`). */
export interface ProductIconRef {
  /** The original, content-addressed. */
  url: string;
  /** The 64 px WebP variant, or `null` when the ladder has none. */
  w64: string | null;
  /** The 128 px WebP variant, or `null`. */
  w128: string | null;
}

/** What the console draws for a product's identity (`ProductLogo`). */
export interface ProductPresentation {
  /** The hosted icon, or `null` when there is no copy the image host serves. */
  icon: ProductIconRef | null;
  /** The hosted header art (`listing.header`): the cover on Home's cards. List rows only. */
  header?: ProductIconRef | null;
  /** HA-12: `presentation.accent` (`#rrggbb`). Not served yet, so always absent today. */
  accent?: string | null;
  /** HA-12: the accent on a dark ground. */
  accentDark?: string | null;
}

/**
 * One hosted-asset slot as the Presentation page reads it (HA-05, HA-06; worker
 * `console/handlers/hostedAssets.ts`, `HostedAssetDto`).
 */
export interface HostedAssetDto {
  slot: string;
  /** `''` is every locale. */
  locale: string;
  /** Who filled the slot: `manifest`, `console` (an upload: it claims the slot), `ci`, `release-mirror`. */
  origin: string;
  /** Where the original is: `url`, `repo`, `upload`, `ci`, `github-asset`. */
  sourceKind: string;
  /** The URL or `<path>@<commit>`; `null` for an upload or a CI push. */
  sourceRef: string | null;
  /** `pending` (nothing served yet), `ready`, `failed` or `stale` (the last good copy kept). */
  status: string;
  /** The last failure's reason code. */
  error: string | null;
  sha256: string | null;
  size: number | null;
  contentType: string | null;
  width: number | null;
  height: number | null;
  checkedAt: number | null;
  modifiedAt: number;
  /** What the manifest declares for the slot now, or `null`. */
  wanted: { kind: "url" | "repo"; src: string; sha256?: string } | null;
  /** The manifest wants a ref the stored copy was not pulled for (a pull is owed). */
  pullPending: boolean;
  attempts: number;
  nextAttemptAt: number | null;
  /** A ready copy still owes its WebP sizes (retried while the Images binding is bound). */
  sizesPending: boolean;
  /** The size ladder's widths. */
  widths: number[];
  /** The original on the image host, when it serves it. */
  url: string | null;
  /** A ~256 px variant, else the original. */
  previewUrl: string | null;
  /** The console may upload to and delete this slot. */
  uploadable: boolean;
  /** The slot's byte cap. */
  maxBytes: number | null;
}

/**
 * One of a product's hosted-asset settings (HA-10; worker `console/handlers/hostedAssets.ts`,
 * `AssetSettingDto`): `assets.releases.mirror`, `assets.quota.mediaBytes`,
 * `assets.quota.releaseBytes`.
 */
export interface AssetSettingDto {
  key: string;
  label: string;
  description: string;
  spec: SettingValueSpec;
  confirm: SettingConfirmSpec;
  /** The value in force. */
  value: unknown;
  /** `console`: the product's own value; `platform` or `default`: inherited. */
  source: string;
  /** What the product follows without a value of its own (what Reset leaves). */
  inherited: unknown;
  /** The product has a value of its own. */
  own: boolean;
  /** The `expectedVersion` the next write carries. */
  version: number;
}

/** One quota: the bytes and distinct files the product holds, against the limit. */
export interface QuotaUsageDto {
  bytes: number;
  files: number;
  quota: number;
  /** No room for one byte more: new images are refused, or mirroring has stopped. */
  full: boolean;
}

/** HA-10: `GET …/assets/usage` (notes/S-20 §6.10). */
export interface AssetUsageDto {
  /** The platform kill switch `assets.hosting.enabled`. */
  hosting: boolean;
  media: QuotaUsageDto;
  release: QuotaUsageDto;
  settings: AssetSettingDto[];
}

/** What Revert or delete-a-copy did (`DELETE …/assets/<slot>`). */
export type HostedAssetOutcome =
  | { outcome: "reverted"; pulling: boolean }
  | { outcome: "deleted" };

/** A row of a product's Users page: one pairwise subject of this product, never the account. */
export interface ProductUserSummary {
  subject: string;
  /** The readable code the person reads out (`XXX-XXX-XXX`); `null` until they ask (I-41). */
  supportCode?: string | null;
  createdAt: number;
  contactEmail: string | null;
  contactSource: "license" | "consented" | null;
  licenses: number;
  devices: number;
  /** Identity on only. */
  signedInDevices?: number;
  /** Identity on only. */
  lastSignInAt?: number | null;
  mergedFrom: number;
}

export interface ProductUserQuery {
  q?: string;
  limit?: number;
  cursor?: string | null;
}

export interface ProductUsersPage {
  identityOn: boolean;
  users: ProductUserSummary[];
  nextCursor: string | null;
}

export interface ProductUserLicense {
  id: string;
  name: string | null;
  email: string | null;
  tierId: string | null;
  status: string;
  activatedAt: number;
  expiresAt: number | null;
}

export interface ProductUserDevice {
  deviceId: string;
  label: string | null;
  status: string;
  platform: string | null;
  appVersion: string | null;
  licenseId: string | null;
  lastSeen: number;
  signedIn?: boolean;
}

export interface ProductUserRelink {
  id: string;
  licenseId: string;
  /** LX-30: an I-12 relink, a Make floating or a Reassign. Absent from an older Worker. */
  kind?: LicenseHolderMoveKind;
  direction: "in" | "out";
  otherSubject: string | null;
  reason: string;
  actorName: string | null;
  createdAt: number;
  undoUntil: number;
  undoneAt: number | null;
  undoable: boolean;
}

export interface ProductUserDetail {
  subject: string;
  /** The readable code the person reads out (`XXX-XXX-XXX`); `null` until they ask (I-41). */
  supportCode?: string | null;
  createdAt: number;
  identityOn: boolean;
  contact: { email: string | null; source: "license" | "consented" | null };
  name: string | null;
  mergedFrom: Array<{ subject: string; mergedAt: number }>;
  licenses: ProductUserLicense[];
  devices: ProductUserDevice[];
  data: { bytes: number; stores: Array<{ name: string; bytes: number }> };
  signIns?: Array<{ at: number; method: string | null }>;
  events: Array<{
    id: string;
    type: string;
    at: number;
    alias?: string;
    licenseIds?: string[];
  }>;
  relinks: ProductUserRelink[];
  audit: Array<{
    id: string;
    at: number;
    action: string;
    actorName: string | null;
    targetKind: string | null;
    targetId: string | null;
    summary: string | null;
  }>;
}

/** A row, or (for a subject absorbed by a merge) the survivor's subject. */
export type ProductUserResponse =
  | { user: ProductUserDetail; mergedInto?: undefined }
  | { mergedInto: string; user?: undefined };

/**
 * `GET users/<subject>/overrides` (U-03; worker `console/handlers/accountOverrides.ts`): one
 * account's managed config on one product, keyed by its pairwise subject. Config and secrets only
 * (entitlements stay on the licence); a secret, and a config key the catalog flags `secret`, come
 * back without their value.
 */
export interface AccountOverridesView {
  subject: string;
  configOn: boolean;
  overrides: {
    config: Record<string, ManagedEntry>;
    secrets: Record<string, ManagedSecretView>;
  };
  /** Epoch seconds of the last write; `null` when the account has none yet. */
  updatedAt: number | null;
  updatedBy: string | null;
}

export interface RelinkResult {
  ok: true;
  relinkId: string;
  subject: string;
  undoUntil: number;
  noticesSent: number;
  alert: boolean;
}

/** Identity → Sign-in's editable settings (I-12). */
export interface SignInSettings {
  claimByKey: boolean;
  passthroughName: string | null;
  effectiveName: string;
  appReview48Warning: boolean;
}

/** One obtain-path kind (notes/S-21 §6.3): one reason a signed-in person can add a product. */
export type ObtainPathKind =
  | "group"
  | "auto_issue"
  | "open"
  | "store_owned"
  | "product_idp"
  | "email_domain";

/** `storefront.polarisKey.listed`. */
export type PolarisKeyListed = "auto" | "listed" | "unlisted";

/** `storefront.polarisKey.audience`. */
export type PolarisKeyAudience = "eligible" | "everyone";

/** One readiness check (PS-01's `polarisKeyReadiness`). */
export interface PolarisKeyReadinessCheck {
  id: "portal" | "listing" | "obtain-path" | "get-it" | "licence-tier";
  state: "pass" | "warn" | "fail";
  reason: string;
}

/** `GET …/storefronts/polaris-key`: the first-party `status` op. */
export interface PolarisKeyStatusResponse {
  /** The deployment switch `storefront.polarisKey.enabled`. */
  enabled: boolean;
  portalEnabled: boolean;
  listing: {
    listed: PolarisKeyListed;
    audience: PolarisKeyAudience;
    offerPaths: ObtainPathKind[] | null;
    groupLabels: Record<string, string>;
  };
  /** The kinds whose policy is configured: the "Ways to add" switches. */
  available: ObtainPathKind[];
  /** The available kinds the listing offers now, in evaluation order. */
  active: ObtainPathKind[];
  /** Audience everyone on a listed product: everyone else signed in sees a link. */
  everyone: boolean;
  identityEligible: boolean;
  licenseEnabled: boolean;
  /** A published release has a file Get it can hand over. */
  directDownload?: boolean;
  groups: { group: string; tier: string | null; label: string | null }[];
  autoIssue: {
    tier: string;
    tierLabel: string | null;
    expiryDays: number | null;
  } | null;
  readiness: PolarisKeyReadinessCheck[];
}

/** A synthetic person (S-21 owner decision 11): nothing in it names anyone. */
export interface PolarisKeyPersona {
  platformAccount: boolean;
  groups: string[];
  /** A domain, never an address. */
  emailDomain: string | null;
  stores: string[];
  holds: boolean;
}

/** The licence terms a path would mint. */
export interface PolarisKeyTerms {
  tier: string | null;
  tierLabel: string | null;
  deviceLimit: number;
  expiresAt: number | null;
  expiryDays: number | null;
}

/** One path on a preview tile, as `GET /api/discover` sends it. */
export interface PolarisKeyTilePath {
  kind: ObtainPathKind;
  detail: string | null;
  /** The operator's group label, or `null`. */
  label: string | null;
  terms: PolarisKeyTerms | null;
  action: "add" | "link";
  reason: string;
}

/** The Discover tile a persona would see (`GET /api/discover`'s offer shape). */
export interface PolarisKeyTile {
  product: string;
  name: string;
  developerName: string | null;
  tintColor: string | null;
  iconUrl: string | null;
  headerUrl: string | null;
  platforms: string[];
  shortDescription: string | null;
  cta: "add" | "link";
  paths: PolarisKeyTilePath[];
  offer: PolarisKeyTerms | null;
  reason: string | null;
  stores: { id: string; kind: string; label: string; url: string }[];
}

/** `POST …/storefronts/polaris-key/preview`. */
export interface PolarisKeyPreviewResponse {
  persona: PolarisKeyPersona;
  visible: boolean;
  hidden: "storefront_off" | "not_candidate" | "holds" | "no_path" | null;
  tile: PolarisKeyTile | null;
}

/** One row of the analytics card. */
export interface PolarisKeyCounts {
  impressions: number;
  adds: number;
  activations: number;
}

/** `GET …/storefronts/polaris-key/analytics`: the last 28 days of `storefront_daily`. */
export interface PolarisKeyAnalyticsResponse {
  from: string;
  to: string;
  days: number;
  totals: PolarisKeyCounts;
  byKind: (PolarisKeyCounts & { kind: ObtainPathKind | "link" })[];
  daily: (PolarisKeyCounts & { day: string })[];
  /** False on a deployment without `KEY_HASH_PEPPER`: no impression is counted there. */
  impressionsCounted: boolean;
}

export interface RotateKeyResult {
  ok: true;
  kid: string;
  publicKey: string;
  status?: "staged" | "active";
  activateAfter?: number;
}

export type IntegrationFeatureId =
  | "licensing"
  | "config"
  | "identity"
  | "update"
  | "packs"
  | "sync"
  | "commerce";

/** Where a feature was seen working. `sdkVersion` is client-supplied: text only, never a trust signal. */
export interface IntegrationVerifiedOn {
  sdk: string;
  platform: string;
  arch: string;
  sdkVersion: string | null;
  lastOkAt: number | null;
}

export interface IntegrationFeature {
  id: IntegrationFeatureId;
  service: ServiceSlug;
  prerequisites: Array<{ id: string; met: boolean }>;
  unavailable: boolean;
  facts: Record<string, number | boolean | string | null>;
  status: "verified" | "not_seen" | "blocked";
  verifiedOn: IntegrationVerifiedOn[];
}

export interface IntegrationView {
  product: string;
  now: number;
  snippet: {
    slug: string;
    services: ServiceSlug[];
    pins: Array<{ kid: string; publicKey: string }>;
    /** Declared release keys (public); none while Release is off. */
    releaseKeys: Array<{ kid: string; publicKey: string }>;
  };
  features: IntegrationFeature[];
  server: IntegrationVerifiedOn[];
  sightings: Array<{
    sdk: string;
    platform: string;
    arch: string;
    sdkVersion: string | null;
    firstSeenAt: number;
    lastSeenAt: number;
  }>;
  verified: boolean;
}

export type SigningKeyState = "active" | "staged" | "retired" | "revoked";

/** One signing key (`GET …/keys`, A-4). Public material only. */
export interface SigningKeyDto {
  kid: string;
  status: SigningKeyState | (string & {});
  alg: string;
  publicKey: string;
  createdAt: number;
  activateAfter: number | null;
  activatedAt: number | null;
  retiredAt: number | null;
  revokedAt: number | null;
}

/**
 * After a rotation (UX-29): the authorized devices seen in the last `windowDays`, and how many of
 * them reached the server since the active key went live. Derived from `last_seen`; there is no
 * per-device trust fetch record, so the console says "refreshed", never "fetched the new trust".
 */
export interface SigningKeyRefreshDto {
  kid: string;
  activatedAt: number;
  activeDevices: number;
  refreshedDevices: number;
  windowDays: number;
}

export interface SigningKeysResponse {
  keys: SigningKeyDto[];
  /** The server's clock, epoch seconds: the staged countdown is measured against it. */
  now: number;
  /** `null` unless the active key replaced another within the window; absent on older Workers. */
  refresh?: SigningKeyRefreshDto | null;
}

/** One secret of the inventory (`GET …/secrets`, A-5). Never a value. */
export interface ProductSecretDto {
  name: string;
  configured: boolean;
  usage: SecretUsage | null;
  createdAt: number | null;
  updatedAt: number | null;
  requiredBy: string[];
}

/** ST-12: one operation's required trust level. */
export type TrustLevelDto = "basic" | "attested";

/** The product's device trust policy (`core.trustPolicy`). */
export interface TrustPolicyDto {
  mint: TrustLevelDto;
  gatedDelivery: TrustLevelDto;
  commerceClaim: TrustLevelDto;
  /** Cloud Sync pushes (U-05.11). */
  cloudSyncWrite: TrustLevelDto;
  enforce: boolean;
  appAttest: {
    teamId: string | null;
    environment: "production" | "development";
  } | null;
  playIntegrity: {
    cloudProjectNumber: string | null;
    allowTestingResponses?: true;
  } | null;
}

export interface TrustPolicyResponse {
  ok: true;
  policy: TrustPolicyDto;
  source: "default" | "admin";
  /** The `expectedVersion` the next write carries (GET only). */
  version?: number;
}

/** What a relaxing change adds (`reason`, and the setting's key typed as `confirm`). */
export interface TrustPolicyGuard {
  expectedVersion: number;
  reason?: string;
  confirm?: string;
}

export interface TrustPolicyWrite extends TrustPolicyGuard {
  policy: TrustPolicyDto;
}

export interface PublisherPolicyDto {
  product: string;
  provider: "github";
  repositoryId: number;
  repositoryOwnerId: number;
  repository: string;
  workflow: string;
  environment: string;
  scopes: string[];
  source: "manifest" | "admin";
  createdAt: number;
  modifiedAt: number;
  modifiedBy: string | null;
}

export interface PublisherClaimBody {
  workflow?: string;
  environment?: string;
  scopes?: string[];
  repository?: string;
  repositoryId?: number;
  repositoryOwnerId?: number;
}

export interface CiTokenDto {
  tokenId: string;
  kind: "oidc" | "static";
  scopes: string[];
  subject: string;
  label: string | null;
  issuedAt: number;
  expiresAt: number;
  revokedAt: number | null;
  createdBy: string;
  /** Last accepted on the registry host, at hourly resolution; null if never (F-33b.2). */
  lastUsedAt: number | null;
}

export interface IssueCiTokenBody {
  scopes: string[];
  expiresInDays: number;
  label?: string;
}

export interface IssuedCiToken {
  ok: true;
  token: string;
  tokenId: string;
  expiresAt: number;
  scopes: string[];
}

/** The CI scopes a publisher policy or a static token can hold (worker `core/ciVocabulary.ts`). */
export const CI_SCOPES = [
  "release:publish",
  "release:promote",
  "release:yank",
  "distribution:report",
  "distribution:rollout",
  "distribution:feeds",
  "distribution:listing",
  "assets:write",
] as const;

/** The blob collector's dry run for one product (`GET …/blob-gc`, P4-14). */
export interface BlobGcDryRun {
  enabled: boolean;
  graceSeconds: number;
  lockAgeSeconds: number;
  skipped?: string | null;
  complete?: boolean;
  incomplete?: unknown;
  liveReleases?: number;
  drops: {
    packObject: number;
    packUpload: number;
    truncated: boolean;
    listed: unknown[];
  };
  restores: { count: number; listed: unknown[] };
  earliestDeletion: number | null;
}

/** How the wire currently admits a device. It is always derived from the enabled services. */
export type RegistrationPolicy =
  | "open"
  | "requires-identity"
  | "requires-license";

/** Read-only facts shown with the console's feature groups. */
export interface ServiceFeatureFacts {
  licensing: { tiers: number; licenses: number };
  managedConfig: { catalogVersion: number | null };
  shipBuilds: {
    latest: { version: string; channel: string | null } | null;
  };
  /** Configured storefronts, and live store purchases (the Attention state while Commerce is off). */
  commerce: { storefronts: number; storeGrants: number };
}

/** The service-enable state returned by mutations and embedded in the reader response. */
export interface ServiceState {
  services: Record<ServiceSlug, { enabled: boolean }>;
  /** The policy the wire enforces, derived from the services. */
  effectiveRegistration: RegistrationPolicy;
  /** Who owns the row: `manifest` (a resync may rewrite it) or `admin` (operator-claimed). */
  source: string;
}

/** `GET …/commerce` (worker `services/commerce/admin.ts` `view`): the overview's read. */
export type CommerceStore = "app-store" | "play" | "steam";

/** Which app a store's purchases belong to (A-28.3). */
export interface CommerceStoreIdentity {
  /** The bundle id, package name or Steam app id in force; `null`: the store is off. */
  value: string | null;
  source: "typed" | "assigned" | null;
  /** The app assigned on that store, whether or not it is used. */
  assigned: string | null;
  /** A typed value that differs from the assigned one (the typed value is in force). */
  mismatch: boolean;
  /** The store's own keys name different apps (D15; the lowest id is in force). */
  ambiguous?: boolean;
}

export interface CommerceView {
  licenseEnabled: boolean;
  /** The stored `commerce.stores` blocks (identity fields as typed; null: derived or unset). */
  settings?: { appStore?: { appAppleId?: string | null } | null };
  identity: Record<CommerceStore, CommerceStoreIdentity>;
  setup: Record<
    CommerceStore,
    { configured: boolean; credential: string | null; reason: string | null }
  >;
  products: Array<{
    store: CommerceStore;
    productId: string;
    deliverable: string;
    flag: string;
  }>;
  purchases: Array<{
    store: CommerceStore;
    purchase: string;
    storeProductId: string;
    state: string;
    environment: string;
    /** Epoch seconds. */
    lastVerified: number;
  }>;
  events: Array<{
    connector: string;
    id: string;
    type: string;
    outcome: string;
    receivedAt: number;
  }>;
}

/** `GET …/services` adds read-only feature facts to the service state. */
export interface ServicesResponse extends ServiceState {
  facts: ServiceFeatureFacts;
}

/**
 * `PATCH …/services?dryRun=1` (PX-W17, ST-38): what the same PATCH would change, with no write.
 * `cascaded` lists dependent services the server turns off under the requirement rule.
 */
export interface ServicesDryRun {
  changes: Array<{ field: string; from: unknown; to: unknown }>;
  cascaded: ServiceSlug[];
  signedInDevicesToClear: number;
}

/** A partial enablement patch: an omitted slug keeps its current value server-side. */
export interface UpdateServicesBody {
  services?: Partial<Record<ServiceSlug, { enabled: boolean }>>;
}

export const coreApi = {
  /** Write-only. `usage` omitted keeps what is stored (a new secret is general). */
  putProductSecret: (
    slug: string,
    name: string,
    value: string,
    usage?: SecretUsage,
  ) =>
    call<{ ok: true; name: string; usage?: SecretUsage }>(
      `${p(slug)}/secrets/${enc(name)}`,
      {
        method: "PUT",
        body: JSON.stringify(usage ? { value, usage } : { value }),
      },
    ),
  rotateProductKey: (slug: string) =>
    call<RotateKeyResult>(`${p(slug)}/keys/rotate`, { method: "POST" }),
  /** A-4: every signing key with its lifecycle state. */
  productKeys: (slug: string) => call<SigningKeysResponse>(`${p(slug)}/keys`),
  /** Promote a staged key. `breakGlass` skips the trust-cache window. */
  activateProductKey: (slug: string, kid: string, breakGlass = false) =>
    call<{ ok: true; kid: string; status: "active" }>(
      `${p(slug)}/keys/activate`,
      {
        method: "POST",
        body: JSON.stringify(breakGlass ? { kid, breakGlass } : { kid }),
      },
    ),
  retireProductKey: (slug: string, kid: string) =>
    call<{ ok: true; kid: string; status: "retired" }>(
      `${p(slug)}/keys/retire`,
      { method: "POST", body: JSON.stringify({ kid }) },
    ),
  revokeProductKey: (slug: string, kid: string) =>
    call<{ ok: true; kid: string; status: "revoked" }>(
      `${p(slug)}/keys/revoke`,
      { method: "POST", body: JSON.stringify({ kid }) },
    ),
  /** A-5: secret names, usage and what requires each. Never a value. */
  productSecrets: (slug: string) =>
    call<{ secrets: ProductSecretDto[] }>(`${p(slug)}/secrets`),
  ciPublisher: (slug: string) =>
    call<{ ok: true; policy: PublisherPolicyDto | null }>(
      `${p(slug)}/ci-publisher`,
    ),
  /** Claims the policy from the manifest (`source` becomes `admin`). */
  putCiPublisher: (slug: string, body: PublisherClaimBody) =>
    call<{ ok: true; policy: PublisherPolicyDto }>(`${p(slug)}/ci-publisher`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  ciTokens: (slug: string) =>
    call<{ ok: true; tokens: CiTokenDto[] }>(`${p(slug)}/ci-tokens`),
  /** The token is in this response once and never again. */
  issueCiToken: (slug: string, body: IssueCiTokenBody) =>
    call<IssuedCiToken>(`${p(slug)}/ci-tokens`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  revokeCiToken: (slug: string, tokenId: string) =>
    call<{ ok: true; tokenId: string; revokedAt: number }>(
      `${p(slug)}/ci-tokens/${enc(tokenId)}`,
      { method: "DELETE" },
    ),
  /** The blob collector's dry run: what would be dropped, and when. Read-only. */
  blobGc: (slug: string) => call<BlobGcDryRun>(`${p(slug)}/blob-gc`),
  /** HA-05, HA-06: every hosted-asset slot of the product (the Presentation page). */
  hostedAssets: (slug: string) =>
    call<{ assets: HostedAssetDto[] }>(`${p(slug)}/assets`),
  /**
   * HA-06: upload `file` into `slot` (the body is the file itself; the Worker sniffs the type).
   * The upload claims the slot: a resync and a CI push leave it alone until Revert.
   */
  uploadHostedAsset: (
    slug: string,
    slot: string,
    file: Blob,
    locale?: string,
  ) =>
    call<{ asset: HostedAssetDto | null }>(
      `${p(slug)}/assets/${enc(slot)}${locale ? `?locale=${enc(locale)}` : ""}`,
      {
        method: "POST",
        body: file,
        headers: { "Content-Type": file.type || "application/octet-stream" },
      },
    ),
  /** HA-06: Revert a console claim to the manifest, or delete the slot's hosted copy. */
  deleteHostedAsset: (slug: string, slot: string, locale?: string) =>
    call<HostedAssetOutcome>(
      `${p(slug)}/assets/${enc(slot)}${locale ? `?locale=${enc(locale)}` : ""}`,
      { method: "DELETE" },
    ),
  /** HA-10: the bytes the product holds against its quotas, the kill switch, its settings. */
  assetUsage: (slug: string) => call<AssetUsageDto>(`${p(slug)}/assets/usage`),
  /** HA-10: set one of the product's hosted-asset settings (through `writeSetting()`). */
  saveAssetSetting: (
    slug: string,
    key: string,
    body: { value: unknown; expectedVersion: number; reason?: string },
  ) =>
    call<AssetUsageDto>(`${p(slug)}/assets/settings/${enc(key)}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  /** HA-10: drop the product's own value: it follows the platform default again. */
  resetAssetSetting: (slug: string, key: string, expectedVersion: number) =>
    call<AssetUsageDto>(`${p(slug)}/assets/settings/${enc(key)}`, {
      method: "DELETE",
      body: JSON.stringify({ expectedVersion }),
    }),

  commerceView: (slug: string) => call<CommerceView>(`${p(slug)}/commerce`),
  /** Drop the store's typed identity so the assigned app applies (A-28.3). */
  commerceUseAssigned: (slug: string, store: CommerceStore) =>
    call<CommerceView>(`${p(slug)}/commerce/settings/${store}/use-assigned`, {
      method: "POST",
    }),

  services: (slug: string) => call<ServicesResponse>(`${p(slug)}/services`),
  updateServices: (slug: string, body: UpdateServicesBody) =>
    call<ServicesResponse>(`${p(slug)}/services`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  /** The same PATCH as a dry run: what it would change, and how many devices it signs out. */
  servicesDryRun: (slug: string, body: UpdateServicesBody) =>
    call<ServicesDryRun>(`${p(slug)}/services?dryRun=1`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  /** Hand `services_json` back to the manifest. Changes nothing live — the manifest re-applies
   *  on the NEXT resync (worker `console/handlers/servicesAdmin.ts`). */
  revertServices: (slug: string) =>
    call<ServicesResponse>(`${p(slug)}/services/revert`, { method: "POST" }),

  /** PS-06: the Polaris Key panel (the first-party `status` op). */
  polarisKey: (slug: string) =>
    call<PolarisKeyStatusResponse>(`${p(slug)}/storefronts/polaris-key`),
  /** PS-06: "Who can see this?" for a persona; reads only (a POST for its body). */
  polarisKeyPreview: (slug: string, persona: PolarisKeyPersona) =>
    call<PolarisKeyPreviewResponse>(
      `${p(slug)}/storefronts/polaris-key/preview`,
      { method: "POST", body: JSON.stringify(persona) },
    ),
  /** PS-06: the 28-day analytics card. */
  polarisKeyAnalytics: (slug: string) =>
    call<PolarisKeyAnalyticsResponse>(
      `${p(slug)}/storefronts/polaris-key/analytics`,
    ),
  productUsers: (slug: string, query: ProductUserQuery = {}) => {
    const search = new URLSearchParams();
    if (query.q) search.set("q", query.q);
    if (query.limit) search.set("limit", String(query.limit));
    if (query.cursor) search.set("cursor", query.cursor);
    const qs = search.toString();
    return call<ProductUsersPage>(`${p(slug)}/users${qs ? `?${qs}` : ""}`);
  },
  productUser: (slug: string, subject: string) =>
    call<ProductUserResponse>(`${p(slug)}/users/${enc(subject)}`),
  /** The subject's product data as one JSON document (audited server-side). */
  productUserExport: (slug: string, subject: string) =>
    call<Record<string, unknown>>(
      `${p(slug)}/users/${enc(subject)}/export`,
      {},
      { stepUpRedirect: true },
    ),
  /** The subject's account overrides (U-03): config and secrets, secrets by name only. */
  productUserOverrides: (slug: string, subject: string) =>
    call<AccountOverridesView>(`${p(slug)}/users/${enc(subject)}/overrides`),
  /**
   * The account override editor's batch, the licence editor's shape. 422 `fields` (catalog
   * validation, or a `flag` key: entitlements stay on the licence); 409 `conflict` when the row
   * changed in the meantime.
   */
  putProductUserOverrides: (
    slug: string,
    subject: string,
    updates: OverrideUpdate[],
  ) =>
    call<{ ok: true; subject: string }>(
      `${p(slug)}/users/${enc(subject)}/overrides`,
      { method: "PUT", body: JSON.stringify({ updates }) },
    ),
  deleteProductUserData: (slug: string, subject: string) =>
    call<{ ok: true; stores: string[] }>(
      `${p(slug)}/users/${enc(subject)}/data/delete`,
      { method: "POST" },
    ),
  detachProductUserLicense: (
    slug: string,
    subject: string,
    licenseId: string,
  ) =>
    call<{ ok: true }>(
      `${p(slug)}/users/${enc(subject)}/licenses/${enc(licenseId)}/detach`,
      { method: "POST" },
    ),
  /** Needs a step-up (403 `step_up_required` otherwise). */
  relinkProductUserLicense: (
    slug: string,
    subject: string,
    licenseId: string,
    body: { target: string; reason: string },
  ) =>
    call<RelinkResult>(
      `${p(slug)}/users/${enc(subject)}/licenses/${enc(licenseId)}/relink`,
      { method: "POST", body: JSON.stringify(body) },
    ),
  signInSettings: (slug: string) =>
    call<{ settings: SignInSettings }>(`${p(slug)}/identity/sign-in-settings`),
  updateSignInSettings: (
    slug: string,
    patch: { claimByKey?: boolean; passthroughName?: string | null },
  ) =>
    call<{ ok: true; settings: SignInSettings }>(
      `${p(slug)}/identity/sign-in-settings`,
      { method: "PATCH", body: JSON.stringify(patch) },
    ),

  /** ST-40: per enabled feature, its prerequisites and where it is Verified. */
  integration: (slug: string) =>
    call<IntegrationView>(`${p(slug)}/integration`),
};
