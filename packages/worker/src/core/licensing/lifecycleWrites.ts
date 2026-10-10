/**
 * LX-12: the lifecycle's writers and the grant read predicate, as SQL derived from the tables in
 * `lifecycle.ts`.
 *
 * Every UPDATE here is guarded by the source states of its event, read from the table, so the
 * database can only take a transition the table has. A stale read or a concurrent write cannot
 * move a row along a path the table lacks: an operator's Enable that races a refund finds the row
 * outside `reinstate`'s sources and changes nothing. A test runs every cell of both tables
 * through these statements against SQLite.
 *
 * The SQL literals are the module's own constant vocabularies, never caller input; everything a
 * caller supplies is bound.
 */

import type { Db, DbParam, DbStatement } from "../../db/types.js";
import { STORES } from "../storeGrants.js";
import {
  GRANT_CONTRIBUTING_STATES,
  grantEventMoves,
  grantTransition,
  isGrantState,
  LICENSE_ENDED_REASONS,
  licenseEndedReasonOf,
  licenseEventMoves,
  licenseLifecycleState,
  licenseStatusOf,
  licenseTransition,
  type GrantEvent,
  type GrantState,
  type LicenseEvent,
  type LicenseLifecycleColumns,
  type LicenseLifecycleState,
  type LifecycleOutcome,
} from "./lifecycle.js";

const lit = (s: string): string => `'${s}'`;
const col = (alias: string | null, name: string): string =>
  alias ? `${alias}.${name}` : name;

// ── licences ─────────────────────────────────────────────────────────────────────────────────

/** SQL: the licence row is in `state`, exactly as `licenseLifecycleState` reads it. */
export function licenseStateSql(
  state: LicenseLifecycleState,
  alias: string | null = null,
): string {
  const status = col(alias, "status");
  const reason = col(alias, "ended_reason");
  if (state === "active") return `${status} = 'active'`;
  if (state === "suspended")
    return `(${status} <> 'active' AND (${reason} IS NULL OR ${reason} NOT IN (${LICENSE_ENDED_REASONS.map(lit).join(", ")})))`;
  return `(${status} <> 'active' AND ${reason} = ${lit(state)})`;
}

/** SQL: the licence is in a state `event` moves it from. */
export function licenseEventSourceSql(
  event: LicenseEvent,
  alias: string | null = null,
): string {
  const { from } = licenseEventMoves(event);
  return `(${from.map((s) => licenseStateSql(s, alias)).join(" OR ")})`;
}

function reasonLiteral(state: LicenseLifecycleState): string {
  const reason = licenseEndedReasonOf(state);
  return reason === null ? "NULL" : lit(reason);
}

/**
 * The SET items that put a licence where `event` moves it: its `status` and `ended_reason`. A
 * statement that writes them must also carry {@link licenseEventSourceSql} in its WHERE, so it
 * only moves rows the table moves. `supersede` also writes `superseded_by`
 * ({@link licenseTransitionStatement}).
 */
export function licenseTargetSetSql(event: LicenseEvent): string {
  const { target } = licenseEventMoves(event);
  return `status = ${lit(licenseStatusOf(target))}, ended_reason = ${reasonLiteral(target)}`;
}

/** One licence's event. */
export interface LicenseTransitionArgs {
  product: string;
  licenseId: string;
  event: LicenseEvent;
  /** `modified_by`: an operator's subject, `oidc`, `system:commerce`. */
  actor: string | null;
  now: number;
  /** `supersede` only, and required there: the licence that replaced this one. */
  supersededBy?: string;
}

/**
 * The guarded UPDATE that applies one event to one licence: the target's `status` and
 * `ended_reason` (with `superseded_by` for `supersede`), written only while the row is in one of
 * the event's source states. A row in any other state is left exactly as it is (`modified_at`
 * included), so a replayed event writes nothing.
 */
export function licenseTransitionStatement(
  args: LicenseTransitionArgs,
): DbStatement {
  const sets = [licenseTargetSetSql(args.event)];
  const params: DbParam[] = [];
  if (args.event === "supersede") {
    if (!args.supersededBy)
      throw new Error("licenseTransitionStatement: supersede needs supersededBy");
    sets.push("superseded_by = ?");
    params.push(args.supersededBy);
  }
  sets.push("modified_by = ?", "modified_at = ?");
  params.push(args.actor, args.now, args.product, args.licenseId);
  return {
    sql: `UPDATE licenses SET ${sets.join(", ")}
           WHERE product = ? AND id = ? AND ${licenseEventSourceSql(args.event)}`,
    params,
  };
}

/**
 * The SET items that apply `event` inside a statement that also touches rows the event does not
 * move (a product's deletion updates every licence it has): a row in a source state takes the
 * target's `status` and `ended_reason`, every other row keeps both. SQLite evaluates each SET
 * expression against the row as it was, so the two CASEs read the same state. `supersede` needs a
 * licence per row and has no bulk form.
 */
export function licenseTransitionSetSql(event: LicenseEvent): string {
  if (event === "supersede")
    throw new Error("licenseTransitionSetSql: supersede has no bulk form");
  const { target } = licenseEventMoves(event);
  const source = licenseEventSourceSql(event);
  return [
    `status = CASE WHEN ${source} THEN ${lit(licenseStatusOf(target))} ELSE status END`,
    `ended_reason = CASE WHEN ${source} THEN ${reasonLiteral(target)} ELSE ended_reason END`,
  ].join(", ");
}

