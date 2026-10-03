/**
 * The Microsoft Store's vocabulary and Distribution's (P5-04; S-07 row 18). Pure functions, no
 * I/O: parsing what the submission API answers, and mapping a submission onto submissions,
 * availability and a mirrored rollout.
 *
 * ── STATUS ──────────────────────────────────────────────────────────────────────────────────
 *
 *     Store status          submission                  availability   meaning
 *     None                  —                           —              nothing to report
 *     PendingCommit         prepared                    pending        created, not committed
 *     CommitStarted         submitted                   processing     committed, being checked
 *     PreProcessing         submitted                   processing     packages being processed
 *     Certification         in-review                   in-review      certification (≤ 3 days)
 *     Release               approved                    approved       certified, releasing
 *     PendingPublication    pending-developer-release   approved       certified; waits for a
 *                                                                      manual publish
 *     Publishing            approved                    approved       publishing
 *     Published             released                    live           live (see ROLLOUT)
 *     CommitFailed          rejected                    rejected       commit refused
 *     PreProcessingFailed   rejected                    rejected       packages refused
 *     CertificationFailed   rejected                    rejected       certification failed
 *     ReleaseFailed         approved                    approved       certified, release failed
 *     PublishFailed         approved                    approved       certified, publish failed
 *     Canceled              cancelled                   removed        withdrawn
 *
 * The three failures before or in certification are a verdict on the submission (`rejected`,
 * with `statusDetails.errors` and the certification report dates in `detail`). A release or
 * publish failure comes after certification passed, so it stays `approved` and carries
 * `failed: true` and the errors in `detail` for the console to flag. A status this build does
 * not know reads as nothing (fail-closed: never `live`).
 *
 * ── ROLLOUT ─────────────────────────────────────────────────────────────────────────────────
 *
 * A Published submission's `packageDeliveryOptions.packageRollout` is mirrored into
 * `dist_rollouts` (`source = ms-store`): `PackageRolloutInProgress` → `active` at
 * `round(percentage × 100)` bp (25 % → 2,500), `PackageRolloutStopped` → `halted` (new customers
 * get the fallback submission; installed users keep the new package — notes/E3 §A1.2, so the
 * availability reads `approved` like a halted Play release), `PackageRolloutComplete` or no
 * gradual rollout → `complete` at 10,000. `PackageRolloutNotStarted` writes no rollout and its
 * builds read `approved` (published, served to no one yet). The mirror is informative, never an
 * access control.
 *
 *     Published submission's rollout   its builds   rollout row          fallback's builds
 *     none, or Complete                live         complete, 10000 bp   (not read)
 *     InProgress at p %                live         active, p × 100 bp   live
 *     Stopped                          approved     halted               live
 *     NotStarted                       approved     —                    live
 *
 * **The fallback submission.** While a gradual rollout is partial, everyone it does not reach
 * gets `fallbackSubmissionId` — the previously published submission. The poller reads it too
 * (role `fallback`), and its builds stay `live`, as Play keeps the previous completed release
 * live beside a staged or halted one. It never mirrors a rollout and never speaks for its release's
 * submission row. Once the rollout completes, the fallback is no longer read, and its builds
 * become `removed` unless the new submission carries them.
 *
 * Pricing is never parsed: an app on Pricing Version 2 answers an unknown price tier, and status,
 * rollout and flights still read normally.
 */

import type { RolloutState } from "../../../../core/hooks.js";
import type { AvailabilityState, SubmissionState } from "../../availability.js";
import { FLIGHT_ID, SUBMISSION_ID } from "./client.js";

export const STORE_STATUSES = [
  "None",
  "Canceled",
  "PendingCommit",
  "CommitStarted",
  "CommitFailed",
  "PendingPublication",
  "Publishing",
  "Published",
  "PublishFailed",
  "PreProcessing",
  "PreProcessingFailed",
  "Certification",
  "CertificationFailed",
  "Release",
  "ReleaseFailed",
] as const;
export type StoreStatus = (typeof STORE_STATUSES)[number];

export const ROLLOUT_STATUSES = [
  "PackageRolloutNotStarted",
  "PackageRolloutInProgress",
  "PackageRolloutComplete",
  "PackageRolloutStopped",
] as const;
export type RolloutStatus = (typeof ROLLOUT_STATUSES)[number];

