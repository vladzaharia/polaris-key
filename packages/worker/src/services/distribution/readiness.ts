/**
 * Outlet readiness (P4-14, CONTENT §6.4, README §3.8 `dist_readiness`): an app release must not go
 * live on an outlet before its REQUIRED pack set is available through that outlet's transport.
 *
 * ── THE REQUIRED SET ────────────────────────────────────────────────────────────────────────
 *
 * Per (app release A, outlet O), read only through Release's catalog hook (release never reads
 * distribution):
 *
 *   - A's `required` pins (`pins`);
 *   - for every channel A is live on (`liveLevels`), the `required` compatible and standalone packs
 *     of the stored sets at A's contentApi level (`packSets`), on the platforms O serves
 *     (`OUTLET_PLATFORMS`, narrowed by a `direct` outlet's `platforms`). A pack the set marks
 *     `unsatisfied` blocks: the app would boot without required content. A level with no stored
 *     set while required packs are declared (a failed resolution clears them) is `pending`;
 *   - A's holds of required packs (`holdsFor`), which replace that pack's set member.
 *
 * ── READY, PER TRANSPORT (the pack's transport on O) ────────────────────────────────────────
 *
 *   embedded, play-pad, steam-depot   ready by construction (the build carries the pack)
 *   pkey-cdn, web                     every object the pack record names is stored with the
 *                                     recorded hash and length AND held by this product's ref
 *                                     (P4-05's availability rule); and the pack is fetchable: an
 *                                     `entitled` pack with no gate (`dist_access.entitlement`
 *                                     null) is fetchable by no device (P4-05 N4), so it blocks
 *   apple-ba                          a stored (CI or connector) availability record of the pack
 *                                     release on O in `approved` or `live`; when it names an
 *                                     `assetPackIdentifier`, that must be exactly the level's asset
 *                                     pack (`<pack>-c<contentApi>`, dots as hyphens), for EVERY level the pack is
 *                                     required at (one asset pack per level, CONTENT §6.6). Until
 *                                     P5-08 links P5-02's ASC states to pack releases, CI reports
 *                                     stand in beside them
 *   msix-optional, flatpak-ext        a stored availability record in `approved` or `live`
 *   anything else                     blocked (fail closed)
 *
 * ── STATES AND THE HOLD ─────────────────────────────────────────────────────────────────────
 *
 * `pending` (the set cannot be computed yet), `blocked` (the first blocker is named), `ready`, or
 * `overridden` (an operator's `dist_readiness` row with `source = 'admin'`, audited, surviving every
 * recompute and resync). On an outlet Polaris Key controls (`HOLDABLE_OUTLET_KINDS`: the outlets
 * whose bytes or feed it serves), a release that is `pending` or `blocked` is HELD: the delivery
 * hook's availability answers its `live` records as `pending` (so the signed feed's per-outlet
 * `live` stays on the previous release), and the storefront feeds skip it. On a store outlet it
 * cannot hold, readiness records the blocker and a warning only (a store connector's
 * `PENDING_DEVELOPER_RELEASE` hold is P5-08's).
 *
 * The hold is COMPUTED ON READ, so a new app release is held from its very first request.
 * `dist_readiness` is the persisted snapshot (`refreshReadiness`): refreshed by Distribution's own
 * triggers (a pack availability report, the connector cron, an operator's refresh) and holding the
 * operator's overrides. Release-side triggers (an app publish or promote, a re-resolved set) take
 * effect at once through the computation, and reach the snapshot on the next cron tick.
 */

import { parseJsonColumn } from "../../platform/json.js";
import { randomId } from "../../crypto.js";
import type { Db } from "../../db/types.js";
import { APP_DELIVERABLE_ID, assetPackId } from "@polaris-key/manifest";
import { OUTLET_PLATFORMS } from "@polaris-key/protocol/distribution";
import { appendAudit } from "../../repo.js";
import { referencedKeys, storedObjects } from "../../core/blobs.js";
import {
  DEFAULT_TRANSPORT,
  type AvailabilityRecord,
  type CatalogLiveLevel,
  type CatalogPackDeliverable,
  type CatalogPackRelease,
  type CatalogPackSet,
  type ReleaseCatalog,
  type ServiceHooks,
} from "../../core/hooks.js";
import { listOutlets, listTransports, type DistOutletRow } from "./outlets.js";
import { accessModeOf, entitlementOf } from "./access.js";

