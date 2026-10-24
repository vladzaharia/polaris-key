/**
 * The products slice of the console API (P0-32.21): the registry, create and link, resync, claims, channels and the portal settings.
 * Types and the `productsApi` methods live together; `api.ts` re-exports the types and spreads the methods.
 */
import type { ServiceSlug } from "../../services.generated.js";
import type { ProductCatalog } from "@polaris-key/catalog";
import type {
  ObtainPathKind,
  PolarisKeyAudience,
  PolarisKeyListed,
  ProductPresentation,
  RegistrationPolicy,
} from "./core.js";
import type { ProductReleaseSource, ProductSigningBundle } from "./platform.js";
import { call, enc, p } from "./transport.js";

export interface ProductSyncState {
  source?: string;
  status?: string;
  lastCheckedAt?: number | null;
  lastSyncedAt?: number | null;
  commitSha?: string | null;
  changedPaths?: string[];
  updated?: string[];
  errors?: string[];
  message?: string | null;
}

export interface PortalProductSettings {
  portalEnabled: boolean;
  /** PX-W5 (G7): customers may replace a license's key from the portal. Off by default. */
  keyReissueEnabled?: boolean;
  /** PX-W5 / S-16: an email-carrying license may be added by key without that email. Off by default. */
  claimByKey?: boolean;
  /** PX-W10 (G24): the product may be offered on the portal's Discover. On by default. */
  discoverEnabled?: boolean;
  /** PS-02: the Polaris Key listing (`storefront.polarisKey.*`; PS-06's panel edits them). */
  storeListed?: PolarisKeyListed;
  storeAudience?: PolarisKeyAudience;
  /** `null` = every way to add, including kinds added later. */
  storeOfferPaths?: ObtainPathKind[] | null;
  storeGroupLabels?: Record<string, string>;
  branding?: unknown;
  modifiedAt?: number;
}

/** One thing that needs the operator (`GET /manage/api/attention`; worker `console/lib/attention.ts`). */
export interface AttentionItemDto {
  id: string;
  /** `null` for a platform item (the Cloud Sync pause): it belongs to no product. */
  product: { slug: string; name: string } | null;
  kind:
    | "sync.failed"
    | "secret.missing"
    | "secret.usage"
    | "signing.missing"
    | "mint.pending"
    | "credential.expiring"
    | "storefront.identity_mismatch"
    | "storefront.identity_ambiguous"
    | "channel.identity_mismatch"
    | "sync.paused";
  tone: "danger" | "warning";
  /** The service the fix belongs to (the row's accent); `null` for the product itself. */
  service: ServiceSlug | null;
  /** The product card's pill: the problem in two or three words. */
  short: string;
  /** One fact per line. */
  lines: string[];
  action: { label: string; page: string; query?: Record<string, string> };
  area: string;
  /** Platform items only: epoch seconds the pause began. */
  since?: number | null;
  /** Platform items only: the display name of who turned it on. */
  by?: string | null;
  /** Platform items only: the operator's reason. */
  reason?: string | null;
}

/** One row of Platform ready (`GET /manage/api/platform/ready`). */
export interface PlatformReadyRow {
  id: string;
  title: string;
  done: boolean;
  detail?: string;
  action?: { label: string; to: string; store?: string };
}

export interface PlatformReadyDto {
  rows: PlatformReadyRow[];
  done: number;
  total: number;
}

/** A-20.4: a channel's delivery state. `setting_up` is reserved for a later slice. */
export type ChannelDeliveryState =
  | "not_set_up"
  | "ready"
  | "live"
  | "attention";

export type ChannelAttention =
  | { code: "out_of_scope" }
  | {
      code: "no_fitting_build";
      reasons: ("format" | "arch" | "unknown-format")[];
    }
  | { code: "credential_expiring" }
  | { code: "credential_missing" }
  /** An outlet's declared app differs from the assigned one (A-28.7); names the field, no value. */
  | { code: "identity_mismatch"; field: string };

export interface ProductPlatformFact {
  platform: string;
  arches: string[];
  formats: string[];
  sources: ("builds" | "declared" | "outlet" | "planned")[];
}

export interface ChannelCommerceFacet {
  state: "not_set_up" | "ready" | "attention";
  reason: "no_settings" | "no_credential" | "commerce_off" | null;
  /** The store's typed app differs from the assigned one (A-28.7). */
  attention: { code: "identity_mismatch" }[];
}

/** The app a store channel's purchases belong to; `null` without the commerce area (A-28.7). */
export interface ChannelIdentity {
  fields: Record<string, string>;
  source: "typed" | "assigned" | null;
}

