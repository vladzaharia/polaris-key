/**
 * An app release's packs (P4-02, plans/P4-01.md §6): the checks its `content` and its builds'
 * `embeds` pass, and the rows that mirror them.
 *
 * The descriptor's `content` is the record's (P3-03's `descriptor-mismatch` comparison covers
 * both members, decision 37), so these checks run on the DESCRIPTOR inside the descriptor ingest
 * (`../descriptor.ts`), and a descriptor-only release (P2-06's GitHub path) is checked the same
 * way. The validator has already checked the structure, the declared pack ids and the
 * `contentApi` (`invalid_descriptor_content`, `invalid_descriptor_embeds`); these are the
 * cross-record rules only stored state can answer, refused with `release_record_rejected`:
 *
 *   content-api   the product declares packs and the release carries no `content`;
 *   pin-unknown   a pin names no stored record;
 *   pin-mismatch  the stored record is not a pack record of the pinned pack, or its version or
 *                 `seq` differ from the pin's;
 *   pin-yanked    the pinned pack release is yanked (a yank stops NEW pins; app releases that
 *                 already pin it keep it, CONTENT §6.7 item 6);
 *   pin-missing   an expected pack, a `required` pack or a `baseline: embedded` pack has no pin,
 *                 or a pin has no expect (in v1 every expected pack is pinned);
 *   pin-gated     a `required` expect pins a record that carries an `entitlement` (a required
 *                 pack is never gated);
 *   embeds        a build embeds a pack the release does not pin.
 *
 * Pins are SIGNED: `release_pins` mirrors them for queries ("which app releases pin pack release
 * X") and is never edited afterwards.
 */

import type { ReleaseDescriptor } from "@polaris-key/manifest";
import type { Db, DbStatement } from "../../../core/platform.js";
import type { RecordRefusalReason } from "../records.js";
import { readPackDeliverables } from "./deliverables.js";
import { storedRecordPayload } from "./ingest.js";

export type ContentRefusal = {
  ok: false;
  reason: RecordRefusalReason;
  message: string;
};

/** One pin as `release_pins` will hold it. */
export interface PlannedPin {
  pack: string;
  packReleaseId: string;
  recordSha256: string;
  required: boolean;
  delivery: string;
}

export type ContentPlan =
  | { ok: true; contentApi: number | null; pins: PlannedPin[] }
  | ContentRefusal;

function refuse(reason: RecordRefusalReason, message: string): ContentRefusal {
  return { ok: false, reason, message };
}

