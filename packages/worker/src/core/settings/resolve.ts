/**
 * The settings resolver (ST-04, notes/S-18 §4.4): one effective value per setting, with the
 * source chain that produced it, over row-backed and column-backed keys alike.
 *
 *   code default → deploy var → platform value → product (manifest or console) → entity
 *
 * then, for a `policy` entry, a clamp on the permissive side by the platform bound, and for an
 * A-13 `ceiling` kill switch the deploy-time hard off (unchanged from A-13). Every answer carries
 * `{ value, source, chain, lockedBy?, clamped?, drift?, version }`: the console renders the chain
 * ("Clamped by Platform: set 30, effective 14"), `writeSetting()` compares `version`, and the
 * discovery builder and the enforcement path read the same value, so they cannot drift (S-18
 * §4.11; `test/settings-discovery.test.ts`).
 *
 * Two halves:
 *
 *   - PURE: `resolvePlatformValue` and `resolveProductValue` take the layers as data. The property
 *     tests (`test/settings-resolver.test.ts`) drive them over every source and both clamp
 *     directions, and pin them to A-13's resolver for A-13's keys.
 *   - LOADERS: `resolvePlatformSetting` / `resolveProductSettings` read the layers. Platform rows
 *     come from A-13's 30-second per-isolate cache (`platformStoreRows`); product rows are read
 *     per call (one indexed `product_settings` read beside the product row, S-18 §4.3), never
 *     cached across requests, so an enforcement read is never staler than the row. Column-backed
 *     values are decoded through the key's column adapter, one select per table; a caller that
 *     already holds the `products` row passes it and `products` is not read again.
 *
 * Hot paths are unchanged: a column-backed key's readers keep reading their typed column. Rich
 * entries (tiers, profiles, outlets) are read by their own descriptor adapters (ST-05, ST-17) and
 * are not resolved here.
 */

import type { Db } from "../../db/types.js";
import {
  deployVarParser,
  platformStoreRows,
  type SettingsEnv,
} from "../platformSettings.js";
import { getManifestSnapshot } from "../manifestSnapshot.js";
import { snapshotValue } from "./snapshot.js";
import type { SettingsRegistry } from "./registry.js";
import { fitsValueSpec } from "./rules.js";
import type {
  SettingColumnAdapter,
  SettingDef,
  SettingEntity,
  SettingScope,
  SettingSource,
} from "./types.js";
import { tryParseJson } from "../../platform/json.js";

// ── Values ───────────────────────────────────────────────────────────────────────────────────

/** Whether `value` is a value of `def`: its value spec, or `null` when the entry allows unset. */
export function isSettingValue(def: SettingDef, value: unknown): boolean {
  if (value === null) return def.allowUnset === true;
  return fitsValueSpec(def.value, value);
}

/** A stable JSON rendering (object keys sorted), for value equality and drift. */
export function canonicalJson(value: unknown): string {
  if (value === undefined) return "undefined";
  return JSON.stringify(value, (_k, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).sort(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0,
          ),
        )
      : v,
  );
}

