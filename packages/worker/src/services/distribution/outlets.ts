/**
 * Distribution's outlets and transports (P2b-02, README §3.8): `dist_outlets` and
 * `dist_transports` — what `.pkey/distribution` declares, applied on link and resync through this
 * service's `manifestIngest` hook (Core's `manifestIngestStatements`, in the ingest batch).
 *
 * ── WHO OWNS WHICH COLUMN ───────────────────────────────────────────────────────────────────
 *
 * The manifest owns `kind`, `identity_json`, `listing_json` and `removed_at`; every ingest
 * rewrites them. The OPERATOR owns `capabilities_json` and `capabilities_source`; no statement in
 * `manifestIngestStatements` names either column, so an operator's narrowing survives every push
 * (and a repo can never widen one — it cannot even express it).
 *
 * `kind` is manifest-owned but ONE-WAY: the capability defaults are keyed by it, so an existing
 * row takes a new kind only when that does not widen its defaults (`kindsNarrowableTo`). A push
 * that re-kinds `altstore-beta` from `altstore` to `direct` updates identity and listing and
 * leaves the kind (and so what installed copies may do) where it was; a wider kind needs a new
 * outlet id. This holds for a removed row coming back too — copies installed through it exist.
 *
 * ── IDEMPOTENT BY CONSTRUCTION ──────────────────────────────────────────────────────────────
 *
 * A hook returns statements and cannot read, so the "only if changed" decision lives in SQL: the
 * upsert's `DO UPDATE … WHERE` touches a row (and its `modified_at`) only when a manifest-owned
 * column actually differs or the outlet is coming back from removal. A second resync of the same
 * manifest therefore changes nothing in `dist_outlets`. An outlet the manifest no longer declares
 * gets `removed_at` and is never deleted: availability history (P2b-03) refers to it.
 */

import {
  normalizeDistribution,
  outletListing,
  type ManifestDistribution,
  type ManifestListing,
  type ParsedManifest,
} from "@polaris-key/manifest";
import { parseJsonColumn } from "../../platform/json.js";
import type { Db, DbStatement } from "../../db/types.js";
import { kindsNarrowableTo } from "./capabilities.js";

/** A `dist_outlets` row. */
export interface DistOutletRow {
  product: string;
  outlet_id: string;
  kind: string;
  identity_json: string;
  capabilities_json: string | null;
  listing_json: string | null;
  capabilities_source: string;
  removed_at: number | null;
  created_at: number;
  modified_at: number;
}

/** A `dist_transports` row. */
export interface DistTransportRow {
  product: string;
  deliverable_id: string;
  outlet_id: string;
  transport: string;
  config_json: string | null;
}

/**
 * The distribution a parsed manifest describes. A manifest that does not enable Distribution
 * carries none, but a resync runs this hook against the product's STORED enablement — an operator
 * may have turned Distribution on live — so absent means the implicit document then too.
 */
function distributionOf(parsed: ParsedManifest): ManifestDistribution {
  return parsed.distribution ?? normalizeDistribution(undefined);
}

/**
 * Distribution's `manifestIngest` (`core/registry.ts`): the statements that make `dist_outlets`
 * and `dist_transports` match the manifest. See the file comment for the ownership and
 * idempotence rules these follow.
 */
export function manifestIngestStatements(
  parsed: ParsedManifest,
  product: string,
  now: number,
): DbStatement[] {
  const dist = distributionOf(parsed);
  const stmts: DbStatement[] = [];

  for (const outlet of dist.outlets) {
    const listing = outletListing(dist, outlet.id);
    // The stored kinds this row may move from without widening (always includes its own).
    const from = kindsNarrowableTo(outlet.kind);
    const inFrom = `dist_outlets.kind IN (${from.map(() => "?").join(", ")})`;
    stmts.push({
      sql: `INSERT INTO dist_outlets
              (product, outlet_id, kind, identity_json, listing_json, created_at, modified_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (product, outlet_id) DO UPDATE SET
              kind = CASE WHEN ${inFrom} THEN excluded.kind ELSE dist_outlets.kind END,
              identity_json = excluded.identity_json,
              listing_json = excluded.listing_json,
              removed_at = NULL,
              modified_at = excluded.modified_at
            WHERE (dist_outlets.kind IS NOT excluded.kind AND ${inFrom})
               OR dist_outlets.identity_json IS NOT excluded.identity_json
               OR dist_outlets.listing_json IS NOT excluded.listing_json
               OR dist_outlets.removed_at IS NOT NULL`,
      params: [
        product,
        outlet.id,
        outlet.kind,
        JSON.stringify(outlet.identity),
        listing ? JSON.stringify(listing) : null,
        now,
        now,
        ...from,
        ...from,
      ],
    });
  }

  // Outlets no longer declared are marked, not deleted. `outlets` is capped at MAX_OUTLETS (32)
  // by the validator, so the IN list stays far inside D1's bound-parameter limit.
  const declared = dist.outlets.map((o) => o.id);
  stmts.push({
    sql: `UPDATE dist_outlets SET removed_at = ?, modified_at = ?
           WHERE product = ? AND removed_at IS NULL${
             declared.length
               ? ` AND outlet_id NOT IN (${declared.map(() => "?").join(", ")})`
               : ""
           }`,
    params: [now, now, product, ...declared],
  });

  // PX-W1: the document's own listing (not an outlet's merged copy) — the product's presentation
  // in the customer portal, read through the `delivery` hook's `listing()`. Same idempotence as
  // the outlets: an identical listing touches nothing; no listing deletes the row.
  if (dist.listing) {
    stmts.push({
      sql: `INSERT INTO dist_listing (product, listing_json, modified_at)
            VALUES (?, ?, ?)
            ON CONFLICT (product) DO UPDATE SET
              listing_json = excluded.listing_json,
              modified_at = excluded.modified_at
            WHERE dist_listing.listing_json IS NOT excluded.listing_json`,
      params: [product, JSON.stringify(dist.listing), now],
    });
  } else {
    stmts.push({
      sql: "DELETE FROM dist_listing WHERE product = ?",
      params: [product],
    });
  }

  // The resolved transport for every (deliverable, live outlet) pair, replaced wholesale. Packs
  // are routed too (P4-05), so a manifest at the bounds — 64 packs and the app across 32 outlets
  // — resolves 2,080 pairs: written TRANSPORT_ROWS_PER_INSERT to a statement (four parameters
  // each, inside D1's 100), at most 84 statements in the ingest batch (THREAT-MODEL R10).
  stmts.push({
    sql: "DELETE FROM dist_transports WHERE product = ?",
    params: [product],
  });
  for (let i = 0; i < dist.routes.length; i += TRANSPORT_ROWS_PER_INSERT) {
    const chunk = dist.routes.slice(i, i + TRANSPORT_ROWS_PER_INSERT);
    stmts.push({
      sql: `INSERT INTO dist_transports (product, deliverable_id, outlet_id, transport, config_json)
            VALUES ${chunk.map(() => "(?, ?, ?, ?, NULL)").join(", ")}`,
      params: chunk.flatMap((r) => [
        product,
        r.deliverableId,
        r.outletId,
        r.transport,
      ]),
    });
  }
  return stmts;
}