/** The checks above, reading only. */
export async function planAppContent(
  db: Db,
  product: string,
  d: ReleaseDescriptor,
): Promise<ContentPlan> {
  const packs = await readPackDeliverables(db, product);
  const content = d.content;
  const pinnedPacks = new Set((content?.pins ?? []).map((p) => p.pack));
  if (!content) {
    if (packs.length > 0)
      return refuse(
        "content-api",
        `${product} declares pack deliverables, so every app release carries content (its contentApi, pins and expects; pkey release publish --content-stamp).`,
      );
  }
  for (const [bi, b] of d.builds.entries())
    for (const e of b.embeds ?? [])
      if (!pinnedPacks.has(e))
        return refuse(
          "embeds",
          `builds[${bi}] (${b.id}) embeds ${e}, which this release does not pin.`,
        );
  if (!content) return { ok: true, contentApi: null, pins: [] };

  // Every expect pinned and every pin expected; every required and embedded-baseline pack pinned.
  const expects = new Map(content.expects.map((e) => [e.pack, e]));
  for (const e of content.expects)
    if (!pinnedPacks.has(e.pack))
      return refuse(
        "pin-missing",
        `${e.pack} is expected but not pinned; v1 pins every expected pack.`,
      );
  for (const p of content.pins)
    if (!expects.has(p.pack))
      return refuse(
        "pin-missing",
        `${p.pack} is pinned but not expected; list it in content.expects.`,
      );
  for (const pack of packs)
    if (
      (pack.required || pack.baseline === "embedded") &&
      !pinnedPacks.has(pack.id)
    )
      return refuse(
        "pin-missing",
        `${pack.id} is ${pack.required ? "required" : "an embedded baseline"}, so every app release pins it.`,
      );

  // Each pin against the stored records, in one query.
  const rows = await db.all<{
    record_sha256: string;
    kind: string;
    deliverable_id: string;
    release_id: string;
    seq: number;
    jws: string;
    version: string | null;
    yanked: number;
  }>(
    `SELECT r.record_sha256, r.kind, r.deliverable_id, r.release_id, r.seq, r.jws,
            m.version AS version,
            EXISTS (SELECT 1 FROM release_yanks y
                     WHERE y.product = r.product AND y.release_id = r.release_id) AS yanked
       FROM release_records r
       LEFT JOIN release_metadata m ON m.product = r.product AND m.release_id = r.release_id
      WHERE r.product = ? AND r.record_sha256 IN (SELECT value FROM json_each(?))`,
    product,
    JSON.stringify(content.pins.map((p) => p.release.sha256)),
  );
  const byHash = new Map(rows.map((r) => [r.record_sha256, r]));
  const pins: PlannedPin[] = [];
  for (const p of content.pins) {
    const r = byHash.get(p.release.sha256);
    if (!r)
      return refuse(
        "pin-unknown",
        `the pin of ${p.pack} names record ${p.release.sha256}, which ${product} has not ingested (publish the pack release first).`,
      );
    if (
      r.kind !== "pack" ||
      r.deliverable_id !== p.pack ||
      r.seq !== p.release.seq ||
      r.version !== p.release.version
    )
      return refuse(
        "pin-mismatch",
        `record ${p.release.sha256} is ${r.kind === "pack" ? `${r.deliverable_id} ${r.version ?? "?"} (seq ${r.seq})` : `a ${r.kind} record`}, not ${p.pack} ${p.release.version} (seq ${p.release.seq}).`,
      );
    if (r.yanked)
      return refuse(
        "pin-yanked",
        `${p.pack} ${p.release.version} is yanked: no new app release may pin it (releases that already pin it keep it).`,
      );
    const e = expects.get(p.pack)!;
    if (e.required) {
      const payload = storedRecordPayload(r.jws);
      if (payload && payload.entitlement !== undefined)
        return refuse(
          "pin-gated",
          `${p.pack} is a required pack, but ${p.pack} ${p.release.version} is gated (${String(payload.entitlement)}); a required pack is never gated.`,
        );
    }
    pins.push({
      pack: p.pack,
      packReleaseId: r.release_id,
      recordSha256: r.record_sha256,
      required: e.required,
      delivery: e.delivery,
    });
  }
  return { ok: true, contentApi: content.contentApi, pins };
}

/**
 * The rows of an app release's packs, unguarded (the caller guards them on its descriptor): the
 * `content_api` column and one `release_pins` row per pin. Each build's `embeds_json` rides on
 * its `release_builds` upsert.
 */
export function appContentStatements(
  product: string,
  releaseId: string,
  plan: Extract<ContentPlan, { ok: true }>,
  now: number,
): DbStatement[] {
  if (plan.contentApi === null) return [];
  return [
    {
      sql: "UPDATE release_metadata SET content_api = ? WHERE product = ? AND release_id = ?",
      params: [plan.contentApi, product, releaseId],
    },
    ...plan.pins.map((p) => ({
      sql: `INSERT INTO release_pins
              (product, app_release_id, pack_deliverable, pack_release_id, record_sha256,
               required, delivery, created_at)
            VALUES (?,?,?,?,?,?,?,?)
            ON CONFLICT(product, app_release_id, pack_deliverable) DO NOTHING`,
      params: [
        product,
        releaseId,
        p.pack,
        p.packReleaseId,
        p.recordSha256,
        p.required ? 1 : 0,
        p.delivery,
        now,
      ],
    })),
  ];
}
