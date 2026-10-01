/// <reference types="@cloudflare/workers-types" />

/**
 * Release descriptor ingest (P2-04, README §3.4 "declared, not sniffed").
 *
 * A release descriptor (`@polaris-key/manifest`'s `ReleaseDescriptor`) is the unsigned body of
 * one release of one deliverable. It reaches this module two ways:
 *
 *   - `source: "github"` — attached to a GitHub release as `pkey-release.json`, found by the
 *     truth-store sync (`ingestGithubDescriptors`, called from `sync.ts`);
 *   - `source: "ci"`     — handed over by P2-02's submit route after it has promoted the staged
 *     objects (`ingestReleaseDescriptor`, with the promoted keys in `promoted`).
 *
 * Either way it is checked against the product's declared artifact map
 * (`validateReleaseDescriptor`), then against the store, the blob store and GitHub, and written
 * to `release_metadata`, `release_builds`, `release_artifacts` and `blob_refs` in ONE batch
 * through `model.ts`. A refusal writes nothing.
 *
 * ── THE RULES THIS FILE ADDS TO THE VALIDATOR'S ──────────────────────────────────────────────
 *
 *   release_exists     the same descriptor twice is a no-op; a DIFFERENT one for an existing
 *                      (deliverable, version) is refused — except that a descriptor may enrich a
 *                      row the GitHub sync created for the same tag when the file names match.
 *   seq                absent: the next one for a new release, the stored one for an existing
 *                      release. Present: above the current maximum for a new release, equal to
 *                      the stored value for an existing one (P3-01 note: a GitHub webhook sync can
 *                      create the row before CI submits, which is why the second half exists).
 *   github             wherever GitHub is the source of bytes (source github, or any github
 *                      location), the tagged release must be IMMUTABLE and every github-located
 *                      file's GitHub digest must equal the descriptor's SHA-256 (size too).
 *   r2                 the key must be recorded in `blob_objects` with the same hash and size,
 *                      and this product must hold a ref to it already or have just earned one by
 *                      promoting it from its own staging prefix (`promoted`; THREAT-MODEL §3 —
 *                      never on the strength of "someone stored these bytes").
 *
 * Errors reuse `ErrorCode` with a `reason` (no new PolarisErrorCode — that is plan mode).
 */

import {
  APP_DELIVERABLE_ID,
  canonicalDescriptorJson,
  DESCRIPTOR_ASSET_NAME,
  MAX_DESCRIPTOR_BYTES,
  parseManifestAppDeliverable,
  validateReleaseDescriptor,
  type ArtifactRole,
  type DescriptorError,
  type DescriptorLocation,
  type ManifestAppDeliverable,
  type ReleaseDescriptor,
} from "@polaris-key/manifest";
import type { Db, DbStatement, Env } from "../../core/platform.js";
import { ErrorCode } from "../../core/errors.js";
import {
  referencedKeys,
  stmtRecordRef,
  storedObjects,
  type BlobRef,
} from "../../core/blobs.js";
import { parseManualChannels } from "./channels.js";
import {
  artifactPolicy,
  artifactsAccessSnapshot,
  getReleaseConfig,
  isResolved,
  type ReleaseConfigRow,
} from "./config.js";
import { installationToken } from "./gateway.js";
import {
  assetSha256,
  fetchTextAsset,
  getReleaseByTag,
  type Release,
  type ReleaseAsset,
} from "./github.js";
import type { FetchImpl } from "./githubApp.js";
import {
  getDeliverable,
  NEXT_SEQ_SQL,
  stmtEnsureAppDeliverable,
  stmtSetArtifactModel,
  stmtUpsertBuild,
  type BuildInput,
} from "./model.js";
import { guardStatement, RELEASE_DESCRIBED_BY_SQL } from "./guard.js";
import {
  artifactContentType,
  artifactKind,
  releasesInPublicationOrder,
  storeAccess,
  type ReleaseArtifactRow,
  type ReleaseMetadataRow,
} from "./store.js";

/** `roleOfKind(kind)` as SQL over `release_artifacts.kind` (kept in step by a worker test). */
export const ROLE_OF_KIND_SQL =
  "CASE kind WHEN 'signature' THEN 'signature' WHEN 'checksum' THEN 'checksum' ELSE 'payload' END";

// ── Result shapes ────────────────────────────────────────────────────────────

export type DescriptorSource = "github" | "ci";

/** What `metadata_json.descriptor` records about a release's descriptor. */
export type DescriptorMarker =
  | {
      status: "ingested";
      /** SHA-256 of the canonical descriptor JSON — "the same descriptor again" is this. */
      sha256: string;
      source: DescriptorSource;
      at: number;
    }
  | {
      /**
       * A `pkey-release.json` the sync refused. It is not fetched again while both the asset and
       * the declaration it was judged against (`basis`) are unchanged — except a refusal that
       * hangs on the store's other rows (`REFUSALS_RETRIED_EVERY_SYNC`), which is retried.
       */
      status: "refused";
      reason: string;
      assetId: number;
      /** `declarationBasis` at the time: SHA-256 of the app declaration and the manual channels. */
      basis?: string;
      at: number;
    };

/**
 * Refusals that depend on rows other than the descriptor's asset and the product's declaration —
 * another release holding the version, a blob-store object or reference — and so may clear
 * without either changing. These are fetched again on every sync (within the budget).
 */
