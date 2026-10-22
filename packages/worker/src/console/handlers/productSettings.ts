/**
 * The product settings admin API (S-18 §4.7, rule 10; LX-06 began it, ST-05b finished it):
 *
 *   GET    /manage/api/products/<slug>/settings/effective[?area=<area>]
 *   GET    /manage/api/products/<slug>/settings/<key>
 *   PATCH  /manage/api/products/<slug>/settings/<key>   { value, expectedVersion, reason?, confirm?, breakGlass? }
 *   DELETE /manage/api/products/<slug>/settings/<key>   { expectedVersion, reason?, confirm? }
 *   GET    /manage/api/products/<slug>/settings/drift
 *
 * `expectedVersion` is required on both writes, as on platform settings (`platformSettings.ts`):
 * the row version the console read, 0 when there was no row. `writeSetting()` checks it.
 *
 * ONE route family serves every product setting the console edits: the row-backed ones
 * (`core/rowSettings.ts`), the column-backed ones (the resolver reads them through their column
 * adapters) and the rich ones that have a `SettingAdapter` (`distribution.access`). The bespoke
 * routes this replaced (`…/update/settings`, `…/license/policy`, `…/trust-policy`,
 * `…/distribution/access`) are gone: what each checked beyond routing is the key's adapter
 * (`core/settings/adapters.ts` and each service's `settingsAdapters.ts`), run here before the one
 * write. A key whose value is a `secret` is never served. History, as-of and restore are not built.
 *
 * Model C (S-18 D2): a PATCH on a repo-linked product CLAIMS the key (`source = 'console'`), and
 * every later resync leaves it alone; DELETE is Revert to manifest (or "reset to default" on a
 * product no manifest feeds). The system product is manifest-authoritative: both are refused
 * until ST-20's break-glass claims.
 *
 * Core-owned, like `claims`: the settings of several services share one store and one path. The
 * registry is the composition root's (`mount.ts` `SETTINGS`), so no service is imported here.
 * Session, CSRF, rate limit and the product-admin gate all ran before this is reached.
 */

import type { Db } from "../../db/types.js";
import type { Env } from "../../platform/env.js";
import type { ProductRow } from "../../core/repo.js";
import { ErrorCode } from "../../core/errors.js";
import { parseServices } from "../../core/services.js";
import {
  isRowServed,
  readRowSettings,
  revertRowSetting,
  rowSettingDefault,
  writeRowSetting,
  type RowSettingRefusal,
  type RowSettingView,
} from "../../core/rowSettings.js";
import { getManifestSnapshot } from "../../core/manifestSnapshot.js";
import { getProduct, getProductSyncState } from "../../core/products/store.js";
import { driftView } from "../../core/settingsDrift.js";
import { claimsApply } from "../../core/settingsClaims.js";
import {
  PRODUCT_EMAIL_CAP_KEY,
  productDailyEmailCap,
} from "../../core/notify/emailDelivery.js";
import type {
  SettingAdapter,
  SettingAdapterContext,
  SettingDef,
} from "../../core/settings/types.js";
import {
  resolveProductSettings,
  type ResolvedSetting,
} from "../../core/settings/resolve.js";
import { snapshotValue } from "../../core/settings/snapshot.js";
import { writeSetting, type WriteRefusal } from "../../core/settings/write.js";
import type { ServiceHooks } from "../../core/hooks.js";
import { tryParseJson } from "../../platform/json.js";
import { SETTINGS } from "../../mount.js";
import type { AdminSession } from "../../core/console/session.js";
import { can } from "../authz.js";
import { requireStepUp } from "../stepUp.js";
import {
  adminJson,
  err,
  notFound,
  readBody,
} from "../../core/console/respond.js";

/**
 * Does this API serve `def`? A live product entry whose value is a secret never is. Otherwise the
 * row-backed keys (`isRowServed`), every column-backed key (the resolver reads them through their
 * column adapters) and a rich key whose owner contributed an adapter that reads it.
 */
function served(d: SettingDef, pendingToo = false): boolean {
  if (
    d.scope !== "product" ||
    (d.pending && !pendingToo) ||
    d.sensitivity === "secret"
  )
    return false;
  if (isRowServed(d) || d.storage.kind === "column") return true;
  return (
    d.storage.kind === "rich" && SETTINGS.adapter(d.key)?.read !== undefined
  );
}

