/**
 * Pack-set resolution, the D1 shell (P4-12): read everything resolution needs in a handful of
 * queries, resolve it (`resolve.ts`, pure), and replace the product's `release_sets` rows in ONE
 * batch so a reader never sees half a resolution. `resolveAndStore` is what every trigger calls
 * (a publish, a pointer move, a floor change, a yank, a resync); the publish checks overlay a
 * release that is not stored yet on the same input (`withPackRelease`, `withAppRelease`) and
 * compare the sets before and after (`setReport`).
 *
 * Release never reads distribution here: which app releases are live is the channel floor's
 * answer, never store availability (CONTENT §6.3 step 1).
 */

import {
  APP_DELIVERABLE_ID,
  type ManifestPackDeliverable,
} from "@polaris-key/manifest";
import { packSetId, variantKey } from "@polaris-key/client-core/packs";
import type { Db, DbStatement } from "../../../core/platform.js";
import { parseIgnoreTags } from "../channels.js";
import { getReleaseConfig, type ReleaseConfigRow } from "../config.js";
import type { ReleaseChannelPolicyRow } from "../model.js";
import {
  canonicalChannel,
  knownChannels,
  loadDeliverableState,
  policyView,
  prereleaseOf,
  tagOf,
  versionSchemeOf,
  type Candidate,
  type PolicyView,
} from "../resolve.js";
import type { ReleaseMetadataRow } from "../store.js";
import { readPackDeliverables } from "./deliverables.js";
import {
  PackResolutionError,
  PackResolver,
  type AppReleaseFacts,
  type PackInput,
  type PackReleaseFacts,
  type PackVariantFacts,
  type Resolution,
  type ResolutionInput,
  type ResolvedSet,
  type Unsatisfied,
} from "./resolve.js";

/** A pack-set row as `release_sets` holds it and the hook answers it. */
export interface StoredSet {
  channel: string;
  appDeliverable: string;
  contentApi: number;
  platform: string;
  variant: string;
  packSetId: string;
  packs: {
    pack: string;
    releaseId: string;
    version: string;
    seq: number;
    sha256: string;
  }[];
  unsatisfied: Unsatisfied[];
  resolvedAt: number;
}

/** What resolution read, and the declared packs it read them for. */
export interface ResolutionState {
  input: ResolutionInput;
  /** Declared packs whose stored declaration does not read back (resolution skips them). */
  unreadable: string[];
  /** Every declared pack, by id. */
  declared: Map<string, ManifestPackDeliverable>;
}

function jsonOr<T>(text: string | null | undefined, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

function asStringRecord(v: unknown): Record<string, string> | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const out: Record<string, string> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>))
    if (typeof x === "string") out[k] = x;
  return Object.keys(out).length > 0 ? out : null;
}

/** The facts of one pack variant from its `release_builds` row. */
export function packVariantFacts(row: {
  variant_json: string | null;
  requires_json: string | null;
  conflicts_json: string | null;
}): PackVariantFacts {
  const variant = jsonOr<Record<string, string>>(row.variant_json, {});
  const requires = jsonOr<Record<string, unknown>>(row.requires_json, {});
  const conflicts = jsonOr<unknown>(row.conflicts_json, []);
  return {
    variantKey: variantKey(
      variant && typeof variant === "object" ? variant : {},
    ),
    engine: typeof requires?.engine === "string" ? requires.engine : null,
    contentApi: asStringRecord(requires?.contentApi),
    packs: asStringRecord(requires?.packs),
    conflicts: Array.isArray(conflicts)
      ? conflicts.filter((c): c is string => typeof c === "string")
      : [],
  };
}

type PackRow = ReleaseMetadataRow & { record_sha256: string | null };
type AppRow = ReleaseMetadataRow & {
  content_api: number | null;
  pack_channels_json: string | null;
};

/**
 * Everything resolution reads for one product: the app's releases, builds, policies and yanks
 * (`loadDeliverableState`), then the resolvable packs' releases, variants, records, policies and
 * floors, and the mirrored holds, in bulk queries.
 */