const REFUSALS_RETRIED_EVERY_SYNC: ReadonlySet<string> =
  new Set<IngestRefusalReason>([
    "release_exists",
    "r2_object_missing",
    "r2_ref_not_owned",
  ]);

/**
 * What a descriptor is judged against besides itself and the store's rows: the persisted app
 * declaration (builds, channels) and the manual channels. A resync that changes either makes
 * every remembered refusal stale.
 */
async function declarationBasis(
  app: ManifestAppDeliverable | null,
  manualChannelsJson: string | null | undefined,
): Promise<string> {
  return sha256Hex(
    JSON.stringify({ app, manualChannels: manualChannelsJson ?? null }),
  );
}

/** Why an ingest was refused. Every refusal writes nothing (the sync's health row aside). */
export type IngestRefusalReason =
  | "invalid_descriptor"
  | "release_exists"
  | "seq_not_increasing"
  | "seq_mismatch"
  | "github_release_not_found"
  | "tag_mismatch"
  | "release_mutable"
  | "github_asset_missing"
  | "digest_mismatch"
  | "r2_object_missing"
  | "r2_ref_not_owned";

export interface PlannedArtifact {
  artifactId: string;
  buildId: string;
  name: string;
  role: ArtifactRole;
  sha256: string;
  size: number;
  platform: string;
  arch: string;
  storageKey: string | null;
  locations: DescriptorLocation[];
  /** GitHub's URL, and only GitHub's (R6-12). */
  sourceUrl: string | null;
}

export interface PlannedRows {
  release: {
    releaseId: string;
    deliverableId: string;
    version: string;
    /** The stored seq, the descriptor's explicit one, or null for "the next one". */
    seq: number | null;
    channel: string | null;
    title: string | null;
    commitSha: string | null;
    publishedAt: number | null;
  };
  builds: BuildInput[];
  artifacts: PlannedArtifact[];
  blobRefs: BlobRef[];
}

export type IngestResult =
  | {
      ok: true;
      releaseId: string;
      /** `unchanged`: the same descriptor was already ingested, and nothing was written. */
      outcome: "created" | "enriched" | "unchanged";
      dryRun: boolean;
      descriptorSha256: string;
      planned: PlannedRows | null;
      /** The validated descriptor (P3-03: the record is checked against it). */
      descriptor: ReleaseDescriptor;
      /** The release's `seq`: the stored one, the descriptor's explicit one, or the next one
       *  as of the plan's read. */
      seq: number;
    }
  | {
      ok: false;
      status: 400 | 403 | 409;
      code: string;
      reason: IngestRefusalReason;
      message: string;
      /** The validator's findings, for `invalid_descriptor`. */
      errors?: DescriptorError[];
      /**
       * The store changed between this ingest's read and its write (another submit or the GitHub
       * sync won a race) and a fresh check found nothing wrong: the same request may succeed if
       * sent again. Set only on that lost-race `release_exists` (P2-04 hand-off (a)); the CI
       * client treats it as retryable, every other refusal as final.
       */
      retryable?: true;
    };

export interface IngestOptions {
  source: DescriptorSource;
  now: number;
  /** Validate and plan only: return the rows that would be written, write nothing. */
  dryRun?: boolean;
  /**
   * Storage keys the caller has just promoted from THIS product's `staging/<product>/…` prefix
   * (P2-02). Together with the keys the product already references, these are the only `r2`
   * keys a descriptor may name.
   */
  promoted?: Iterable<string>;
  /**
   * `dryRun` only (P2-02's submit with `dryRun: true`, and its own pre-check): objects verified in
   * THIS product's staging prefix that the submit would promote, by target key. Planned as if
   * already promoted — stored with this hash and size, and earned by this release — so a dry
   * run judges the descriptor exactly as the real submit will, without writing anything.
   * Ignored without `dryRun`.
   */
  pendingPromotion?: ReadonlyMap<string, { sha256: string; size: number }>;
  /**
   * Statements that ride in the ingest's own batch, after the descriptor's rows (P3-03: the
   * release record). Each must carry its own guard. For an `unchanged` descriptor they run in a
   * batch of their own. Never run on a dry run or a refusal.
   */
  extraStatements?: (p: {
    releaseId: string;
    deliverableId: string;
    descriptorSha256: string;
  }) => DbStatement[];
  /** The tagged GitHub release, when the caller already holds it (the sync). */
  githubRelease?: Release | null;
  fetchImpl?: FetchImpl;
}

/** Refusal helper: `ErrorCode` + a stable reason (the `errorResponse` shape P2-02 answers with). */
function refuse(
  reason: IngestRefusalReason,
  message: string,
  extra: { status?: 400 | 403 | 409; errors?: DescriptorError[] } = {},
): Extract<IngestResult, { ok: false }> {
  const status = extra.status ?? 400;
  return {
    ok: false,
    status,
    code: status === 403 ? ErrorCode.Forbidden : ErrorCode.BadRequest,
    reason,
    message,
    ...(extra.errors ? { errors: extra.errors } : {}),
  };
}

// ── Context ──────────────────────────────────────────────────────────────────

/** The persisted app declaration (`release_deliverables.def_json`, written by resync). */
export async function readAppDeliverable(
  db: Db,
  product: string,
): Promise<ManifestAppDeliverable | null> {
  const row = await getDeliverable(db, product, APP_DELIVERABLE_ID);
  return parseManifestAppDeliverable(row?.def_json ?? null);
}

