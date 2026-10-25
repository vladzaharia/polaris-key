/**
 * The release slice of the console API (P0-32.22): the truth store, packs, the compatibility matrix, channel policy and release health.
 * Types and the `releaseApi` methods live together; `api.ts` re-exports the types and spreads the methods.
 */
import { RELEASE_POLICY_ERROR_MESSAGES } from "../../lib/releasePolicyMessages.js";
import { HttpError, call, enc, p } from "./transport.js";
import type { SettingsSource } from "./update.js";
import type { ArtifactRole } from "@polaris-key/manifest";

type ReleaseHealthStatus =
  | "healthy"
  | "needs-setup"
  | "not-configured"
  | "error";

type ReleaseHealthCheckStatus = "ok" | "missing" | "warning" | "error";

export interface ReleaseHealthCheck {
  id: string;
  label: string;
  status: ReleaseHealthCheckStatus;
  message?: string;
  missing?: string[];
  /** Files the check is about: what the latest release carries (`release-artifacts`), the file
   *  a declared artifact entry matched, or an ambiguous entry's candidates. */
  files?: ReleaseHealthFile[];
}

export interface ReleaseHealthFile {
  name: string;
  platform?: string;
  arch?: string;
  format?: string;
}

export interface ReleaseHealth {
  status: ReleaseHealthStatus;
  healthy: boolean;
  missing: string[];
  checks: ReleaseHealthCheck[];
  release?: {
    tag: string;
    name: string | null;
    prerelease: boolean;
    assetCount: number;
    htmlUrl: string;
  };
}

// ── release truth store ───────────────────────────────────────────────────────
/**
 * Where an artifact's bytes live (`@polaris-key/manifest` `DescriptorLocation`, P2-04). Every
 * location is pinned by the artifact's SHA-256; `store` carries no bytes of ours.
 */
export type ArtifactLocationDto =
  | { provider: "r2"; key: string }
  | { provider: "github"; asset: string }
  | { provider: "store" }
  | { provider: "external"; url: string };

export interface ReleaseArtifactDto {
  artifactId: string;
  name: string;
  kind: string | null;
  platform: string | null;
  arch: string | null;
  sizeBytes: number | null;
  access: string | null;
  /** The build this file belongs to (P2-04's descriptor); `null` for a file the GitHub sync
   *  indexed without one. */
  buildId: string | null;
  /** `ARTIFACT_ROLES` in `@polaris-key/manifest`: payload, signature, checksum, … */
  role: ArtifactRole | (string & {}) | null;
  sha256: string | null;
  /** As the descriptor declared them; `null` for a file only the GitHub sync knows. */
  locations: ArtifactLocationDto[] | null;
}

/** One build of a release (P2-04 descriptor; worker `release_builds`). */
export interface ReleaseBuildDto {
  buildId: string;
  /** `null` = platform-independent (a pack variant). */
  platform: string | null;
  arch: string;
  format: string | null;
  buildNumber: string | null;
  minOs: string | null;
  /** P4-09: the pack ids this build ships embedded; `null` (or absent) when its descriptor said
   *  nothing about embedding. */
  embeds?: string[] | null;
}

/** A release's yank (P2-05): never offered on a moving selector; resolves only by pin. */
export interface ReleaseYankDto {
  reason: string;
  at: number;
  /** `admin:<sub>` or `ci:<subject>`. */
  by: string;
}

export interface ReleaseDto {
  releaseId: string;
  version: string;
  title: string | null;
  publishedAt: number | null;
  sourceUrl: string | null;
  status: string;
  artifacts: ReleaseArtifactDto[];
  /** The deliverable this is a release of (`app` until packs exist). */
  deliverable: string;
  seq: number | null;
  /** The channel it was published to; `null` = derived from GitHub's prerelease flag. */
  channel: string | null;
  yank: ReleaseYankDto | null;
  /** Empty for a legacy release no descriptor described. */
  builds: ReleaseBuildDto[];
  /** P4-09: the app release's `content.contentApi`; `null` before its product declared packs. */
  contentApi?: number | null;
  /** P4-09: the exact pack release each pack is pinned to (a mirror of the signed `content`). */
  pins?: AppPinDto[];
  /**
   * Who signed the release record: the CI release key (AGENTS rule 2), with the record's hash.
   * `null` for a release no signed record describes (a legacy GitHub-synced release); absent from
   * a Worker that predates the field.
   */
  signer?: { kind: "release"; kid: string; recordSha256: string } | null;
}

