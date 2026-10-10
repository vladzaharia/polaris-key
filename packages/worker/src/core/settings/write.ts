/**
 * `writeSetting()`: the one write path for registry-backed settings (ST-04, notes/S-18 §4.6).
 *
 * Every console or API write of a platform or product setting comes through here. One call:
 *
 *   1. finds the entry in the registry and refuses what it may not write: an unknown or pending
 *      key, a manifest-only or read-only field on a product that follows its `.pkey/`, a claim on
 *      the manifest-authoritative system product (until ST-20's break-glass), a value outside the
 *      entry's value spec, a product value outside the platform bound (`setting_out_of_bounds`);
 *   2. in STRICT mode (the generic API, ST-05) also requires `expectedVersion`, a reason on a
 *      `critical` key and the typed confirmation an L2/L3 change needs. A bespoke console route
 *      that does its own confirmation and has no version in its contract passes `strict: false`
 *      (the compatibility aliases ST-05 retires); everything else below still applies;
 *   3. writes, in ONE `db.batch`: the value (a `product_settings` row for a row-backed key, the
 *      typed column through the key's column adapter for a column-backed one, the caller's own
 *      statements for a rich one), the claim (`source = 'console'`, version + 1, author, reason)
 *      and one audit row per key with `before_json`, `after_json`, `origin`, `reason` and
 *      `setting_key`;
 *   4. drops the platform cache on a platform write, so the writer reads its own change.
 *
 * All-or-nothing without a transaction primitive: the audit rows go first, each inserted only
 * while every `expectedVersion` still holds (`INSERT … SELECT … WHERE <versions>`); every other
 * statement in the batch ANDs "the first audit row exists" into its own `WHERE`. A stale version
 * therefore writes nothing at all, and the first statement's change count says which happened.
 *
 * Claims (model C, owner decision 1): a console write to a `claimable` key on a product that
 * follows its manifest claims it, and every later resync skips it until Revert. On a product
 * with no manifest the value is simply the console's: no claim row is written for a claimable
 * or manifest key there (ST-01b's rule, so a later link still applies the manifest), and its
 * version stays 0. An operator key always gets a row, which carries its version and author.
 * Keys with a legacy ownership marker (`services_source`, …) are claimed by their adapter too.
 */

import type { Db, DbStatement } from "../../db/types.js";
import { randomId } from "../../platform/crypto.js";
import {
  invalidatePlatformSettings,
  type SettingsEnv,
} from "../platformSettings.js";
import type { SettingsRegistry } from "./registry.js";
import {
  followsManifest,
  isSettingValue,
  outOfBounds,
  platformLinks,
  resolvePlatformSetting,
  resolveProductSettings,
  resolveProductValue,
  sameValue,
  type ProductFacts,
  type ResolvedSetting,
} from "./resolve.js";
import { NO_GUARD } from "./columns.js";
import {
  BREAK_GLASS_MAX_SECONDS,
  BREAK_GLASS_REASON_MAX,
  manifestAuthorityOf,
  manifestAuthoritativeRefusal,
} from "./authority.js";
import {
  SETTING_ORIGINS,
  type ConfirmLevel,
  type SettingDef,
  type SettingOrigin,
  type SqlGuard,
} from "./types.js";

/** Who a settings audit row names: the verified admin session, or a system actor. */
export interface AuditActor {
  sub: string | null;
  name: string | null;
  email: string | null;
}

/** One key to write. */
export interface SettingWrite {
  /** A registry key or alias. */
  key: string;
  /** `set` (the default) stores `value`; `reset` drops the stored value (inherit / manifest). */
  op?: "set" | "reset";
  value?: unknown;
  /** The version the caller read (`ResolvedSetting.version`; 0 when nothing was stored). */
  expectedVersion?: number;
  reason?: string | null;
  /**
   * `reset` of a column-backed claimable key: the manifest value to put back at once (Revert
   * with ST-01a's snapshot). Absent: a key with a legacy marker flips it and the next resync
   * re-applies the manifest; any other key keeps its value until then.
   */
  restore?: unknown;
  /**
   * A RICH key (tiers, the catalog, …): the statements that store the value, each ANDing `guard`
   * into its `WHERE`. writeSetting adds the claim and the audit row around them.
   */
  statements?: (guard: SqlGuard) => DbStatement[];
  /**
   * The audit row's action, summary and target; defaults name the setting. A summary may be a
   * function of the write's outcome (a break-glass claim's reason and expiry, ST-20).
   */
  audit?: {
    action?: string;
    summary?:
      | string
      | ((outcome: {
          breakGlass?: { reason: string; expiresAt: number };
        }) => string);
    target?: { kind: string; id: string } | null;
  };
}

