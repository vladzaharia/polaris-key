// The one audit writer (P0-18, absorbing ST-24).
//
// Every `audit` and `platform_audit` row is built here, from `auditStatement` and
// `platformAuditStatement`; `test/auditWriter.test.ts` greps `src/` for any other
// `INSERT INTO audit`. Callers say what happened and who did it; they never write the column list.
//
//   Actor      `AuditActor` (sub, name, email). `actorOf(session)` takes it from the VERIFIED admin
//              session, never from a request field. `SYSTEM_ACTORS` names the runtime's own.
//   Statement  `auditStatement(row, tail?)` returns a `DbStatement` for a batch that commits the
//              row with the change it records. Any column may be a literal or a `sql()` fragment;
//              `tail` adds `WHERE <guard>` (a guarded batch) or `FROM … WHERE …` (one row per
//              matching row).
//   Retention  `pruneAudit` / `prunePlatformAudit` (ST-24): past the cutoff a row goes, except the
//              latest row of each setting, which is its history's anchor and survives every purge.
//   Export     `exportAuditNdjson` / `exportPlatformAuditNdjson`: one JSON object per line, newest
//              first, every column the table has (before/after/origin/reason/setting key included).
//
// A-12: an action on the platform as a whole (no product) goes to `platform_audit`, read by
// `GET /manage/api/platform/activity`.

import type { Db, DbParam, DbStatement } from "../db/types.js";
import { randomId } from "../platform/crypto.js";
import type { AdminSession } from "./console/session.js";

// ── Actors ─────────────────────────────────────────────────────────────────────

/** Who an audit row names: the verified admin session, or one of `SYSTEM_ACTORS`. */
export interface AuditActor {
  sub: string | null;
  name: string | null;
  email: string | null;
}

/** The actor of a console write, from the verified session. */
export function actorOf(
  session: Pick<AdminSession, "sub" | "name" | "email">,
): AuditActor {
  return { sub: session.sub, name: session.name, email: session.email };
}

/** An actor as the three audit columns, for a row literal: `{ product, at, ...actorColumns(a) }`. */
export function actorColumns(actor: AuditActor): {
  actor_sub: string | null;
  actor_name: string | null;
  actor_email: string | null;
} {
  return {
    actor_sub: actor.sub,
    actor_name: actor.name,
    actor_email: actor.email,
  };
}

/** The runtime's own actors: no session behind the row. */
export const SYSTEM_ACTORS = {
  /** Manifest resync, link and register. */
  resync: { sub: "resync", name: "Manifest resync", email: null },
  /** The deploy hook's settings rows. */
  deploy: { sub: "deploy", name: "Deploy hook", email: null },
  /** The platform itself (scheduled work, asset pulls): the `system` filter in the feed. */
  platform: { sub: null, name: "Polaris Key", email: null },
} as const satisfies Record<string, AuditActor>;

// ── Rows ───────────────────────────────────────────────────────────────────────

export interface AuditRow {
  product: string;
  id: string;
  at: number;
  actor_sub: string | null;
  actor_name: string | null;
  actor_email: string | null;
  action: string;
  target_kind: string | null;
  target_id: string | null;
  parent_id: string | null;
  summary: string | null;
  /** Settings history (ST-04): the value before and after, as JSON, with the way in. */
  before_json?: string | null;
  after_json?: string | null;
  origin?: string | null;
  reason?: string | null;
  setting_key?: string | null;
}

export interface PlatformAuditRow {
  id: string;
  at: number;
  actor_sub: string | null;
  actor_name: string | null;
  actor_email: string | null;
  action: string;
  target_kind: string | null;
  target_id: string | null;
  summary: string | null;
  before_json: string | null;
  after_json: string | null;
  origin?: string | null;
  reason?: string | null;
  setting_key?: string | null;
}

/** A SQL expression with its parameters, usable wherever a column takes a value. */
export interface AuditSql {
  sql: string;
  params: readonly DbParam[];
}

/** An expression in place of a literal: `sql("? || key", "prefix ")`. */
export function sql(text: string, ...params: DbParam[]): AuditSql {
  return { sql: text, params };
}

type Col<T> = T | AuditSql;

/** What `auditStatement` takes: `AuditRow` with any column an expression, `id` defaulted. */
export type AuditInsert = {
  [K in keyof AuditRow]?: Col<AuditRow[K]>;
} & { product: Col<string>; at: Col<number>; action: string };