const isOneOf = <T extends string>(list: readonly T[], v: unknown): v is T =>
  typeof v === "string" && (list as readonly string[]).includes(v);

interface StatusRow {
  submission: SubmissionState | null;
  availability: AvailabilityState | null;
  failed: boolean;
}

export const STATUS_MAP: Readonly<Record<StoreStatus, StatusRow>> = {
  None: { submission: null, availability: null, failed: false },
  PendingCommit: {
    submission: "prepared",
    availability: "pending",
    failed: false,
  },
  CommitStarted: {
    submission: "submitted",
    availability: "processing",
    failed: false,
  },
  PreProcessing: {
    submission: "submitted",
    availability: "processing",
    failed: false,
  },
  Certification: {
    submission: "in-review",
    availability: "in-review",
    failed: false,
  },
  Release: { submission: "approved", availability: "approved", failed: false },
  PendingPublication: {
    submission: "pending-developer-release",
    availability: "approved",
    failed: false,
  },
  Publishing: {
    submission: "approved",
    availability: "approved",
    failed: false,
  },
  Published: { submission: "released", availability: "live", failed: false },
  CommitFailed: {
    submission: "rejected",
    availability: "rejected",
    failed: true,
  },
  PreProcessingFailed: {
    submission: "rejected",
    availability: "rejected",
    failed: true,
  },
  CertificationFailed: {
    submission: "rejected",
    availability: "rejected",
    failed: true,
  },
  ReleaseFailed: {
    submission: "approved",
    availability: "approved",
    failed: true,
  },
  PublishFailed: {
    submission: "approved",
    availability: "approved",
    failed: true,
  },
  Canceled: {
    submission: "cancelled",
    availability: "removed",
    failed: false,
  },
};

/** When one build is in several submissions of one outlet, the most-served state speaks. */
export const AVAILABILITY_RANK: Readonly<Record<AvailabilityState, number>> = {
  live: 7,
  approved: 6,
  "in-review": 5,
  processing: 4,
  pending: 3,
  rejected: 2,
  removed: 1,
};

// ── Parsing ──────────────────────────────────────────────────────────────────────────────────

export interface SubmissionRef {
  id: string;
}

export interface StoreApplication {
  id: string;
  primaryName: string | null;
  lastPublished: SubmissionRef | null;
  pending: SubmissionRef | null;
}

export interface StoreFlight {
  flightId: string;
  friendlyName: string | null;
  lastPublished: SubmissionRef | null;
  pending: SubmissionRef | null;
}

export interface StatusDetail {
  code: string;
  details: string;
}

export interface StorePackage {
  version: string;
  fileStatus: string | null;
  architecture: string | null;
}

export interface StoreRollout {
  isPackageRollout: boolean;
  /** 0–100. */
  percentage: number | null;
  status: RolloutStatus | null;
  fallbackSubmissionId: string | null;
}

export interface StoreSubmission {
  id: string;
  /** `null` = a status this build does not know: read fail-closed. */
  status: StoreStatus | null;
  /** The raw status string, for display. */
  rawStatus: string | null;
  errors: StatusDetail[];
  warnings: StatusDetail[];
  /** Certification report dates (epoch seconds), newest last. Report URLs are not kept. */
  certificationReports: number[];
  /** The 4-part package versions, distinct, in the API's order (pending deletes left out). */
  packages: StorePackage[];
  rollout: StoreRollout | null;
  targetPublishMode: string | null;
  friendlyName: string | null;
}

const MAX_DETAILS = 20;
/** The most packages of one submission kept (one per architecture and version; a real one has a
 *  handful). */
const MAX_PACKAGES = 64;
const MAX_DETAIL_TEXT = 500;

const obj = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
const str = (v: unknown, max = 200): string | null =>
  typeof v === "string" && v.length > 0 ? v.slice(0, max) : null;

function refOf(v: unknown): SubmissionRef | null {
  const o = obj(v);
  return o && typeof o.id === "string" && SUBMISSION_ID.test(o.id)
    ? { id: o.id }
    : null;
}

