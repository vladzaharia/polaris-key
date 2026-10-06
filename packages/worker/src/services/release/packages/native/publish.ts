/// <reference types="@cloudflare/workers-types" />
/**
 * The shared half of every native publish (F-22): from a client's files to a package release,
 * through the SAME descriptor and ingest as `pkey release publish` (F-03, `../ingest.ts`).
 *
 * A native client's request is translated by its adapter (`npm.ts`, `pypi.ts`, `swift.ts`,
 * `maven.ts`) into files, a version, a channel and the ecosystem's metadata. This module then:
 *
 *   1. resolves the declared package deliverable the name belongs to (a package is declared in
 *      `.pkey/release` first, exactly as for the CLI: `package-undeclared` otherwise);
 *   2. builds the release descriptor (`kind: "package"`, `r2` locations at each file's
 *      content-addressed key) and plans it as a dry run, so every ingest refusal (namespace,
 *      ceiling, version taken, Swift signing, Maven snapshot, shape) answers before a byte is
 *      written;
 *   3. stages each file under the owner's staging prefix (`staging/<owner>/<session>/<sha256>`,
 *      written by the Worker with R2 checking the SHA-256, never by a client credential);
 *   4. promotes each staged file (`core/blobs.ts` `promote`: verify, copy, record) and ingests the
 *      descriptor with them, then audits and bumps the release generation.
 *
 * The bytes pass through the Worker (that is what a native client sends), bounded by the request
 * cap (`body.ts`); they are hashed and staged once. Nothing here reads inside a package except
 * Swift's manifests (`swiftArchive.ts`).
 */

import {
  packageNameNorm,
  type PackageEcosystem,
  type PackageReleaseDescriptor,
} from "@polaris-key/manifest";
import type { Db, Env } from "../../../../core/platform.js";
import type { RegistryRouteContext } from "../../../../core/registryHost.js";
import type { PackageFeedSettings } from "../../../../core/hooks.js";
import type { PublishPrincipal } from "../../../../core/registryPublish.js";
import {
  blobKey,
  promote,
  putVerified,
  stagingKey,
} from "../../../../core/blobs.js";
import { appendAudit } from "../../../../core/data.js";
import { randomId } from "../../../../core/platform.js";
import { bumpReleaseGeneration } from "../../ghCache.js";
import {
  ingestPackageDescriptor,
  readPackageDeliverables,
  type PackageIngestResult,
  type PackageSource,
} from "../ingest.js";

/** The native client a publish came from, as audits and the package record name it. */
export type NativeClient = "npm" | "twine" | "swift" | "maven";

/** How each client is named in an audit summary. */
export const CLIENT_LABEL: Readonly<Record<NativeClient, string>> = {
  npm: "npm publish",
  twine: "twine upload",
  swift: "swift package-registry publish",
  maven: "a Maven/Gradle deploy",
};

/** One file of a native release, hashed. */
export interface NativeFile {
  readonly name: string;
  readonly type: string;
  readonly sha256: string;
  readonly size: number;
  readonly extension?: string;
  readonly classifier?: string;
}

/** A file staged under the owner's staging prefix. */
export interface StagedFile extends NativeFile {
  readonly staging: string;
}

/** A refusal, as every adapter answers it in its own protocol's shape. */
export interface NativeRefusal {
  readonly ok: false;
  readonly status: number;
  readonly code: string;
  readonly reason: string;
  readonly message: string;
}

export function nativeRefusal(
  status: number,
  code: string,
  reason: string,
  message: string,
): NativeRefusal {
  return { ok: false, status, code, reason, message };
}

/** The lowercase hex SHA-256 of `bytes`. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer,
  );
  let out = "";
  for (const b of new Uint8Array(buf)) out += b.toString(16).padStart(2, "0");
  return out;
}

/**
 * The owner's feed of `ecosystem`, or `null` when a publish must answer the host's not-found:
 * Distribution off (no `delivery` hook), no feed of that ecosystem, or the feed, the owner's
 * `packageFeeds` or the platform's kill switch off. "Off" is indistinguishable from "absent",
 * as on every read.
 */
