/**
 * App Store Connect → Polaris Key vocabulary (P5-02). Pure: no I/O, so every mapping is a table
 * the tests walk exhaustively.
 *
 * The target vocabularies are P2b-03's (`services/distribution/availability.ts`): availability
 * `pending | processing | in-review | approved | live | rejected | removed`, submission
 * `prepared | submitted | in-review | approved | rejected | pending-developer-release |
 * released | cancelled`. The P5-02 brief proposed two states P2b-03 lacks; they map onto it:
 *
 *   - "approved-held" (`PENDING_DEVELOPER_RELEASE`) → availability `approved` + submission
 *     `pending-developer-release`, which already says exactly that;
 *   - "superseded" (`REPLACED_WITH_NEW_VERSION`, a Background Asset `SUPERSEDED`) → availability
 *     `removed`: the object is no longer what the store distributes.
 *
 * The store's own state is always kept verbatim beside the mapped one (`detail.ascState`, the
 * connector object's `store_state`), so nothing is lost by the mapping.
 */

import type { AvailabilityState, SubmissionState } from "../../availability.js";

// ── Webhook event types ──────────────────────────────────────────────────────────────────────

/** `WebhookEventType`: exactly 12 values (ASC API 4.5; S-07 row 16, re-checked 2026-09-30). */
export const ASC_WEBHOOK_EVENT_TYPES = [
  "APP_STORE_VERSION_APP_VERSION_STATE_UPDATED",
  "BUILD_UPLOAD_STATE_UPDATED",
  "BUILD_BETA_DETAIL_EXTERNAL_BUILD_STATE_UPDATED",
  "BETA_FEEDBACK_SCREENSHOT_SUBMISSION_CREATED",
  "BETA_FEEDBACK_CRASH_SUBMISSION_CREATED",
  "BACKGROUND_ASSET_VERSION_STATE_UPDATED",
  "BACKGROUND_ASSET_VERSION_INTERNAL_BETA_RELEASE_CREATED",
  "BACKGROUND_ASSET_VERSION_EXTERNAL_BETA_RELEASE_STATE_UPDATED",
  "BACKGROUND_ASSET_VERSION_APP_STORE_RELEASE_STATE_UPDATED",
  "ALTERNATIVE_DISTRIBUTION_PACKAGE_VERSION_CREATED",
  "ALTERNATIVE_DISTRIBUTION_PACKAGE_AVAILABLE_UPDATED",
  "ALTERNATIVE_DISTRIBUTION_TERRITORY_AVAILABILITY_UPDATED",
] as const;
export type AscWebhookEventType = (typeof ASC_WEBHOOK_EVENT_TYPES)[number];

/** What the connector does with each event type. */
export type AscEventEffect =
  /** availability + submission of the app release on `app-store` */
  | "app-store-version"
  /** build processed; availability on `testflight` */
  | "build-upload"
  /** availability on `testflight` */
  | "build-beta-detail"
  /** availability with transport `apple-ba` */
  | "background-asset"
  /** stored raw, no state change */
  | "store-only";

export const ASC_EVENT_EFFECTS: Readonly<
  Record<AscWebhookEventType, AscEventEffect>
> = {
  APP_STORE_VERSION_APP_VERSION_STATE_UPDATED: "app-store-version",
  BUILD_UPLOAD_STATE_UPDATED: "build-upload",
  BUILD_BETA_DETAIL_EXTERNAL_BUILD_STATE_UPDATED: "build-beta-detail",
  BETA_FEEDBACK_SCREENSHOT_SUBMISSION_CREATED: "store-only",
  BETA_FEEDBACK_CRASH_SUBMISSION_CREATED: "store-only",
  BACKGROUND_ASSET_VERSION_STATE_UPDATED: "background-asset",
  BACKGROUND_ASSET_VERSION_INTERNAL_BETA_RELEASE_CREATED: "background-asset",
  BACKGROUND_ASSET_VERSION_EXTERNAL_BETA_RELEASE_STATE_UPDATED:
    "background-asset",
  BACKGROUND_ASSET_VERSION_APP_STORE_RELEASE_STATE_UPDATED: "background-asset",
  ALTERNATIVE_DISTRIBUTION_PACKAGE_VERSION_CREATED: "store-only",
  ALTERNATIVE_DISTRIBUTION_PACKAGE_AVAILABLE_UPDATED: "store-only",
  ALTERNATIVE_DISTRIBUTION_TERRITORY_AVAILABILITY_UPDATED: "store-only",
};