/** Parse an application resource; `null` for something that is not one. */
export function parseApplication(doc: unknown): StoreApplication | null {
  const o = obj(doc);
  if (!o || typeof o.id !== "string") return null;
  return {
    id: o.id,
    primaryName: str(o.primaryName),
    lastPublished: refOf(o.lastPublishedApplicationSubmission),
    pending: refOf(o.pendingApplicationSubmission),
  };
}

/** Parse the flights a `listflights` read returned (de-duplicated by id). */
export function parseFlights(list: readonly unknown[]): StoreFlight[] {
  const out: StoreFlight[] = [];
  for (const v of list) {
    const o = obj(v);
    if (
      !o ||
      typeof o.flightId !== "string" ||
      !FLIGHT_ID.test(o.flightId) ||
      out.some((f) => f.flightId === o.flightId)
    )
      continue;
    out.push({
      flightId: o.flightId,
      friendlyName: str(o.friendlyName, 100),
      lastPublished: refOf(o.lastPublishedFlightSubmission),
      pending: refOf(o.pendingFlightSubmission),
    });
  }
  return out;
}

function detailsOf(v: unknown): StatusDetail[] {
  if (!Array.isArray(v)) return [];
  const out: StatusDetail[] = [];
  for (const d of v.slice(0, MAX_DETAILS)) {
    const o = obj(d);
    if (!o) continue;
    out.push({
      code: str(o.code, 100) ?? "Other",
      details: str(o.details, MAX_DETAIL_TEXT) ?? "",
    });
  }
  return out;
}

/** An ISO 8601 date as epoch seconds, or null (Partner Center's 1601-01-01 "unset" included). */
export function isoSeconds(v: unknown): number | null {
  if (typeof v !== "string") return null;
  const ms = Date.parse(v);
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return Math.floor(ms / 1000);
}

/** A 4-part MSIX package version (`1.2.3.0`). */
export const MSIX_VERSION = /^(0|[1-9][0-9]{0,4})(\.(0|[1-9][0-9]{0,4})){3}$/;

function packagesOf(v: unknown): StorePackage[] {
  if (!Array.isArray(v)) return [];
  const out: StorePackage[] = [];
  for (const p of v.slice(0, MAX_PACKAGES)) {
    const o = obj(p);
    if (!o || typeof o.version !== "string" || !MSIX_VERSION.test(o.version))
      continue;
    // A package marked for deletion is leaving the submission; it is not offered by it.
    if (o.fileStatus === "PendingDelete") continue;
    if (out.some((x) => x.version === o.version)) continue;
    out.push({
      version: o.version,
      fileStatus: str(o.fileStatus, 50),
      architecture: str(o.architecture, 50),
    });
  }
  return out;
}

function rolloutOf(v: unknown): StoreRollout | null {
  const o = obj(obj(v)?.packageRollout);
  if (!o) return null;
  const pct = o.packageRolloutPercentage;
  return {
    isPackageRollout: o.isPackageRollout === true,
    percentage:
      typeof pct === "number" && Number.isFinite(pct) && pct >= 0 && pct <= 100
        ? pct
        : null,
    status: isOneOf(ROLLOUT_STATUSES, o.packageRolloutStatus)
      ? o.packageRolloutStatus
      : null,
    fallbackSubmissionId:
      typeof o.fallbackSubmissionId === "string" &&
      SUBMISSION_ID.test(o.fallbackSubmissionId) &&
      o.fallbackSubmissionId !== "0"
        ? o.fallbackSubmissionId
        : null,
  };
}

/**
 * Parse an app or flight submission; `null` for something that is not one. Only the fields this
 * connector reads are kept — never `fileUploadUrl` (a writable SAS URI), listings, pricing, or a
 * certification report's URL.
 */
export function parseSubmission(doc: unknown): StoreSubmission | null {
  const o = obj(doc);
  if (!o || typeof o.id !== "string" || !SUBMISSION_ID.test(o.id)) return null;
  const details = obj(o.statusDetails);
  const reports = Array.isArray(details?.certificationReports)
    ? (details.certificationReports as unknown[])
        .slice(0, MAX_DETAILS)
        .map((r) => isoSeconds(obj(r)?.date))
        .filter((d): d is number => d !== null)
        .sort((a, b) => a - b)
    : [];
  return {
    id: o.id,
    status: isOneOf(STORE_STATUSES, o.status) ? o.status : null,
    rawStatus: str(o.status, 50),
    errors: detailsOf(details?.errors),
    warnings: detailsOf(details?.warnings),
    certificationReports: reports,
    packages: packagesOf(o.applicationPackages ?? o.flightPackages),
    rollout: rolloutOf(o.packageDeliveryOptions),
    targetPublishMode: str(o.targetPublishMode, 50),
    friendlyName: str(o.friendlyName, 100),
  };
}

