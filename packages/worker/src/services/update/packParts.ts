/// <reference types="@cloudflare/workers-types" />

/**
 * The channel feed's content members (P4-13, plans/P4-13.md §2.2, §6.3; WIRE-CONTRACT-V4 §2.4.1):
 * `packSets`, `packFloors` and `revocations`, composed from Release's stored state and
 * Distribution's transports.
 *
 *   rows        the stored `release_sets` rows of the app deliverable on the canonical channel
 *               (P4-12), one per group; an `unsatisfied` pack is simply absent (decision 6).
 *   releases    every pack release a row's set names, by record hash (deduplicated).
 *   sets        `packSetId` → member hashes sorted by pack-id bytes; each key is asserted to be
 *               client-core's `packSetId` of its members.
 *   outlets     per live outlet, `pinned`: the compatible and standalone packs whose transport on
 *               that outlet cannot float (`TRANSPORT_FLOATS`, only `play-pad` today, decision 16).
 *               `gates` (P4-14, `composeGates`): Distribution's pack rollouts and halts on that
 *               outlet, keyed by the target's hash, each with the previous set's release as
 *               `fallback` (rows C11–C13).
 *   packFloors  per declared pack (pinned packs included) and live level, the higher of the
 *               level-free `min_supported` and the level's `release_pack_floors` row on the pack's
 *               channel (the level's `packChannels` routing, as resolution reads it), with the
 *               pack's version scheme.
 *   revocations the revocations in force (decision 14): one is DROPPED only when no stored app
 *               release on the channel, live or not, pins or holds its target (an embedded
 *               baseline is pinned) and no row lists it. It is REFERENCED when a live app release
 *               pins or holds it or a row lists it. Above `MAX_FEED_REVOCATIONS` the unreferenced
 *               go first, then the oldest by `issuedAt` (audit `update.feed.revocations_truncated`).
 *               P4-19: a delegation's revocation (`kind: "delegation"`, `pack` the scope root) is
 *               never dropped by that rule and is always referenced.
 *
 * Every member is checked with client-core's `feedContent` before signing (`feedDoc.ts`); one that
 * would read as unusable is omitted and audited, never signed. Update reads Distribution only
 * through Core's `delivery` hook; the one service import is `update → release`.
 */

import {
  APP_DELIVERABLE_ID,
  TRANSPORT_FLOATS,
  packChannelFor,
  type ManifestPackDeliverable,
  type Transport,
} from "@polaris-key/manifest";
import { MAX_FEED_REVOCATIONS } from "@polaris-key/protocol/core";
import type {
  FeedPackFloor,
  FeedPackGate,
  FeedPackOutlet,
  FeedPackRelease,
  FeedPackRow,
  FeedPackSets,
  FeedRevocation,
} from "@polaris-key/protocol/update";
import { packSetId } from "@polaris-key/client-core/packs";
import {
  compareVersions,
  parseVersion,
} from "@polaris-key/client-core/version";
import type { Db } from "../../core/platform.js";
import type {
  CatalogRevocation,
  DeliveryOutlet,
  ServiceHooks,
} from "../../core/hooks.js";
import { readPackDeliverables } from "../release/packs/deliverables.js";
import { loadResolutionState, readStoredSets } from "../release/packs/sets.js";
import { PackResolutionError, PackResolver } from "../release/packs/resolve.js";
import { rowKey } from "../release/packs/sets.js";
import type { ResolvedSet } from "../release/packs/resolve.js";
import type { ReleaseConfigRow } from "../release/config.js";

/** Basis points in a whole rollout (`dist_rollouts.rollout_bp`). */
const FULL_ROLLOUT_BP = 10000;

/** The content part one composition produced, before any shedding. */
export interface ComposedPackParts {
  packSets: FeedPackSets | null;
  packFloors: FeedPackFloor[] | null;
  revocations: FeedRevocation[] | null;
  /** Record hashes of the revocations a live app release or a row references (size step 3). */
  referenced: ReadonlySet<string>;
  /** Audit rows the composition owes (written when a document is signed). */
  audits: { action: string; summary: string }[];
}

