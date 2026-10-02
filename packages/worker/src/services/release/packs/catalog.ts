/**
 * The pack half of Release's `releaseCatalog` hook (P4-02, plans/P4-01.md §6): declared packs,
 * pack releases with their variants and objects, a variant's files, pins and embeds — what P4-05
 * serves, P4-09 shows and update reads. Read-only (a hook never writes), and keyed by
 * deliverable, never by "is a pack" (README §11 guardrails).
 *
 * A pack release's variants and objects come from its stored, signed record (the record is the
 * whole truth); its files come from its files index, read from the blob store and decoded one
 * index per call under `MAX_PUBLISHED_INDEX_BYTES` (decision 36).
 */

import {
  MAX_PUBLISHED_INDEX_BYTES,
  packVariantKeys,
} from "@polaris-key/manifest";
import { parseFilesIndex, variantKey } from "@polaris-key/client-core/packs";
import type { PackRecordDoc } from "@polaris-key/protocol/packs";
import { decode as zstdDecode } from "@polaris-key/zstd-wasm";
import type {
  CatalogBuildEmbeds,
  CatalogPackDeliverable,
  CatalogPackFile,
  CatalogPackRelease,
  CatalogPin,
  CatalogRelease,
  ReleaseCatalog,
} from "../../../core/hooks.js";
import type { Db, Env } from "../../../core/platform.js";
import { blobKey } from "../../../core/blobs.js";
import { readPackDeliverables } from "./deliverables.js";
import { packObjects, storedRecordPayload, variantBuildId } from "./ingest.js";

type PackCatalog = Pick<
  ReleaseCatalog,
  | "packDeliverables"
  | "packRelease"
  | "packFiles"
  | "pins"
  | "pinnedBy"
  | "embeds"
  | "pinnedByMany"
  | "embedsOf"
>;

/** Ids per `IN` list: one parameter is the product, D1 binds at most 100. */
const IN_IDS = 90;

function chunked<T>(rows: readonly T[]): T[][] {
  const out: T[][] = [];
  const unique = [...new Set(rows)];
  for (let i = 0; i < unique.length; i += IN_IDS)
    out.push(unique.slice(i, i + IN_IDS));
  return out;
}

function embedsColumn(raw: string | null): string[] | null {
  if (!raw) return null;
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) && v.every((x) => typeof x === "string")
      ? (v as string[])
      : null;
  } catch {
    return null;
  }
}

