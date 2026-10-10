/**
 * Row-backed claimable product settings (LX-06; notes/S-18 §4.3, §4.5, §4.6, model C).
 *
 * ST-01b created `product_settings` in its final shape and used it for COLUMN-backed claims only
 * (`settingsClaims.ts`: the value stays in a typed column, the row is just the claim). A
 * ROW-backed setting keeps its value in the row itself (`value_json`), so the row's `source` says
 * who set the value in force:
 *
 *   - no row: the setting is undeclared and the registry default applies (with `legacyDefault`,
 *     the default a product registered before the cut-over keeps);
 *   - `source = 'manifest'`: the value the last link or resync applied from `.pkey/`;
 *   - `source = 'console'`: a console claim. Every later resync leaves it alone; Revert drops it
 *     and re-applies the last applied manifest's value at once (ST-01a's snapshot).
 *
 * Which settings are row-backed is DATA: a registry entry (ST-03) at product scope, with scalar
 * storage and claimable ownership. Core never names a service (rule 6): each service hands its
 * own entries to `manifestRowSettingStatements` from its descriptor's `manifestIngestAlways`
 * (License: `licensing.*`; Identity: `identity.oidc.syncTierOnSignIn`), and the admin API
 * (`console/handlers/productSettings.ts`) takes them from the assembled registry.
 *
 * The manifest side is OMIT-CLEARS (S-18 §4.5 item 1's exception): a setting the manifest stops
 * declaring loses its manifest row and returns to the default, so `.pkey/` keeps describing what
 * is in force. A console claim is never touched by either.
 *
 * ST-04: the console's write and Revert go through `writeSetting()` (`core/settings/write.ts`),
 * the one write path: this module keeps the route's own checks and answers (`preflight`, the
 * reason, the version it read, `not_claimed`) and hands the write itself, the claim and the
 * structured audit row to it. That also brings these keys under manifest-authoritative mode
 * (ST-20): on a product in that mode a console write is refused unless it is a break-glass claim.
 * ST-05's generic API replaces `readRowSettings` with the resolver.
 */

import type { Db, DbStatement } from "../db/types.js";
import { randomId } from "../platform/crypto.js";
import { getManifestSnapshot } from "./manifestSnapshot.js";
import {
  auditValue,
  claimsApply,
  isClaimKey,
  RESYNC_ACTOR,
  type AuditActor,
  type ProductSettingRow,
} from "./settingsClaims.js";
import { fitsValueSpec } from "./settings/rules.js";
import type { SettingDef } from "./settings/types.js";
import type { Principal } from "./rbac/can.js";
import {
  writeSetting,
  type SettingsWriteContext,
  type WriteRefusal,
} from "./settings/write.js";
import { tryParseJson } from "../platform/json.js";
import { jsonList, jsonListArg } from "./sqlIn.js";

/** The product facts the row store needs: who it is, when it was registered, how it is linked. */
export interface RowSettingProduct {
  slug: string;
  created_at: number;
  system?: number | null;
  release_source?: string | null;
}

/** Where the value in force came from. */
export type RowSettingSource = "default" | "manifest" | "console";

/** One row-backed setting as read for one product. */
export interface RowSettingView {
  def: SettingDef;
  value: unknown;
  source: RowSettingSource;
  /** The default this product falls back to (its `legacyDefault`, when one applies). */
  defaultValue: unknown;
  /** The row's version; 0 when there is no row (the `expectedVersion` of a first write). */
  version: number;
  updatedAt: number | null;
  updatedBy: string | null;
  reason: string | null;
}

/** The longest reason a write may carry (stored on the row and in the audit summary). */
export const MAX_SETTING_REASON = 500;

/** Is `def` a row-backed claimable product setting (the kind this module stores)? */
export function isRowBacked(def: SettingDef): boolean {
  return (
    def.scope === "product" &&
    def.storage.kind === "scalar" &&
    def.ownership === "claimable" &&
    def.manifest !== undefined
  );
}

