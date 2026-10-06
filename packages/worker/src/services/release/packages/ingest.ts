/// <reference types="@cloudflare/workers-types" />

/**
 * Package release ingest (F-03, plans/F-01.md §3.2, §6.3, §6.7).
 *
 * A package release is one version of a `kind: package` deliverable: an ordinary
 * `release_metadata` row (`release_id` = `<deliverable>@<version>`, no builds), one
 * `release_artifacts` row of role `payload` per file (held by `blob_refs`, so the blob collector
 * keeps them), and one `release_packages` row of what the feeds render from. It reaches this
 * module only through the submit route (`../publish.ts`), after the staged objects verified; it
 * is NEVER signed, so a submit carrying a release record with it is refused before this runs
 * (`release_record_rejected`, reason `package-unsigned`).
 *
 * ── THE RULES THIS FILE ADDS TO THE VALIDATOR'S ──────────────────────────────────────────────
 *
 *   invalid_descriptor  package-shape      the validator refused the descriptor
 *                       maven-snapshot     a Maven `-SNAPSHOT` version (never mutable here)
 *                       package-namespace  no feed of the ecosystem, or the name is outside its
 *                                          namespace (the dependency-confusion rule)
 *                       package-too-large  over the feed's ceiling (per package; per blob for OCI)
 *                       swift-unsigned     a Swift release without its `cms-1.0.0` signature on a
 *                                          feed that requires one (the default; always for the
 *                                          system product)
 *   release_exists      package-version-taken  the version exists, in any state: unique forever,
 *                                          so a yanked or deprecated version is a tombstone, and
 *                                          so is a pruned build of main (`prune.ts`)
 *   (and the app path's seq, r2 and race rules, unchanged)
 *
 * The Worker never unzips (the P2b-05 rule): the metadata is the CLI's extract, checked for shape
 * and agreement by the validator. What the Worker does read is the bytes of each npm tarball and
 * Maven file, once, after promotion, for the SHA-512 / SHA-1 (/ MD5) digests those ecosystems'
 * clients verify (`digests.ts`); SHA-256 is already the blob key.
 */

import {
  SYSTEM_PRODUCT_SLUG,
  canonicalDescriptorJson,
  packageNameNorm,
  packageNamespaceProblem,
  parseManifestPackageDeliverable,
  validateReleaseDescriptor,
  type DescriptorError,
  type PackageEcosystem,
  type PackageReleaseDescriptor,
} from "@polaris-key/manifest";
import type { Db, DbStatement, Env } from "../../../core/platform.js";
import { ErrorCode } from "../../../core/errors.js";
import type { PackageFeedSettings } from "../../../core/hooks.js";
import {
  referencedKeys,
  stmtRecordRef,
  storedObjects,
} from "../../../core/blobs.js";
import { stmtEnqueuePackageRender } from "../../../core/registryQueue.js";
import { parseManualChannels } from "../channels.js";
import { getReleaseConfig } from "../config.js";
import { NEXT_SEQ_SQL } from "../model.js";
import { guardStatement, RELEASE_DESCRIBED_BY_SQL } from "../guard.js";
import { readAppDeliverable } from "../descriptor.js";
import { readPackDeliverableIds } from "../packs/deliverables.js";
import { packageFileDigests, type FileDigests } from "./digests.js";
import { prunedVersion, pruneAfterStablePublish } from "./prune.js";

/** Why a package ingest was refused (the response's `reason`). */
export type PackageRefusalReason =
  | "package-shape"
  | "maven-snapshot"
  | "package-namespace"
  | "package-too-large"
  | "swift-unsigned"
  | "package-version-taken"
  | "release_exists"
  | "seq_not_increasing"
  | "r2_object_missing"
  | "r2_ref_not_owned"
  | "distribution_disabled";