/**
 * Can a write come through this API? Only a row-backed key, or a key whose owner contributed an
 * adapter (it vouches for the value's shape and the cross-checks the registry cannot hold). A
 * column key without one (`core.services`, whose coherence rules `servicesAdmin` checks, the product
 * name, the web origins) is read here and written where the console already owns it.
 */
function writable(d: SettingDef): boolean {
  return isRowServed(d) || SETTINGS.adapter(d.key) !== undefined;
}

/** The settings this API serves, in registry order. */
export function servedSettings(): SettingDef[] {
  return SETTINGS.entries.filter((d) => served(d));
}

/** One setting as the console renders it: the registry's description plus the value in force. */
export interface ProductSettingDto {
  key: string;
  area: string;
  service: string;
  label: string;
  description: string;
  docs: string;
  /** The value's shape, bounds and vocabulary (`ValueSpec`). */
  spec: SettingDef["value"];
  confirm: SettingDef["confirm"];
  critical: boolean;
  /** `.pkey/<document>` and the dotted path the manifest declares it at. */
  manifestPath: string | null;
  /** Hide (or show read-only) while the owning service is off (`visibleWhen`). */
  visibleWhen: SettingDef["visibleWhen"] | null;
  serviceEnabled: boolean;
  /** The console area a write needs (`SettingDef.rbacArea`): a member without edit sees it read-only. */
  rbacArea: SettingDef["rbacArea"];
  /** Who may write it (`SettingDef.ownership`): a `manifest` or `read-only` key is shown, not edited. */
  ownership: SettingDef["ownership"];
  value: unknown;
  source: RowSettingView["source"];
  defaultValue: unknown;
  /** What an unset value follows, when the platform supplies one (the daily mail cap). */
  inherited?: unknown;
  /** What the last applied manifest declares (Revert's target), when it declares it. */
  manifestValue?: unknown;
  /** Why a write is refused now (an adapter's `blocked`), e.g. a product with no release config. */
  blocked?: string;
  version: number;
  updatedAt: number | null;
  updatedBy: string | null;
  reason: string | null;
}

function dto(
  view: RowSettingView,
  services: Record<string, { enabled: boolean } | undefined>,
  manifest: unknown,
  blocked?: string | null,
): ProductSettingDto {
  const d = view.def;
  const declared =
    manifest === undefined ? undefined : snapshotValue(d.key, manifest, d);
  return {
    key: d.key,
    area: d.area,
    service: d.service,
    label: d.label,
    description: d.description,
    docs: d.docs,
    spec: d.value,
    confirm: d.confirm,
    critical: d.critical === true,
    manifestPath: d.manifest?.path ?? null,
    visibleWhen: d.visibleWhen ?? null,
    serviceEnabled:
      d.service === "core" || services[d.service]?.enabled === true,
    rbacArea: d.rbacArea,
    ownership: d.ownership,
    value: view.value,
    source: view.source,
    defaultValue: view.defaultValue,
    ...(declared !== undefined ? { manifestValue: declared } : {}),
    ...(blocked ? { blocked } : {}),
    version: view.version,
    updatedAt: view.updatedAt,
    updatedBy: view.updatedBy,
    reason: view.reason,
  };
}

async function snapshotManifest(db: Db, product: ProductRow): Promise<unknown> {
  if (!claimsApply(product)) return undefined;
  const snap = await getManifestSnapshot(db, product.slug);
  if (!snap) return undefined;
  try {
    return JSON.parse(snap.manifest_json) as unknown;
  } catch {
    return undefined;
  }
}

function refusal(r: RowSettingRefusal, product: ProductRow): Response {
  return err(
    r.status,
    r.status === 403 ? ErrorCode.Forbidden : ErrorCode.BadRequest,
    r.message,
    {
      reason: r.reason,
      ...(r.current
        ? {
            current: dto(
              inForceOf(r.current),
              parseServices(product.services_json).services,
              undefined,
            ),
          }
        : {}),
    },
  );
}

interface Request_ {
  env: Env;
  db: Db;
  product: ProductRow;
  now: number;
  hooks: ServiceHooks | undefined;
}

/**
 * The request after a write: the product row is read again, because the resolver decodes a
 * column-backed value from the row it is handed.
 */
