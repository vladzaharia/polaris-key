/**
 * Console claims on manifest-declared settings (ST-01b; notes/S-18 §4.3, §4.5, owner decision 1:
 * model C). Core-owned, over `product_settings` (migration 0079).
 *
 * A repo-linked product's `.pkey/` declares some settings that an operator may also edit in the
 * console; before ST-01b every resync overwrote those edits silently. Now:
 *
 *   - a console write to a CLAIMABLE key upserts a `source = 'console'` row here (the claim), in
 *     the same batch as the write; every later resync skips a claimed key;
 *   - absence of a row means the manifest owns the key (S-18 §4.3), so products with no claims
 *     behave exactly as before (ST-01c's backfill is what decides existing products);
 *   - Revert (`revertClaim`) deletes the row and, when the product has a manifest snapshot
 *     (ST-01a), re-applies the snapshot's value at once; with no snapshot it says the value
 *     "applies at the next resync".
 *
 * The five keys here are COLUMN-BACKED, permanently: the hot paths keep reading `products.*` and
 * the active `product_schema`, and the row holds only the claim (`value_json` stays NULL). Tiers
 * and profiles are claimed per row instead, through their own `source` column (migration 0079).
 *
 * `core.adminGroup` is manifest-only (owner decision 1): never claimable, so it is not listed.
 *
 * ST-20 (S-18 §4.5 items 7–8, owner decision D2): MANIFEST-AUTHORITATIVE mode
 * (`core.manifest.authoritative`). A product in it refuses every console claim except a
 * BREAK-GLASS claim (`decideClaim`): a reason is required (the console confirms it at L2), and
 * the row's `expires_at` is the earlier of 7 days or the first apply whose manifest changes that
 * field (`claimsForApply`). An apply that leaves the field alone does not end the claim, so an
 * unrelated push or deploy cannot undo an incident fix. The mode is off by default for a customer
 * product (a `product_settings` row, D14) and on, locked by a registry rule (`systemLock`, the
 * system-lock rule in `settings/rules.ts`), for the system product (`system = 1`), whose only
 * writer is the deploy hook: a resync of it from anywhere else is refused
 * (`SYSTEM_RESYNC_REFUSAL`). Every resync and deploy summary lists the live break-glass claims.
 */

import { Catalog } from "@polaris-key/catalog";
import type { Db, DbStatement } from "../db/types.js";
import { randomId } from "./platform.js";
import { serializeWebOrigins } from "./cors.js";
import { getManifestSnapshot } from "./manifestSnapshot.js";
import { CORE_SLICE } from "./settings/core.js";

/** The column-backed claimable keys ST-01b introduces (registry keys, ST-03). */
export const CLAIM_KEYS = [
  "core.name",
  "license.defaults.maxOfflineDays",
  "license.defaults.deviceLimit",
  "core.web.origins",
  "config.catalog",
] as const;
export type ClaimKey = (typeof CLAIM_KEYS)[number];

export function isClaimKey(key: string): key is ClaimKey {
  return (CLAIM_KEYS as readonly string[]).includes(key);
}

/** A stored `product_settings` row, as D1 returns it. */
export interface ProductSettingRow {
  product: string;
  key: string;
  value_json: string | null;
  source: "manifest" | "console";
  version: number;
  updated_at: number;
  updated_by: string;
  reason: string | null;
  expires_at: number | null;
}

/** One live console claim, as the console shows it. */
export interface ClaimView {
  key: ClaimKey;
  claimedBy: string;
  claimedAt: number;
  version: number;
  /**
   * ST-20: present on a break-glass claim (a manifest-authoritative product): the reason it was
   * made and when it expires at the latest. An ordinary claim (model C) has neither.
   */
  breakGlass?: { reason: string; expiresAt: number };
}

/** A live break-glass claim (ST-20), as the resync and deploy summaries list it. */
export interface BreakGlassClaim {
  key: ClaimKey;
  claimedBy: string;
  claimedAt: number;
  reason: string;
  expiresAt: number;
}