interface PinRow {
  app_release_id: string;
  pack_deliverable: string;
  pack_release_id: string;
  record_sha256: string;
  required: number;
  delivery: string;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function pinRecord(r: PinRow): CatalogPin {
  return {
    appReleaseId: r.app_release_id,
    pack: r.pack_deliverable,
    packReleaseId: r.pack_release_id,
    recordSha256: r.record_sha256,
    required: r.required === 1,
    delivery: r.delivery,
  };
}

/** A pack release's stored record and release row, or null. */
async function packRecordOf(
  db: Db,
  product: string,
  releaseId: string,
): Promise<{
  record: PackRecordDoc;
  sha256: string;
  release: CatalogRelease;
} | null> {
  const row = await db.first<{
    jws: string;
    record_sha256: string;
    deliverable_id: string;
    version: string;
    seq: number | null;
    channel: string | null;
    published_at: number | null;
    yanked: number;
  }>(
    `SELECT r.jws, r.record_sha256, m.deliverable_id, m.version, m.seq, m.channel,
            m.published_at,
            EXISTS (SELECT 1 FROM release_yanks y
                     WHERE y.product = m.product AND y.release_id = m.release_id) AS yanked
       FROM release_records r
       JOIN release_metadata m ON m.product = r.product AND m.release_id = r.release_id
      WHERE r.product = ? AND r.release_id = ? AND r.kind = 'pack'`,
    product,
    releaseId,
  );
  if (!row) return null;
  const payload = storedRecordPayload(row.jws);
  if (!payload || payload.kind !== "pack") return null;
  return {
    record: payload as unknown as PackRecordDoc,
    sha256: row.record_sha256,
    release: {
      deliverableId: row.deliverable_id,
      releaseId,
      version: row.version,
      seq: row.seq,
      channel: row.channel,
      publishedAt: row.published_at,
      yanked: Boolean(row.yanked),
    },
  };
}

export function packCatalog(ctx: {
  db: Db;
  env: Env;
  slug: string;
}): PackCatalog {
  const { db, env, slug } = ctx;
  return {
    async packDeliverables(): Promise<CatalogPackDeliverable[]> {
      // Discovery lists what reads back; a publish refuses while any declaration does not.
      return (await readPackDeliverables(db, slug)).packs.map((p) => ({
        id: p.id,
        packType: p.type,
        binding: p.binding,
        baseline: p.baseline,
        required: p.required,
        delivery: p.delivery,
        variantKeys: packVariantKeys(p),
        assertedEntitlement: p.entitlement,
      }));
    },

    async packRelease(deliverableId, releaseId) {
      const found = await packRecordOf(db, slug, releaseId);
      if (!found || found.release.deliverableId !== deliverableId) return null;
      const { record } = found;
      const objects = packObjects(record);
      const out: CatalogPackRelease = {
        release: found.release,
        recordSha256: found.sha256,
        type: record.type,
        formatVersion: record.formatVersion,
        entitlement: record.entitlement ?? null,
        handler: record.handler ?? null,
        variants: record.variants.map((v) => {
          const buildId = variantBuildId(v.variant);
          return {
            variantKey: variantKey(v.variant),
            buildId,
            variant: v.variant,
            payload: v.payload,
            engine:
              typeof v.requires?.engine === "string" ? v.requires.engine : null,
            objects: objects
              .filter((o) => o.buildId === buildId)
              .map((o) => ({
                role: o.role,
                sha256: o.sha256,
                bytes: o.bytes,
                key: o.key,
                meta: o.meta,
              })),
          };
        }),
      };
      return out;
    },

    async packFiles(releaseId, key): Promise<CatalogPackFile[] | null> {
      const found = await packRecordOf(db, slug, releaseId);
      const bucket = env.BLOBS;
      if (!found || !bucket) return null;
      const v = found.record.variants.find(
        (x) => variantKey(x.variant) === key,
      );
      if (!v) return null;
      if (
        v.files.size > MAX_PUBLISHED_INDEX_BYTES ||
        v.files.bytes > MAX_PUBLISHED_INDEX_BYTES
      )
        return null;
      const gated = found.record.entitlement !== undefined;
      const obj = await bucket.get(blobKey(v.files.sha256, { gated }));
      if (!obj || !("arrayBuffer" in obj) || obj.size !== v.files.bytes)
        return null;
      const parsed = await parseFilesIndex(
        new Uint8Array(await obj.arrayBuffer()),
        v.files,
        v,
        {
          decode: (frame, size) => zstdDecode(frame, size),
          maxBytes: MAX_PUBLISHED_INDEX_BYTES,
        },
      );
      if (!parsed.ok) return null;
      return parsed.index.files.map((e) => ({
        path: e.path,
        size: e.size,
        sha256: e.sha256,
        offset: typeof e.offset === "number" ? e.offset : null,
        blob: {
          sha256: e.blob.sha256,
          bytes: e.blob.bytes,
          codec: e.blob.codec,
          key: blobKey(e.blob.sha256, { gated }),
        },
      }));
    },

    async pins(appReleaseId) {
      return (
        await db.all<PinRow>(
          `SELECT app_release_id, pack_deliverable, pack_release_id, record_sha256, required,
                  delivery
             FROM release_pins WHERE product = ? AND app_release_id = ?
            ORDER BY pack_deliverable`,
          slug,
          appReleaseId,
        )
      ).map(pinRecord);
    },

    async pinnedBy(packReleaseId) {
      return (
        await db.all<PinRow>(
          `SELECT app_release_id, pack_deliverable, pack_release_id, record_sha256, required,
                  delivery
             FROM release_pins WHERE product = ? AND pack_release_id = ?
            ORDER BY app_release_id`,
          slug,
          packReleaseId,
        )
      ).map(pinRecord);
    },

    async embeds(appReleaseId, buildId) {
      const row = await db.first<{ embeds_json: string | null }>(
        `SELECT embeds_json FROM release_builds
          WHERE product = ? AND release_id = ? AND build_id = ?`,
        slug,
        appReleaseId,
        buildId,
      );
      return embedsColumn(row?.embeds_json ?? null);
    },

    async pinnedByMany(packReleaseIds) {
      const out: CatalogPin[] = [];
      for (const ids of chunked(packReleaseIds)) {
        const rows = await db.all<PinRow>(
          `SELECT app_release_id, pack_deliverable, pack_release_id, record_sha256, required,
                  delivery
             FROM release_pins
            WHERE product = ? AND pack_release_id IN (${ids.map(() => "?").join(", ")})`,
          slug,
          ...ids,
        );
        out.push(...rows.map(pinRecord));
      }
      return out.sort(
        (a, b) =>
          cmp(a.packReleaseId, b.packReleaseId) ||
          cmp(a.appReleaseId, b.appReleaseId),
      );
    },

    async embedsOf(appReleaseIds) {
      const out: CatalogBuildEmbeds[] = [];
      for (const ids of chunked(appReleaseIds)) {
        const rows = await db.all<{
          release_id: string;
          build_id: string;
          platform: string | null;
          embeds_json: string | null;
        }>(
          `SELECT release_id, build_id, platform, embeds_json FROM release_builds
            WHERE product = ? AND release_id IN (${ids.map(() => "?").join(", ")})`,
          slug,
          ...ids,
        );
        for (const r of rows)
          out.push({
            releaseId: r.release_id,
            buildId: r.build_id,
            platform: r.platform,
            embeds: embedsColumn(r.embeds_json),
          });
      }
      return out.sort(
        (a, b) => cmp(a.releaseId, b.releaseId) || cmp(a.buildId, b.buildId),
      );
    },
  };
}
