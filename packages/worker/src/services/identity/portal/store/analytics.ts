/**
 * The Polaris Key storefront's analytics (PS-04, notes/S-21 §6.6, owner decision 12): daily
 * aggregates per product, UTC day and path kind, and nothing stored per person beyond a two-day
 * table of keyed hashes. PS-06's console card reads `storefront_daily`.
 *
 *   impressions   a visible product shown to an account: an offer of `GET /api/discover` or the
 *                 storefront product page `GET /api/discover/<p>`. Once per account, product and
 *                 day: `storefront_seen` holds `HMAC(daily salt, account id)` for the day, and the
 *                 first sighting alone counts. Attributed to the first path's kind (`link` for an
 *                 audience-`everyone` listing with nothing to add).
 *   adds          a claim that created what its path implies (a licence or a library entry),
 *                 under the path's kind. A repeat or a racing double submit adds nothing.
 *   activations   the first device bound to a licence added from Discover, within seven days of
 *                 the add (Core's new-authorization listener, `core/authorizationListeners.ts`).
 *                 Counted on the ADD's day and path kind, so `activations / adds` is a rate.
 *
 * ── PRIVACY (THREAT-MODEL "Storefront analytics (PS-04)") ───────────────────────────────────
 *
 * Neither table has an account id. `account_key` is HMAC-SHA-256 of the account id under the
 * day's salt, and the salt is itself derived from the deployment's `KEY_HASH_PEPPER` and the day,
 * so it is never stored and a key cannot be recomputed without the pepper. Keys change every day
 * (two days' keys never match), and the nightly sweep deletes every row older than yesterday
 * (`pruneStorefrontSeen`). The activation count needs to know which licences were added from
 * Discover: it reads the `portal.discover.claim` row the claim already writes to the account's own
 * history (`portal_audit`), and marks the licence counted there, so no new per-person record
 * exists for it.
 *
 * ── BEST EFFORT ─────────────────────────────────────────────────────────────────────────────
 *
 * Counting never fails what it counts: a listing, a page, a claim or an activation answers the
 * same whether or not its count was written. A count lost to a storage error is lost; the
 * aggregates are a trend, not a ledger.
 */

import { hashKey, type Db, type Env } from "../../../../core/platform.js";
import {
  registerAuthorizationListener,
  type AuthorizationListenerContext,
  type NewAuthorization,
} from "../../../../core/authorizationListeners.js";
import {
  isObtainPathKind,
  type ObtainPathKind,
} from "../../../../core/storefront/polarisKeyListing.js";
import { discoverClaimAuditId } from "../repo.js";

/** The path kind of an audience-`everyone` listing with nothing to add (`cta: "link"`). */
export const LINK_PATH_KIND = "link";

/** What `storefront_daily.path_kind` holds: an obtain-path kind, or `link`. */
export type StorefrontPathKind = ObtainPathKind | typeof LINK_PATH_KIND;

/** A first activation counts only this long after the add (PS-06's "within 7 days"). */
export const ACTIVATION_WINDOW_SECONDS = 7 * 86400;

/** At most this many `storefront_seen` rows go per prune statement (the sweep drains). */
export const SEEN_PRUNE_BATCH = 500;

/** The UTC day of `now` (epoch seconds), `YYYY-MM-DD`: sortable as text. */
export function storefrontDay(now: number): string {
  return new Date(now * 1000).toISOString().slice(0, 10);
}

/**
 * The day's dedupe key for one account: HMAC-SHA-256 of the account id under the day's salt,
 * truncated to 128 bits. The salt is HMAC-SHA-256 of a fixed label and the day under the
 * deployment's `KEY_HASH_PEPPER` (a plain SHA-256 on a deployment without one, where the keys are
 * only as private as the day is secret, which it is not: set the pepper).
 */
export async function storefrontAccountKey(
  env: Env,
  accountId: string,
  day: string,
): Promise<string> {
  const salt = await hashKey(
    `pkey-storefront-seen/1|${day}`,
    env.KEY_HASH_PEPPER,
  );
  return (await hashKey(accountId, salt)).slice(0, 32);
}

type Counter = "impressions" | "adds" | "activations";

/** Add one to a counter of (product, day, path kind), creating the row at zero first. */
async function bump(
  db: Db,
  product: string,
  day: string,
  kind: StorefrontPathKind,
  counter: Counter,
): Promise<void> {
  await db.run(
    `INSERT INTO storefront_daily
       (product, day, path_kind, impressions, adds, activations)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(product, day, path_kind) DO UPDATE SET ${counter} = ${counter} + 1`,
    product,
    day,
    kind,
    counter === "impressions" ? 1 : 0,
    counter === "adds" ? 1 : 0,
    counter === "activations" ? 1 : 0,
  );
}