export type PackageIngestResult =
  | {
      ok: true;
      releaseId: string;
      deliverableId: string;
      /** `unchanged`: the same descriptor of a live version, already ingested. */
      outcome: "created" | "unchanged";
      dryRun: boolean;
      descriptorSha256: string;
      descriptor: PackageReleaseDescriptor;
      seq: number;
      /** The rows the ingest wrote (or, on a dry run, would write). */
      planned: PackagePlanned | null;
    }
  | {
      ok: false;
      status: 400 | 403 | 409;
      code: string;
      reason: PackageRefusalReason;
      message: string;
      errors?: DescriptorError[];
      retryable?: true;
    };

export interface PackagePlanned {
  releaseId: string;
  deliverableId: string;
  ecosystem: string;
  name: string;
  nameNorm: string;
  version: string;
  channel: string | null;
  files: PackageFileRow[];
}

/** One `release_packages.files_json` entry. */
export interface PackageFileRow {
  name: string;
  type: string;
  sha256: string;
  size: number;
  storageKey: string;
  mediaType?: string;
  classifier?: string;
  extension?: string;
  sha1?: string;
  sha512?: string;
  md5?: string;
}

/** Who published, for `release_packages.source_json`. */
export interface PackageSource {
  /** `oidc` / `static`: a CI token (trusted publishing, or an operator-issued one); `console`;
   *  `registry`: a `pkeyr_` publish token of the owner (F-22's native clients, F-23's push). */
  kind: "oidc" | "static" | "console" | "registry";
  publisher?: string;
  runUrl?: string;
  tokenId?: string;
  /** F-22: the native client that published (`npm`, `twine`, `swift`, `maven`); absent for
   *  `pkey release publish`. */
  client?: string;
  /** F-23: the release came through a registry protocol (`docker push`), not a ticket. */
  via?: "oci-push";
}

export interface PackageIngestOptions {
  now: number;
  dryRun?: boolean;
  /** Keys just promoted from this product's staging prefix (see `IngestOptions.promoted`). */
  promoted?: Iterable<string>;
  /** Dry run only: objects verified in staging, planned as promoted. */
  pendingPromotion?: ReadonlyMap<string, { sha256: string; size: number }>;
  /** The ecosystem's feed settings through `delivery.packageFeed`; `undefined` = Distribution
   *  is off for the product (a package is served by Distribution, so it cannot be published). */
  feed: PackageFeedSettings | null | undefined;
  source: PackageSource;
  /** Test seam: computes the npm and Maven digests (default: read each promoted object). */
  digests?: (files: PackageFileRow[]) => Promise<Map<string, FileDigests>>;
}

