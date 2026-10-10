/**
 * The pack half of Release's `releaseCatalog` hook (P4-02, plans/P4-01.md §6): declared packs,
 * pack releases with their variants and objects, a variant's files, pins and embeds — what P4-05
 * serves, P4-09 shows and update reads. Read-only (a hook never writes), and keyed by
 * deliverable, never by "is a pack" (README §11 guardrails).
 *
 * A pack release's variants and objects come from its stored, signed record (the record is the
 * whole truth); its files come from its files index, and (P4-22) the chunks it reads from chunk
 * bundles from its chunk index, each read from the blob store and decoded one index per call
 * under `MAX_PUBLISHED_INDEX_BYTES` (decision 36).
 */

import {
  MAX_PUBLISHED_INDEX_BYTES,
  packVariantKeys,
} from "@polaris-key/manifest";
import {
  parseChunkIndex,
  parseFilesIndex,
  variantKey,
} from "@polaris-key/client-core/packs";
import type { PackRecordDoc, PayloadDelta } from "@polaris-key/protocol/packs";
import { decode as zstdDecode } from "@polaris-key/zstd-wasm";
import type {
  CatalogHold,
  CatalogBuildEmbeds,
  CatalogLazyDelta,
  CatalogPackChunk,
  CatalogPackDeliverable,
  CatalogPackFile,
  CatalogPackFloor,
  CatalogPackPayload,
  CatalogPackRelease,
  CatalogPin,
  CatalogRelease,
  CatalogRevocation,
  ReleaseCatalog,
} from "../../../core/hooks.js";
import { APP_DELIVERABLE_ID } from "@polaris-key/manifest";
import { canonicalChannel } from "../resolve.js";
import {
  canonicalPackChannel,
  loadResolutionState,
  readStoredSets,
} from "./sets.js";
import { PackResolver } from "./resolve.js";
import type { Db } from "../../../db/types.js";
import type { Env } from "../../../env.js";
import { blobKey } from "../../../core/blobs.js";
import { readPackDeliverables } from "./deliverables.js";
import { packObjects, storedRecordPayload, variantBuildId } from "./ingest.js";
import { readAllRevocations } from "./revocations.js";
import {
  HOT_WINDOW_SECONDS,
  installedBase,
  lazyDeltasEnabled,
} from "../../../core/deltaDemand.js";
import { menuEntryOf, readyLazyDeltas } from "./deltas/menu.js";
import { readyDeltasTo } from "./deltas/store.js";

type PackCatalog = Pick<
  ReleaseCatalog,
  | "packDeliverables"
  | "packRelease"
  | "packFiles"
  | "packChunks"
  | "packPayload"
  | "lazyDeltas"
  | "lazyDeltaDevices"
  | "pins"
  | "pinnedBy"
  | "embeds"
  | "liveLevels"
  | "packSets"
  | "packFloors"
  | "holdsFor"
  | "heldBy"
  | "pinnedByMany"
  | "embedsOf"
  | "revocations"
>;

interface HoldRow {
  app_release_id: string;
  pack_deliverable: string;
  pack_release_id: string;
  record_sha256: string;
  reason: string | null;
}

function holdRecord(r: HoldRow): CatalogHold {
  return {
    appReleaseId: r.app_release_id,
    pack: r.pack_deliverable,
    packReleaseId: r.pack_release_id,
    recordSha256: r.record_sha256,
    reason: r.reason,
  };
}

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

interface PackRecordRow {
  release_id: string;
  jws: string;
  record_sha256: string;
  deliverable_id: string;
  version: string;
  seq: number | null;
  channel: string | null;
  published_at: number | null;
  yanked: number;
  /** P4-19: the delegation a content key signed it under, or null (a release key). */
  delegation: string | null;
}

interface FoundPackRecord {
  record: PackRecordDoc;
  sha256: string;
  delegation: string | null;
  release: CatalogRelease;
}

const PACK_RECORD_SELECT = `SELECT r.release_id, r.jws, r.record_sha256, m.deliverable_id, m.version, m.seq,
            m.channel, m.published_at,
            EXISTS (SELECT 1 FROM release_yanks y
                     WHERE y.product = m.product AND y.release_id = m.release_id) AS yanked,
            (SELECT d.delegation_sha256 FROM release_delegated_records d
              WHERE d.product = r.product AND d.record_sha256 = r.record_sha256) AS delegation
       FROM release_records r
       JOIN release_metadata m ON m.product = r.product AND m.release_id = r.release_id`;

