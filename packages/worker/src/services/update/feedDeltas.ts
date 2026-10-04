/**
 * The feed's delta menu, the composer's half (P4-29, plans/P4-29.md §6.1, §6.2): which ready lazy
 * deltas a document lists, in which order, and how many fit.
 *
 *   - **Which records.** The document's `packSets.releases`, plus the pins and holds of the app
 *     records its targets pin (a per-platform document: only its own target's). Release answers
 *     the ready rows for those records through the `lazyDeltas` hook (rule 6: Update reads no
 *     Release table), already filtered by P4-17's two switches and §2.2's rules.
 *   - **Order and caps.** Ranked by the base's installed devices (most first), then generation
 *     time (newest first), then `artifact.sha256` bytes. At most `MAX_FEED_DELTAS_PER_TARGET` per
 *     key and `MAX_FEED_DELTAS` in all; an `artifact.sha256` is listed once.
 *   - **Cost.** Every feed request reads the candidate SET (`composeFeedDeltas`), since the seq
 *     hash covers it. The device counts behind the rank are not hashed, so they are read
 *     (`rankFeedDeltas`, one `installedBase` per deliverable) only when a document is signed.
 *   - **Size.** The menu is added LAST, after P4-13's document choice and shedding, and only while
 *     the payload stays within the cap; the lowest-ranked entries go first. So it can never turn
 *     a channel-wide document into a per-platform one, shed a P4-13 member, or make a feed
 *     uncomposable.
 */

import {
  MAX_FEED_DELTAS,
  MAX_FEED_DELTAS_PER_TARGET,
} from "@polaris-key/protocol/core";
import type {
  ChannelFeedDoc,
  FeedDelta,
  FeedDeltas,
  FeedPackSets,
} from "@polaris-key/protocol/update";
import type { CatalogLazyDelta, ServiceHooks } from "../../core/hooks.js";
import type { Db, Env } from "../../core/platform.js";
import { lazyDeltasOn } from "../../core/deltaDemand.js";

/** What the composer read for a channel's menu: the candidate set, and each target's records.
 *  Unranked: this is what the seq hash covers, read on every request. */
export interface ComposedFeedDeltas {
  /** Every candidate, in Release's order (the hash sorts its own copy). */
  candidates: CatalogLazyDelta[];
  /** Platform → the pack records its target's app release pins or holds. */
  pinnedBy: Record<string, string[]>;
}

/** A candidate with its base's installed devices: the rank's first key. */
export interface RankedLazyDelta extends CatalogLazyDelta {
  /** Devices last seen on `entry.from` (P4-17's `installedBase`). */
  devices: number;
}

/** The menu a document is built from (`documentFor`): ranked candidates, best first. Read only on
 *  the sign path (`rankFeedDeltas`). */
export interface RankedFeedDeltas {
  candidates: RankedLazyDelta[];
  pinnedBy: Record<string, string[]>;
}

/** Compare by UTF-8 bytes (lowercase hex: code-unit order). */
const bytesCmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The rank (§6.1): devices on `from` desc, `createdAt` desc, `artifact.sha256` bytes asc. */
export function rankLazyDeltas(
  rows: readonly RankedLazyDelta[],
): RankedLazyDelta[] {
  return [...rows].sort(
    (a, b) =>
      b.devices - a.devices ||
      b.createdAt - a.createdAt ||
      bytesCmp(a.entry.artifact.sha256, b.entry.artifact.sha256) ||
      bytesCmp(a.recordSha256, b.recordSha256),
  );
}

/**
 * Read a channel's menu candidates (the set the seq hash covers; no device counts). Null (no menu)
 * while the deployment's `LAZY_DELTAS` is off — checked before any read but the platform settings
 * store's (cached, and skipped when the `[vars]` value is a hard `off`) — or when Release lists
 * nothing for the channel's records.
 */