export async function loadResolutionState(
  db: Db,
  product: string,
  cfg?: ReleaseConfigRow | null,
): Promise<ResolutionState | null> {
  const config = cfg === undefined ? await getReleaseConfig(db, product) : cfg;
  const declared = await readPackDeliverables(db, product);
  const app = await loadDeliverableState(
    db,
    product,
    APP_DELIVERABLE_ID,
    config,
  );
  if (!app) return null;
  const resolvable = declared.packs.filter(
    (p) => p.binding === "compatible" || p.binding === "standalone",
  );
  const ids = JSON.stringify(resolvable.map((p) => p.id));

  const holds = await db.all<{
    app_release_id: string;
    pack_deliverable: string;
    pack_release_id: string;
  }>(
    `SELECT app_release_id, pack_deliverable, pack_release_id FROM release_holds
      WHERE product = ? ORDER BY app_release_id, pack_deliverable`,
    product,
  );
  const holdsBy = new Map<string, { pack: string; releaseId: string }[]>();
  for (const h of holds) {
    const list = holdsBy.get(h.app_release_id) ?? [];
    list.push({ pack: h.pack_deliverable, releaseId: h.pack_release_id });
    holdsBy.set(h.app_release_id, list);
  }
  const appReleases = new Map<string, AppReleaseFacts>();
  for (const r of app.rows as AppRow[])
    appReleases.set(r.release_id, {
      contentApi: r.content_api ?? null,
      builds: (app.buildsByRelease.get(r.release_id) ?? []).map((b) => {
        const req = jsonOr<Record<string, unknown>>(b.requires_json, {});
        return {
          platform: b.platform,
          engine: typeof req?.engine === "string" ? req.engine : null,
        };
      }),
      packChannels: asStringRecord(jsonOr(r.pack_channels_json, null)),
      holds: holdsBy.get(r.release_id) ?? [],
    });
  const minSupported = (
    rows: Iterable<ReleaseChannelPolicyRow>,
  ): Map<string, string | null> =>
    new Map([...rows].map((p) => [p.channel, p.min_supported]));

  const packs: PackInput[] = [];
  if (resolvable.length > 0) {
    const rows = await db.all<PackRow>(
      `SELECT m.*, r.record_sha256 FROM release_metadata m
         LEFT JOIN release_records r
           ON r.product = m.product AND r.release_id = m.release_id AND r.kind = 'pack'
        WHERE m.product = ? AND m.deliverable_id IN (SELECT value FROM json_each(?))`,
      product,
      ids,
    );
    const builds = await db.all<{
      release_id: string;
      variant_json: string | null;
      requires_json: string | null;
      conflicts_json: string | null;
    }>(
      `SELECT b.release_id, b.variant_json, b.requires_json, b.conflicts_json
         FROM release_builds b
         JOIN release_metadata m ON m.product = b.product AND m.release_id = b.release_id
        WHERE b.product = ? AND m.deliverable_id IN (SELECT value FROM json_each(?))
        ORDER BY b.release_id, b.build_id`,
      product,
      ids,
    );
    const policies = await db.all<ReleaseChannelPolicyRow>(
      `SELECT * FROM release_channel_policy
        WHERE product = ? AND deliverable_id IN (SELECT value FROM json_each(?))`,
      product,
      ids,
    );
    const floors = await db.all<{
      deliverable_id: string;
      channel: string;
      content_api: number;
      min_version: string;
    }>(
      `SELECT deliverable_id, channel, content_api, min_version FROM release_pack_floors
        WHERE product = ?`,
      product,
    );
    const variantsBy = new Map<string, PackVariantFacts[]>();
    for (const b of builds) {
      const list = variantsBy.get(b.release_id) ?? [];
      list.push(packVariantFacts(b));
      variantsBy.set(b.release_id, list);
    }
    for (const decl of resolvable) {
      const mine = rows.filter((r) => r.deliverable_id === decl.id);
      const candidates: Candidate[] = mine.map((r) => ({
        releaseId: r.release_id,
        version: r.version,
        seq: r.seq,
        channel: r.channel ? canonicalChannel(r.channel, app.manual) : null,
        prerelease: prereleaseOf(r),
        tag: tagOf(r),
        builds: [],
      }));
      const releases = new Map<string, PackReleaseFacts>();
      for (const r of mine)
        if (r.record_sha256 && r.seq !== null)
          releases.set(r.release_id, {
            releaseId: r.release_id,
            version: r.version,
            seq: r.seq,
            recordSha256: r.record_sha256,
            variants: variantsBy.get(r.release_id) ?? [],
          });
      const myPolicies = policies.filter((p) => p.deliverable_id === decl.id);
      const myFloors = new Map<string, Map<number, string>>();
      for (const f of floors) {
        if (f.deliverable_id !== decl.id) continue;
        const byLevel = myFloors.get(f.channel) ?? new Map<number, string>();
        byLevel.set(f.content_api, f.min_version);
        myFloors.set(f.channel, byLevel);
      }
      packs.push({
        id: decl.id,
        binding: decl.binding,
        required: decl.required,
        scheme: decl.versioning.scheme,
        axes: decl.variants as Record<string, string[]>,
        candidates,
        policies: new Map<string, PolicyView>(
          myPolicies.map((p) => [p.channel, policyView(p)]),
        ),
        minSupported: minSupported(myPolicies),
        floors: myFloors,
        releases,
      });
    }
  }

  return {
    input: {
      app: {
        scheme: versionSchemeOf(app.deliverable),
        candidates: app.candidates,
        policies: new Map(
          [...app.policyRows].map(([c, p]) => [c, policyView(p)]),
        ),
        minSupported: minSupported(app.policyRows.values()),
        manual: app.manual,
        stableTagPattern: config?.stable_tag_pattern ?? null,
        ignoreTags: parseIgnoreTags(config?.ignore_tags_json),
        releases: appReleases,
      },
      packs,
      channels: await knownChannels(db, product, config),
      yanked: app.yanked,
    },
    unreadable: declared.unreadable,
    declared: new Map(declared.packs.map((p) => [p.id, p])),
  };
}

