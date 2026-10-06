/**
 * Core's column adapters (ST-04, notes/S-18 §4.3): how each column-backed setting stored in a
 * table Core owns is decoded by the resolver and written by `writeSetting()`.
 *
 * Column-backed is PERMANENT for these keys: the device hot paths keep reading `products.*` (and
 * the storefront columns) exactly as before, so nothing here is on a hot path. The adapters exist
 * so the one write path can store a value without each handler issuing its own `UPDATE`, which
 * `test/settings-writes.test.ts` now refuses. A service's own tables are adapted in that service
 * (`services/release/settingsColumns.ts`), contributed through its slice.
 *
 * Every statement ANDs the write's guard (`ColumnWriteArgs.guard`) into its `WHERE`, so a refused
 * batch writes nothing (`write.ts`). The legacy ownership markers (`services_source`,
 * `compat_source`, `fingerprint_policy_source`, `auto_issue_source`, `trust_policy_source`) are
 * kept and mapped, never rewritten (S-18 §4.3): a console write sets their console spelling, a
 * reset flips them back, and the resync's own `WHERE … = 'manifest'` guard is unchanged.
 */

import type { DbStatement } from "../../db/types.js";
import { parseAutoIssue, parseFingerprintPolicy } from "../fingerprint.js";
import { parseWebOrigins, serializeWebOrigins } from "../cors.js";
import { parseTrustPolicy } from "../deviceTrust.js";
import { parseServices, serializeServices } from "../services.js";
import {
  resolveListing,
  type ListingColumns,
} from "../storefront/polarisKeyListing.js";
import type {
  ColumnWriteArgs,
  SettingColumnAdapter,
  SqlGuard,
} from "./types.js";

type Row = Readonly<Record<string, unknown>> | null;

/** `NULL | manifest | import | default → manifest`, `admin → console` (S-18 §4.3). */
export function legacyMarker(raw: unknown): "manifest" | "console" {
  return raw === "admin" ? "console" : "manifest";
}

/** `UPDATE products SET <sets>, modified_at = ? WHERE slug = ? AND <guard>`. */
function updateProductColumns(
  { product, at, guard }: ColumnWriteArgs,
  sets: readonly [column: string, value: string | number | null][],
): DbStatement[] {
  return [
    {
      sql: `UPDATE products SET ${[...sets.map(([c]) => `${c} = ?`), "modified_at = ?"].join(", ")}
             WHERE slug = ? AND (${guard.sql})`,
      params: [...sets.map(([, v]) => v), at, product, ...guard.params],
    },
  ];
}

function text(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function int(v: unknown): number | undefined {
  return typeof v === "number" && Number.isSafeInteger(v) ? v : undefined;
}

function jsonOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : JSON.stringify(value);
}

/** A plain `products` column holding a scalar value. */
function productScalar(
  column: string,
  decode: (v: unknown) => unknown,
): SettingColumnAdapter {
  return {
    table: "products",
    keyColumn: "slug",
    columns: [column],
    decode: (row) => (row ? decode(row[column]) : undefined),
    set: (args) =>
      updateProductColumns(args, [[column, args.value as string | number | null]]),
  };
}

/** A `products` JSON column with a legacy `*_source` marker (`'admin'` = the console's). */
function productClaimedJson(
  column: string,
  markerColumn: string,
  decode: (raw: string) => unknown,
  encode: (value: unknown) => string | null = jsonOrNull,
): SettingColumnAdapter {
  return {
    table: "products",
    keyColumn: "slug",
    columns: [column, markerColumn],
    decode: (row) => {
      const raw = row?.[column];
      return typeof raw === "string" && raw !== "" ? decode(raw) : undefined;
    },
    marker: (row) => legacyMarker(row?.[markerColumn]),
    set: (args) =>
      updateProductColumns(args, [
        [column, encode(args.value)],
        [markerColumn, "admin"],
      ]),
    // Only the owner flips: the stored value stays as the operator left it until the next resync
    // re-applies the manifest (the `revert…ToManifest` contract these replace).
    reset: (args) => updateProductColumns(args, [[markerColumn, "manifest"]]),
  };
}

/**
 * An upsert into `portal_product_settings` (the storefront listing columns PS-02 placed beside
 * `discover_enabled`): the row may not exist yet, and every other column takes its default.
 */
function upsertStorefront(
  { product, at, guard }: ColumnWriteArgs,
  sets: readonly [column: string, value: string | number | null][],
): DbStatement[] {
  const cols = sets.map(([c]) => c);
  return [
    {
      sql: `INSERT INTO portal_product_settings (product, ${cols.join(", ")}, created_at, modified_at)
            SELECT ?, ${cols.map(() => "?").join(", ")}, ?, ? WHERE (${guard.sql})
            ON CONFLICT(product) DO UPDATE SET
              ${[...cols.map((c) => `${c} = excluded.${c}`), "modified_at = excluded.modified_at"].join(", ")}`,
      params: [product, ...sets.map(([, v]) => v), at, at, ...guard.params],
    },
  ];
}

const STOREFRONT_COLUMNS = [
  "store_listed",
  "store_audience",
  "store_offer_paths_json",
  "store_group_labels_json",
  "discover_enabled",
] as const;