export function sameValue(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

/**
 * A `[vars]` string as the entry's value, or `undefined` when it is not one. A-13's integer keys
 * keep their pre-A-13 parsing (deploy values are reviewed in the repo, so they are not held to
 * the runtime bounds); everything else must be a value of the entry.
 */
export function parseDeployValue(def: SettingDef, raw: unknown): unknown {
  if (typeof raw !== "string" || def.varName === undefined) return undefined;
  const legacy = deployVarParser(def.varName);
  if (legacy && def.value.kind === "integer") return legacy(raw);
  const t = raw.trim();
  let v: unknown;
  switch (def.value.kind) {
    case "switch":
    case "enum":
      v = t.toLowerCase();
      break;
    case "boolean":
      v = t === "true" ? true : t === "false" ? false : undefined;
      break;
    case "integer":
      v = t === "" ? undefined : Number(t);
      break;
    case "string":
      v = raw;
      break;
    case "list":
    case "json":
      try {
        v = JSON.parse(t) as unknown;
      } catch {
        v = undefined;
      }
      break;
  }
  return v !== undefined && v !== null && fitsValueSpec(def.value, v)
    ? v
    : undefined;
}

/**
 * A `ceiling` entry's `[vars]` value is a hard off when it is `off`, or a string that is neither a
 * value nor `runtime` (`false`, `0`, a typo): A-13's rule, which no runtime value can override.
 */
export function isHardOffDeploy(def: SettingDef, raw: unknown): boolean {
  if (def.precedence !== "ceiling" || typeof raw !== "string") return false;
  const parsed = parseDeployValue(def, raw);
  if (parsed === "off") return true;
  return parsed === undefined && raw.trim().toLowerCase() !== "runtime";
}

// ── The chain ────────────────────────────────────────────────────────────────────────────────

/** One layer that had something to say, in precedence order (lowest first). */
export interface ChainStep {
  source: SettingSource;
  /**
   * Where it was read: `default`, `deploy:<VAR>`, `platform_settings:<row key>`,
   * `product_settings`, `<table>.<column>`, `<entity>:<id>`.
   */
  from: string;
  value: unknown;
  /** Present, but not a value of the entry: shown in the chain, never applied. */
  ignored?: true;
  version?: number;
  at?: number;
  by?: string;
}

export interface ResolvedSetting {
  key: string;
  scope: SettingScope;
  /** The effective value (`null` only for an entry that allows unset). */
  value: unknown;
  /** The layer the effective value came from (before any clamp). */
  source: SettingSource;
  chain: ChainStep[];
  /**
   * A higher scope fixed or bounded the value: the deploy (A-13 ceiling), the platform, or the
   * registry for the system product (`systemLock`, ST-20).
   */
  lockedBy?: "deploy" | "platform" | "system";
  /** A `policy` entry whose value sat outside the platform bound: what was set, and the bound. */
  clamped?: { requested: unknown; bound: unknown; by: "platform" };
  /** A claimable key whose console claim differs from the last applied manifest (ST-01a). */
  drift?: { manifest: unknown; console: unknown };
  /** The `expectedVersion` the next write must carry (0: no stored row). */
  version: number;
  /** A-13's fail-safe: the store was unreadable, so a kill switch reads off. */
  failsafe?: true;
}

/** A stored value as a layer reads it. */
export interface StoredLayer {
  value: unknown;
  version?: number;
  at?: number;
  by?: string;
}

function pick(def: SettingDef, chain: ChainStep[]): ChainStep {
  for (let i = chain.length - 1; i >= 0; i--)
    if (!chain[i]!.ignored) return chain[i]!;
  // The default is always valid (`checkRegistry` refuses one that is not).
  return (
    chain[0] ?? { source: "default", from: "default", value: def.defaultValue }
  );
}

/** The input of `resolvePlatformValue`. */
export interface PlatformLayers {
  /** The raw `[vars]` string (`env[def.varName]`), if any. */
  deploy?: unknown;
  /** The `platform_settings` row, if any (a tombstone is no row). */
  row?: StoredLayer | null;
  /** The row's key (`storage.storedAs` or the registry key), for the chain. */
  rowKey?: string;
  /** False when the store could not be read: a `ceiling` kill switch then reads off. */
  storeOk?: boolean;
  /** The row's version, a tombstone's included (0: never written). */
  version?: number;
}

/** Resolve one PLATFORM-scope entry from its layers (pure). */
export function resolvePlatformValue(
  def: SettingDef,
  layers: PlatformLayers,
): ResolvedSetting {
  const chain: ChainStep[] = [
    { source: "default", from: "default", value: def.defaultValue },
  ];
  if (def.varName !== undefined && typeof layers.deploy === "string") {
    const parsed = parseDeployValue(def, layers.deploy);
    chain.push({
      source: "deploy",
      from: `deploy:${def.varName}`,
      value: parsed ?? layers.deploy,
      ...(parsed === undefined ? { ignored: true as const } : {}),
    });
  }
  const base = { key: def.key, scope: def.scope, version: layers.version ?? 0 };
  if (isHardOffDeploy(def, layers.deploy))
    return {
      ...base,
      value: "off",
      source: "deploy",
      chain,
      lockedBy: "deploy",
    };
  if (def.precedence === "ceiling" && layers.storeOk === false)
    return { ...base, value: "off", source: "derived", chain, failsafe: true };
  if (layers.row) {
    chain.push({
      source: "platform",
      from: `platform_settings:${layers.rowKey ?? def.key}`,
      value: layers.row.value,
      version: layers.row.version,
      at: layers.row.at,
      by: layers.row.by,
      ...(isSettingValue(def, layers.row.value)
        ? {}
        : { ignored: true as const }),
    });
  }
  const top = pick(def, chain);
  return { ...base, value: top.value, source: top.source, chain };
}

/** One entity value (a tier's, then a licence's), in the order they apply. */
export interface EntityLayer {
  entity: SettingEntity;
  id: string;
  value: unknown;
  source: "manifest" | "console";
}

/** The input of `resolveProductValue`. */
export interface ProductLayers {
  /** The platform entry this key inherits (`inherits: "platform"`), resolved. */
  inherit?: ResolvedSetting;
  /** The platform entry that bounds this `policy` key (`productLink.bound`), resolved. */
  bound?: ResolvedSetting;
  /** ST-16: the platform enforces its value on every product (`policyBound: "lock"` only). */
  enforced?: boolean;
  /** The product's own value and where it came from. */
  stored?: StoredLayer & { source: "manifest" | "console"; from: string };
  entities?: readonly EntityLayer[];
  /** The last applied manifest's value (ST-01a's snapshot), for drift. */
  manifestValue?: unknown;
  version?: number;
  /**
   * When the product was registered: before an entry's `legacyDefault.createdBefore` the default
   * step is that legacy value (LX-06, plans/LX-01.md §8 Q2), still with source `default`.
   */
  productCreatedAt?: number;
  /** The product is the system product: an entry's `systemLock` fixes its value (ST-20). */
  system?: boolean;
}

/** The default a product starts from: the entry's, or its `legacyDefault` for an older product. */
export function productDefault(
  def: SettingDef,
  createdAt: number | undefined,
): unknown {
  return def.legacyDefault &&
    createdAt !== undefined &&
    createdAt < def.legacyDefault.createdBefore
    ? def.legacyDefault.value
    : def.defaultValue;
}

/** Resolve one PRODUCT- (or entity-) scope entry from its layers (pure). */
export function resolveProductValue(
  def: SettingDef,
  layers: ProductLayers,
): ResolvedSetting {
  const legacy =
    def.legacyDefault &&
    layers.productCreatedAt !== undefined &&
    layers.productCreatedAt < def.legacyDefault.createdBefore;
  const chain: ChainStep[] = [
    {
      source: "default",
      from: legacy ? "legacyDefault" : "default",
      value: productDefault(def, layers.productCreatedAt),
    },
  ];
  // Live inheritance (D5): the platform entry's deploy and platform layers sit below the
  // product's own. Its default is the product default's twin, so it adds nothing.
  if (def.inherits === "platform" && layers.inherit)
    for (const step of layers.inherit.chain)
      if (step.source !== "default")
        chain.push({
          ...step,
          // A platform value that is not a value of the PRODUCT entry is not inherited.
          ...(step.ignored || !isSettingValue(def, step.value)
            ? { ignored: true as const }
            : {}),
        });
  if (layers.stored)
    chain.push({
      source: layers.stored.source,
      from: layers.stored.from,
      value: layers.stored.value,
      version: layers.stored.version,
      at: layers.stored.at,
      by: layers.stored.by,
      ...(isSettingValue(def, layers.stored.value)
        ? {}
        : { ignored: true as const }),
    });
  for (const e of layers.entities ?? [])
    chain.push({
      source: e.source,
      from: `${e.entity}:${e.id}`,
      value: e.value,
      ...(isSettingValue(def, e.value) ? {} : { ignored: true as const }),
    });
  const top = pick(def, chain);
  const out: ResolvedSetting = {
    key: def.key,
    scope: def.scope,
    value: top.value,
    source: top.source,
    chain,
    version: layers.version ?? 0,
  };
  // The system-lock rule (ST-20): the registry fixes the value for the system product; no row,
  // console write or manifest changes it there.
  if (def.systemLock && layers.system) {
    out.value = def.systemLock.value;
    out.source = "derived";
    out.lockedBy = "system";
    return out;
  }
  const clamp = clampToBound(def, top.value, layers);
  if (clamp) {
    out.value = clamp.value;
    out.lockedBy = "platform";
    if (!sameValue(clamp.value, top.value))
      out.clamped = {
        requested: top.value,
        bound: clamp.bound,
        by: "platform",
      };
  }
  if (
    def.ownership === "claimable" &&
    layers.stored?.source === "console" &&
    layers.manifestValue !== undefined &&
    !sameValue(layers.manifestValue, layers.stored.value)
  )
    out.drift = {
      manifest: layers.manifestValue,
      console: layers.stored.value,
    };
  return out;
}

/**
 * The value a `policy` entry takes under its platform bound, on the permissive side only (S-18
 * §4.4): `max` lowers a larger value to the bound, `min` raises a smaller one, `lock` replaces it
 * while the platform enforces. `null` ("unlimited", allowed only by `allowUnset`) is the most
 * permissive value of all, so a bound always replaces it. `undefined`: no bound applies.
 */
export function clampToBound(
  def: SettingDef,
  value: unknown,
  layers: Pick<ProductLayers, "bound" | "enforced">,
): { value: unknown; bound: unknown } | undefined {
  if (def.merge !== "policy" || !def.policyBound || !layers.bound)
    return undefined;
  const bound = layers.bound.value;
  if (bound === null || bound === undefined) return undefined;
  switch (def.policyBound) {
    case "max":
      if (typeof bound !== "number") return undefined;
      return {
        value: value === null || (value as number) > bound ? bound : value,
        bound,
      };
    case "min":
      if (typeof bound !== "number") return undefined;
      return {
        value: value === null || (value as number) < bound ? bound : value,
        bound,
      };
    case "lock":
      return layers.enforced ? { value: bound, bound } : undefined;
  }
}

/**
 * Whether `value` is outside the platform bound a product write must respect (S-18 §4.4: "a
 * product write outside the bound is refused with `setting_out_of_bounds`").
 */
export function outOfBounds(
  def: SettingDef,
  value: unknown,
  layers: Pick<ProductLayers, "bound" | "enforced">,
): { bound: unknown } | undefined {
  const c = clampToBound(def, value, layers);
  return c && !sameValue(c.value, value) ? { bound: c.bound } : undefined;
}

// ── Loaders ──────────────────────────────────────────────────────────────────────────────────

/** What every loader needs: the Worker's env (the `[vars]`), a database and the registry. */
export interface SettingsContext {
  env: SettingsEnv;
  db: Db;
  registry: SettingsRegistry;
}

function storedKey(def: SettingDef): string {
  return def.storage.kind === "scalar" && def.storage.storedAs
    ? def.storage.storedAs
    : def.key;
}

function platformDef(ctx: SettingsContext, keyOrAlias: string): SettingDef {
  const def = ctx.registry.get(keyOrAlias, "platform");
  if (!def) throw new Error(`no platform setting ${keyOrAlias}`);
  return def;
}

/** Resolve one platform-scope setting (from the 30-second platform cache unless `fresh`). */
export async function resolvePlatformSetting(
  ctx: SettingsContext,
  keyOrAlias: string,
  opts: { fresh?: boolean } = {},
): Promise<ResolvedSetting> {
  const def = platformDef(ctx, keyOrAlias);
  const read = await platformStoreRows(ctx.env, ctx.db, opts);
  return platformFromRead(ctx, def, read);
}

function platformFromRead(
  ctx: SettingsContext,
  def: SettingDef,
  read: Awaited<ReturnType<typeof platformStoreRows>>,
): ResolvedSetting {
  const rowKey = storedKey(def);
  const row = read.rows.get(rowKey);
  return resolvePlatformValue(def, {
    deploy: def.varName ? ctx.env[def.varName] : undefined,
    row:
      row && !row.deleted
        ? {
            value: row.value,
            version: row.version,
            at: row.updatedAt,
            by: row.updatedBy,
          }
        : null,
    rowKey,
    storeOk: read.ok,
    version: row?.version ?? 0,
  });
}

/** A `product_settings` row, as D1 returns it. */
interface ProductSettingsRow {
  key: string;
  value_json: string | null;
  source: "manifest" | "console";
  version: number;
  updated_at: number;
  updated_by: string;
  expires_at: number | null;
}

/** The product facts the resolver needs; a full `products` row satisfies it. */
export interface ProductFacts {
  slug: string;
  system?: number | null;
  release_source?: string | null;
  /** When it was registered: picks an entry's `legacyDefault` (LX-06). */
  created_at?: number;
}

/** Is the product linked to a repository whose `.pkey/` manifest it follows? */
export function followsManifest(product: ProductFacts): boolean {
  return product.release_source === "github" || product.system === 1;
}

/** One select per adapted table (the `products` row is the one the caller already holds). */
async function readColumnRows(
  db: Db,
  product: ProductFacts,
  adapters: readonly SettingColumnAdapter[],
): Promise<Map<string, Record<string, unknown> | null>> {
  const byTable = new Map<string, { keyColumn: string; cols: Set<string> }>();
  for (const a of adapters) {
    if (a.table === "products") continue;
    let t = byTable.get(a.table);
    if (!t)
      byTable.set(a.table, (t = { keyColumn: a.keyColumn, cols: new Set() }));
    for (const c of a.columns) t.cols.add(c);
  }
  const out = new Map<string, Record<string, unknown> | null>([
    // The caller's `products` row (a full `SELECT *` or `ProductRow`): its columns are read as is.
    ["products", product as unknown as Record<string, unknown>],
  ]);
  for (const [table, { keyColumn, cols }] of byTable) {
    try {
      out.set(
        table,
        await db.first<Record<string, unknown>>(
          `SELECT ${[...cols].join(", ")} FROM ${table} WHERE ${keyColumn} = ?`,
          product.slug,
        ),
      );
    } catch {
      // A table this database does not have yet reads as "no row": every key in it is unset.
      out.set(table, null);
    }
  }
  return out;
}

/** The source of a column-backed key's stored value (S-18 §4.3: absence means manifest). */
function columnSource(
  def: SettingDef,
  product: ProductFacts,
  marker: "manifest" | "console" | "default" | undefined,
  row: ProductSettingsRow | undefined,
): "manifest" | "console" {
  if (marker === "console" || marker === "default") return "console";
  if (marker === "manifest")
    return followsManifest(product) ? "manifest" : "console";
  if (row) return row.source;
  return def.ownership !== "operator" && followsManifest(product)
    ? "manifest"
    : "console";
}

export interface ResolveProductOptions {
  /** Only these keys (registry keys or aliases); default every live scalar and column entry. */
  keys?: readonly string[];
  /** Read ST-01a's manifest snapshot and report drift on claimed keys. */
  withDrift?: boolean;
  /** Epoch seconds, for break-glass expiry (`product_settings.expires_at`). */
  now?: number;
}

/**
 * Resolve a product's settings. `product` is a slug, or the `products` row the caller already
 * holds (then `products` is not read again). Rich entries are skipped (their descriptor adapters
 * read them); a pending entry is resolved only when asked for by key. Answers `[]` for a product
 * that does not exist.
 */
export async function resolveProductSettings(
  ctx: SettingsContext,
  product: string | ProductFacts,
  opts: ResolveProductOptions = {},
): Promise<ResolvedSetting[]> {
  const row =
    typeof product === "string"
      ? await ctx.db.first<ProductFacts>(
          "SELECT * FROM products WHERE slug = ?",
          product,
        )
      : product;
  if (!row) return [];
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const defs = (
    opts.keys
      ? opts.keys.map((k) => {
          const d = ctx.registry.get(k, "product");
          if (!d) throw new Error(`no product setting ${k}`);
          return d;
        })
      : ctx.registry.entries.filter((e) => e.scope === "product" && !e.pending)
  ).filter((d) => d.storage.kind === "scalar" || d.storage.kind === "column");

  const stored = new Map<string, ProductSettingsRow>();
  for (const r of await ctx.db.all<ProductSettingsRow>(
    "SELECT key, value_json, source, version, updated_at, updated_by, expires_at FROM product_settings WHERE product = ?",
    row.slug,
  ))
    // An expired break-glass claim (ST-20) is no claim at all.
    if (r.expires_at === null || r.expires_at > now) stored.set(r.key, r);

  const adapters = new Map<string, SettingColumnAdapter>();
  for (const d of defs)
    if (d.storage.kind === "column") {
      const a = ctx.registry.columnAdapter(d.key);
      if (!a) throw new Error(`${d.key} is column-backed but has no adapter`);
      adapters.set(d.key, a);
    }
  const columnRows = await readColumnRows(ctx.db, row, [...adapters.values()]);

  const needsPlatform = defs.some(
    (d) => d.inherits === "platform" || d.merge === "policy",
  );
  const platformRead = needsPlatform
    ? await platformStoreRows(ctx.env, ctx.db)
    : null;
  const linked = (d: SettingDef): ResolvedSetting | undefined => {
    const p = ctx.registry.get(d.key, "platform");
    return p && platformRead
      ? platformFromRead(ctx, p, platformRead)
      : undefined;
  };

  let manifest: unknown;
  if (opts.withDrift) {
    const snap = await getManifestSnapshot(ctx.db, row.slug);
    manifest = snap ? tryParseJson(snap.manifest_json) : undefined;
  }

  return defs.map((def) => {
    const ps = stored.get(def.key);
    let layer: ProductLayers["stored"];
    if (def.storage.kind === "column") {
      const adapter = adapters.get(def.key)!;
      const colRow = columnRows.get(adapter.table) ?? null;
      const value = adapter.decode(colRow);
      if (value !== undefined)
        layer = {
          value,
          source: columnSource(def, row, adapter.marker?.(colRow), ps),
          from: `${adapter.table}.${def.storage.column}`,
          version: ps?.version,
          at: ps?.updated_at,
          by: ps?.updated_by,
        };
    } else if (ps && ps.value_json !== null) {
      layer = {
        value: tryParseJson(ps.value_json),
        source: ps.source,
        from: "product_settings",
        version: ps.version,
        at: ps.updated_at,
        by: ps.updated_by,
      };
    }
    const p = linked(def);
    return resolveProductValue(def, {
      inherit: def.inherits === "platform" ? p : undefined,
      bound:
        def.merge === "policy" &&
        p &&
        ctx.registry.get(def.key, "platform")?.productLink?.bound
          ? p
          : undefined,
      stored: layer,
      manifestValue:
        manifest !== undefined
          ? snapshotValue(def.key, manifest, def)
          : undefined,
      version: ps?.version ?? 0,
      ...(typeof row.created_at === "number"
        ? { productCreatedAt: row.created_at }
        : {}),
      system: row.system === 1,
    });
  });
}

/**
 * The platform entry a product key inherits or is bounded by, resolved (from the platform cache):
 * the `inherit` and `bound` layers `resolveProductValue` takes.
 */
export async function platformLinks(
  ctx: SettingsContext,
  def: SettingDef,
): Promise<Pick<ProductLayers, "inherit" | "bound">> {
  const p = ctx.registry.get(def.key, "platform");
  if (!p || (def.inherits !== "platform" && def.merge !== "policy")) return {};
  const resolved = platformFromRead(
    ctx,
    p,
    await platformStoreRows(ctx.env, ctx.db),
  );
  return {
    inherit: def.inherits === "platform" ? resolved : undefined,
    bound:
      def.merge === "policy" && p.productLink?.bound ? resolved : undefined,
  };
}

/** Resolve one product setting (see `resolveProductSettings`); `undefined` for no such product. */
export async function resolveProductSetting(
  ctx: SettingsContext,
  product: string | ProductFacts,
  keyOrAlias: string,
  opts: Omit<ResolveProductOptions, "keys"> = {},
): Promise<ResolvedSetting | undefined> {
  return (
    await resolveProductSettings(ctx, product, { ...opts, keys: [keyOrAlias] })
  )[0];
}
