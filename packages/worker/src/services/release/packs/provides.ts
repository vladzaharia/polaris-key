/**
 * Save compatibility at publish (P4-20, CONTENT §6.4 and §6.7 item 8): a pack release that stops
 * providing a content id its predecessor provided fails, unless it moves to a new contentApi line
 * or acknowledges the id in `removes`. Saves reference content ids, never paths, so a silently
 * dropped id would break players' saves instead of failing in CI.
 *
 * `provides` and `removes` are record-level members WIRE-CONTRACT-V4 §2.5.1 reserves on the pack
 * record (`plans/P4-01.md` §2.3): never claims, so clients that predate this ignore them. These
 * checks are publish rules, run on the submit (dry run included) beside P4-12's set checks:
 *
 *   pack-provides     a list that is not an array of at most `MAX_PROVIDES` distinct content ids
 *                     (`CONTENT_ID_PATTERN`), or no `provides` while the pack's declared policy
 *                     says `provides.required`;
 *   provides-dropped  for the predecessor P (the stored pack record of the same deliverable ON
 *                     THE SAME CHANNEL, `stable` when none is named, with the highest seq; a
 *                     record's seq always rises) and every live contentApi
 *                     level that both P and the new release N support,
 *                     provides(P) \ provides(N) ⊄ removes(N). The refusal names each dropped id
 *                     (the first 20, and how many more) and the levels.
 *
 * WHICH LEVELS. A release supports a level when its `requires.contentApi.app` range holds it; a
 * release without a range (a `pinned` or `standalone` pack) supports every level. When neither
 * release has a range they are on the same line by definition and the rule applies whatever is
 * live. Otherwise the live levels are the contentApi values of the live app releases that the
 * new release's channel serves (each app channel's routed pack channel, with its `includes`); when N supports none of the levels P supports, N is a contentApi bump and
 * the check passes. A predecessor without `provides` leaves nothing to compare. A record without
 * `provides` provides nothing, so after a predecessor that listed ids it must list them in
 * `removes` (or declare `provides.required` to catch the omission earlier).
 *
 * Warnings (answered as `warnings`, never a refusal): a `removes` id the predecessor never
 * provided, and a `removes` id the release still provides.
 */

import {
  APP_DELIVERABLE_ID,
  packChannelFor,
  providesListProblem,
  type ManifestPackDeliverable,
} from "@polaris-key/manifest";
import { base64UrlDecode } from "@polaris-key/jws";
import type { PackRecordDoc } from "@polaris-key/protocol/packs";
import type { Db } from "../../../core/platform.js";
import type { ReleaseConfigRow } from "../config.js";
import type { PackRefusal } from "./ingest.js";
import { channelClosure } from "../resolve.js";
import { levelInRange, PackResolver } from "./resolve.js";
import { loadResolutionState } from "./sets.js";

/** How many dropped ids a refusal names before it counts the rest. */
const NAMED_IDS = 20;

/** The record's `provides` or `removes` as a list, or null when the member is absent. */
function listOf(record: unknown, member: "provides" | "removes"): unknown {
  return (record as Record<string, unknown> | null)?.[member];
}

/**
 * `pack-provides`: each list's shape, and the declared policy's `required`. Runs before anything
 * is read, so a malformed list never reaches the predecessor comparison.
 */
export function checkProvidesShape(
  record: PackRecordDoc,
  pack: ManifestPackDeliverable,
): PackRefusal | null {
  for (const member of ["provides", "removes"] as const) {
    const list = listOf(record, member);
    if (list === undefined) continue;
    const problem = providesListProblem(list);
    if (problem)
      return {
        ok: false,
        reason: "pack-provides",
        message: `the record's ${member} ${problem}.`,
      };
  }
  if (pack.provides?.required && listOf(record, "provides") === undefined)
    return {
      ok: false,
      reason: "pack-provides",
      message: `${record.deliverable} declares provides.required, and the record carries no provides (pkey release publish reads it from ${pack.provides.from}, or --provides).`,
    };
  return null;
}

/** The `requires.contentApi.app` range a pack record signs, or null for an unranged release. */
function rangeOf(record: unknown): string | null {
  const variants = (record as { variants?: unknown } | null)?.variants;
  if (!Array.isArray(variants)) return null;
  for (const v of variants) {
    const range = (v as { requires?: { contentApi?: Record<string, unknown> } })
      ?.requires?.contentApi?.[APP_DELIVERABLE_ID];
    if (typeof range === "string") return range;
  }
  return null;
}