const AUDIT_COLUMNS = [
  "product",
  "id",
  "at",
  "actor_sub",
  "actor_name",
  "actor_email",
  "action",
  "target_kind",
  "target_id",
  "parent_id",
  "summary",
  "before_json",
  "after_json",
  "origin",
  "reason",
  "setting_key",
] as const satisfies readonly (keyof AuditRow)[];

const PLATFORM_AUDIT_COLUMNS = [
  "id",
  "at",
  "actor_sub",
  "actor_name",
  "actor_email",
  "action",
  "target_kind",
  "target_id",
  "summary",
  "before_json",
  "after_json",
  "origin",
  "reason",
  "setting_key",
] as const satisfies readonly (keyof PlatformAuditRow)[];

function isSql(v: unknown): v is AuditSql {
  return typeof v === "object" && v !== null && "sql" in v && "params" in v;
}

/** `INSERT INTO <table> (<columns>) SELECT <one expression per column> <tail>`. */
function insertStatement(
  table: "audit" | "platform_audit",
  columns: readonly string[],
  row: Record<string, unknown>,
  tail: AuditSql | undefined,
  orIgnore = false,
): DbStatement {
  const exprs: string[] = [];
  const params: DbParam[] = [];
  for (const column of columns) {
    const v = row[column];
    if (isSql(v)) {
      exprs.push(`(${v.sql})`);
      params.push(...v.params);
    } else {
      exprs.push("?");
      params.push((v ?? null) as DbParam);
    }
  }
  const head = `INSERT ${orIgnore ? "OR IGNORE " : ""}INTO ${table} (${columns.join(", ")})`;
  // A plain row is `VALUES (…)`: the statement guards elsewhere (`unlessClaimed`,
  // `guardStatement`, `guardedInsert`) rewrite that shape into `SELECT … WHERE <guard>`.
  if (!tail && exprs.every((e) => e === "?"))
    return { sql: `${head} VALUES (${exprs.join(", ")})`, params };
  return {
    sql: `${head} SELECT ${exprs.join(", ")}${tail ? ` ${tail.sql}` : ""}`,
    params: [...params, ...(tail?.params ?? [])],
  };
}

/**
 * The one builder of an `audit` row, as a statement for a batch that commits it with the change
 * it records. `tail`: `sql("WHERE <guard>", …)` writes the row only while the guard holds (a
 * guarded batch whose other statements carry the same condition); `sql("FROM <t> WHERE …")` writes
 * one row per matching row, with the columns as expressions over it.
 */
export function auditStatement(
  row: AuditInsert,
  tail?: AuditSql,
  opts: { orIgnore?: boolean } = {},
): DbStatement {
  return insertStatement(
    "audit",
    AUDIT_COLUMNS,
    { ...row, id: row.id ?? randomId("aud") },
    tail,
    opts.orIgnore,
  );
}

export async function appendAudit(db: Db, row: AuditInsert): Promise<void> {
  const stmt = auditStatement(row);
  await db.run(stmt.sql, ...stmt.params);
}

/** The platform trail's twin of `auditStatement`. */
export function platformAuditStatement(
  row: Omit<PlatformAuditRow, "id" | "before_json" | "after_json"> &
    Partial<PlatformAuditRow>,
  tail?: AuditSql,
): DbStatement {
  return insertStatement(
    "platform_audit",
    PLATFORM_AUDIT_COLUMNS,
    { ...row, id: row.id ?? randomId("paud") },
    tail,
  );
}

export async function appendPlatformAudit(
  db: Db,
  row: Parameters<typeof platformAuditStatement>[0],
): Promise<void> {
  const stmt = platformAuditStatement(row);
  await db.run(stmt.sql, ...stmt.params);
}

// ── Console wrappers (the verified session is the actor) ───────────────────────

type Target = { kind: string; id: string } | null;

export async function audit(
  db: Db,
  product: string,
  session: AdminSession,
  now: number,
  action: string,
  target: Target,
  summary: string,
): Promise<void> {
  await appendAudit(
    db,
    sessionRow(product, session, now, action, target, summary),
  );
}

