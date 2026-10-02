// @polaris-key/protocol/update — Update service wire types (spec §4.1; the feed and the
// decision, WIRE-CONTRACT-V4 §2.3 and plans/P3-01.md §2.8).

import type { OutletCapabilities, OutletKind } from "./distribution.js";
import type { AppContent, ContentHold } from "./packs.js";
import type { ReleaseRecordDoc } from "./release.js";

export { MAX_FEED_REVOCATIONS } from "./core.js";

/** Architectures the appcast can target (`?arch=` on `/update/appcast.xml`). The
 *  unparameterized feed serves `arm64` for continuity with shipped SUFeedURLs. */
export type UpdateArch = "arm64" | "x86_64";

// ── The channel feed, `pkey-feed+jws` (WIRE-CONTRACT-V4 §2.3) ───────────────────────────────
//
// Signed by the product key, device-less, one per (product, canonical channel). Every integer
// field is an integer claim (a plain integer token from its minimum to 2^53 − 1).

/** The version schemes a feed may name; equal to `@polaris-key/manifest`'s `VERSION_SCHEMES`
 *  (a test keeps them so). Not an enum: `semver+build` and `4part` are no identifiers. */
export const FEED_VERSION_SCHEMES = [
  "semver",
  "semver+build",
  "4part",
] as const;
export type FeedVersionScheme = (typeof FEED_VERSION_SCHEMES)[number];

/** `expiresAt = issuedAt + FEED_TTL_SECONDS` for every feed the Worker signs. */
export const FEED_TTL_SECONDS = 900;
/** A verifier refuses `expiresAt > issuedAt + MAX_FEED_TTL_SECONDS`. */
export const MAX_FEED_TTL_SECONDS = 3600;
/** A rollout's `bp` is in basis points, from 0 to this. */
export const ROLLOUT_BUCKETS = 10000;
/** A target's `platform`: ASCII, `OUTLET_ID_PATTERN`'s shape. Unknown values that match are
 *  allowed; a client reads only its own. */
export const FEED_PLATFORM_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;

/** What a target pins: the record's hash, `seq` and version. */
export interface ReleasePin {
  sha256: string;
  seq: number;
  version: string;
}

export interface FeedRollout {
  bp: number;
  /** 32 lowercase hex, hashed as text. */
  salt: string;
}

export interface FeedOutletEntry {
  kind: string;
  live: { version: string; seq: number } | null;
  halted: boolean;
  rollout?: FeedRollout;
  listingUrl?: string;
  capabilities?: Partial<OutletCapabilities>;
}

export interface FeedTarget {
  platform: string;
  release: ReleasePin;
  /** This platform's floor, never above its own pin. Required; may be null. */
  floor: { minVersion: string } | null;
  critical: boolean;
  /** Keyed by the product's outlet id. */
  outlets: Record<string, FeedOutletEntry>;
}

export interface FeedApp {
  deliverable: "app";
  versionScheme: FeedVersionScheme;
  targets: FeedTarget[];
}

export interface FeedSelector {
  platform?: string;
}

export interface ChannelFeedDoc {
  schemaVersion: 1;
  iss: string;
  aud: string;
  /** The canonical channel, which keys the client's `seq` floor. Never `latest`. */
  channel: string;
  selector: FeedSelector;
  seq: number;
  issuedAt: number;
  expiresAt: number;
  app: FeedApp;
  /** The content members (plans/P4-13.md §2.2, V4 §2.4.1): read with `feedContent` beside the
   *  claims, never a claim. A malformed member is unusable, never a refusal of the feed. */
  packSets?: FeedPackSets;
  packFloors?: FeedPackFloor[];
  revocations?: FeedRevocation[];
}

// ── The feed's content members (plans/P4-13.md §2.2, WIRE-CONTRACT-V4 §2.4.1) ────────────────

/** One pack release the feed's sets name, keyed by its record hash in `packSets.releases`. */
export interface FeedPackRelease {
  pack: string;
  version: string;
  seq: number;
}