/**
 * Whether a console write claims the field at all. Only a repo-linked product has a manifest that
 * could overwrite it: a manual product's values are the console's by construction. A
 * manifest-authoritative product always claims (`decideClaim`).
 */
export function claimsApply(product: {
  release_source?: string | null;
}): boolean {
  return product.release_source === "github";
}

// ── Manifest-authoritative mode (ST-20) ────────────────────────────────────────────────

/** The mode's registry key (Core's product slice, `settings/core.ts`). */
export const MANIFEST_AUTHORITATIVE_KEY = "core.manifest.authoritative";
/** A break-glass claim lives at most this long (S-18 §4.5 item 7: 7 days). */
export const BREAK_GLASS_MAX_SECONDS = 7 * 24 * 60 * 60;
/** A break-glass reason is 1 to 500 characters, like every other operator reason. */
export const BREAK_GLASS_REASON_MAX = 500;
/**
 * The refusal for a resync of the system product from anywhere but the deploy hook (the GitHub
 * webhook, the console's Resync and its dry run): the deploy hook is its single writer, applying
 * the root `.pkey/` at the deployed commit (S-18 §4.5 item 8).
 */
export const SYSTEM_RESYNC_REFUSAL =
  "the system product is applied by the deploy hook";

/**
 * The system product's mode: the registry's lock (`systemLock`, which the system-lock rule keeps
 * present). Fails closed: a missing lock still reads on.
 */
const SYSTEM_AUTHORITATIVE: boolean = (() => {
  const lock = CORE_SLICE.find(
    (e) => e.scope === "product" && e.key === MANIFEST_AUTHORITATIVE_KEY,
  )?.systemLock;
  return lock ? lock.value === true : true;
})();

/** The resync refusal for `product` (the system product), or `null`. */
export function systemResyncRefusal(product: {
  system?: number | null;
}): string | null {
  return product.system === 1 ? SYSTEM_RESYNC_REFUSAL : null;
}

/** Whether a product is manifest-authoritative, and whether that is locked. */
export interface ManifestAuthority {
  authoritative: boolean;
  /** True for the system product: the registry fixes the value, no row is read. */
  locked: boolean;
  /** The stored row's version; 0 when it was never written (and for a locked value). */
  version: number;
  updatedAt: number | null;
  updatedBy: string | null;
}

/**
 * `core.manifest.authoritative` for `product`. The system product's value is the registry's lock
 * (`systemLock`), never a row: an operator cannot delete or overwrite it. A customer product's is
 * its `product_settings` row (`value_json` `true`/`false`); no row is the default, off (D14).
 */
export async function manifestAuthorityOf(
  db: Db,
  product: { slug: string; system?: number | null },
): Promise<ManifestAuthority> {
  if (product.system === 1)
    return {
      authoritative: SYSTEM_AUTHORITATIVE,
      locked: true,
      version: 0,
      updatedAt: null,
      updatedBy: null,
    };
  const row = await db.first<ProductSettingRow>(
    "SELECT * FROM product_settings WHERE product = ? AND key = ?",
    product.slug,
    MANIFEST_AUTHORITATIVE_KEY,
  );
  return {
    authoritative: row?.value_json === "true",
    locked: false,
    version: row?.version ?? 0,
    updatedAt: row?.updated_at ?? null,
    updatedBy: row?.updated_by ?? null,
  };
}