// ── Vocabulary ───────────────────────────────────────────────────────────────────────────────

export const READINESS_STATES = [
  "pending",
  "blocked",
  "ready",
  "overridden",
] as const;
export type ReadinessState = (typeof READINESS_STATES)[number];
export type ComputedReadiness = Exclude<ReadinessState, "overridden">;

/** Transports that ship inside the build: ready by construction. */
export const BUILT_IN_TRANSPORTS: readonly string[] = [
  "embedded",
  "play-pad",
  "steam-depot",
];
/** Transports whose bytes Polaris Key serves: ready once every object is stored and held. */
export const CDN_TRANSPORTS: readonly string[] = ["pkey-cdn", "web"];
/** Transports a store hosts: ready once a stored availability record says approved or live. */
export const REPORTED_TRANSPORTS: readonly string[] = [
  "apple-ba",
  "msix-optional",
  "flatpak-ext",
];
const APPROVED_STATES: readonly string[] = ["approved", "live"];

/**
 * Outlet kinds Polaris Key can hold a release on: the self-hosted kinds whose `live` it derives
 * (`DERIVED_OUTLET_KINDS` in `availability.ts`, which a test keeps a subset of this list) plus the
 * kinds whose storefront feed it serves (`altstore-pal`, `flathub`). Every other kind is a store:
 * readiness warns there and never holds.
 */
export const HOLDABLE_OUTLET_KINDS: readonly string[] = [
  "direct",
  "web",
  "altstore",
  "obtainium",
  "fdroid-repo",
  "app-installer",
  "altstore-pal",
  "flathub",
];

export type BlockerReason =
  | "objects-missing"
  | "entitlement-missing"
  | "awaiting-approval"
  | "transport-unsupported"
  | "unsatisfied"
  | "release-missing";

export interface ReadinessBlocker {
  pack: string;
  /** `null` for `unsatisfied` (no release satisfies the pack at the level). */
  packReleaseId: string | null;
  version: string | null;
  transport: string;
  reason: BlockerReason;
  detail: string;
  /** `apple-ba`: the asset pack the level needs (`<pack>-c<contentApi>`, P5-08). */
  assetPack?: string;
}

export interface RequiredPack {
  pack: string;
  packReleaseId: string;
  version: string;
  transport: string;
  /** `pin`, `hold` or `set`. */
  via: "pin" | "hold" | "set";
  /** The contentApi levels it is required at: its set rows' levels, or every level the app
   *  release is live at for a pin or hold (`apple-ba` needs one asset pack per level). */
  levels: number[];
}

export interface ReadinessOverride {
  by: string;
  at: number;
  reason: string | null;
}

/** Readiness of one app release on one live outlet. */
export interface OutletReadiness {
  appReleaseId: string;
  outletId: string;
  outletKind: string;
  /** The state in force (`overridden` when an operator released it). */
  state: ReadinessState;
  /** The computed state, whatever the override. */
  computed: ComputedReadiness;
  blockingPackReleaseId: string | null;
  blockers: ReadinessBlocker[];
  required: RequiredPack[];
  /** Why the set could not be computed (`pending`), else null. */
  pendingReason: string | null;
  /** Whether Polaris Key can hold a release on this outlet (`HOLDABLE_OUTLET_KINDS`). */
  holdable: boolean;
  /** Whether the release is held on this outlet now: holdable, not ready, not overridden. */
  holds: boolean;
  /** A store outlet Polaris Key cannot hold, not ready: what the operator must not do yet. */
  warning: string | null;
  override: ReadinessOverride | null;
}