/** The default `product` falls back to for `def` (S-18 §4.3 "absence means default"). */
export function rowSettingDefault(
  def: SettingDef,
  product: Pick<RowSettingProduct, "created_at">,
): unknown {
  if (def.legacyDefault && product.created_at < def.legacyDefault.createdBefore)
    return def.legacyDefault.value;
  return def.defaultValue;
}

/**
 * The value a parsed manifest (or a stored snapshot of one) declares for `def`, or `undefined`.
 * `def.manifest.path` is `product:<dotted path>`, and the parsed product document keeps those
 * paths (`licensing.<name>`, `oidc.syncTierOnSignIn`), so the walk is generic.
 */
export function manifestValueAt(manifest: unknown, def: SettingDef): unknown {
  const path = def.manifest?.path;
  if (!path?.startsWith("product:")) return undefined;
  let node: unknown = manifest;
  for (const seg of path.slice("product:".length).split(".")) {
    if (!node || typeof node !== "object" || Array.isArray(node))
      return undefined;
    if (!Object.prototype.hasOwnProperty.call(node, seg)) return undefined;
    node = (node as Record<string, unknown>)[seg];
  }
  return node;
}

/** The live console claim on `key`, as SQL binding `[product, key, now]` (ST-01b's guard). */
const CLAIMED = `EXISTS (SELECT 1 FROM product_settings
    WHERE product = ? AND key = ? AND source = 'console'
      AND (expires_at IS NULL OR expires_at > ?))`;

/** Every row-backed setting in `defs`, with the value in force for `product`. */
export async function readRowSettings(
  db: Db,
  product: RowSettingProduct,
  defs: readonly SettingDef[],
  now: number = Math.floor(Date.now() / 1000),
): Promise<RowSettingView[]> {
  const keys = defs.map((d) => d.key);
  const rows =
    keys.length === 0
      ? []
      : await db.all<ProductSettingRow>(
          `SELECT * FROM product_settings WHERE product = ? AND key IN ${jsonList()}`,
          product.slug,
          jsonListArg(keys),
        );
  const byKey = new Map(rows.map((r) => [r.key, r]));
  return defs.map((def) =>
    viewOf(def, product, liveRow(byKey.get(def.key) ?? null, now)),
  );
}

/** An expired break-glass claim (ST-20) is no row at all, as the resolver and the write read it. */
function liveRow(
  row: ProductSettingRow | null,
  now: number,
): ProductSettingRow | null {
  return row && row.expires_at !== null && row.expires_at <= now ? null : row;
}

function viewOf(
  def: SettingDef,
  product: RowSettingProduct,
  row: ProductSettingRow | null,
): RowSettingView {
  const defaultValue = rowSettingDefault(def, product);
  const stored = row ? tryParseJson(row.value_json) : undefined;
  // A stored value the spec no longer accepts (a bound tightened since) reads as the default
  // rather than reaching a reader; the row still shows who wrote it.
  const usable = row !== null && fitsValueSpec(def.value, stored);
  return {
    def,
    value: usable ? stored : defaultValue,
    source: usable ? row.source : "default",
    defaultValue,
    version: row?.version ?? 0,
    updatedAt: row?.updated_at ?? null,
    updatedBy: row?.updated_by ?? null,
    reason: row?.reason ?? null,
  };
}

async function readOne(
  db: Db,
  product: RowSettingProduct,
  def: SettingDef,
  now: number,
): Promise<{ row: ProductSettingRow | null; view: RowSettingView }> {
  const row = liveRow(
    await db.first<ProductSettingRow>(
      "SELECT * FROM product_settings WHERE product = ? AND key = ?",
      product.slug,
      def.key,
    ),
    now,
  );
  return { row, view: viewOf(def, product, row) };
}

// ── The manifest side: link and resync ─────────────────────────────────────────

