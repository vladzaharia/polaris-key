/**
 * The Polaris Key storefront's analytics (PS-04, notes/S-21 §6.6, owner decision 12): daily
 * aggregates per product, UTC day and path kind, and nothing stored per person beyond a two-day
 * table of keyed hashes. PS-06's console card reads `storefront_daily`.
 *
 *   impressions   a visible product shown to an account: an offer of `GET /api/discover` or the
 *                 storefront product page `GET /api/discover/<p>`. Once per account, product and
 *                 day: `storefront_seen` holds `HMAC(daily salt, account id)` for the day, and the
 *                 first sighting alone counts. Attributed to the first path's kind (`link` for an
 *                 audience-`everyone` listing with nothing to add). Counted only on a deployment
 *                 with `KEY_HASH_PEPPER` (see PRIVACY below).
 *   adds          a claim that created what its path implies (a licence or a library entry),
 *                 under the path's kind. A repeat or a racing double submit adds nothing.
 *   activations   the licence's FIRST device ever, bound within seven days of an add from
 *                 Discover (Core's new-authorization listener, `core/authorizationListeners.ts`,
 *                 with its `firstOnLicense`). Counted on the ADD's day and path kind, so
 *                 `activations / adds` is a rate. Two devices binding the same licence at the same
 *                 instant can both read first and count twice; the aggregates accept that.
 *
 * ── PRIVACY (THREAT-MODEL "Storefront analytics (PS-04)", docs/PRIVACY.md) ──────────────────
 *
 * Neither table has an account id. `account_key` is HMAC-SHA-256 of the account id under the
 * day's salt, and the salt is itself derived from the deployment's `KEY_HASH_PEPPER` and the day,
 * so it is never stored and a key cannot be recomputed without the pepper. Keys change every day
 * (two days' keys never match), and the nightly sweep deletes every row older than yesterday
 * (`pruneStorefrontSeen`). Without the pepper a key would be recomputable from the database alone,
 * so none is written and no impression is counted. The activation count writes nothing per
 * person: it READS the `portal.discover.claim` row the claim already wrote to the account's own
 * history (`portal_audit`) to learn that, when and by which path the licence was added, and Core
 * tells it whether the device is the licence's first.
 *
 * ── BEST EFFORT ─────────────────────────────────────────────────────────────────────────────
 *
 * Counting never fails what it counts: a listing, a page, a claim or an activation answers the
 * same whether or not its count was written. A count lost to a storage error is lost; the
 * aggregates are a trend, not a ledger.
 */