/** A write's audit summary, resolved against its outcome. */
function summaryOf(
  w: SettingWrite,
  outcome: { breakGlass?: { reason: string; expiresAt: number } },
): string | undefined {
  const s = w.audit?.summary;
  return typeof s === "function" ? s(outcome) : s;
}

export interface WriteOptions {
  actor: AuditActor;
  origin: SettingOrigin;
  /** Epoch seconds: one value for every timestamp the write records. */
  now: number;
  /** The product (a slug, or the `products` row the caller holds) for a product-scope write. */
  product?: string | ProductFacts;
  /** Default `true`: version, reason and typed confirmation are required (see the header). */
  strict?: boolean;
  /** The typed confirmation an L2/L3 change needs in strict mode: the key itself. */
  confirm?: string;
  /** Caller statements committed in the same batch, each ANDing `guard` into its `WHERE`. */
  extra?: (guard: SqlGuard) => DbStatement[];
  /**
   * The author the stored rows record (`updated_by`); default the actor's subject. A route whose
   * table always spelled its author another way keeps that spelling (feed retention's
   * `admin:<sub>`). The audit row always names the actor.
   */
  author?: string;
  /**
   * ST-20 (S-18 §4.5 item 7): the request's break-glass claim, `{ reason, seconds? }` as the
   * request carried it. Needed only on a manifest-authoritative product (the system product
   * always), where a console write to a governed setting is refused without it; ignored on any
   * other product. The reason is 1–500 characters; the claim expires after `seconds` (default and
   * most: 7 days), or sooner at the first apply that changes the field (`claimsForApply`).
   */
  breakGlass?: unknown;
}

/** The `updated_by` a write records. */
function authorOf(opts: WriteOptions): string {
  return opts.author ?? opts.actor.sub ?? "system";
}

export interface SettingsWriteContext {
  env: SettingsEnv;
  db: Db;
  registry: SettingsRegistry;
}

export interface WrittenSetting {
  key: string;
  op: "set" | "reset";
  /** The version the stored row now has (0: no row is kept for this key). */
  version: number;
  /** A console claim on a manifest-declared field (the console says "claimed"). */
  claimed: boolean;
  /** ST-20: the claim is a break-glass one, with its reason and its latest expiry. */
  breakGlass?: { reason: string; expiresAt: number };
  before: ResolvedSetting;
  /** The value and source the write leaves (predicted before the batch, for the audit row). */
  after: { value: unknown; source: ResolvedSetting["source"] };
}

export type WriteRefusalReason =
  | "unknown_setting"
  | "pending_setting"
  | "product_not_found"
  | "read_only"
  | "manifest_only"
  | "manifest_authoritative"
  | "locked"
  | "invalid_break_glass"
  | "no_writer"
  | "invalid_value"
  | "setting_out_of_bounds"
  | "expected_version_required"
  | "reason_required"
  | "confirm_required"
  | "nothing_stored"
  | "version_conflict"
  | "invalid_origin";

export interface WriteRefusal {
  ok: false;
  status: 400 | 404 | 409 | 422;
  reason: WriteRefusalReason;
  /** The key the refusal is about. */
  key?: string;
  message: string;
  details?: Record<string, unknown>;
}

export type WriteOutcome =
  | { ok: true; written: WrittenSetting[] }
  | WriteRefusal;

function refuse(
  status: WriteRefusal["status"],
  reason: WriteRefusalReason,
  message: string,
  key?: string,
  details?: Record<string, unknown>,
): WriteRefusal {
  return {
    ok: false,
    status,
    reason,
    message,
    ...(key ? { key } : {}),
    ...(details ? { details } : {}),
  };
}

// ── Confirm levels ───────────────────────────────────────────────────────────────────────────

const ORDER: readonly ConfirmLevel[] = ["L0", "L1", "L2", "L3"];

/** The confirm level a change from `before` to `after` needs (ADMIN.md §5.2). */
export function confirmLevelFor(
  def: SettingDef,
  before: unknown,
  after: unknown,
): ConfirmLevel {
  if (sameValue(before, after)) return "L0";
  const c = def.confirm;
  if ("change" in c) return c.change;
  if ("on" in c) return after === "on" || after === true ? c.on : c.off;
  // Ordered: an integer (null = unlimited, the top) or an ordered enum (its listed order).
  const rank = (v: unknown): number => {
    if (v === null) return Number.POSITIVE_INFINITY;
    if (typeof v === "number") return v;
    if (def.value.kind === "enum" && typeof v === "string")
      return def.value.values.indexOf(v);
    return Number.NaN;
  };
  const a = rank(before);
  const b = rank(after);
  if (Number.isNaN(a) || Number.isNaN(b))
    return ORDER.indexOf(c.up) >= ORDER.indexOf(c.down) ? c.up : c.down;
  return b > a ? c.up : c.down;
}