export const NO_PACK_PARTS: ComposedPackParts = {
  packSets: null,
  packFloors: null,
  revocations: null,
  referenced: new Set(),
  audits: [],
};

/** Compare by UTF-8 bytes (equal to code-point order). */
function bytesCmp(a: string, b: string): number {
  if (a === b) return 0;
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
  return x.length - y.length;
}

/** A stored variant key (`a=b;c=d`, `""` for none) as the row's `variant` object. */
export function variantOfKey(key: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (key === "") return out;
  for (const pair of key.split(";")) {
    const at = pair.indexOf("=");
    if (at > 0) out[pair.slice(0, at)] = pair.slice(at + 1);
  }
  return out;
}

/**
 * The effective binding of every compatible and standalone pack on every live outlet (CONTENT
 * §6.6): `pinned` where the pack's transport on that outlet cannot float, else the declared
 * binding. Exported for P4-15's console view. A (pack, outlet) with no transport row uses
 * `defaultTransport`.
 */
export function effectivePackBindings(
  packs: readonly Pick<ManifestPackDeliverable, "id" | "binding">[],
  outlets: readonly Pick<DeliveryOutlet, "outletId">[],
  transports: readonly {
    deliverable: string;
    outlet: string;
    transport: string;
  }[],
  defaultTransport: string,
): Record<string, Record<string, string>> {
  const by = new Map<string, string>();
  for (const t of transports)
    by.set(`${t.deliverable}\u0000${t.outlet}`, t.transport);
  const out: Record<string, Record<string, string>> = {};
  for (const o of outlets) {
    const row: Record<string, string> = {};
    for (const p of packs) {
      if (p.binding !== "compatible" && p.binding !== "standalone") continue;
      const t = by.get(`${p.id}\u0000${o.outletId}`) ?? defaultTransport;
      const floats = Object.hasOwn(TRANSPORT_FLOATS, t)
        ? TRANSPORT_FLOATS[t as Transport]
        : true;
      row[p.id] = floats ? p.binding : "pinned";
    }
    out[o.outletId] = row;
  }
  return out;
}

/** Truncate the revocation list to `MAX_FEED_REVOCATIONS`: unreferenced first, then oldest.
 *  Exported for its test (a delegation's revocation, always referenced, survives). */
export function truncateRevocations(
  list: (FeedRevocation & { issuedAt: number })[],
  referenced: ReadonlySet<string>,
): { kept: (FeedRevocation & { issuedAt: number })[]; dropped: number } {
  if (list.length <= MAX_FEED_REVOCATIONS) return { kept: list, dropped: 0 };
  const order = [...list].sort(
    (a, b) =>
      Number(referenced.has(b.record)) - Number(referenced.has(a.record)) ||
      b.issuedAt - a.issuedAt ||
      bytesCmp(a.record, b.record),
  );
  const keep = new Set(
    order.slice(0, MAX_FEED_REVOCATIONS).map((r) => r.record),
  );
  return {
    kept: list.filter((r) => keep.has(r.record)),
    dropped: list.length - keep.size,
  };
}

