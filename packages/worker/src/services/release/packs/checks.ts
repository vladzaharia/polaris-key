/**
 * The two-way publish checks (P4-12, CONTENT §6.4, README §3.4). Each overlays the release being
 * published on what is stored, re-resolves every channel, and compares: both refuse with
 * `release_record_rejected` and a reason naming the selector and the constraint, and both answer
 * the resulting sets and the app releases that receive them (`PackSetReport`), which the submit
 * returns, dry run or not.
 *
 * A PACK RELEASE (`compatible` or `standalone`; a `pinned` pack never enters a set):
 *
 *   pack-unsatisfiable  at a live selector it is meant for (its channel serves it there and, if
 *                       compatible, its contentApi range holds the level) it lacks the selector's
 *                       variant ("a missing variant for a live platform"), or it passes its stages
 *                       yet the set keeps an older release (or none) because it breaks a
 *                       `requires.packs` range or a `conflicts` entry; or, with it, a live app
 *                       release's held set breaks a dependency or a conflict it did not before.
 *
 * A release for another engine or below a floor is not a failure: it is simply not chosen (a
 * release for a coming engine is published before the app that runs it, CONTENT §6.8 row 7).
 *
 * AN APP RELEASE (with `content`):
 *
 *   pack-channels-conflict  its `packChannels` differs from another live app release's on the
 *                           same channel and contentApi (sets are keyed per channel and level,
 *                           so a mapping change needs a contentApi bump);
 *   content-unsatisfied     at a selector it is live in, a `required` compatible or standalone
 *                           pack has no release ("every required compatible pack has at least one
 *                           compatible release on each of the app's channels");
 *   hold-unsatisfiable      at such a selector, the set with its holds substituted breaks a
 *                           dependency or a conflict.
 *
 * Either check refuses `pack-sets-bound` when resolution cannot finish inside its bounds.
 */

import type { PackRecordDoc } from "@polaris-key/protocol/packs";
import type { Db } from "../../../core/platform.js";
import type { ReleaseConfigRow } from "../config.js";
import { canonicalChannel, type Candidate } from "../resolve.js";
import type { RecordRefusalReason } from "../records.js";
import { packReleaseId, variantConflicts } from "./ingest.js";
import type {
  AppReleaseFacts,
  PackReleaseFacts,
  PackResolver,
  ResolvedSet,
} from "./resolve.js";
import {
  loadResolutionState,
  packVariantFacts,
  readStoredSets,
  rowKey,
  setReport,
  tryResolve,
  withAppRelease,
  withPackRelease,
  withSetIds,
  type PackSetReport,
  type ResolutionState,
  type ResolvedForStore,
  type StoredSet,
} from "./sets.js";

export type CheckRefusal = {
  ok: false;
  reason: RecordRefusalReason;
  message: string;
};
export type CheckResult =
  | {
      ok: true;
      report: PackSetReport | null;
      /** The after-state's rows, which the publish stores once it has written the release
       *  (`resolveAndStore`), so a publish resolves once. Null when there are none to store. */
      resolved: ResolvedForStore | null;
    }
  | CheckRefusal;

/**
 * A request's memo of its checks: P2-02's submit plans an app release twice (a dry-run pre-check,
 * then the ingest), over the same stored state, and the second plan reuses the first's result.
 */
export type CheckCache = Map<string, CheckResult>;

const NOTHING: CheckResult = { ok: true, report: null, resolved: null };

function refuse(reason: RecordRefusalReason, message: string): CheckRefusal {
  return { ok: false, reason, message };
}

/** A selector, as a refusal names it. */
export function selectorText(s: {
  channel: string;
  contentApi: number;
  platform: string;
  engine: string;
  variant: string;
}): string {
  return `channel ${s.channel}, contentApi ${s.contentApi}, platform ${s.platform}${s.engine ? `, engine ${s.engine}` : ""}${s.variant ? `, variant ${s.variant}` : ""}`;
}

