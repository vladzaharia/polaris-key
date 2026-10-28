/**
 * The feeds slice of the console API (P0-32.22): package feeds and registry tokens.
 * Types and the `feedsApi` methods live together; `api.ts` re-exports the types and spreads the methods.
 */
import type { ActivityItem } from "./activity.js";
import { call, enc, p } from "./transport.js";

// ── package feeds (F-11; worker `console/handlers/feeds.ts`) ───────────────────────────

/** The ecosystems a package feed serves (`@polaris-key/manifest` PACKAGE_ECOSYSTEMS): the six of
 *  tier 1, then tier 3's Cargo (F-30) and Go (F-31). */
export type FeedEcosystem =
  | "npm"
  | "pypi"
  | "swift"
  | "maven"
  | "oci"
  | "godot"
  | "cargo"
  | "go";

/** Why a feed does not answer, in the order the registry's access ladder checks it. */
export type FeedOffReason =
  | "platform-off"
  | "no-owner"
  | "distribution-off"
  | "package-feeds-off"
  | "not-set-up"
  | "feed-off";

export interface FeedSummary {
  ecosystem: FeedEcosystem;
  label: string;
  configured: boolean;
  enabled: boolean;
  accessMode: string;
  status: "enabled" | "off" | "unavailable";
  reason: FeedOffReason | null;
  packages: number;
  versions: number;
  lastPublishedAt: number | null;
  /** On the registry host; `null` when this deployment has no registry host configured. */
  baseUrl: string | null;
}

export interface PackageFeedsSwitch {
  enabled: boolean;
  /** 0 = never written. */
  version: number;
  updatedAt: number | null;
  /** Who last wrote it: an admin subject, or `manifest` for a row the ingest provisioned. */
  updatedBy: string | null;
}

interface FeedsHead {
  scope: "platform" | "product";
  /** The owning product (the system product in platform scope); `null` before the bootstrap. */
  owner: string | null;
  ownerName: string | null;
  distributionEnabled: boolean;
  packageFeeds: PackageFeedsSwitch | null;
  registryOrigin: string | null;
}

export interface FeedsOverviewDto extends FeedsHead {
  feeds: FeedSummary[];
  summary: {
    feedsEnabled: number;
    packages: number;
    versions: number;
    lastPublishedAt: number | null;
  };
  /** Platform scope: each ecosystem's kill switch and size ceiling (`null` before its row exists). */
  policies?: {
    ecosystem: FeedEcosystem;
    label: string;
    policy: FeedPolicy | null;
  }[];
  /** Platform scope: every owner with a packageFeeds row. */
  owners?: {
    slug: string;
    name: string;
    system: boolean;
    packageFeeds: boolean;
  }[];
}

export interface FeedSettings {
  enabled: boolean;
  accessMode: string;
  namespace: Record<string, unknown>;
  /** Where the namespace came from: provisioned from `.pkey/release`, or set in the console. */
  namespaceSource?: "manifest" | "console";
  maxPackageBytes: number;
  upstream: "none";
  ext: Record<string, unknown>;
  /** 0 = no row yet: the first save creates it. */
  version: number;
  updatedAt: number | null;
  updatedBy: string | null;
}

export interface FeedPolicy {
  enabled: boolean;
  maxPackageBytesCeiling: number;
  version: number;
  updatedAt: number;
  updatedBy: string | null;
}

/**
 * What one ecosystem's protocol can express: the feed adapter's declaration (worker
 * `services/distribution/registry/adapter.ts` `FeedCapabilities`), exposed on every feed and
 * package. Read it instead of switching on the ecosystem's name.
 */