/** One pin of an app release (worker `release_pins`, P4-02). */
export interface AppPinDto {
  pack: string;
  packReleaseId: string;
  /** `null` when the pinned release's row is gone. */
  packVersion: string | null;
  /** The pinned pack release's yank: a yank never changes an existing pin. */
  packYank: ReleaseYankDto | null;
  /** The app release's `expects` entry for the pack. */
  required: boolean;
  delivery: string;
  recordSha256: string;
}

// ── pack deliverables (P4-09; worker `release/packs/adminView.ts`) ─────────────

/** One row of `GET …/release/deliverables`: the app or a pack. */
export interface DeliverableDto {
  id: string;
  /** `app`, `pack` or (F-03) `package`. */
  kind: string;
  /** The pack type, or a package's ecosystem; `null` for the app. */
  type: string | null;
  /** False for a pack whose stored declaration does not read back (a resync rewrites it). */
  declared: boolean;
  binding: string | null;
  required: boolean | null;
  /** `embedded` or `none` for a pack. */
  baseline: string | null;
  delivery: string | null;
  variantKeys: string[];
  /** The licence flag `.pkey/release` asserts; never the gate. */
  assertedEntitlement: string | null;
  /** The delivery gate (Distribution's access row for this deliverable), or `null`. */
  gate: string | null;
  latest: {
    releaseId: string;
    version: string;
    seq: number | null;
    publishedAt: number | null;
    yanked: boolean;
    /** The latest pack release's signed `entitlement`, or `null`. */
    entitlement: string | null;
  } | null;
  releaseCount: number;
  /** Distinct app releases pinning some release of this pack; `null` for the app. */
  pinnedByAppReleases: number | null;
}

/** One row of `GET …/release/delegations` (P4-19, worker `release/packs/adminView.ts`): a
 *  delegated content key. Read-only: minting and revoking are CI acts. */
export interface DelegationDto {
  sha256: string;
  scope: string;
  types: string[];
  effectiveTypes: string[];
  seq: number;
  issuedAt: number;
  expiresAt: number;
  status: "active" | "closed" | "revoked";
  origin: "submit" | "revocation";
  signedBy: string;
  keyFingerprint: string;
  releaseCount: number;
  revocation: {
    sha256: string;
    kid: string | null;
    reason: string | null;
    issuedAt: number | null;
  } | null;
}

export interface DelegationsResponse {
  delegations: DelegationDto[];
}

export interface DeliverablesResponse {
  deliverables: DeliverableDto[];
  /** False while Distribution is off: `gate` is unknown then, not "ungated". */
  gateKnown: boolean;
}

/** One entry of a pack variant's delta menu, as the signed record gives it. */
export interface PackDeltaDto {
  /** `payload` (one patch) or `files` (a per-entry patch set). */
  scope: string;
  method: string | null;
  /** The base's `payload.sha256`. */
  from: string | null;
  /** The version of this pack's release that has that base, when one does. */
  fromVersion: string | null;
  /** Stored bytes a device downloads for this strategy. */
  bytes: number;
  memBytes: number | null;
}

export interface PackVariantDto {
  /** `""` for an unvaried pack. */
  variantKey: string;
  variant: Record<string, string>;
  engine: string | null;
  payload: { size: number; sha256: string };
  /** Stored bytes of the whole payload (the full download). */
  fullBytes: number | null;
  indexBytes: number | null;
  deltas: PackDeltaDto[];
}

export interface PinnedByDto {
  appReleaseId: string;
  appVersion: string | null;
  appYank: ReleaseYankDto | null;
  required: boolean;
  delivery: string;
  recordSha256: string;
}

