/**
 * The console's compatibility matrix (P4-15, CONTENT §6.9 "console", README §6.2 item 4):
 * `GET /manage/api/products/<slug>/release/compat` — app releases × pack releases, one cell per
 * pair, read from Release alone (CONTENT §6.3: release never reads distribution; the SPA overlays
 * per-outlet liveness from Distribution's own matrix).
 *
 * ── CELL STATES (the first that applies) ────────────────────────────────────────────────────
 *
 *   revoked       a `kind: revocation` record names the pack release (P4-13). From P4-19 a
 *                 revoked DELEGATION revokes every release signed under it (P4-19,
 *                 client-core's `recordRevoked`; see `revokedBy`).
 *   pinned        the app release pins it (`release_pins`).
 *   held          the app release holds it (`release_holds`).
 *   compatible    a variant of it admits the app release: for a `compatible` pack its
 *                 `requires.contentApi.app` range holds the app release's level (P4-12's
 *                 `levelInRange`) AND it runs on an engine the app release's builds declare (the
 *                 resolver's own `variantRunsOn`); for a `standalone` pack the engine alone.
 *   incompatible  otherwise. A `pinned`-binding pack reaches a device only through a pin, so
 *                 every other cell of it is incompatible.
 *
 * `current` marks the release that IS the set member for the app release: a stored
 * `release_sets` row (what the feed composes from) that serves it — on a channel where it is live,
 * at its level, on a platform and engine one of its builds has — names it. Yanked is a modifier on
 * the release, never a state.
 *
 * ── LIVE LEVELS ─────────────────────────────────────────────────────────────────────────────
 *
 * From P4-12's live-app computation (`PackResolver.live`, floor-based, never store availability),
 * so the highlighted levels are exactly the ones resolution stores rows for and the feed carries.
 *
 * ── SIZE ────────────────────────────────────────────────────────────────────────────────────
 *
 * A PAGE: live app releases plus the window [`offset`, `offset + limit`) of each channel's
 * releases, newest first (`limit` default 10); pack releases that are a set member plus the same
 * window of each deliverable's releases, read with a windowed query so a pack's whole history is
 * never loaded. App releases are capped at `COMPAT_MAX_APP_RELEASES` in all (live first, then
 * newest; `capped` says so), which bounds the cells at that many × the pack releases shown.
 * `hidden` counts what the page leaves out, `older` what lies past it; `offset` pages through
 * them in.
 *
 * Read-only: no write, no audit. Keyed by deliverable; the console names no pack (AGENTS rule 5).
 */

import { APP_DELIVERABLE_ID } from "@polaris-key/manifest";
import type { CatalogRevocation } from "../../../core/hooks.js";
import type { Db } from "../../../core/platform.js";
import type { ReleaseConfigRow } from "../config.js";
import { listYanks } from "../model.js";
import { recordRevoked } from "@polaris-key/client-core/record";
import { readAllRevocations } from "./revocations.js";
import {
  loadResolutionState,
  packVariantFacts,
  readStoredSets,
  type StoredSet,
} from "./sets.js";
import {
  PackResolver,
  levelInRange,
  variantRunsOn,
  type PackVariantFacts,
  type UnsatisfiedReason,
} from "./resolve.js";

export const COMPAT_DEFAULT_LIMIT = 10;
export const COMPAT_MAX_LIMIT = 100;
/** The most app releases (rows) one response carries, live ones first. */
export const COMPAT_MAX_APP_RELEASES = 200;
/** The largest `offset` accepted. */
export const COMPAT_MAX_OFFSET = 100_000;

export type CompatCellState =
  | "pinned"
  | "held"
  | "compatible"
  | "incompatible"
  | "revoked";

export interface CompatYank {
  reason: string;
  at: number;
  by: string;
}

export interface CompatUnsatisfied {
  pack: string;
  reason: UnsatisfiedReason;
  detail: string;
  channel: string;
  platform: string;
  engine: string;
  variant: string;
}