function refuse(
  reason: PackageRefusalReason,
  message: string,
  extra: {
    status?: 400 | 403 | 409;
    code?: string;
    errors?: DescriptorError[];
  } = {},
): Extract<PackageIngestResult, { ok: false }> {
  const status = extra.status ?? 400;
  return {
    ok: false,
    status,
    code:
      extra.code ??
      (reason === "package-shape" ||
      reason === "maven-snapshot" ||
      reason === "package-namespace" ||
      reason === "package-too-large" ||
      reason === "swift-unsigned"
        ? "invalid_descriptor"
        : reason === "package-version-taken"
          ? "release_exists"
          : status === 403
            ? ErrorCode.Forbidden
            : ErrorCode.BadRequest),
    reason,
    message,
    ...(extra.errors ? { errors: extra.errors } : {}),
  };
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

/** Is this submit body's descriptor a package release's? (Read defensively: unvalidated.) */
export function isPackageDescriptor(descriptor: unknown): boolean {
  return (
    descriptor !== null &&
    typeof descriptor === "object" &&
    (descriptor as { kind?: unknown }).kind === "package"
  );
}

/** The declared package deliverables, as persisted by resync (`release_deliverables`). */
export async function readPackageDeliverables(
  db: Db,
  product: string,
): Promise<{ id: string; ecosystem: PackageEcosystem; name: string }[]> {
  const rows = await db.all<{
    deliverable_id: string;
    def_json: string | null;
  }>(
    `SELECT deliverable_id, def_json FROM release_deliverables
      WHERE product = ? AND kind = 'package' ORDER BY deliverable_id`,
    product,
  );
  const out: { id: string; ecosystem: PackageEcosystem; name: string }[] = [];
  for (const r of rows) {
    const p = parseManifestPackageDeliverable(r.def_json, r.deliverable_id);
    if (p) out.push({ id: p.id, ecosystem: p.ecosystem, name: p.name });
  }
  return out;
}

/**
 * Validate, check and (unless `dryRun`) write one package release. A refusal writes nothing.
 */
export async function ingestPackageDescriptor(
  db: Db,
  env: Env,
  product: string,
  descriptor: unknown,
  opts: PackageIngestOptions,
): Promise<PackageIngestResult> {
  const dryRun = opts.dryRun === true;
  // 1. Shape and the declaration.
  const cfg = await getReleaseConfig(db, product);
  const v = validateReleaseDescriptor(descriptor, {
    product: { slug: product },
    release: {
      app: await readAppDeliverable(db, product),
      manualChannels: parseManualChannels(cfg?.manual_channels_json),
      packs: await readPackDeliverableIds(db, product),
      packages: await readPackageDeliverables(db, product),
    },
  });
  if (!v.ok)
    // The validator's own codes (`unsupported_deliverable_kind` when the descriptor's kind and
    // the deliverable's disagree, …) stay in `errors`; the answer's code is the descriptor's.
    return refuse(
      "package-shape",
      v.errors.map((e) => `${e.path}: ${e.message}`).join("; "),
      { errors: v.errors },
    );
  if (v.descriptor.kind !== "package")
    return refuse("package-shape", "kind must be package.");
  const d = v.descriptor;
  const pkg = d.package;
  const releaseId = v.releaseId;
  const nameNorm = packageNameNorm(pkg.ecosystem, pkg.name);
  const descriptorSha256 = await sha256Hex(canonicalDescriptorJson(d));

  // 2. Feed-level rules (operator-owned settings, read through Distribution's hook).
  if (pkg.ecosystem === "maven" && /-SNAPSHOT$/i.test(d.version))
    return refuse(
      "maven-snapshot",
      `${d.version} is a Maven snapshot; a package version is immutable, so snapshots are never published to a feed.`,
    );
  if (opts.feed === undefined)
    return refuse(
      "distribution_disabled",
      `${d.deliverable} is a package, and Distribution is off for this product: package feeds are Distribution's, so it cannot be published until Distribution is enabled.`,
      { status: 409 },
    );
  if (opts.feed === null)
    return refuse(
      "package-namespace",
      `no ${pkg.ecosystem} package feed is configured for ${product}; its operator sets the feed's namespace first.`,
    );
  const nsProblem = packageNamespaceProblem(
    pkg.ecosystem,
    pkg.name,
    opts.feed.namespace,
  );
  if (nsProblem)
    return refuse(
      "package-namespace",
      `${nsProblem} (a feed takes only names in its namespace).`,
    );
  const ceiling = opts.feed.maxPackageBytes;
  const sizes = pkg.files.map((f) => f.size);
  const tooLarge =
    pkg.ecosystem === "oci"
      ? sizes.some((s) => s > ceiling)
      : sizes.reduce((a, b) => a + b, 0) > ceiling;
  if (tooLarge)
    return refuse(
      "package-too-large",
      pkg.ecosystem === "oci"
        ? `an OCI object is over the feed's ceiling of ${ceiling} bytes per blob.`
        : `the release's files are over the feed's ceiling of ${ceiling} bytes.`,
    );
  if (pkg.ecosystem === "swift") {
    const required =
      product === SYSTEM_PRODUCT_SLUG || opts.feed.ext.requireSigned !== false;
    const signed =
      pkg.files.some((f) => f.type === "source-archive-signature") &&
      pkg.metadata.signatureFormat === "cms-1.0.0";
    if (required && !signed)
      return refuse(
        "swift-unsigned",
        "this Swift feed requires signed releases: publish the source-archive-signature (signatureFormat cms-1.0.0) that swift package-registry publish --dry-run writes with the signing flags.",
      );
  }

  // 3. Unique forever: the version in any state, or the release id held by anything else.
  const taken = await db.first<{
    release_id: string;
    state: string;
    marker: string | null;
  }>(
    `SELECT p.release_id, p.state,
            (SELECT json_extract(m.metadata_json, '$.descriptor.sha256') FROM release_metadata m
              WHERE m.product = p.product AND m.release_id = p.release_id) AS marker
       FROM release_packages p
      WHERE p.product = ? AND p.ecosystem = ? AND p.name_norm = ? AND p.version = ?`,
    product,
    pkg.ecosystem,
    nameNorm,
    d.version,
  );
  if (taken) {
    if (
      taken.state === "live" &&
      taken.release_id === releaseId &&
      taken.marker === descriptorSha256
    ) {
      const row = await db.first<{ seq: number | null }>(
        "SELECT seq FROM release_metadata WHERE product = ? AND release_id = ?",
        product,
        releaseId,
      );
      return {
        ok: true,
        releaseId,
        deliverableId: d.deliverable,
        outcome: "unchanged",
        dryRun,
        descriptorSha256,
        descriptor: d,
        seq: row?.seq ?? 0,
        planned: null,
      };
    }
    return refuse(
      "package-version-taken",
      taken.state === "live"
        ? `${pkg.name} ${d.version} is already published, from a different descriptor; a package version is never republished.`
        : `${pkg.name} ${d.version} was ${taken.state}; a package version is unique forever, so publish a new version.`,
      { status: 409 },
    );
  }
  // Feed retention (`prune.ts`): a pruned build of main is gone from every table but its
  // tombstone, and stays unique forever.
  const pruned = await prunedVersion(
    db,
    product,
    pkg.ecosystem,
    nameNorm,
    d.version,
  );
  if (pruned)
    return refuse(
      "package-version-taken",
      `${pkg.name} ${d.version} was pruned when ${pruned.stable} was released; a package version is unique forever, so publish a new version.`,
      { status: 409 },
    );
  const existing = await db.first<{ release_id: string }>(
    `SELECT release_id FROM release_metadata
      WHERE product = ? AND (release_id = ? OR (deliverable_id = ? AND version = ?))`,
    product,
    releaseId,
    d.deliverable,
    d.version,
  );
  if (existing)
    return refuse("release_exists", `${existing.release_id} already exists.`, {
      status: 409,
    });

  // 4. seq.
  const maxRow = await db.first<{ m: number | null }>(
    "SELECT MAX(seq) AS m FROM release_metadata WHERE product = ? AND deliverable_id = ?",
    product,
    d.deliverable,
  );
  const currentMax = maxRow?.m ?? 0;
  if (d.seq !== undefined && d.seq <= currentMax)
    return refuse(
      "seq_not_increasing",
      `seq ${d.seq} is not above the current maximum ${currentMax} for ${d.deliverable}.`,
      { status: 409 },
    );

  // 5. The blob store: every file is a stored object this product promoted or already holds.
  const promoted = new Set(opts.promoted ?? []);
  const keyed = pkg.files.map((f) => ({ f, key: f.locations[0]!.key }));
  const allKeys = pkg.files.flatMap((f) => f.locations.map((l) => l.key));
  const stored = await storedObjects(db, allKeys);
  const owned = await referencedKeys(db, product, allKeys);
  for (const f of pkg.files)
    for (const { key } of f.locations) {
      const pending = dryRun ? opts.pendingPromotion?.get(key) : undefined;
      const obj = stored.get(key) ?? pending;
      if (!obj || obj.sha256 !== f.sha256 || obj.size !== f.size)
        return refuse(
          "r2_object_missing",
          `${key} is not a stored object with ${f.name}'s sha256 and size.`,
        );
      if (!promoted.has(key) && !owned.has(key) && !pending)
        return refuse(
          "r2_ref_not_owned",
          `${key} was neither promoted for this release nor already referenced by ${product}.`,
          { status: 403 },
        );
    }

  // 6. The rows.
  const files: PackageFileRow[] = keyed.map(({ f, key }) => ({
    name: f.name,
    type: f.type,
    sha256: f.sha256,
    size: f.size,
    storageKey: key,
    ...(f.mediaType !== undefined ? { mediaType: f.mediaType } : {}),
    ...(f.classifier !== undefined ? { classifier: f.classifier } : {}),
    ...(f.extension !== undefined ? { extension: f.extension } : {}),
  }));
  const planned: PackagePlanned = {
    releaseId,
    deliverableId: d.deliverable,
    ecosystem: pkg.ecosystem,
    name: pkg.name,
    nameNorm,
    version: d.version,
    channel: d.channel ?? null,
    files,
  };
  const seq = d.seq ?? currentMax + 1;
  if (dryRun)
    return {
      ok: true,
      releaseId,
      deliverableId: d.deliverable,
      outcome: "created",
      dryRun,
      descriptorSha256,
      descriptor: d,
      seq,
      planned,
    };

  // The npm and Maven digests, read once from the promoted bytes (never on a dry run: the
  // objects may not be staged yet).
  const digests = await (opts.digests ?? ((fs) => packageFileDigests(env, fs)))(
    files,
  );
  for (const f of files) Object.assign(f, digests.get(f.name) ?? {});

  const now = opts.now;
  const markerJson = JSON.stringify({
    status: "ingested",
    sha256: descriptorSha256,
    source: "ci",
    at: now,
  });
  const publishedAt = d.publishedAt
    ? Math.floor(Date.parse(d.publishedAt) / 1000)
    : now;
  const seqSql = d.seq === undefined ? NEXT_SEQ_SQL : "?";
  const seqParams = d.seq === undefined ? [product, d.deliverable] : [d.seq];
  // The head: the release row, only while nothing holds this version or id (and an explicit
  // seq is still above the maximum). If the store changed since the read, it writes nothing,
  // and neither does the tail, which is guarded on this descriptor's marker.
  const head = guardStatement(
    {
      sql: `INSERT INTO release_metadata
              (product, release_id, version, title, notes, commit_sha, source_url,
               metadata_access, artifacts_access, published_at, metadata_json,
               created_at, modified_at, deliverable_id, seq, channel)
            VALUES (?,?,?,?,?,?,NULL,'public','public',?,json_object('descriptor', json(?)),?,?,?,${seqSql},?)
            ON CONFLICT(product, release_id) DO NOTHING`,
      params: [
        product,
        releaseId,
        d.version,
        d.title ?? `${pkg.name} ${d.version}`,
        d.notes ?? null,
        d.provenance?.commit ?? null,
        publishedAt,
        markerJson,
        now,
        now,
        d.deliverable,
        ...seqParams,
        d.channel ?? null,
      ],
    },
    `(NOT EXISTS (SELECT 1 FROM release_packages
                   WHERE product = ? AND ecosystem = ? AND name_norm = ? AND version = ?)
      AND NOT EXISTS (SELECT 1 FROM release_metadata
                       WHERE product = ? AND (release_id = ? OR (deliverable_id = ? AND version = ?)))${
                         d.seq !== undefined
                           ? `
      AND (SELECT COALESCE(MAX(seq), 0) FROM release_metadata
            WHERE product = ? AND deliverable_id = ?) < ?`
                           : ""
                       })`,
    [
      product,
      pkg.ecosystem,
      nameNorm,
      d.version,
      product,
      releaseId,
      d.deliverable,
      d.version,
      ...(d.seq !== undefined ? [product, d.deliverable, d.seq] : []),
    ],
  );
  const tail: DbStatement[] = [];
  for (const f of files) {
    const artifactId = `file:${f.name}`;
    tail.push({
      sql: `INSERT INTO release_artifacts
              (product, release_id, artifact_id, name, kind, platform, arch, content_type,
               size_bytes, sha256, source_url, storage_key, sparkle_signature, access,
               metadata_json, created_at, build_id, role, locations_json)
            VALUES (?,?,?,?,'package',NULL,NULL,'application/octet-stream',?,?,NULL,?,NULL,
                    'public',?,?,NULL,'payload',?)
            ON CONFLICT(product, release_id, artifact_id) DO NOTHING`,
      params: [
        product,
        releaseId,
        artifactId,
        f.name,
        f.size,
        f.sha256,
        f.storageKey,
        JSON.stringify({ packageFileType: f.type }),
        now,
        JSON.stringify(
          pkg.files.find((x) => x.name === f.name)?.locations ?? [],
        ),
      ],
    });
    for (const l of pkg.files.find((x) => x.name === f.name)?.locations ?? [])
      tail.push(
        stmtRecordRef(
          {
            product,
            storageKey: l.key,
            refKind: "artifact",
            refId: `${releaseId}/${artifactId}`,
          },
          now,
        ),
      );
  }
  tail.push(
    {
      sql: `INSERT INTO release_packages
              (product, ecosystem, name_norm, version, deliverable_id, release_id, name, state,
               state_message, files_json, metadata_json, source_json, published_at)
            VALUES (?,?,?,?,?,?,?,'live',NULL,?,?,?,?)
            ON CONFLICT(product, ecosystem, name_norm, version) DO NOTHING`,
      params: [
        product,
        pkg.ecosystem,
        nameNorm,
        d.version,
        d.deliverable,
        releaseId,
        pkg.name,
        JSON.stringify(files.map(fileJson)),
        JSON.stringify(pkg.metadata),
        JSON.stringify(opts.source),
        publishedAt,
      ],
    },
    // The feeds re-render this package (plans/F-01.md §6.5), atomically with the publish.
    stmtEnqueuePackageRender(product, d.deliverable, "publish", now),
  );
  const ownTail = tail.map((s) =>
    guardStatement(s, RELEASE_DESCRIBED_BY_SQL, [
      product,
      releaseId,
      descriptorSha256,
    ]),
  );
  await db.batch([head, ...ownTail]);
  const back = await db.first<{ seq: number | null; marker: string | null }>(
    `SELECT seq, json_extract(metadata_json, '$.descriptor.sha256') AS marker
       FROM release_metadata WHERE product = ? AND release_id = ?`,
    product,
    releaseId,
  );
  const row = await db.first<{ n: number }>(
    `SELECT 1 AS n FROM release_packages
      WHERE product = ? AND ecosystem = ? AND name_norm = ? AND version = ? AND release_id = ?`,
    product,
    pkg.ecosystem,
    nameNorm,
    d.version,
    releaseId,
  );
  if (back?.marker !== descriptorSha256 || !row)
    return {
      ...refuse(
        "release_exists",
        `${releaseId} changed while this descriptor was being checked; submit it again.`,
        { status: 409 },
      ),
      retryable: true,
    };
  // Feed retention: a final release on `stable` prunes this package's builds of main below it,
  // now that it is committed. It never throws: a failure is audited, and the next
  // stable publish retries it (`prune.ts`).
  await pruneAfterStablePublish(
    db,
    env,
    product,
    {
      deliverableId: d.deliverable,
      ecosystem: pkg.ecosystem,
      name: pkg.name,
      version: d.version,
      channel: d.channel ?? null,
    },
    now,
  );
  return {
    ok: true,
    releaseId,
    deliverableId: d.deliverable,
    outcome: "created",
    dryRun: false,
    descriptorSha256,
    descriptor: d,
    seq: back.seq ?? seq,
    planned,
  };
}

/** A `files_json` entry: the row without its storage key (the feeds address files by digest). */
function fileJson(f: PackageFileRow): Omit<PackageFileRow, "storageKey"> {
  const { storageKey: _key, ...rest } = f;
  return rest;
}