function sessionRow(
  product: string,
  session: AdminSession,
  now: number,
  action: string,
  target: Target,
  summary: string,
): AuditInsert {
  const actor = actorOf(session);
  return {
    product,
    at: now,
    actor_sub: actor.sub,
    actor_name: actor.name,
    actor_email: actor.email,
    action,
    target_kind: target?.kind ?? null,
    target_id: target?.id ?? null,
    parent_id: null,
    summary,
  };
}

/**
 * `audit` as a statement, for a batch that commits the row with the change it records. `when`, a
 * boolean SQL condition, writes the row only while it holds (a guarded batch, such as a licence
 * deletion, whose other statements carry the same condition).
 */
export function auditStatementFor(
  product: string,
  session: AdminSession,
  now: number,
  action: string,
  target: Target,
  summary: string,
  when?: { sql: string; params: DbParam[] },
): DbStatement {
  return auditStatement(
    sessionRow(product, session, now, action, target, summary),
    when ? sql(`WHERE ${when.sql}`, ...when.params) : undefined,
  );
}

/**
 * An admin action that belongs to no product (A-12). `change.before` / `change.after` are stored
 * as JSON so the activity feed can show what changed; a caller must never pass a secret, key
 * material or anything derived from one (a hash, a length) in either.
 */
function platformRow(
  session: AdminSession,
  now: number,
  action: string,
  target: Target,
  summary: string,
  change: { before?: unknown; after?: unknown },
): PlatformAuditRow {
  const actor = actorOf(session);
  return {
    id: randomId("paud"),
    at: now,
    actor_sub: actor.sub,
    actor_name: actor.name,
    actor_email: actor.email,
    action,
    target_kind: target?.kind ?? null,
    target_id: target?.id ?? null,
    summary,
    before_json:
      change.before === undefined ? null : JSON.stringify(change.before),
    after_json:
      change.after === undefined ? null : JSON.stringify(change.after),
  };
}

export async function platformAudit(
  db: Db,
  session: AdminSession,
  now: number,
  action: string,
  target: Target,
  summary: string,
  change: { before?: unknown; after?: unknown } = {},
): Promise<void> {
  await appendPlatformAudit(
    db,
    platformRow(session, now, action, target, summary, change),
  );
}

/** `platformAudit` as a statement, for a batch that commits it with the change it records. */
export function platformAuditStatementFor(
  session: AdminSession,
  now: number,
  action: string,
  target: Target,
  summary: string,
  change: { before?: unknown; after?: unknown } = {},
): DbStatement {
  return platformAuditStatement(
    platformRow(session, now, action, target, summary, change),
  );
}

// ── Retention (ST-24) ──────────────────────────────────────────────────────────

/**
 * Delete one product's `audit` rows older than `cutoff`, except the latest row of each setting
 * (the newest `(at, id)` per `setting_key`), which survives every purge so a setting's history
 * never empties. Returns how many were removed.
 *
 * R11-09: nothing used to delete from this table. Bounded by `limit` and driven from the
 * `scheduled()` sweep, which calls it repeatedly until a pass removes fewer rows than it asked
 * for, so an old, huge backlog drains over several nights instead of one statement trying to
 * delete millions of rows inside a single D1 invocation. Kept rows are never selected, so they
 * do not hold the loop open.
 *
 * `idx_audit_time(product, at DESC, id DESC)` serves the inner SELECT and `idx_audit_setting`
 * the keep test. The `product` predicate is mandatory, as everywhere: retention on a shared
 * table must never reach past the tenant it was asked about.
 */
export async function pruneAudit(
  db: Db,
  product: string,
  cutoff: number,
  limit: number,
): Promise<number> {
  return db.runChanges(
    `DELETE FROM audit
      WHERE rowid IN (
        SELECT a.rowid FROM audit a
         WHERE a.product = ? AND a.at < ?
           AND (a.setting_key IS NULL OR EXISTS (
                 SELECT 1 FROM audit n
                  WHERE n.product = a.product AND n.setting_key = a.setting_key
                    AND (n.at > a.at OR (n.at = a.at AND n.id > a.id))))
         LIMIT ?
      )`,
    product,
    cutoff,
    limit,
  );
}

/**
 * Delete `platform_audit` rows older than `cutoff`, at most `limit` per call, keeping the latest
 * row of each setting (see `pruneAudit`). The table has no product column: it is platform-level
 * by construction, which `scheduled.ts`'s "product-scoped" property names explicitly.
 */