/** A stored record's payload (its JWS was verified at ingest), or null when it does not decode. */
function payloadOf(jws: string): Record<string, unknown> | null {
  const seg = jws.split(".")[1];
  if (seg === undefined) return null;
  try {
    const v: unknown = JSON.parse(
      new TextDecoder().decode(base64UrlDecode(seg)),
    );
    return v && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** A list member as a set of strings (a stored record passed `checkProvidesShape`). */
function setOf(list: unknown): Set<string> {
  return new Set(
    Array.isArray(list)
      ? list.filter((x): x is string => typeof x === "string")
      : [],
  );
}

/**
 * The live contentApi levels at which a release of `pack` on pack channel `channel` is served:
 * for every app channel's live app releases (P4-12's resolver), the pack's routed channel there
 * (`packChannels`, else the app channel) and everything it includes must contain `channel`
 * (`beta` includes `stable`, so a stable pack release reaches beta players too). Ascending.
 */
async function liveLevels(
  db: Db,
  product: string,
  cfg: ReleaseConfigRow | null,
  pack: string,
  channel: string,
): Promise<number[]> {
  const state = await loadResolutionState(db, product, cfg);
  if (!state) return [];
  const resolver = new PackResolver(state.input);
  const policies =
    state.input.packs.find((p) => p.id === pack)?.policies ?? new Map();
  const out = new Set<number>();
  for (const app of state.input.channels)
    for (const r of resolver.live(app)) {
      const routed =
        packChannelFor(resolver.levelMapping(app, r.contentApi), pack) ?? app;
      if (channelClosure(routed, policies).has(channel)) out.add(r.contentApi);
    }
  return [...out].sort((a, b) => a - b);
}

export type ProvidesCheck =
  | { ok: true; warnings: string[] }
  | { ok: false; reason: "provides-dropped"; message: string };

/** `provides-dropped` (see the header), and the warnings the submit answers. */
export async function checkProvidesKept(
  db: Db,
  product: string,
  record: PackRecordDoc,
  cfg: ReleaseConfigRow | null,
): Promise<ProvidesCheck> {
  // The predecessor on the SAME channel: a beta release must not move stable's baseline, in
  // either direction (a beta addition would force a false `removes` on stable; a beta `removes`
  // would let stable drop the id silently).
  const channel = record.channel ?? "stable";
  const row = await db.first<{ jws: string; release_id: string }>(
    `SELECT r.jws, r.release_id FROM release_records r
       JOIN release_metadata m ON m.product = r.product AND m.release_id = r.release_id
      WHERE r.product = ? AND r.deliverable_id = ? AND r.kind = 'pack' AND r.seq < ?
        AND COALESCE(m.channel, 'stable') = ?
      ORDER BY r.seq DESC LIMIT 1`,
    product,
    record.deliverable,
    record.seq,
    channel,
  );
  const prior = row ? payloadOf(row.jws) : null;
  const removes = setOf(listOf(record, "removes"));
  const provides = setOf(listOf(record, "provides"));
  const warnings: string[] = [];
  const before =
    prior && listOf(prior, "provides") !== undefined
      ? setOf(listOf(prior, "provides"))
      : null;
  for (const id of [...removes].sort()) {
    if (provides.has(id))
      warnings.push(
        `removes lists ${id}, which this release still provides; the acknowledgement has no effect.`,
      );
    else if (before !== null && !before.has(id))
      warnings.push(
        `removes lists ${id}, which ${row!.release_id} never provided.`,
      );
    else if (before === null && row)
      warnings.push(
        `removes lists ${id}, but ${row.release_id} declares no provides.`,
      );
  }
  if (before === null) return { ok: true, warnings };
  const dropped = [...before]
    .filter((id) => !provides.has(id) && !removes.has(id))
    .sort();
  if (dropped.length === 0) return { ok: true, warnings };

  // The levels both releases support.
  const was = rangeOf(prior);
  const now = rangeOf(record);
  let where: string;
  if (was === null && now === null) where = "every contentApi level";
  else {
    const shared = (
      await liveLevels(db, product, cfg, record.deliverable, channel)
    ).filter(
      (l) =>
        (was === null || levelInRange(was, l)) &&
        (now === null || levelInRange(now, l)),
    );
    // No live level both support: a contentApi bump, so the drop is the new line's shape.
    if (shared.length === 0) return { ok: true, warnings };
    where = `contentApi ${shared.join(", ")}`;
  }
  const named = dropped.slice(0, NAMED_IDS).join(", ");
  const more =
    dropped.length > NAMED_IDS ? ` and ${dropped.length - NAMED_IDS} more` : "";
  return {
    ok: false,
    reason: "provides-dropped",
    message: `${record.deliverable} ${record.version} stops providing ${dropped.length} content id${dropped.length === 1 ? "" : "s"} that ${row!.release_id} provided, at ${where}: ${named}${more}. Saves that reference them would break: keep providing them, move the release to a new contentApi range, or acknowledge each in removes (pkey release publish --removes).`,
  };
}