// ── Overlays: a release the publish has not stored yet ──────────────────────

/** `state` with one more pack release (or a replaced one), as the publish would store it. */
export function withPackRelease(
  state: ResolutionState,
  packId: string,
  candidate: Candidate,
  facts: PackReleaseFacts,
): ResolutionState {
  return {
    ...state,
    input: {
      ...state.input,
      packs: state.input.packs.map((p) =>
        p.id !== packId
          ? p
          : {
              ...p,
              candidates: [
                ...p.candidates.filter(
                  (c) => c.releaseId !== candidate.releaseId,
                ),
                candidate,
              ],
              releases: new Map([...p.releases, [facts.releaseId, facts]]),
            },
      ),
    },
  };
}

/** `state` with one more app release (or a replaced one), as the publish would store it. */
export function withAppRelease(
  state: ResolutionState,
  candidate: Candidate,
  facts: AppReleaseFacts,
  channel: string | null,
): ResolutionState {
  const channels = new Set(state.input.channels);
  if (channel) channels.add(channel);
  return {
    ...state,
    input: {
      ...state.input,
      channels: [...channels],
      app: {
        ...state.input.app,
        candidates: [
          ...state.input.app.candidates.filter(
            (c) => c.releaseId !== candidate.releaseId,
          ),
          candidate,
        ],
        releases: new Map([
          ...state.input.app.releases,
          [candidate.releaseId, facts],
        ]),
      },
    },
  };
}

// ── packSetId, rows and reports ──────────────────────────────────────────────