/** Write a customer product's mode (an operator setting: `source = 'console'`, no expiry). */
export function stmtSetManifestAuthority(
  product: string,
  value: boolean,
  by: string,
  now: number,
): DbStatement {
  return {
    sql: `INSERT INTO product_settings
            (product, key, value_json, source, version, updated_at, updated_by, reason, expires_at)
          VALUES (?, ?, ?, 'console', 1, ?, ?, NULL, NULL)
          ON CONFLICT(product, key) DO UPDATE SET
            value_json = excluded.value_json, source = 'console',
            version = product_settings.version + 1,
            updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    params: [
      product,
      MANIFEST_AUTHORITATIVE_KEY,
      JSON.stringify(value),
      now,
      by,
    ],
  };
}

/**
 * The refusal text for a console write to a claimable setting of a manifest-authoritative
 * product made without a break-glass claim.
 */
export function manifestAuthoritativeRefusal(product: {
  slug: string;
  system?: number | null;
}): string {
  return product.system === 1
    ? "the system product is manifest-authoritative: change the monorepo's .pkey/ (the deploy hook applies it), or make a break-glass claim with a reason"
    : `${product.slug} is manifest-authoritative: edit its .pkey/ instead, or make a break-glass claim with a reason`;
}

/** What a console write to claimable settings may do (`decideClaim`). */
export type ClaimDecision =
  /** Write without a claim: a manual product, whose values are the console's anyway. */
  | { ok: true; claim: null }
  /** Write and claim; a break-glass claim carries its reason and expiry. */
  | {
      ok: true;
      claim: { reason: string | null; expiresAt: number | null };
    }
  | {
      ok: false;
      status: 409 | 422;
      reason: "manifest_authoritative" | "reason_required";
      message: string;
      fields?: string[];
    };

/**
 * Decide a console write to one or more claimable settings of `product` (S-18 §4.5 items 2, 7).
 * Not manifest-authoritative: an ordinary claim on a repo-linked product (model C), none on a
 * manual one; `breakGlass` is not needed and is ignored. Manifest-authoritative: refused (409
 * `manifest_authoritative`) unless `breakGlass` is `{ reason }` with a 1–500 character reason, and
 * then a break-glass claim that expires in 7 days at the latest (`claimsForApply` ends it sooner
 * when an apply changes the field).
 */
export async function decideClaim(
  db: Db,
  product: {
    slug: string;
    system?: number | null;
    release_source?: string | null;
  },
  breakGlass: unknown,
  now: number,
): Promise<ClaimDecision> {
  const authority = await manifestAuthorityOf(db, product);
  if (!authority.authoritative)
    return {
      ok: true,
      claim: claimsApply(product) ? { reason: null, expiresAt: null } : null,
    };
  if (breakGlass === undefined || breakGlass === null)
    return {
      ok: false,
      status: 409,
      reason: "manifest_authoritative",
      message: manifestAuthoritativeRefusal(product),
    };
  const raw =
    typeof breakGlass === "object"
      ? (breakGlass as { reason?: unknown }).reason
      : undefined;
  const reason = typeof raw === "string" ? raw.trim() : "";
  if (reason.length === 0 || reason.length > BREAK_GLASS_REASON_MAX)
    return {
      ok: false,
      status: 422,
      reason: "reason_required",
      message: `a break-glass claim needs a reason of 1 to ${BREAK_GLASS_REASON_MAX} characters`,
      fields: ["breakGlass.reason"],
    };
  return {
    ok: true,
    claim: { reason, expiresAt: now + BREAK_GLASS_MAX_SECONDS },
  };
}

/** The two product facts a claim decision needs, for handlers that hold a loaded product. */
export function claimFacts(
  db: Db,
  product: string,
): Promise<{ system: number | null; release_source: string | null } | null> {
  return db.first<{ system: number | null; release_source: string | null }>(
    "SELECT system, release_source FROM products WHERE slug = ?",
    product,
  );
}

/** The product's live console claims on the column-backed keys. */
export async function listClaims(
  db: Db,
  product: string,
  now: number,
): Promise<ClaimView[]> {
  const rows = await db.all<ProductSettingRow>(
    `SELECT * FROM product_settings
       WHERE product = ? AND source = 'console'
         AND (expires_at IS NULL OR expires_at > ?)
       ORDER BY key`,
    product,
    now,
  );
  return claimViews(rows, now);
}

/** The live claims among `rows` (one product's `product_settings` rows). */
function claimViews(
  rows: readonly ProductSettingRow[],
  now: number,
): ClaimView[] {
  return rows
    .filter(
      (r) =>
        r.source === "console" &&
        isClaimKey(r.key) &&
        (r.expires_at === null || r.expires_at > now),
    )
    .map((r) => ({
      key: r.key as ClaimKey,
      claimedBy: r.updated_by,
      claimedAt: r.updated_at,
      version: r.version,
      ...(r.expires_at !== null
        ? { breakGlass: { reason: r.reason ?? "", expiresAt: r.expires_at } }
        : {}),
    }));
}

/**
 * The console's view of a product's claims and its manifest-authoritative mode, from one read
 * (the product list builds it for every product).
 */
export async function claimsView(
  db: Db,
  product: { slug: string; system?: number | null },
  now: number,
): Promise<{
  claims: ClaimView[];
  manifestAuthoritative: { value: boolean; locked: boolean };
}> {
  const rows = await db.all<ProductSettingRow>(
    "SELECT * FROM product_settings WHERE product = ? ORDER BY key",
    product.slug,
  );
  const locked = product.system === 1;
  const mode = rows.find((r) => r.key === MANIFEST_AUTHORITATIVE_KEY);
  return {
    claims: claimViews(rows, now),
    manifestAuthoritative: {
      value: locked ? SYSTEM_AUTHORITATIVE : mode?.value_json === "true",
      locked,
    },
  };
}

/** The product's live break-glass claims (ST-20). */
export async function breakGlassClaims(
  db: Db,
  product: string,
  now: number,
): Promise<BreakGlassClaim[]> {
  return (await listClaims(db, product, now)).flatMap((c) =>
    c.breakGlass
      ? [
          {
            key: c.key,
            claimedBy: c.claimedBy,
            claimedAt: c.claimedAt,
            reason: c.breakGlass.reason,
            expiresAt: c.breakGlass.expiresAt,
          },
        ]
      : [],
  );
}

/** The claimed keys as a set (what a resync skips). */
export async function claimedKeys(
  db: Db,
  product: string,
  now: number,
): Promise<Set<ClaimKey>> {
  return new Set((await listClaims(db, product, now)).map((c) => c.key));
}

/**
 * The claim guard as SQL, for a writer that must not overwrite a claimed key: true while `key` has
 * a live console claim. Binds `[product, key, now]` (`claimGuardParams`). A resync reads the
 * claims early (to report them and skip their audit rows) but several GitHub round trips pass
 * before its batch runs, so a console save that claims a key in between must still win: the
 * guard lives in each column write, never only in that earlier read.
 */
export const CLAIMED_SQL = `EXISTS (SELECT 1 FROM product_settings
    WHERE product = ? AND key = ? AND source = 'console'
      AND (expires_at IS NULL OR expires_at > ?))`;

export function claimGuardParams(
  product: string,
  key: ClaimKey,
  now: number,
): [string, ClaimKey, number] {
  return [product, key, now];
}

/**
 * `stmt` (an `INSERT INTO t (cols) VALUES (?, ...)`) rewritten to insert nothing once `key` is
 * claimed: `INSERT INTO t (cols) SELECT ?, ... WHERE NOT <CLAIMED_SQL>`.
 */
export function unlessClaimed(
  stmt: DbStatement,
  product: string,
  key: ClaimKey,
  now: number,
): DbStatement {
  const m = /^(\s*INSERT INTO [^(]+\([^)]*\))\s*VALUES\s*\(([^)]*)\)\s*$/s.exec(
    stmt.sql,
  );
  if (!m) throw new Error("unlessClaimed: not a single-row INSERT ... VALUES");
  return {
    sql: `${m[1]} SELECT ${m[2]} WHERE NOT ${CLAIMED_SQL}`,
    params: [...stmt.params, ...claimGuardParams(product, key, now)],
  };
}

/**
 * Claim `key` for the console: "set to the same value keeps one" (S-18 §4.3): the claim is the
 * write, not the difference. A re-claim bumps `version` and takes this write's reason and expiry:
 * `null` for an ordinary claim, the break-glass expiry (ST-20, `decideClaim`) otherwise, so a
 * second break-glass save restarts its 7 days and an ordinary save makes the claim permanent.
 */
export function stmtClaim(
  product: string,
  key: ClaimKey,
  by: string,
  now: number,
  reason: string | null = null,
  expiresAt: number | null = null,
): DbStatement {
  return {
    sql: `INSERT INTO product_settings
            (product, key, value_json, source, version, updated_at, updated_by, reason, expires_at)
          VALUES (?, ?, NULL, 'console', 1, ?, ?, ?, ?)
          ON CONFLICT(product, key) DO UPDATE SET
            source = 'console', version = product_settings.version + 1,
            updated_at = excluded.updated_at, updated_by = excluded.updated_by,
            reason = excluded.reason, expires_at = excluded.expires_at`,
    params: [product, key, now, by, reason, expiresAt],
  };
}

/** Drop a claim (Revert). The row's absence is what "manifest" means. */
export function stmtDeleteClaim(product: string, key: ClaimKey): DbStatement {
  return {
    sql: "DELETE FROM product_settings WHERE product = ? AND key = ?",
    params: [product, key],
  };
}

/** Who a settings audit row names. */
export interface AuditActor {
  sub: string | null;
  name: string | null;
  email: string | null;
}

/** The actor of every resync audit row. */
export const RESYNC_ACTOR: AuditActor = {
  sub: "resync",
  name: "Manifest resync",
  email: null,
};

/** A short, bounded rendering of a setting value for an audit summary. */
export function auditValue(value: unknown): string {
  const text = value === undefined ? "unset" : JSON.stringify(value);
  return text.length > 200 ? `${text.slice(0, 197)}...` : text;
}

/**
 * One per-field settings audit row, as a statement for the writer's batch. ST-04 adds the
 * structured `before_json`/`after_json`/`origin`/`setting_key` columns; until then the key is the
 * target and the summary carries before → after.
 */
export function stmtSettingAudit(
  product: string,
  now: number,
  actor: AuditActor,
  action:
    | "setting.resync"
    | "setting.claim"
    | "setting.revert"
    | "setting.breakGlass.end",
  targetKind: "setting" | "tier" | "profile",
  targetId: string,
  summary: string,
): DbStatement {
  return {
    sql: `INSERT INTO audit
            (product, id, at, actor_sub, actor_name, actor_email, action, target_kind,
             target_id, parent_id, summary)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
    params: [
      product,
      randomId("aud"),
      now,
      actor.sub,
      actor.name,
      actor.email,
      action,
      targetKind,
      targetId,
      summary,
    ],
  };
}