export async function prunePlatformAudit(
  db: Db,
  cutoff: number,
  limit: number,
): Promise<number> {
  return db.runChanges(
    `DELETE FROM platform_audit
      WHERE rowid IN (
        SELECT a.rowid FROM platform_audit a
         WHERE a.at < ?
           AND (a.setting_key IS NULL OR EXISTS (
                 SELECT 1 FROM platform_audit n
                  WHERE n.setting_key = a.setting_key
                    AND (n.at > a.at OR (n.at = a.at AND n.id > a.id))))
         LIMIT ?
      )`,
    cutoff,
    limit,
  );
}

// ── Reading (keyset pagination on (at DESC, id DESC)) ──────────────────────────

/**
 * The activity feed's filters (A-2). Every one narrows; none widens. `action` is a PREFIX
 * (`license.` matches `license.create` and `license.tier.change`), compared with `substr` so a
 * `%` or `_` in it is literal. `actor` matches the subject or the email exactly; the reserved
 * value `system` matches the rows the runtime writes with no session behind them. `since` and
 * `until` are epoch seconds, inclusive.
 */
export interface AuditFilters {
  action?: string;
  actor?: string;
  /**
   * Other `actor_sub` values that name the same person as `actor` (ST-30: the member id and the
   * IdP subject of one operator; `consoleActorAliases`). Only ever widens `actor` to the same
   * person's other ids, so a filter still matches one person.
   */
  actorAliases?: readonly string[];
  targetKind?: string;
  targetId?: string;
  since?: number;
  until?: number;
  /** One row by id (ST-51: an event's deep link). */
  id?: string;
}

function filterWhere(
  opts: AuditFilters & { beforeAt?: number; beforeId?: string },
  where: string[],
  params: DbParam[],
): void {
  if (opts.beforeAt !== undefined && opts.beforeId !== undefined) {
    where.push("(at < ? OR (at = ? AND id < ?))");
    params.push(opts.beforeAt, opts.beforeAt, opts.beforeId);
  }
  if (opts.action) {
    where.push("substr(action, 1, ?) = ?");
    params.push(opts.action.length, opts.action);
  }
  if (opts.actor === "system") {
    where.push("(actor_sub IS NULL OR actor_sub = '')");
  } else if (opts.actor) {
    const subs = [...new Set([opts.actor, ...(opts.actorAliases ?? [])])];
    where.push(
      `(actor_sub IN (${subs.map(() => "?").join(", ")}) OR actor_email = ?)`,
    );
    params.push(...subs, opts.actor);
  }
  if (opts.targetKind) {
    where.push("target_kind = ?");
    params.push(opts.targetKind);
  }
  if (opts.targetId) {
    where.push("target_id = ?");
    params.push(opts.targetId);
  }
  if (opts.id) {
    where.push("id = ?");
    params.push(opts.id);
  }
  if (opts.since !== undefined) {
    where.push("at >= ?");
    params.push(opts.since);
  }
  if (opts.until !== undefined) {
    where.push("at <= ?");
    params.push(opts.until);
  }
}

function pageLimit(requested: number | undefined): number {
  // An integer in 1..200; -1 (SQLite: no limit) and fractions never reach the query.
  const raw = Math.floor(requested ?? 50);
  return Math.min(Number.isFinite(raw) ? Math.max(raw, 1) : 50, 200);
}

export async function listAudit(
  db: Db,
  product: string,
  opts: {
    beforeAt?: number;
    beforeId?: string;
    limit?: number;
  } & AuditFilters = {},
): Promise<AuditRow[]> {
  const where: string[] = ["product = ?"];
  const params: DbParam[] = [product];
  filterWhere(opts, where, params);
  return db.all<AuditRow>(
    `SELECT * FROM audit WHERE ${where.join(" AND ")}
     ORDER BY at DESC, id DESC LIMIT ?`,
    ...params,
    pageLimit(opts.limit),
  );
}

export async function listPlatformAudit(
  db: Db,
  opts: {
    beforeAt?: number;
    beforeId?: string;
    limit?: number;
  } & AuditFilters = {},
): Promise<PlatformAuditRow[]> {
  const where: string[] = [];
  const params: DbParam[] = [];
  filterWhere(opts, where, params);
  return db.all<PlatformAuditRow>(
    `SELECT * FROM platform_audit ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY at DESC, id DESC LIMIT ?`,
    ...params,
    pageLimit(opts.limit),
  );
}