/**
 * The per-outlet pack GATES (P4-14, plans/P4-13.md §2.2 and §2.6 rows C11–C13): Distribution's
 * rollouts and halts of pack releases, keyed by the target's record hash, under
 * `packSets.outlets.<outletId>.gates`. For every rollout row of a declared pack on `channel` whose
 * release a stored row offers (a key of `releases`), on a live outlet where the pack floats:
 *
 *   active | paused   `{halted: false, rollout: {bp, salt}, fallback}`: a device outside the bucket
 *                     (`u32(sha256(salt ‖ installId)[0..4]) mod 10000 >= bp`, evaluated on the
 *                     device) takes `fallback` instead (C11, C12). Skipped when `bp` is 10000
 *                     (everyone is in), and for a MIRRORED row (a store connector owns it, P5-*);
 *   halted            `{halted: true, fallback}`: every device takes `fallback` (C13) — a
 *                     pack-only rollback (CONTENT §6.7 item 5);
 *   complete          no gate: the release is out to everyone.
 *
 * `fallback` is the release the rows would name WITHOUT the releases gated ON THAT OUTLET: one
 * more resolution of the channel per distinct set of gated releases, with those removed from their
 * packs' candidates (the outlet's "previous set").
 * When the rows that offer the target disagree on it, or name none, it is `null` (a device keeps
 * what it has). Each fallback joins `releases`, so it is always a key there. Mutates `packSets`.
 */
async function composeGates(
  hooks: ServiceHooks,
  channel: string,
  stored: readonly {
    channel: string;
    contentApi: number;
    platform: string;
    engine: string;
    variant: string;
    packs: readonly { pack: string; releaseId: string; sha256: string }[];
  }[],
  packSets: FeedPackSets,
  bindings: Record<string, Record<string, string>>,
  declaredIds: ReadonlySet<string>,
  state: Awaited<ReturnType<typeof loadResolutionState>>,
): Promise<{ audits: ComposedPackParts["audits"] }> {
  const audits: ComposedPackParts["audits"] = [];
  const delivery = hooks.delivery();
  if (!delivery) return { audits };
  // A release a row offers, by release id.
  const offered = new Map<string, { pack: string; sha256: string }>();
  for (const s of stored)
    for (const m of s.packs)
      offered.set(m.releaseId, { pack: m.pack, sha256: m.sha256 });
  const rows = (await delivery.rollouts()).filter(
    (r) =>
      r.channel === channel &&
      r.deliverableId !== APP_DELIVERABLE_ID &&
      declaredIds.has(r.deliverableId) &&
      offered.get(r.releaseId)?.pack === r.deliverableId &&
      Object.hasOwn(bindings, r.outletId) &&
      bindings[r.outletId]![r.deliverableId] !== "pinned",
  );
  const gates: {
    outlet: string;
    releaseId: string;
    target: string;
    gate: FeedPackGate;
  }[] = [];
  for (const r of rows) {
    const target = offered.get(r.releaseId)!.sha256;
    if (r.state === "halted") {
      gates.push({
        outlet: r.outletId,
        releaseId: r.releaseId,
        target,
        gate: { halted: true, fallback: null },
      });
      continue;
    }
    if (r.mirrored || (r.state !== "active" && r.state !== "paused")) continue;
    if (
      !Number.isSafeInteger(r.rolloutBp) ||
      r.rolloutBp < 0 ||
      r.rolloutBp >= FULL_ROLLOUT_BP ||
      !/^[0-9a-f]{32}$/.test(r.rolloutSalt)
    )
      continue;
    gates.push({
      outlet: r.outletId,
      releaseId: r.releaseId,
      target,
      gate: {
        halted: false,
        rollout: { bp: r.rolloutBp, salt: r.rolloutSalt },
        fallback: null,
      },
    });
  }
  if (gates.length === 0) return { audits };

  // The previous set, PER OUTLET: the channel resolved without the releases gated on that outlet
  // (an outlet's devices see only its own gates). Outlets gating the same releases share one
  // resolution.
  const fallbacks = new Map<string, string | null>(); // `${outlet}\u0000${target}` → fallback
  if (state) {
    const byOutlet = new Map<string, Set<string>>();
    for (const g of gates) {
      const set = byOutlet.get(g.outlet) ?? new Set<string>();
      set.add(g.releaseId);
      byOutlet.set(g.outlet, set);
    }
    const resolved = new Map<string, Map<string, ResolvedSet> | null>();
    for (const [outlet, without] of byOutlet) {
      const key = [...without].sort().join("\u0000");
      if (!resolved.has(key)) {
        try {
          const alt = new PackResolver({
            ...state.input,
            channels: [channel],
            packs: state.input.packs.map((p) => ({
              ...p,
              candidates: p.candidates.filter((c) => !without.has(c.releaseId)),
            })),
          }).resolve();
          resolved.set(key, new Map(alt.sets.map((s) => [rowKey(s), s])));
        } catch (e) {
          if (!(e instanceof PackResolutionError)) throw e;
          resolved.set(key, null);
          audits.push({
            action: "update.feed.gate_fallback_omitted",
            summary:
              `The ${channel} feed's pack gates on ${outlet} carry no fallback: resolving the previous set failed (${e.message})`.slice(
                0,
                1000,
              ),
          });
        }
      }
      const altRows = resolved.get(key);
      if (!altRows) continue;
      for (const target of new Set(
        gates.filter((g) => g.outlet === outlet).map((g) => g.target),
      )) {
        const named = new Set<string>();
        let pack: string | null = null;
        for (const s of stored) {
          const m = s.packs.find((x) => x.sha256 === target);
          if (!m) continue;
          pack = m.pack;
          const e = altRows
            .get(rowKey(s))
            ?.entries.find((x) => x.pack === m.pack);
          named.add(e ? e.recordSha256 : "");
          if (e && !Object.hasOwn(packSets.releases, e.recordSha256))
            packSets.releases[e.recordSha256] = {
              pack: e.pack,
              version: e.version,
              seq: e.seq,
            };
        }
        const only = named.size === 1 ? [...named][0]! : "";
        fallbacks.set(
          `${outlet}\u0000${target}`,
          pack !== null && only !== "" && only !== target ? only : null,
        );
      }
    }
  }
  // Drop a fallback release no gate ended up naming (a disagreement leaves it unused).
  const used = new Set<string>();
  const outlets = (packSets.outlets ??= {});
  for (const g of gates.sort(
    (a, b) => bytesCmp(a.outlet, b.outlet) || bytesCmp(a.target, b.target),
  )) {
    const fallback = fallbacks.get(`${g.outlet}\u0000${g.target}`) ?? null;
    if (fallback !== null) used.add(fallback);
    const entry = (outlets[g.outlet] ??= {});
    (entry.gates ??= {})[g.target] = { ...g.gate, fallback };
  }
  const listed = new Set<string>();
  for (const members of Object.values(packSets.sets))
    for (const h of members) listed.add(h);
  for (const h of Object.keys(packSets.releases))
    if (!listed.has(h) && !used.has(h)) delete packSets.releases[h];
  return { audits };
}