/** `dist_transports` rows per INSERT: four bound parameters each, 100 per statement (D1). */
export const TRANSPORT_ROWS_PER_INSERT = 25;

/**
 * The transports Polaris Key ACTS ON: it either delivers the bytes itself, or tracks a store's
 * delivery end to end. Two kinds:
 *
 *   - delivered by Polaris Key (P4-05; `DERIVED_TRANSPORTS` in `availability.ts`): `pkey-cdn`,
 *     `web` and embedded baselines (`embedded`). Availability on a self-hosted outlet is derived
 *     from Release's truth, with no report;
 *   - store transports P5-08 implements: `apple-ba` (Apple-hosted Background Assets), `play-pad`
 *     (Play Asset Delivery) and `steam-depot` (Steam depots). The store moves the bytes; Polaris
 *     Key packages them (`pkey transport …`), takes their availability from CI reports and the
 *     App Store Connect connector, gates readiness on it, and the Godot SDK plans the `platform`
 *     strategy through the store's plugin and verifies the marker and bytes before mounting. No
 *     availability is DERIVED for them and no byte is routed for them.
 *
 * Any other transport a manifest names (`msix-optional`, `flatpak-ext`: no work package implements
 * them yet) is still STORED in `dist_transports` and listed, marked unsupported: nothing is
 * derived or routed for it, readiness reads only reported availability, and a device has no
 * transport for it, so a pack bound to it plans nothing (`plan.transport_unsupported`), never a
 * silent CDN fallback. That device rule is the SDK's and holds whatever this list says: a
 * platform transport the build does not carry is unsupported there too.
 */
export const SUPPORTED_TRANSPORTS: readonly string[] = [
  "pkey-cdn",
  "web",
  "embedded",
  "apple-ba",
  "play-pad",
  "steam-depot",
];

export function transportSupported(transport: string): boolean {
  return SUPPORTED_TRANSPORTS.includes(transport);
}

/**
 * The product's root listing (PX-W1), as the last ingest stored it, or `null` when the document
 * declares none (or the stored value is unreadable, which only a hand edit could make it).
 */
export async function getListing(
  db: Db,
  product: string,
): Promise<ManifestListing | null> {
  const row = await db.first<{ listing_json: string }>(
    "SELECT listing_json FROM dist_listing WHERE product = ?",
    product,
  );
  const parsed = row ? parseJsonColumn(row.listing_json) : null;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as ManifestListing)
    : null;
}

/** Every outlet row of a product, live first, then by id. */
export function listOutlets(db: Db, product: string): Promise<DistOutletRow[]> {
  return db.all<DistOutletRow>(
    `SELECT * FROM dist_outlets WHERE product = ?
      ORDER BY removed_at IS NOT NULL, outlet_id`,
    product,
  );
}

/** One outlet row (live or removed), or `null`. */
export function getOutlet(
  db: Db,
  product: string,
  outletId: string,
): Promise<DistOutletRow | null> {
  return db.first<DistOutletRow>(
    "SELECT * FROM dist_outlets WHERE product = ? AND outlet_id = ?",
    product,
    outletId,
  );
}

/** Every transport row of a product, by deliverable then outlet. */
export function listTransports(
  db: Db,
  product: string,
): Promise<DistTransportRow[]> {
  return db.all<DistTransportRow>(
    `SELECT * FROM dist_transports WHERE product = ?
      ORDER BY deliverable_id, outlet_id`,
    product,
  );
}

/**
 * Set (an operator's narrowing, `source = 'admin'`) or clear (revert, `source = 'default'`) the
 * capability override of one live outlet. The ONLY writer of the two operator-owned columns.
 * Returns whether a live row matched.
 */
export async function setCapabilityOverride(
  db: Db,
  product: string,
  outletId: string,
  override: Record<string, unknown> | null,
  now: number,
): Promise<boolean> {
  const changed = await db.runChanges(
    `UPDATE dist_outlets SET capabilities_json = ?, capabilities_source = ?, modified_at = ?
      WHERE product = ? AND outlet_id = ? AND removed_at IS NULL`,
    override ? JSON.stringify(override) : null,
    override ? "admin" : "default",
    now,
    product,
    outletId,
  );
  return changed > 0;
}