export async function answeringFeed(
  ctx: RegistryRouteContext,
  ecosystem: PackageEcosystem,
): Promise<PackageFeedSettings | null> {
  const delivery = ctx.hooks.delivery();
  if (!delivery) return null;
  const feed = await delivery.packageFeed(ecosystem);
  if (!feed || !feed.enabled || !feed.ownerEnabled || !feed.policyEnabled)
    return null;
  return feed;
}

/** The declared package deliverable `name` belongs to (by the ecosystem's normalised name). */
export async function declaredPackage(
  db: Db,
  product: string,
  ecosystem: PackageEcosystem,
  name: string,
): Promise<{ id: string; name: string } | null> {
  const norm = packageNameNorm(ecosystem, name);
  const declared = await readPackageDeliverables(db, product);
  const hit = declared.find(
    (p) =>
      p.ecosystem === ecosystem && packageNameNorm(ecosystem, p.name) === norm,
  );
  return hit ? { id: hit.id, name: hit.name } : null;
}

/** The refusal for a name no deliverable declares. */
export function undeclared(
  ecosystem: PackageEcosystem,
  name: string,
): NativeRefusal {
  return nativeRefusal(
    403,
    "forbidden",
    "package-undeclared",
    `${name} is not a ${ecosystem} package this product declares; add it to .pkey/release (a package deliverable) and sync the manifest before publishing it.`,
  );
}

/** What `release_packages.source_json` records for a native publish. */
export function nativeSource(
  principal: PublishPrincipal,
  client: NativeClient,
): PackageSource {
  return principal.kind === "registry"
    ? { kind: "registry", tokenId: principal.tokenId, client }
    : {
        kind: principal.ciKind,
        ...(principal.ciKind === "oidc"
          ? { publisher: `ci:${principal.subject}` }
          : {}),
        tokenId: principal.tokenId,
        client,
      };
}

/** The audit actor of a publish principal. */
export function nativeActor(principal: PublishPrincipal): string {
  return principal.kind === "registry"
    ? `registry-token:${principal.tokenId}`
    : `ci:${principal.subject}`;
}

/** The release descriptor of a native release (what `pkey release publish` would send). */
export function nativeDescriptor(input: {
  product: string;
  deliverable: string;
  ecosystem: PackageEcosystem;
  name: string;
  version: string;
  channel: string | null;
  files: readonly NativeFile[];
  metadata: Record<string, unknown>;
}): PackageReleaseDescriptor {
  return {
    descriptorVersion: 1,
    product: input.product,
    deliverable: input.deliverable,
    kind: "package",
    version: input.version,
    ...(input.channel !== null ? { channel: input.channel } : {}),
    package: {
      ecosystem: input.ecosystem,
      name: input.name,
      files: input.files.map((f) => ({
        name: f.name,
        role: "payload" as const,
        type: f.type,
        sha256: f.sha256,
        size: f.size,
        ...(f.extension !== undefined ? { extension: f.extension } : {}),
        ...(f.classifier !== undefined ? { classifier: f.classifier } : {}),
        locations: [{ provider: "r2" as const, key: blobKey(f.sha256) }],
      })),
      metadata: input.metadata,
    },
  } as PackageReleaseDescriptor;
}

function ingestRefusal(
  r: Extract<PackageIngestResult, { ok: false }>,
): NativeRefusal {
  return nativeRefusal(r.status, r.code, r.reason, r.message);
}

/** Plan `descriptor` as a dry run, its files treated as staged (nothing is written). */
export async function planNative(
  ctx: RegistryRouteContext,
  descriptor: PackageReleaseDescriptor,
  feed: PackageFeedSettings,
  source: PackageSource,
): Promise<{ ok: true } | NativeRefusal> {
  const pending = new Map(
    descriptor.package.files.map((f) => [
      blobKey(f.sha256),
      { sha256: f.sha256, size: f.size },
    ]),
  );
  const plan = await ingestPackageDescriptor(
    ctx.db,
    ctx.env,
    ctx.product.slug,
    descriptor,
    { now: ctx.now, dryRun: true, pendingPromotion: pending, feed, source },
  );
  return plan.ok ? { ok: true } : ingestRefusal(plan);
}

