/**
 * The package readers of Release's `releaseCatalog` hook (F-03, plans/F-01.md §6.3): what the
 * package feeds (F-04 to F-09, through Distribution's materialiser) and the console (F-11) read.
 * Read-only, plain records in Core's shapes (`core/hooks.ts`), never this service's row types.
 */

import type {
  CatalogPackageDeliverable,
  CatalogPackageFile,
  CatalogPackageVersion,
  ReleaseCatalog,
} from "../../../core/hooks.js";
import {
  parseJsonArray,
  parseJsonObject,
  type Db,
} from "../../../core/platform.js";
import { parseManualChannels } from "../channels.js";
import { getReleaseConfig } from "../config.js";
import {
  canonicalChannel,
  knownChannels,
  resolveChannelReleases,
} from "../resolve.js";
import { readPackageDeliverables } from "./ingest.js";

type PackageCatalog = Pick<
  ReleaseCatalog,
  "packageDeliverables" | "packageVersions" | "packageChannelHeads"
>;

/** A `files_json` entry, read defensively (a hand-edited row drops the entry, never throws). */
function fileRecord(v: unknown): CatalogPackageFile | null {
  if (!v || typeof v !== "object") return null;
  const f = v as Record<string, unknown>;
  if (
    typeof f.name !== "string" ||
    typeof f.type !== "string" ||
    typeof f.sha256 !== "string" ||
    typeof f.size !== "number"
  )
    return null;
  const out: CatalogPackageFile = {
    name: f.name,
    type: f.type,
    sha256: f.sha256,
    size: f.size,
  };
  for (const k of [
    "mediaType",
    "classifier",
    "extension",
    "sha1",
    "sha512",
    "md5",
  ] as const)
    if (typeof f[k] === "string") out[k] = f[k] as string;
  return out;
}

export function packageCatalog({
  db,
  slug,
}: {
  db: Db;
  slug: string;
}): PackageCatalog {
  const isPackage = async (deliverableId: string) =>
    (await db.first<{ n: number }>(
      `SELECT 1 AS n FROM release_deliverables
        WHERE product = ? AND deliverable_id = ? AND kind = 'package'`,
      slug,
      deliverableId,
    )) !== null;
  return {
    async packageDeliverables(): Promise<CatalogPackageDeliverable[]> {
      return (await readPackageDeliverables(db, slug)).map((p) => ({
        id: p.id,
        ecosystem: p.ecosystem,
        name: p.name,
      }));
    },

    async packageVersions(
      deliverableId: string,
    ): Promise<CatalogPackageVersion[]> {
      const rows = await db.all<{
        deliverable_id: string;
        release_id: string;
        ecosystem: string;
        name: string;
        name_norm: string;
        version: string;
        state: "live" | "yanked" | "deprecated";
        state_message: string | null;
        files_json: string;
        metadata_json: string;
        published_at: number;
        seq: number | null;
        channel: string | null;
      }>(
        `SELECT p.deliverable_id, p.release_id, p.ecosystem, p.name, p.name_norm, p.version,
                p.state, p.state_message, p.files_json, p.metadata_json, p.published_at,
                m.seq, m.channel
           FROM release_packages p
           JOIN release_metadata m ON m.product = p.product AND m.release_id = p.release_id
          WHERE p.product = ? AND p.deliverable_id = ?
          ORDER BY COALESCE(m.seq, 0) ASC, p.published_at ASC, p.version ASC`,
        slug,
        deliverableId,
      );
      return rows.map((r) => ({
        deliverableId: r.deliverable_id,
        releaseId: r.release_id,
        ecosystem: r.ecosystem,
        name: r.name,
        nameNorm: r.name_norm,
        version: r.version,
        seq: r.seq,
        channel: r.channel,
        state: r.state,
        stateMessage: r.state_message,
        files: (parseJsonArray(r.files_json) ?? [])
          .map(fileRecord)
          .filter((f): f is CatalogPackageFile => f !== null),
        metadata: parseJsonObject(r.metadata_json) ?? {},
        publishedAt: r.published_at,
      }));
    },

    async packageChannelHeads(deliverableId: string) {
      if (!(await isPackage(deliverableId))) return [];
      const cfg = await getReleaseConfig(db, slug);
      const manual = parseManualChannels(cfg?.manual_channels_json);
      const published = await db.all<{ channel: string }>(
        `SELECT DISTINCT channel FROM release_metadata
          WHERE product = ? AND deliverable_id = ? AND channel IS NOT NULL`,
        slug,
        deliverableId,
      );
      const channels = new Set(await knownChannels(db, slug, cfg));
      for (const p of published) {
        const c = canonicalChannel(p.channel, manual);
        if (c) channels.add(c);
      }
      const out: { channel: string; releaseId: string; version: string }[] = [];
      for (const channel of [...channels].sort()) {
        const res = await resolveChannelReleases(
          db,
          slug,
          deliverableId,
          channel,
          cfg,
        );
        const head = res?.releases[0];
        if (head)
          out.push({
            channel: res.channel,
            releaseId: head.release_id,
            version: head.version,
          });
      }
      return out;
    },
  };
}
