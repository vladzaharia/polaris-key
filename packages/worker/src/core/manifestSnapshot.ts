/**
 * The manifest snapshot (ST-01a, notes/S-18 §4.3): the last `.pkey/` manifest applied to each
 * product, in `product_manifest_snapshot` (Core-owned, migration 0072).
 *
 * Every apply path puts `stmtUpsertManifestSnapshot` in the SAME `db.batch` as the apply, so the
 * row can never describe a manifest that did not land, nor miss one that did:
 *
 *   - `resync`      `services/release/resync.ts` `resyncRepo` (webhook or manual);
 *   - `link`        `services/release/linkRepo.ts` `linkRepo`;
 *   - `deploy-hook` `console/systemProduct.ts` `linkSystemProduct` (the system product);
 *   - `backfill`    ST-01c, for products not applied since this table existed.
 *
 * One row per product, latest only (`ON CONFLICT(product) DO UPDATE`). Readers: Revert (ST-01b),
 * the backfill (ST-01c) and the drift view (ST-17).
 *
 * The snapshot never decides what is applied; it records what was. `applied_sha` is the commit the
 * documents were fetched AT, resolved by GitHub from the DB-configured repository's default branch
 * (`services/release/manifestFetch.ts`) or, for the deploy hook, the deploy's own `PKEY_GIT_SHA`.
 * A manifest profile CAN carry secret values (`payload.secrets.*`, and `payload.config.<key>` for a
 * catalog-secret key); the apply seals them, but the parsed manifest handed to the snapshot is the
 * pre-seal one. So the snapshot scrubs before it stores (`scrubManifestSecrets`): `manifest_json`
 * holds a fixed marker where a secret value was, and nothing that can be restored. The values
 * stay in the linked repository and, sealed, in the profile row. `files_sha256` is taken over the
 * raw documents and is untouched, so drift detection is unchanged.
 */

import type { Db, DbStatement } from "../db/types.js";
import { sha256Hex } from "../platform/hash.js";

/** Who wrote a snapshot row (the table's CHECK constraint, in the same order). */
export const SNAPSHOT_ORIGINS = [
  "resync",
  "link",
  "deploy-hook",
  "backfill",
] as const;
export type SnapshotOrigin = (typeof SNAPSHOT_ORIGINS)[number];

/** A stored snapshot row, as D1 returns it. */
export interface ManifestSnapshotRow {
  product: string;
  applied_sha: string | null;
  applied_at: number;
  origin: SnapshotOrigin;
  files_sha256: string;
  manifest_json: string;
}

/** A git object id: SHA-1 (40 hex) or SHA-256 (64 hex), lowercase as GitHub spells it. */
const GIT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** `value` when it is a well-formed lowercase git commit id, otherwise `null`. */
export function gitShaOrNull(value: string | null | undefined): string | null {
  return typeof value === "string" && GIT_SHA.test(value) ? value : null;
}

/**
 * SHA-256 (lowercase hex) over the raw manifest documents, for change detection.
 *
 * Canonical encoding: the documents as `[name, text]` pairs sorted by name, JSON-encoded. JSON's
 * string escaping makes the boundary between a name and its text unambiguous, and sorting makes
 * the digest independent of the order the documents were read in. An absent document is simply
 * not in the list.
 */
export async function manifestFilesSha256(
  files: Readonly<Record<string, string>>,
): Promise<string> {
  const pairs = Object.keys(files)
    .sort()
    .map((name) => [name, files[name]]);
  return sha256Hex(JSON.stringify(pairs));
}

/** What a scrubbed snapshot holds where a secret value was. */
export const SNAPSHOT_REDACTED = "[redacted]";

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function redactEntry(entry: unknown): unknown {
  if (isObj(entry) && "value" in entry)
    return entry.value === null ||
      entry.value === undefined ||
      entry.value === SNAPSHOT_REDACTED
      ? entry
      : { ...entry, value: SNAPSHOT_REDACTED };
  return entry === null || entry === undefined ? entry : SNAPSHOT_REDACTED;
}

/**
 * A copy of the parsed manifest with every secret value replaced by `SNAPSHOT_REDACTED`: the
 * whole `secrets` bucket of each profile payload, and the `config` entries under a key
 * `isSecretKey` names. Everything else is carried as it is. Idempotent. A manifest of another
 * shape is returned unchanged.
 */