// ── Revert ──────────────────────────────────────────────────────────────────────

/** The fields of a stored snapshot Revert reads (the normalised ParsedManifest, ST-01a). */
interface SnapshotManifest {
  product?: {
    name?: unknown;
    defaultMaxOfflineDays?: unknown;
    defaultDeviceLimit?: unknown;
  };
  webOrigins?: unknown;
  catalog?: unknown;
}

export type RevertResult =
  | { ok: true; applied: true; value: unknown }
  | { ok: true; applied: false; message: string }
  | { ok: false; status: 404 | 409; reason: string; message: string };

const NEXT_RESYNC = "applies at the next resync";

function parseSnapshot(json: string): SnapshotManifest | null {
  try {
    const parsed = JSON.parse(json) as unknown;
    return parsed && typeof parsed === "object"
      ? (parsed as SnapshotManifest)
      : null;
  } catch {
    return null;
  }
}

/**
 * The column write that puts the snapshot's value for `key` back, plus the value it writes, or
 * `null` when the snapshot does not carry a usable one (the claim is still dropped; the value then
 * "applies at the next resync").
 */
async function revertStatements(
  db: Db,
  product: string,
  key: ClaimKey,
  manifest: SnapshotManifest,
  now: number,
): Promise<
  { statements: DbStatement[]; value: unknown } | { refusal: string } | null