export interface FeedCapabilities {
  yank: boolean;
  deprecate: boolean;
  yankPolicy: boolean;
  /** How Release channels surface: npm dist-tags, tags, only "latest", or not at all. */
  channels: "dist-tags" | "tags" | "latest" | "none";
  /** The protocol carries a package signature (the feed's `requireSigned` setting applies). */
  signing: boolean;
  immutableVersions: boolean;
  delete: boolean;
  search: boolean;
  /** The challenge a non-public feed answers an anonymous client with. */
  authChallenge: "basic" | "oci-bearer";
  /**
   * One entry per operation (`render`, `serve`, `auth`, `yank`, `unyank`, `deprecate`, `setup`),
   * in the shared adapter base's shape: `{mode: "api", …}` or `{mode: "unsupported", reason}`.
   */
  ops?: Record<string, { mode: string; reason?: string }>;
}

export interface FeedDetailDto extends FeedsHead {
  feed: FeedSummary;
  settings: FeedSettings;
  policy: FeedPolicy | null;
  capabilities: FeedCapabilities;
  /**
   * The extension settings (`settings.ext` keys) the feed's adapter accepts, which the ecosystem
   * panel renders (F-12).
   */
  extensions: string[];
  accessModes: { mode: string; available: boolean }[];
  /** F-21: the ecosystem's packages with no delivery gate, which `entitled` refuses every
   *  licence token for. */
  ungatedPackages?: { id: string; name: string }[];
}

// ── cleanup (F-36; worker `services/release/packages/prune.ts`) ───────────────────────────────

/** The dry run the one-time notice recorded, and the day cleanup starts (epoch seconds). */
export interface FeedPruneNotice {
  noticedAt: number;
  startsAt: number;
  packages: number;
  versions: number;
  bytes: number;
  freedBytes: number;
}

/** `GET <feeds base>/retention`: where the cleanup setting comes from. */
export interface FeedRetentionDto {
  product: string;
  prunePrereleases: boolean;
  locked: boolean;
  /** `default`: nobody chose, so cleanup starts once the notice window has passed. */
  source: "system" | "operator" | "default";
  notice: FeedPruneNotice | null;
  version: number;
}

export interface FeedPruneVersion {
  releaseId: string;
  version: string;
  files: number;
  bytes: number;
  freedBytes: number;
}

export interface FeedPruneKept {
  releaseId: string;
  version: string;
  /** `pinned`: a channel points at it; `referenced`: another row names it. */
  reason: "pinned" | "referenced";
}

export interface FeedPrunePackage {
  deliverableId: string;
  ecosystem: string;
  name: string;
  /** The stable version cleanup prunes below. */
  stable: string;
  prune: FeedPruneVersion[];
  kept: FeedPruneKept[];
  bytes: number;
  freedBytes: number;
  failed?: { version: string; error: string }[];
  skipped?: FeedPruneKept[];
}

/** `POST <feeds base>/prune`: the plan (`dryRun`) or what an apply deleted. */
export interface FeedPruneReport {
  product: string;
  dryRun: boolean;
  retention: FeedRetentionDto;
  packages: FeedPrunePackage[];
  skipped: { deliverableId: string; reason: "no-stable" }[];
  totals: {
    versions: number;
    bytes: number;
    freedBytes: number;
    failed: number;
    skipped: number;
  };
  /** Only with `apply`: more went than one request deletes; run it again. */
  more: boolean;
}

// ── registry tokens (F-21; worker `console/handlers/registryTokens.ts`) ────────────────────────

/** One registry token as the console lists it: never the plaintext or its hash. */
export interface RegistryTokenDto {
  tokenId: string;
  label: string;
  /** The token's last four characters. */
  hint: string;
  scopes: string[];
  /** `null` = every feed of the owner. */
  ecosystems: FeedEcosystem[] | null;
  binding: "owner" | "license";
  licenseId: string | null;
  presentation: "header" | "url";
  createdBy: string;
  createdAt: number;
  expiresAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
  revokedBy: string | null;
  revokeReason: string | null;
  status: "active" | "expired" | "revoked";
  /** F-33b.3: an owner-wide read token, retired; it works until it expires. */
  legacy?: boolean;
}