/** A pack record as resolution would see it once stored. */
export function packReleaseOf(
  record: PackRecordDoc,
  recordSha256: string,
  manual: Parameters<typeof canonicalChannel>[1],
): { candidate: Candidate; facts: PackReleaseFacts } {
  const releaseId = packReleaseId(record);
  return {
    candidate: {
      releaseId,
      version: record.version,
      seq: record.seq,
      channel: record.channel ? canonicalChannel(record.channel, manual) : null,
      prerelease: false,
      tag: null,
      builds: [],
    },
    facts: {
      releaseId,
      version: record.version,
      seq: record.seq,
      recordSha256,
      variants: record.variants.map((v) => {
        const conflicts = variantConflicts(v);
        return packVariantFacts({
          variant_json: JSON.stringify(v.variant),
          requires_json: v.requires ? JSON.stringify(v.requires) : null,
          conflicts_json: Array.isArray(conflicts)
            ? JSON.stringify(conflicts)
            : null,
        });
      }),
    },
  };
}

/** The violation the held sets of `set`'s app releases show, keyed by app release. */
function heldViolations(
  resolver: PackResolver,
  set: Pick<ResolvedSet, "entries" | "variant" | "group" | "appReleases">,
  only?: string,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const id of set.appReleases) {
    if (only !== undefined && id !== only) continue;
    const holds = resolver.input.app.releases.get(id)?.holds ?? [];
    const v = resolver.heldSetViolation(set, holds);
    if (v) out.set(id, v);
  }
  return out;
}

/** The pack-release check (see the header). */
export async function checkPackPublish(
  db: Db,
  product: string,
  record: PackRecordDoc,
  recordSha256: string,
  cfg: ReleaseConfigRow | null,
): Promise<CheckResult> {
  const state = await loadResolutionState(db, product, cfg);
  if (!state) return NOTHING;
  const decl = state.declared.get(record.deliverable);
  if (!decl || (decl.binding !== "compatible" && decl.binding !== "standalone"))
    return NOTHING;
  const { candidate, facts } = packReleaseOf(
    record,
    recordSha256,
    state.input.app.manual,
  );
  return compare(
    db,
    product,
    withPackRelease(state, record.deliverable, candidate, facts),
    (after, stored) => {
      const pack = after.resolver.pack(record.deliverable)!;
      const was = new Map(stored.map((s) => [rowKey(s), s]));
      for (const set of after.resolution.sets) {
        const v = after.resolver.publishViolation(
          set,
          pack,
          candidate.releaseId,
          after.resolver.levelMapping(set.channel, set.contentApi),
        );
        if (v)
          return refuse(
            "pack-unsatisfiable",
            `${record.deliverable} ${record.version} fails at ${selectorText(set)}: ${v.detail} (${v.reason}).`,
          );
        const prior = was.get(rowKey(set));
        const held = heldViolations(after.resolver, set);
        for (const [app, detail] of held) {
          // A violation the stored row already showed is not this release's regression.
          const earlier = prior
            ? heldViolations(
                after.resolver,
                {
                  entries: prior.packs.map((p) => ({
                    pack: p.pack,
                    releaseId: p.releaseId,
                    version: p.version,
                    seq: p.seq,
                    recordSha256: p.sha256,
                  })),
                  variant: set.variant,
                  group: set.group,
                  appReleases: set.appReleases,
                },
                app,
              ).get(app)
            : undefined;
          if (earlier === undefined)
            return refuse(
              "pack-unsatisfiable",
              `with ${record.deliverable} ${record.version}, app release ${app}'s holds break at ${selectorText(set)}: ${detail}.`,
            );
        }
      }
      return null;
    },
  );
}

/** The app release being published, as the check needs it. */
export interface AppPublish {
  releaseId: string;
  version: string;
  seq: number;
  channel: string | null;
  tag: string | null;
  builds: {
    buildId: string;
    platform: string | null;
    arch: string;
    engine: string | null;
  }[];
  contentApi: number | null;
  packChannels: Record<string, string> | null;
  holds: { pack: string; releaseId: string }[];
}

const canonicalMap = (m: Record<string, string> | null): string =>
  m
    ? JSON.stringify(
        Object.entries(m).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      )
    : "null";