export async function composeFeedDeltas(
  ctx: { env?: Pick<Env, "LAZY_DELTAS">; db: Db; hooks: ServiceHooks },
  apps: readonly { platform: string; appReleaseId: string }[],
  packSets: FeedPackSets | null,
): Promise<ComposedFeedDeltas | null> {
  if (!ctx.env || apps.length === 0 || !(await lazyDeltasOn(ctx.env, ctx.db)))
    return null;
  const catalog = ctx.hooks.releaseCatalog();
  if (!catalog?.lazyDeltas) return null;
  const pinnedBy: Record<string, string[]> = {};
  const records = new Set<string>(Object.keys(packSets?.releases ?? {}));
  for (const { platform, appReleaseId } of apps) {
    const held = new Set<string>();
    for (const p of await catalog.pins(appReleaseId)) held.add(p.recordSha256);
    for (const h of await catalog.holdsFor(appReleaseId))
      held.add(h.recordSha256);
    pinnedBy[platform] = [...held].sort(bytesCmp);
    for (const r of held) records.add(r);
  }
  if (records.size === 0) return null;
  const rows = await catalog.lazyDeltas([...records].sort(bytesCmp));
  if (rows.length === 0) return null;
  return { candidates: rows, pinnedBy };
}

/**
 * Rank a channel's candidates for signing (§6.1): the device counts on each base, read through
 * Release's `lazyDeltaDevices` (rule 6), then `rankLazyDeltas`. A catalog without it ranks every
 * base as 0 devices (generation time, then bytes, decide). Called only on the sign path.
 */
export async function rankFeedDeltas(
  hooks: ServiceHooks,
  d: ComposedFeedDeltas,
): Promise<RankedFeedDeltas> {
  const catalog = hooks.releaseCatalog();
  const counts = catalog?.lazyDeltaDevices
    ? await catalog.lazyDeltaDevices(
        d.candidates.map((c) => ({
          deliverableId: c.deliverableId,
          from: c.entry.from,
        })),
      )
    : [];
  return {
    candidates: rankLazyDeltas(
      d.candidates.map((c, i) => ({ ...c, devices: counts[i] ?? 0 })),
    ),
    pinnedBy: d.pinnedBy,
  };
}

/** The hashed form of the candidates: the SET (rank order excluded, so device counts moving never
 *  re-sign the feed; a delta turning ready or cold does). */
export function deltasHashPart(d: ComposedFeedDeltas): unknown[] {
  return d.candidates
    .map((c) => ({ record: c.recordSha256, to: c.to, ...c.entry }))
    .sort(
      (a, b) =>
        bytesCmp(a.artifact.sha256, b.artifact.sha256) ||
        bytesCmp(a.record, b.record),
    );
}

/** The capped, ranked entries a document over `records` may list. */
export function menuEntries(
  d: RankedFeedDeltas,
  records: ReadonlySet<string>,
): { to: string; entry: FeedDelta }[] {
  const out: { to: string; entry: FeedDelta }[] = [];
  const artifacts = new Set<string>();
  const pairs = new Set<string>();
  const perKey = new Map<string, number>();
  for (const c of d.candidates) {
    if (out.length >= MAX_FEED_DELTAS) break;
    if (!records.has(c.recordSha256)) continue;
    if (artifacts.has(c.entry.artifact.sha256)) continue;
    const pair = `${c.to}|${c.entry.from}|${c.entry.method}`;
    if (pairs.has(pair)) continue;
    const n = perKey.get(c.to) ?? 0;
    if (n >= MAX_FEED_DELTAS_PER_TARGET) continue;
    artifacts.add(c.entry.artifact.sha256);
    pairs.add(pair);
    perKey.set(c.to, n + 1);
    out.push({ to: c.to, entry: c.entry });
  }
  return out;
}

/** The `deltas` member of the first `n` entries (keys in first-appearance order). */
export function menuMember(
  list: readonly { to: string; entry: FeedDelta }[],
): FeedDeltas {
  const out: FeedDeltas = {};
  for (const { to, entry } of list)
    (out[to] ??= []).push({
      from: entry.from,
      method: entry.method,
      scope: "payload",
      memBytes: entry.memBytes,
      artifact: { sha256: entry.artifact.sha256, bytes: entry.artifact.bytes },
    });
  return out;
}

/** The records a document's menu may draw from (§6.1). */
export function menuRecords(
  doc: ChannelFeedDoc,
  d: RankedFeedDeltas,
  platform: string | null,
): Set<string> {
  const out = new Set<string>(Object.keys(doc.packSets?.releases ?? {}));
  for (const [p, list] of Object.entries(d.pinnedBy))
    if (platform === null || p === platform) for (const r of list) out.add(r);
  return out;
}