/** Every release of `product` whose `metadata_json` carries a descriptor marker. */
export async function readDescriptorMarkers(
  db: Db,
  product: string,
): Promise<Map<string, DescriptorMarker>> {
  const rows = await db.all<{ release_id: string; marker: string | null }>(
    `SELECT release_id, json_extract(metadata_json, '$.descriptor') AS marker
       FROM release_metadata
      WHERE product = ? AND json_extract(metadata_json, '$.descriptor') IS NOT NULL`,
    product,
  );
  const out = new Map<string, DescriptorMarker>();
  for (const r of rows) {
    try {
      const m = JSON.parse(r.marker ?? "null") as DescriptorMarker | null;
      if (m && (m.status === "ingested" || m.status === "refused"))
        out.set(r.release_id, m);
    } catch {
      // A hand-edited marker is no marker.
    }
  }
  return out;
}

async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function publishedSeconds(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

/** The `artifact_id` of a descriptor file: an existing row's, else GitHub's asset id, else its
 *  name — so a file never gets a second row under a different id. */
function artifactIdFor(
  name: string,
  existing: ReadonlyMap<string, string>,
  asset: ReleaseAsset | undefined,
): string {
  return existing.get(name) ?? (asset ? String(asset.id) : `file:${name}`);
}

// ── Planning ─────────────────────────────────────────────────────────────────

interface PlanInput {
  product: string;
  descriptor: unknown;
  source: DescriptorSource;
  now: number;
  cfg: ReleaseConfigRow | null;
  app: ManifestAppDeliverable | null;
  github: Release | null;
  promoted: ReadonlySet<string>;
  /** See `IngestOptions.pendingPromotion` (already filtered to dry runs by the caller). */
  pendingPromotion?: ReadonlyMap<string, { sha256: string; size: number }>;
  /**
   * The highest `seq` the deliverable will hold when this release's row is written, counting
   * rows written earlier in the same batch (the sync: every new release published before this
   * one, in publication order). An explicit `seq` on a new release must exceed it.
   */
  seqFloor?: number;
}

export type Plan =
  | {
      ok: true;
      releaseId: string;
      outcome: "created" | "enriched" | "unchanged";
      descriptorSha256: string;
      planned: PlannedRows | null;
      /** The release row — first in a batch, before anything that references it. */
      head: DbStatement[];
      /** Builds, artifacts and refs — after the row (and, in the sync, after the store's rows). */
      tail: DbStatement[];
      /**
       * The explicit seq the row newly takes — a release with no stored seq whose descriptor
       * names one. Null when the row keeps its stored seq or takes the next one in statement
       * order (`NEXT_SEQ_SQL`).
       */
      seq: number | null;
      /** The validated descriptor. */
      descriptor: ReleaseDescriptor;
      /** The seq the release holds or takes (the stored, explicit or next one at this read). */
      effectiveSeq: number;
    }
  | Extract<IngestResult, { ok: false }>;

/** Does the descriptor name any GitHub location? */
function namesGithub(d: ReleaseDescriptor): boolean {
  return d.builds.some((b) =>
    b.artifacts.some((a) => a.locations.some((l) => l.provider === "github")),
  );
}

/**
 * Check a descriptor against everything ingest knows and build the statements that write it.
 * Reads only. `input.github` must already be the tagged GitHub release when one is needed
 * (`githubNeeded`), or null when it could not be found.
 */
export async function planDescriptorIngest(
  db: Db,
  input: PlanInput,
): Promise<Plan> {
  const { product, source, now, cfg, app, github } = input;

  // 1. Shape and the declared map.
  const manual = parseManualChannels(cfg?.manual_channels_json);
  const v = validateReleaseDescriptor(input.descriptor, {
    product: { slug: product },
    release: { app, manualChannels: manual },
  });
  if (!v.ok)
    return refuse(
      "invalid_descriptor",
      v.errors.map((e) => `${e.path}: ${e.message}`).join("; "),
      { errors: v.errors },
    );
  const d = v.descriptor;
  const releaseId = v.releaseId;
  const descriptorSha256 = await sha256Hex(canonicalDescriptorJson(d));

  // 2. The release as the store has it.
  const rows = await db.all<ReleaseMetadataRow>(
    `SELECT * FROM release_metadata
      WHERE product = ? AND (release_id = ? OR (deliverable_id = ? AND version = ?))`,
    product,
    releaseId,
    d.deliverable,
    d.version,
  );
  const existing = rows.find((r) => r.release_id === releaseId) ?? null;
  const other = rows.find((r) => r.release_id !== releaseId);
  if (other)
    return refuse(
      "release_exists",
      `${d.deliverable} ${d.version} already exists as ${other.release_id}.`,
      { status: 409 },
    );
  const marker = existing ? markerOf(existing.metadata_json) : null;
  if (marker?.status === "ingested") {
    if (marker.sha256 === descriptorSha256)
      return {
        ok: true,
        releaseId,
        outcome: "unchanged",
        descriptorSha256,
        planned: null,
        head: [],
        tail: [],
        seq: null,
        descriptor: d,
        effectiveSeq: existing?.seq ?? 0,
      };
    return refuse(
      "release_exists",
      `${releaseId} was already ingested from a different descriptor.`,
      { status: 409 },
    );
  }
  if (existing && existing.deliverable_id !== d.deliverable)
    return refuse(
      "release_exists",
      `${releaseId} is a release of ${existing.deliverable_id}.`,
      { status: 409 },
    );

  // The files the store already holds for this release (a row the GitHub sync created).
  const existingArtifacts = existing
    ? await db.all<Pick<ReleaseArtifactRow, "artifact_id" | "name">>(
        "SELECT artifact_id, name FROM release_artifacts WHERE product = ? AND release_id = ?",
        product,
        releaseId,
      )
    : [];
  const idByName = new Map(
    existingArtifacts.map((a) => [a.name, a.artifact_id]),
  );
  if (existing) {
    // Enrichment: only a row the sync created for the SAME TAG, and only when the files the
    // descriptor places on GitHub are files that row already holds (its names match).
    const held = new Set(existingArtifacts.map((a) => a.name));
    const strangers = d.builds
      .flatMap((b) => b.artifacts)
      .filter(
        (a) =>
          a.locations.some((l) => l.provider === "github") && !held.has(a.name),
      )
      .map((a) => a.name);
    if (d.tag === undefined || strangers.length > 0)
      return refuse(
        "release_exists",
        d.tag === undefined
          ? `${releaseId} already exists.`
          : `${releaseId} already exists, and its files do not include ${strangers.slice(0, 5).join(", ")}.`,
        { status: 409 },
      );
  }

  // 3. seq.
  const maxRow = await db.first<{ m: number | null }>(
    "SELECT MAX(seq) AS m FROM release_metadata WHERE product = ? AND deliverable_id = ?",
    product,
    d.deliverable,
  );
  const currentMax = Math.max(maxRow?.m ?? 0, input.seqFloor ?? 0);
  let seq: number | null = existing?.seq ?? null;
  if (d.seq !== undefined) {
    if (seq !== null && d.seq !== seq)
      return refuse(
        "seq_mismatch",
        `${releaseId} has seq ${seq}; the descriptor says ${d.seq}.`,
        { status: 409 },
      );
    if (seq === null && d.seq <= currentMax)
      return refuse(
        "seq_not_increasing",
        `seq ${d.seq} is not above the current maximum ${currentMax} for ${d.deliverable}.`,
        { status: 409 },
      );
    seq = d.seq;
  }

  // 4. GitHub, wherever it is the source of bytes.
  const githubNeeded = source === "github" || namesGithub(d);
  const assets = new Map((github?.assets ?? []).map((a) => [a.name, a]));
  if (githubNeeded) {
    if (!github || d.tag === undefined)
      return refuse(
        "github_release_not_found",
        d.tag === undefined
          ? "a descriptor with GitHub locations needs a tag naming its GitHub release."
          : `no GitHub release is tagged ${d.tag}.`,
      );
    if (github.tag_name !== d.tag)
      return refuse(
        "tag_mismatch",
        `the descriptor is for tag ${d.tag}, attached to ${github.tag_name}.`,
      );
    if (github.immutable !== true)
      return refuse(
        "release_mutable",
        `GitHub release ${github.tag_name} is not immutable; ingest requires an immutable release where GitHub holds the bytes.`,
      );
    for (const b of d.builds) {
      for (const a of b.artifacts) {
        if (!a.locations.some((l) => l.provider === "github")) continue;
        const asset = assets.get(a.name);
        if (!asset)
          return refuse(
            "github_asset_missing",
            `${a.name} is not an asset of ${github.tag_name}.`,
          );
        const digest = assetSha256(asset);
        if (digest !== a.sha256 || asset.size !== a.size)
          return refuse(
            "digest_mismatch",
            digest === null
              ? `GitHub records no digest for ${a.name}.`
              : `${a.name} on GitHub does not have the descriptor's sha256 and size.`,
          );
      }
    }
  }

  // 5. The blob store.
  const r2Keys = d.builds.flatMap((b) =>
    b.artifacts.flatMap((a) =>
      a.locations.flatMap((l) =>
        l.provider === "r2" ? [{ key: l.key, a }] : [],
      ),
    ),
  );
  if (r2Keys.length > 0) {
    const keys = r2Keys.map((k) => k.key);
    const stored = await storedObjects(db, keys);
    const owned = await referencedKeys(db, product, keys);
    for (const { key, a } of r2Keys) {
      const pending = input.pendingPromotion?.get(key);
      const obj = stored.get(key) ?? pending;
      if (!obj || obj.sha256 !== a.sha256 || obj.size !== a.size)
        return refuse(
          "r2_object_missing",
          `${key} is not a stored object with ${a.name}'s sha256 and size.`,
        );
      if (!input.promoted.has(key) && !owned.has(key) && !pending)
        return refuse(
          "r2_ref_not_owned",
          `${key} was neither promoted for this release nor already referenced by ${product}.`,
          { status: 403 },
        );
    }
  }

  // 6. The rows.
  const policy = cfg ? artifactPolicy(cfg) : null;
  const metadataAccess = storeAccess(policy?.access.metadata ?? "public");
  const artifactsAccess = storeAccess(
    cfg ? artifactsAccessSnapshot(cfg) : "public",
  );
  const planned: PlannedRows = {
    release: {
      releaseId,
      deliverableId: d.deliverable,
      version: d.version,
      seq,
      channel: d.channel ?? null,
      title: d.title ?? github?.name ?? null,
      commitSha: d.provenance?.commit ?? null,
      publishedAt:
        publishedSeconds(d.publishedAt) ??
        publishedSeconds(github?.published_at) ??
        now,
    },
    builds: [],
    artifacts: [],
    blobRefs: [],
  };
  for (const b of d.builds) {
    planned.builds.push({
      product,
      releaseId,
      buildId: b.id,
      platform: b.platform,
      arch: b.arch,
      format: b.format,
      buildNumber: b.buildNumber ?? null,
      minOs: b.minOS ?? null,
      requiresJson: b.requires ? JSON.stringify(b.requires) : null,
    });
    for (const a of b.artifacts) {
      const asset = assets.get(a.name);
      const artifactId = artifactIdFor(a.name, idByName, asset);
      const r2 = a.locations.find((l) => l.provider === "r2");
      planned.artifacts.push({
        artifactId,
        buildId: b.id,
        name: a.name,
        role: a.role,
        sha256: a.sha256,
        size: a.size,
        platform: b.platform,
        arch: b.arch,
        storageKey: r2?.provider === "r2" ? r2.key : null,
        locations: a.locations,
        sourceUrl:
          asset && a.locations.some((l) => l.provider === "github")
            ? asset.browser_download_url
            : null,
      });
      for (const l of a.locations) {
        if (l.provider !== "r2") continue;
        planned.blobRefs.push({
          product,
          storageKey: l.key,
          refKind: "artifact",
          refId: `${releaseId}/${artifactId}`,
        });
      }
    }
  }

  const markerJson = JSON.stringify({
    status: "ingested",
    sha256: descriptorSha256,
    source,
    at: now,
  } satisfies DescriptorMarker);
  const releaseStmt = stmtUpsertDescribedRelease(product, planned.release, {
    notes: d.notes ?? github?.body ?? null,
    sourceUrl: github?.html_url ?? null,
    metadataAccess,
    artifactsAccess,
    markerJson,
    descriptorSha256,
    now,
  });
  // A NEW release's row is inserted only if what made it new still holds when the batch runs:
  // no other release of this version has appeared, and an explicit seq is still above the
  // deliverable's maximum. (A row of this id that appeared meanwhile — the sync's — takes the
  // ON CONFLICT path, which has its own condition.) When it does not hold, nothing of the ingest
  // is written: the tail is guarded on this descriptor's marker.
  const explicitSeq = existing === null && d.seq !== undefined;
  const head: DbStatement[] = [
    stmtEnsureAppDeliverable(product, now),
    existing
      ? releaseStmt
      : guardStatement(
          releaseStmt,
          `(EXISTS (SELECT 1 FROM release_metadata WHERE product = ? AND release_id = ?)
             OR (NOT EXISTS (SELECT 1 FROM release_metadata
                              WHERE product = ? AND deliverable_id = ? AND version = ?)${
                                explicitSeq
                                  ? `
                 AND (SELECT COALESCE(MAX(seq), 0) FROM release_metadata
                       WHERE product = ? AND deliverable_id = ?) < ?`
                                  : ""
                              }))`,
          [
            product,
            releaseId,
            product,
            d.deliverable,
            d.version,
            ...(explicitSeq ? [product, d.deliverable, d.seq!] : []),
          ],
        ),
  ];
  const tail: DbStatement[] = [
    ...planned.builds.map((b) => stmtUpsertBuild(b, now)),
    // A file the descriptor does not name belongs to no build of it: whatever build the map
    // gave it goes (below), so it leaves that build and its role falls back to the one its kind
    // implies (`roleOfKind`). The descriptor owns the release from here: `described` syncs
    // never touch `build_id` or `role` of a row, and insert a file the descriptor does not name
    // with no build (they skip the map), so no file is left pointing at a build that is not there.
    {
      sql: `UPDATE release_artifacts
               SET build_id = NULL,
                   role = ${ROLE_OF_KIND_SQL}
             WHERE product = ? AND release_id = ? AND build_id IS NOT NULL
               AND name NOT IN (SELECT value FROM json_each(?))`,
      params: [
        product,
        releaseId,
        JSON.stringify(planned.artifacts.map((a) => a.name)),
      ],
    },
    // A build the descriptor does not list is not part of this release (a map-made one, say).
    {
      sql: `DELETE FROM release_builds
             WHERE product = ? AND release_id = ?
               AND build_id NOT IN (SELECT value FROM json_each(?))`,
      params: [
        product,
        releaseId,
        JSON.stringify(planned.builds.map((b) => b.buildId)),
      ],
    },
  ];
  for (const a of planned.artifacts) {
    const kind = artifactKind(a.name);
    tail.push(
      {
        sql: `INSERT INTO release_artifacts
                (product, release_id, artifact_id, name, kind, platform, arch, content_type,
                 size_bytes, sha256, source_url, storage_key, sparkle_signature, access,
                 metadata_json, created_at, build_id, role, locations_json)
              VALUES (?,?,?,?,?,?,?,?,?,NULL,?,NULL,NULL,?,NULL,?,NULL,NULL,NULL)
              ON CONFLICT(product, release_id, artifact_id) DO NOTHING`,
        params: [
          product,
          releaseId,
          a.artifactId,
          a.name,
          kind,
          a.platform,
          a.arch,
          // The gateway's choice, never the uploader's `contentType` (R6-04).
          artifactContentType(kind),
          a.size,
          a.sourceUrl,
          artifactsAccess,
          now,
        ],
      },
      // The build's platform and arch replace whatever the sync sniffed for the file.
      {
        sql: `UPDATE release_artifacts SET platform = ?, arch = ?, size_bytes = ?
               WHERE product = ? AND release_id = ? AND artifact_id = ?`,
        params: [a.platform, a.arch, a.size, product, releaseId, a.artifactId],
      },
      stmtSetArtifactModel({
        product,
        releaseId,
        artifactId: a.artifactId,
        buildId: a.buildId,
        role: a.role,
        sha256: a.sha256,
        storageKey: a.storageKey,
        locationsJson: JSON.stringify(a.locations),
        metadataJson: null,
      }),
    );
  }
  for (const ref of planned.blobRefs) tail.push(stmtRecordRef(ref, now));

  // Every row after the head is written only while THIS descriptor is the release's: if another
  // one was ingested between this plan's read and its batch, the head wrote nothing (see
  // `stmtUpsertDescribedRelease`) and so does everything here — the first to commit wins, whole.
  const ownTail = tail.map((stmt) =>
    guardStatement(stmt, RELEASE_DESCRIBED_BY_SQL, [
      product,
      releaseId,
      descriptorSha256,
    ]),
  );

  return {
    ok: true,
    releaseId,
    outcome: existing ? "enriched" : "created",
    descriptorSha256,
    planned,
    head,
    tail: ownTail,
    seq: existing?.seq != null || d.seq === undefined ? null : d.seq,
    descriptor: d,
    effectiveSeq: seq ?? currentMax + 1,
  };
}

/**
 * The release row. A new row gets everything; an existing one (the sync's) gets only the
 * descriptor-owned facts — the marker, the channel, the provenance commit — and keeps its seq.
 *
 * The update is conditional on the row as it is when the batch runs: it applies only while the
 * release has no ingested descriptor, or has this very one. A different descriptor ingested
 * after this ingest read the store (two CI submissions racing, or CI racing the GitHub sync)
 * makes it a no-op, and with it every row of the ingest (`RELEASE_DESCRIBED_BY_SQL` guards the
 * tail). So does a stored seq other than the one the plan checked against: a release the sync
 * numbered after the plan read the store (no row then, an explicit `seq` in the descriptor) keeps
 * its seq and is not described. The CI path reads the marker back and reports the loss as the
 * refusal a fresh plan gives (`seq_mismatch` there), else `release_exists`.
 */
function stmtUpsertDescribedRelease(
  product: string,
  r: PlannedRows["release"],
  extra: {
    notes: string | null;
    sourceUrl: string | null;
    metadataAccess: string;
    artifactsAccess: string;
    markerJson: string;
    descriptorSha256: string;
    now: number;
  },
): DbStatement {
  const seqSql = r.seq === null ? NEXT_SEQ_SQL : "?";
  const seqParams = r.seq === null ? [product, r.deliverableId] : [r.seq];
  return {
    sql: `INSERT INTO release_metadata
            (product, release_id, version, title, notes, commit_sha, source_url,
             metadata_access, artifacts_access, published_at, metadata_json,
             created_at, modified_at, deliverable_id, seq, channel)
          VALUES (?,?,?,?,?,?,?,?,?,?,json_object('descriptor', json(?)),?,?,?,${seqSql},?)
          ON CONFLICT(product, release_id) DO UPDATE SET
            seq = COALESCE(release_metadata.seq, excluded.seq),
            channel = COALESCE(excluded.channel, release_metadata.channel),
            commit_sha = COALESCE(excluded.commit_sha, release_metadata.commit_sha),
            metadata_json = json_set(COALESCE(release_metadata.metadata_json, '{}'),
                                     '$.descriptor', json(?)),
            modified_at = excluded.modified_at
          WHERE (COALESCE(json_extract(release_metadata.metadata_json, '$.descriptor.status'), '')
                   <> 'ingested'
                 OR json_extract(release_metadata.metadata_json, '$.descriptor.sha256') = ?)
            AND (release_metadata.seq IS NULL OR ? IS NULL OR release_metadata.seq = ?)`,
    params: [
      product,
      r.releaseId,
      r.version,
      r.title,
      extra.notes,
      r.commitSha,
      extra.sourceUrl,
      extra.metadataAccess,
      extra.artifactsAccess,
      r.publishedAt,
      extra.markerJson,
      extra.now,
      extra.now,
      r.deliverableId,
      ...seqParams,
      r.channel,
      extra.markerJson,
      extra.descriptorSha256,
      r.seq,
      r.seq,
    ],
  };
}

function markerOf(metadataJson: string | null): DescriptorMarker | null {
  if (!metadataJson) return null;
  try {
    const m = (JSON.parse(metadataJson) as { descriptor?: DescriptorMarker })
      .descriptor;
    return m && typeof m === "object" ? m : null;
  } catch {
    return null;
  }
}

// ── The CI path (and anything else holding a descriptor) ─────────────────────

/**
 * Ingest one descriptor: validate, cross-check, and write its rows in one batch — or, with
 * `dryRun`, return the rows it would write and write nothing. P2-02's submit route calls this
 * after promoting the staged objects (`source: "ci"`, `promoted`).
 */
export async function ingestReleaseDescriptor(
  db: Db,
  env: Env,
  product: string,
  descriptor: unknown,
  opts: IngestOptions,
): Promise<IngestResult> {
  const cfg = await getReleaseConfig(db, product);
  const app = await readAppDeliverable(db, product);
  let github = opts.githubRelease ?? null;
  const d = descriptor as Partial<ReleaseDescriptor> | null;
  const wantsGithub =
    opts.source === "github" ||
    (Array.isArray(d?.builds) &&
      d.builds.some((b) =>
        (Array.isArray(b?.artifacts) ? b.artifacts : []).some((a) =>
          (Array.isArray(a?.locations) ? a.locations : []).some(
            (l) => l?.provider === "github",
          ),
        ),
      ));
  if (
    wantsGithub &&
    github === null &&
    typeof d?.tag === "string" &&
    cfg &&
    isResolved(cfg)
  ) {
    try {
      const fetchImpl = opts.fetchImpl ?? fetch;
      const token = await installationToken(env, cfg, opts.now, fetchImpl);
      github = await getReleaseByTag(
        token,
        cfg.gh_owner,
        cfg.gh_repo,
        d.tag,
        fetchImpl,
      );
    } catch {
      github = null; // reported as github_release_not_found below
    }
  }
  const input = {
    product,
    descriptor,
    source: opts.source,
    now: opts.now,
    cfg,
    app,
    github,
    promoted: new Set(opts.promoted ?? []),
    ...(opts.dryRun === true && opts.pendingPromotion
      ? { pendingPromotion: opts.pendingPromotion }
      : {}),
  };
  const plan = await planDescriptorIngest(db, input);
  if (!plan.ok) return plan;
  const dryRun = opts.dryRun === true;
  const extra =
    !dryRun && opts.extraStatements
      ? opts.extraStatements({
          releaseId: plan.releaseId,
          deliverableId: plan.descriptor.deliverable,
          descriptorSha256: plan.descriptorSha256,
        })
      : [];
  if (!dryRun && plan.outcome === "unchanged" && extra.length > 0)
    await db.batch(extra);
  if (!dryRun && plan.outcome !== "unchanged") {
    await db.batch([...plan.head, ...plan.tail, ...extra]);
    // The batch writes nothing when the store changed under the plan in a way that would have
    // refused it — a different descriptor for this release ingested, another release of this
    // version created, an explicit seq overtaken, or the row created by a sync with a seq other
    // than the descriptor's — after the plan read the store (the head's
    // conditions). Read back whose marker it is; on a loss, the same checks run again against
    // the store as it is now name the reason.
    const stored = await db.first<{
      status: string | null;
      sha256: string | null;
    }>(
      `SELECT json_extract(metadata_json, '$.descriptor.status') AS status,
              json_extract(metadata_json, '$.descriptor.sha256') AS sha256
         FROM release_metadata WHERE product = ? AND release_id = ?`,
      product,
      plan.releaseId,
    );
    if (
      stored?.status !== "ingested" ||
      stored.sha256 !== plan.descriptorSha256
    ) {
      const again = await planDescriptorIngest(db, input);
      if (!again.ok) return again;
      return {
        ...refuse(
          "release_exists",
          `${plan.releaseId} changed while this descriptor was being checked; submit it again.`,
          { status: 409 },
        ),
        retryable: true,
      };
    }
  }
  return {
    ok: true,
    releaseId: plan.releaseId,
    outcome: plan.outcome,
    dryRun,
    descriptorSha256: plan.descriptorSha256,
    planned: plan.planned,
    descriptor: plan.descriptor,
    seq: plan.effectiveSeq,
  };
}

// ── The GitHub path (the truth-store sync) ───────────────────────────────────

/** How many `pkey-release.json` assets one sync fetches at most (installation quota, R10-05). */
export const MAX_DESCRIPTOR_FETCHES_PER_SYNC = 5;

export interface GithubDescriptorOutcome {
  /**
   * The release rows of the descriptors ingested in this pass, by release id. The store emits
   * each in that release's publication-order slot (`StoreClassificationOptions.describedRows`),
   * so seq stays publication order.
   */
  rows: Map<string, DbStatement[]>;
  /** Statements that must run AFTER the store's own. */
  tail: DbStatement[];
  /** Releases with an ingested descriptor, including the ones ingested in this pass. */
  described: Set<string>;
  /** Releases whose descriptor is refused, with the reason (their health is degraded). */
  refused: Map<string, string>;
}

/**
 * Find and ingest the `pkey-release.json` of GitHub releases that have no ingested descriptor
 * yet, newest first, at most `MAX_DESCRIPTOR_FETCHES_PER_SYNC` per sync. A refused descriptor is
 * remembered by asset id and declaration (`basis`), so the same refusal is not fetched again
 * until the asset or the product's declaration changes; a refusal that hangs on other rows
 * (`REFUSALS_RETRIED_EVERY_SYNC`) is fetched again every sync.
 * A fetch that fails (quota, a 404) is skipped silently and retried by the next sync — the
 * truth store is a cache, and this pass must never fail the resync carrying it.
 *
 * SEQ. The descriptors are planned in publication order (`releasesInPublicationOrder`, the order
 * the store writes the rows in), tracking the `seq` each new release will take when its row is
 * written: the stored maximum, plus one for every new release published before it — or that
 * release's own explicit `seq`. A descriptor's explicit `seq` must exceed that running value,
 * else it is refused `seq_not_increasing` and the release is numbered like any other. So an
 * explicit seq can never collide with one the same batch computes (the unique index would fail
 * the whole batch), and seq never runs against publication order.
 */
export async function ingestGithubDescriptors(
  db: Db,
  cfg: ReleaseConfigRow & { gh_owner: string; gh_repo: string },
  token: string,
  releases: readonly Release[],
  held: readonly Release[],
  app: ManifestAppDeliverable | null,
  now: number,
  fetchImpl: FetchImpl,
): Promise<GithubDescriptorOutcome> {
  const product = cfg.product;
  const markers = await readDescriptorMarkers(db, product);
  const described = new Set<string>();
  const refused = new Map<string, string>();
  for (const [id, m] of markers) {
    if (m.status === "ingested") described.add(id);
  }
  const out: GithubDescriptorOutcome = {
    rows: new Map(),
    tail: [],
    described,
    refused,
  };

  const ordered = releasesInPublicationOrder(releases, held);
  const candidates = ordered
    .filter((r) => !described.has(r.tag_name))
    .map((r) => ({
      r,
      asset: r.assets.find((a) => a.name === DESCRIPTOR_ASSET_NAME),
    }))
    .filter(
      (c): c is { r: Release; asset: ReleaseAsset } => c.asset !== undefined,
    );
  // A refusal of this exact asset under this exact declaration is remembered, not re-fetched.
  const basis = await declarationBasis(app, cfg.manual_channels_json);
  const toFetch: { r: Release; asset: ReleaseAsset }[] = [];
  for (const c of candidates) {
    const m = markers.get(c.r.tag_name);
    if (
      m?.status === "refused" &&
      m.assetId === c.asset.id &&
      m.basis === basis &&
      !REFUSALS_RETRIED_EVERY_SYNC.has(m.reason)
    )
      refused.set(c.r.tag_name, m.reason);
    else {
      // Stale or retried: fetched again (budget permitting), and degraded until it is accepted.
      if (m?.status === "refused") refused.set(c.r.tag_name, m.reason);
      toFetch.push(c);
    }
  }
  // The newest ones, for the budget.
  const budget = toFetch
    .sort(
      (a, b) =>
        (publishedSeconds(b.r.published_at) ?? 0) -
        (publishedSeconds(a.r.published_at) ?? 0),
    )
    .slice(0, MAX_DESCRIPTOR_FETCHES_PER_SYNC);
  const reads = new Map<
    string,
    {
      asset: ReleaseAsset;
      read: Awaited<ReturnType<typeof readAttachedDescriptor>>;
    }
  >();
  for (const { r, asset } of budget)
    reads.set(r.tag_name, {
      asset,
      read: await readAttachedDescriptor(cfg, token, asset, fetchImpl),
    });

  // Planned in publication order, tracking the seq the batch will have reached at each slot.
  const stored = await db.all<{ release_id: string; seq: number | null }>(
    "SELECT release_id, seq FROM release_metadata WHERE product = ? AND deliverable_id = ?",
    product,
    APP_DELIVERABLE_ID,
  );
  const storedSeq = new Map(stored.map((x) => [x.release_id, x.seq]));
  let running = stored.reduce((m, x) => Math.max(m, x.seq ?? 0), 0);
  for (const r of ordered) {
    // A row with no stored seq (new, or written before P2-03) takes one in this batch.
    const takesSeq = (storedSeq.get(r.tag_name) ?? null) === null;
    let explicit: number | null = null;
    const fetched = reads.get(r.tag_name);
    if (fetched && fetched.read !== "transient") {
      const { asset, read } = fetched;
      const plan =
        read === "unreadable"
          ? refuse(
              "invalid_descriptor",
              `pkey-release.json is not JSON of at most ${MAX_DESCRIPTOR_BYTES} bytes.`,
            )
          : await planDescriptorIngest(db, {
              product,
              descriptor: read.value,
              source: "github",
              now,
              cfg,
              app,
              github: r,
              promoted: new Set(),
              seqFloor: running,
            });
      if (plan.ok) {
        explicit = plan.seq;
        out.rows.set(r.tag_name, plan.head);
        out.tail.push(...plan.tail);
        described.add(r.tag_name);
        refused.delete(r.tag_name);
      } else {
        refused.set(r.tag_name, plan.reason);
        out.tail.push({
          // After the store's own upsert of the row, which this then annotates. Never over an
          // ingested descriptor.
          sql: `UPDATE release_metadata
                   SET metadata_json = json_set(COALESCE(metadata_json, '{}'), '$.descriptor', json(?))
                 WHERE product = ? AND release_id = ?
                   AND COALESCE(json_extract(metadata_json, '$.descriptor.status'), '') <> 'ingested'`,
          params: [
            JSON.stringify({
              status: "refused",
              reason: plan.reason,
              assetId: asset.id,
              basis,
              at: now,
            } satisfies DescriptorMarker),
            product,
            r.tag_name,
          ],
        });
      }
    }
    if (takesSeq) running = explicit ?? running + 1;
  }
  return out;
}

/**
 * Fetch and parse one `pkey-release.json`. `unreadable` (too large, or not JSON) is a refusal;
 * `transient` (quota, a 404, a network failure) is retried by the next sync.
 */
async function readAttachedDescriptor(
  cfg: { gh_owner: string; gh_repo: string },
  token: string,
  asset: ReleaseAsset,
  fetchImpl: FetchImpl,
): Promise<{ value: unknown } | "unreadable" | "transient"> {
  // Over the cap it can never be accepted, so it is refused without spending a fetch.
  if (asset.size > MAX_DESCRIPTOR_BYTES) return "unreadable";
  let text: string;
  try {
    text = await fetchTextAsset(
      token,
      cfg.gh_owner,
      cfg.gh_repo,
      asset.id,
      fetchImpl,
      MAX_DESCRIPTOR_BYTES,
    );
  } catch {
    return "transient";
  }
  try {
    return { value: JSON.parse(text) as unknown };
  } catch {
    return "unreadable";
  }
}