export interface CompatAppRelease {
  releaseId: string;
  version: string;
  seq: number | null;
  channel: string | null;
  contentApi: number | null;
  /** Live on at least one channel (P4-12's live-app computation). */
  live: boolean;
  /** The channels it is live on. */
  liveOn: string[];
  yanked: CompatYank | null;
  /** Its builds' platforms and engines (`""` for a build that declares none). */
  platforms: string[];
  engines: string[];
  pins: { pack: string; releaseId: string }[];
  holds: { pack: string; releaseId: string }[];
  /** The `unsatisfied` markers of the stored rows that serve it (P4-12). */
  unsatisfied: CompatUnsatisfied[];
}

export interface CompatRevocation {
  /** `record` (P4-13) or `delegation` (P4-19). */
  kind: "record" | "delegation";
  recordSha256: string;
  reason: string;
  issuedAt: number;
  replacement: { releaseId: string; sha256: string } | null;
}

export interface CompatPackRelease {
  pack: string;
  releaseId: string;
  version: string;
  seq: number | null;
  /** The pack record's hash (the set member's identity), or null without a stored record. */
  sha256: string | null;
  channel: string | null;
  /** The distinct `requires.contentApi.app` ranges and `requires.engine` values of its variants. */
  requires: { contentApi: string[]; engines: string[] };
  yanked: CompatYank | null;
  revoked: CompatRevocation | null;
  /** A member of some stored set row. */
  current: boolean;
}

export interface CompatCell {
  appReleaseId: string;
  packReleaseId: string;
  state: CompatCellState;
  /** The pack release is the set member serving this app release. */
  current: boolean;
  yanked: boolean;
  reason: string;
}

export interface CompatPack {
  id: string;
  binding: string;
  required: boolean;
  delivery: string;
}

export interface CompatView {
  channels: string[];
  /** Live contentApi levels per channel, ascending. */
  liveLevels: Record<string, number[]>;
  /** Every live level on any channel, ascending. */
  levels: number[];
  limit: number;
  offset: number;
  /** True when more than `COMPAT_MAX_APP_RELEASES` app releases qualified for this page. */
  capped: boolean;
  /** Releases past this page's window (per channel / per deliverable, summed): what a larger
   *  `offset` shows. */
  older: { appReleases: number; packReleases: number };
  packs: CompatPack[];
  appReleases: CompatAppRelease[];
  packReleases: CompatPackRelease[];
  cells: CompatCell[];
  hidden: { appReleases: number; packReleases: number };
  /** When the stored sets were last resolved (newest row), or null with none. */
  resolvedAt: number | null;
}

/** The `offset` query value: 0–`COMPAT_MAX_OFFSET`, default 0; null if bad. */
export function parseCompatOffset(raw: string | null): number | null {
  if (raw === null || raw === "") return 0;
  if (!/^[0-9]{1,6}$/.test(raw)) return null;
  const n = Number(raw);
  return n <= COMPAT_MAX_OFFSET ? n : null;
}

/** The `limit` query value: 1–`COMPAT_MAX_LIMIT`, default `COMPAT_DEFAULT_LIMIT`; null if bad. */
export function parseCompatLimit(raw: string | null): number | null {
  if (raw === null || raw === "") return COMPAT_DEFAULT_LIMIT;
  if (!/^[0-9]{1,4}$/.test(raw)) return null;
  const n = Number(raw);
  return n >= 1 && n <= COMPAT_MAX_LIMIT ? n : null;
}

const bySeqDesc = (
  a: { seq: number | null; releaseId: string },
  b: { seq: number | null; releaseId: string },
): number =>
  (b.seq ?? -1) - (a.seq ?? -1) ||
  (a.releaseId < b.releaseId ? -1 : a.releaseId > b.releaseId ? 1 : 0);

