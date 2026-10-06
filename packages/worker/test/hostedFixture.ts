/**
 * A hosted copy as HA-01's ingest leaves it (HA-07's serving tests): the `hosted_assets` row, the
 * `blob_objects` row and the product's `hosted-asset` ref (`<slot>@`) to the original, which is
 * what the image host's tenancy check (and `core/hostedImages.ts`) requires.
 */

import type { Db } from "../src/db/types.js";
import { NOW } from "./seed.js";

export interface HostedSeed {
  sha256: string | null;
  status?: string;
  origin?: string;
  contentType?: string | null;
  width?: number | null;
  height?: number | null;
  /** Ladder widths (each variant gets a made-up hash). */
  widths?: number[];
  /** The `wanted_ref` the copy was pulled for (`pulled_ref`), canonical JSON. */
  pulledRef?: string | null;
  /** `false`: no hosted-asset ref to the copy (the image host would not serve it). */
  ref?: boolean;
}

/** `{kind, src}` as `wantedRefOf` writes it. */
export function urlRef(src: string): string {
  return JSON.stringify({ kind: "url", src });
}

export async function seedHosted(
  db: Db,
  product: string,
  slot: string,
  row: HostedSeed,
): Promise<void> {
  await db.run(
    `INSERT INTO hosted_assets (product, slot, locale, origin, source_kind, sha256, size,
            content_type, width, height, variants_json, status, pulled_ref, wanted_ref,
            modified_at)
          VALUES (?, ?, '', ?, 'url', ?, 10, ?, ?, ?, ?, ?, ?, ?, ?)`,
    product,
    slot,
    row.origin ?? "manifest",
    row.sha256,
    row.contentType === undefined ? "image/png" : row.contentType,
    row.width ?? null,
    row.height ?? null,
    JSON.stringify(
      (row.widths ?? []).map((w) => ({
        w,
        format: "image/webp",
        sha256: w.toString(16).padStart(64, "f"),
        size: 5,
      })),
    ),
    row.status ?? "ready",
    row.pulledRef ?? null,
    row.pulledRef ?? null,
    NOW,
  );
  if (!row.sha256 || row.ref === false) return;
  const key = `blobs/sha256/${row.sha256}`;
  await db.run(
    `INSERT OR IGNORE INTO blob_objects (storage_key, sha256, size, kind, gated, verified_at, created_at)
          VALUES (?, ?, 10, 'blob', 0, ?, ?)`,
    key,
    row.sha256,
    NOW,
    NOW,
  );
  await db.run(
    `INSERT INTO blob_refs (product, storage_key, ref_kind, ref_id, created_at)
          VALUES (?, ?, 'hosted-asset', ?, ?)`,
    product,
    key,
    `${slot}@`,
    NOW,
  );
}