// ── Mapping ──────────────────────────────────────────────────────────────────────────────────

export function statusRow(status: StoreStatus | null): StatusRow {
  return status
    ? STATUS_MAP[status]
    : { submission: null, availability: null, failed: false };
}

/** `packageRolloutPercentage` (0–100) → basis points, clamped. */
export function percentToBp(pct: number): number {
  return Math.max(0, Math.min(10000, Math.round(pct * 100)));
}

/** The rollout a Published submission mirrors, or `null` (not published, or not started). */
export function rolloutOfSubmission(
  s: StoreSubmission,
): { state: RolloutState; bp: number } | null {
  if (s.status !== "Published") return null;
  const r = s.rollout;
  if (!r || !r.isPackageRollout || r.status === "PackageRolloutComplete")
    return { state: "complete", bp: 10000 };
  switch (r.status) {
    case "PackageRolloutInProgress":
      return { state: "active", bp: percentToBp(r.percentage ?? 0) };
    case "PackageRolloutStopped":
      return { state: "halted", bp: percentToBp(r.percentage ?? 0) };
    default:
      return null;
  }
}

/** Whether a Published submission's gradual rollout is still partial (not started, in progress
 *  or stopped), i.e. its fallback submission is still served to the rest. */
export function servesFallback(s: StoreSubmission): boolean {
  return (
    s.status === "Published" &&
    s.rollout !== null &&
    s.rollout.isPackageRollout &&
    s.rollout.fallbackSubmissionId !== null &&
    s.rollout.fallbackSubmissionId !== s.id &&
    (s.rollout.status === "PackageRolloutNotStarted" ||
      s.rollout.status === "PackageRolloutInProgress" ||
      s.rollout.status === "PackageRolloutStopped")
  );
}

/** The availability a submission gives its builds: the status row's, except that a Published
 *  submission whose gradual rollout is stopped or not started serves no one new (`approved`). */
export function availabilityOf(s: StoreSubmission): AvailabilityState | null {
  const row = statusRow(s.status);
  if (
    s.status === "Published" &&
    s.rollout?.isPackageRollout &&
    (s.rollout.status === "PackageRolloutStopped" ||
      s.rollout.status === "PackageRolloutNotStarted")
  )
    return "approved";
  return row.availability;
}

/** Compare two 4-part versions numerically. */
export function compareMsix(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 4; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** Compare two submission ids numerically (Partner Center issues them increasing). */
export function compareSubmissionIds(a: string, b: string): number {
  const x = BigInt(a);
  const y = BigInt(b);
  return x > y ? 1 : x < y ? -1 : 0;
}

/** What `detail_json` keeps of a submission: status, errors, warnings, report dates, packages,
 *  rollout — never a URL. */
export function submissionDetail(
  s: StoreSubmission,
  extra: Record<string, unknown>,
): Record<string, unknown> {
  const row = statusRow(s.status);
  const out: Record<string, unknown> = {
    ...extra,
    storeStatus: s.rawStatus,
    submissionId: s.id,
    friendlyName: s.friendlyName,
    targetPublishMode: s.targetPublishMode,
    packageVersions: s.packages.map((p) => p.version),
    failed: row.failed || undefined,
    errors: s.errors.length ? s.errors : undefined,
    warnings: s.warnings.length ? s.warnings : undefined,
    certificationReports: s.certificationReports.length
      ? s.certificationReports
      : undefined,
    packageRollout:
      s.rollout && s.rollout.isPackageRollout
        ? {
            percentage: s.rollout.percentage,
            status: s.rollout.status,
            fallbackSubmissionId: s.rollout.fallbackSubmissionId,
          }
        : undefined,
  };
  return Object.fromEntries(
    Object.entries(out).filter(([, v]) => v !== null && v !== undefined),
  );
}
