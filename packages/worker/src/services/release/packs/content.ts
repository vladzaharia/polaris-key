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
 *   embeds        a build embeds a pack the release does not pin;
 *   pack-unreadable  a declared pack's stored declaration does not read back, so the rules above
 *                 cannot all be checked (fail closed; a resync rewrites it);
 *
 * and, since P4-12, the requirements a pin or a hold must meet and the release's holds:
 *
 *   pin-requires   a pinned release's signed requirements exclude this app release: its
 *                  `requires.contentApi.app` range does not hold the release's contentApi, or no
 *                  variant runs on an engine one of the release's builds declares;
 *   hold-unknown   a hold names no stored record;
 *   hold-mismatch  the stored record is not a pack record of the held pack, or its version or
 *                  `seq` differ from the hold's;
 *   hold-yanked    the held pack release is yanked;
 *   hold-binding   the held pack is not `compatible` (a hold keeps a compatible pack; a pinned one
 *                  is pinned, and a standalone one is never tied to an app release);
 *   hold-requires  the held release's signed requirements exclude this app release (as
 *                  pin-requires);
 *
 * and, since P4-13, `pin-revoked` and `hold-revoked`: the pinned or held release is revoked (checked
 * before the yank its revocation also wrote). App releases already stored keep their signed pins;
 * devices refuse the revoked release themselves (plans/P4-13.md §2.6);
 *
 * and, since P4-19, `pin-delegated` and `hold-delegated`: the pinned or held release was signed
 * by a delegated content key (a pin or hold is the release key vouching for exact bytes; `embeds`
 * ⊆ pins, so this covers embedded baselines too, plans/P4-19.md §2.4);
 *
 * then the resolution check (`checks.ts`: pack-channels-conflict, content-unsatisfied,
 * hold-unsatisfiable, pack-sets-bound), whose report the submit returns.
 *
 * Pins and holds are SIGNED: `release_pins` and `release_holds` mirror them for queries ("which app
 * releases pin or hold pack release X") and are never edited afterwards.
 */

import {
  APP_DELIVERABLE_ID,
  type ReleaseDescriptor,
} from "@polaris-key/manifest";
import type { Db, DbStatement } from "../../../core/platform.js";
import type { ReleaseConfigRow } from "../config.js";
import type { RecordRefusalReason } from "../records.js";
import { checkAppPublish, type CheckCache } from "./checks.js";
import { readPackDeliverables } from "./deliverables.js";
import { storedRecordPayload } from "./ingest.js";
import { levelInRange } from "./resolve.js";
import type { PackSetReport, ResolvedForStore } from "./sets.js";

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

/** One hold as `release_holds` will hold it. */
export interface PlannedHold {
  pack: string;
  packReleaseId: string;
  recordSha256: string;
  reason: string | null;
}

export type ContentPlan =
  | {
      ok: true;
      contentApi: number | null;
      pins: PlannedPin[];
      holds: PlannedHold[];
      packChannels: Record<string, string> | null;
      /** The resolution report (P4-12), or null when the product resolves no pack sets. */
      report: PackSetReport | null;
      /** The after-state's rows, stored once the release is written (one resolution). */
      resolved: ResolvedForStore | null;
    }
  | ContentRefusal;

/** What the resolution check needs beyond the descriptor. */
export interface ContentContext {
  releaseId: string;
  /** The release's seq as it will be stored. */
  seq: number;
  cfg: ReleaseConfigRow | null;
  /** The request's check memo (the submit plans twice over one stored state). */
  cache?: CheckCache;
}

/**
 * Why a stored pack record's signed requirements exclude an app release, or null: its
 * `requires.contentApi.app` range (any variant that signs one) must hold `contentApi`, and every
 * engine a build declares must be one some variant runs on (`requires.engine` absent or equal).
 */
function requirementsExclude(
  payload: Record<string, unknown> | null,
  contentApi: number,
  engines: readonly string[],
): string | null {
  const variants = Array.isArray(payload?.variants)
    ? (payload.variants as { requires?: Record<string, unknown> }[])
    : [];
  for (const v of variants) {
    const range = (
      v.requires?.contentApi as Record<string, unknown> | undefined
    )?.[APP_DELIVERABLE_ID];
    if (range !== undefined && !levelInRange(range as string, contentApi))
      return `its requires.contentApi.${APP_DELIVERABLE_ID} is ${String(range)}, not holding contentApi ${contentApi}`;
  }
  for (const e of engines)
    if (
      variants.length > 0 &&
      !variants.some(
        (v) => v.requires?.engine === undefined || v.requires.engine === e,
      )
    )
      return `no variant runs on ${e}`;
  return null;
}

function refuse(reason: RecordRefusalReason, message: string): ContentRefusal {
  return { ok: false, reason, message };
}

/** The checks above, reading only. */
export async function planAppContent(
  db: Db,
  product: string,
  d: ReleaseDescriptor,
  ctx: ContentContext,
): Promise<ContentPlan> {
  const declared = await readPackDeliverables(db, product);
  // Fail closed: a declaration that does not read back could be the `required` pack this release
  // omits, so nothing below is decided without every one of them.
  if (declared.unreadable.length > 0)
    return refuse(
      "pack-unreadable",
      `${product}'s stored declaration of ${declared.unreadable.join(", ")} does not read back; resync the product's manifest, then publish again.`,
    );
  const packs = declared.packs;
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
  if (!content)
    return {
      ok: true,
      contentApi: null,
      pins: [],
      holds: [],
      packChannels: null,
      report: null,
      resolved: null,
    };

  // Every expected PINNED pack pinned and every pin expected; every required pinned pack and every
  // embedded baseline pinned. A compatible or standalone pack comes from the resolved sets
  // (P4-12), so its expect needs no pin, unless the build embeds it as a baseline.
  const expects = new Map(content.expects.map((e) => [e.pack, e]));
  const bindingOf = new Map(packs.map((p) => [p.id, p.binding]));
  for (const e of content.expects)
    if (
      (bindingOf.get(e.pack) ?? "pinned") === "pinned" &&
      !pinnedPacks.has(e.pack)
    )
      return refuse(
        "pin-missing",
        `${e.pack} is expected but not pinned; every expected pinned pack is pinned.`,
      );
  for (const p of content.pins)
    if (!expects.has(p.pack))
      return refuse(
        "pin-missing",
        `${p.pack} is pinned but not expected; list it in content.expects.`,
      );
  for (const pack of packs)
    if (
      ((pack.required && pack.binding === "pinned") ||
        pack.baseline === "embedded") &&
      !pinnedPacks.has(pack.id)
    )
      return refuse(
        "pin-missing",
        `${pack.id} is ${pack.baseline === "embedded" ? "an embedded baseline" : "a required pinned pack"}, so every app release pins it.`,
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
    revoked: number;
    delegated: number;
  }>(
    `SELECT r.record_sha256, r.kind, r.deliverable_id, r.release_id, r.seq, r.jws,
            m.version AS version,
            EXISTS (SELECT 1 FROM release_yanks y
                     WHERE y.product = r.product AND y.release_id = r.release_id) AS yanked,
            EXISTS (SELECT 1 FROM release_revocations v
                     WHERE v.product = r.product AND v.target_sha256 = r.record_sha256) AS revoked,
            EXISTS (SELECT 1 FROM release_delegated_records d
                     WHERE d.product = r.product AND d.record_sha256 = r.record_sha256) AS delegated
       FROM release_records r
       LEFT JOIN release_metadata m ON m.product = r.product AND m.release_id = r.release_id
      WHERE r.product = ? AND r.record_sha256 IN (SELECT value FROM json_each(?))`,
    product,
    JSON.stringify([
      ...content.pins.map((p) => p.release.sha256),
      ...(content.holds ?? []).map((h) => h.release.sha256),
    ]),
  );
  const engines = [
    ...new Set(
      d.builds.flatMap((b) =>
        typeof b.requires?.engine === "string" ? [b.requires.engine] : [],
      ),
    ),
  ].sort();
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
    if (r.delegated)
      return refuse(
        "pin-delegated",
        `${p.pack} ${p.release.version} was signed by a delegated content key; an app release pins (or embeds) only releases its release key signed (plans/P4-19.md §2.4).`,
      );
    if (r.revoked)
      return refuse(
        "pin-revoked",
        `${p.pack} ${p.release.version} is revoked: no app release may pin it (plans/P4-13.md §6.2).`,
      );
    if (r.yanked)
      return refuse(
        "pin-yanked",
        `${p.pack} ${p.release.version} is yanked: no new app release may pin it (releases that already pin it keep it).`,
      );
    const excluded = requirementsExclude(
      storedRecordPayload(r.jws),
      content.contentApi,
      engines,
    );
    if (excluded)
      return refuse(
        "pin-requires",
        `${p.pack} ${p.release.version} cannot run with this app release: ${excluded}.`,
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

  // Holds (P4-12): each against the stored records and the held pack's binding.
  const holds: PlannedHold[] = [];
  for (const h of content.holds ?? []) {
    const r = byHash.get(h.release.sha256);
    if (!r)
      return refuse(
        "hold-unknown",
        `the hold of ${h.pack} names record ${h.release.sha256}, which ${product} has not ingested.`,
      );
    if (
      r.kind !== "pack" ||
      r.deliverable_id !== h.pack ||
      r.seq !== h.release.seq ||
      r.version !== h.release.version
    )
      return refuse(
        "hold-mismatch",
        `record ${h.release.sha256} is ${r.kind === "pack" ? `${r.deliverable_id} ${r.version ?? "?"} (seq ${r.seq})` : `a ${r.kind} record`}, not ${h.pack} ${h.release.version} (seq ${h.release.seq}).`,
      );
    if (bindingOf.get(h.pack) !== "compatible")
      return refuse(
        "hold-binding",
        `${h.pack} is ${bindingOf.get(h.pack) ?? "not declared"}; only a compatible pack is held (a pinned pack is pinned).`,
      );
    if (r.delegated)
      return refuse(
        "hold-delegated",
        `${h.pack} ${h.release.version} was signed by a delegated content key; an app release holds only releases its release key signed (plans/P4-19.md §2.4).`,
      );
    if (r.revoked)
      return refuse(
        "hold-revoked",
        `${h.pack} ${h.release.version} is revoked: no app release may hold it (plans/P4-13.md §6.2).`,
      );
    if (r.yanked)
      return refuse(
        "hold-yanked",
        `${h.pack} ${h.release.version} is yanked: no app release may hold it.`,
      );
    const excluded = requirementsExclude(
      storedRecordPayload(r.jws),
      content.contentApi,
      engines,
    );
    if (excluded)
      return refuse(
        "hold-requires",
        `${h.pack} ${h.release.version} cannot run with this app release: ${excluded}.`,
      );
    holds.push({
      pack: h.pack,
      packReleaseId: r.release_id,
      recordSha256: r.record_sha256,
      reason: h.reason ?? null,
    });
  }

  // The resolution check (P4-12): this release live beside the stored ones.
  const checked = await checkAppPublish(
    db,
    product,
    {
      releaseId: ctx.releaseId,
      version: d.version,
      seq: ctx.seq,
      channel: d.channel ?? null,
      tag: d.tag ?? null,
      builds: d.builds.map((b) => ({
        buildId: b.id,
        platform: b.platform,
        arch: b.arch,
        engine:
          typeof b.requires?.engine === "string" ? b.requires.engine : null,
      })),
      contentApi: content.contentApi,
      packChannels: content.packChannels ?? null,
      holds: holds.map((h) => ({ pack: h.pack, releaseId: h.packReleaseId })),
    },
    ctx.cfg,
    ctx.cache,
  );
  if (!checked.ok) return checked;
  return {
    ok: true,
    contentApi: content.contentApi,
    pins,
    holds,
    packChannels: content.packChannels ?? null,
    report: checked.report,
    resolved: checked.resolved,
  };
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
      sql: "UPDATE release_metadata SET content_api = ?, pack_channels_json = ? WHERE product = ? AND release_id = ?",
      params: [
        plan.contentApi,
        plan.packChannels ? JSON.stringify(plan.packChannels) : null,
        product,
        releaseId,
      ],
    },
    ...plan.holds.map((h) => ({
      sql: `INSERT INTO release_holds
              (product, app_release_id, pack_deliverable, pack_release_id, record_sha256, reason,
               created_at)
            VALUES (?,?,?,?,?,?,?)
            ON CONFLICT(product, app_release_id, pack_deliverable) DO NOTHING`,
      params: [
        product,
        releaseId,
        h.pack,
        h.packReleaseId,
        h.recordSha256,
        h.reason,
        now,
      ],
    })),
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