function listing(row: Row) {
  return row ? resolveListing(row as unknown as ListingColumns) : null;
}

function storefront(
  decode: (row: NonNullable<Row>) => unknown,
  set: (value: unknown) => [string, string | number | null][],
): SettingColumnAdapter {
  return {
    table: "portal_product_settings",
    keyColumn: "product",
    columns: STOREFRONT_COLUMNS,
    decode: (row) => (row ? decode(row) : undefined),
    set: (args) => upsertStorefront(args, set(args.value)),
  };
}

/** Core's adapters, keyed by registry key. */
export const CORE_COLUMN_ADAPTERS: Readonly<
  Record<string, SettingColumnAdapter>
> = {
  "core.name": productScalar("name", text),
  "core.adminGroup": productScalar("admin_group", (v) =>
    typeof v === "string" && v !== "" ? v : undefined,
  ),
  "core.web.origins": {
    table: "products",
    keyColumn: "slug",
    columns: ["web_origins_json"],
    decode: (row) => {
      const raw = row?.web_origins_json;
      return typeof raw === "string" ? parseWebOrigins(raw) : undefined;
    },
    set: (args) =>
      updateProductColumns(args, [
        ["web_origins_json", serializeWebOrigins(args.value as string[])],
      ]),
  },
  // The stored shape is `serializeServices`' (every slug, then `registration`, then a newer
  // build's unknown slugs), so a value round-trips through the same parser the router reads.
  "core.services": productClaimedJson(
    "services_json",
    "services_source",
    (raw) => JSON.parse(serializeServices(parseServices(raw))) as unknown,
    (value) => serializeServices(parseServices(JSON.stringify(value))),
  ),
  "core.trustPolicy": {
    table: "products",
    keyColumn: "slug",
    columns: ["trust_policy_json", "trust_policy_source"],
    decode: (row) => {
      const raw = row?.trust_policy_json;
      return typeof raw === "string" && raw !== ""
        ? parseTrustPolicy(raw)
        : undefined;
    },
    // Operator-owned (`default | admin`): there is no manifest to map to.
    marker: (row) =>
      row?.trust_policy_source === "admin" ? "console" : "default",
    set: (args) =>
      updateProductColumns(args, [
        ["trust_policy_json", jsonOrNull(args.value)],
        ["trust_policy_source", args.value === null ? "default" : "admin"],
      ]),
    reset: (args) =>
      updateProductColumns(args, [
        ["trust_policy_json", null],
        ["trust_policy_source", "default"],
      ]),
  },
  "license.defaults.deviceLimit": productScalar("default_device_limit", int),
  "license.defaults.maxOfflineDays": productScalar(
    "default_max_offline_days",
    int,
  ),
  "license.fingerprint": productClaimedJson(
    "fingerprint_policy_json",
    "fingerprint_policy_source",
    (raw) => parseFingerprintPolicy(raw),
  ),
  "license.autoIssue": productClaimedJson(
    "auto_issue_json",
    "auto_issue_source",
    (raw) => parseAutoIssue(raw),
  ),
  // One value over two columns: `{ min, max }`, each a semver string or null.
  "release.compatWindow": {
    table: "products",
    keyColumn: "slug",
    columns: ["compat_min", "compat_max", "compat_source"],
    decode: (row) =>
      row ? { min: row.compat_min ?? null, max: row.compat_max ?? null } : undefined,
    marker: (row) => legacyMarker(row?.compat_source),
    set: (args) => {
      const v = (args.value ?? {}) as { min?: unknown; max?: unknown };
      return updateProductColumns(args, [
        ["compat_min", (v.min as string | null | undefined) ?? null],
        ["compat_max", (v.max as string | null | undefined) ?? null],
        ["compat_source", "admin"],
      ]);
    },
    reset: (args) => updateProductColumns(args, [["compat_source", "manifest"]]),
  },

  // ── The Polaris Key storefront (PS-02), Core's columns on `portal_product_settings` ──────
  // `discover_enabled` stays in step with the listing state until PS-11 (0 exactly when
  // `unlisted`), so a Worker still reading it agrees; the decode is the same dual-read.
  "storefront.polarisKey.listed": storefront(
    (row) => listing(row)!.listed,
    (v) => [
      ["store_listed", v as string],
      ["discover_enabled", v === "unlisted" ? 0 : 1],
    ],
  ),
  "storefront.polarisKey.audience": storefront(
    (row) => listing(row)!.audience,
    (v) => [["store_audience", v as string]],
  ),
  "storefront.polarisKey.offerPaths": storefront(
    (row) => {
      const l = listing(row)!;
      return l.offerPathsAll ? undefined : [...l.offerPaths];
    },
    (v) => [["store_offer_paths_json", jsonOrNull(v)]],
  ),
  "storefront.polarisKey.groupLabels": storefront(
    (row) => {
      const labels = listing(row)!.groupLabels;
      return Object.keys(labels).length > 0 ? { ...labels } : undefined;
    },
    (v) => [
      [
        "store_group_labels_json",
        v && typeof v === "object" && Object.keys(v).length > 0
          ? JSON.stringify(v)
          : null,
      ],
    ],
  ),
};

/** The always-true guard, for a write nothing conditions. */
export const NO_GUARD: SqlGuard = { sql: "1", params: [] };