async function afterWrite(r: Request_): Promise<Request_> {
  return {
    ...r,
    product: (await getProduct(r.db, r.product.slug)) ?? r.product,
  };
}

/** What an adapter is handed. Without hooks (a test calling the handler), none are available. */
function adapterCtx(r: Request_): SettingAdapterContext {
  return {
    env: r.env,
    db: r.db,
    product: r.product as unknown as SettingAdapterContext["product"],
    now: r.now,
    hooks:
      r.hooks ??
      ({
        releaseCatalog: () => null,
      } as unknown as ServiceHooks),
  };
}

/** The keys' stored `product_settings` rows, for the author, time and reason a view shows. */
async function storedRows(
  db: Db,
  slug: string,
  now: number,
): Promise<
  Map<
    string,
    {
      reason: string | null;
      updated_at: number;
      updated_by: string;
      version: number;
      source: string;
    }
  >
> {
  const rows = await db.all<{
    key: string;
    reason: string | null;
    updated_at: number;
    updated_by: string;
    version: number;
    source: string;
    expires_at: number | null;
  }>(
    "SELECT key, reason, updated_at, updated_by, version, source, expires_at FROM product_settings WHERE product = ?",
    slug,
  );
  return new Map(
    rows
      .filter((r) => r.expires_at === null || r.expires_at > now)
      .map((r) => [r.key, r]),
  );
}

/** A resolved column-backed key as the view the console renders. */
function viewOfResolved(
  def: SettingDef,
  r: ResolvedSetting,
  product: ProductRow,
  stored: Awaited<ReturnType<typeof storedRows>>,
): RowSettingView {
  const row = stored.get(def.key);
  const step = r.chain.find(
    (c) => c.source === "console" || c.source === "manifest",
  );
  return {
    def,
    value: r.value ?? null,
    source:
      r.source === "console" || r.source === "manifest" ? r.source : "default",
    defaultValue: rowSettingDefault(def, product),
    version: r.version,
    updatedAt: row?.updated_at ?? step?.at ?? null,
    updatedBy: row?.updated_by ?? step?.by ?? null,
    reason: row?.reason ?? null,
  };
}

/** The views of `defs` for `product`: row-backed by the row store, the rest by the resolver. */
async function readViews(
  r: Request_,
  defs: readonly SettingDef[],
): Promise<RowSettingView[]> {
  const { env, db, product, now } = r;
  const byKey = new Map<string, RowSettingView>();
  const rows = defs.filter((d) => isRowServed(d));
  for (const v of await readRowSettings(db, product, rows, now))
    byKey.set(v.def.key, v);
  const columns = defs.filter((d) => d.storage.kind === "column");
  const stored = await storedRows(db, product.slug, now);
  if (columns.length > 0)
    for (const res of await resolveProductSettings(
      { env, db, registry: SETTINGS },
      product,
      { keys: columns.map((d) => d.key), now },
    ))
      byKey.set(
        res.key,
        viewOfResolved(SETTINGS.get(res.key, "product")!, res, product, stored),
      );
  for (const d of defs) {
    const a = d.storage.kind === "rich" ? SETTINGS.adapter(d.key) : undefined;
    if (!a?.read) continue;
    const read = await a.read(adapterCtx(r));
    const row = stored.get(d.key);
    byKey.set(d.key, {
      def: d,
      value: read.value,
      source: read.source,
      defaultValue: d.defaultValue,
      version: row?.version ?? 0,
      updatedAt: row?.updated_at ?? null,
      updatedBy: row?.updated_by ?? null,
      reason: row?.reason ?? null,
    });
  }
  return defs.flatMap((d) => {
    const v = byKey.get(d.key);
    return v ? [inForceOf(v)] : [];
  });
}

/** A view with the value as the readers see it, for a key whose adapter says how (`inForce`). */
function inForceOf(v: RowSettingView): RowSettingView {
  const inForce = SETTINGS.adapter(v.def.key)?.inForce;
  return inForce ? { ...v, value: inForce(v.value) } : v;
}

const NEXT_RESYNC = "applies at the next resync";

