/**
 * Apple-hosted asset packs and their retire candidates (P5-08; CONTENT §6.6–§6.7; notes/S-01 §4;
 * notes/E1 §E5). Every `apple-ba` pack has one asset pack per content level
 * (`<pack>-c<contentApi>`, `@polaris-key/manifest`'s `assetPackId`), and a live asset-pack version
 * switches every installed app version, so an asset pack whose level no app release is live at
 * any more is only quota: Apple allows 200 asset packs and 200 GB per app.
 *
 * This is a READ for the operator (`GET …/distribution/asset-packs`, the console API). It lists
 * what Polaris Key knows of each asset pack, from two sources:
 *
 *   - the App Store Connect connector's stored objects (`backgroundAssetVersions` and their
 *     release kinds; P5-02), whose `ref_json` carries `assetPackIdentifier`,
 *     `ascBackgroundAssetId` and `ascBackgroundAssetVersionId`;
 *   - CI-reported availability (`pkey transport apple-ba package|upload`), whose `platformRef`
 *     carries the same ids.
 *
 * Archiving (`PATCH /v1/backgroundAssets/{id}` `{archived: true}`) is irreversible and the id can
 * never be reused (S-01 §4), so nothing here archives: the operator archives a candidate in App
 * Store Connect.
 */

import { APP_DELIVERABLE_ID, parseAssetPackId } from "@polaris-key/manifest";
import type { Db } from "../../core/platform.js";
import type { ReleaseCatalog } from "../../core/hooks.js";

/** Apple's per-app limits (ASC Help "Apple-hosted asset pack size limits"; notes/S-07 row 16). */
export const ASSET_PACK_QUOTA = {
  maxPacks: 200,
  maxBytes: 200 * 1000 * 1000 * 1000,
} as const;

export interface AssetPackEntry {
  assetPackIdentifier: string;
  /** The content level the id names, or null when it does not follow `<base>-c<level>`. */
  level: number | null;
  /** The pack id it was resolved to (a linked pack release's deliverable), or null. */
  packId: string | null;
  ascBackgroundAssetId: string | null;
  /** The newest asset-pack version Polaris Key saw, with the states it knows of it. */
  newestVersion: {
    ascBackgroundAssetVersionId: string;
    version: string | number | null;
    releaseId: string | null;
    states: Record<string, string | null>;
  } | null;
  /** Bytes Apple reported (`usedBytes`/`size`), when it did. */
  bytes: number | null;
  /** Whether its level is a live contentApi level of the app on some channel. */
  live: boolean;
  /** Not live: its versions only use quota (archive it in App Store Connect when done). */
  retireCandidate: boolean;
}

export interface AssetPackListing {
  liveLevels: number[];
  assetPacks: AssetPackEntry[];
  quota: {
    packs: number;
    maxPacks: number;
    /** The sum of the known sizes, null when Apple reported none. */
    bytes: number | null;
    maxBytes: number;
  };
}