/** A read service token (a `pkeyci_` holding only `packages:read`): never the token or its hash. */
export interface ServiceTokenDto {
  /** `cit_…`: revoke it with `POST …/tokens/<tokenId>/revoke`. */
  tokenId: string;
  label: string;
  scopes: string[];
  createdBy: string;
  createdAt: number;
  expiresAt: number;
  lastUsedAt: number | null;
  /** The token's last four characters; `null` for a token made before F-33b.4. */
  hint: string | null;
  revokedAt: number | null;
  /** From the audit trail: `admin:<who>`, or `null` when it is not there. */
  revokedBy: string | null;
  /** `manual` (this token) or `revoke_all` (the product-wide revoke); `null` with `revokedBy`. */
  revokeReason: string | null;
  status: "active" | "expired" | "revoked";
}

export interface RegistryTokenFeed {
  ecosystem: FeedEcosystem;
  label: string;
  enabled: boolean;
  accessMode: string;
  baseUrl: string | null;
  /** The feed's namespace (npm `scope`, Maven `groupPrefixes`, …): the setup snippets name it. */
  namespace?: Record<string, unknown>;
}

export interface RegistryTokensDto {
  owner: string;
  registryOrigin: string | null;
  /** The username clients send beside the token (`__token__`). */
  username: string;
  tokens: RegistryTokenDto[];
  /** F-33b.3: the product's read service tokens (none for a licence filter). */
  serviceTokens?: ServiceTokenDto[];
  feeds: RegistryTokenFeed[];
  limits: {
    minDays: number;
    maxDays: number;
    defaultDays: number;
    urlDefaultDays: number;
    perOwner: number;
    perLicense: number;
    /** F-22: a publish token's default and longest expiry, and the ecosystems it may name. */
    serviceDefaultDays?: number;
    serviceMaxDays?: number;
    publishDefaultDays?: number;
    publishMaxDays?: number;
    publishEcosystems?: FeedEcosystem[];
  };
}

export interface MintRegistryTokenBody {
  label: string;
  ecosystems?: FeedEcosystem[] | null;
  expiresInDays?: number;
  /** `"service"` (F-33b.3) mints a `pkeyci_` read service token: only `label` and
   *  `expiresInDays` (1 to 365, default 90) apply. `"owner"` is for publish tokens only. */
  binding: "owner" | "license" | "service";
  licenseId?: string;
  presentation?: "header" | "url";
  /** `["publish"]` for a publish token (owner-bound, named ecosystems): F-22's native clients and
   *  F-23's `docker push`. */
  scopes?: ("read" | "publish")[];
}

/** The answer to a `binding: "service"` mint. */
export interface MintedServiceToken {
  ok: true;
  /** The `pkeyci_` plaintext: in this answer only. */
  token: string;
  view: ServiceTokenDto;
}

export interface MintedRegistryToken {
  ok: true;
  /** The plaintext: in this answer only. */
  token: string;
  view: RegistryTokenDto;
}

export interface FeedSettingsWrite {
  expectedVersion: number;
  enabled?: boolean;
  accessMode?: string;
  namespace?: Record<string, unknown>;
  maxPackageBytes?: number;
  ext?: Record<string, unknown>;
}

export interface FeedPolicyWrite {
  expectedVersion: number;
  enabled?: boolean;
  maxPackageBytesCeiling?: number;
}

export interface FeedTag {
  tag: string;
  channel: string;
  version: string;
}

export interface FeedPackageRow {
  owner: string;
  deliverableId: string;
  name: string;
  versions: number;
  liveVersions: number;
  latestVersion: string | null;
  lastPublishedAt: number | null;
  tags: FeedTag[];
}

export interface FeedPackagesPage {
  items: FeedPackageRow[];
  nextCursor: string | null;
}

export interface FeedPackageFile {
  name: string;
  type: string;
  size: number;
  sha256: string;
  sha512?: string;
  sha1?: string;
  md5?: string;
}

