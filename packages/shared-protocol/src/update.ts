// @polaris-key/protocol/update — Update service wire types (spec §4.1; the feed and the
// decision, WIRE-CONTRACT-V4 §2.3 and plans/P3-01.md §2.8).

import type { OutletCapabilities, OutletKind } from "./distribution.js";
import type { ReleaseRecordDoc } from "./release.js";

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
}

// ── The update decision (plans/P3-01.md §2.8) ───────────────────────────────────────────────

/** Closed vocabularies, in order. A reserved value (`packs`, `content-floor`,
 *  `revoked-content`) is added by its own plan-mode package, never here. */
export const UPDATE_ACTIONS = [
  "none",
  "code-ready",
  "binary",
  "store",
  "platform",
  "blocked",
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

export const BLOCKED_REASONS = ["app-floor"] as const;
export type UpdateBlockedReason = (typeof BLOCKED_REASONS)[number];

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
      prestage: [];
      discardStaged: boolean;
    }
  | {
      action: "store";
      release: DecisionRelease;
      listingUrl: string | null;
      mandatory: boolean;
      critical: boolean;
      discardStaged: boolean;
    }
  | {
      action: "platform";
      release: DecisionRelease;
      mandatory: boolean;
      critical: boolean;
      discardStaged: boolean;
    }
  | {
      action: "blocked";
      reason: UpdateBlockedReason;
      discardStaged: boolean;
    };

/** What `client.update.decide()` returns in every SDK (plans/P3-01.md §2.5). */
export interface UpdateCheck {
  /** The canonical channel: the `channel` claim of the feed the decision used. */
  channel: string;
  decision: UpdateDecision;
  feed: "network" | "committed";
  record: "network" | "cache" | "none";
  errors: { code: string; detail: string | null }[];
}