/** One row of the platform Activity page: either trail, with the product it belongs to. */
export type ActivityRow = PlatformAuditRow & { product: string | null };

/** The columns both trails carry, in the order the union selects them. */
const UNION_COLUMNS =
  "id, at, actor_sub, actor_name, actor_email, action, target_kind, target_id, summary, before_json, after_json, origin, reason, setting_key";

/**
 * ST-51: the platform Activity page's feed. `product` is `all` (every product's trail and the
 * platform trail, newest first), `platform` (the platform trail only) or a product slug. Each
 * branch applies the same filters and cursor, so a page costs a keyset read per table, not a scan
 * of the union.
 */
export async function listActivity(
  db: Db,
  opts: {
    product: string;
    beforeAt?: number;
    beforeId?: string;
    limit?: number;
  } & AuditFilters,
): Promise<ActivityRow[]> {
  const where: string[] = [];
  const params: DbParam[] = [];
  filterWhere(opts, where, params);
  const limit = pageLimit(opts.limit);
  const clause = (extra: string[]): string => {
    const all = [...extra, ...where];
    return all.length ? `WHERE ${all.join(" AND ")}` : "";
  };
  const branches: { sql: string; params: DbParam[] }[] = [];
  if (opts.product !== "platform") {
    const slug = opts.product !== "all";
    branches.push({
      sql: `SELECT product, ${UNION_COLUMNS} FROM audit ${clause(slug ? ["product = ?"] : [])}
            ORDER BY at DESC, id DESC LIMIT ?`,
      params: [...(slug ? [opts.product] : []), ...params, limit],
    });
  }
  if (opts.product === "all" || opts.product === "platform") {
    branches.push({
      sql: `SELECT NULL AS product, ${UNION_COLUMNS} FROM platform_audit ${clause([])}
            ORDER BY at DESC, id DESC LIMIT ?`,
      params: [...params, limit],
    });
  }
  const inner = branches
    .map((b) => `SELECT * FROM (${b.sql})`)
    .join(" UNION ALL ");
  return db.all<ActivityRow>(
    `SELECT * FROM (${inner}) ORDER BY at DESC, id DESC LIMIT ?`,
    ...branches.flatMap((b) => b.params),
    limit,
  );
}

// ── Export (ST-24) ─────────────────────────────────────────────────────────────

/** The most rows one export returns; `truncated` says there were more. */
export const AUDIT_EXPORT_MAX_ROWS = 10_000;

export interface AuditExport {
  /** One JSON object per line, newest first; empty when nothing matches. */
  body: string;
  rows: number;
  truncated: boolean;
}

async function exportPages<T extends { at: number; id: string }>(
  page: (cursor: { beforeAt?: number; beforeId?: string }) => Promise<T[]>,
): Promise<AuditExport> {
  const lines: string[] = [];
  let cursor: { beforeAt?: number; beforeId?: string } = {};
  let truncated = false;
  for (;;) {
    const rows = await page(cursor);
    for (const row of rows) {
      if (lines.length >= AUDIT_EXPORT_MAX_ROWS) {
        truncated = true;
        break;
      }
      lines.push(JSON.stringify(row));
    }
    const last = rows[rows.length - 1];
    if (truncated || rows.length < 200 || !last) break;
    cursor = { beforeAt: last.at, beforeId: last.id };
  }
  return {
    body: lines.length ? `${lines.join("\n")}\n` : "",
    rows: lines.length,
    truncated,
  };
}

/** A product's audit history as NDJSON, under the activity feed's filters. */
export function exportAuditNdjson(
  db: Db,
  product: string,
  filters: AuditFilters = {},
): Promise<AuditExport> {
  return exportPages((cursor) =>
    listAudit(db, product, { ...filters, ...cursor, limit: 200 }),
  );
}

/** The platform trail as NDJSON, under the activity feed's filters. */
export function exportPlatformAuditNdjson(
  db: Db,
  filters: AuditFilters = {},
): Promise<AuditExport> {
  return exportPages((cursor) =>
    listPlatformAudit(db, { ...filters, ...cursor, limit: 200 }),
  );
}