/** `APP_STORE_VERSION_APP_VERSION_STATE_UPDATED` → `appStoreVersionAppVersionStateUpdated`. */
export function camelEventType(t: AscWebhookEventType): string {
  return t
    .toLowerCase()
    .replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

const BY_NAME = new Map<string, AscWebhookEventType>(
  ASC_WEBHOOK_EVENT_TYPES.flatMap((t) => [
    [t, t],
    [camelEventType(t), t],
  ]),
);

/** The `data.type` of Apple's test ping (`POST /v1/webhookPings`): answered, stored, no effect. */
export const ASC_PING_TYPE = "webhookPingCreated";

/**
 * The event type a payload's `data.type` names. Apple sends the camel-case spelling
 * (`appStoreVersionAppVersionStateUpdated`); the enum spelling is accepted too. `null` for
 * anything else — an event type this build does not know.
 */
export function eventTypeOf(dataType: unknown): AscWebhookEventType | null {
  return typeof dataType === "string" ? (BY_NAME.get(dataType) ?? null) : null;
}

/** Instance resource types each effect may name, so a payload cannot point the follow-up GET at
 *  an arbitrary resource. */
export const BACKGROUND_ASSET_INSTANCE_TYPES = [
  "backgroundAssetVersions",
  "backgroundAssetVersionInternalBetaReleases",
  "backgroundAssetVersionExternalBetaReleases",
  "backgroundAssetVersionAppStoreReleases",
] as const;
export type BackgroundAssetInstanceType =
  (typeof BACKGROUND_ASSET_INSTANCE_TYPES)[number];

export const INSTANCE_TYPES: Readonly<
  Record<AscEventEffect, readonly string[]>
> = {
  "app-store-version": ["appStoreVersions"],
  "build-upload": ["buildUploads"],
  "build-beta-detail": ["buildBetaDetails"],
  "background-asset": BACKGROUND_ASSET_INSTANCE_TYPES,
  "store-only": [],
};

/** An instance identifier: a resource type and id, both plain segments. */
const PLAIN = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/;

/**
 * The `relationships.instance` of a webhook payload, in either of Apple's shapes: the usual
 * `{ data: { type, id } }`, or — Background Asset and marketplace events — `{ type, id, links }`
 * with no `data` wrapper (notes/E1 §A1). `null` when absent or not plain.
 */
export function instanceOf(
  data: Record<string, unknown>,
): { type: string; id: string } | null {
  const rels = data.relationships;
  if (!rels || typeof rels !== "object") return null;
  const inst = (rels as Record<string, unknown>).instance;
  if (!inst || typeof inst !== "object") return null;
  const wrapped = (inst as Record<string, unknown>).data;
  const ident = (
    wrapped && typeof wrapped === "object" ? wrapped : inst
  ) as Record<string, unknown>;
  const { type, id } = ident;
  if (typeof type !== "string" || typeof id !== "string") return null;
  if (!PLAIN.test(type) || !PLAIN.test(id)) return null;
  return { type, id };
}

// ── App Store versions ───────────────────────────────────────────────────────────────────────

/**
 * `AppVersionState` (webhooks, `appVersionState`) and the legacy `AppStoreVersionState`
 * (`appStoreState`) → availability on the `app-store` outlet. `READY_FOR_SALE` (legacy) and
 * `READY_FOR_DISTRIBUTION` (new) are the same state and both read `live`.
 */
export const APP_VERSION_AVAILABILITY: Readonly<
  Record<string, AvailabilityState>
> = {
  PREPARE_FOR_SUBMISSION: "pending",
  READY_FOR_REVIEW: "pending",
  DEVELOPER_REJECTED: "pending",
  NOT_APPLICABLE: "pending",
  WAITING_FOR_REVIEW: "in-review",
  IN_REVIEW: "in-review",
  WAITING_FOR_EXPORT_COMPLIANCE: "in-review",
  ACCEPTED: "approved",
  PENDING_CONTRACT: "approved",
  PENDING_APPLE_RELEASE: "approved",
  PENDING_DEVELOPER_RELEASE: "approved",
  PROCESSING_FOR_DISTRIBUTION: "approved",
  PROCESSING_FOR_APP_STORE: "approved",
  READY_FOR_DISTRIBUTION: "live",
  READY_FOR_SALE: "live",
  PREORDER_READY_FOR_SALE: "live",
  REJECTED: "rejected",
  METADATA_REJECTED: "rejected",
  INVALID_BINARY: "rejected",
  REPLACED_WITH_NEW_VERSION: "removed",
  REMOVED_FROM_SALE: "removed",
  DEVELOPER_REMOVED_FROM_SALE: "removed",
};

/**
 * The same states → submission. `undefined` = no submission change (a version taken off sale
 * keeps the submission history it had).
 */
export const APP_VERSION_SUBMISSION: Readonly<
  Record<string, SubmissionState | undefined>
> = {
  PREPARE_FOR_SUBMISSION: "prepared",
  READY_FOR_REVIEW: "prepared",
  WAITING_FOR_REVIEW: "submitted",
  IN_REVIEW: "in-review",
  WAITING_FOR_EXPORT_COMPLIANCE: "in-review",
  ACCEPTED: "approved",
  PENDING_CONTRACT: "approved",
  PENDING_APPLE_RELEASE: "approved",
  PENDING_DEVELOPER_RELEASE: "pending-developer-release",
  PROCESSING_FOR_DISTRIBUTION: "released",
  PROCESSING_FOR_APP_STORE: "released",
  READY_FOR_DISTRIBUTION: "released",
  READY_FOR_SALE: "released",
  PREORDER_READY_FOR_SALE: "released",
  REJECTED: "rejected",
  METADATA_REJECTED: "rejected",
  INVALID_BINARY: "rejected",
  DEVELOPER_REJECTED: "cancelled",
};

/** States after which an App Store version can no longer change (the poller stops). */
export const APP_VERSION_TERMINAL: ReadonlySet<string> = new Set([
  "REPLACED_WITH_NEW_VERSION",
  "REMOVED_FROM_SALE",
  "DEVELOPER_REMOVED_FROM_SALE",
]);

/** The state of an `appStoreVersions` resource: `appVersionState`, else legacy `appStoreState`. */
export function appVersionStateOf(
  attributes: Record<string, unknown> | undefined,
): string | null {
  const v = attributes?.appVersionState ?? attributes?.appStoreState;
  return typeof v === "string" ? v : null;
}

/** `ReviewSubmission.state` → submission (the poller; there is no webhook for it). */
export const REVIEW_SUBMISSION_STATE: Readonly<
  Record<string, SubmissionState | undefined>
> = {
  READY_FOR_REVIEW: "prepared",
  WAITING_FOR_REVIEW: "submitted",
  IN_REVIEW: "in-review",
  UNRESOLVED_ISSUES: "rejected",
  CANCELING: "cancelled",
  // COMPLETING / COMPLETE: the version's own state says what came of it.
};

// ── TestFlight ───────────────────────────────────────────────────────────────────────────────

/** `internalBuildState` → availability to internal testers. */
export const INTERNAL_BUILD_AVAILABILITY: Readonly<
  Record<string, AvailabilityState>
> = {
  PROCESSING: "processing",
  PROCESSING_EXCEPTION: "rejected",
  MISSING_EXPORT_COMPLIANCE: "pending",
  IN_EXPORT_COMPLIANCE_REVIEW: "in-review",
  READY_FOR_BETA_TESTING: "live",
  IN_BETA_TESTING: "live",
  EXPIRED: "removed",
};

/** `externalBuildState` → availability to external testers. `NOT_APPLICABLE` maps to none. */
export const EXTERNAL_BUILD_AVAILABILITY: Readonly<
  Record<string, AvailabilityState>
> = {
  PROCESSING: "processing",
  PROCESSING_EXCEPTION: "rejected",
  MISSING_EXPORT_COMPLIANCE: "pending",
  IN_EXPORT_COMPLIANCE_REVIEW: "in-review",
  READY_FOR_BETA_SUBMISSION: "approved",
  WAITING_FOR_BETA_REVIEW: "in-review",
  IN_BETA_REVIEW: "in-review",
  BETA_REJECTED: "rejected",
  BETA_APPROVED: "approved",
  READY_FOR_BETA_TESTING: "approved",
  IN_BETA_TESTING: "live",
  EXPIRED: "removed",
};

/** `BuildUpload.state` (`BUILD_UPLOAD_STATE_UPDATED`): before the build has a beta detail. */
export const BUILD_UPLOAD_AVAILABILITY: Readonly<
  Record<string, AvailabilityState>
> = {
  AWAITING_UPLOAD: "pending",
  PROCESSING: "processing",
  FAILED: "rejected",
  COMPLETE: "processing",
};

/**
 * The `testflight` outlet's availability from a build's beta detail. The outlet is the whole
 * TestFlight audience, so a build any tester can install is `live`; otherwise the external
 * state says where it stands (it is the one with a review), else the internal one. `EXPIRED` on
 * either side wins: TestFlight builds expire for everyone at once after 90 days.
 */
export function testflightAvailability(
  internal: string | null,
  external: string | null,
): AvailabilityState | null {
  if (internal === "EXPIRED" || external === "EXPIRED") return "removed";
  const i = internal ? INTERNAL_BUILD_AVAILABILITY[internal] : undefined;
  const e = external ? EXTERNAL_BUILD_AVAILABILITY[external] : undefined;
  if (i === "live" || e === "live") return "live";
  return e ?? i ?? null;
}

// ── Background Assets ────────────────────────────────────────────────────────────────────────

/** Per instance type: the Apple state → availability, and which outlet kind it describes. */
export const BACKGROUND_ASSET_STATES: Readonly<
  Record<
    BackgroundAssetInstanceType,
    {
      outletKind: "app-store" | "testflight";
      states: Readonly<Record<string, AvailabilityState>>;
      terminal: readonly string[];
    }
  >
> = {
  // The version itself: upload and import processing (`BackgroundAssetVersionState`).
  backgroundAssetVersions: {
    outletKind: "testflight",
    states: {
      AWAITING_UPLOAD: "pending",
      PROCESSING: "processing",
      FAILED: "rejected",
      COMPLETE: "approved",
    },
    terminal: ["FAILED"],
  },
  backgroundAssetVersionInternalBetaReleases: {
    outletKind: "testflight",
    states: { READY_FOR_TESTING: "live", SUPERSEDED: "removed" },
    terminal: ["SUPERSEDED"],
  },
  backgroundAssetVersionExternalBetaReleases: {
    outletKind: "testflight",
    states: {
      READY_FOR_BETA_SUBMISSION: "approved",
      WAITING_FOR_REVIEW: "in-review",
      IN_REVIEW: "in-review",
      REJECTED: "rejected",
      PROCESSING_FOR_TESTING: "processing",
      READY_FOR_TESTING: "live",
      SUPERSEDED: "removed",
    },
    terminal: ["SUPERSEDED"],
  },
  backgroundAssetVersionAppStoreReleases: {
    outletKind: "app-store",
    states: {
      PREPARE_FOR_SUBMISSION: "pending",
      READY_FOR_REVIEW: "pending",
      WAITING_FOR_REVIEW: "in-review",
      IN_REVIEW: "in-review",
      ACCEPTED: "approved",
      REJECTED: "rejected",
      PROCESSING_FOR_DISTRIBUTION: "approved",
      READY_FOR_DISTRIBUTION: "live",
      SUPERSEDED: "removed",
    },
    terminal: ["SUPERSEDED"],
  },
};

export function isBackgroundAssetInstanceType(
  t: string,
): t is BackgroundAssetInstanceType {
  return (BACKGROUND_ASSET_INSTANCE_TYPES as readonly string[]).includes(t);
}

// ── Phased release ───────────────────────────────────────────────────────────────────────────

/** Apple's seven-day schedule: day N of a phased release reaches this share of users with
 *  automatic updates on (1, 2, 5, 10, 20, 50, 100 %), in basis points. */
export const PHASED_RELEASE_BP: readonly number[] = [
  100, 200, 500, 1000, 2000, 5000, 10000,
];

/** Day → basis points. Day 0 (not started) is 0; day 7 and later are 10000. */
export function phasedDayToBp(day: number | null): number {
  if (day === null || !Number.isFinite(day) || day < 1) return 0;
  return PHASED_RELEASE_BP[Math.min(Math.floor(day), 7) - 1]!;
}

/** `PhasedReleaseState` → rollout state. `INACTIVE` (configured, not started) is not mirrored. */
export function phasedStateToRollout(
  state: string | null,
): "active" | "paused" | "complete" | null {
  switch (state) {
    case "ACTIVE":
      return "active";
    case "PAUSED":
      return "paused";
    case "COMPLETE":
      return "complete";
    default:
      return null;
  }
}

/** The release a store version string names: exact, or with a leading `v` on either side. */
export function sameVersion(a: string, b: string): boolean {
  const n = (s: string) => s.trim().replace(/^v/i, "");
  return n(a) === n(b);
}