import {
  hashKey,
  type Db,
  type DbStatement,
  type Env,
} from "../../../../core/platform.js";
import {
  registerAuthorizationListener,
  type AuthorizationListenerContext,
  type NewAuthorization,
} from "../../../../core/authorizationListeners.js";
import {
  isObtainPathKind,
  OBTAIN_PATH_KINDS,
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
 * deployment's `KEY_HASH_PEPPER`. `null` on a deployment without the pepper: the salt would then
 * be public, and the key recomputable from any account id, so no key is made at all.
 */
export async function storefrontAccountKey(
  env: Env,
  accountId: string,
  day: string,
): Promise<string | null> {
  if (!env.KEY_HASH_PEPPER) return null;
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
 * showed it first. ONE atomic batch for the whole listing: each product's dedupe insert is followed
 * by its counter's upsert, which runs only when that insert wrote a row (`changes()` reads the
 * statement just before it, inside the batch's transaction). Nothing is written without
 * `KEY_HASH_PEPPER`. Best effort (see the file comment).
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
    if (key === null) return;
    const statements: DbStatement[] = [];
    for (const { product, kind } of shown) {
      statements.push(
        {
          sql: `INSERT INTO storefront_seen (product, day, account_key) VALUES (?, ?, ?)
                ON CONFLICT(product, day, account_key) DO NOTHING`,
          params: [product, day, key],
        },
        {
          sql: `INSERT INTO storefront_daily
                  (product, day, path_kind, impressions, adds, activations)
                SELECT ?, ?, ?, 1, 0, 0 WHERE changes() > 0
                ON CONFLICT(product, day, path_kind) DO UPDATE SET impressions = impressions + 1`,
          params: [product, day, kind],
        },
      );
    }
    await db.batch(statements);
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

const PATH_RE = /\(source: discover; path: ([a-z_]+)[;)]/g;
const LEGACY_REASON_RE = /\(source: discover; reason: ([^;)]+)[;)]/g;

/**
 * The path kind a `portal.discover.claim` summary names (`Added <name> from Discover (source:
 * discover; path: <kind>; reason: <code>)`, written by the claim since PS-04), or, for a claim
 * written before PS-04, the kind its reason implies (`group:<g>` → `group`, `free_with_account` →
 * `auto_issue`). `null` when neither reads. The LAST match wins: the product's name comes first in
 * the summary and is the operator's text, so a name that spells the marker cannot choose the kind.
 */
export function claimPathKind(summary: string | null): ObtainPathKind | null {
  if (!summary) return null;
  const path = [...summary.matchAll(PATH_RE)].at(-1)?.[1];
  if (path !== undefined) return isObtainPathKind(path) ? path : null;
  const reason = [...summary.matchAll(LEGACY_REASON_RE)].at(-1)?.[1];
  if (reason === "free_with_account") return "auto_issue";
  if (reason?.startsWith("group:")) return "group";
  return null;
}

/**
 * Core's new-authorization listener: count the licence's first device ever, when the licence was
 * added from Discover at most `ACTIVATION_WINDOW_SECONDS` before, on the add's day and path kind.
 * Reads only, but for the counter: the claim behind the licence is its `portal.discover.claim` row
 * (by primary key), and "first" is Core's `firstOnLicense`, so no per-person record is written.
 */
export async function recordFirstActivation(
  ctx: AuthorizationListenerContext,
  event: NewAuthorization,
): Promise<void> {
  if (!event.firstOnLicense) return;
  const { db, now } = ctx;
  const claim = await db.first<{ at: number; summary: string | null }>(
    "SELECT at, summary FROM portal_audit WHERE id = ? AND action = 'portal.discover.claim'",
    discoverClaimAuditId(event.product, event.licenseId),
  );
  if (!claim || now - claim.at > ACTIVATION_WINDOW_SECONDS) return;
  const kind = claimPathKind(claim.summary);
  if (!kind) return;
  await bump(db, event.product, storefrontDay(claim.at), kind, "activations");
}

registerAuthorizationListener("storefront.activations", recordFirstActivation);

// ── The console card (PS-06) ────────────────────────────────────────────────────────────────

/** The console card's window: the last 28 UTC days, today included (notes/S-21 §6.6). */
export const ANALYTICS_DAYS = 28;

/** The three counters of one row, or of a sum of rows. */
export interface StorefrontCounts {
  impressions: number;
  adds: number;
  activations: number;
}

/** One path kind's sums over the window. */
export interface StorefrontKindCounts extends StorefrontCounts {
  kind: StorefrontPathKind;
}

/** One UTC day's sums over every path kind. */
export interface StorefrontDayCounts extends StorefrontCounts {
  day: string;
}

export interface StorefrontAnalytics {
  /** The window's first and last UTC days, inclusive. */
  from: string;
  to: string;
  days: number;
  totals: StorefrontCounts;
  /** Every kind with a count in the window, in `OBTAIN_PATH_KINDS` order, `link` last. */
  byKind: StorefrontKindCounts[];
  /** Every day of the window, oldest first, zero where nothing was counted. */
  daily: StorefrontDayCounts[];
}

const KIND_ORDER: readonly string[] = [...OBTAIN_PATH_KINDS, LINK_PATH_KIND];

/**
 * The card's numbers (PS-06): `storefront_daily` summed over the window, per path kind and per
 * day. Aggregates only, as stored: no row names a person, so nothing here can either. An
 * activation counts on its add's day, so the newest week's activations are still arriving.
 */
export async function storefrontAnalytics(
  db: Db,
  product: string,
  now: number,
  days: number = ANALYTICS_DAYS,
): Promise<StorefrontAnalytics> {
  const from = storefrontDay(now - (days - 1) * 86400);
  const to = storefrontDay(now);
  const rows = await db.all<{
    day: string;
    path_kind: string;
    impressions: number;
    adds: number;
    activations: number;
  }>(
    `SELECT day, path_kind, impressions, adds, activations
       FROM storefront_daily
      WHERE product = ? AND day >= ? AND day <= ?`,
    product,
    from,
    to,
  );
  const zero = (): StorefrontCounts => ({
    impressions: 0,
    adds: 0,
    activations: 0,
  });
  const add = (into: StorefrontCounts, r: StorefrontCounts): void => {
    into.impressions += r.impressions;
    into.adds += r.adds;
    into.activations += r.activations;
  };
  const totals = zero();
  const kinds = new Map<string, StorefrontCounts>();
  const byDay = new Map<string, StorefrontCounts>();
  for (const r of rows) {
    // A kind this Worker does not know (written by a newer one) still counts in the totals.
    add(totals, r);
    if (!kinds.has(r.path_kind)) kinds.set(r.path_kind, zero());
    add(kinds.get(r.path_kind)!, r);
    if (!byDay.has(r.day)) byDay.set(r.day, zero());
    add(byDay.get(r.day)!, r);
  }
  const rank = (k: string): number => {
    const i = KIND_ORDER.indexOf(k);
    return i === -1 ? KIND_ORDER.length : i;
  };
  const byKind = [...kinds.entries()]
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .map(([kind, c]) => ({ kind: kind as StorefrontPathKind, ...c }));
  const daily: StorefrontDayCounts[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const day = storefrontDay(now - i * 86400);
    daily.push({ day, ...(byDay.get(day) ?? zero()) });
  }
  return { from, to, days, totals, byKind, daily };
}

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