/** One channel of `GET …/distribution/channels`. Credential facts are booleans and codes only. */
export interface ChannelRow {
  id: string;
  label: string;
  inScope: boolean;
  declared: boolean;
  oneClick: boolean;
  notUsing: boolean;
  delivery: {
    state: ChannelDeliveryState;
    attention: ChannelAttention[];
    platforms: { platform: string; arches: string[] }[];
  };
  commerce: ChannelCommerceFacet | null;
  /** Store channels only, and only for a session that sees the commerce area. */
  identity: ChannelIdentity | null;
}

export interface ChannelsView {
  product: string;
  now: number;
  platforms: ProductPlatformFact[];
  kinds: string[];
  channels: ChannelRow[];
}

/**
 * The compact channel rows on the one-product read (`ProductDetail.channels`): the nav's facts,
 * safe for a holder of any area. `oneClick` and the commerce facet are on `ChannelRow` only.
 */
export interface ProductChannelSummary {
  id: string;
  label: string;
  /** In the product's scope (its platforms and deliverables fit); a declared outlet can be out. */
  inScope: boolean;
  delivery: ChannelDeliveryState;
  notUsing: boolean;
}

export interface ProductDetail {
  slug: string;
  name: string;
  /** ST-08: the browser origins the product answers CORS for. Absent from an older Worker. */
  webOrigins?: string[];
  /** The logo (owner request 2026-10-06). Absent from a Worker that predates it. */
  presentation?: ProductPresentation;
  /** The platform's own product (F-03: the package-feeds owner of our SDKs); kept out of the
   *  product switcher and the Products registry. */
  system?: boolean;
  /** List rows only: an SDK has been seen calling one of the product's services (Home's facet). */
  verified?: boolean;
  /** The operator-owned `packageFeeds` sub-capability (F-11): Distribution → Package feeds shows
   *  only while it is on. */
  packageFeeds?: boolean;
  /** F-34.3: the product's package feeds at a glance (the one-product read only). `declared`
   *  counts the package deliverables in `.pkey/release`; `offBy` and `offAt` say who turned the
   *  feeds off and when (`manifest`: a row the ingest provisioned). */
  packages?: {
    declared: number;
    feedsOn: boolean;
    offBy: string | null;
    offAt: number | null;
  };
  /** A-20.4: what the product can ship to. One-product read only (not the list). */
  platforms?: ProductPlatformFact[];
  /** A-20.4: the channels it can use, compact. One-product read only. */
  channels?: ProductChannelSummary[];
  signingKid: string;
  releaseSource?: ProductReleaseSource;
  signing?: ProductSigningBundle | null;
  jwksUrl?: string;
  jwks?: unknown;
  portalSettings?: PortalProductSettings;
  /** The last manifest resync, `null` before the first. Detail row only. */
  sync?: ProductSyncState | null;
  /**
   * Which services this product runs (D-15). Carried on the product row itself — not only on
   * `GET …/services` — because the SHELL needs it to decide which nav sections exist, and the
   * shell already loads the product. A second round-trip before the sidebar can be drawn would
   * make the nav pop in after the view it frames.
   */
  services?: Record<ServiceSlug, { enabled: boolean }>;
  /** What the derivation currently produces — what the wire actually enforces. */
  effectiveRegistration?: RegistrationPolicy;
  /** Who owns `services_json`: `manifest` (a resync may rewrite it) or `admin`. */
  servicesSource?: string;
  compatMin: string;
  compatMax: string;
  defaultMaxOfflineDays: number;
  defaultDeviceLimit: number;
  adminGroup: string | null;
  /**
   * ST-01b: the manifest-declared settings the console has claimed (a resync leaves each alone
   * until it is reverted). Empty, or absent from an older Worker, when nothing is claimed.
   */
  claims?: ProductClaim[];
  /**
   * ST-20: manifest-authoritative mode. On, console edits to manifest-declared settings are
   * break-glass claims only (a reason, at most 7 days). Locked on for the system product. Absent
   * from an older Worker.
   */
  manifestAuthoritative: { value: boolean; locked: boolean };
  createdAt: number;
  modifiedAt: number;
}

/** The column-backed claimable settings (worker `core/settingsClaims.ts` `CLAIM_KEYS`). */
export type ClaimKey =
  | "core.name"
  | "license.defaults.maxOfflineDays"
  | "license.defaults.deviceLimit"
  | "core.web.origins"
  | "config.catalog";