export interface FeedPackageVersion {
  version: string;
  releaseId: string;
  channel: string | null;
  tags: string[];
  state: "live" | "yanked" | "deprecated";
  stateMessage: string | null;
  publishedAt: number;
  source: {
    kind: "oidc" | "static" | "console" | "registry" | "unknown";
    publisher: string | null;
    runUrl: string | null;
    tokenId: string | null;
    /** F-22: the native client that published (`npm`, `twine`, `swift`, `maven`), or null. */
    client?: string | null;
    /** F-23: `oci-push` when the version came through `docker push`. */
    via?: "oci-push" | null;
  };
  size: number;
  files: FeedPackageFile[];
}

export interface FeedPackageDto {
  owner: string;
  ownerName: string;
  ecosystem: FeedEcosystem;
  deliverableId: string;
  name: string;
  baseUrl: string | null;
  capabilities: FeedCapabilities;
  tags: FeedTag[];
  versions: FeedPackageVersion[];
}

export type FeedVersionVerb = "yank" | "unyank" | "deprecate" | "undeprecate";

/** Which console scope a Feeds call is in: the platform's feeds, or one product's. */
export type FeedScope =
  | { kind: "platform" }
  | { kind: "product"; slug: string };

/** The Feeds API base of a scope (F-11). */
const feedsBase = (scope: FeedScope): string =>
  scope.kind === "platform"
    ? "/manage/api/platform/feeds"
    : `${p(scope.slug)}/distribution/feeds`;

/** One package: `:owner/:name` in platform scope, `:name` in product scope. */
const feedPackagePath = (
  scope: FeedScope,
  eco: FeedEcosystem,
  owner: string,
  name: string,
): string =>
  scope.kind === "platform"
    ? `${feedsBase(scope)}/${eco}/packages/${enc(owner)}/${enc(name)}`
    : `${feedsBase(scope)}/${eco}/packages/${enc(name)}`;