/** Stage one file's bytes under `staging/<owner>/<session>/<sha256>` (create-only, R2-checked). */
export async function stageFile(
  env: Env,
  product: string,
  sessionId: string,
  file: NativeFile,
  bytes: Uint8Array,
): Promise<StagedFile | NativeRefusal> {
  const bucket = env.BLOBS;
  if (!bucket)
    return nativeRefusal(
      503,
      "unavailable",
      "no-blob-store",
      "this environment has no blob store",
    );
  const key = stagingKey(product, sessionId, file.sha256);
  const put = await putVerified(bucket, key, bytes, {
    sha256: file.sha256,
    size: file.size,
  });
  // `exists`: this session staged the same bytes already (a retried request).
  if (!put.ok && put.reason !== "exists")
    return nativeRefusal(
      500,
      "internal_error",
      "staging-failed",
      `${file.name} could not be staged (${put.reason})`,
    );
  return { ...file, staging: key };
}

export type CommitResult =
  | { ok: true; releaseId: string; outcome: "created" | "unchanged" }
  | NativeRefusal;

/**
 * Promote `files` and ingest `descriptor` with them; on success audit the publish and bump the
 * release generation. A failure writes no release (the ingest is one guarded batch); promoted
 * blobs that end up unreferenced are the collector's (P4-14).
 */
export async function commitNative(
  ctx: RegistryRouteContext,
  descriptor: PackageReleaseDescriptor,
  files: readonly StagedFile[],
  feed: PackageFeedSettings,
  principal: PublishPrincipal,
  client: NativeClient,
): Promise<CommitResult> {
  const { env, db, product } = ctx;
  const bucket = env.BLOBS;
  if (!bucket)
    return nativeRefusal(
      503,
      "unavailable",
      "no-blob-store",
      "this environment has no blob store",
    );
  const now = ctx.now;
  const promoted: string[] = [];
  for (const f of files) {
    const target = blobKey(f.sha256);
    if (promoted.includes(target)) continue;
    const res = await promote(
      bucket,
      f.staging,
      target,
      { sha256: f.sha256, size: f.size },
      { db, now, product: product.slug },
    );
    // `alreadyStored` is never read: whether another product holds these bytes is not ours to
    // tell (THREAT-MODEL §3).
    if (!res.ok)
      return nativeRefusal(
        res.reason === "missing" ? 409 : 500,
        res.reason === "missing" ? "bad_request" : "internal_error",
        res.reason === "missing" ? "staged-object-missing" : "promote-failed",
        res.reason === "missing"
          ? `${f.name} is no longer staged (an upload left idle for a day is discarded); publish the version again.`
          : `${f.name} could not be stored (${res.reason}); retry the publish.`,
      );
    promoted.push(target);
  }
  const source = nativeSource(principal, client);
  const result = await ingestPackageDescriptor(
    db,
    env,
    product.slug,
    descriptor,
    { now, promoted, feed, source },
  );
  if (!result.ok) return ingestRefusal(result);
  try {
    await bucket.delete([...new Set(files.map((f) => f.staging))]);
  } catch {
    // Best effort: the bucket's one-day staging rule takes them anyway.
  }
  if (result.outcome !== "unchanged") {
    await appendAudit(db, {
      product: product.slug,
      id: randomId("aud"),
      at: now,
      actor_sub: nativeActor(principal),
      actor_name:
        principal.kind === "registry" ? "Registry token" : "CI (native client)",
      actor_email: null,
      action: "release.publish",
      target_kind: "release",
      target_id: result.releaseId,
      parent_id: null,
      summary: `Published package ${descriptor.package.name} ${descriptor.version} (${result.releaseId}) through ${CLIENT_LABEL[client]} with ${principal.kind === "registry" ? `registry token ${principal.tokenId}` : `CI token ${principal.tokenId}`}`,
    });
    await bumpReleaseGeneration(env, product.slug, now);
  }
  return { ok: true, releaseId: result.releaseId, outcome: result.outcome };
}