> {
  const p = manifest.product ?? {};
  const intIn = (v: unknown, min: number): v is number =>
    typeof v === "number" && Number.isInteger(v) && v >= min;
  switch (key) {
    case "core.name":
      if (typeof p.name !== "string" || p.name.trim() === "") return null;
      return {
        value: p.name,
        statements: [
          {
            sql: "UPDATE products SET name = ?, modified_at = ? WHERE slug = ?",
            params: [p.name, now, product],
          },
        ],
      };
    case "license.defaults.maxOfflineDays":
      if (!intIn(p.defaultMaxOfflineDays, 0)) return null;
      return {
        value: p.defaultMaxOfflineDays,
        statements: [
          {
            sql: "UPDATE products SET default_max_offline_days = ?, modified_at = ? WHERE slug = ?",
            params: [p.defaultMaxOfflineDays, now, product],
          },
        ],
      };
    case "license.defaults.deviceLimit":
      if (!intIn(p.defaultDeviceLimit, 1)) return null;
      return {
        value: p.defaultDeviceLimit,
        statements: [
          {
            sql: "UPDATE products SET default_device_limit = ?, modified_at = ? WHERE slug = ?",
            params: [p.defaultDeviceLimit, now, product],
          },
        ],
      };
    case "core.web.origins": {
      const origins = Array.isArray(manifest.webOrigins)
        ? manifest.webOrigins.filter((o): o is string => typeof o === "string")
        : [];
      return {
        value: origins,
        statements: [
          {
            sql: "UPDATE products SET web_origins_json = ?, modified_at = ? WHERE slug = ?",
            params: [serializeWebOrigins(origins), now, product],
          },
        ],
      };
    }
    case "config.catalog": {
      if (!manifest.catalog || typeof manifest.catalog !== "object")
        return null;
      // The same screening the console publish, linkRepo and a resync apply before writing
      // `product_schema` — the only thing bounding `pattern` complexity. A resync does NOT screen
      // the catalog while it is claimed (it is not installed), yet the snapshot still records it,
      // so a repo writer could otherwise plant a catalog that this Revert would activate unscreened.
      try {
        new Catalog(manifest.catalog as never).compileAll();
      } catch (e) {
        return {
          refusal: `the manifest's catalog is invalid: ${e instanceof Error ? e.message : "unknown error"}`,
        };
      }
      const json = JSON.stringify(manifest.catalog);
      const active = await db.first<{ catalog_json: string }>(
        "SELECT catalog_json FROM product_schema WHERE product = ? AND active = 1 ORDER BY catalog_version DESC LIMIT 1",
        product,
      );
      if (active?.catalog_json === json)
        return { value: manifest.catalog, statements: [] };
      // A new active version, exactly as a resync publishes one: the old rows are kept (versions
      // are never deleted), the next number is taken inside the INSERT.
      return {
        value: manifest.catalog,
        statements: [
          {
            sql: "UPDATE product_schema SET active = 0 WHERE product = ?",
            params: [product],
          },
          {
            // The next number comes from an inner aggregate, and the statement ends in an OUTER
            // WHERE on no aggregate: a caller's guard (`guardUnclaimed`) is appended there. Put on
            // the aggregate's own WHERE it would still answer one row (MAX over nothing is NULL,
            // so version 1) and the insert would hit the primary key and abort the whole batch.
            sql: `INSERT INTO product_schema (product, catalog_version, catalog_json, active, created_at)
                  SELECT ?, next.v, ?, 1, ?
                    FROM (SELECT COALESCE(MAX(catalog_version), 0) + 1 AS v
                            FROM product_schema WHERE product = ?) AS next
                   WHERE next.v > 0`,
            params: [product, json, now, product],
          },
        ],
      };
    }
  }
}