// ── Audit ────────────────────────────────────────────────────────────────────────────────────

/** A bounded rendering of a value for an audit summary. */
export function auditValue(value: unknown): string {
  const text = value === undefined ? "unset" : JSON.stringify(value);
  return text.length > 200 ? `${text.slice(0, 197)}...` : text;
}

/** One side of a change as the audit row stores it (a secret records presence only). */
function snapshot(
  def: SettingDef,
  side: { value: unknown; source: string; version?: number; stored?: unknown },
): string {
  const secret = def.sensitivity === "secret";
  const show = (v: unknown) =>
    secret ? { set: v !== undefined && v !== null } : (v ?? null);
  return JSON.stringify({
    stored: show(side.stored),
    version: side.version ?? 0,
    effective: show(side.value),
    source: side.source,
  });
}

function defaultSummary(
  def: SettingDef,
  op: "set" | "reset",
  origin: SettingOrigin,
  before: unknown,
  after: unknown,
): string {
  const secret = def.sensitivity === "secret";
  if (op === "set")
    return secret
      ? `Set ${def.key} (secret)`
      : `Set ${def.key} to ${auditValue(after)} (was ${auditValue(before)})`;
  if (origin === "revert") return `Reverted ${def.key} to the manifest`;
  return secret
    ? `Reset ${def.key} (secret)`
    : `Reset ${def.key} to ${auditValue(after)} (was ${auditValue(before)})`;
}

/** The product-scope audit INSERT, as `INSERT … SELECT … WHERE <when>`. */
function productAuditStmt(
  product: string,
  id: string,
  opts: WriteOptions,
  def: SettingDef,
  w: SettingWrite,
  op: "set" | "reset",
  before: ResolvedSetting,
  after: WrittenSetting["after"],
  storedBefore: unknown,
  storedAfter: unknown,
  versionAfter: number,
  when: SqlGuard,
  breakGlass: { reason: string; expiresAt: number } | null,
): DbStatement {
  const target =
    w.audit?.target === undefined
      ? { kind: "setting", id: def.key }
      : w.audit.target;
  return {
    sql: `INSERT INTO audit
            (product, id, at, actor_sub, actor_name, actor_email, action, target_kind, target_id,
             parent_id, summary, before_json, after_json, origin, reason, setting_key)
          SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ? WHERE (${when.sql})`,
    params: [
      product,
      id,
      opts.now,
      opts.actor.sub,
      opts.actor.name,
      opts.actor.email,
      w.audit?.action ??
        (op === "set"
          ? "setting.update"
          : opts.origin === "revert"
            ? "setting.revert"
            : "setting.reset"),
      target?.kind ?? null,
      target?.id ?? null,
      summaryOf(w, breakGlass ? { breakGlass } : {}) ??
        defaultSummary(def, op, opts.origin, before.value, after.value),
      snapshot(def, {
        value: before.value,
        source: before.source,
        version: before.version,
        stored: storedBefore,
      }),
      snapshot(def, {
        value: after.value,
        source: after.source,
        version: versionAfter,
        stored: storedAfter,
      }),
      opts.origin,
      w.reason ?? null,
      def.key,
      ...when.params,
    ],
  };
}

// ── The write ────────────────────────────────────────────────────────────────────────────────

/** Write one setting. See `writeSettings`. */
export function writeSetting(
  ctx: SettingsWriteContext,
  write: SettingWrite,
  opts: WriteOptions,
): Promise<WriteOutcome> {
  return writeSettings(ctx, [write], opts);
}

/**
 * Write several settings of ONE scope atomically: every check runs before anything is written,
 * and the batch applies all of them or none (one audit row per key).
 */
export async function writeSettings(
  ctx: SettingsWriteContext,
  writes: readonly SettingWrite[],
  opts: WriteOptions,
): Promise<WriteOutcome> {
  if (!(SETTING_ORIGINS as readonly string[]).includes(opts.origin))
    return refuse(400, "invalid_origin", `unknown origin ${opts.origin}`);
  if (writes.length === 0) return { ok: true, written: [] };
  return opts.product === undefined
    ? writePlatform(ctx, writes, opts)
    : writeProduct(ctx, writes, opts);
}