export const feedsApi = {
  // ── package feeds (F-11), both scopes ───────────────────────────────────────────
  feedsOverview: (scope: FeedScope) => call<FeedsOverviewDto>(feedsBase(scope)),
  feedDetail: (scope: FeedScope, eco: FeedEcosystem) =>
    call<FeedDetailDto>(`${feedsBase(scope)}/${eco}`),
  /** 409 `version_conflict` when the feed moved past `expectedVersion` (0 creates the row). */
  saveFeedSettings: (
    scope: FeedScope,
    eco: FeedEcosystem,
    body: FeedSettingsWrite,
  ) =>
    call<{ ok: true; settings: FeedSettings }>(
      `${feedsBase(scope)}/${eco}/settings`,
      { method: "PUT", body: JSON.stringify(body) },
    ),
  /** Platform scope only: the ecosystem's kill switch and size ceiling. */
  saveFeedPolicy: (eco: FeedEcosystem, body: FeedPolicyWrite) =>
    call<{ ok: true; policy: FeedPolicy }>(
      `/manage/api/platform/feeds/${eco}/policy`,
      { method: "PUT", body: JSON.stringify(body) },
    ),
  feedPackages: (
    scope: FeedScope,
    eco: FeedEcosystem,
    query: { q?: string; owner?: string; cursor?: string | null } = {},
  ) => {
    const search = new URLSearchParams();
    if (query.q) search.set("q", query.q);
    if (query.owner) search.set("owner", query.owner);
    if (query.cursor) search.set("cursor", query.cursor);
    const qs = search.toString();
    return call<FeedPackagesPage>(
      `${feedsBase(scope)}/${eco}/packages${qs ? `?${qs}` : ""}`,
    );
  },
  feedPackage: (
    scope: FeedScope,
    eco: FeedEcosystem,
    owner: string,
    name: string,
  ) => call<FeedPackageDto>(feedPackagePath(scope, eco, owner, name)),
  feedVersionAction: (
    scope: FeedScope,
    eco: FeedEcosystem,
    owner: string,
    name: string,
    version: string,
    verb: FeedVersionVerb,
    body: { reason?: string; message?: string } = {},
  ) =>
    call<{ ok: true; state: FeedPackageVersion["state"] }>(
      `${feedPackagePath(scope, eco, owner, name)}/versions/${enc(version)}/${verb}`,
      { method: "POST", body: JSON.stringify(body) },
    ),
  rebuildFeed: (scope: FeedScope, eco: FeedEcosystem) =>
    call<{ ok: true; queued: number }>(`${feedsBase(scope)}/${eco}/rebuild`, {
      method: "POST",
    }),
  feedActivity: (scope: FeedScope, eco: FeedEcosystem) =>
    call<{ items: ActivityItem[] }>(`${feedsBase(scope)}/${eco}/activity`),
  /** F-21: the scope's registry tokens (or one licence's), with its feeds for the snippets. */
  registryTokens: (scope: FeedScope, licenseId?: string) =>
    call<RegistryTokensDto>(
      `${feedsBase(scope)}/tokens${licenseId ? `?license=${enc(licenseId)}` : ""}`,
    ),
  mintRegistryToken: (scope: FeedScope, body: MintRegistryTokenBody) =>
    call<MintedRegistryToken>(`${feedsBase(scope)}/tokens`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  /** F-33b.4: a read service token (`binding: "service"`), answered once with the `pkeyci_` value. */
  mintServiceToken: (scope: FeedScope, body: MintRegistryTokenBody) =>
    call<MintedServiceToken>(`${feedsBase(scope)}/tokens`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  revokeRegistryToken: (scope: FeedScope, tokenId: string) =>
    call<{ ok: true; view: RegistryTokenDto }>(
      `${feedsBase(scope)}/tokens/${enc(tokenId)}/revoke`,
      { method: "POST" },
    ),
  revokeAllRegistryTokens: (scope: FeedScope, licenseId?: string) =>
    call<{ ok: true; revoked: number }>(
      `${feedsBase(scope)}/tokens/revoke-all`,
      {
        method: "POST",
        body: JSON.stringify(licenseId ? { licenseId } : {}),
      },
    ),
  /** F-36: the cleanup setting and its notice. */
  feedRetention: (scope: FeedScope) =>
    call<FeedRetentionDto>(`${feedsBase(scope)}/retention`),
  /** F-38a: what cleanup would delete (`apply: false`: a plan, nothing is stored). */
  previewFeedPrune: (scope: FeedScope) =>
    call<FeedPruneReport>(`${feedsBase(scope)}/prune`, {
      method: "POST",
      body: JSON.stringify({ apply: false }),
    }),
  /** F-38a: delete the versions the plan lists now (at most one request's worth). */
  pruneFeeds: (scope: FeedScope) =>
    call<FeedPruneReport>(`${feedsBase(scope)}/prune`, {
      method: "POST",
      body: JSON.stringify({ apply: true }),
    }),
  /** Create (or re-assert) the system product that owns the platform's feeds (F-03). */
  bootstrapPlatformFeeds: () =>
    call<{ ok: true; slug: string; created: boolean }>(
      "/manage/api/platform/feeds/bootstrap",
      { method: "POST" },
    ),
  packageFeeds: (slug: string) =>
    call<{ packageFeeds: PackageFeedsSwitch }>(
      `${p(slug)}/distribution/package-feeds`,
    ),
  /** 409 `version_conflict` when the switch moved past `expectedVersion` (0 = never written). */
  savePackageFeeds: (
    slug: string,
    body: { enabled: boolean; expectedVersion: number },
  ) =>
    call<{ ok: true; packageFeeds: PackageFeedsSwitch }>(
      `${p(slug)}/distribution/package-feeds`,
      { method: "PUT", body: JSON.stringify(body) },
    ),
};