/** The app-release check (see the header). */
export async function checkAppPublish(
  db: Db,
  product: string,
  a: AppPublish,
  cfg: ReleaseConfigRow | null,
  cache?: CheckCache,
): Promise<CheckResult> {
  if (a.contentApi === null) return NOTHING;
  const key = JSON.stringify(a);
  const hit = cache?.get(key);
  if (hit) return hit;
  const result = await checkAppPublishUncached(db, product, a, cfg);
  cache?.set(key, result);
  return result;
}

async function checkAppPublishUncached(
  db: Db,
  product: string,
  a: AppPublish & { contentApi: number | null },
  cfg: ReleaseConfigRow | null,
): Promise<CheckResult> {
  const state = await loadResolutionState(db, product, cfg);
  if (!state) return NOTHING;
  if (
    ![...state.declared.values()].some(
      (p) => p.binding === "compatible" || p.binding === "standalone",
    )
  )
    return NOTHING;
  const manual = state.input.app.manual;
  const existing = state.input.app.candidates.find(
    (c) => c.releaseId === a.releaseId,
  );
  const channel = a.channel ? canonicalChannel(a.channel, manual) : null;
  const candidate: Candidate = {
    releaseId: a.releaseId,
    version: a.version,
    seq: a.seq,
    channel: channel ?? existing?.channel ?? null,
    prerelease: existing?.prerelease ?? false,
    tag: a.tag,
    builds: a.builds.map((b) => ({
      buildId: b.buildId,
      platform: b.platform,
      arch: b.arch,
    })),
  };
  const facts: AppReleaseFacts = {
    contentApi: a.contentApi,
    builds: a.builds.map((b) => ({ platform: b.platform, engine: b.engine })),
    packChannels: a.packChannels,
    holds: a.holds,
  };
  return compare(
    db,
    product,
    withAppRelease(state, candidate, facts, channel),
    (after) => {
      for (const [ch, live] of after.resolution.live) {
        if (!live.some((r) => r.releaseId === a.releaseId)) continue;
        for (const other of live) {
          if (
            other.releaseId === a.releaseId ||
            other.contentApi !== a.contentApi
          )
            continue;
          const theirs =
            after.resolver.input.app.releases.get(other.releaseId)
              ?.packChannels ?? null;
          if (canonicalMap(theirs) !== canonicalMap(a.packChannels))
            return refuse(
              "pack-channels-conflict",
              `${a.releaseId} maps packs to channels as ${canonicalMap(a.packChannels)}, but ${other.releaseId}, live on ${ch} at contentApi ${a.contentApi}, maps them as ${canonicalMap(theirs)}; a packChannels change needs a contentApi bump.`,
            );
        }
      }
      for (const set of after.resolution.sets) {
        if (!set.appReleases.includes(a.releaseId)) continue;
        for (const u of set.unsatisfied)
          if (after.resolver.pack(u.pack)?.required)
            return refuse(
              "content-unsatisfied",
              `${u.pack} is required, and no release of it serves ${a.releaseId} at ${selectorText(set)}: ${u.detail} (${u.reason}).`,
            );
        const held = heldViolations(after.resolver, set, a.releaseId).get(
          a.releaseId,
        );
        if (held)
          return refuse(
            "hold-unsatisfiable",
            `${a.releaseId}'s holds break the set at ${selectorText(set)}: ${held}.`,
          );
      }
      return null;
    },
  );
}

type Resolved = Extract<ReturnType<typeof tryResolve>, { ok: true }>;

/**
 * Resolve the after-state ONCE, run `judge` over it and the stored rows (the before-state: what
 * the last trigger stored), and report the difference. The after-state's rows come back for the
 * publish to store, so a publish never resolves a second time.
 */
async function compare(
  db: Db,
  product: string,
  after: ResolutionState,
  judge: (after: Resolved, stored: StoredSet[]) => CheckRefusal | null,
): Promise<CheckResult> {
  const a = tryResolve(after);
  if (!a.ok) return refuse("pack-sets-bound", a.message);
  const stored = await readStoredSets(db, product, null);
  const refusal = judge(a, stored);
  if (refusal) return refusal;
  const sets = await withSetIds(a.resolution.sets);
  return {
    ok: true,
    report: setReport(stored, sets),
    resolved: { sets, generation: after.generation },
  };
}