/** One console claim on a manifest-declared setting (ST-01b). */
export interface ProductClaim {
  key: ClaimKey;
  claimedBy: string;
  claimedAt: number;
  version: number;
  /**
   * ST-20: a break-glass claim's reason and latest expiry (epoch seconds). It also ends at the
   * first resync or deploy that changes the field. Absent on an ordinary claim.
   */
  breakGlass?: { reason: string; expiresAt: number };
}

/** A live break-glass claim, as a resync lists it (ST-20). */
export interface BreakGlassClaim {
  key: ClaimKey;
  claimedBy: string;
  claimedAt: number;
  reason: string;
  expiresAt: number;
}

/** What Revert to manifest did: re-applied the snapshot now, or left it to the next resync. */
export type RevertClaimResult =
  | { ok: true; key: ClaimKey; applied: true; value: unknown }
  | { ok: true; key: ClaimKey; applied: false; message: string };

/** ST-42 (W25): the choices both create routes take, all optional. */
export interface CreateChoices {
  /** Service slugs; the Worker applies the requirement rule. */
  services?: ServiceSlug[];
  intendedPlatforms?: string[];
  starterTier?: "free" | "none";
}

export interface CreateManualProductBody extends CreateChoices {
  slug: string;
  name?: string;
  schema?: ProductCatalog | string;
  signingKid?: string;
  compatMin?: string;
  compatMax?: string;
  defaultMaxOfflineDays?: number;
  defaultDeviceLimit?: number;
  adminGroup?: string;
}

/** `GET /manage/api/products/slug-check?slug=` (W24). */
export type SlugCheck =
  | { slug: string; status: "available" }
  | {
      slug: string;
      status: "taken" | "reserved" | "invalid";
      message: string;
      suggestion: string | null;
    };

/** One repository the GitHub App can read (W22). */
export interface GithubRepoRow {
  installationId: number;
  owner: string;
  name: string;
  fullName: string;
  language: string | null;
  pushedAt: number | null;
  private: boolean;
  defaultBranch: string | null;
  /** The slug of the product registered from it, or null. */
  product: string | null;
  /** A `.pkey/product` on the default branch; null when GitHub would not say. */
  hasManifest: boolean | null;
}

/** `GET /manage/api/github/repositories` (W22). */
export interface GithubRepositories {
  configured: boolean;
  app: { slug: string; installUrl: string } | null;
  installations: {
    id: number;
    account: string;
    repositorySelection: string;
    repositoryCount: number | null;
    listingError: string | null;
  }[];
  repositories: GithubRepoRow[];
  total: number;
  nextCursor: string | null;
}

/** One thing that blocks a create, with its `.pkey/` document and JSON path when it has one. */
export interface CreateProblem {
  check: string;
  file: "product" | "schema" | "release" | "distribution" | null;
  path: string | null;
  message: string;
  suggestion?: string;
}

/** `POST /manage/api/products/link-repo?dryRun=1` (W23): the product as it will be. */
export interface CreateDryRun {
  ok: true;
  dryRun: true;
  repository: string;
  installationId: number;
  commit: string;
  manifestDigest: string;
  ready: boolean;
  product: {
    slug: string;
    name: string;
    presentation: unknown;
  } | null;
  slug: SlugCheck | null;
  registeredAs: string | null;
  services: string[];
  catalog: { entries: number } | null;
  platforms: { values: string[]; source: "artifact-map" | "none" };
  secrets: string[];
  releaseWorkflow: boolean | null;
  /** Whether the create adds the Free tier (License on, no tier declared). */
  starterTier: "free" | "none";
  problems: CreateProblem[];
}

/** What a create answers for the choices it applied (ST-42). */
export interface CreateLinkOptions extends CreateChoices {
  /** From the dry run: a `.pkey/` that changed since refuses the create. */
  manifestDigest?: string;
  trustReleaseWorkflow?: boolean;
}

export type UpdatePortalSettingsBody = Partial<
  Pick<
    PortalProductSettings,
    | "portalEnabled"
    | "keyReissueEnabled"
    | "claimByKey"
    | "discoverEnabled"
    | "branding"
    | "storeListed"
    | "storeAudience"
    | "storeOfferPaths"
    | "storeGroupLabels"
  >
> & {
  /**
   * The typed phrase that widens the audience to `everyone` (`storefront.polarisKey.audience`,
   * level 2, PS-02); the Worker answers `400 confirm_required` without it.
   */
  confirm?: string;
};

export interface CreateManualProductResult {
  ok: true;
  slug: string;
  kid: string;
  signing?: ProductSigningBundle | null;
  product: ProductDetail | null;
}