/** What one {@link transitionLicense} did. */
export interface LicenseTransitionResult {
  /** The licence's state when the event arrived. */
  from: LicenseLifecycleState;
  /** What the table answers for that state and event. */
  outcome: LifecycleOutcome<LicenseLifecycleState>;
  /** Whether the row changed. */
  changed: boolean;
  /** The licence's state afterwards. */
  to: LicenseLifecycleState;
}

async function readLicenseState(
  db: Db,
  product: string,
  licenseId: string,
): Promise<LicenseLifecycleState | null> {
  const row = await db.first<LicenseLifecycleColumns>(
    "SELECT status, ended_reason FROM licenses WHERE product = ? AND id = ?",
    product,
    licenseId,
  );
  return row ? licenseLifecycleState(row) : null;
}

/**
 * Apply one event to one licence: read its state, ask the table, and write the guarded UPDATE
 * when the table moves it. `null` when there is no such licence. A `refused` outcome writes
 * nothing; the caller answers the error. When a concurrent write moved the row out of the
 * event's sources between the read and the write, nothing is written and `to` is where the row
 * is now.
 */
export async function transitionLicense(
  db: Db,
  args: LicenseTransitionArgs,
): Promise<LicenseTransitionResult | null> {
  const from = await readLicenseState(db, args.product, args.licenseId);
  if (from === null) return null;
  const outcome = licenseTransition(from, args.event);
  if (outcome === "same" || outcome === "refused")
    return { from, outcome, changed: false, to: from };
  const stmt = licenseTransitionStatement(args);
  if ((await db.runChanges(stmt.sql, ...stmt.params)) > 0)
    return { from, outcome, changed: true, to: outcome };
  const to = await readLicenseState(db, args.product, args.licenseId);
  return { from, outcome, changed: false, to: to ?? from };
}

// ── grants (add-ons) ─────────────────────────────────────────────────────────────────────────

/**
 * Store-sourced grants are left out of every transition here. Until LX-11 retires the dual-write,
 * a store grant's state is the projection of `license_store_grants` (`core/grants.ts`
 * `storeGrantProjection`): a transition written here would be overwritten by that purchase's next
 * projection and reported as drift. Their refunds and revocations arrive through `applyStoreGrant`.
 */
const STORE_SOURCES_SQL = STORES.map(lit).join(", ");

/** Which grants one event applies to: one grant, or every grant of one order (a bundle). */
export type GrantTarget = { grantId: string } | { orderRef: string };

export interface GrantTransitionArgs {
  product: string;
  target: GrantTarget;
  event: GrantEvent;
  /** `modified_by`: an operator's subject, `commerce`, `oidc`. */
  actor: string;
  now: number;
}

/**
 * The guarded UPDATE that applies one event to one grant, or to every grant of one order: the
 * target state, written only while a grant is in one of the event's source states. `grace_until`
 * is not written: nothing reads it (no refund grace; LX-41 puts a billing retry's grace into
 * `expires_at`), so it stays the dormant column it is.
 */
export function grantTransitionStatement(
  args: GrantTransitionArgs,
): DbStatement {
  const { target, from } = grantEventMoves(args.event);
  const byId = "grantId" in args.target;
  return {
    sql: `UPDATE grants SET state = ${lit(target)}, modified_at = ?, modified_by = ?
           WHERE product = ? AND ${byId ? "id" : "order_ref"} = ?
             AND state IN (${from.map(lit).join(", ")})
             AND source NOT IN (${STORE_SOURCES_SQL})`,
    params: [
      args.now,
      args.actor,
      args.product,
      "grantId" in args.target ? args.target.grantId : args.target.orderRef,
    ],
  };
}

/** What one {@link transitionGrant} did. */
export interface GrantTransitionResult {
  from: GrantState;
  outcome: LifecycleOutcome<GrantState>;
  changed: boolean;
  to: GrantState;
}

async function readGrantState(
  db: Db,
  product: string,
  grantId: string,
): Promise<{ state: GrantState; store: boolean } | null> {
  const row = await db.first<{ state: string; source: string }>(
    "SELECT state, source FROM grants WHERE product = ? AND id = ?",
    product,
    grantId,
  );
  if (!row || !isGrantState(row.state)) return null;
  return {
    state: row.state,
    store: (STORES as readonly string[]).includes(row.source),
  };
}

/**
 * Apply one event to one grant, as {@link transitionLicense} does for a licence. `null` when there
 * is no such grant or it is store-sourced (see `STORE_SOURCES_SQL`).
 */
export async function transitionGrant(
  db: Db,
  args: Omit<GrantTransitionArgs, "target"> & { grantId: string },
): Promise<GrantTransitionResult | null> {
  const read = await readGrantState(db, args.product, args.grantId);
  if (read === null || read.store) return null;
  const from = read.state;
  const outcome = grantTransition(from, args.event);
  if (outcome === "same" || outcome === "refused")
    return { from, outcome, changed: false, to: from };
  const stmt = grantTransitionStatement({
    ...args,
    target: { grantId: args.grantId },
  });
  if ((await db.runChanges(stmt.sql, ...stmt.params)) > 0)
    return { from, outcome, changed: true, to: outcome };
  const after = await readGrantState(db, args.product, args.grantId);
  return { from, outcome, changed: false, to: after?.state ?? from };
}

/**
 * SQL: the grant `alias` counts toward its holder's entitlements at `now`, exactly as
 * `grantContributes` decides (one bound parameter, `now`).
 */
export function grantContributesSql(
  alias: string,
  now: number,
): { sql: string; params: DbParam[] } {
  return {
    sql: `(${alias}.state IN (${GRANT_CONTRIBUTING_STATES.map(lit).join(", ")})
           AND (${alias}.expires_at IS NULL OR ? <= ${alias}.expires_at))`,
    params: [now],
  };
}
