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
import { parseJsonOr } from "../../../platform/json.js";
import { randomHex } from "../../../platform/random.js";
import { randomId } from "../../../crypto.js";
import type { Db, DbStatement } from "../../../db/types.js";
import { parseIgnoreTags, parseManualChannels } from "../channels.js";
import { appendAudit } from "../../../repo.js";
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
  /** The engine of the builds it serves; `""` for builds that declare none. */
  engine: string;
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
  /** The product's `release_set_state.generation` when this state was read (0 for none). */
  generation: number;
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
  const variant = parseJsonOr<Record<string, string>>(row.variant_json, {});
  const requires = parseJsonOr<Record<string, unknown>>(row.requires_json, {});
  const conflicts = parseJsonOr<unknown>(row.conflicts_json, []);
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
  // The generation first: a write that finds it moved re-resolves (`storeResolution`).
  const generation =
    (
      await db.first<{ generation: number }>(
        "SELECT generation FROM release_set_state WHERE product = ?",
        product,
      )
    )?.generation ?? 0;
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
        const req = parseJsonOr<Record<string, unknown>>(b.requires_json, {});
        return {
          platform: b.platform,
          engine: typeof req?.engine === "string" ? req.engine : null,
        };
      }),
      packChannels: asStringRecord(parseJsonOr(r.pack_channels_json, null)),
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
    // P4-13: a revoked release leaves every candidate list, a pinned pointer included (a yank
    // alone would still resolve as a pinned pointer). P4-19: so does one signed under a revoked
    // delegation.
    const revoked = new Set(
      (
        await db.all<{ target_release_id: string }>(
          `SELECT target_release_id FROM release_revocations WHERE product = ?
           UNION
           SELECT r.release_id FROM release_records r
             JOIN release_delegated_records d
               ON d.product = r.product AND d.record_sha256 = r.record_sha256
             JOIN release_delegations g
               ON g.product = d.product AND g.record_sha256 = d.delegation_sha256
            WHERE r.product = ? AND g.revocation_sha256 IS NOT NULL`,
          product,
          product,
        )
      ).map((r) => r.target_release_id),
    );
    for (const decl of resolvable) {
      const mine = rows.filter(
        (r) => r.deliverable_id === decl.id && !revoked.has(r.release_id),
      );
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
    generation,
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

/** A resolved row with its `packSetId`. */
export type IdentifiedSet = ResolvedSet & { packSetId: string };

/** Every resolved row with its `packSetId` (client-core's, decision 11; memoised per member list). */
export async function withSetIds(
  sets: readonly ResolvedSet[],
): Promise<IdentifiedSet[]> {
  const memo = new Map<string, string>();
  const out: IdentifiedSet[] = [];
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

/** The SQL that holds while `release_set_state` carries this writer's token. Params: product, token. */
const OWN_TOKEN_SQL =
  "EXISTS (SELECT 1 FROM release_set_state WHERE product = ? AND token = ?)";

/**
 * The statements that replace the product's `release_sets` with `sets`, for one batch, written
 * only by the writer that moves the generation from `generation` (read before resolving) to the
 * next: the first statement claims it with `token`, and every other statement is guarded on the
 * claim. A writer that resolved from an older generation writes nothing.
 */
export function setStatements(
  product: string,
  sets: readonly IdentifiedSet[],
  now: number,
  claim: { generation: number; token: string },
): DbStatement[] {
  const guard = [product, claim.token];
  const out: DbStatement[] = [
    {
      sql: `INSERT INTO release_set_state (product, generation, token, modified_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(product) DO UPDATE SET
              generation = excluded.generation, token = excluded.token,
              modified_at = excluded.modified_at
            WHERE release_set_state.generation = ?`,
      params: [
        product,
        claim.generation + 1,
        claim.token,
        now,
        claim.generation,
      ],
    },
    {
      sql: `DELETE FROM release_sets WHERE product = ? AND ${OWN_TOKEN_SQL}`,
      params: [product, ...guard],
    },
  ];
  const COLUMNS = 11;
  const PER = Math.floor((100 - guard.length) / COLUMNS); // D1's 100-parameter limit
  for (let i = 0; i < sets.length; i += PER) {
    const chunk = sets.slice(i, i + PER);
    out.push({
      sql: `INSERT INTO release_sets
              (product, channel, app_deliverable, content_api, platform, engine, variant,
               pack_set_id, set_json, unsatisfied_json, resolved_at)
            SELECT column1, column2, column3, column4, column5, column6, column7, column8,
                   column9, column10, column11
              FROM (VALUES ${chunk.map(() => `(${Array(COLUMNS).fill("?").join(", ")})`).join(", ")})
             WHERE ${OWN_TOKEN_SQL}`,
      params: [
        ...chunk.flatMap((s) => [
          product,
          s.channel,
          s.appDeliverable,
          s.contentApi,
          s.platform,
          s.engine,
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
        ...guard,
      ],
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
    engine: string;
    variant: string;
  }[];
  /** The app releases that receive it. */
  appReleases: string[];
}

/** What a publish (or its dry run) changes: the resulting sets, and the rows that moved. */
export interface PackSetReport {
  sets: ReportSet[];
  changed: {
    channel: string;
    contentApi: number;
    platform: string;
    engine: string;
    variant: string;
    before: string | null;
    after: string | null;
  }[];
}

/** A row's key: (channel, contentApi, platform, engine, variant). */
export const rowKey = (s: {
  channel: string;
  contentApi: number;
  platform: string;
  engine: string;
  variant: string;
}) =>
  `${s.channel}\u0000${s.contentApi}\u0000${s.platform}\u0000${s.engine}\u0000${s.variant}`;

const selectorOf = (s: {
  channel: string;
  contentApi: number;
  platform: string;
  engine: string;
  variant: string;
}) => ({
  channel: s.channel,
  contentApi: s.contentApi,
  platform: s.platform,
  engine: s.engine,
  variant: s.variant,
});

/** The report of a publish: `after`'s distinct sets, and every row whose set changed from the
 *  stored `before`. */
export function setReport(
  before: readonly {
    channel: string;
    contentApi: number;
    platform: string;
    engine: string;
    variant: string;
    packSetId: string;
  }[],
  after: readonly IdentifiedSet[],
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
    g.selectors.push(selectorOf(s));
    for (const r of s.appReleases)
      if (!g.appReleases.includes(r)) g.appReleases.push(r);
  }
  const was = new Map(before.map((s) => [rowKey(s), s.packSetId]));
  const now = new Map(after.map((s) => [rowKey(s), s.packSetId]));
  const changed: PackSetReport["changed"] = [];
  for (const s of after)
    if (was.get(rowKey(s)) !== s.packSetId)
      changed.push({
        ...selectorOf(s),
        before: was.get(rowKey(s)) ?? null,
        after: s.packSetId,
      });
  for (const s of before)
    if (!now.has(rowKey(s)))
      changed.push({ ...selectorOf(s), before: s.packSetId, after: null });
  return { sets: [...groups.values()], changed };
}

/** Resolve `state`, or the bound's message when resolution cannot finish inside it. */
export function tryResolve(
  state: ResolutionState,
):
  | { ok: true; resolver: PackResolver; resolution: Resolution }
  | { ok: false; message: string } {
  try {
    const resolver = new PackResolver(state.input);
    return { ok: true, resolver, resolution: resolver.resolve() };
  } catch (e) {
    if (e instanceof PackResolutionError)
      return { ok: false, message: e.message };
    throw e;
  }
}

/** A resolution ready to store: its rows and the generation it was resolved from. */
export interface ResolvedForStore {
  sets: IdentifiedSet[];
  generation: number;
}

/**
 * The outcome of a trigger's re-resolution, which the policy, resync and sync routes answer as
 * `packSets`. `ok: false` means resolution failed and the product's sets were CLEARED (fail
 * closed: no stale set, which may still hold a yanked release, survives).
 */
export type StoreOutcome =
  | { ok: true; sets: number }
  | {
      ok: false;
      reason: "pack-sets-bound" | "pack-sets-error";
      message: string;
    };

/**
 * Write `resolved` if the generation it was resolved from is still current; true when written.
 * A concurrent trigger that moved the generation first wins, and this write is a no-op.
 */
export async function storeResolution(
  db: Db,
  product: string,
  resolved: ResolvedForStore,
  now: number,
): Promise<boolean> {
  const token = randomHex(12);
  const statements = setStatements(product, resolved.sets, now, {
    generation: resolved.generation,
    token,
  });
  // The claim (statement 1) changed a row exactly when this write won; every other statement is
  // guarded on it, so the batch applied whole or not at all.
  if (db.batchChanges) return (await db.batchChanges(statements))[0] === 1;
  await db.batch(statements);
  const row = await db.first<{ token: string | null }>(
    "SELECT token FROM release_set_state WHERE product = ?",
    product,
  );
  return row?.token === token;
}

/**
 * The statements that make the stored sets unusable until the next resolution: move the
 * generation (so no writer resolved from before can store) and delete every row. A policy change
 * that can make a stored set wrong (a yank, an unyank, a floor, a pointer) rides these in its own
 * batch, so a crash between its write and `resolveAndStore` leaves no stale set: fail closed.
 */
export function invalidateSetsStatements(
  product: string,
  now: number,
  opts: { onlyAfterAChange?: boolean } = {},
): DbStatement[] {
  // `onlyAfterAChange`: the batch's previous statement (a policy write) must have changed a row.
  // `changes()` is the connection's count for the most recent completed INSERT, UPDATE or DELETE,
  // and a batch runs its statements in order on one connection (SQLite and D1 alike, proven in
  // test-workerd). The DELETE is then guarded on the bump having changed its row, which it does
  // exactly when the write did and the product resolves sets.
  const after = opts.onlyAfterAChange ? "changes() > 0 AND " : "";
  return [
    {
      // Only for a product that resolves sets (an app-only product gets no state row).
      sql: `INSERT INTO release_set_state (product, generation, token, modified_at)
            SELECT ?, 1, ?, ?
             WHERE ${after}${RESOLVES_SETS_SQL}
            ON CONFLICT(product) DO UPDATE SET generation = release_set_state.generation + 1,
              token = excluded.token, modified_at = excluded.modified_at`,
      params: [product, randomHex(12), now, product, product],
    },
    {
      sql: `DELETE FROM release_sets WHERE ${opts.onlyAfterAChange ? "changes() > 0 AND " : ""}product = ?`,
      params: [product],
    },
  ];
}

/** True while the product has a stored set or a compatible or standalone pack. Params: product ×2. */
const RESOLVES_SETS_SQL = `(EXISTS (SELECT 1 FROM release_sets WHERE product = ?)
  OR EXISTS (SELECT 1 FROM release_deliverables
              WHERE product = ? AND kind = 'pack'
                AND (CASE WHEN json_valid(def_json)
                          THEN json_extract(def_json, '$.binding') END)
                    IN ('compatible', 'standalone')))`;

/**
 * Fail closed: clear the product's sets (and move the generation, so a slower writer resolved
 * from before cannot restore them), and audit why. Never throws.
 */
async function clearSets(
  db: Db,
  product: string,
  now: number,
  outcome: Extract<StoreOutcome, { ok: false }>,
): Promise<void> {
  try {
    await db.batch(invalidateSetsStatements(product, now));
    await appendAudit(db, {
      product,
      id: randomId("aud"),
      at: now,
      actor_sub: "system:pack-sets",
      actor_name: "Release",
      actor_email: null,
      action: "release.pack_sets.failed",
      target_kind: "product",
      target_id: product,
      parent_id: null,
      summary:
        `Pack-set resolution failed (${outcome.reason}); the product's resolved sets were cleared: ${outcome.message}`.slice(
          0,
          1000,
        ),
    });
  } catch {
    // The caller still answers the failure; there is nothing safer to do here.
  }
}

/**
 * Store `resolved` (a publish check's own resolution, reused so a publish resolves once) or, when
 * absent or overtaken by a concurrent trigger, re-resolve: the trigger after a publish, a pointer
 * move, a floor change, a yank or a resync. Never refuses for an unsatisfiable set (that is
 * stored with its `unsatisfied` marker). A resolution that FAILS (its bound, or an error) clears
 * the product's sets, writes an audit row and is answered `ok: false`; the operation that
 * triggered it has already happened and stands. Never throws.
 */
export async function resolveAndStore(
  db: Db,
  product: string,
  now: number,
  resolved?: ResolvedForStore | null,
): Promise<StoreOutcome> {
  try {
    if (resolved && (await storeResolution(db, product, resolved, now)))
      return { ok: true, sets: resolved.sets.length };
    // One query decides whether there is anything to do: a product with no compatible or
    // standalone pack and no stored set pays nothing more.
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
    // At most twice: a concurrent trigger that wins the generation makes us re-read once.
    let resolvedCount = 0;
    for (let attempt = 0; attempt < 2; attempt++) {
      const state = await loadResolutionState(db, product);
      if (!state) {
        await db.batch(invalidateSetsStatements(product, now));
        return { ok: true, sets: 0 };
      }
      const r = tryResolve(state);
      if (!r.ok) {
        const outcome = {
          ok: false as const,
          reason: "pack-sets-bound" as const,
          message: r.message,
        };
        await clearSets(db, product, now, outcome);
        return outcome;
      }
      const sets = await withSetIds(r.resolution.sets);
      resolvedCount = sets.length;
      if (
        await storeResolution(
          db,
          product,
          { sets, generation: state.generation },
          now,
        )
      )
        return { ok: true, sets: sets.length };
    }
    // Overtaken twice: the writer that won resolved from a state at least as new as ours.
    return { ok: true, sets: resolvedCount };
  } catch (e) {
    const outcome = {
      ok: false as const,
      reason: "pack-sets-error" as const,
      message: e instanceof Error ? e.message : String(e),
    };
    await clearSets(db, product, now, outcome);
    return outcome;
  }
}

function canonical(db: Db, product: string, channel: string): Promise<string> {
  return getReleaseConfig(db, product).then(
    (cfg) =>
      canonicalChannel(
        channel,
        parseManualChannels(cfg?.manual_channels_json),
      ) ?? channel,
  );
}

/** The stored rows of one channel (the hook's `packSets`), by selector; `channel` is
 *  canonicalised as the policy routes do (`staging` → `beta`). */
export async function readStoredSets(
  db: Db,
  product: string,
  channel: string | null,
): Promise<StoredSet[]> {
  const rows = await db.all<{
    channel: string;
    app_deliverable: string;
    content_api: number;
    platform: string;
    engine: string;
    variant: string;
    pack_set_id: string;
    set_json: string;
    unsatisfied_json: string | null;
    resolved_at: number;
  }>(
    `SELECT channel, app_deliverable, content_api, platform, engine, variant, pack_set_id,
            set_json, unsatisfied_json, resolved_at
       FROM release_sets WHERE product = ? AND (? IS NULL OR channel = ?)
      ORDER BY channel, app_deliverable, content_api, platform, engine, variant`,
    product,
    channel === null ? null : await canonical(db, product, channel),
    channel === null ? null : await canonical(db, product, channel),
  );
  return rows.map((r) => ({
    channel: r.channel,
    appDeliverable: r.app_deliverable,
    contentApi: r.content_api,
    platform: r.platform,
    engine: r.engine,
    variant: r.variant,
    packSetId: r.pack_set_id,
    packs:
      parseJsonOr<{ packs?: StoredSet["packs"] }>(r.set_json, {}).packs ?? [],
    unsatisfied: parseJsonOr<Unsatisfied[]>(r.unsatisfied_json, []),
    resolvedAt: r.resolved_at,
  }));
}

export { canonical as canonicalPackChannel };
