/**
 * Package-feed settings (F-03, plans/F-01.md §6.3, §6.4) — Distribution's tables
 * `dist_registry_owners` (the owner's operator-owned `packageFeeds` sub-capability),
 * `dist_registry_feeds` (one feed per owner and ecosystem) and `dist_registry_policy` (the
 * platform's per-ecosystem kill switch and ceiling).
 *
 * Read by the `delivery.packageFeed` hook (Release's package ingest: namespace, size ceiling,
 * Swift signing), written by the `packageFeeds` toggle (`PUT …/distribution/package-feeds`) and
 * by the system-product bootstrap. The per-feed settings routes and the console are F-11's; the
 * registry host that serves the feeds is F-02's. A manifest never writes any of these.
 */

import {
  isPackageEcosystem,
  type PackageEcosystem,
} from "@polaris-key/manifest";
import type { PackageFeedSettings } from "../../core/hooks.js";
import type { Db, DbStatement } from "../../core/platform.js";

function parseObject(json: string | null | undefined): Record<string, unknown> {
  if (!json) return {};
  try {
    const v: unknown = JSON.parse(json);
    return v && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** One ecosystem's feed of `product`, under the owner switch and the platform policy. */
export async function packageFeedOf(
  db: Db,
  product: string,
  ecosystem: string,
): Promise<PackageFeedSettings | null> {
  if (!isPackageEcosystem(ecosystem)) return null;
  const row = await db.first<{
    enabled: number;
    namespace_json: string;
    max_package_bytes: number;
    ext_json: string;
    owner_enabled: number | null;
    policy_enabled: number | null;
    ceiling: number | null;
  }>(
    `SELECT f.enabled, f.namespace_json, f.max_package_bytes, f.ext_json,
            o.enabled AS owner_enabled, p.enabled AS policy_enabled,
            p.max_package_bytes_ceiling AS ceiling
       FROM dist_registry_feeds f
       LEFT JOIN dist_registry_owners o ON o.product = f.product
       LEFT JOIN dist_registry_policy p ON p.ecosystem = f.ecosystem
      WHERE f.product = ? AND f.ecosystem = ?`,
    product,
    ecosystem,
  );
  if (!row) return null;
  return {
    ecosystem,
    enabled: row.enabled === 1,
    ownerEnabled: row.owner_enabled === 1,
    // A missing policy row is a closed switch (fail closed), as is a disabled one.
    policyEnabled: row.policy_enabled === 1,
    namespace: parseObject(row.namespace_json),
    maxPackageBytes:
      row.ceiling === null ? 0 : Math.min(row.max_package_bytes, row.ceiling),
    ext: parseObject(row.ext_json),
  };
}

/** The owner's `packageFeeds` row, or the default (off, version 0 = never written). */
export async function packageFeedsOf(
  db: Db,
  product: string,
): Promise<{ enabled: boolean; version: number; updatedAt: number | null }> {
  const row = await db.first<{
    enabled: number;
    version: number;
    updated_at: number;
  }>(
    "SELECT enabled, version, updated_at FROM dist_registry_owners WHERE product = ?",
    product,
  );
  return row
    ? {
        enabled: row.enabled === 1,
        version: row.version,
        updatedAt: row.updated_at,
      }
    : { enabled: false, version: 0, updatedAt: null };
}

/**
 * Set the owner's `packageFeeds` switch, only if its version is still `expectedVersion` (0 for a
 * row never written). Answers the statement; the caller reads the outcome back (`changes`).
 */
export function stmtSetPackageFeeds(
  product: string,
  enabled: boolean,
  expectedVersion: number,
  by: string,
  now: number,
): DbStatement {
  return {
    sql: `INSERT INTO dist_registry_owners (product, enabled, version, updated_at, updated_by)
          SELECT ?, ?, 1, ?, ?
           WHERE ? = 0
             AND NOT EXISTS (SELECT 1 FROM dist_registry_owners WHERE product = ?)
          ON CONFLICT(product) DO NOTHING`,
    params: [product, enabled ? 1 : 0, now, by, expectedVersion, product],
  };
}

/** The UPDATE half of {@link stmtSetPackageFeeds}: an existing row at `expectedVersion`. */
export function stmtUpdatePackageFeeds(
  product: string,
  enabled: boolean,
  expectedVersion: number,
  by: string,
  now: number,
): DbStatement {
  return {
    sql: `UPDATE dist_registry_owners
             SET enabled = ?, version = version + 1, updated_at = ?, updated_by = ?
           WHERE product = ? AND version = ?`,
    params: [enabled ? 1 : 0, now, by, product, expectedVersion],
  };
}

/**
 * A feed row with these settings unless one exists (the bootstrap: never overwrites an operator's
 * settings). The size ceiling starts at the platform's.
 */
export function stmtEnsureFeed(
  product: string,
  ecosystem: PackageEcosystem,
  namespace: Record<string, unknown>,
  ext: Record<string, unknown>,
  by: string,
  now: number,
): DbStatement {
  return {
    sql: `INSERT INTO dist_registry_feeds
            (product, ecosystem, enabled, access_mode, namespace_json, max_package_bytes,
             upstream, claims_json, ext_json, version, updated_at, updated_by)
          SELECT ?, ?, 1, 'public', ?,
                 COALESCE((SELECT max_package_bytes_ceiling FROM dist_registry_policy
                            WHERE ecosystem = ?), 52428800),
                 'none', '[]', ?, 1, ?, ?
          ON CONFLICT(product, ecosystem) DO NOTHING`,
    params: [
      product,
      ecosystem,
      JSON.stringify(namespace),
      ecosystem,
      JSON.stringify(ext),
      now,
      by,
    ],
  };
}
