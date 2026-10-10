/**
 * The product settings admin API, first slice (LX-06; notes/S-18 §4.7, rule 10):
 *
 *   GET    /manage/api/products/<slug>/settings/effective[?area=<area>]
 *   PATCH  /manage/api/products/<slug>/settings/<key>   { value, expectedVersion, reason? }
 *   DELETE /manage/api/products/<slug>/settings/<key>   { expectedVersion }
 *
 * `expectedVersion` is required on both, as on platform settings (`platformSettings.ts`): the row
 * version the console read, 0 when there was no row. `writeSetting()` checks it.
 *
 * The paths and bodies are S-18 §4.7's generic ones, so nothing here needs an alias later. This
 * slice serves the ROW-BACKED claimable settings only (`core/rowSettings.ts`: `licensing.*` and
 * `identity.oidc.syncTierOnSignIn` today); any other registry key answers 404 `unknown_setting`.
 * ST-05 widens the same routes to every key (column-backed, rich, platform) and adds the
 * history, as-of, restore, drift and export routes; ST-04's resolver and `writeSetting()` replace
 * the read and write underneath.
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
  isRowBacked,
  manifestValueAt,
  readRowSettings,
  revertRowSetting,
  writeRowSetting,
  type RowSettingRefusal,
  type RowSettingView,
} from "../../core/rowSettings.js";
import { getManifestSnapshot } from "../../core/manifestSnapshot.js";
import { claimsApply } from "../../core/settingsClaims.js";
import type { SettingDef } from "../../core/settings/types.js";
import { SETTINGS } from "../../mount.js";
import type { AdminSession } from "../../core/console/session.js";
import { can } from "../authz.js";
import {
  adminJson,
  err,
  notFound,
  readBody,
} from "../../core/console/respond.js";

/** The settings this slice serves: live, row-backed, claimable product entries. */
export function rowBackedSettings(): SettingDef[] {
  return SETTINGS.entries.filter((d) => isRowBacked(d) && !d.pending);
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
  value: unknown;
  source: RowSettingView["source"];
  defaultValue: unknown;
  /** What the last applied manifest declares (Revert's target), when it declares it. */
  manifestValue?: unknown;
  version: number;
  updatedAt: number | null;
  updatedBy: string | null;
  reason: string | null;
}

function dto(
  view: RowSettingView,
  services: Record<string, { enabled: boolean } | undefined>,
  manifest: unknown,
): ProductSettingDto {
  const d = view.def;
  const declared =
    manifest === undefined ? undefined : manifestValueAt(manifest, d);
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
    value: view.value,
    source: view.source,
    defaultValue: view.defaultValue,
    ...(declared !== undefined ? { manifestValue: declared } : {}),
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
  return err(r.status, r.status === 403 ? ErrorCode.Forbidden : ErrorCode.BadRequest, r.message, {
    reason: r.reason,
    ...(r.current
      ? {
          current: dto(
            r.current,
            parseServices(product.services_json).services,
            undefined,
          ),
        }
      : {}),
  });
}

export async function handleProductSettings(
  req: Request,
  env: Env,
  db: Db,
  session: AdminSession,
  product: ProductRow,
  rest: string[],
  now: number,
): Promise<Response> {
  const [segment, ...extra] = rest;
  if (!segment || extra.length > 0) return notFound();
  const services = parseServices(product.services_json).services;

  if (segment === "effective") {
    if (req.method !== "GET")
      return err(405, ErrorCode.BadRequest, "method not allowed");
    const area = new URL(req.url).searchParams.get("area");
    // ST-29: only the keys whose area the caller holds on this product.
    const scope = {
      kind: "product",
      slug: product.slug,
      system: product.system === 1,
    } as const;
    const defs = rowBackedSettings().filter(
      (d) =>
        (!area || d.area === area) &&
        can(session.principal, scope, d.rbacArea, "view"),
    );
    const views = await readRowSettings(db, product, defs, now);
    const manifest = await snapshotManifest(db, product);
    return adminJson({
      settings: views.map((v) => dto(v, services, manifest)),
    });
  }

  // Registry keys are dotted lowerCamel words, which no URL encoding changes, so the raw segment
  // is the key (as `claims/<key>` reads it); anything else is simply not a registry key.
  const key = segment;
  const def = SETTINGS.get(key, "product");
  if (!def || !isRowBacked(def))
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

  if (req.method === "PATCH") {
    const body = await readBody(req);
    if (!("value" in body))
      return err(422, ErrorCode.BadRequest, "value is required", {
        reason: "invalid_value",
        fields: ["value"],
      });
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
      },
      actor,
      now,
      session.principal,
    );
    if (!res.ok) return refusal(res, product);
    return adminJson({
      ok: true,
      claimed: res.claimed,
      setting: dto(res.view, services, await snapshotManifest(db, product)),
    });
  }

  if (req.method === "DELETE") {
    const body = await readBody(req);
    const res = await revertRowSetting(
      { env, db, registry: SETTINGS },
      product,
      def,
      { expectedVersion: body.expectedVersion },
      actor,
      now,
      session.principal,
    );
    if (!res.ok) return refusal(res, product);
    return adminJson({
      ok: true,
      applied: res.applied,
      ...(res.applied ? {} : { message: res.message }),
      setting: dto(res.view, services, await snapshotManifest(db, product)),
    });
  }

  return err(405, ErrorCode.BadRequest, "method not allowed");
}