export interface DistReadinessRow {
  product: string;
  app_release_id: string;
  outlet_id: string;
  blocking_pack_release_id: string | null;
  state: string;
  detail_json: string | null;
  source: string;
  override_reason: string | null;
  computed_at: number;
  updated_at: number;
  updated_by: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────────────────────

function objectOf(raw: string | null): Record<string, unknown> {
  const v = parseJsonColumn(raw);
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

/** The platforms an outlet serves: its kind's (`OUTLET_PLATFORMS`), narrowed by `platforms`. */
export function outletPlatformsOf(row: DistOutletRow): string[] {
  const table = OUTLET_PLATFORMS as Readonly<Record<string, readonly string[]>>;
  const base = table[row.kind] ?? table.unknown ?? [];
  const identity = objectOf(row.identity_json);
  if (row.kind === "direct" && Array.isArray(identity.platforms))
    return base.filter((p) => (identity.platforms as unknown[]).includes(p));
  return [...base];
}

/**
 * The asset pack an `apple-ba` pack needs at one level: P5-08's convention, `<pack>-c<level>` with
 * every `.` rewritten to `-` (`diceroll.foes` → `diceroll-foes-c3`; `@polaris-key/manifest`'s
 * `assetPackId`, the name `pkey transport apple-ba` uploads under).
 */
export function assetPackName(pack: string, level: number): string {
  return assetPackId(pack, level);
}

function memo<K, V>(fn: (k: K) => Promise<V>): (k: K) => Promise<V> {
  const cache = new Map<K, Promise<V>>();
  return (k) => {
    let hit = cache.get(k);
    if (!hit) {
      hit = fn(k);
      cache.set(k, hit);
    }
    return hit;
  };
}

function once<V>(fn: () => Promise<V>): () => Promise<V> {
  let hit: Promise<V> | undefined;
  return () => (hit ??= fn());
}

// ── The reader ───────────────────────────────────────────────────────────────────────────────

export interface ReadinessContext {
  db: Db;
  product: string;
  hooks: ServiceHooks;
}

/**
 * Readiness, computed on read and memoised for the reader's life (one request, one matrix page,
 * one refresh): the declarations, channels, levels, sets, pack records, transports and outlets are
 * each read once however many releases are asked about.
 */
export interface ReadinessReader {
  /**
   * Readiness of app release `appReleaseId` on every live outlet. `null` when there is nothing to
   * hold: Release is off, the product declares no pack, or the release is not an app release.
   */
  forRelease(appReleaseId: string): Promise<OutletReadiness[] | null>;
  /** Whether `appReleaseId` is held on `outletId` (false whenever `forRelease` is null). */
  holdsOn(appReleaseId: string, outletId: string): Promise<boolean>;
}

export function readinessReader(ctx: ReadinessContext): ReadinessReader {
  const { db, product, hooks } = ctx;
  const catalog = (): ReleaseCatalog | null => hooks.releaseCatalog();

  const declared = once(async (): Promise<CatalogPackDeliverable[]> => {
    const c = catalog();
    return c ? c.packDeliverables() : [];
  });
  const outlets = once(async () =>
    (await listOutlets(db, product)).filter((o) => o.removed_at === null),
  );
  const transports = once(async () => {
    const map = new Map<string, string>();
    for (const t of await listTransports(db, product))
      map.set(`${t.deliverable_id}\u0000${t.outlet_id}`, t.transport);
    return map;
  });
  const channels = once(async () => {
    const c = catalog();
    return c ? [...new Set(await c.knownChannels())].sort() : [];
  });
  const liveLevels = memo(
    async (channel: string): Promise<CatalogLiveLevel[]> => {
      const c = catalog();
      return c ? c.liveLevels(APP_DELIVERABLE_ID, channel) : [];
    },
  );
  const packSets = memo(async (channel: string): Promise<CatalogPackSet[]> => {
    const c = catalog();
    return c
      ? (await c.packSets(channel)).filter(
          (s) => s.appDeliverable === APP_DELIVERABLE_ID,
        )
      : [];
  });
  const packRecord = memo(
    async (key: string): Promise<CatalogPackRelease | null> => {
      const c = catalog();
      if (!c) return null;
      const [pack, releaseId] = key.split("\u0000") as [string, string];
      return c.packRelease(pack, releaseId);
    },
  );
  /** Every object stored with the recorded hash and length and held by this product. */
  const objectsComplete = memo(async (key: string): Promise<boolean> => {
    const rec = await packRecord(key);
    if (!rec) return false;
    const keys = [
      ...new Set(rec.variants.flatMap((v) => v.objects.map((o) => o.key))),
    ];
    if (keys.length === 0) return false;
    const [stored, held] = await Promise.all([
      storedObjects(db, keys),
      referencedKeys(db, product, keys),
    ]);
    return rec.variants.every((v) =>
      v.objects.every((o) => {
        const s = stored.get(o.key);
        return (
          s !== undefined &&
          s.sha256 === o.sha256 &&
          s.size === o.bytes &&
          held.has(o.key)
        );
      }),
    );
  });
  /** Whether a device can fetch the pack at all (P4-05 N4). */
  const fetchable = memo(async (pack: string): Promise<boolean> => {
    const mode = await accessModeOf(db, product, pack);
    if (mode !== "entitled") return true;
    return (await entitlementOf(db, product, pack)) !== null;
  });
  const reports = memo(async (releaseId: string) =>
    db.all<{
      outlet_id: string;
      build_id: string;
      state: string;
      platform_ref_json: string | null;
    }>(
      `SELECT outlet_id, build_id, state, platform_ref_json FROM dist_availability
        WHERE product = ? AND release_id = ?`,
      product,
      releaseId,
    ),
  );
  const overrides = memo(async (appReleaseId: string) =>
    db.all<DistReadinessRow>(
      `SELECT * FROM dist_readiness
        WHERE product = ? AND app_release_id = ? AND source = 'admin'`,
      product,
      appReleaseId,
    ),
  );

  async function transportOf(pack: string, outlet: string): Promise<string> {
    return (
      (await transports()).get(`${pack}\u0000${outlet}`) ?? DEFAULT_TRANSPORT
    );
  }

  async function evaluate(
    req: RequiredPack,
    outlet: DistOutletRow,
    level: number | null,
  ): Promise<ReadinessBlocker | null> {
    const base = {
      pack: req.pack,
      packReleaseId: req.packReleaseId,
      version: req.version,
      transport: req.transport,
    };
    const t = req.transport;
    if (BUILT_IN_TRANSPORTS.includes(t)) return null;
    if (CDN_TRANSPORTS.includes(t)) {
      const key = `${req.pack}\u0000${req.packReleaseId}`;
      if (!(await packRecord(key)))
        return {
          ...base,
          reason: "release-missing",
          detail: `no stored record of ${req.packReleaseId}`,
        };
      if (!(await objectsComplete(key)))
        return {
          ...base,
          reason: "objects-missing",
          detail: `not every object of ${req.packReleaseId} is published to the blob store yet`,
        };
      if (!(await fetchable(req.pack)))
        return {
          ...base,
          reason: "entitlement-missing",
          detail: `${req.pack} is entitled with no delivery gate set, so no device can fetch it; set its entitlement under Distribution → Access`,
        };
      return null;
    }
    if (REPORTED_TRANSPORTS.includes(t)) {
      const wanted =
        t === "apple-ba" && level !== null
          ? assetPackName(req.pack, level)
          : null;
      const ok = (await reports(req.packReleaseId)).some((r) => {
        if (r.outlet_id !== outlet.outlet_id) return false;
        if (!APPROVED_STATES.includes(r.state)) return false;
        if (t !== "apple-ba" || level === null) return true;
        // P5-08: apple-ba rows are keyed by their asset pack (`build_id`), one row per level; a
        // whole-release row (`''`, a hand-made report) counts when it names this asset pack or
        // none.
        if (r.build_id !== "") return r.build_id === wanted;
        const named = objectOf(r.platform_ref_json).assetPackIdentifier;
        return typeof named !== "string" || named === wanted;
      });
      if (ok) return null;
      return {
        ...base,
        reason: "awaiting-approval",
        detail:
          wanted !== null
            ? `asset pack ${wanted} is not approved on ${outlet.outlet_id} yet`
            : `${req.packReleaseId} is not reported approved on ${outlet.outlet_id} yet`,
        ...(wanted !== null ? { assetPack: wanted } : {}),
      };
    }
    return {
      ...base,
      reason: "transport-unsupported",
      detail: `readiness cannot be decided for transport ${t}`,
    };
  }

  async function forRelease(
    appReleaseId: string,
  ): Promise<OutletReadiness[] | null> {
    const c = catalog();
    if (!c) return null;
    const decl = await declared();
    if (decl.length === 0) return null;
    const release = await c.release(appReleaseId);
    if (!release || release.deliverableId !== APP_DELIVERABLE_ID) return null;

    const requiredDecl = new Map(
      decl
        .filter(
          (d) =>
            d.required &&
            (d.binding === "compatible" || d.binding === "standalone"),
        )
        .map((d) => [d.id, d]),
    );
    const isRequired = new Set(decl.filter((d) => d.required).map((d) => d.id));
    const pins = (await c.pins(appReleaseId)).filter((p) => p.required);
    const holds = (await c.holdsFor(appReleaseId)).filter((h) =>
      isRequired.has(h.pack),
    );
    const held = new Set(holds.map((h) => h.pack));
    const pinned = new Set(pins.map((p) => p.pack));
    const holdVersions = new Map<string, string>();
    for (const h of holds) {
      const r = await c.release(h.packReleaseId);
      holdVersions.set(h.packReleaseId, r?.version ?? "");
    }
    const pinVersions = new Map<string, string>();
    for (const p of pins) {
      const r = await c.release(p.packReleaseId);
      pinVersions.set(p.packReleaseId, r?.version ?? "");
    }

    // The levels A is live at, with each channel's sets at that level.
    const live: { channel: string; level: number; sets: CatalogPackSet[] }[] =
      [];
    for (const channel of await channels()) {
      const lv = (await liveLevels(channel)).find((l) =>
        l.appReleases.includes(appReleaseId),
      );
      if (!lv) continue;
      live.push({
        channel,
        level: lv.contentApi,
        sets: (await packSets(channel)).filter(
          (s) => s.contentApi === lv.contentApi,
        ),
      });
    }
    const pendingReason =
      requiredDecl.size > 0
        ? (live
            .filter((l) => l.sets.length === 0)
            .map(
              (l) =>
                `no resolved pack set for contentApi ${l.level} on ${l.channel} yet`,
            )[0] ?? null)
        : null;

    const overrideRows = await overrides(appReleaseId);
    const out: OutletReadiness[] = [];
    for (const outlet of await outlets()) {
      const platforms = new Set(outletPlatformsOf(outlet));
      const required: RequiredPack[] = [];
      const blockers: ReadinessBlocker[] = [];
      const add = async (
        pack: string,
        packReleaseId: string,
        version: string,
        via: RequiredPack["via"],
        levels: readonly number[],
      ) => {
        const existing = required.find(
          (r) => r.pack === pack && r.packReleaseId === packReleaseId,
        );
        if (existing) {
          for (const l of levels)
            if (!existing.levels.includes(l)) existing.levels.push(l);
          existing.levels.sort((a, b) => a - b);
          return;
        }
        required.push({
          pack,
          packReleaseId,
          version,
          transport: await transportOf(pack, outlet.outlet_id),
          via,
          levels: [...new Set(levels)].sort((a, b) => a - b),
        });
      };
      const allLevels = live.map((l) => l.level);
      for (const p of pins)
        await add(
          p.pack,
          p.packReleaseId,
          pinVersions.get(p.packReleaseId) ?? "",
          "pin",
          allLevels,
        );
      for (const h of holds)
        if (!pinned.has(h.pack))
          await add(
            h.pack,
            h.packReleaseId,
            holdVersions.get(h.packReleaseId) ?? "",
            "hold",
            allLevels,
          );
      for (const l of live)
        for (const s of l.sets) {
          if (!platforms.has(s.platform)) continue;
          for (const m of s.packs)
            if (
              requiredDecl.has(m.pack) &&
              !held.has(m.pack) &&
              !pinned.has(m.pack)
            )
              await add(m.pack, m.releaseId, m.version, "set", [l.level]);
          for (const u of s.unsatisfied)
            if (
              requiredDecl.has(u.pack) &&
              !held.has(u.pack) &&
              !pinned.has(u.pack) &&
              !blockers.some(
                (b) => b.reason === "unsatisfied" && b.pack === u.pack,
              )
            )
              blockers.push({
                pack: u.pack,
                packReleaseId: null,
                version: null,
                transport: await transportOf(u.pack, outlet.outlet_id),
                reason: "unsatisfied",
                detail: `no release of ${u.pack} satisfies contentApi ${l.level} on ${l.channel} (${u.reason}${u.detail ? `: ${u.detail}` : ""})`,
              });
        }
      for (const r of required) {
        // Per level: an `apple-ba` pack needs each level's asset pack approved.
        for (const lv of r.transport === "apple-ba" && r.levels.length > 0
          ? r.levels
          : [null]) {
          const b = await evaluate(r, outlet, lv);
          if (b) {
            blockers.push(b);
            break;
          }
        }
      }
      const computed: ComputedReadiness =
        pendingReason !== null
          ? "pending"
          : blockers.length > 0
            ? "blocked"
            : "ready";
      const row = overrideRows.find((o) => o.outlet_id === outlet.outlet_id);
      const override: ReadinessOverride | null = row
        ? {
            by: row.updated_by,
            at: row.updated_at,
            reason: row.override_reason,
          }
        : null;
      const holdable = HOLDABLE_OUTLET_KINDS.includes(outlet.kind);
      const blocking =
        blockers.find((b) => b.packReleaseId !== null)?.packReleaseId ?? null;
      out.push({
        appReleaseId,
        outletId: outlet.outlet_id,
        outletKind: outlet.kind,
        state: override ? "overridden" : computed,
        computed,
        blockingPackReleaseId: blocking,
        blockers,
        required,
        pendingReason,
        holdable,
        holds: holdable && computed !== "ready" && override === null,
        warning:
          !holdable && computed !== "ready"
            ? `Polaris Key cannot hold a release on ${outlet.outlet_id} (${outlet.kind}): do not release ${release.version} there until ${
                pendingReason ??
                blockers[0]?.detail ??
                "its required packs are available"
              }`
            : null,
        override,
      });
    }
    return out;
  }

  const byRelease = memo(forRelease);
  return {
    forRelease: byRelease,
    async holdsOn(appReleaseId, outletId) {
      const r = await byRelease(appReleaseId);
      return r?.find((o) => o.outletId === outletId)?.holds ?? false;
    },
  };
}

/**
 * Apply the hold to one app release's availability records: on every outlet where it is held, a
 * `live` record answers `pending`, with the readiness in its `detail`. Records on other outlets,
 * and every record when nothing is held, are returned as they are.
 */
export function applyReadinessHold(
  records: readonly AvailabilityRecord[],
  readiness: readonly OutletReadiness[] | null,
): AvailabilityRecord[] {
  if (!readiness) return [...records];
  const held = new Map(
    readiness.filter((r) => r.holds).map((r) => [r.outletId, r]),
  );
  if (held.size === 0) return [...records];
  return records.map((rec) => {
    const r = held.get(rec.outletId);
    if (!r || rec.state !== "live") return rec;
    return {
      ...rec,
      state: "pending",
      detail: {
        ...(rec.detail ?? {}),
        readiness: {
          state: r.state,
          blockingPackReleaseId: r.blockingPackReleaseId,
        },
      },
    };
  });
}

// ── The persisted snapshot ───────────────────────────────────────────────────────────────────

export interface RefreshContext extends ReadinessContext {
  now: number;
  /** Who triggered it, for the audit rows of state changes: `system:<trigger>`, `admin:<sub>`. */
  actor: string;
}

/**
 * The app releases a refresh covers when none are named: every app release live on any channel,
 * and every app release with a stored row (so a row that is no longer live is refreshed once more,
 * not left stale).
 */
async function refreshTargets(
  ctx: ReadinessContext,
  catalog: ReleaseCatalog,
): Promise<string[]> {
  const ids = new Set<string>();
  for (const channel of new Set(await catalog.knownChannels()))
    for (const l of await catalog.liveLevels(APP_DELIVERABLE_ID, channel))
      for (const id of l.appReleases) ids.add(id);
  for (const r of await ctx.db.all<{ app_release_id: string }>(
    "SELECT DISTINCT app_release_id FROM dist_readiness WHERE product = ?",
    ctx.product,
  ))
    ids.add(r.app_release_id);
  return [...ids].sort();
}

/**
 * Recompute `dist_readiness` for `appReleaseIds` (default: `refreshTargets`): upsert one row per
 * (app release, live outlet), keeping an operator's override (`source = 'admin'`) — its computed
 * blockers are refreshed, its state stays `overridden`. A state change is audited
 * (`distribution.readiness.<state>`). Returns the rows written or changed.
 */
export async function refreshReadiness(
  ctx: RefreshContext,
  appReleaseIds?: readonly string[],
): Promise<number> {
  const catalog = ctx.hooks.releaseCatalog();
  if (!catalog) return 0;
  if ((await catalog.packDeliverables()).length === 0) return 0;
  const reader = readinessReader(ctx);
  const ids = appReleaseIds
    ? [...new Set(appReleaseIds)]
    : await refreshTargets(ctx, catalog);
  let changed = 0;
  for (const id of ids) {
    const list = await reader.forRelease(id);
    if (!list) continue;
    const existing = await ctx.db.all<DistReadinessRow>(
      "SELECT * FROM dist_readiness WHERE product = ? AND app_release_id = ?",
      ctx.product,
      id,
    );
    for (const r of list) {
      const prev = existing.find((e) => e.outlet_id === r.outletId);
      const detail = JSON.stringify({
        blockers: r.blockers,
        required: r.required,
        pendingReason: r.pendingReason,
        warning: r.warning,
        computed: r.computed,
      });
      const state: ReadinessState =
        prev?.source === "admin" ? "overridden" : r.computed;
      if (
        prev &&
        prev.state === state &&
        prev.detail_json === detail &&
        prev.blocking_pack_release_id === r.blockingPackReleaseId
      )
        continue;
      await ctx.db.run(
        `INSERT INTO dist_readiness
           (product, app_release_id, outlet_id, blocking_pack_release_id, state, detail_json,
            source, override_reason, computed_at, updated_at, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, 'computed', NULL, ?, ?, ?)
         ON CONFLICT (product, app_release_id, outlet_id) DO UPDATE SET
           blocking_pack_release_id = excluded.blocking_pack_release_id,
           detail_json = excluded.detail_json,
           computed_at = excluded.computed_at,
           state = CASE WHEN dist_readiness.source = 'admin' THEN 'overridden' ELSE excluded.state END,
           updated_at = CASE WHEN dist_readiness.source = 'admin' THEN dist_readiness.updated_at ELSE excluded.updated_at END,
           updated_by = CASE WHEN dist_readiness.source = 'admin' THEN dist_readiness.updated_by ELSE excluded.updated_by END`,
        ctx.product,
        id,
        r.outletId,
        r.blockingPackReleaseId,
        r.computed,
        detail,
        ctx.now,
        ctx.now,
        ctx.actor,
      );
      changed++;
      if (!prev || prev.state !== state)
        await appendAudit(ctx.db, {
          product: ctx.product,
          id: randomId("aud"),
          at: ctx.now,
          actor_sub: ctx.actor,
          actor_name: "Distribution readiness",
          actor_email: null,
          action: `distribution.readiness.${state}`,
          target_kind: "readiness",
          target_id: `${id}:${r.outletId}`,
          parent_id: null,
          summary: (
            `${id} on ${r.outletId} is ${state}` +
            (r.computed !== "ready"
              ? `: ${r.pendingReason ?? r.blockers.map((b) => b.detail).join("; ")}`
              : "") +
            (r.warning ? ` — ${r.warning}` : "")
          ).slice(0, 1000),
        });
    }
  }
  return changed;
}

/**
 * The app releases whose readiness a pack release can change: those that pin or hold it, and every
 * app release live on any channel (whose sets may name it). What a pack availability report
 * refreshes.
 */
export async function appReleasesAffectedBy(
  catalog: ReleaseCatalog,
  packReleaseId: string,
): Promise<string[]> {
  const ids = new Set<string>();
  for (const p of await catalog.pinnedBy(packReleaseId))
    ids.add(p.appReleaseId);
  for (const h of await catalog.heldBy(packReleaseId)) ids.add(h.appReleaseId);
  for (const channel of new Set(await catalog.knownChannels()))
    for (const l of await catalog.liveLevels(APP_DELIVERABLE_ID, channel))
      for (const id of l.appReleases) ids.add(id);
  return [...ids].sort();
}

// ── Operator overrides ───────────────────────────────────────────────────────────────────────

export type OverrideResult =
  | { ok: true }
  | { ok: false; status: 404 | 409 | 422; reason: string; message: string };

/**
 * Set (`reason` given) or clear (`null`) an operator's override of one (app release, outlet).
 * The caller audits. The override is a row with `source = 'admin'`, `state = 'overridden'`; a
 * clear hands the row back to the computation (`source = 'computed'`, recomputed at once).
 */
export async function setReadinessOverride(
  ctx: RefreshContext,
  appReleaseId: string,
  outletId: string,
  reason: string | null,
): Promise<OverrideResult> {
  const catalog = ctx.hooks.releaseCatalog();
  if (!catalog)
    return {
      ok: false,
      status: 404,
      reason: "not_found",
      message: "no such release",
    };
  const release = await catalog.release(appReleaseId);
  if (!release || release.deliverableId !== APP_DELIVERABLE_ID)
    return {
      ok: false,
      status: 404,
      reason: "unknown_release",
      message: `no app release ${appReleaseId}`,
    };
  const outlet = (await listOutlets(ctx.db, ctx.product)).find(
    (o) => o.outlet_id === outletId && o.removed_at === null,
  );
  if (!outlet)
    return {
      ok: false,
      status: 404,
      reason: "unknown_outlet",
      message: `no outlet ${outletId}`,
    };
  if (reason === null) {
    const changed = await ctx.db.runChanges(
      `UPDATE dist_readiness SET source = 'computed', override_reason = NULL, updated_at = ?, updated_by = ?
        WHERE product = ? AND app_release_id = ? AND outlet_id = ? AND source = 'admin'`,
      ctx.now,
      ctx.actor,
      ctx.product,
      appReleaseId,
      outletId,
    );
    if (changed === 0)
      return {
        ok: false,
        status: 409,
        reason: "no_override",
        message: "there is no override to clear",
      };
    // The row's state is the override's until recomputed: recompute it now.
    await ctx.db.run(
      `UPDATE dist_readiness SET state = 'pending'
        WHERE product = ? AND app_release_id = ? AND outlet_id = ?`,
      ctx.product,
      appReleaseId,
      outletId,
    );
    await refreshReadiness(ctx, [appReleaseId]);
    return { ok: true };
  }
  await ctx.db.run(
    `INSERT INTO dist_readiness
       (product, app_release_id, outlet_id, blocking_pack_release_id, state, detail_json,
        source, override_reason, computed_at, updated_at, updated_by)
     VALUES (?, ?, ?, NULL, 'overridden', NULL, 'admin', ?, ?, ?, ?)
     ON CONFLICT (product, app_release_id, outlet_id) DO UPDATE SET
       state = 'overridden', source = 'admin', override_reason = excluded.override_reason,
       updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    ctx.product,
    appReleaseId,
    outletId,
    reason,
    ctx.now,
    ctx.now,
    ctx.actor,
  );
  return { ok: true };
}

/** Every stored row, by app release then outlet (the console's list). */
export function listReadiness(
  db: Db,
  product: string,
): Promise<DistReadinessRow[]> {
  return db.all<DistReadinessRow>(
    `SELECT * FROM dist_readiness WHERE product = ? ORDER BY app_release_id, outlet_id`,
    product,
  );
}

/** One stored row as the console shows it. */
export function readinessRowView(row: DistReadinessRow) {
  const detail = objectOf(row.detail_json);
  return {
    appReleaseId: row.app_release_id,
    outletId: row.outlet_id,
    state: (READINESS_STATES as readonly string[]).includes(row.state)
      ? (row.state as ReadinessState)
      : ("pending" as ReadinessState),
    blockingPackReleaseId: row.blocking_pack_release_id,
    blockers: Array.isArray(detail.blockers) ? detail.blockers : [],
    warning: typeof detail.warning === "string" ? detail.warning : null,
    source: row.source,
    overrideReason: row.override_reason,
    computedAt: row.computed_at,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  };
}