function foundOf(row: PackRecordRow): FoundPackRecord | null {
  const payload = storedRecordPayload(row.jws);
  if (!payload || payload.kind !== "pack") return null;
  return {
    record: payload as unknown as PackRecordDoc,
    sha256: row.record_sha256,
    delegation: row.delegation ?? null,
    release: {
      deliverableId: row.deliverable_id,
      releaseId: row.release_id,
      version: row.version,
      seq: row.seq,
      channel: row.channel,
      publishedAt: row.published_at,
      yanked: Boolean(row.yanked),
    },
  };
}

/** A pack release's stored record and release row, or null. */
async function packRecordOf(
  db: Db,
  product: string,
  releaseId: string,
): Promise<FoundPackRecord | null> {
  const row = await db.first<PackRecordRow>(
    `${PACK_RECORD_SELECT}
      WHERE r.product = ? AND r.release_id = ? AND r.kind = 'pack'`,
    product,
    releaseId,
  );
  return row ? foundOf(row) : null;
}

/** The hook's view of one stored pack record: its variants and the objects each names. */
function packReleaseView(found: FoundPackRecord): CatalogPackRelease {
  const { record } = found;
  const objects = packObjects(record);
  return {
    release: found.release,
    recordSha256: found.sha256,
    delegation: found.delegation,
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
}

/**
 * `packRelease` for many releases of one pack in bounded queries (P4-09's pack page): one
 * chunked `IN` per `IN_IDS` ids, keyed by release id. A release of another deliverable, or one
 * whose record does not read back, is absent.
 */
export async function packReleasesMany(
  db: Db,
  product: string,
  deliverableId: string,
  releaseIds: readonly string[],
): Promise<Map<string, CatalogPackRelease>> {
  const out = new Map<string, CatalogPackRelease>();
  for (const ids of chunked(releaseIds)) {
    const rows = await db.all<PackRecordRow>(
      `${PACK_RECORD_SELECT}
        WHERE r.product = ? AND r.kind = 'pack'
          AND r.release_id IN (${ids.map(() => "?").join(", ")})`,
      product,
      ...ids,
    );
    for (const row of rows) {
      const found = foundOf(row);
      if (found && found.release.deliverableId === deliverableId)
        out.set(row.release_id, packReleaseView(found));
    }
  }
  return out;
}

/** How many of a pack's newest releases `packPayload` reads, a page at a time (P4-18). A payload
 *  older than that answers not-found on the payload URL, and the SDK takes the blob route. */
export const MAX_PAYLOAD_SCAN = 200;
const PAYLOAD_SCAN_PAGE = 20;

/** The payload URL's view of one variant (`packPayload`), or null for a tree or another hash. */
function payloadView(
  found: FoundPackRecord,
  buildId: string,
  payloadSha256: string,
): CatalogPackPayload | null {
  const v = found.record.variants.find(
    (x) => variantBuildId(x.variant) === buildId,
  );
  if (
    !v ||
    v.files?.layout !== "container" ||
    v.payload?.sha256 !== payloadSha256
  )
    return null;
  return {
    releaseId: found.release.releaseId,
    gated: found.record.entitlement !== undefined,
    payload: { size: v.payload.size, sha256: v.payload.sha256 },
    full: {
      sha256: v.full.sha256,
      bytes: v.full.bytes,
      size: v.full.size,
      codec: v.full.codec,
    },
    deltas: (v.deltas ?? [])
      .filter(
        (d): d is PayloadDelta =>
          d.scope === "payload" && d.method === "zstd-patch-from",
      )
      .map((d) => ({
        from: d.from,
        artifact: { sha256: d.artifact.sha256, bytes: d.artifact.bytes },
      })),
  };
}

/** How many payloads `installedBase` ranks per pack for the menu (P4-29). */
const MENU_BASE_SCAN = 1000;

export function packCatalog(ctx: {
  db: Db;
  env: Env;
  slug: string;
  /** Epoch seconds (the request's); the menu's installed-base window ends here. */
  now?: number;
}): PackCatalog {
  const { db, env, slug } = ctx;
  const now = (): number => ctx.now ?? Math.floor(Date.now() / 1000);
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
      return packReleaseView(found);
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

    async packChunks(releaseId, key): Promise<CatalogPackChunk[] | null> {
      // P4-22 (plans/P4-10.md decision 16): what the collector keeps a bundle alive by.
      const found = await packRecordOf(db, slug, releaseId);
      const bucket = env.BLOBS;
      if (!found || !bucket) return null;
      const v = found.record.variants.find(
        (x) => variantKey(x.variant) === key,
      );
      const c = v?.chunks;
      if (!v || !c) return null;
      if (
        c.size > MAX_PUBLISHED_INDEX_BYTES ||
        c.bytes > MAX_PUBLISHED_INDEX_BYTES
      )
        return null;
      const gated = found.record.entitlement !== undefined;
      const obj = await bucket.get(blobKey(c.sha256, { gated }));
      if (!obj || !("arrayBuffer" in obj) || obj.size !== c.bytes) return null;
      const parsed = await parseChunkIndex(
        new Uint8Array(await obj.arrayBuffer()),
        c,
        v.payload,
        {
          decode: (frame, size) => zstdDecode(frame, size),
          maxBytes: MAX_PUBLISHED_INDEX_BYTES,
        },
      );
      if (!parsed.ok) return null;
      // One entry per stored location (duplicate ids share one), in record order.
      const keys = parsed.index.bundles.map(([sha]) => blobKey(sha, { gated }));
      const seen = new Set<string>();
      const out: CatalogPackChunk[] = [];
      for (const [, , clen, bundle, offset] of parsed.index.records) {
        const at = `${bundle}:${offset}`;
        if (seen.has(at)) continue;
        seen.add(at);
        out.push({ bundleKey: keys[bundle]!, offset, bytes: clen });
      }
      return out;
    },

    async packPayload(deliverableId, buildId, payloadSha256) {
      // P4-18: the record is the truth, and no column holds a variant's payload hash, so the
      // pack's releases are read newest first (the target of an update is nearly always the
      // first), a page at a time, at most `MAX_PAYLOAD_SCAN`.
      for (let at = 0; at < MAX_PAYLOAD_SCAN; at += PAYLOAD_SCAN_PAGE) {
        const rows = await db.all<PackRecordRow>(
          `${PACK_RECORD_SELECT}
            WHERE r.product = ? AND r.kind = 'pack' AND m.deliverable_id = ?
            ORDER BY m.seq DESC, r.release_id DESC LIMIT ? OFFSET ?`,
          slug,
          deliverableId,
          PAYLOAD_SCAN_PAGE,
          at,
        );
        for (const row of rows) {
          const found = foundOf(row);
          const view = found
            ? payloadView(found, buildId, payloadSha256)
            : null;
          if (view) {
            // P4-29 (plans/P4-29.md §6.3): the payload's ready lazy deltas too, under P4-17's
            // two switches, after the record's own (a record delta of the same base wins).
            if (await lazyDeltasEnabled(env, db, slug)) {
              const bases = new Set(view.deltas.map((d) => d.from));
              const ids = new Set(view.deltas.map((d) => d.artifact.sha256));
              for (const r of await readyDeltasTo(db, slug, payloadSha256)) {
                if (r.deliverableId !== deliverableId) continue;
                const e = menuEntryOf(r);
                if (!e || e.method !== "zstd-patch-from") continue;
                if (bases.has(e.from) || ids.has(e.artifact.sha256)) continue;
                bases.add(e.from);
                ids.add(e.artifact.sha256);
                view.deltas.push({ from: e.from, artifact: e.artifact });
              }
            }
            return view;
          }
        }
        if (rows.length < PAYLOAD_SCAN_PAGE) break;
      }
      return null;
    },

    async lazyDeltas(recordSha256s): Promise<CatalogLazyDelta[]> {
      // P4-29 (plans/P4-29.md §6.1): nothing while either P4-17 switch is off.
      if (recordSha256s.length === 0) return [];
      if (!(await lazyDeltasEnabled(env, db, slug))) return [];
      const ready = await readyLazyDeltas(db, slug);
      if (ready.length === 0) return [];
      const byTo = new Map<string, typeof ready>();
      for (const r of ready) {
        const list = byTo.get(r.to);
        if (list) list.push(r);
        else byTo.set(r.to, [r]);
      }
      const out: CatalogLazyDelta[] = [];
      for (const ids of chunked(recordSha256s)) {
        const rows = await db.all<PackRecordRow>(
          `${PACK_RECORD_SELECT}
            WHERE r.product = ? AND r.kind = 'pack'
              AND r.record_sha256 IN (${ids.map(() => "?").join(", ")})
            ORDER BY r.record_sha256`,
          slug,
          ...ids,
        );
        for (const row of rows) {
          const found = foundOf(row);
          if (!found) continue;
          const deliverable = found.release.deliverableId;
          for (const v of found.record.variants) {
            if (v.files?.layout !== "container") continue;
            const to = v.payload?.sha256;
            for (const r of byTo.get(to) ?? []) {
              if (r.deliverableId !== deliverable) continue;
              const entry = menuEntryOf(r);
              if (!entry) continue;
              const covered = (v.deltas ?? []).some(
                (d) =>
                  d.scope === "payload" &&
                  d.from === entry.from &&
                  d.method === entry.method,
              );
              if (covered) continue;
              out.push({
                recordSha256: found.sha256,
                deliverableId: deliverable,
                to,
                entry,
                createdAt: r.createdAt,
              });
            }
          }
        }
      }
      return out;
    },

    async lazyDeltaDevices(bases): Promise<number[]> {
      // P4-29: the menu's rank, read only on the feed's sign path (the seq hash ignores it).
      const since = now() - HOT_WINDOW_SECONDS;
      const byDeliverable = new Map<string, Map<string, number>>();
      for (const d of new Set(bases.map((b) => b.deliverableId))) {
        const rows = await installedBase(db, slug, d, 1, since, MENU_BASE_SCAN);
        byDeliverable.set(d, new Map(rows.map((x) => [x.payload, x.devices])));
      }
      return bases.map(
        (b) => byDeliverable.get(b.deliverableId)?.get(b.from) ?? 0,
      );
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

    async liveLevels(appDeliverable, channel) {
      if (appDeliverable !== APP_DELIVERABLE_ID) return [];
      const state = await loadResolutionState(db, slug);
      if (!state) return [];
      const canonical = canonicalChannel(channel, state.input.app.manual);
      if (!canonical || !state.input.channels.includes(canonical)) return [];
      const levels = new Map<number, string[]>();
      for (const r of new PackResolver(state.input).live(canonical)) {
        const list = levels.get(r.contentApi) ?? [];
        list.push(r.releaseId);
        levels.set(r.contentApi, list);
      }
      return [...levels.entries()]
        .sort(([a], [b]) => a - b)
        .map(([contentApi, appReleases]) => ({ contentApi, appReleases }));
    },

    async packSets(channel) {
      return readStoredSets(db, slug, channel);
    },

    async packFloors(channel): Promise<CatalogPackFloor[]> {
      const canonical = await canonicalPackChannel(db, slug, channel);
      return (
        await db.all<{
          deliverable_id: string;
          channel: string;
          content_api: number;
          min_version: string;
          modified_at: number;
        }>(
          `SELECT deliverable_id, channel, content_api, min_version, modified_at
             FROM release_pack_floors WHERE product = ? AND channel = ?
            ORDER BY deliverable_id, content_api`,
          slug,
          canonical,
        )
      ).map((r) => ({
        deliverableId: r.deliverable_id,
        channel: r.channel,
        contentApi: r.content_api,
        minSupported: r.min_version,
        modifiedAt: r.modified_at,
      }));
    },

    async holdsFor(appReleaseId) {
      return (
        await db.all<HoldRow>(
          `SELECT app_release_id, pack_deliverable, pack_release_id, record_sha256, reason
             FROM release_holds WHERE product = ? AND app_release_id = ?
            ORDER BY pack_deliverable`,
          slug,
          appReleaseId,
        )
      ).map(holdRecord);
    },

    async heldBy(packReleaseId) {
      return (
        await db.all<HoldRow>(
          `SELECT app_release_id, pack_deliverable, pack_release_id, record_sha256, reason
             FROM release_holds WHERE product = ? AND pack_release_id = ?
            ORDER BY app_release_id`,
          slug,
          packReleaseId,
        )
      ).map(holdRecord);
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

    async revocations(): Promise<CatalogRevocation[]> {
      return readAllRevocations(db, slug);
    },
  };
}
