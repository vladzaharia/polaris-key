/**
 * LX-07: offline grace clamped to licence expiry (S-19 G9 and §7.6, decision 7).
 *
 * A licence expiring tomorrow with a 30-day offline window used to keep an offline install
 * running for 30 days. With the product's `licensing.clampGraceToExpiry` on (the registry default,
 * `services/license/licensingSettings.ts`; a per-product opt-out), every document a licence
 * grants ends its offline window no later than the licence's `expires_at`:
 *
 *   graceUntil = min(issuedAt + maxOfflineDays × 86 400, max(expires_at, expiresAt))
 *
 * The `max(…, expiresAt)` floor exists because every verifier refuses `graceUntil < expiresAt`
 * (WIRE-CONTRACT-V4 §3, always enforced); see `clampGraceUntil` in `core/documents.ts`. No
 * claim is added and no shape changes: `graceUntil` only gets an earlier value, which §3.6 says
 * it may.
 *
 * Which documents: everything a licence grants a device. The licence document
 * (`/license/document`); the config document of a device bound to a licence on a product that
 * runs License (R1 in `services/config/document.ts`: its secrets stop with the licence, so its
 * window does too); the offline bundle's inner documents (`core/bundles.ts`), where the operator's
 * `graceDays` is the window; and Identity's fused browser-session document. A config-only
 * product and a keyless device have no licence and are never clamped.
 *
 * Not clamped: a grant's expiry (S-19 §7.6: that would end base access offline; LX-12 owns
 * grant terms). A perpetual licence (`expires_at` NULL) is never affected.
 *
 * Cost: the setting is read only when the clamp would change the window, so a perpetual licence
 * and a licence whose expiry lies past its window cost no read on the document routes.
 *
 * The affected-licence report (`graceClampReport`, below) lists, per product, every usable
 * licence whose window the clamp shortens, with the product's clamp state. The owner runs it on a
 * production copy before the release that turns the clamp on (RUNBOOK "Offline grace clamp",
 * `scripts/grace-clamp-report.ts`); LX-09's holder report reuses it (S-19 §7.3.4).
 */

import type { Db } from "../db/types.js";
import type { LicenseRow } from "./data.js";
import { clampGraceUntil, offlineWindowEnd } from "./documents.js";
import type { SettingsEnv } from "./platformSettings.js";
import { parseServices } from "./services.js";
import type { SettingsRegistry } from "./settings/registry.js";
import { resolveProductSetting } from "./settings/resolve.js";
import type { SettingSource } from "./settings/types.js";

/** The product setting that turns the clamp on (default) or off (S-19 §7.13). */
export const CLAMP_GRACE_SETTING = "licensing.clampGraceToExpiry";

export interface GraceClampContext {
  env: SettingsEnv;
  db: Db;
  /** ST-04's registry (`ServiceContext.settings`); absent on a context built by hand. */
  registry?: SettingsRegistry;
}

/** Whether `product` clamps, and which layer decided it. */
export interface GraceClampState {
  on: boolean;
  source: SettingSource;
}

/**
 * The product's `licensing.clampGraceToExpiry`, resolved (ST-04): a console claim (an expired
 * break-glass claim is none), else the manifest, else the default (on). A context without the
 * registry reads the stored row the same way. Anything but `false` reads on: an unknown product or
 * an unreadable value keeps the shorter, safer window.
 */
export async function graceClampState(
  ctx: GraceClampContext,
  product: string,
  now: number,
): Promise<GraceClampState> {
  if (ctx.registry?.get(CLAMP_GRACE_SETTING, "product")) {
    const r = await resolveProductSetting(
      { env: ctx.env, db: ctx.db, registry: ctx.registry },
      product,
      CLAMP_GRACE_SETTING,
      { now },
    );
    return { on: r?.value !== false, source: r?.source ?? "default" };
  }
  const row = await ctx.db.first<{
    value_json: string | null;
    source: string;
    expires_at: number | null;
  }>(
    "SELECT value_json, source, expires_at FROM product_settings WHERE product = ? AND key = ?",
    product,
    CLAMP_GRACE_SETTING,
  );
  if (
    !row ||
    row.value_json === null ||
    (row.expires_at !== null && row.expires_at <= now)
  )
    return { on: true, source: "default" };
  let value: unknown;
  try {
    value = JSON.parse(row.value_json);
  } catch {
    return { on: true, source: "default" };
  }
  return {
    on: value !== false,
    source: row.source === "console" ? "console" : "manifest",
  };
}

/**
 * The instant a document issued at `now` for `license` may not outlast (its `expires_at`), or
 * `null` for no clamp: no licence, a perpetual one, an expiry the clamp would not move the window
 * for, or a product that opted out. Pass the result to the builders' `clampGraceTo`.
 */
export async function graceClampFor(
  ctx: GraceClampContext,
  product: string,
  license: Pick<LicenseRow, "expires_at"> | null | undefined,
  now: number,
  maxOfflineDays: number,
): Promise<number | null> {
  const expiresAt = license?.expires_at;
  if (expiresAt === null || expiresAt === undefined) return null;
  const windowEnd = offlineWindowEnd(now, maxOfflineDays);
  if (clampGraceUntil(windowEnd, now, expiresAt) === windowEnd) return null;
  return (await graceClampState(ctx, product, now)).on ? expiresAt : null;
}

// ── The affected-licence report ─────────────────────────────────────────────────────────────