export function scrubManifestSecrets(
  manifest: unknown,
  isSecretKey: (key: string) => boolean,
): unknown {
  if (!isObj(manifest) || !Array.isArray(manifest.profiles)) return manifest;
  const profiles = manifest.profiles.map((profile: unknown) => {
    if (!isObj(profile) || !isObj(profile.payload)) return profile;
    const payload: Record<string, unknown> = { ...profile.payload };
    if (isObj(payload.secrets))
      payload.secrets = Object.fromEntries(
        Object.entries(payload.secrets).map(([k, v]) => [k, redactEntry(v)]),
      );
    if (isObj(payload.config))
      payload.config = Object.fromEntries(
        Object.entries(payload.config).map(([k, v]) => [
          k,
          isSecretKey(k) ? redactEntry(v) : v,
        ]),
      );
    return { ...profile, payload };
  });
  return { ...manifest, profiles };
}

/**
 * The inverse guard, for a payload read BACK from a snapshot: an entry holding `SNAPSHOT_REDACTED`
 * carries no value from the manifest, so it takes the stored profile's entry (a sealed secret is
 * carried exactly as stored) or, with none stored, is dropped. The marker is never sealed or
 * written. Everything else is returned as it is.
 */
export function unredactPayload(
  payload: Record<string, unknown>,
  storedPayloadJson: string | null | undefined,
): Record<string, unknown> {
  let stored: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(storedPayloadJson ?? "null");
    if (isObj(parsed)) stored = parsed;
  } catch {
    /* nothing stored to carry */
  }
  const next = { ...payload };
  for (const bucket of ["secrets", "config"]) {
    const entries = payload[bucket];
    if (!isObj(entries)) continue;
    const storedBucket = isObj(stored[bucket]) ? stored[bucket] : {};
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(entries)) {
      const value = isObj(v) && "value" in v ? v.value : v;
      if (value !== SNAPSHOT_REDACTED) out[k] = v;
      else if (k in storedBucket) out[k] = storedBucket[k];
    }
    next[bucket] = out;
  }
  return next;
}

/** What an apply path hands to `stmtUpsertManifestSnapshot`. */
export interface ManifestSnapshotInput {
  product: string;
  appliedSha: string | null;
  appliedAt: number;
  origin: SnapshotOrigin;
  /** `manifestFilesSha256` over the documents that were parsed. */
  filesSha256: string;
  /** The normalised ParsedManifest that was applied (serialised with `JSON.stringify`). */
  manifest: unknown;
}

/** The upsert for one product's snapshot. Returned, not run: it belongs in the apply's batch. */
export function stmtUpsertManifestSnapshot(
  input: ManifestSnapshotInput,
): DbStatement {
  return {
    sql: `INSERT INTO product_manifest_snapshot
            (product, applied_sha, applied_at, origin, files_sha256, manifest_json)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(product) DO UPDATE SET
            applied_sha = excluded.applied_sha,
            applied_at = excluded.applied_at,
            origin = excluded.origin,
            files_sha256 = excluded.files_sha256,
            manifest_json = excluded.manifest_json`,
    params: [
      input.product,
      gitShaOrNull(input.appliedSha),
      input.appliedAt,
      input.origin,
      input.filesSha256,
      JSON.stringify(input.manifest),
    ],
  };
}

/**
 * Build the snapshot statement straight from the raw documents and the parsed manifest, scrubbed
 * of secret values by `isSecretKey` (the union of the incoming and stored catalogs, as sealing).
 */
export async function manifestSnapshotStatement(
  product: string,
  origin: SnapshotOrigin,
  appliedSha: string | null,
  files: Readonly<Record<string, string>>,
  manifest: unknown,
  now: number,
  isSecretKey: (key: string) => boolean,
): Promise<DbStatement> {
  return stmtUpsertManifestSnapshot({
    product,
    appliedSha,
    appliedAt: now,
    origin,
    filesSha256: await manifestFilesSha256(files),
    manifest: scrubManifestSecrets(manifest, isSecretKey),
  });
}

/** The product's last applied manifest, or `null` when none has been recorded yet. */
export function getManifestSnapshot(
  db: Db,
  product: string,
): Promise<ManifestSnapshotRow | null> {
  return db.first<ManifestSnapshotRow>(
    "SELECT * FROM product_manifest_snapshot WHERE product = ?",
    product,
  );
}
