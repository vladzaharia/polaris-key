/**
 * Before-and-after projection and the audit row of an App Store Connect write (A-17a; notes/S-14
 * §7.4).
 *
 *   - **Before and after are Apple's own reads**: the natural-key pre-read and the re-read after
 *     the write. Both go through `projectAscResource`, a per-type ALLOW-list of attributes;
 *     a type not listed keeps only `{ type, id }`.
 *   - **Never stored**, whatever a list says: passwords, secrets, emails, phone numbers, names of
 *     people and contact fields (`REDACTED_KEY`, checked after the allow-list as defence in
 *     depth); beta testers are projected to their state only, so no email reaches a row (the
 *     caller's summary gives a count). No request body and no Apple error body is stored: a
 *     failure keeps its status and Apple's `errors[].code` token only.
 *   - **One audit row per write**: product scope appends to the product's `audit`
 *     (`distribution.asc.<op>`), team scope to `platform_audit` (`platform.asc.<op>`, with the
 *     projections as `before` / `after`). Product audit rows have no before/after columns, so the
 *     projections live on the ledger row, whose `op_id` the summary names.
 */

import type { Db } from "../platform.js";
import { audit, type AdminSession } from "../adminApi.js";
import { appendPlatformEvent } from "../platformEvents.js";
import type { AscResource } from "./client.js";

/** Attributes kept per resource type. Everything else is dropped. */
const PROJECTION: Readonly<Record<string, readonly string[]>> = {
  bundleIds: ["identifier", "name", "platform", "seedId"],
  bundleIdCapabilities: ["capabilityType"],
  apps: [
    "name",
    "bundleId",
    "sku",
    "primaryLocale",
    "subscriptionStatusUrl",
    "subscriptionStatusUrlVersion",
    "subscriptionStatusUrlForSandbox",
    "subscriptionStatusUrlVersionForSandbox",
  ],
  appAvailabilities: ["availableInNewTerritories"],
  appPriceSchedules: [],
  betaGroups: [
    "name",
    "isInternalGroup",
    "hasAccessToAllBuilds",
    "publicLinkEnabled",
    "publicLinkLimitEnabled",
    "publicLinkLimit",
    "publicLink",
    "feedbackEnabled",
  ],
  betaTesters: ["inviteType", "state"],
  builds: [
    "version",
    "processingState",
    "usesNonExemptEncryption",
    "expired",
    "uploadedDate",
  ],
  betaBuildLocalizations: ["locale"],
  betaAppReviewSubmissions: ["betaReviewState", "submittedDate"],
  appStoreVersions: [
    "platform",
    "versionString",
    "appVersionState",
    "appStoreState",
    "releaseType",
    "earliestReleaseDate",
    "reviewType",
  ],
  appStoreVersionLocalizations: ["locale"],
  appStoreVersionPhasedReleases: [
    "phasedReleaseState",
    "currentDayNumber",
    "startDate",
    "totalPauseDuration",
  ],
  appStoreVersionReleaseRequests: [],
  reviewSubmissions: ["platform", "state", "submittedDate"],
  reviewSubmissionItems: ["state"],
  inAppPurchases: [
    "name",
    "productId",
    "inAppPurchaseType",
    "state",
    "familySharable",
  ],
  inAppPurchaseVersions: ["state"],
  inAppPurchaseLocalizations: ["locale", "name", "state"],
  inAppPurchasePriceSchedules: [],
  inAppPurchaseAvailabilities: ["availableInNewTerritories"],
  webhooks: ["name", "enabled", "eventTypes", "url"],
  webhookPings: [],
};

/** Keys never stored, even if a projection lists them (defence in depth). */
const REDACTED_KEY =
  /password|secret|email|phone|contact|firstname|lastname|demoaccount|token/i;

/** The most characters of one projected string value. */
const MAX_VALUE = 300;

/** A projected resource: its type, id and the allowed attributes Apple returned. */
export interface AscProjection {
  type: string;
  id: string;
  attributes: Record<string, unknown>;
}

function projectValue(v: unknown): unknown {
  if (v === null || typeof v === "boolean" || typeof v === "number") return v;
  if (typeof v === "string") return v.slice(0, MAX_VALUE);
  // Short lists of tokens (a webhook's event types); nothing nested.
  if (
    Array.isArray(v) &&
    v.length <= 50 &&
    v.every((x) => typeof x === "string")
  )
    return v.map((x: string) => x.slice(0, 100));
  return undefined;
}

/** Project one resource through its type's allow-list. `null` in, `null` out. */
export function projectAscResource(
  r: AscResource | null | undefined,
): AscProjection | null {
  if (!r || typeof r.type !== "string" || typeof r.id !== "string") return null;
  const keep = PROJECTION[r.type] ?? [];
  const attributes: Record<string, unknown> = {};
  for (const k of keep) {
    if (REDACTED_KEY.test(k)) continue;
    const v = projectValue(r.attributes?.[k]);
    if (v !== undefined) attributes[k] = v;
  }
  return { type: r.type, id: r.id, attributes };
}

/** Whom an A-17 write is on behalf of: the verified admin session. */
export type AscActor = Pick<AdminSession, "sub" | "name" | "email">;

export interface AscAuditEntry {
  scope: "team" | "product";
  /** The product slug (product scope only). */
  product: string | null;
  /** The full admin session for product scope (the product audit writer takes one). */
  session: AdminSession;
  now: number;
  /** The operation, e.g. `bundle_id.register`; the action is `<prefix>.asc.<op>`. */
  op: string;
  /** The Apple object written (or found). */
  target: { kind: string; id: string } | null;
  summary: string;
  opId: string;
  before: AscProjection | null;
  after: AscProjection | null;
}

/** Append the one audit row of a write: the product's trail, or the platform trail. */
export async function recordAscAudit(db: Db, e: AscAuditEntry): Promise<void> {
  const summary = `${e.summary} [op ${e.opId.slice(0, 12)}]`;
  if (e.scope === "product") {
    if (!e.product)
      throw new Error("product-scope ASC audit without a product");
    await audit(
      db,
      e.product,
      e.session,
      e.now,
      `distribution.asc.${e.op}`,
      e.target,
      summary,
    );
    return;
  }
  await appendPlatformEvent(db, {
    actor: { sub: e.session.sub, name: e.session.name, email: e.session.email },
    at: e.now,
    action: `platform.asc.${e.op}`,
    target: e.target,
    summary,
    before: e.before,
    after: e.after,
  });
}