/**
 * Revert a console claim (S-18 §4.5 item 2): delete the claim and re-apply the manifest snapshot's
 * value in one batch, with a `setting.revert` audit row. With no snapshot (linked before ST-01a and
 * not resynced since), only the claim goes and the answer says the value applies at the next
 * resync.
 */
export async function revertClaim(
  db: Db,
  product: { slug: string; system?: number | null },
  key: string,
  actor: AuditActor,
  now: number,
): Promise<RevertResult> {
  if (!isClaimKey(key))
    return {
      ok: false,
      status: 404,
      reason: "unknown_setting",
      message: `${key} is not a claimable setting`,
    };
  const claims = await claimedKeys(db, product.slug, now);
  if (!claims.has(key))
    return {
      ok: false,
      status: 409,
      reason: "not_claimed",
      message: `${key} is not claimed: it already follows the manifest`,
    };
  const snapshot = await getManifestSnapshot(db, product.slug);
  const manifest = snapshot ? parseSnapshot(snapshot.manifest_json) : null;
  const plan = manifest
    ? await revertStatements(db, product.slug, key, manifest, now)
    : null;
  // A snapshot value the write path would refuse keeps the claim: dropping it would let the next
  // resync's own screening be the only guard, and leave the key "following" a manifest it cannot.
  if (plan && "refusal" in plan)
    return {
      ok: false,
      status: 409,
      reason: "invalid_catalog",
      message: `${plan.refusal}; the claim is kept`,
    };
  await db.batch([
    stmtDeleteClaim(product.slug, key),
    ...(plan?.statements ?? []),
    stmtSettingAudit(
      product.slug,
      now,
      actor,
      "setting.revert",
      "setting",
      key,
      plan
        ? `Reverted ${key} to the manifest: ${auditValue(plan.value)}`
        : `Reverted ${key} to the manifest: ${NEXT_RESYNC}`,
    ),
  ]);
  return plan
    ? { ok: true, applied: true, value: plan.value }
    : { ok: true, applied: false, message: NEXT_RESYNC };
}