export interface PackReleaseDto {
  releaseId: string;
  version: string;
  seq: number | null;
  channel: string | null;
  publishedAt: number | null;
  yank: ReleaseYankDto | null;
  recordSha256: string | null;
  formatVersion: number | null;
  entitlement: string | null;
  /** P4-19: who signed the record (absent from a Worker before P4-19). */
  signer?:
    | { kind: "release"; kid: string }
    | { kind: "delegated"; delegation: string; scope: string; seq: number }
    | null;
  variants: PackVariantDto[];
  /** Every app release that pins this pack release, yanked or not. */
  pinnedBy: PinnedByDto[];
}

export interface PackReleasesResponse {
  deliverable: string;
  releases: PackReleaseDto[];
}

/** One file of a pack variant, from its files index (never where its blob is stored). */
export interface PackFileDto {
  path: string;
  size: number;
  sha256: string;
  /** Container layout only. */
  offset: number | null;
  blob: { sha256: string; bytes: number; codec: string };
}

export interface PackFilesResponse {
  deliverable: string;
  releaseId: string;
  variant: string;
  /** At most 2,000; `total` is how many the index lists. */
  files: PackFileDto[];
  total: number;
}

// ── release: the compatibility matrix (P4-15; worker `release/packs/compat.ts`) ─────
export type CompatCellState =
  | "pinned"
  | "held"
  | "compatible"
  | "incompatible"
  | "revoked";

export interface CompatYankDto {
  reason: string;
  at: number;
  by: string;
}

export interface CompatAppReleaseDto {
  releaseId: string;
  version: string;
  seq: number | null;
  channel: string | null;
  contentApi: number | null;
  live: boolean;
  liveOn: string[];
  yanked: CompatYankDto | null;
  platforms: string[];
  engines: string[];
  pins: { pack: string; releaseId: string }[];
  holds: { pack: string; releaseId: string }[];
  unsatisfied: {
    pack: string;
    reason: string;
    detail: string;
    channel: string;
    platform: string;
    engine: string;
    variant: string;
  }[];
}

export interface CompatPackReleaseDto {
  pack: string;
  releaseId: string;
  version: string;
  seq: number | null;
  sha256: string | null;
  channel: string | null;
  requires: { contentApi: string[]; engines: string[] };
  yanked: CompatYankDto | null;
  revoked: {
    kind: "record" | "delegation";
    recordSha256: string;
    reason: string;
    issuedAt: number;
    replacement: { releaseId: string; sha256: string } | null;
  } | null;
  current: boolean;
}

export interface CompatCellDto {
  appReleaseId: string;
  packReleaseId: string;
  state: CompatCellState;
  current: boolean;
  yanked: boolean;
  reason: string;
}

/** `GET …/release/compat`. */
export interface CompatResponse {
  channels: string[];
  liveLevels: Record<string, number[]>;
  levels: number[];
  limit: number;
  packs: { id: string; binding: string; required: boolean; delivery: string }[];
  appReleases: CompatAppReleaseDto[];
  packReleases: CompatPackReleaseDto[];
  cells: CompatCellDto[];
  hidden: { appReleases: number; packReleases: number };
  /** The page's window start; `older` is what lies past it; `capped` that the 200-row cap cut. */
  offset: number;
  capped: boolean;
  older: { appReleases: number; packReleases: number };
  resolvedAt: number | null;
}

export interface ReleaseChannelDto {
  channel: string;
  releaseId: string;
  modifiedAt: number | null;
}

/**
 * A channel's anti-rollback floor (P0-02, R6-10): the highest version a sync has seen on it. An
 * operator may lower or clear it (`…/release/channels/<channel>/floor`), never raise it.
 */
export interface ReleaseChannelFloorDto {
  channel: string;
  version: string;
  releaseId: string | null;
  raisedAt: number;
  loweredBy: string | null;
  loweredAt: number | null;
}

export interface ReleaseStoreResponse {
  releases: ReleaseDto[];
  channels: ReleaseChannelDto[];
  floors: ReleaseChannelFloorDto[];
}

/**
 * One channel's policy as `GET …/release/channels` returns it (worker `policy.ts`
 * `ChannelPolicyView`, plus what it resolves to). The console renders `resolved` and
 * `byPlatform` as they are: it never recomputes resolution.
 */