/** One stored resolution row (P4-12's `release_sets`, one per group) of the app deliverable. */
export interface FeedPackRow {
  contentApi: number;
  platform: string;
  /** `godot-<major>.<minor>`, or `""` for builds that declared no engine (exact match only). */
  engine: string;
  /** 0–4 axis → value members; `{}` for an axis-less group. */
  variant: Record<string, string>;
  /** A key of `packSets.sets`. */
  set: string;
}

/** A per-outlet pack rollout or halt, keyed by the gated release's record hash (P4-14 fills it). */
export interface FeedPackGate {
  halted: boolean;
  rollout?: FeedRollout;
  /** The release a device out of the gate takes instead, a key of `releases`; null for none. */
  fallback: string | null;
}

/** Per-outlet narrowing and gates. */
export interface FeedPackOutlet {
  /** Packs whose transport on this outlet cannot float: they never take a feed target. */
  pinned?: string[];
  gates?: Record<string, FeedPackGate>;
}

export interface FeedPackSets {
  /** Record hash → release. */
  releases: Record<string, FeedPackRelease>;
  /** `packSetId` → member record hashes, sorted by pack-id bytes. */
  sets: Record<string, string[]>;
  rows: FeedPackRow[];
  outlets?: Record<string, FeedPackOutlet>;
}

/** The effective floor of one pack at one live level. */
export interface FeedPackFloor {
  pack: string;
  contentApi: number;
  minVersion: string;
  /** A `FEED_VERSION_SCHEMES` value; an entry with any other is ignored. */
  versionScheme: string;
}

/** One revocation in force: the revocation record's hash and its target's pin. */
export interface FeedRevocation {
  /** The revocation record's hash (fetch it from the record route). */
  record: string;
  pack: string;
  /** The revoked pack record's hash. */
  target: string;
  version: string;
  seq: number;
  /** `delegation` when the target is a delegation record (plans/P4-19.md §2.7); absent for a
   *  pack record target. */
  kind?: "delegation";
}

/** `feedContent`'s answer: each member parsed, or null when absent or unusable. */
export interface FeedContent {
  packSets: FeedPackSets | null;
  packFloors: FeedPackFloor[] | null;
  revocations: FeedRevocation[] | null;
}

// ── The update decision (plans/P3-01.md §2.8) ───────────────────────────────────────────────

/** Closed vocabularies, in order. P4-13 filled P3-01's reserved values: `packs`,
 *  `content-floor` and `revoked-content` (plans/P4-13.md §2.6). */
export const UPDATE_ACTIONS = [
  "none",
  "code-ready",
  "binary",
  "store",
  "platform",
  "blocked",
  "packs",
] as const;
export type UpdateAction = (typeof UPDATE_ACTIONS)[number];

export const NONE_REASONS = [
  "up-to-date",
  "behind",
  "not-available",
  "halted",
  "out-of-bucket",
  "stale",
  "skipped",
  "no-method",
  "no-build",
  "unknown-version",
] as const;
export type UpdateNoneReason = (typeof NONE_REASONS)[number];

export const BLOCKED_REASONS = [
  "app-floor",
  "content-floor",
  "revoked-content",
] as const;
export type UpdateBlockedReason = (typeof BLOCKED_REASONS)[number];

/** A content block on an offer or an app-floor answer (plans/P4-13.md §2.6). */
export type ContentBlock = "content-floor" | "revoked-content";

export const BINARY_METHODS = ["native", "download", "sidecar-pck"] as const;
export type BinaryMethod = (typeof BINARY_METHODS)[number];

/** The install's outlet: the product's outlet id and its kind (`resolveUpdateOutlet`). */
export interface UpdateOutlet {
  id: string | null;
  kind: OutletKind | "unknown";
}

export interface InstalledBuild {
  version: string;
  /** Defaults to `version`. */
  binaryVersion?: string;
  buildNumber: string | null;
  platform: string;
  arch: string;
  format: string | null;
  /** `godot-<major>.<minor>`; null outside Godot. */
  engine: string | null;
}