// ── Break-glass claims at an apply (ST-20) ──────────────────────────────────────────────

/** A break-glass claim an apply ends: its 7 days ran out, or the manifest changed the field. */
export interface EndedBreakGlass {
  key: ClaimKey;
  why: "expired" | "changed";
  reason: string;
  expiresAt: number;
  /** The row's version when read, so a re-claim made since is never deleted. */
  version: number;
}

/** The claims an apply of `next` honours, and the break-glass claims it ends (`claimsForApply`). */
export interface ApplyClaims {
  /** The keys the apply skips: every ordinary claim and every break-glass claim it keeps. */
  claimed: Set<ClaimKey>;
  /** The break-glass claims still live after the apply (what every summary lists). */
  live: BreakGlassClaim[];
  /** The break-glass claims the apply ends, in the apply's own batch. */
  ended: EndedBreakGlass[];
}

/** The value `manifest` declares for `key`, as comparable JSON; `undefined` when it has none. */
function declaredValue(
  manifest: SnapshotManifest,
  key: ClaimKey,
): string | undefined {
  const p = manifest.product ?? {};
  const value =
    key === "core.name"
      ? p.name
      : key === "license.defaults.maxOfflineDays"
        ? p.defaultMaxOfflineDays
        : key === "license.defaults.deviceLimit"
          ? p.defaultDeviceLimit
          : key === "core.web.origins"
            ? // `omitClears`: an undeclared origin list means none.
              Array.isArray(manifest.webOrigins)
              ? manifest.webOrigins
              : []
            : manifest.catalog;
  return value === undefined ? undefined : JSON.stringify(value);
}

/**
 * The console claims an apply of `next` honours (S-18 §4.5 item 7). An ordinary claim always
 * holds (model C: Revert is the only way back). A break-glass claim (`expires_at` set) ends at
 * this apply when its 7 days ran out, or when `next` declares a different value for its field
 * than the last applied manifest (`product_manifest_snapshot`) did; otherwise it holds, so an
 * apply that leaves the field alone (an unrelated push or deploy) cannot undo an incident fix.
 * With no snapshot there is nothing to compare, and the claim holds until it expires.
 *
 * Read before the apply's batch; `endBreakGlassStatements` turns `ended` into that batch's first
 * statements, guarded so a claim made in between is never touched.
 */