export interface ChannelPolicyDto {
  deliverable: string;
  channel: string;
  /** A release id, or `null` to follow the newest eligible release. */
  pointer: string | null;
  pinned: boolean;
  /** Channels this one includes; `null` = the default (beta includes stable). */
  includes: string[] | null;
  /** The device floor the signed feed carries (P2-03, P3-03). */
  minSupported: string | null;
  critical: boolean;
  /** `manifest` until an operator or CI changes the row; `admin` from then on. */
  source: SettingsSource;
  modifiedAt: number | null;
  modifiedBy: string | null;
  /** The release the channel resolves to with no platform filter, or `null`. */
  resolved: string | null;
  /** Platform → the release the channel resolves to there (`null`: nothing qualifies). */
  byPlatform: Record<string, string | null>;
  /** A pack's floors per contentApi line on this channel (P4-12); absent for the app. */
  packFloors?: {
    contentApi: number;
    minSupported: string;
    modifiedAt: number;
    modifiedBy: string | null;
  }[];
}

export interface ReleaseChannelsResponse {
  deliverables: Array<{
    deliverable: string;
    kind: string;
    /** Every platform some build of the deliverable declares, sorted. */
    platforms: string[];
    channels: ChannelPolicyDto[];
  }>;
}

/** `PUT …/release/channels/<channel>`: any of these; an omitted field is left as it is. */
export interface ChannelPolicyBody {
  deliverable?: string;
  pointer?: string | null;
  pinned?: boolean;
  minSupported?: string | null;
  critical?: boolean;
  /**
   * A pack's floor for one contentApi line (P4-12): with `minSupported` (a version, or `null` to
   * clear) and `deliverable`, and nothing else.
   */
  contentApi?: number;
}

/** `POST …/release/channels/<channel>/floor`: lower to a version, or clear. Never raises. */
export type ChannelFloorBody = { version: string } | { clear: true };

export { RELEASE_POLICY_ERROR_MESSAGES };

/** The console's wording for a release policy refusal. */
export function releasePolicyMessage(err: unknown): string {
  if (err instanceof HttpError) {
    const known = err.reason
      ? RELEASE_POLICY_ERROR_MESSAGES[err.reason]
      : undefined;
    if (known) return known;
    if (err.message && err.message !== `http ${err.status}`) return err.message;
    return `Request failed (${err.status}).`;
  }
  return err instanceof Error ? err.message : "Request failed.";
}

/** `GET …/release/ci-readiness` (A-32.3): what stands between the repository and a publishing tag. */
export type CiReadinessState = "ok" | "missing" | "unknown";

export interface CiReadinessCheck {
  id:
    | "app"
    | "release-manifest"
    | "workflow"
    | "environment"
    | "ruleset"
    | "publisher"
    | "distribution-pr";
  state: CiReadinessState;
  /** The App permission to grant, on an `unknown` read the installation cannot make. */
  permission?: string;
  /** A name or a reason, never content. */
  detail?: string;
}

export interface CiReadiness {
  repository: string | null;
  capabilities: {
    pullRequest: boolean;
    workflow: boolean;
    environment: boolean;
    ruleset: boolean;
  };
  checks: CiReadinessCheck[];
  workflowPreview: string | null;
}

/** `POST …/release/ci-readiness/fix` (A-32.6): what one fix did. */
export type CiFixCheck = "environment" | "ruleset";

export interface CiFixResult {
  ok: true;
  repository: string;
  results: {
    id: CiFixCheck;
    state: "created" | "updated" | "ok" | "skipped";
    detail?: string;
  }[];
}