export interface LinkRepoResult {
  ok: true;
  slug: string;
  kid: string;
  signing?: ProductSigningBundle | null;
  product?: ProductDetail | null;
  install?: unknown;
  remainingSecrets?: string[];
}

/**
 * NOTE what is absent: `compatMin`/`compatMax`. Spec §8 relocated the compatibility window to
 * the setting `release.compatWindow`, and the worker's product PATCH now DROPS them rather than rejecting them —
 * so a console that still sent them would appear to save a value that never changed. Removing
 * them from the type is what makes that unrepresentable instead of merely unused.
 */
export interface UpdateProductBody {
  name?: string;
  defaultMaxOfflineDays?: number;
  defaultDeviceLimit?: number;
  /** `null` (or blank) clears the group (A-3). */
  adminGroup?: string | null;
  /** ST-08: the browser origins the product answers CORS for; `[]` clears them. */
  webOrigins?: string[];
  /** ST-20: turn manifest-authoritative mode on or off (a repository-linked product only). */
  manifestAuthoritative?: boolean;
  /** ST-20: on a manifest-authoritative product, the claimable fields' break-glass reason. */
  breakGlass?: { reason: string };
}

/** `POST …/release/resync` (worker `release/admin.ts`): what the resync re-applied. */
export interface ResyncResult {
  ok: true;
  slug: string;
  /** What the resync re-applied ("services", "catalog", "channels"…). */
  updated?: string[];
  /** Parts of the manifest it refused while applying the rest (P3-03). */
  refused?: { code: string; path: string; message: string }[];
  /**
   * ST-01b: what it left alone because the console claimed it — setting keys (`core.name`, …)
   * and console-owned rows (`tier:<id>`, `profile:<id>`).
   */
  claimed?: string[];
  /** ST-01b: console rows holding an id the manifest newly declares; kept, manifest row skipped. */
  conflicts?: { path: string; message: string }[];
  /** ST-20: the live break-glass claims after the resync. */
  breakGlass?: BreakGlassClaim[];
  /** ST-20: the break-glass claims it ended (their 7 days ran out, or the manifest changed them). */
  breakGlassEnded?: { key: ClaimKey; why: "expired" | "changed" }[];
  /** The pack-set re-resolution, when it stored sets or failed (P4-12). */
  packSets?:
    | { ok: true; sets: number }
    | { ok: false; reason: string; message: string };
}

/** One line of a manifest plan (worker `release/linkExisting.ts`, S-18 §4.5's dry-run shape). */
export interface ManifestPlanItem {
  area: string;
  /** The row it names (a tier, a catalog key), when there is one. */
  id?: string;
  summary: string;
}

/** What applying a repository's `.pkey/` to a product will do. */
/** One validator warning the plan carries (ST-17): a deprecated or conflicting spelling and the like. */
export interface ManifestPlanWarning {
  file: "product" | "schema" | "release" | "distribution";
  path: string;
  code: string;
  message: string;
}

export interface ManifestPlan {
  apply: ManifestPlanItem[];
  /** Declared by the manifest but set in the console: they stay. */
  skipClaimed: ManifestPlanItem[];
  delete: ManifestPlanItem[];
  /** What blocks the link. */
  conflicts: ManifestPlanItem[];
  /** ST-17: the validator's warnings for the manifest. Absent when none; they never block. */
  warnings?: ManifestPlanWarning[];
}

/** `POST …/release/link?dryRun=1`: the checks passed; this is what a link would do. A refusal
 *  is an `ApiError` whose `reason` names the failed check (`repository`, `app`, `manifest`,
 *  `slug`, `policy`, `product`). */
export interface LinkCheckResult {
  ok: true;
  dryRun: true;
  slug: string;
  repository: string;
  /** Sent back with the link: a push since the check refuses it (409). */
  manifestDigest: string;
  plan: ManifestPlan;
  /** Secret names the manifest references that the product does not hold yet. */
  remainingSecrets: string[];
}

/** `POST …/release/resync?dryRun=1` (UX-78): what a resync would do now. Writes nothing. A
 *  refusal is an `ApiError` whose `reason` names the failed check (`product`, `app`,
 *  `manifest`, `slug`); a policy refusal is a `plan.conflicts` item instead. */
export interface ResyncPlanResult {
  ok: true;
  dryRun: true;
  slug: string;
  /** `owner/repo`. */
  repository: string;
  /** The default-branch commit the manifest was read at. */
  commit: string;
  plan: ManifestPlan;
  /** ST-20: the break-glass claims the resync would keep (absent when none). */
  breakGlass?: BreakGlassClaim[];
}