export async function claimsForApply(
  db: Db,
  product: string,
  next: SnapshotManifest,
  now: number,
): Promise<ApplyClaims> {
  const rows = (
    await db.all<ProductSettingRow>(
      "SELECT * FROM product_settings WHERE product = ? AND source = 'console' ORDER BY key",
      product,
    )
  ).filter((r) => isClaimKey(r.key));
  const snapshot = rows.some((r) => r.expires_at !== null)
    ? await getManifestSnapshot(db, product)
    : null;
  const previous = snapshot ? parseSnapshot(snapshot.manifest_json) : null;
  const out: ApplyClaims = { claimed: new Set(), live: [], ended: [] };
  for (const r of rows) {
    const key = r.key as ClaimKey;
    if (r.expires_at === null) {
      out.claimed.add(key);
      continue;
    }
    const base = {
      key,
      reason: r.reason ?? "",
      expiresAt: r.expires_at,
      version: r.version,
    };
    if (r.expires_at <= now) {
      out.ended.push({ ...base, why: "expired" });
      continue;
    }
    const before = previous ? declaredValue(previous, key) : undefined;
    const after = declaredValue(next, key);
    if (before !== undefined && after !== undefined && before !== after) {
      out.ended.push({ ...base, why: "changed" });
      continue;
    }
    out.claimed.add(key);
    out.live.push({
      key,
      claimedBy: r.updated_by,
      claimedAt: r.updated_at,
      reason: r.reason ?? "",
      expiresAt: r.expires_at,
    });
  }
  return out;
}

/**
 * `stmt` (ending in a WHERE clause on no aggregate) that matches nothing while `key` holds a live
 * claim.
 */
function guardUnclaimed(
  stmt: DbStatement,
  product: string,
  key: ClaimKey,
  now: number,
): DbStatement {
  return {
    sql: `${stmt.sql} AND NOT ${CLAIMED_SQL}`,
    params: [...stmt.params, ...claimGuardParams(product, key, now)],
  };
}

/**
 * The statements that end `ended` in an apply's batch, placed before the apply's own guarded
 * writes: the row's delete (only at the version read, so a re-claim made since survives), then,
 * with `apply`, the column write that puts `apply`'s value in (the deploy hook, which writes no
 * claimable column of its own), then a `setting.breakGlass.end` audit row. The value write and
 * the audit row are guarded on no live claim remaining, like every resync write. A resync passes
 * no `apply`: its own guarded writes apply the field once the row is gone.
 */
export async function endBreakGlassStatements(
  db: Db,
  product: string,
  ended: readonly EndedBreakGlass[],
  opts: {
    actor: AuditActor;
    /** The applied commit, named in the audit summary. */
    sha: string | null;
    now: number;
    apply?: SnapshotManifest;
  },
): Promise<DbStatement[]> {
  const { actor, sha, now, apply } = opts;
  const at = sha ? ` at ${sha.slice(0, 12)}` : "";
  const out: DbStatement[] = [];
  for (const e of ended) {
    out.push({
      sql: `DELETE FROM product_settings
              WHERE product = ? AND key = ? AND source = 'console'
                AND expires_at IS NOT NULL AND version = ?`,
      params: [product, e.key, e.version],
    });
    const plan = apply
      ? await revertStatements(db, product, e.key, apply, now)
      : null;
    const writes = plan && "statements" in plan ? plan.statements : [];
    for (const w of writes) out.push(guardUnclaimed(w, product, e.key, now));
    const applied = !apply
      ? ""
      : plan && "statements" in plan
        ? `; the manifest's value applies: ${auditValue(plan.value)}`
        : "; the value stays as set: the manifest declares none this apply can write";
    out.push(
      unlessClaimed(
        stmtSettingAudit(
          product,
          now,
          actor,
          "setting.breakGlass.end",
          "setting",
          e.key,
          e.why === "expired"
            ? `Break-glass claim on ${e.key} expired at ${new Date(e.expiresAt * 1000).toISOString()}${applied}`
            : `Break-glass claim on ${e.key} ended: the manifest changed it${at}${applied}`,
        ),
        product,
        e.key,
        now,
      ),
    );
  }
  return out;
}