export const releaseApi = {
  /** A-32.6: create the release environment and/or the `v*` tag ruleset. A 409 names the permission. */
  fixCiReadiness: (slug: string, checks: CiFixCheck[]) =>
    call<CiFixResult>(`${p(slug)}/release/ci-readiness/fix`, {
      method: "POST",
      body: JSON.stringify({ checks }),
    }),
  /** A-32.3: the CI readiness checks, the App's write capabilities and the workflow preview. */
  ciReadiness: (slug: string) =>
    call<CiReadiness>(`${p(slug)}/release/ci-readiness`),
  releaseHealth: (slug: string) =>
    call<{ health: ReleaseHealth }>(`${p(slug)}/release/health`),
  /** The release TRUTH STORE (`release_metadata`/`_artifacts`/`_channels`, P2.T2) — what
   *  Polaris Key believes the linked repo publishes, without spending a GitHub round-trip. */
  releases: (slug: string) =>
    call<ReleaseStoreResponse>(`${p(slug)}/release/releases`),
  /** P4-09: the app and every pack, with its declaration, gate and latest release. */
  deliverables: (slug: string) =>
    call<DeliverablesResponse>(`${p(slug)}/release/deliverables`),
  /** P4-19: the product's delegated content keys, read-only. */
  delegations: (slug: string) =>
    call<DelegationsResponse>(`${p(slug)}/release/delegations`),
  /** P4-09: a pack's releases, newest first, each with the app releases that pin it. */
  packReleases: (slug: string, deliverable: string) =>
    call<PackReleasesResponse>(
      `${p(slug)}/release/deliverables/${enc(deliverable)}/releases`,
    ),
  /** P4-09: one variant's files (`variant` is `""` for an unvaried pack), read from its index. */
  packFiles: (
    slug: string,
    deliverable: string,
    releaseId: string,
    variant: string,
  ) =>
    call<PackFilesResponse>(
      `${p(slug)}/release/deliverables/${enc(deliverable)}/releases/${enc(releaseId)}/files?variant=${enc(variant)}`,
    ),
  /** P4-15: app releases × pack releases, a state per pair, the live contentApi levels. */
  releaseCompat: (
    slug: string,
    opts: { limit?: number; offset?: number } = {},
  ) => {
    const q = new URLSearchParams();
    if (opts.limit !== undefined) q.set("limit", String(opts.limit));
    if (opts.offset !== undefined && opts.offset > 0)
      q.set("offset", String(opts.offset));
    const qs = q.toString();
    return call<CompatResponse>(
      `${p(slug)}/release/compat${qs ? `?${qs}` : ""}`,
    );
  },
  // ── release channel policy (P2-05 admin routes; worker `release/admin.ts`) ────
  /** Every deliverable's channels: policy, source, and what each resolves to, per platform. */
  releaseChannels: (slug: string) =>
    call<ReleaseChannelsResponse>(`${p(slug)}/release/channels`),
  /** Promote (`pointer`), pin (`pointer` + `pinned: true`), unpin (`pinned: false`), the device
   *  floor (`minSupported`) and `critical`. Claims the row for the operator. */
  updateReleaseChannel: (
    slug: string,
    channel: string,
    body: ChannelPolicyBody,
  ) =>
    call<{ ok: true; policy: ChannelPolicyDto }>(
      `${p(slug)}/release/channels/${enc(channel)}`,
      { method: "PUT", body: JSON.stringify(body) },
    ),
  /** Hand the channel back to the manifest. Changes nothing live — the manifest's declaration
   *  re-applies on the NEXT resync. */
  revertReleaseChannel: (slug: string, channel: string, deliverable?: string) =>
    call<{ ok: true; policy: ChannelPolicyDto }>(
      `${p(slug)}/release/channels/${enc(channel)}/revert`,
      {
        method: "POST",
        body: JSON.stringify(deliverable ? { deliverable } : {}),
      },
    ),
  /** Lower or clear a channel's anti-rollback floor (P0-02). The server refuses a raise. */
  setChannelFloor: (slug: string, channel: string, body: ChannelFloorBody) =>
    call<{ ok: true; channel: string; floor: ReleaseChannelFloorDto | null }>(
      `${p(slug)}/release/channels/${enc(channel)}/floor`,
      { method: "POST", body: JSON.stringify(body) },
    ),
  yankRelease: (slug: string, releaseId: string, reason: string) =>
    call<{ ok: true }>(`${p(slug)}/release/releases/${enc(releaseId)}/yank`, {
      method: "POST",
      body: JSON.stringify({ reason }),
    }),
  unyankRelease: (slug: string, releaseId: string) =>
    call<{ ok: true }>(`${p(slug)}/release/releases/${enc(releaseId)}/yank`, {
      method: "DELETE",
    }),
};