/** Every resolved set with its `packSetId` (client-core's, decision 11; memoised per member list). */
export async function withSetIds(
  sets: readonly ResolvedSet[],
): Promise<(ResolvedSet & { packSetId: string })[]> {
  const memo = new Map<string, string>();
  const out: (ResolvedSet & { packSetId: string })[] = [];
  for (const s of sets) {
    const key = s.entries.map((e) => `${e.pack} ${e.recordSha256}`).join("\n");
    let id = memo.get(key);
    if (id === undefined) {
      id =
        (await packSetId(
          s.entries.map((e) => ({
            packId: e.pack,
            releaseSha256: e.recordSha256,
          })),
        )) ?? "";
      memo.set(key, id);
    }
    out.push({ ...s, packSetId: id });
  }
  return out;
}

/** The statements that replace the product's `release_sets` with `sets`, for one batch. */
export function setStatements(
  product: string,
  sets: readonly (ResolvedSet & { packSetId: string })[],
  now: number,
): DbStatement[] {
  const out: DbStatement[] = [
    { sql: "DELETE FROM release_sets WHERE product = ?", params: [product] },
  ];
  const PER = 10; // 10 columns × 10 rows = 100 parameters, D1's limit
  for (let i = 0; i < sets.length; i += PER) {
    const chunk = sets.slice(i, i + PER);
    out.push({
      sql: `INSERT INTO release_sets
              (product, channel, app_deliverable, content_api, platform, variant, pack_set_id,
               set_json, unsatisfied_json, resolved_at)
            VALUES ${chunk.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").join(", ")}`,
      params: chunk.flatMap((s) => [
        product,
        s.channel,
        s.appDeliverable,
        s.contentApi,
        s.platform,
        s.variant,
        s.packSetId,
        JSON.stringify({
          packs: s.entries.map((e) => ({
            pack: e.pack,
            releaseId: e.releaseId,
            version: e.version,
            seq: e.seq,
            sha256: e.recordSha256,
          })),
        }),
        s.unsatisfied.length > 0 ? JSON.stringify(s.unsatisfied) : null,
        now,
      ]),
    });
  }
  return out;
}

/** One distinct set of a report, with the selectors that resolve to it. */
export interface ReportSet {
  packSetId: string;
  packs: { pack: string; version: string; sha256: string }[];
  unsatisfied: Unsatisfied[];
  selectors: {
    channel: string;
    contentApi: number;
    platform: string;
    variant: string;
  }[];
  /** The app releases that receive it, newest publication first within each selector. */
  appReleases: string[];
}

/** What a publish (or its dry run) changes: the resulting sets, and the selectors that moved. */
export interface PackSetReport {
  sets: ReportSet[];
  changed: {
    channel: string;
    contentApi: number;
    platform: string;
    variant: string;
    before: string | null;
    after: string | null;
  }[];
}

const selectorKey = (s: {
  channel: string;
  contentApi: number;
  platform: string;
  variant: string;
}) => `${s.channel}\u0000${s.contentApi}\u0000${s.platform}\u0000${s.variant}`;