/**
 * The statements that apply `parsed`'s row-backed settings to `product`, for a link or resync
 * batch (a descriptor's `manifestIngestAlways`). Statements only, so every guard is in SQL:
 *
 *   - a declared value upserts a `source = 'manifest'` row, unless a live console claim exists
 *     (the guard is in the statement: a claim made after the resync started still wins);
 *   - an undeclared setting loses its manifest row (omit-clears), never a console row;
 *   - each change writes a `setting.resync` audit row, guarded the same way, so an unchanged or
 *     claimed setting writes none.
 *
 * A declared value outside its registry spec (the validator refuses it, so only a drifted bound
 * could produce one) is left alone rather than written or cleared.
 */
export function manifestRowSettingStatements(
  product: string,
  defs: readonly SettingDef[],
  parsed: unknown,
  now: number,
  actor: AuditActor = RESYNC_ACTOR,
): DbStatement[] {
  const out: DbStatement[] = [];
  const undeclared: string[] = [];
  for (const def of defs) {
    if (!isRowBacked(def)) continue;
    const value = manifestValueAt(parsed, def);
    if (value === undefined) {
      undeclared.push(def.key);
      continue;
    }
    if (!fitsValueSpec(def.value, value)) continue;
    const json = JSON.stringify(value);
    out.push(
      {
        sql: `INSERT INTO audit
                (product, id, at, actor_sub, actor_name, actor_email, action, target_kind,
                 target_id, parent_id, summary)
              SELECT ?, ?, ?, ?, ?, ?, 'setting.resync', 'setting', ?, NULL,
                     ? || COALESCE((SELECT value_json FROM product_settings
                                     WHERE product = ? AND key = ?), 'unset') || ' → ' || ?
              WHERE NOT ${CLAIMED}
                AND (SELECT value_json FROM product_settings WHERE product = ? AND key = ?)
                    IS NOT ?`,
        params: [
          product,
          randomId("aud"),
          now,
          actor.sub,
          actor.name,
          actor.email,
          def.key,
          `${def.key} set from the manifest: `,
          product,
          def.key,
          json,
          product,
          def.key,
          now,
          product,
          def.key,
          json,
        ],
      },
      {
        sql: `INSERT INTO product_settings
                (product, key, value_json, source, version, updated_at, updated_by, reason, expires_at)
              SELECT ?, ?, ?, 'manifest', 1, ?, 'resync', NULL, NULL
              WHERE NOT ${CLAIMED}
              ON CONFLICT(product, key) DO UPDATE SET
                value_json = excluded.value_json, source = 'manifest',
                version = product_settings.version + 1, updated_at = excluded.updated_at,
                updated_by = excluded.updated_by, reason = NULL, expires_at = NULL
              WHERE product_settings.value_json IS NOT excluded.value_json
                 OR product_settings.source <> 'manifest'`,
        params: [product, def.key, json, now, product, def.key, now],
      },
    );
  }
  if (undeclared.length > 0) {
    const inList = jsonList();
    out.push(
      {
        sql: `INSERT INTO audit
                (product, id, at, actor_sub, actor_name, actor_email, action, target_kind,
                 target_id, parent_id, summary)
              SELECT product, 'aud_' || lower(hex(randomblob(9))), ?, ?, ?, ?,
                     'setting.resync', 'setting', key, NULL,
                     key || ' cleared from the manifest: ' || value_json || ' → default'
                FROM product_settings
               WHERE product = ? AND source = 'manifest' AND key IN ${inList}`,
        params: [
          now,
          actor.sub,
          actor.name,
          actor.email,
          product,
          jsonListArg(undeclared),
        ],
      },
      {
        sql: `DELETE FROM product_settings
               WHERE product = ? AND source = 'manifest' AND key IN ${inList}`,
        params: [product, jsonListArg(undeclared)],
      },
    );
  }
  return out;
}

/**
 * The row-backed keys `product` has live console claims on (what a resync leaves alone). The
 * column-backed claims are `settingsClaims.ts`' `claimedKeys`; this answers the rest, so the
 * resync result and its dry run can name them without knowing which service owns them.
 */
