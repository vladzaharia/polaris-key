/**
 * The console's read model of pack deliverables (P4-09, plans/P4-01.md §8.4): the deliverables
 * list, a pack's releases with their variants, sizes, delta menu, yank and "pinned by", and the
 * pins an app release carries. Read-only, built on Release's own `releaseCatalog` hook (what
 * P4-05 serves and update reads) plus one query each over `release_pins` where the hook answers
 * per release and the console needs the whole product at once.
 *
 * Keyed by deliverable, never by "is this product's pack X" (README §11 guardrails, AGENTS rule
 * 5): types, bindings and deliveries are the strings the declarations hold.
 *
 * What is deliberately absent: an object's blob-store key. A gated pack's objects live under
 * `gated/`; the console never names where bytes can be fetched from, only their sizes and hashes.
 */

import type {
  CatalogPackObject,
  CatalogPin,
  CatalogPackRelease,
  Delivery,
  ReleaseCatalog,
} from "../../../core/hooks.js";
import type { Db } from "../../../core/platform.js";
import { listYanks, type ReleaseYankRow } from "../model.js";
import { packReleasesMany } from "./catalog.js";

/** The app deliverable's id; every other deliverable id names a pack. */
const APP = "app";

export interface YankView {
  reason: string;
  at: number;
  by: string;
}

function yankView(y: ReleaseYankRow | undefined): YankView | null {
  return y ? { reason: y.reason, at: y.at, by: y.by } : null;
}

/** One row of `GET …/release/deliverables`. */
export interface DeliverableView {
  id: string;
  /** `app` or `pack` (`release_deliverables.kind`). */
  kind: string;
  /** The pack type (`godot.pck`, `files.tree`, …); null for the app. */
  type: string | null;
  /** False for a pack row whose declaration does not read back (a resync rewrites it). */
  declared: boolean;
  binding: string | null;
  required: boolean | null;
  baseline: string | null;
  delivery: string | null;
  variantKeys: string[];
  /** The licence flag `.pkey/release` asserts; never the gate. */
  assertedEntitlement: string | null;
  /** The delivery GATE (Distribution's `dist_access` row for this deliverable), or null. */
  gate: string | null;
  latest: {
    releaseId: string;
    version: string;
    seq: number | null;
    publishedAt: number | null;
    yanked: boolean;
    /** The latest pack release's signed `entitlement` (the gate CI saw at publish), or null. */
    entitlement: string | null;
  } | null;
  releaseCount: number;
  /** How many distinct app releases pin some release of this pack; null for the app. */
  pinnedByAppReleases: number | null;
}

export interface DeliverablesView {
  deliverables: DeliverableView[];
  /** False while Distribution is off: `gate` is unknown then, not "ungated". */
  gateKnown: boolean;
}

export async function deliverablesView(
  db: Db,
  slug: string,
  catalog: ReleaseCatalog,
  delivery: Delivery | null,
): Promise<DeliverablesView> {
  const all = await catalog.deliverables();
  // The declarations that read back; a pack row whose declaration does not is `declared: false`.
  const declared = new Map(
    (await catalog.packDeliverables()).map((p) => [p.id, p]),
  );
  const pinCounts = new Map(
    (
      await db.all<{ pack_deliverable: string; n: number }>(
        `SELECT pack_deliverable, COUNT(DISTINCT app_release_id) AS n
           FROM release_pins WHERE product = ? GROUP BY pack_deliverable`,
        slug,
      )
    ).map((r) => [r.pack_deliverable, r.n]),
  );
  const out: DeliverableView[] = [];
  for (const d of all) {
    const releases = await catalog.releases(d.id);
    const newest = releases[0] ?? null;
    const isApp = d.id === APP;
    const p = declared.get(d.id) ?? null;
    let entitlement: string | null = null;
    if (newest && !isApp) {
      const pr = await catalog.packRelease(d.id, newest.releaseId);
      entitlement = pr?.entitlement ?? null;
    }
    out.push({
      id: d.id,
      kind: d.kind,
      type: isApp ? null : (p?.packType ?? d.packType ?? null),
      declared: isApp || p !== null,
      binding: p?.binding ?? null,
      required: p ? p.required : null,
      baseline: p?.baseline ?? null,
      delivery: p?.delivery ?? null,
      variantKeys: p?.variantKeys ?? [],
      assertedEntitlement: p?.assertedEntitlement ?? null,
      gate: delivery ? await delivery.entitlement(d.id) : null,
      latest: newest
        ? {
            releaseId: newest.releaseId,
            version: newest.version,
            seq: newest.seq,
            publishedAt: newest.publishedAt,
            yanked: newest.yanked,
            entitlement,
          }
        : null,
      releaseCount: releases.length,
      pinnedByAppReleases: isApp ? null : (pinCounts.get(d.id) ?? 0),
    });
  }
  return { deliverables: out, gateKnown: delivery !== null };
}