function obj(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

/** The live content levels of the app, over every known channel. */
export async function liveContentLevels(
  catalog: ReleaseCatalog | null,
): Promise<number[]> {
  if (!catalog) return [];
  const levels = new Set<number>();
  for (const channel of new Set(await catalog.knownChannels()))
    for (const l of await catalog.liveLevels(APP_DELIVERABLE_ID, channel))
      if (l.appReleases.length) levels.add(l.contentApi);
  return [...levels].sort((a, b) => a - b);
}

export async function listAssetPacks(
  db: Db,
  product: string,
  catalog: ReleaseCatalog | null,
): Promise<AssetPackListing> {
  interface Seen {
    version: string | number | null;
    releaseId: string | null;
    states: Record<string, string | null>;
    at: number;
  }
  interface Acc {
    entry: AssetPackEntry;
    versions: Map<string, Seen>;
  }
  const byId = new Map<string, Acc>();
  const acc = (identifier: string): Acc => {
    let a = byId.get(identifier);
    if (!a) {
      const parsed = parseAssetPackId(identifier);
      a = {
        entry: {
          assetPackIdentifier: identifier,
          level: parsed?.level ?? null,
          packId: null,
          ascBackgroundAssetId: null,
          newestVersion: null,
          bytes: null,
          live: false,
          retireCandidate: false,
        },
        versions: new Map(),
      };
      byId.set(identifier, a);
    }
    return a;
  };
  const releaseDeliverable = new Map<string, string | null>();
  const deliverableOf = async (releaseId: string): Promise<string | null> => {
    if (!releaseDeliverable.has(releaseId)) {
      const r = catalog ? await catalog.release(releaseId) : null;
      releaseDeliverable.set(
        releaseId,
        r && r.deliverableId !== APP_DELIVERABLE_ID ? r.deliverableId : null,
      );
    }
    return releaseDeliverable.get(releaseId) ?? null;
  };
  const note = async (
    ref: Record<string, unknown>,
    releaseId: string | null,
    stateKey: string,
    state: string | null,
    at: number,
    detail: Record<string, unknown>,
  ) => {
    const identifier = str(ref.assetPackIdentifier);
    if (!identifier) return;
    const a = acc(identifier);
    a.entry.ascBackgroundAssetId ??= str(ref.ascBackgroundAssetId);
    const pack = releaseId ? await deliverableOf(releaseId) : null;
    if (pack) a.entry.packId ??= pack;
    const bytes = num(detail.usedBytes) ?? num(detail.size);
    if (bytes !== null) a.entry.bytes = Math.max(a.entry.bytes ?? 0, bytes);
    const vid = str(ref.ascBackgroundAssetVersionId);
    if (!vid) return;
    const v = a.versions.get(vid) ?? {
      version: null,
      releaseId: null,
      states: {},
      at: 0,
    };
    v.version ??=
      str(detail.version) ??
      num(detail.version) ??
      str(ref.ascVersion) ??
      num(ref.ascVersion);
    v.releaseId ??= releaseId;
    v.states[stateKey] = state;
    v.at = Math.max(v.at, at);
    a.versions.set(vid, v);
  };

  for (const row of await db.all<{
    object_type: string;
    release_id: string | null;
    store_state: string | null;
    ref_json: string | null;
    detail_json: string | null;
    updated_at: number;
  }>(
    `SELECT object_type, release_id, store_state, ref_json, detail_json, updated_at
       FROM dist_connector_objects
      WHERE product = ? AND connector = 'asc' AND object_type LIKE 'backgroundAsset%'
      ORDER BY updated_at`,
    product,
  ))
    await note(
      obj(row.ref_json),
      row.release_id,
      row.object_type,
      row.store_state,
      row.updated_at,
      obj(row.detail_json),
    );
  for (const row of await db.all<{
    release_id: string;
    outlet_id: string;
    state: string;
    platform_ref_json: string | null;
    updated_at: number;
  }>(
    `SELECT release_id, outlet_id, state, platform_ref_json, updated_at FROM dist_availability
      WHERE product = ? AND json_extract(platform_ref_json, '$.assetPackIdentifier') IS NOT NULL
      ORDER BY updated_at`,
    product,
  ))
    await note(
      obj(row.platform_ref_json),
      row.release_id,
      `availability:${row.outlet_id}`,
      row.state,
      row.updated_at,
      {},
    );

  const liveLevels = await liveContentLevels(catalog);
  const assetPacks: AssetPackEntry[] = [];
  let bytes: number | null = null;
  for (const a of [...byId.values()].sort((x, y) =>
    x.entry.assetPackIdentifier < y.entry.assetPackIdentifier ? -1 : 1,
  )) {
    // The newest version: the highest version number, else the latest seen.
    const rank = (v: Seen) =>
      typeof v.version === "number" ? v.version : Number(v.version);
    let newest: [string, Seen] | null = null;
    for (const [id, v] of a.versions) {
      if (!newest) {
        newest = [id, v];
        continue;
      }
      const n = rank(v);
      const m = rank(newest[1]);
      if (
        Number.isFinite(n) && Number.isFinite(m) ? n > m : v.at > newest[1].at
      )
        newest = [id, v];
    }
    a.entry.newestVersion = newest
      ? {
          ascBackgroundAssetVersionId: newest[0],
          version: newest[1].version,
          releaseId: newest[1].releaseId,
          states: newest[1].states,
        }
      : null;
    a.entry.live = a.entry.level !== null && liveLevels.includes(a.entry.level);
    a.entry.retireCandidate = a.entry.level !== null && !a.entry.live;
    if (a.entry.bytes !== null) bytes = (bytes ?? 0) + a.entry.bytes;
    assetPacks.push(a.entry);
  }
  return {
    liveLevels,
    assetPacks,
    quota: {
      packs: assetPacks.length,
      maxPacks: ASSET_PACK_QUOTA.maxPacks,
      bytes,
      maxBytes: ASSET_PACK_QUOTA.maxBytes,
    },
  };
}