/** One licence whose offline window the clamp shortens. */
export interface GraceClampLicence {
  licenseId: string;
  tierId: string | null;
  /** The licence's expiry (epoch seconds). */
  expiresAt: number;
  /** The licence's own offline days, else the product default. */
  maxOfflineDays: number;
  /** `graceUntil` of a document issued at the report's `now` without the clamp. */
  windowEnd: number;
  /** The same document's `graceUntil` with the clamp. */
  clampedTo: number;
  /** Whole and partial offline days the clamp removes from that document. */
  daysRemoved: number;
  /** Devices currently authorised on the licence (the installs that see the shorter window). */
  authorizedDevices: number;
}

export interface GraceClampProductReport {
  product: string;
  /** The License service is on for the product (with it off, no licence document is served). */
  licenseService: boolean;
  clamp: GraceClampState;
  licences: GraceClampLicence[];
}

export interface GraceClampReport {
  /** The instant the windows were computed for (epoch seconds). */
  now: number;
  /** Products with at least one affected licence, by slug. */
  products: GraceClampProductReport[];
  totals: {
    products: number;
    licences: number;
    authorizedDevices: number;
    /** Of those, on products whose clamp is on (the ones the release changes). */
    clampedLicences: number;
  };
}

interface ReportRow {
  product: string;
  id: string;
  tier_id: string | null;
  expires_at: number;
  max_offline_days: number;
  services_json: string | null;
  devices: number;
}

/**
 * Every usable licence (active, not past `expires_at`) whose offline window, for a document issued
 * at `now`, the clamp shortens, grouped by product with the product's clamp state. Read-only.
 * Computed with the builders' own arithmetic (`offlineWindowEnd`, `clampGraceUntil`), so the
 * report and the documents cannot disagree. Lists licence ids, tiers and counts only: no name,
 * email or key.
 */
export async function graceClampReport(
  ctx: GraceClampContext,
  opts: { now: number; product?: string },
): Promise<GraceClampReport> {
  const { now } = opts;
  const rows = await ctx.db.all<ReportRow>(
    `SELECT l.product, l.id, l.tier_id, l.expires_at,
            COALESCE(l.max_offline_days, p.default_max_offline_days) AS max_offline_days,
            p.services_json,
            (SELECT COUNT(*) FROM devices d
              WHERE d.product = l.product AND d.license_id = l.id AND d.status = 'authorized') AS devices
       FROM licenses l JOIN products p ON p.slug = l.product
      WHERE l.status = 'active' AND l.expires_at IS NOT NULL AND l.expires_at >= ?
        ${opts.product !== undefined ? "AND l.product = ?" : ""}
      ORDER BY l.product, l.expires_at, l.id`,
    now,
    ...(opts.product !== undefined ? [opts.product] : []),
  );

  const byProduct = new Map<string, GraceClampProductReport>();
  for (const r of rows) {
    const windowEnd = offlineWindowEnd(now, r.max_offline_days);
    const clampedTo = clampGraceUntil(windowEnd, now, r.expires_at);
    if (clampedTo >= windowEnd) continue;
    let entry = byProduct.get(r.product);
    if (!entry) {
      entry = {
        product: r.product,
        licenseService: parseServices(r.services_json).services.license.enabled,
        clamp: await graceClampState(ctx, r.product, now),
        licences: [],
      };
      byProduct.set(r.product, entry);
    }
    entry.licences.push({
      licenseId: r.id,
      tierId: r.tier_id,
      expiresAt: r.expires_at,
      maxOfflineDays: r.max_offline_days,
      windowEnd,
      clampedTo,
      daysRemoved: Math.round(((windowEnd - clampedTo) / 86_400) * 100) / 100,
      authorizedDevices: Number(r.devices),
    });
  }

  const products = [...byProduct.values()];
  const all = products.flatMap((p) => p.licences);
  return {
    now,
    products,
    totals: {
      products: products.length,
      licences: all.length,
      authorizedDevices: all.reduce((n, l) => n + l.authorizedDevices, 0),
      clampedLicences: products
        .filter((p) => p.clamp.on && p.licenseService)
        .reduce((n, p) => n + p.licences.length, 0),
    },
  };
}

/** The report as CSV, one row per affected licence (times as ISO 8601, UTC). */
export function graceClampReportCsv(report: GraceClampReport): string {
  const iso = (s: number) => new Date(s * 1000).toISOString();
  const lines = [
    "product,licenseService,clamp,clampSource,licenseId,tierId,expiresAt,maxOfflineDays,windowEnd,clampedTo,daysRemoved,authorizedDevices",
  ];
  for (const p of report.products)
    for (const l of p.licences)
      lines.push(
        [
          p.product,
          p.licenseService ? "on" : "off",
          p.clamp.on ? "on" : "off",
          p.clamp.source,
          l.licenseId,
          l.tierId ?? "",
          iso(l.expiresAt),
          String(l.maxOfflineDays),
          iso(l.windowEnd),
          iso(l.clampedTo),
          String(l.daysRemoved),
          String(l.authorizedDevices),
        ]
          .map(csvCell)
          .join(","),
      );
  return `${lines.join("\n")}\n`;
}

/** RFC 4180 quoting, and a leading `=`, `+`, `-` or `@` neutralised against formula injection. */
function csvCell(v: string): string {
  const safe = /^[=+\-@]/.test(v) ? `'${v}` : v;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}