/** A `writeSetting()` refusal as this API answers it (a version conflict with the value now). */
async function writeRefusal(
  r: Request_,
  def: SettingDef,
  w: WriteRefusal,
): Promise<Response> {
  const services = parseServices(r.product.services_json).services;
  return err(
    // The route's contract: a missing or malformed version is a 422 like the rest of its inputs.
    w.status === 400 ? 422 : w.status,
    w.status === 403 ? ErrorCode.Forbidden : ErrorCode.BadRequest,
    w.message,
    {
      reason: w.reason,
      ...(w.details ?? {}),
      ...(w.reason === "version_conflict"
        ? {
            current: dto((await readViews(r, [def]))[0]!, services, undefined),
          }
        : {}),
    },
  );
}

/** The 409 a relaxing write gets when it names a version other than the one in force (a missing one is `writeSetting()`'s 422). */
function staleRelax(r: Request_, def: SettingDef, view: RowSettingView): Response {
  const services = parseServices(r.product.services_json).services;
  return err(
    409,
    ErrorCode.BadRequest,
    "the setting changed since it was loaded; reload and review it",
    {
      reason: "version_conflict",
      current: dto(view, services, undefined),
    },
  );
}

/** The 422 an adapter's refusal of a value is. */
function valueRefusal(def: SettingDef, message: string, fields?: string[]) {
  return err(422, ErrorCode.BadRequest, message, {
    reason: "invalid_value",
    key: def.key,
    ...(fields ? { fields } : {}),
  });
}

/**
 * A change that RELAXES a control (an adapter's `relaxes`) needs more than the area: a step-up
 * proved in the last five minutes, a reason and the typed key. `null` when the change may proceed.
 */
function relaxGate(
  session: AdminSession,
  def: SettingDef,
  body: Record<string, unknown>,
  now: number,
): Response | null {
  const denied = requireStepUp(session, now);
  if (denied) return denied;
  if (typeof body.reason !== "string" || body.reason.trim() === "")
    return err(400, ErrorCode.BadRequest, "a reason is required", {
      reason: "reason_required",
    });
  if (body.confirm !== def.key)
    return err(400, ErrorCode.BadRequest, `type ${def.key} to confirm`, {
      reason: "confirm_required",
      level: "L2",
    });
  return null;
}