/** One entry of a variant's delta menu, as the record gives it. */
export interface DeltaView {
  /** `payload` (one patch frame) or `files` (a per-entry patch set). */
  scope: string;
  method: string | null;
  /** The base release's `payload.sha256`. */
  from: string | null;
  /** The version of this pack's release whose same variant has that payload, when one does. */
  fromVersion: string | null;
  /** Stored bytes a device downloads for this strategy (a files set: descriptor plus data). */
  bytes: number;
  memBytes: number | null;
}

export interface VariantView {
  variantKey: string;
  variant: Record<string, string>;
  engine: string | null;
  payload: { size: number; sha256: string };
  /** Stored bytes of the whole payload object (the `full` strategy). */
  fullBytes: number | null;
  /** Stored bytes of the files index. */
  indexBytes: number | null;
  deltas: DeltaView[];
}

export interface PinnedByView {
  appReleaseId: string;
  /** The app release's version, or null when its row is gone. */
  appVersion: string | null;
  appYank: YankView | null;
  required: boolean;
  delivery: string;
  recordSha256: string;
}

export interface PackReleaseView {
  releaseId: string;
  version: string;
  seq: number | null;
  channel: string | null;
  publishedAt: number | null;
  yank: YankView | null;
  /** Null when the stored record does not read back. */
  recordSha256: string | null;
  formatVersion: number | null;
  entitlement: string | null;
  variants: VariantView[];
  pinnedBy: PinnedByView[];
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

/** A variant's delta menu from its objects: each `delta`, and each `patch` with the `patch-data`
 *  beside it (the record lists them in pairs, in order). */
function deltasOf(objects: CatalogPackObject[]): DeltaView[] {
  const out: DeltaView[] = [];
  const data = objects.filter((o) => o.role === "patch-data");
  let patch = 0;
  for (const o of objects) {
    if (o.role === "delta") {
      out.push({
        scope: "payload",
        method: str(o.meta.method),
        from: str(o.meta.from),
        fromVersion: null,
        bytes: o.bytes,
        memBytes: num(o.meta.memBytes),
      });
    } else if (o.role === "patch") {
      const d = data[patch++];
      out.push({
        scope: "files",
        method: str(o.meta.method),
        from: str(o.meta.from),
        fromVersion: null,
        bytes: o.bytes + (d?.bytes ?? 0),
        memBytes: num(o.meta.memBytes),
      });
    }
  }
  return out;
}

function variantView(v: CatalogPackRelease["variants"][number]): VariantView {
  const role = (r: string) =>
    v.objects.find((o) => o.role === r)?.bytes ?? null;
  return {
    variantKey: v.variantKey,
    variant: v.variant,
    engine: v.engine,
    payload: { size: v.payload.size, sha256: v.payload.sha256 },
    fullBytes: role("payload"),
    indexBytes: role("files-index"),
    deltas: deltasOf(v.objects),
  };
}

/** The most releases one pack page lists (each reads and decodes its stored record). */
export const MAX_PACK_RELEASES_VIEW = 100;

/** The most files one files view returns; `total` says how many the index lists. */
export const MAX_PACK_FILES_VIEW = 2000;

/**
 * A pack's releases, newest first (at most `MAX_PACK_RELEASES_VIEW`), or null when `deliverable`
 * is not a pack this product has.
 * Every release lists the app releases that pin it, a yanked one included (a yank never changes
 * existing pins, CONTENT §6.7).
 */
export async function packReleasesView(
  db: Db,
  slug: string,
  catalog: ReleaseCatalog,
  deliverable: string,
): Promise<PackReleaseView[] | null> {
  if (deliverable === APP) return null;
  const known = (await catalog.deliverables()).some(
    (d) => d.id === deliverable && d.kind !== APP,
  );
  if (!known) return null;
  const yanks = new Map(
    (await listYanks(db, slug)).map((y) => [y.release_id, y]),
  );
  const apps = new Map(
    (
      await db.all<{ release_id: string; version: string }>(
        `SELECT m.release_id, m.version FROM release_metadata m
           JOIN release_pins p ON p.product = m.product AND p.app_release_id = m.release_id
          WHERE m.product = ? AND p.pack_deliverable = ?`,
        slug,
        deliverable,
      )
    ).map((r) => [r.release_id, r.version]),
  );
  const out: PackReleaseView[] = [];
  const listed = (await catalog.releases(deliverable)).slice(
    0,
    MAX_PACK_RELEASES_VIEW,
  );
  const ids = listed.map((r) => r.releaseId);
  // Bounded: the records and the pins of the whole page in chunked `IN` reads, never one query
  // per release.
  const records = await packReleasesMany(db, slug, deliverable, ids);
  const pinsOf = new Map<string, CatalogPin[]>();
  for (const p of await catalog.pinnedByMany(ids))
    pinsOf.set(p.packReleaseId, [...(pinsOf.get(p.packReleaseId) ?? []), p]);
  for (const r of listed) {
    const pr = records.get(r.releaseId) ?? null;
    const pins = pinsOf.get(r.releaseId) ?? [];
    out.push({
      releaseId: r.releaseId,
      version: r.version,
      seq: r.seq,
      channel: r.channel,
      publishedAt: r.publishedAt,
      yank: yankView(yanks.get(r.releaseId)),
      recordSha256: pr?.recordSha256 ?? null,
      formatVersion: pr?.formatVersion ?? null,
      entitlement: pr?.entitlement ?? null,
      variants: pr ? pr.variants.map(variantView) : [],
      pinnedBy: pins.map((p) => ({
        appReleaseId: p.appReleaseId,
        appVersion: apps.get(p.appReleaseId) ?? null,
        appYank: yankView(yanks.get(p.appReleaseId)),
        required: p.required,
        delivery: p.delivery,
        recordSha256: p.recordSha256,
      })),
    });
  }
  // Name each delta's base by version where this pack's same variant had that payload.
  const versionOf = new Map<string, string>();
  for (const r of out)
    for (const v of r.variants)
      versionOf.set(`${v.variantKey}\n${v.payload.sha256}`, r.version);
  for (const r of out)
    for (const v of r.variants)
      for (const d of v.deltas)
        d.fromVersion = d.from
          ? (versionOf.get(`${v.variantKey}\n${d.from}`) ?? null)
          : null;
  return out;
}

/** One file of a pack variant as the console shows it: never its blob-store key. */
export interface PackFileView {
  path: string;
  size: number;
  sha256: string;
  offset: number | null;
  blob: { sha256: string; bytes: number; codec: string };
}

/**
 * One variant's files, read from its files index through the hook's `packFiles` (one index per
 * request, at most `MAX_PUBLISHED_INDEX_BYTES`), or null when the release is not this pack's, or
 * the variant or a readable index does not exist.
 */
export async function packFilesView(
  catalog: ReleaseCatalog,
  deliverable: string,
  releaseId: string,
  variantKey: string,
): Promise<{ files: PackFileView[]; total: number } | null> {
  if (deliverable === APP) return null;
  if (!(await catalog.packRelease(deliverable, releaseId))) return null;
  const files = await catalog.packFiles(releaseId, variantKey);
  if (!files) return null;
  return {
    total: files.length,
    files: files.slice(0, MAX_PACK_FILES_VIEW).map((f) => ({
      path: f.path,
      size: f.size,
      sha256: f.sha256,
      offset: f.offset,
      blob: { sha256: f.blob.sha256, bytes: f.blob.bytes, codec: f.blob.codec },
    })),
  };
}

/** One pin of an app release, with the pinned pack release's version and yank. */
export interface AppPinView {
  pack: string;
  packReleaseId: string;
  packVersion: string | null;
  packYank: YankView | null;
  required: boolean;
  delivery: string;
  recordSha256: string;
}

/** App release ids per `IN` list: one parameter is the product, D1 binds at most 100. */
const PIN_IN_IDS = 90;

interface AppPinRow {
  app_release_id: string;
  pack_deliverable: string;
  pack_release_id: string;
  record_sha256: string;
  required: number;
  delivery: string;
  version: string | null;
}

/** The pins of the listed app releases, keyed by app release id: one chunked `IN` read per
 *  `PIN_IN_IDS` releases, never the whole product's pins. */
export async function appPinsByRelease(
  db: Db,
  slug: string,
  appReleaseIds: readonly string[],
  yanks: ReadonlyMap<string, ReleaseYankRow>,
): Promise<Map<string, AppPinView[]>> {
  const unique = [...new Set(appReleaseIds)];
  const rows: AppPinRow[] = [];
  for (let i = 0; i < unique.length; i += PIN_IN_IDS) {
    const ids = unique.slice(i, i + PIN_IN_IDS);
    rows.push(
      ...(await db.all<AppPinRow>(
        `SELECT p.app_release_id, p.pack_deliverable, p.pack_release_id, p.record_sha256,
              p.required, p.delivery, m.version
         FROM release_pins p
         LEFT JOIN release_metadata m
           ON m.product = p.product AND m.release_id = p.pack_release_id
        WHERE p.product = ? AND p.app_release_id IN (${ids.map(() => "?").join(", ")})
        ORDER BY p.app_release_id, p.pack_deliverable`,
        slug,
        ...ids,
      )),
    );
  }
  const out = new Map<string, AppPinView[]>();
  for (const r of rows) {
    const list = out.get(r.app_release_id) ?? [];
    list.push({
      pack: r.pack_deliverable,
      packReleaseId: r.pack_release_id,
      packVersion: r.version,
      packYank: yankView(yanks.get(r.pack_release_id)),
      required: r.required === 1,
      delivery: r.delivery,
      recordSha256: r.record_sha256,
    });
    out.set(r.app_release_id, list);
  }
  return out;
}

/** A build's `embeds_json` as the console shows it: the pack ids, or null when absent. */
export function embedsOf(json: string | null): string[] | null {
  if (!json) return null;
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v) && v.every((x) => typeof x === "string")
      ? (v as string[])
      : null;
  } catch {
    return null;
  }
}