/** The checks every write shares (value, strict-mode version, reason and confirmation). */
function commonChecks(
  def: SettingDef,
  w: SettingWrite,
  op: "set" | "reset",
  before: unknown,
  after: unknown,
  opts: WriteOptions,
): WriteRefusal | null {
  if (op === "set" && !isSettingValue(def, w.value))
    return refuse(
      422,
      "invalid_value",
      `${def.key} is not a valid value (${describeSpec(def)})`,
      def.key,
      { value: def.value },
    );
  if (opts.strict === false) return null;
  if (
    w.expectedVersion === undefined ||
    !Number.isSafeInteger(w.expectedVersion) ||
    w.expectedVersion < 0
  )
    return refuse(
      400,
      "expected_version_required",
      "expectedVersion is required",
      def.key,
    );
  if (
    (def.critical || def.securityWidening) &&
    !(typeof w.reason === "string" && w.reason.trim() !== "")
  )
    return refuse(
      400,
      "reason_required",
      `${def.key} is critical: a reason is required`,
      def.key,
    );
  const level = confirmLevelFor(def, before, after);
  if ((level === "L2" || level === "L3") && opts.confirm !== def.key)
    return refuse(
      400,
      "confirm_required",
      `type ${def.key} to confirm`,
      def.key,
      {
        level,
      },
    );
  return null;
}

function describeSpec(def: SettingDef): string {
  const v = def.value;
  switch (v.kind) {
    case "switch":
      return `"on" or "off"`;
    case "boolean":
      return "true or false";
    case "integer":
      return `an integer from ${v.min} to ${v.max}`;
    case "enum":
      return `one of ${v.values.map((x) => `"${x}"`).join(", ")}`;
    case "string":
      return `text of at most ${v.maxLength} characters`;
    case "list":
      return `a list of at most ${v.max}`;
    case "json":
      return v.schema;
  }
}

/**
 * The version guard. A product row whose break-glass claim has expired (`expires_at`, ST-20) is
 * no claim at all, exactly as the resolver reads it: its version is 0. Binds
 * `[product, key, now, expected]` for a product key, `[key, expected]` for a platform one.
 */
const VERSION_OF = (table: "product_settings" | "platform_settings") =>
  table === "product_settings"
    ? `COALESCE((SELECT version FROM product_settings WHERE product = ? AND key = ?
         AND ${LIVE_ROW}), 0) = ?`
    : "COALESCE((SELECT version FROM platform_settings WHERE key = ?), 0) = ?";

/** A `product_settings` row that is still a claim at `?` (no expiry, or not yet expired). */
const LIVE_ROW = "(expires_at IS NULL OR expires_at > ?)";

/** Run the batch; answer whether the first statement (the anchor audit row) applied. */
async function applyBatch(
  db: Db,
  stmts: DbStatement[],
  anchor: { table: "audit" | "platform_audit"; id: string; product?: string },
): Promise<boolean> {
  if (db.batchChanges) return (await db.batchChanges(stmts))[0] === 1;
  await db.batch(stmts);
  const row =
    anchor.table === "audit"
      ? await db.first(
          "SELECT 1 AS ok FROM audit WHERE product = ? AND id = ?",
          anchor.product!,
          anchor.id,
        )
      : await db.first(
          "SELECT 1 AS ok FROM platform_audit WHERE id = ?",
          anchor.id,
        );
  return row !== null;
}

// ── Product scope ────────────────────────────────────────────────────────────────────────────

interface ProductPlan {
  def: SettingDef;
  w: SettingWrite;
  op: "set" | "reset";
  before: ResolvedSetting;
  after: WrittenSetting["after"];
  /**
   * Keep (upsert) the console's `product_settings` row, drop it, put the manifest's value back as
   * a `source = 'manifest'` row (a row-backed Revert), or leave it alone.
   */
  row: "upsert" | "delete" | "manifest" | "none";
  claimed: boolean;
  /**
   * Governed by manifest-authoritative mode (ST-20): a claimable key claimed through a
   * `product_settings` row (a legacy `*_source` marker is the deploy hook's to honour instead).
   */
  governed: boolean;
  storedBefore: unknown;
}

/** A break-glass request, checked: its reason and when its claim expires at the latest. */
function parseBreakGlass(
  raw: unknown,
  now: number,
): { reason: string; expiresAt: number } | WriteRefusal {
  const r =
    raw && typeof raw === "object"
      ? (raw as { reason?: unknown; seconds?: unknown })
      : {};
  const reason = typeof r.reason === "string" ? r.reason.trim() : "";
  if (reason.length === 0 || reason.length > BREAK_GLASS_REASON_MAX)
    return refuse(
      422,
      "reason_required",
      `a break-glass claim needs a reason of 1 to ${BREAK_GLASS_REASON_MAX} characters`,
      undefined,
      { fields: ["breakGlass.reason"] },
    );
  const seconds = r.seconds ?? BREAK_GLASS_MAX_SECONDS;
  if (
    typeof seconds !== "number" ||
    !Number.isSafeInteger(seconds) ||
    seconds < 1 ||
    seconds > BREAK_GLASS_MAX_SECONDS
  )
    return refuse(
      422,
      "invalid_break_glass",
      `a break-glass claim lasts 1 second to ${BREAK_GLASS_MAX_SECONDS / 86400} days`,
      undefined,
      { fields: ["breakGlass.seconds"] },
    );
  return { reason, expiresAt: now + seconds };
}