export async function liveRowClaimKeys(
  db: Db,
  product: string,
  now: number,
): Promise<string[]> {
  const rows = await db.all<{ key: string }>(
    `SELECT key FROM product_settings
       WHERE product = ? AND source = 'console' AND value_json IS NOT NULL
         AND (expires_at IS NULL OR expires_at > ?)
       ORDER BY key`,
    product,
    now,
  );
  return rows.map((r) => r.key).filter((k) => !isClaimKey(k));
}

// ── The console side: write (claim) and revert ─────────────────────────────────

export type RowSettingRefusal = {
  ok: false;
  status: 403 | 404 | 409 | 422;
  /** `writeSetting()`'s reasons, plus the two that are this route's own state checks. */
  reason: WriteRefusal["reason"] | "not_claimed" | "invalid_manifest_value";
  message: string;
  /** On a version conflict: the value in force now, so the console can offer "reload". */
  current?: RowSettingView;
};

export type RowSettingWriteResult =
  | { ok: true; view: RowSettingView; claimed: boolean }
  | RowSettingRefusal;

export type RowSettingRevertResult =
  | { ok: true; view: RowSettingView; applied: true }
  | { ok: true; view: RowSettingView; applied: false; message: string }
  | RowSettingRefusal;

export interface RowSettingWriteInput {
  value: unknown;
  /** Required: the row version the caller read (0 when there was no row). */
  expectedVersion: unknown;
  reason?: unknown;
  /** ST-20: the request's break-glass claim, `{ reason }` (a manifest-authoritative product). */
  breakGlass?: unknown;
}

const NEXT_RESYNC = "applies at the next resync";

/** A `writeSetting()` refusal as this route answers it (a version conflict with the value now). */
async function fromWriteRefusal(
  ctx: SettingsWriteContext,
  product: RowSettingProduct,
  def: SettingDef,
  r: WriteRefusal,
  now: number,
  verb: string,
): Promise<RowSettingRefusal> {
  if (r.reason === "version_conflict")
    return {
      ok: false,
      status: 409,
      reason: "version_conflict",
      message: `${def.key} changed while it was being ${verb}`,
      current: (await readOne(ctx.db, product, def, now)).view,
    };
  return {
    ok: false,
    status: r.status === 400 ? 422 : r.status,
    reason: r.reason,
    message: r.message,
  };
}

/**
 * A console write (S-18 §4.5 item 2): validate against the registry entry, check
 * `expectedVersion`, and store the value as a `source = 'console'` row with a `setting.claim`
 * audit row (`setting.update` on a product no manifest feeds), in one batch, through
 * `writeSetting()`. "Set to the same value keeps one" (S-18 §4.3): the claim is the write, not the
 * difference. On a manifest-authoritative product (ST-20) it is refused unless `breakGlass`
 * carries a reason, and then the claim expires in 7 days at the latest.
 */
export async function writeRowSetting(
  ctx: SettingsWriteContext,
  product: RowSettingProduct,
  def: SettingDef,
  input: RowSettingWriteInput,
  actor: AuditActor,
  now: number,
  principal?: Principal,
): Promise<RowSettingWriteResult> {
  const { view } = await readOne(ctx.db, product, def, now);

  const claimed = claimsApply(product);
  const res = await writeSetting(
    ctx,
    {
      key: def.key,
      value: input.value,
      // Checked in the write's own batch: the loser of a race writes nothing.
      expectedVersion: input.expectedVersion as number | undefined,
      // `writeSetting()` refuses a reason that is not text.
      reason: (typeof input.reason === "string"
        ? input.reason.trim()
        : input.reason) as string | null | undefined,
      audit: {
        action: claimed ? "setting.claim" : "setting.update",
        summary: ({ breakGlass }) =>
          `${def.key} set in the console${claimed ? " (claimed from the manifest)" : ""}: ${auditValue(view.value)} → ${auditValue(input.value)}${typeof input.reason === "string" && input.reason.trim() ? ` (reason: ${input.reason.trim()})` : ""}${breakGlass ? ` (break-glass claim until ${new Date(breakGlass.expiresAt * 1000).toISOString()}: ${breakGlass.reason})` : ""}`,
      },
    },
    {
      actor,
      origin: "console",
      principal,
      now,
      product,
      // No typed confirmation on this route; the version and a critical key's reason are
      // `writeSetting()`'s own checks.
      strict: false,
      requireVersion: true,
      requireReason: true,
      breakGlass: input.breakGlass,
    },
  );
  if (!res.ok) return fromWriteRefusal(ctx, product, def, res, now, "saved");
  return {
    ok: true,
    view: (await readOne(ctx.db, product, def, now)).view,
    claimed,
  };
}

