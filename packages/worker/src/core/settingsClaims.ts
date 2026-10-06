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
 * The system product (`system = 1`) is manifest-authoritative (S-18 §4.5 item 8). Its expiring
 * break-glass claims are ST-20's; until then every console claim on it is refused
 * (`systemClaimRefusal`).
 */

import { Catalog } from "@polaris-key/catalog";
import type { Db, DbStatement } from "../db/types.js";
import { randomId } from "./platform.js";
import { serializeWebOrigins } from "./cors.js";
import { getManifestSnapshot } from "./manifestSnapshot.js";

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
}

/**
 * Whether a console write claims the field at all. Only a repo-linked product has a manifest that
 * could overwrite it: a manual product's values are the console's by construction, and the system
 * product is refused before this is asked (`systemClaimRefusal`).
 */
export function claimsApply(product: {
  release_source?: string | null;
}): boolean {
  return product.release_source === "github";
}

/**
 * The refusal for a console claim on the system product, or `null`. Manifest-authoritative (S-18
 * §4.5 item 8): its settings come from the monorepo's root `.pkey/` with each deploy, and ST-20
 * adds the only console path (time-boxed break-glass claims).
 */
export function systemClaimRefusal(product: {
  system?: number | null;
}): string | null {
  return product.system === 1
    ? "the system product is manifest-authoritative: change the monorepo's .pkey/ instead"
    : null;
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
  return rows
    .filter((r) => isClaimKey(r.key))
    .map((r) => ({
      key: r.key as ClaimKey,
      claimedBy: r.updated_by,
      claimedAt: r.updated_at,
      version: r.version,
    }));
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
 * write, not the difference. A re-claim bumps `version` and clears any expiry.
 */
export function stmtClaim(
  product: string,
  key: ClaimKey,
  by: string,
  now: number,
  reason: string | null = null,
): DbStatement {
  return {
    sql: `INSERT INTO product_settings
            (product, key, value_json, source, version, updated_at, updated_by, reason, expires_at)
          VALUES (?, ?, NULL, 'console', 1, ?, ?, ?, NULL)
          ON CONFLICT(product, key) DO UPDATE SET
            source = 'console', version = product_settings.version + 1,
            updated_at = excluded.updated_at, updated_by = excluded.updated_by,
            reason = excluded.reason, expires_at = NULL`,
    params: [product, key, now, by, reason],
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
    | "setting.update",
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
            sql: `INSERT INTO product_schema (product, catalog_version, catalog_json, active, created_at)
                  SELECT ?, COALESCE(MAX(catalog_version), 0) + 1, ?, 1, ?
                    FROM product_schema WHERE product = ?`,
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