/** One product shown to the account, under the kind it was shown for. */
export interface Impression {
  product: string;
  kind: StorefrontPathKind;
}

/**
 * Count what the account was just shown: one impression per product per day, whichever surface
 * showed it first. Best effort (see the file comment).
 */
export async function recordImpressions(
  env: Env,
  db: Db,
  accountId: string,
  shown: readonly Impression[],
  now: number,
): Promise<void> {
  if (shown.length === 0) return;
  try {
    const day = storefrontDay(now);
    const key = await storefrontAccountKey(env, accountId, day);
    for (const { product, kind } of shown) {
      const first = await db.runChanges(
        `INSERT INTO storefront_seen (product, day, account_key) VALUES (?, ?, ?)
         ON CONFLICT(product, day, account_key) DO NOTHING`,
        product,
        day,
        key,
      );
      if (first > 0) await bump(db, product, day, kind, "impressions");
    }
  } catch {
    // Best effort: the listing answers the same without its count.
  }
}

/** Count one add (a claim that created its licence or entry). Best effort. */
export async function recordAdd(
  db: Db,
  product: string,
  kind: ObtainPathKind,
  now: number,
): Promise<void> {
  try {
    await bump(db, product, storefrontDay(now), kind, "adds");
  } catch {
    // Best effort: the claim answers the same without its count.
  }
}

/**
 * The path kind a `portal.discover.claim` summary names (`… (source: discover; path: <kind>; …)`,
 * written by the claim since PS-04), or, for a claim written before PS-04, the kind its reason
 * implies (`group:<g>` → `group`, `free_with_account` → `auto_issue`). `null` when neither reads.
 */
export function claimPathKind(summary: string | null): ObtainPathKind | null {
  if (!summary) return null;
  const path = /\(source: discover; path: ([a-z_]+)[;)]/.exec(summary)?.[1];
  if (path !== undefined) return isObtainPathKind(path) ? path : null;
  const reason = /\(source: discover; reason: ([^;)]+)[;)]/.exec(summary)?.[1];
  if (reason === "free_with_account") return "auto_issue";
  if (reason?.startsWith("group:")) return "group";
  return null;
}

/**
 * Core's new-authorization listener: count the first device bound to a licence added from
 * Discover, within `ACTIVATION_WINDOW_SECONDS` of the add, on the add's day and path kind. The
 * claim behind the licence is its `portal.discover.claim` row (by primary key); the licence is
 * counted once, by a marker row beside it in the same account's history whose insert decides.
 */
export async function recordFirstActivation(
  ctx: AuthorizationListenerContext,
  event: NewAuthorization,
): Promise<void> {
  const { db, now } = ctx;
  const claim = await db.first<{
    account_id: string | null;
    at: number;
    summary: string | null;
  }>(
    "SELECT account_id, at, summary FROM portal_audit WHERE id = ? AND action = 'portal.discover.claim'",
    discoverClaimAuditId(event.product, event.licenseId),
  );
  if (!claim || now - claim.at > ACTIVATION_WINDOW_SECONDS) return;
  const kind = claimPathKind(claim.summary);
  if (!kind) return;
  const first = await db.runChanges(
    `INSERT INTO portal_audit
       (id, account_id, at, action, product, target_kind, target_id, summary)
     VALUES (?, ?, ?, 'portal.discover.activation', ?, 'license', ?, ?)
     ON CONFLICT(id) DO NOTHING`,
    `${discoverClaimAuditId(event.product, event.licenseId)}_activated`,
    claim.account_id,
    now,
    event.product,
    event.licenseId,
    "A first device was activated on a license added from Discover",
  );
  if (first > 0)
    await bump(db, event.product, storefrontDay(claim.at), kind, "activations");
}

registerAuthorizationListener("storefront.activations", recordFirstActivation);

/**
 * The nightly sweep's step for one product: delete its dedupe rows older than yesterday, at most
 * `limit` per statement (the caller drains). Today's rows dedupe today's impressions; yesterday's
 * are kept so a sweep that runs just after midnight never races the day's first sightings.
 */
export async function pruneStorefrontSeen(
  db: Db,
  product: string,
  now: number,
  limit: number = SEEN_PRUNE_BATCH,
): Promise<number> {
  return db.runChanges(
    `DELETE FROM storefront_seen
      WHERE rowid IN (
        SELECT rowid FROM storefront_seen WHERE product = ? AND day < ? LIMIT ?
      )`,
    product,
    storefrontDay(now - 86400),
    limit,
  );
}