/**
 * Revert a console claim (S-18 §4.5 item 2) through `writeSetting()`: drop it and, on a
 * repo-linked product, put the last applied manifest's value back at once (a `source = 'manifest'`
 * row, or no row when the manifest does not declare it), with a `setting.revert` audit row, in one
 * batch. With no snapshot yet (linked before ST-01a and not resynced since) the claim goes and the
 * value "applies at the next resync". On a product no manifest feeds, Revert is "reset to
 * default". Reverting is open on a manifest-authoritative product: it returns the key to `.pkey/`.
 */
export async function revertRowSetting(
  ctx: SettingsWriteContext,
  product: RowSettingProduct,
  def: SettingDef,
  input: { expectedVersion: unknown },
  actor: AuditActor,
  now: number,
  principal?: Principal,
): Promise<RowSettingRevertResult> {
  const { row, view } = await readOne(ctx.db, product, def, now);
  if (!row || row.source !== "console")
    return {
      ok: false,
      status: 409,
      reason: "not_claimed",
      message: claimsApply(product)
        ? `${def.key} is not claimed: it already follows the manifest`
        : `${def.key} is not set in the console: it already has its default`,
    };

  let restore: { value: unknown } | null = null;
  let applied = true;
  if (claimsApply(product)) {
    const snapshot = await getManifestSnapshot(ctx.db, product.slug);
    if (!snapshot) applied = false;
    else {
      const declared = manifestValueAt(
        tryParseJson(snapshot.manifest_json),
        def,
      );
      if (declared !== undefined) {
        // A snapshot value the write path would refuse keeps the claim, as ST-01b's catalog
        // Revert does: dropping it would leave the key "following" a manifest it cannot.
        if (!fitsValueSpec(def.value, declared))
          return {
            ok: false,
            status: 409,
            reason: "invalid_manifest_value",
            message: `the manifest's ${def.key} is not a valid value; the claim is kept`,
          };
        restore = { value: declared };
      }
    }
  }

  const after = restore
    ? auditValue(restore.value)
    : applied
      ? `${auditValue(rowSettingDefault(def, product))} (default)`
      : NEXT_RESYNC;
  const res = await writeSetting(
    ctx,
    {
      key: def.key,
      op: "reset",
      expectedVersion: input.expectedVersion as number | undefined,
      // The manifest's value goes back as a `source = 'manifest'` row (none: the row goes).
      ...(restore ? { restore: restore.value } : {}),
      audit: {
        action: "setting.revert",
        summary: claimsApply(product)
          ? `Reverted ${def.key} to the manifest: ${auditValue(view.value)} → ${after}`
          : `Reset ${def.key} to its default: ${auditValue(view.value)} → ${after}`,
      },
    },
    {
      actor,
      origin: "revert",
      principal,
      now,
      product,
      strict: false,
      requireVersion: true,
      // The restored manifest row's author, as the resync spells its own.
      ...(restore ? { author: "revert" } : {}),
    },
  );
  if (!res.ok) return fromWriteRefusal(ctx, product, def, res, now, "reverted");
  const fresh = (await readOne(ctx.db, product, def, now)).view;
  return applied
    ? { ok: true, view: fresh, applied: true }
    : { ok: true, view: fresh, applied: false, message: NEXT_RESYNC };
}