/**
 * The revocation that applies to a pack release, or null, decided by client-core's
 * `recordRevoked(recordSha256, delegationSha256, revoked)` — the one rule every SDK applies
 * (plans/P4-19.md §2.3). `revoked` holds every target in force: a `kind: record` revocation's pack
 * record hash, and a `kind: delegation` revocation's delegation hash. So a release signed under a
 * revoked delegation (its `release_delegated_records` row) reads revoked, with the delegation named
 * in the reason; a record revocation of the release itself wins. A release with no stored record
 * (no hash to test) can only be revoked by a record revocation naming its release id.
 */
export function revokedBy(
  release: {
    releaseId: string;
    sha256: string | null;
    delegation: string | null;
  },
  revocations: readonly CatalogRevocation[],
): CompatRevocation | null {
  const byTarget = new Map<string, CatalogRevocation>();
  for (const r of revocations) byTarget.set(r.targetSha256, r);
  const asView = (
    r: CatalogRevocation,
    kind: "record" | "delegation",
  ): CompatRevocation => ({
    kind,
    recordSha256: r.recordSha256,
    reason:
      kind === "delegation"
        ? `signed under delegation ${r.targetSha256.slice(0, 12)}…, revoked: ${r.reason}`
        : r.reason,
    issuedAt: r.issuedAt,
    replacement: kind === "record" ? r.replacement : null,
  });
  if (release.sha256 !== null) {
    const hit = recordRevoked(
      release.sha256,
      release.delegation,
      new Set(byTarget.keys()),
    );
    if (hit === null) return null;
    const target = hit === "record" ? release.sha256 : release.delegation!;
    const r = byTarget.get(target)!;
    // A record hash that collides with a delegation target is not a record revocation.
    if ((r.kind ?? "record") !== hit) return null;
    return asView(r, hit);
  }
  for (const r of revocations)
    if (
      (r.kind ?? "record") === "record" &&
      r.targetReleaseId === release.releaseId
    )
      return asView(r, "record");
  return null;
}

/** Does any variant admit the app release (see the header)? With the reason either way. */
function compatibility(
  binding: string,
  variants: readonly PackVariantFacts[],
  level: number | null,
  engines: readonly string[],
): { ok: boolean; reason: string } {
  if (binding !== "compatible" && binding !== "standalone")
    return {
      ok: false,
      reason: `${binding} binding: reaches a device only through an app release's pin`,
    };
  if (variants.length === 0)
    return { ok: false, reason: "the release has no stored variant" };
  const runs = (v: PackVariantFacts): boolean =>
    (engines.length > 0 ? engines : [""]).some((e) => variantRunsOn(v, e));
  if (binding === "standalone") {
    const ok = variants.some(runs);
    return ok
      ? { ok, reason: "standalone: admitted at every level" }
      : {
          ok,
          reason: `needs engine ${[...new Set(variants.map((v) => v.engine))].join(", ")}; the builds declare ${engines.join(", ") || "none"}`,
        };
  }
  if (level === null)
    return { ok: false, reason: "the app release declares no contentApi" };
  const ranges = [
    ...new Set(variants.map((v) => v.contentApi?.[APP_DELIVERABLE_ID] ?? "")),
  ];
  const inLevel = variants.filter((v) =>
    levelInRange(v.contentApi?.[APP_DELIVERABLE_ID], level),
  );
  if (inLevel.length === 0)
    return {
      ok: false,
      reason: `contentApi ${ranges.map((r) => r || "(none)").join(", ")} excludes level ${level}`,
    };
  if (!inLevel.some(runs))
    return {
      ok: false,
      reason: `needs engine ${[...new Set(inLevel.map((v) => v.engine))].join(", ")}; the builds declare ${engines.join(", ") || "none"}`,
    };
  return {
    ok: true,
    reason: `contentApi ${inLevel[0]!.contentApi?.[APP_DELIVERABLE_ID]} holds level ${level}`,
  };
}

const EMPTY = (limit: number, offset: number): CompatView => ({
  channels: [],
  liveLevels: {},
  levels: [],
  limit,
  offset,
  capped: false,
  older: { appReleases: 0, packReleases: 0 },
  packs: [],
  appReleases: [],
  packReleases: [],
  cells: [],
  hidden: { appReleases: 0, packReleases: 0 },
  resolvedAt: null,
});