export interface PackPartsContext {
  db: Db;
  product: string;
  hooks: ServiceHooks;
  cfg: ReleaseConfigRow;
}

/** One composition of the content members of `channel` (canonical). Never throws: a failure to
 *  read leaves the members out (devices then keep their content). */
export async function composePackParts(
  ctx: PackPartsContext,
  channel: string,
): Promise<ComposedPackParts> {
  try {
    return await compose(ctx, channel);
  } catch (e) {
    return {
      ...NO_PACK_PARTS,
      audits: [
        {
          action: "update.feed.packs_omitted",
          summary:
            `The ${channel} feed's content members could not be composed and were left out: ${e instanceof Error ? e.message : String(e)}`.slice(
              0,
              1000,
            ),
        },
      ],
    };
  }
}

async function compose(
  ctx: PackPartsContext,
  channel: string,
): Promise<ComposedPackParts> {
  const { db, product, hooks } = ctx;
  const declared = (await readPackDeliverables(db, product)).packs;
  const catalog = hooks.releaseCatalog();
  const revocationsInForce: CatalogRevocation[] = catalog
    ? await catalog.revocations()
    : [];
  if (declared.length === 0 && revocationsInForce.length === 0)
    return NO_PACK_PARTS;
  const audits: ComposedPackParts["audits"] = [];

  // ── packSets ─────────────────────────────────────────────────────────────────────────────
  const stored = (await readStoredSets(db, product, channel)).filter(
    (s) => s.appDeliverable === APP_DELIVERABLE_ID && s.channel === channel,
  );
  const releases: Record<string, FeedPackRelease> = {};
  const sets: Record<string, string[]> = {};
  const rows: FeedPackRow[] = [];
  let mismatch = false;
  for (const s of stored) {
    const members = [...s.packs].sort((a, b) => bytesCmp(a.pack, b.pack));
    const id = await packSetId(
      members.map((m) => ({ packId: m.pack, releaseSha256: m.sha256 })),
    );
    if (id === null || id !== s.packSetId) {
      mismatch = true;
      continue;
    }
    for (const m of members)
      releases[m.sha256] = { pack: m.pack, version: m.version, seq: m.seq };
    sets[id] = members.map((m) => m.sha256);
    rows.push({
      contentApi: s.contentApi,
      platform: s.platform,
      engine: s.engine,
      variant: variantOfKey(s.variant),
      set: id,
    });
  }
  let packSets: FeedPackSets | null = null;
  let bindings: Record<string, Record<string, string>> = {};
  if (mismatch) {
    audits.push({
      action: "update.feed.packs_omitted",
      summary: `A stored ${channel} pack set's id is not the packSetId of its members; packSets was left out of the feed until the next resolution.`,
    });
  } else if (rows.length > 0) {
    packSets = { releases, sets, rows };
    const delivery = hooks.delivery();
    if (delivery) {
      const outlets = await delivery.outlets();
      const transports = await delivery.transports();
      bindings = effectivePackBindings(
        declared,
        outlets,
        transports,
        delivery.defaultTransport,
      );
      const parts: Record<string, FeedPackOutlet> = {};
      for (const [outlet, byPack] of Object.entries(bindings)) {
        const pinned = Object.keys(byPack)
          .filter((p) => byPack[p] === "pinned")
          .sort(bytesCmp);
        if (pinned.length > 0) parts[outlet] = { pinned };
      }
      if (Object.keys(parts).length > 0) packSets.outlets = parts;
    }
  }

  // ── packFloors ───────────────────────────────────────────────────────────────────────────
  const state = await loadResolutionState(db, product, ctx.cfg);

  // ── gates (P4-14) ────────────────────────────────────────────────────────────────────────
  if (packSets) {
    const gated = await composeGates(
      hooks,
      channel,
      stored,
      packSets,
      bindings,
      new Set(declared.map((d) => d.id)),
      state,
    );
    audits.push(...gated.audits);
  }
  // level → its newest live app release's packChannels mapping.
  const levels = new Map<number, Record<string, string> | null>();
  const liveIds = new Set<string>();
  if (state) {
    for (const r of new PackResolver(state.input).live(channel)) {
      liveIds.add(r.releaseId);
      if (!levels.has(r.contentApi))
        levels.set(
          r.contentApi,
          state.input.app.releases.get(r.releaseId)?.packChannels ?? null,
        );
    }
  }
  const policies = await db.all<{
    deliverable_id: string;
    channel: string;
    min_supported: string | null;
  }>(
    `SELECT deliverable_id, channel, min_supported FROM release_channel_policy
      WHERE product = ? AND deliverable_id != ?`,
    product,
    APP_DELIVERABLE_ID,
  );
  const levelFloors = await db.all<{
    deliverable_id: string;
    channel: string;
    content_api: number;
    min_version: string;
  }>(
    `SELECT deliverable_id, channel, content_api, min_version FROM release_pack_floors
      WHERE product = ?`,
    product,
  );
  const floors: FeedPackFloor[] = [];
  for (const pack of [...declared].sort((a, b) => bytesCmp(a.id, b.id))) {
    const scheme = pack.versioning.scheme;
    for (const [level, map] of [...levels.entries()].sort(
      ([a], [b]) => a - b,
    )) {
      const packChannel = packChannelFor(map, pack.id) ?? channel;
      const inputs: string[] = [];
      const free = policies.find(
        (p) => p.deliverable_id === pack.id && p.channel === packChannel,
      )?.min_supported;
      if (free) inputs.push(free);
      const at = levelFloors.find(
        (f) =>
          f.deliverable_id === pack.id &&
          f.channel === packChannel &&
          f.content_api === level,
      );
      if (at) inputs.push(at.min_version);
      let best: string | null = null;
      for (const v of inputs) {
        if (parseVersion(scheme, v) === null) continue;
        if (best === null || (compareVersions(scheme, v, best) ?? 0) > 0)
          best = v;
      }
      if (best !== null)
        floors.push({
          pack: pack.id,
          contentApi: level,
          minVersion: best,
          versionScheme: scheme,
        });
    }
  }

  // ── revocations ──────────────────────────────────────────────────────────────────────────
  let revocations: FeedRevocation[] | null = null;
  const referenced = new Set<string>();
  if (revocationsInForce.length > 0) {
    // App releases on the channel, live or not, and the targets they pin or hold.
    const onChannel = new Set<string>(liveIds);
    if (state)
      for (const c of state.input.app.candidates)
        if (c.channel === channel) onChannel.add(c.releaseId);
    const refs = await db.all<{
      app_release_id: string;
      record_sha256: string;
    }>(
      `SELECT app_release_id, record_sha256 FROM release_pins WHERE product = ?
       UNION ALL
       SELECT app_release_id, record_sha256 FROM release_holds WHERE product = ?`,
      product,
      product,
    );
    const byChannel = new Set<string>();
    const byLive = new Set<string>();
    for (const r of refs) {
      if (onChannel.has(r.app_release_id)) byChannel.add(r.record_sha256);
      if (liveIds.has(r.app_release_id)) byLive.add(r.record_sha256);
    }
    const listed = new Set<string>();
    for (const sets of Object.values(packSets?.sets ?? {}))
      for (const h of sets) listed.add(h);
    const list: (FeedRevocation & { issuedAt: number })[] = [];
    for (const r of revocationsInForce) {
      // P4-19 (plans/P4-19.md §6.3): a delegation's revocation names no release, so no pin,
      // hold or set ever lists its target. It is always listed, with `pack` the scope root, and
      // counts as referenced: never dropped under the cap, kept at size step 3.
      if (r.kind === "delegation") {
        referenced.add(r.recordSha256);
        list.push({
          record: r.recordSha256,
          pack: r.deliverableId,
          target: r.targetSha256,
          version: r.version,
          seq: r.seq,
          kind: "delegation",
          issuedAt: r.issuedAt,
        });
        continue;
      }
      const keep = byChannel.has(r.targetSha256) || listed.has(r.targetSha256);
      if (!keep) continue;
      if (byLive.has(r.targetSha256) || listed.has(r.targetSha256))
        referenced.add(r.recordSha256);
      list.push({
        record: r.recordSha256,
        pack: r.deliverableId,
        target: r.targetSha256,
        version: r.version,
        seq: r.seq,
        issuedAt: r.issuedAt,
      });
    }
    const t = truncateRevocations(list, referenced);
    if (t.dropped > 0)
      audits.push({
        action: "update.feed.revocations_truncated",
        summary: `The ${channel} feed lists ${MAX_FEED_REVOCATIONS} of ${list.length} revocations; ${t.dropped} unreferenced or oldest were left out.`,
      });
    if (t.kept.length > 0)
      revocations = t.kept
        .map(({ issuedAt: _i, ...r }) => r)
        .sort(
          (a, b) =>
            bytesCmp(a.pack, b.pack) ||
            a.seq - b.seq ||
            bytesCmp(a.record, b.record),
        );
  }

  return {
    packSets,
    packFloors: floors.length > 0 ? floors : null,
    revocations,
    referenced,
    audits,
  };
}