async function writeProduct(
  ctx: SettingsWriteContext,
  writes: readonly SettingWrite[],
  opts: WriteOptions,
): Promise<WriteOutcome> {
  const product =
    typeof opts.product === "string"
      ? await ctx.db.first<ProductFacts>(
          "SELECT * FROM products WHERE slug = ? AND COALESCE(status, 'active') != 'deleted'",
          opts.product,
        )
      : opts.product!;
  if (!product) return refuse(404, "product_not_found", "no such product");
  const slug = product.slug;
  const linked = followsManifest(product);
  const system = product.system === 1;

  const defs: SettingDef[] = [];
  for (const w of writes) {
    const def = ctx.registry.get(w.key, "product");
    if (!def)
      return refuse(
        404,
        "unknown_setting",
        `${w.key} is not a product setting`,
        w.key,
      );
    if (def.pending)
      return refuse(
        409,
        "pending_setting",
        `${def.key} is registered ahead of ${def.pending.wp} and cannot be written yet`,
        def.key,
      );
    defs.push(def);
  }

  // The current state of every key: resolved for the scalar and column ones, the claim row alone
  // for a rich one (its descriptor adapter owns the value).
  const resolved = new Map(
    (
      await resolveProductSettings(ctx, product, {
        keys: defs
          .filter((d) => d.storage.kind !== "rich" && d.storage.kind !== "none")
          .map((d) => d.key),
        now: opts.now,
      })
    ).map((r) => [r.key, r]),
  );
  const claimRows = new Map(
    (
      await ctx.db.all<{ key: string; version: number; source: string }>(
        `SELECT key, version, source FROM product_settings WHERE product = ? AND ${LIVE_ROW}`,
        slug,
        opts.now,
      )
    ).map((r) => [r.key, r]),
  );

  const plans: ProductPlan[] = [];
  for (let i = 0; i < writes.length; i++) {
    const w = writes[i]!;
    const def = defs[i]!;
    const op = w.op ?? "set";
    const before: ResolvedSetting = resolved.get(def.key) ?? {
      key: def.key,
      scope: def.scope,
      value: undefined,
      source:
        claimRows.get(def.key)?.source === "console" ? "console" : "manifest",
      chain: [],
      version: claimRows.get(def.key)?.version ?? 0,
    };
    const storedBefore = before.chain.find(
      (s) => s.source === "manifest" || s.source === "console",
    )?.value;

    // Ownership (S-18 §4.2, §4.5).
    if (def.ownership === "read-only" || def.storage.kind === "none")
      return refuse(409, "read_only", `${def.key} is not writable`, def.key);
    if (
      (def.ownership === "manifest" || def.ownership === "narrow-only") &&
      linked
    )
      return refuse(
        409,
        "manifest_only",
        `${def.key} is set by the product's .pkey/ (${def.manifest?.path ?? "manifest"})`,
        def.key,
      );
    const adapter =
      def.storage.kind === "column"
        ? ctx.registry.columnAdapter(def.key)
        : undefined;
    // The system-lock rule (ST-20): a key the registry fixes for the system product is never
    // written there.
    if (def.systemLock && system)
      return refuse(
        409,
        "locked",
        `${def.key} is fixed for the system product: the deploy hook is its only writer`,
        def.key,
      );
    if (def.storage.kind === "column" && !adapter)
      return refuse(
        409,
        "no_writer",
        `${def.key} has no column adapter`,
        def.key,
      );
    if (op === "set" && def.storage.kind === "column" && !adapter!.set)
      return refuse(
        409,
        "no_writer",
        `${def.key} has no console writer`,
        def.key,
      );
    if (op === "set" && def.storage.kind === "rich" && !w.statements)
      return refuse(
        409,
        "no_writer",
        `${def.key} is written through its own adapter`,
        def.key,
      );

    // What the write leaves.
    let after: WrittenSetting["after"];
    const manifestSide = linked ? "manifest" : "default";
    if (op === "set") after = { value: w.value, source: "console" };
    else if (def.storage.kind === "column") {
      if (w.restore !== undefined && !adapter!.marker)
        after = { value: w.restore, source: "manifest" };
      else if (adapter!.marker && def.ownership !== "operator")
        after = { value: before.value, source: "manifest" };
      else if (adapter!.reset)
        after = { value: def.defaultValue, source: "default" };
      else after = { value: before.value, source: before.source };
    } else if (def.storage.kind === "scalar") {
      if (w.restore !== undefined)
        after = { value: w.restore, source: "manifest" };
      else {
        const r = resolveProductValue(def, {
          ...(await platformLinks(ctx, def)),
          ...(product.created_at !== undefined
            ? { productCreatedAt: product.created_at }
            : {}),
        });
        after = { value: r.value, source: r.source };
      }
    } else after = { value: undefined, source: manifestSide };

    const refused = commonChecks(def, w, op, before.value, after.value, opts);
    if (refused) return refused;
    if (op === "set") {
      const out = outOfBounds(def, w.value, await platformLinks(ctx, def));
      if (out)
        return refuse(
          422,
          "setting_out_of_bounds",
          `${def.key} must stay within the platform bound (${auditValue(out.bound)})`,
          def.key,
          { bound: out.bound, boundedBy: "platform" },
        );
    }

    // The claim row: always for an operator key; for a manifest-capable key only where a
    // manifest exists to claim from (ST-01b), so a manual product's later link still applies it.
    const keepsRow =
      def.storage.kind === "scalar" ||
      def.ownership === "operator" ||
      (linked && def.ownership === "claimable");
    plans.push({
      def,
      w,
      op,
      before,
      after,
      row:
        op === "reset"
          ? def.storage.kind === "scalar" && w.restore !== undefined
            ? "manifest"
            : "delete"
          : keepsRow
            ? "upsert"
            : "none",
      claimed: op === "set" && linked && def.ownership === "claimable",
      governed:
        def.ownership === "claimable" &&
        !(def.storage.kind === "column" && adapter?.marker),
      storedBefore,
    });
  }

  // Manifest-authoritative mode (ST-20, S-18 §4.5 items 7–8): a console write to a governed key
  // is refused unless it is a break-glass claim; Revert stays open (it returns the key to the
  // manifest). Off for most products, so the mode is read only when a governed key is set.
  let breakGlass: { reason: string; expiresAt: number } | null = null;
  if (plans.some((p) => p.op === "set" && p.governed)) {
    const authority = await manifestAuthorityOf(ctx.db, product);
    if (authority.authoritative) {
      if (opts.breakGlass === undefined || opts.breakGlass === null)
        return refuse(
          409,
          "manifest_authoritative",
          manifestAuthoritativeRefusal(product),
          plans.find((p) => p.op === "set" && p.governed)!.def.key,
        );
      const bg = parseBreakGlass(opts.breakGlass, opts.now);
      if ("ok" in bg) return bg;
      breakGlass = bg;
    }
  }
  const bgOf = (p: ProductPlan) =>
    breakGlass && p.op === "set" && p.governed && p.row === "upsert"
      ? breakGlass
      : null;

  // The batch: anchor audit rows (versions checked), then everything else guarded by the anchor.
  const versionChecks = plans.filter((p) => p.w.expectedVersion !== undefined);
  const when: SqlGuard = versionChecks.length
    ? {
        sql: versionChecks
          .map(() => VERSION_OF("product_settings"))
          .join(" AND "),
        params: versionChecks.flatMap((p) => [
          slug,
          p.def.key,
          opts.now,
          p.w.expectedVersion!,
        ]),
      }
    : NO_GUARD;
  const ids = plans.map(() => randomId("aud"));
  const guard: SqlGuard = {
    sql: "EXISTS (SELECT 1 FROM audit WHERE product = ? AND id = ?)",
    params: [slug, ids[0]!],
  };
  const versionAfter = (p: ProductPlan) =>
    p.row === "upsert" || p.row === "manifest"
      ? p.before.version + 1
      : p.row === "delete"
        ? 0
        : p.before.version;

  const stmts: DbStatement[] = plans.map((p, i) =>
    productAuditStmt(
      slug,
      ids[i]!,
      opts,
      p.def,
      p.w,
      p.op,
      p.before,
      p.after,
      p.storedBefore,
      p.op === "set" ? p.w.value : p.after.value,
      versionAfter(p),
      when,
      bgOf(p),
    ),
  );
  const args = {
    product: slug,
    at: opts.now,
    by: authorOf(opts),
    guard,
  };
  for (const p of plans) {
    if (p.w.statements) stmts.push(...p.w.statements(guard));
    if (p.def.storage.kind !== "column") continue;
    const adapter = ctx.registry.columnAdapter(p.def.key)!;
    if (p.op === "set")
      stmts.push(...adapter.set!({ ...args, value: p.w.value }));
    else if (p.w.restore !== undefined && !adapter.marker && adapter.set)
      stmts.push(...adapter.set({ ...args, value: p.w.restore }));
    else if (adapter.reset) stmts.push(...adapter.reset(args));
  }
  if (opts.extra) stmts.push(...opts.extra(guard));
  const source =
    opts.origin === "resync" || opts.origin === "manifest-push"
      ? "manifest"
      : "console";
  for (const p of plans) {
    if (p.row === "delete")
      stmts.push({
        sql: `DELETE FROM product_settings WHERE product = ? AND key = ? AND (${guard.sql})`,
        params: [slug, p.def.key, ...guard.params],
      });
    else if (p.row === "upsert" || p.row === "manifest") {
      // A break-glass claim stores its reason and expiry; any other write clears an expiry, so an
      // ordinary save makes a claim permanent and a second break-glass save restarts its clock.
      const bg = bgOf(p);
      const manifestRow = p.row === "manifest";
      stmts.push({
        sql: `INSERT INTO product_settings
                (product, key, value_json, source, version, updated_at, updated_by, reason, expires_at)
              SELECT ?, ?, ?, ?, 1, ?, ?, ?, ? WHERE (${guard.sql})
              ON CONFLICT(product, key) DO UPDATE SET
                value_json = excluded.value_json, source = excluded.source,
                version = CASE
                  WHEN product_settings.expires_at IS NOT NULL
                   AND product_settings.expires_at <= excluded.updated_at THEN 1
                  ELSE product_settings.version + 1 END,
                updated_at = excluded.updated_at,
                updated_by = excluded.updated_by, reason = excluded.reason,
                expires_at = excluded.expires_at`,
        params: [
          slug,
          p.def.key,
          manifestRow
            ? JSON.stringify(p.w.restore)
            : p.def.storage.kind === "scalar"
              ? JSON.stringify(p.w.value)
              : null,
          manifestRow ? "manifest" : source,
          opts.now,
          authorOf(opts),
          manifestRow ? null : (bg?.reason ?? p.w.reason ?? null),
          bg?.expiresAt ?? null,
          ...guard.params,
        ],
      });
    }
  }

  if (
    !(await applyBatch(ctx.db, stmts, {
      table: "audit",
      id: ids[0]!,
      product: slug,
    }))
  ) {
    const current = new Map(
      (
        await ctx.db.all<{ key: string; version: number }>(
          `SELECT key, version FROM product_settings WHERE product = ? AND ${LIVE_ROW}`,
          slug,
          opts.now,
        )
      ).map((r) => [r.key, r.version]),
    );
    const stale =
      versionChecks.find(
        (p) => (current.get(p.def.key) ?? 0) !== p.w.expectedVersion,
      ) ?? versionChecks[0];
    return refuse(
      409,
      "version_conflict",
      "the setting changed since it was loaded; reload and review it",
      stale?.def.key,
      { currentVersion: stale ? (current.get(stale.def.key) ?? 0) : 0 },
    );
  }
  return {
    ok: true,
    written: plans.map((p) => ({
      key: p.def.key,
      op: p.op,
      version: versionAfter(p),
      claimed: p.claimed,
      ...(bgOf(p) ? { breakGlass: bgOf(p)! } : {}),
      before: p.before,
      after: p.after,
    })),
  };
}