export async function handleProductSettings(
  req: Request,
  env: Env,
  db: Db,
  session: AdminSession,
  product: ProductRow,
  rest: string[],
  now: number,
  hooks?: ServiceHooks,
): Promise<Response> {
  const [segment, ...extra] = rest;
  if (!segment || extra.length > 0) return notFound();
  const services = parseServices(product.services_json).services;
  const r: Request_ = { env, db, product, now, hooks };
  const scope = {
    kind: "product",
    slug: product.slug,
    system: product.system === 1,
  } as const;

  if (segment === "effective") {
    if (req.method !== "GET")
      return err(405, ErrorCode.BadRequest, "method not allowed");
    const area = new URL(req.url).searchParams.get("area");
    // ST-29: only the keys whose area the caller holds on this product.
    const defs = servedSettings().filter(
      (d) =>
        (!area || d.area === area) &&
        can(session.principal, scope, d.rbacArea, "view"),
    );
    const views = await readViews(r, defs);
    const manifest = await snapshotManifest(db, product);
    const settings: ProductSettingDto[] = [];
    for (const v of views)
      settings.push(
        dto(
          v,
          services,
          manifest,
          await SETTINGS.adapter(v.def.key)?.blocked?.(adapterCtx(r)),
        ),
      );
    // An unset daily mail cap follows the platform default: say which number (B-035).
    for (const s of settings)
      if (s.key === PRODUCT_EMAIL_CAP_KEY && s.value === null)
        s.inherited = await productDailyEmailCap(env, db, product.slug);
    return adminJson({ settings });
  }

  // ST-17: the claims against the last applied manifest, and the plan the last apply recorded.
  if (segment === "drift") {
    if (req.method !== "GET")
      return err(405, ErrorCode.BadRequest, "method not allowed");
    const view = await driftView(
      { env, db, registry: SETTINGS },
      product,
      (await getProductSyncState(db, product.slug))?.plan_json,
      now,
    );
    // Only the keys whose area the caller holds, as `effective` does (ST-29). The last apply's
    // plan summarises every area (tiers, catalog, sign-in, release), so it goes only to a caller
    // who holds Settings, which owns the resync.
    return adminJson({
      ...view,
      items: view.items.filter((i) => {
        const d = SETTINGS.get(i.key, "product");
        return !d || can(session.principal, scope, d.rbacArea, "view");
      }),
      lastPlan: can(session.principal, scope, "settings", "view")
        ? view.lastPlan
        : null,
    });
  }

  // Registry keys are dotted lowerCamel words, which no URL encoding changes, so the raw segment
  // is the key (as `claims/<key>` reads it); anything else is simply not a registry key.
  const key = segment;
  const def = SETTINGS.get(key, "product");
  // A pending key is not listed, but a write names it and `writeSetting()` says why it is refused.
  if (!def || !served(def, true))
    return err(
      404,
      ErrorCode.BadRequest,
      `${key} is not a product setting this API serves`,
      {
        reason: "unknown_setting",
      },
    );
  const actor = {
    sub: session.sub,
    name: session.name ?? null,
    email: session.email ?? null,
  };
  const adapter: SettingAdapter | undefined = SETTINGS.adapter(def.key);

  if (req.method !== "GET" && !writable(def))
    return err(
      409,
      ErrorCode.BadRequest,
      `${def.key} is read here: it is edited where the console owns it`,
      { reason: "no_writer", key: def.key },
    );

  if (req.method === "GET") {
    if (!can(session.principal, scope, def.rbacArea, "view"))
      return err(403, ErrorCode.Forbidden, "no access", {
        reason: "no_access",
      });
    const [view] = await readViews(r, [def]);
    return adminJson({
      setting: dto(
        view!,
        services,
        await snapshotManifest(db, product),
        await adapter?.blocked?.(adapterCtx(r)),
      ),
    });
  }

  if (req.method === "PATCH") {
    const body = await readBody(req);
    if (!("value" in body))
      return err(422, ErrorCode.BadRequest, "value is required", {
        reason: "invalid_value",
        fields: ["value"],
      });
    if (adapter?.validate) {
      const bad = await adapter.validate(body.value, adapterCtx(r));
      if (bad) return valueRefusal(def, bad.message, bad.fields);
    }
    if (adapter?.relaxes) {
      const [now_] = await readViews(r, [def]);
      if (adapter.relaxes(now_?.value ?? null, body.value)) {
        // The relax is judged against the value read here, so it is tied to the version it read:
        // a racing request that tightened in between must not be undone without a step-up.
        if (
          body.expectedVersion !== undefined &&
          body.expectedVersion !== now_?.version
        )
          return staleRelax(r, def, now_!);
        const gate = relaxGate(session, def, body, now);
        if (gate) return gate;
      }
    }
    await adapter?.beforeWrite?.(adapterCtx(r));
    const before = adapter?.audit ? (await readViews(r, [def]))[0] : undefined;
    const audit = adapter?.audit?.({
      op: "set",
      slug: product.slug,
      before: before?.value ?? null,
      after: body.value,
    });
    if (isRowServed(def)) {
      const res = await writeRowSetting(
        { env, db, registry: SETTINGS },
        product,
        def,
        {
          value: body.value,
          expectedVersion: body.expectedVersion,
          reason: body.reason,
          // ST-20: a manifest-authoritative product takes a break-glass claim only.
          breakGlass: body.breakGlass,
          ...(audit ? { audit } : {}),
          // The bespoke routes an adapter replaced never asked for a reason (the trust policy's
          // relaxing change does, in `relaxGate`); a console page for one has no field for it yet.
          requireReason: adapter === undefined,
        },
        actor,
        now,
        session.principal,
      );
      if (!res.ok) return refusal(res, product);
      return adminJson({
        ok: true,
        claimed: res.claimed,
        setting: dto(
          inForceOf(res.view),
          services,
          await snapshotManifest(db, product),
        ),
      });
    }
    const res = await writeSetting(
      { env, db, registry: SETTINGS },
      {
        key: def.key,
        value: body.value,
        expectedVersion: body.expectedVersion as number | undefined,
        reason: (typeof body.reason === "string"
          ? body.reason.trim()
          : body.reason) as string | null | undefined,
        ...(audit ? { audit } : {}),
        ...(def.storage.kind === "rich" && adapter?.set
          ? {
              statements: (guard) =>
                adapter.set!({
                  value: body.value,
                  ctx: adapterCtx(r),
                  guard,
                }),
            }
          : {}),
      },
      {
        actor,
        origin: "console",
        principal: session.principal,
        now,
        product,
        // The typed confirmation is the console's own dialog (or `relaxGate` above); the version
        // and a critical key's reason are `writeSetting()`'s own checks.
        strict: false,
        requireVersion: true,
        // As the row path above: an adapter-backed key keeps its bespoke route's contract, which
        // took a reason when the caller had one and required none.
        requireReason: adapter === undefined,
        breakGlass: body.breakGlass,
      },
    );
    if (!res.ok) return writeRefusal(r, def, res);
    return adminJson({
      ok: true,
      claimed: res.written[0]?.claimed === true,
      setting: dto(
        (await readViews(await afterWrite(r), [def]))[0]!,
        services,
        await snapshotManifest(db, product),
      ),
    });
  }

  if (req.method === "DELETE") {
    const body = await readBody(req);
    if (adapter?.relaxes) {
      const [now_] = await readViews(r, [def]);
      if (adapter.relaxes(now_?.value ?? null, undefined)) {
        if (
          body.expectedVersion !== undefined &&
          body.expectedVersion !== now_?.version
        )
          return staleRelax(r, def, now_!);
        const gate = relaxGate(session, def, body, now);
        if (gate) return gate;
      }
    }
    await adapter?.beforeWrite?.(adapterCtx(r));
    const before = (await readViews(r, [def]))[0]!;
    const audit = adapter?.audit?.({
      op: "reset",
      slug: product.slug,
      before: before.value,
      after: null,
    });
    if (isRowServed(def)) {
      const res = await revertRowSetting(
        { env, db, registry: SETTINGS },
        product,
        def,
        { expectedVersion: body.expectedVersion, ...(audit ? { audit } : {}) },
        actor,
        now,
        session.principal,
      );
      if (!res.ok) return refusal(res, product);
      return adminJson({
        ok: true,
        applied: res.applied,
        ...(res.applied ? {} : { message: res.message }),
        setting: dto(
          inForceOf(res.view),
          services,
          await snapshotManifest(db, product),
        ),
      });
    }
    // Revert (or reset) a column-backed or rich key. A claimable key must be claimed; an
    // operator-owned one resets to its default whatever it holds.
    if (def.ownership === "claimable" && before.source !== "console")
      return err(
        409,
        ErrorCode.BadRequest,
        `${def.key} is not claimed: it already follows the manifest`,
        { reason: "not_claimed" },
      );
    const columnAdapter =
      def.storage.kind === "column"
        ? SETTINGS.columnAdapter(def.key)
        : undefined;
    // With a snapshot, the manifest's value goes back at once, for a key that has no ownership
    // marker to flip; a marker key (`services_source`, `compat_source`, …) hands the field back and
    // the next resync applies it.
    const snapshot = claimsApply(product)
      ? await getManifestSnapshot(db, product.slug)
      : null;
    const declared = snapshot
      ? snapshotValue(def.key, tryParseJson(snapshot.manifest_json), def)
      : undefined;
    const restore =
      declared !== undefined && !columnAdapter?.marker ? declared : undefined;
    const follows = claimsApply(product) && def.ownership === "claimable";
    // A key with an ownership marker hands the field back and keeps its value until the next
    // resync, whatever the product follows.
    const applied = columnAdapter?.marker
      ? false
      : !follows || restore !== undefined;
    const res = await writeSetting(
      { env, db, registry: SETTINGS },
      {
        key: def.key,
        op: "reset",
        expectedVersion: body.expectedVersion as number | undefined,
        reason: (typeof body.reason === "string"
          ? body.reason.trim()
          : body.reason) as string | null | undefined,
        ...(restore !== undefined ? { restore } : {}),
        ...(audit ? { audit } : {}),
        ...(def.storage.kind === "rich" && adapter?.reset
          ? {
              statements: (guard) =>
                adapter.reset!({ ctx: adapterCtx(r), guard }),
            }
          : {}),
      },
      {
        actor,
        origin: "revert",
        principal: session.principal,
        now,
        product,
        strict: false,
        requireVersion: true,
      },
    );
    if (!res.ok) return writeRefusal(r, def, res);
    return adminJson({
      ok: true,
      applied,
      ...(applied ? {} : { message: NEXT_RESYNC }),
      setting: dto(
        (await readViews(await afterWrite(r), [def]))[0]!,
        services,
        await snapshotManifest(db, product),
      ),
    });
  }

  return err(405, ErrorCode.BadRequest, "method not allowed");
}