/** The report of a publish: `after`'s distinct sets, and every selector whose set changed. */
export function setReport(
  before: readonly (ResolvedSet & { packSetId: string })[],
  after: readonly (ResolvedSet & { packSetId: string })[],
): PackSetReport {
  const groups = new Map<string, ReportSet>();
  for (const s of after) {
    const key = `${s.packSetId}\u0000${JSON.stringify(s.unsatisfied)}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        packSetId: s.packSetId,
        packs: s.entries.map((e) => ({
          pack: e.pack,
          version: e.version,
          sha256: e.recordSha256,
        })),
        unsatisfied: s.unsatisfied,
        selectors: [],
        appReleases: [],
      };
      groups.set(key, g);
    }
    g.selectors.push({
      channel: s.channel,
      contentApi: s.contentApi,
      platform: s.platform,
      variant: s.variant,
    });
    for (const r of s.appReleases)
      if (!g.appReleases.includes(r)) g.appReleases.push(r);
  }
  const was = new Map(before.map((s) => [selectorKey(s), s.packSetId]));
  const now = new Map(after.map((s) => [selectorKey(s), s.packSetId]));
  const changed: PackSetReport["changed"] = [];
  for (const s of after)
    if (was.get(selectorKey(s)) !== s.packSetId)
      changed.push({
        channel: s.channel,
        contentApi: s.contentApi,
        platform: s.platform,
        variant: s.variant,
        before: was.get(selectorKey(s)) ?? null,
        after: s.packSetId,
      });
  for (const s of before)
    if (!now.has(selectorKey(s)))
      changed.push({
        channel: s.channel,
        contentApi: s.contentApi,
        platform: s.platform,
        variant: s.variant,
        before: s.packSetId,
        after: null,
      });
  return { sets: [...groups.values()], changed };
}

/** Resolve `state`; null (with the message) when resolution cannot finish inside its bounds. */
export function tryResolve(state: ResolutionState):
  | { ok: true; resolver: PackResolver; resolution: Resolution }
  | {
      ok: false;
      message: string;
    } {
  const resolver = new PackResolver(state.input);
  try {
    return { ok: true, resolver, resolution: resolver.resolve() };
  } catch (e) {
    if (e instanceof PackResolutionError)
      return { ok: false, message: e.message };
    throw e;
  }
}

/** The outcome of a trigger's re-resolution. */
export type StoreOutcome =
  | { ok: true; sets: number }
  | { ok: false; message: string };

/**
 * Re-resolve every channel of `product` and replace its `release_sets` in one batch: the trigger
 * after a publish, a pointer move, a floor change, a yank or a resync. Never refuses for an
 * unsatisfiable set (that is stored with its `unsatisfied` marker); a bound that resolution cannot
 * finish inside leaves the stored sets as they were and is answered to the caller.
 */
export async function resolveAndStore(
  db: Db,
  product: string,
  now: number,
): Promise<StoreOutcome> {
  // One query decides whether there is anything to do: a product with no compatible or standalone
  // pack and no stored set (every product before it declares one) pays nothing more.
  const any = await db.first<{ packs: number; sets: number }>(
    `SELECT EXISTS (SELECT 1 FROM release_deliverables
                     WHERE product = ? AND kind = 'pack'
                       AND (CASE WHEN json_valid(def_json)
                                 THEN json_extract(def_json, '$.binding') END)
                           IN ('compatible', 'standalone')) AS packs,
            EXISTS (SELECT 1 FROM release_sets WHERE product = ?) AS sets`,
    product,
    product,
  );
  if (!any?.packs && !any?.sets) return { ok: true, sets: 0 };
  const state = await loadResolutionState(db, product);
  if (!state) {
    await db.run("DELETE FROM release_sets WHERE product = ?", product);
    return { ok: true, sets: 0 };
  }
  const r = tryResolve(state);
  if (!r.ok) return r;
  const sets = await withSetIds(r.resolution.sets);
  await db.batch(setStatements(product, sets, now));
  return { ok: true, sets: sets.length };
}

/** The stored sets of one channel (the hook's `packSets`), by selector. */
export async function readStoredSets(
  db: Db,
  product: string,
  channel: string,
): Promise<StoredSet[]> {
  const rows = await db.all<{
    channel: string;
    app_deliverable: string;
    content_api: number;
    platform: string;
    variant: string;
    pack_set_id: string;
    set_json: string;
    unsatisfied_json: string | null;
    resolved_at: number;
  }>(
    `SELECT channel, app_deliverable, content_api, platform, variant, pack_set_id, set_json,
            unsatisfied_json, resolved_at
       FROM release_sets WHERE product = ? AND channel = ?
      ORDER BY app_deliverable, content_api, platform, variant`,
    product,
    channel,
  );
  return rows.map((r) => ({
    channel: r.channel,
    appDeliverable: r.app_deliverable,
    contentApi: r.content_api,
    platform: r.platform,
    variant: r.variant,
    packSetId: r.pack_set_id,
    packs: jsonOr<{ packs?: StoredSet["packs"] }>(r.set_json, {}).packs ?? [],
    unsatisfied: jsonOr<Unsatisfied[]>(r.unsatisfied_json, []),
    resolvedAt: r.resolved_at,
  }));
}