// ── Platform scope ───────────────────────────────────────────────────────────────────────────

async function writePlatform(
  ctx: SettingsWriteContext,
  writes: readonly SettingWrite[],
  opts: WriteOptions,
): Promise<WriteOutcome> {
  const plans: {
    def: SettingDef;
    w: SettingWrite;
    op: "set" | "reset";
    rowKey: string;
    before: ResolvedSetting;
    after: WrittenSetting["after"];
    stored: unknown;
  }[] = [];
  for (const w of writes) {
    const def = ctx.registry.get(w.key, "platform");
    if (!def)
      return refuse(
        404,
        "unknown_setting",
        `${w.key} is not a platform setting`,
        w.key,
      );
    if (def.pending)
      return refuse(
        409,
        "pending_setting",
        `${def.key} is registered ahead of ${def.pending.wp} and cannot be written yet`,
        def.key,
      );
    if (def.ownership !== "operator" || def.storage.kind !== "scalar")
      return refuse(409, "read_only", `${def.key} is not writable`, def.key);
    const op = w.op ?? "set";
    const before = await resolvePlatformSetting(ctx, def.key, { fresh: true });
    const storedStep = before.chain.find((s) => s.source === "platform");
    if (op === "reset" && !storedStep)
      return refuse(
        404,
        "nothing_stored",
        `${def.key} has no runtime value`,
        def.key,
      );
    const rowKey = def.storage.storedAs ?? def.key;
    // A reset falls back to the deploy value or the default (A-13's DELETE).
    const fallback = before.chain
      .filter((s) => s.source !== "platform" && !s.ignored)
      .at(-1);
    const after: WrittenSetting["after"] =
      op === "set"
        ? { value: w.value, source: "platform" }
        : {
            value: fallback?.value ?? def.defaultValue,
            source: fallback?.source ?? "default",
          };
    const refused = commonChecks(def, w, op, before.value, after.value, opts);
    if (refused) return refused;
    plans.push({
      def,
      w,
      op,
      rowKey,
      before,
      after,
      stored: storedStep?.value,
    });
  }

  const versionChecks = plans.filter((p) => p.w.expectedVersion !== undefined);
  const when: SqlGuard = versionChecks.length
    ? {
        sql: versionChecks
          .map(() => VERSION_OF("platform_settings"))
          .join(" AND "),
        params: versionChecks.flatMap((p) => [p.rowKey, p.w.expectedVersion!]),
      }
    : NO_GUARD;
  const ids = plans.map(() => randomId("paud"));
  const guard: SqlGuard = {
    sql: "EXISTS (SELECT 1 FROM platform_audit WHERE id = ?)",
    params: [ids[0]!],
  };
  const by = authorOf(opts);
  const stmts: DbStatement[] = plans.map((p, i) => ({
    sql: `INSERT INTO platform_audit
            (id, at, actor_sub, actor_name, actor_email, action, target_kind, target_id, summary,
             before_json, after_json, origin, reason, setting_key)
          SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE (${when.sql})`,
    params: [
      ids[i]!,
      opts.now,
      opts.actor.sub,
      opts.actor.name,
      opts.actor.email,
      p.w.audit?.action ??
        (p.op === "set" ? "platform.setting.set" : "platform.setting.revert"),
      p.w.audit?.target === undefined
        ? "setting"
        : (p.w.audit.target?.kind ?? null),
      p.w.audit?.target === undefined
        ? p.def.key
        : (p.w.audit.target?.id ?? null),
      summaryOf(p.w, {}) ??
        defaultSummary(p.def, p.op, opts.origin, p.before.value, p.after.value),
      snapshot(p.def, {
        value: p.before.value,
        source: p.before.source,
        version: p.before.version,
        stored: p.stored,
      }),
      snapshot(p.def, {
        value: p.after.value,
        source: p.after.source,
        version: p.before.version + 1,
        stored: p.op === "set" ? p.w.value : undefined,
      }),
      opts.origin,
      p.w.reason ?? null,
      p.def.key,
      ...when.params,
    ],
  }));
  for (const p of plans)
    stmts.push(
      p.op === "set"
        ? {
            sql: `INSERT INTO platform_settings (key, value_json, version, updated_at, updated_by)
                  SELECT ?, ?, 1, ?, ? WHERE (${guard.sql})
                  ON CONFLICT(key) DO UPDATE SET
                    value_json = excluded.value_json, version = platform_settings.version + 1,
                    updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
            params: [
              p.rowKey,
              JSON.stringify(p.w.value),
              opts.now,
              by,
              ...guard.params,
            ],
          }
        : // A tombstone (A-13's): the version keeps counting, so a stale one can never pass.
          {
            sql: `UPDATE platform_settings
                     SET value_json = 'null', version = version + 1, updated_at = ?, updated_by = ?
                   WHERE key = ? AND value_json <> 'null' AND (${guard.sql})`,
            params: [opts.now, by, p.rowKey, ...guard.params],
          },
    );
  if (opts.extra) stmts.push(...opts.extra(guard));

  const ok = await applyBatch(ctx.db, stmts, {
    table: "platform_audit",
    id: ids[0]!,
  });
  invalidatePlatformSettings(ctx.env, ctx.db);
  if (!ok) {
    // With no version to check the anchor always inserts; a miss there is a broken database.
    const stale = versionChecks[0];
    if (!stale)
      throw new Error("writeSetting: the unguarded batch did not apply");
    const current = await ctx.db.first<{ version: number }>(
      "SELECT version FROM platform_settings WHERE key = ?",
      stale.rowKey,
    );
    return refuse(
      409,
      "version_conflict",
      "the setting changed since it was loaded; reload and review it",
      stale.def.key,
      { currentVersion: current?.version ?? 0 },
    );
  }
  return {
    ok: true,
    written: plans.map((p) => ({
      key: p.def.key,
      op: p.op,
      version: p.before.version + 1,
      claimed: false,
      before: p.before,
      after: p.after,
    })),
  };
}