/** An update the host staged and verified, under the `UpdateCheck.channel` it was staged on. */
export interface StagedUpdate {
  version: string;
  channel: string;
}

/** One stored, verified revocation the decision applies (one per target: the winner of
 *  `newerRevocation`), with its replacement's state (plans/P4-13.md §2.5 step 12). */
export interface ContentRevocationInput {
  target: string;
  pack: string;
  replacement: ReleasePin | null;
  /** True only when the replacement was fetched, verified, is not itself revoked and
   *  `selectVariant` picks a variant for the host. False while it is still unfetched. */
  replacementUsable: boolean;
}

/** The decision's content input (plans/P4-13.md §2.6). Absent: every rule is P3-01's. */
export interface UpdateContentInput {
  /** The running build's content stamp; `holds` is `holdsOf`'s answer (null when unusable). */
  stamp: Omit<AppContent, "holds"> & { holds: ContentHold[] | null };
  /** The pack state's active installs, embedded baselines included, by pack id. */
  active: Record<string, ReleasePin>;
  /** The host's variant preferences (`VariantPrefs.axes`). */
  axes: Record<string, string[]>;
  revocations: ContentRevocationInput[];
  /** The rollout bucket per gate salt (null: out of every gate's rollout). */
  buckets: Record<string, number | null>;
}

export interface UpdateDecisionInput {
  now: number;
  feed: ChannelFeedDoc;
  record: ReleaseRecordDoc | null;
  installed: InstalledBuild;
  outlet: UpdateOutlet;
  subkind: string | null;
  staged: StagedUpdate | null;
  skipVersion: string | null;
  bucket: number | null;
  methods: BinaryMethod[];
  content?: UpdateContentInput;
}

/** A pack and the release to take: an install, or a prestage entry. */
export interface PackTarget {
  pack: string;
  release: ReleasePin;
}

export interface DecisionRelease {
  version: string;
  seq: number;
  /** On `code-ready` and `binary` only. */
  sha256?: string;
}

export type UpdateDecision =
  | {
      action: "none";
      reason: UpdateNoneReason;
      behind: boolean;
      discardStaged: boolean;
    }
  | {
      action: "code-ready";
      release: DecisionRelease;
      critical: boolean;
      discardStaged: false;
    }
  | {
      action: "binary";
      method: BinaryMethod;
      release: DecisionRelease;
      build: string;
      mandatory: boolean;
      critical: boolean;
      /** The new level's required and essential packs, minus the build's `embeds`, sorted by
       *  pack-id bytes; `[]` when the level does not change (plans/P4-13.md §2.6). */
      prestage: PackTarget[];
      discardStaged: boolean;
      contentBlock?: ContentBlock;
    }
  | {
      action: "store";
      release: DecisionRelease;
      listingUrl: string | null;
      mandatory: boolean;
      critical: boolean;
      discardStaged: boolean;
      contentBlock?: ContentBlock;
    }
  | {
      action: "platform";
      release: DecisionRelease;
      mandatory: boolean;
      critical: boolean;
      discardStaged: boolean;
      contentBlock?: ContentBlock;
    }
  | {
      action: "blocked";
      reason: UpdateBlockedReason;
      discardStaged: boolean;
      /** On `app-floor` only. */
      contentBlock?: ContentBlock;
    }
  | PacksDecision;

/** `packs` (plans/P4-13.md §2.6): install and revoke lists, and the effective set. */
export interface PacksDecision {
  action: "packs";
  install: PackTarget[];
  revoke: string[];
  /** The effective release of every known pack. */
  set: { pack: string; sha256: string }[];
  discardStaged: boolean;
}

/** What `client.update.decide()` returns in every SDK (plans/P3-01.md §2.5). */
export interface UpdateCheck {
  /** The canonical channel: the `channel` claim of the feed the decision used. */
  channel: string;
  decision: UpdateDecision;
  feed: "network" | "committed";
  record: "network" | "cache" | "none";
  errors: { code: string; detail: string | null }[];
}