export async function compatView(
  db: Db,
  product: string,
  cfg: ReleaseConfigRow | null,
  limit: number = COMPAT_DEFAULT_LIMIT,
  offset = 0,
  /** The app-release cap; a parameter only so a test can exercise it cheaply. */
  maxAppReleases: number = COMPAT_MAX_APP_RELEASES,
): Promise<CompatView> {
  const state = await loadResolutionState(db, product, cfg);
  if (!state) return EMPTY(limit, offset);
  const resolver = new PackResolver(state.input);
  const channels = [...state.input.channels];

  // ── live app releases, per channel ────────────────────────────────────────────────────────
  const liveOn = new Map<string, string[]>();
  const liveLevels: Record<string, number[]> = {};
  const allLevels = new Set<number>();
  for (const channel of channels) {
    const levels = new Set<number>();
    for (const r of resolver.live(channel)) {
      liveOn.set(r.releaseId, [...(liveOn.get(r.releaseId) ?? []), channel]);
      levels.add(r.contentApi);
      allLevels.add(r.contentApi);
    }
    if (levels.size > 0)
      liveLevels[channel] = [...levels].sort((a, b) => a - b);
  }

  const yanks = new Map(
    (await listYanks(db, product)).map((y) => [y.release_id, y]),
  );
  const yankOf = (id: string): CompatYank | null => {
    const y = yanks.get(id);
    return y ? { reason: y.reason, at: y.at, by: y.by } : null;
  };

  // ── stored sets (what the feed composes from) ─────────────────────────────────────────────
  const stored: StoredSet[] = (await readStoredSets(db, product, null)).filter(
    (s) => s.appDeliverable === APP_DELIVERABLE_ID,
  );
  const members = new Set<string>();
  let resolvedAt: number | null = null;
  for (const s of stored) {
    for (const m of s.packs) members.add(m.releaseId);
    if (resolvedAt === null || s.resolvedAt > resolvedAt)
      resolvedAt = s.resolvedAt;
  }

  // ── app releases: live plus the last `limit` per channel ──────────────────────────────────
  const pins = await db.all<{
    app_release_id: string;
    pack_deliverable: string;
    pack_release_id: string;
  }>(
    `SELECT app_release_id, pack_deliverable, pack_release_id FROM release_pins
      WHERE product = ? ORDER BY app_release_id, pack_deliverable`,
    product,
  );
  const pinsBy = new Map<string, { pack: string; releaseId: string }[]>();
  for (const p of pins)
    pinsBy.set(p.app_release_id, [
      ...(pinsBy.get(p.app_release_id) ?? []),
      { pack: p.pack_deliverable, releaseId: p.pack_release_id },
    ]);

  const appAll = [...state.input.app.candidates].sort(bySeqDesc);
  const live: string[] = [];
  const windowed: string[] = [];
  const perChannel = new Map<string, number>();
  let olderApps = 0;
  for (const c of appAll) {
    const key = c.channel ?? "";
    const n = perChannel.get(key) ?? 0;
    perChannel.set(key, n + 1);
    if (liveOn.has(c.releaseId)) live.push(c.releaseId);
    else if (n >= offset && n < offset + limit) windowed.push(c.releaseId);
    else if (n >= offset + limit) olderApps++;
  }
  // Live first, then the window, newest first in each, up to the cap.
  const chosen = [...live, ...windowed];
  const capped = chosen.length > maxAppReleases;
  const appKeep = new Set(chosen.slice(0, maxAppReleases));
  const appReleases: CompatAppRelease[] = [];
  for (const c of appAll) {
    if (!appKeep.has(c.releaseId)) continue;
    const facts = state.input.app.releases.get(c.releaseId);
    const builds = (facts?.builds ?? []).filter((b) => b.platform !== null);
    const on = liveOn.get(c.releaseId) ?? [];
    const level = facts?.contentApi ?? null;
    const unsatisfied: CompatUnsatisfied[] = [];
    for (const s of stored) {
      if (!on.includes(s.channel) || s.contentApi !== level) continue;
      if (
        !builds.some(
          (b) => b.platform === s.platform && (b.engine ?? "") === s.engine,
        )
      )
        continue;
      for (const u of s.unsatisfied)
        unsatisfied.push({
          ...u,
          channel: s.channel,
          platform: s.platform,
          engine: s.engine,
          variant: s.variant,
        });
    }
    appReleases.push({
      releaseId: c.releaseId,
      version: c.version,
      seq: c.seq,
      channel: c.channel,
      contentApi: level,
      live: on.length > 0,
      liveOn: on,
      yanked: yankOf(c.releaseId),
      platforms: [...new Set(builds.map((b) => b.platform as string))].sort(),
      engines: [...new Set(builds.map((b) => b.engine ?? ""))].sort(),
      pins: pinsBy.get(c.releaseId) ?? [],
      holds: facts?.holds ?? [],
      unsatisfied,
    });
  }

  // ── pack releases: set members plus the last `limit` per deliverable ──────────────────────
  const declared = [...state.declared.values()].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  const packs: CompatPack[] = declared.map((d) => ({
    id: d.id,
    binding: d.binding,
    required: d.required,
    delivery: d.delivery,
  }));
  const ids = JSON.stringify(declared.map((d) => d.id));
  const rows =
    declared.length === 0
      ? []
      : await db.all<{
          release_id: string;
          deliverable_id: string;
          version: string;
          seq: number | null;
          channel: string | null;
          record_sha256: string | null;
          delegation: string | null;
          rn: number;
        }>(
          // Each deliverable's releases ranked newest first (`bySeqDesc`'s order: seq descending,
          // a null seq last, ties by release id); only the page's window and the set members are
          // read back.
          `SELECT m.release_id, m.deliverable_id, m.version, m.seq, m.channel, m.rn,
                  r.record_sha256, d.delegation_sha256 AS delegation
             FROM (SELECT release_id, deliverable_id, version, seq, channel, product,
                          ROW_NUMBER() OVER (PARTITION BY deliverable_id
                            ORDER BY seq IS NULL, seq DESC, release_id) AS rn
                     FROM release_metadata
                    WHERE product = ? AND deliverable_id IN (SELECT value FROM json_each(?))) m
             LEFT JOIN release_records r
               ON r.product = m.product AND r.release_id = m.release_id AND r.kind = 'pack'
             LEFT JOIN release_delegated_records d
               ON d.product = r.product AND d.record_sha256 = r.record_sha256
            WHERE (m.rn > ? AND m.rn <= ?)
               OR m.release_id IN (SELECT value FROM json_each(?))`,
          product,
          ids,
          offset,
          offset + limit,
          JSON.stringify([...members]),
        );
  const shownIds = JSON.stringify(rows.map((r) => r.release_id));
  const totals = new Map(
    (declared.length === 0
      ? []
      : await db.all<{ deliverable_id: string; n: number }>(
          `SELECT deliverable_id, COUNT(*) AS n FROM release_metadata
            WHERE product = ? AND deliverable_id IN (SELECT value FROM json_each(?))
            GROUP BY deliverable_id`,
          product,
          ids,
        )
    ).map((r) => [r.deliverable_id, r.n]),
  );
  const builds =
    declared.length === 0
      ? []
      : await db.all<{
          release_id: string;
          variant_json: string | null;
          requires_json: string | null;
          conflicts_json: string | null;
        }>(
          `SELECT b.release_id, b.variant_json, b.requires_json, b.conflicts_json
             FROM release_builds b
            WHERE b.product = ? AND b.release_id IN (SELECT value FROM json_each(?))
            ORDER BY b.release_id, b.build_id`,
          product,
          shownIds,
        );
  const variantsBy = new Map<string, PackVariantFacts[]>();
  for (const b of builds)
    variantsBy.set(b.release_id, [
      ...(variantsBy.get(b.release_id) ?? []),
      packVariantFacts(b),
    ]);
  const revocations = await readAllRevocations(db, product);

  const packReleases: CompatPackRelease[] = [];
  let hiddenPacks = 0;
  let olderPacks = 0;
  for (const d of declared) {
    const mine = rows
      .filter((r) => r.deliverable_id === d.id)
      .map((r) => ({ ...r, releaseId: r.release_id }))
      .sort(bySeqDesc);
    const total = totals.get(d.id) ?? 0;
    hiddenPacks += total - mine.length;
    // Past the window, less the set members shown from there.
    olderPacks +=
      Math.max(0, total - (offset + limit)) -
      mine.filter((r) => r.rn > offset + limit).length;
    for (const r of mine) {
      const variants = variantsBy.get(r.release_id) ?? [];
      packReleases.push({
        pack: d.id,
        releaseId: r.release_id,
        version: r.version,
        seq: r.seq,
        sha256: r.record_sha256,
        channel: r.channel,
        requires: {
          contentApi: [
            ...new Set(
              variants
                .map((v) => v.contentApi?.[APP_DELIVERABLE_ID])
                .filter((x): x is string => typeof x === "string"),
            ),
          ],
          engines: [
            ...new Set(
              variants
                .map((v) => v.engine)
                .filter((x): x is string => x !== null),
            ),
          ],
        },
        yanked: yankOf(r.release_id),
        revoked: revokedBy(
          {
            releaseId: r.release_id,
            sha256: r.record_sha256,
            delegation: r.delegation,
          },
          revocations,
        ),
        current: members.has(r.release_id),
      });
    }
  }

  // ── cells ─────────────────────────────────────────────────────────────────────────────────
  const bindingOf = new Map(declared.map((d) => [d.id, d.binding as string]));
  const cells: CompatCell[] = [];
  for (const a of appReleases) {
    const facts = state.input.app.releases.get(a.releaseId);
    const serving = stored.filter(
      (s) =>
        a.liveOn.includes(s.channel) &&
        s.contentApi === a.contentApi &&
        (facts?.builds ?? []).some(
          (b) => b.platform === s.platform && (b.engine ?? "") === s.engine,
        ),
    );
    const currentIds = new Set(
      serving.flatMap((s) => s.packs.map((m) => m.releaseId)),
    );
    const pinned = new Set(a.pins.map((p) => p.releaseId));
    const held = new Set(a.holds.map((h) => h.releaseId));
    for (const p of packReleases) {
      const base = {
        appReleaseId: a.releaseId,
        packReleaseId: p.releaseId,
        current: currentIds.has(p.releaseId),
        yanked: p.yanked !== null,
      };
      if (p.revoked) {
        cells.push({
          ...base,
          state: "revoked",
          reason: `revoked (${p.revoked.reason || "no reason given"})${pinned.has(p.releaseId) ? "; the app release pins it" : held.has(p.releaseId) ? "; the app release holds it" : ""}`,
        });
        continue;
      }
      if (pinned.has(p.releaseId)) {
        cells.push({
          ...base,
          state: "pinned",
          reason: "the app release pins it",
        });
        continue;
      }
      if (held.has(p.releaseId)) {
        cells.push({
          ...base,
          state: "held",
          reason: "the app release holds it",
        });
        continue;
      }
      const c = compatibility(
        bindingOf.get(p.pack) ?? "pinned",
        variantsBy.get(p.releaseId) ?? [],
        a.contentApi,
        a.engines,
      );
      cells.push({
        ...base,
        state: c.ok ? "compatible" : "incompatible",
        reason: c.reason,
      });
    }
  }

  return {
    channels,
    liveLevels,
    levels: [...allLevels].sort((a, b) => a - b),
    limit,
    offset,
    capped,
    older: { appReleases: olderApps, packReleases: olderPacks },
    packs,
    appReleases,
    packReleases,
    cells,
    hidden: {
      appReleases: appAll.length - appReleases.length,
      packReleases: hiddenPacks,
    },
    resolvedAt,
  };
}