/** `POST …/release/link`: linked and applied. */
export interface LinkExistingResult extends Omit<ResyncResult, "updated"> {
  repository: string;
  plan: ManifestPlan;
  updated: string[];
  remainingSecrets: string[];
}

export const productsApi = {
  products: () => call<{ products: ProductDetail[] }>("/manage/api/products"),
  /** Home's Needs attention: composed on the server, filtered to what the member can open. */
  attention: () => call<{ items: AttentionItemDto[] }>("/manage/api/attention"),
  /**
   * I-41: a support code a customer read out → the product and user it names. A `404` (an
   * `ApiError`) is every refusal: unknown, malformed, or a product the operator cannot read.
   */
  supportCode: (code: string) =>
    call<{ product: string; subject: string }>(
      `/manage/api/support-codes/${enc(code)}`,
    ),
  /** Platform ready: the first-run checklist (platform admins). */
  platformReady: () => call<PlatformReadyDto>("/manage/api/platform/ready"),
  product: (slug: string) => call<{ product: ProductDetail }>(p(slug)),
  createManualProduct: (body: CreateManualProductBody) =>
    call<CreateManualProductResult>("/manage/api/products", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  linkRepo: (repoUrl: string, options?: CreateLinkOptions) =>
    call<LinkRepoResult>("/manage/api/products/link-repo", {
      method: "POST",
      body: JSON.stringify({ repoUrl, ...options }),
    }),
  /** W23: check a repository for a product that does not exist yet. Writes nothing. */
  checkRepoCreate: (repoUrl: string) =>
    call<CreateDryRun>("/manage/api/products/link-repo?dryRun=1", {
      method: "POST",
      body: JSON.stringify({ repoUrl }),
    }),
  /** W24: whether a slug is free for a new product. */
  slugCheck: (slug: string) =>
    call<SlugCheck>(
      `/manage/api/products/slug-check?slug=${encodeURIComponent(slug)}`,
    ),
  /** W22: the repositories the GitHub App can read. */
  githubRepositories: (q: string) =>
    call<GithubRepositories>(
      `/manage/api/github/repositories?q=${encodeURIComponent(q)}`,
    ),
  updateProduct: (slug: string, body: UpdateProductBody) =>
    call<{ ok: true; slug: string }>(p(slug), {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  /**
   * Tombstone a product. `confirmSlug` is what the operator TYPED in the L3 confirmation (ADMIN.md
   * §5.2): the worker refuses unless it equals the slug, and the client never fills it in itself
   * (fixes PRD-4: an auto-filled guard guards nothing).
   */
  deleteProduct: (slug: string, confirmSlug: string) =>
    call<{ ok: true; slug: string }>(p(slug), {
      method: "DELETE",
      body: JSON.stringify({ confirmSlug }),
    }),
  resyncProduct: (slug: string) =>
    call<ResyncResult>(`${p(slug)}/release/resync`, { method: "POST" }),
  /** The resync's dry run: reads the manifest and plans. Writes nothing. */
  planResync: (slug: string) =>
    call<ResyncPlanResult>(`${p(slug)}/release/resync?dryRun=1`, {
      method: "POST",
    }),
  /** ST-01b: Revert a console claim to the manifest (`DELETE …/claims/<key>`). */
  revertClaim: (slug: string, key: ClaimKey) =>
    call<RevertClaimResult>(`${p(slug)}/claims/${encodeURIComponent(key)}`, {
      method: "DELETE",
    }),
  /** Link repository, step 1: check `repoUrl` and plan the hand-over. Writes nothing. */
  checkRepoLink: (slug: string, repoUrl: string) =>
    call<LinkCheckResult>(`${p(slug)}/release/link?dryRun=1`, {
      method: "POST",
      body: JSON.stringify({ repoUrl }),
    }),
  /** Link repository, step 2: link and apply the manifest the check read. */
  linkProductRepo: (slug: string, repoUrl: string, manifestDigest: string) =>
    call<LinkExistingResult>(`${p(slug)}/release/link`, {
      method: "POST",
      body: JSON.stringify({ repoUrl, manifestDigest }),
    }),
  portalSettings: (slug: string) =>
    call<{ settings: PortalProductSettings }>(`${p(slug)}/identity/portal`),
  updatePortalSettings: (slug: string, body: UpdatePortalSettingsBody) =>
    call<{ ok: true; settings: PortalProductSettings }>(
      `${p(slug)}/identity/portal`,
      {
        method: "PATCH",
        body: JSON.stringify(body),
      },
    ),
  /** A-20.4: one product's channel read model (area `ship`). */
  channels: (slug: string) =>
    call<ChannelsView>(`${p(slug)}/distribution/channels`),
};
