// `client.update.decide()`'s shared core — plans/P3-01.md §2.5 steps 2–18 and "After a refusal".
//
// Five SDKs must behave the same after a refusal, so the order, the fallback and the error map
// live here once for both JavaScript SDKs. The function does no I/O of its own: the host hands
// it the two fetches (the feed for a requested channel, a record by hash) and the cache slices,
// and gets back the `UpdateCheck` plus the slices to write. Steps 1 (discovery), the options
// refusals (`not-configured`, `invalid-options`) and the write itself stay with the host.
//
// It never throws. A failure with nothing to decide from comes back as `{ok: false, error}`,
// which the host raises.

import type { NonWireIntegers, TrustSet } from "@polaris-key/jws";
import { MAX_FEED_REVOCATIONS } from "@polaris-key/protocol/core";
import type { AppContent, ContentHold } from "@polaris-key/protocol/packs";
import type {
  BinaryMethod,
  ChannelFeedDoc,
  ContentRevocationInput,
  FeedContent,
  InstalledBuild,
  ReleasePin,
  StagedUpdate,
  UpdateCheck,
  UpdateOutlet,
} from "@polaris-key/protocol/update";
import type { ReleaseRecordDoc } from "@polaris-key/protocol/release";
import {
  bootDecision,
  decideUpdate,
  feedTarget,
  outletEntry,
  rolloutBucket,
  selectPackRows,
} from "./decide.js";
import {
  boundChannels,
  commitFeed,
  feedContent,
  reloadFeeds,
  verifyFeed,
  withFeedContent,
  type CommittedFeed,
  type FeedRefusal,
} from "./feed.js";
import { holdsOf } from "./packs/claims.js";
import { selectVariant } from "./packs/select.js";
import {
  newerRevocation,
  reloadReleaseRecords,
  verifyReleaseRecord,
  verifyRevocation,
  type VerifiedRevocation,
} from "./record.js";

/** One fetch's outcome. A transport failure or a non-2xx answer carries the SDK's own transport
 *  code (`network` in React, `network-error` in Node), or the Worker's wire code when the answer
 *  names one (`feed_not_composable`, …). */
export type FetchOutcome =
  | { ok: true; body: string }
  | { ok: false; code: string };

/** One entry of `UpdateCheck.errors`. */
export interface UpdateCheckError {
  code: string;
  detail: string | null;
}

export interface RunUpdateCheckOptions {
  /** The channel name the host REQUESTED (it may be an alias, such as `latest`). */
  channel: string;
  /** The product: every `aud` must equal it. */
  expectedAud: string;
  /** The EFFECTIVE product trust set (pins ∪ manifest keys). */
  trust: TrustSet;
  /** `pinnedReleaseKeys`: never empty here (the host raises `not-configured` first). */
  releaseKeys: TrustSet;
  /** The effective clock, epoch seconds: `max(system, highWaterMark)`. */
  now: number;
  /** The SDK's device id, as it sends `X-PKey-Device`: the rollout bucket's install id. Null
   *  when the host has none, which leaves the bucket null (out of every client rollout). */
  installId: string | null;
  installed: InstalledBuild;
  outlet: UpdateOutlet;
  subkind: string | null;
  staged?: StagedUpdate | null;
  skipVersion?: string | null;
  methods: readonly BinaryMethod[];
  /** The cache slices as stored. Each entry is re-verified here (the reload path). */
  cache: {
    feeds?: Readonly<Record<string, string>>;
    releaseRecords?: Readonly<Record<string, string>>;
  };
  /** Step 2: `GET …/update/{channel}/feed.jws?platform=…` with the requested name. */
  fetchFeed(channel: string): Promise<FetchOutcome>;
  /** Step 11: `GET …/release/records/{sha256}`. Also fetches revocation and replacement
   *  records by hash (plans/P4-13.md §2.5 steps 11–12). */
  fetchRecord(sha256: string): Promise<FetchOutcome>;
  /**
   * The content decision's inputs (plans/P4-13.md §2.5 steps 10–14, §2.6). Omitted: no content
   * decision, every answer is P3-01's.
   */
  content?: UpdateCheckContent;
}

/** What a host with packs hands the update check (plans/P4-13.md §2.5, §2.6). */
export interface UpdateCheckContent {
  /** The running build's content stamp (`parseContentStamp`'s result). */
  stamp: AppContent;
  /** `holdsOf` over the stamp (`stampHolds`): null when unusable. */
  holds: ContentHold[] | null;
  /** The pack state's active installs, embedded baselines included, by pack id. */
  active: Record<string, ReleasePin>;
  /** The host's engine (`godot-<major>.<minor>`, null outside Godot) and variant axes. */
  engine: string | null;
  axes: Record<string, string[]>;
  /** The stored, verified revocations, by target (the pack engine's `revocations()`). */
  revoked: Record<string, VerifiedRevocation>;
  /** Packs whose revocations must be re-learned (the engine's `relearn`). */
  relearn?: readonly string[];
}

export type RunUpdateCheckResult =
  | {
      ok: true;
      check: UpdateCheck;
      /** The stage machine's `decide.done` for the decision (`bootDecision`). */
      boot: ReturnType<typeof bootDecision>;
      /** The verified feed and record the decision used. */
      feed: ChannelFeedDoc;
      record: ReleaseRecordDoc | null;
      /** The slices to write back (Core's read-modify-write). Only verified, committed
       *  artifacts: a cached entry that failed the reload path is gone. */
      cache: {
        feeds: Record<string, string>;
        releaseRecords: Record<string, string>;
      };
      /** With `content`: the revocations this check verified, to store (the pack engine's
       *  `recordRevocations`), and the packs whose `relearn` it cleared. */
      revocations?: {
        learned: { revocation: VerifiedRevocation; jws: string }[];
        relearnCleared: string[];
      };
    }
  | {
      ok: false;
      /** Nothing to decide from: the code to raise. */
      error: UpdateCheckError;
    };

const FEED_REJECTED = "feed-rejected";
const FEED_ROLLBACK = "feed-rollback";
const RECORD_REJECTED = "record-rejected";
const RECORD_MISMATCH = "record-mismatch";

async function safeFetch(
  fetcher: () => Promise<FetchOutcome>,
  fallbackCode: string,
): Promise<FetchOutcome> {
  try {
    const out = await fetcher();
    if (out && out.ok === true && typeof out.body === "string") return out;
    if (out && out.ok === false && typeof out.code === "string") return out;
    return { ok: false, code: fallbackCode };
  } catch {
    return { ok: false, code: fallbackCode };
  }
}

/** The step-3–8 refusal's entry in `errors`, or null for `not-newer` (nothing is reported). */
function feedError(reason: FeedRefusal): UpdateCheckError | null {
  if (reason === "not-newer") return null;
  if (reason === "rollback") return { code: FEED_ROLLBACK, detail: null };
  return { code: FEED_REJECTED, detail: reason };
}

/**
 * Steps 2–18 of plans/P3-01.md §2.5 with its refusal rules:
 *
 * - the committed feeds are re-verified first (the reload path), which gives the floors;
 * - a fetched body equal to a committed feed that step 5 binds to the request changes nothing;
 * - otherwise the fetched feed is verified (steps 3–8) and, when accepted, committed under its
 *   claim, removing the requested name's entry after an alias answer (step 9);
 * - after a transport failure, `not-newer` or a refusal at steps 3–8, the decision uses the first
 *   committed feed among `feeds[claim]` (only when the fetched feed passed step 5),
 *   `feeds[requested]` and `feeds[CHANNEL_ALIASES[requested]]`; with none, `{ok: false}`;
 * - the record comes from the cache or the network, hash before signature, and a record that
 *   cannot be fetched or is refused is null for this call.
 */
export async function runUpdateCheck(
  opts: RunUpdateCheckOptions,
): Promise<RunUpdateCheckResult> {
  const requested = opts.channel;
  const platform = opts.installed.platform;
  const errors: UpdateCheckError[] = [];

  // The reload path: the committed feeds that still verify, and the floors they set.
  const committed = await reloadFeeds(opts.cache.feeds, {
    trust: opts.trust,
    expectedAud: opts.expectedAud,
    platform,
  });
  let feeds: Record<string, string> = {};
  // The decoded twin of `feeds`, so the records can be pruned to what a committed feed pins.
  const feedDocs: Record<string, ChannelFeedDoc> = {};
  for (const [k, c] of Object.entries(committed.feeds)) {
    feeds[k] = c.jws;
    feedDocs[k] = c.feed;
  }

  const fallback = (claim?: string): CommittedFeed | null => {
    const keys = [
      ...(claim === undefined ? [] : [claim]),
      ...boundChannels(requested),
    ];
    for (const k of keys)
      if (Object.prototype.hasOwnProperty.call(committed.feeds, k))
        return committed.feeds[k]!;
    return null;
  };

  // Steps 2–9.
  let feed: ChannelFeedDoc | null = null;
  let content: FeedContent | null = null;
  let feedSource: UpdateCheck["feed"] = "network";
  const fetched = await safeFetch(() => opts.fetchFeed(requested), "network");
  if (fetched.ok) {
    // Step 2: an unchanged body decides from the committed copy.
    for (const k of boundChannels(requested)) {
      const c = Object.prototype.hasOwnProperty.call(committed.feeds, k)
        ? committed.feeds[k]!
        : undefined;
      if (c && c.jws === fetched.body) {
        feed = c.feed;
        content = c.content;
        break;
      }
    }
    if (feed === null) {
      const v = await verifyFeed(fetched.body, {
        trust: opts.trust,
        expectedAud: opts.expectedAud,
        channel: requested,
        platform,
        now: opts.now,
        checkFreshness: true,
        floors: committed.floors,
      });
      if (v.ok) {
        feed = v.feed;
        content = v.content;
        feeds = commitFeed(feeds, {
          requested,
          claim: v.feed.channel,
          jws: fetched.body,
        });
        if (v.feed.channel !== requested) delete feedDocs[requested];
        feedDocs[v.feed.channel] = v.feed;
      } else {
        const err = feedError(v.reason);
        const prior = fallback(v.channel);
        if (!prior)
          return {
            ok: false,
            error: err ?? { code: FEED_REJECTED, detail: v.reason },
          };
        if (err) errors.push(err);
        feed = prior.feed;
        content = prior.content;
        feedSource = "committed";
      }
    }
  } else {
    const prior = fallback();
    if (!prior)
      return { ok: false, error: { code: fetched.code, detail: null } };
    errors.push({ code: fetched.code, detail: null });
    feed = prior.feed;
    content = prior.content;
    feedSource = "committed";
  }

  // Steps 10–16.
  const target = feedTarget(feed.app.targets, platform);
  const cachedRecords = opts.cache.releaseRecords ?? {};
  let record: ReleaseRecordDoc | null = null;
  let recordSource: UpdateCheck["record"] = "none";
  let recordJws: string | null = null;
  let recordNonWire: NonWireIntegers | null = null;
  if (target) {
    const pin = target.release;
    const verifyOpts = {
      releaseKeys: opts.releaseKeys,
      productTrust: opts.trust,
      expectedAud: opts.expectedAud,
      expectedHash: pin.sha256,
      pin: { deliverable: "app", version: pin.version, seq: pin.seq },
    };
    const cached = Object.prototype.hasOwnProperty.call(
      cachedRecords,
      pin.sha256,
    )
      ? cachedRecords[pin.sha256]
      : undefined;
    if (typeof cached === "string") {
      const r = await verifyReleaseRecord(cached, verifyOpts);
      if (r.ok) {
        record = r.record;
        recordSource = "cache";
        recordJws = cached;
        recordNonWire = r.nonWireIntegers;
      }
    }
    if (record === null) {
      const got = await safeFetch(
        () => opts.fetchRecord(pin.sha256),
        "network",
      );
      if (!got.ok) errors.push({ code: got.code, detail: null });
      else {
        const r = await verifyReleaseRecord(got.body, verifyOpts);
        if (r.ok) {
          record = r.record;
          recordSource = "network";
          recordJws = got.body;
          recordNonWire = r.nonWireIntegers;
        } else if (r.step === "cross-check")
          errors.push({ code: RECORD_MISMATCH, detail: null });
        else errors.push({ code: RECORD_REJECTED, detail: r.step });
      }
    }
  }

  // A record is kept only while a committed feed's target for this platform pins it.
  const pinned = new Set<string>();
  for (const doc of Object.values(feedDocs)) {
    const t = feedTarget(doc.app.targets, platform);
    if (t) pinned.add(t.release.sha256);
  }
  const candidates: Record<string, string> = {};
  for (const [h, jws] of Object.entries(cachedRecords)) candidates[h] = jws;
  if (recordJws !== null && target)
    candidates[target.release.sha256] = recordJws;
  const kept = await reloadReleaseRecords(candidates, {
    releaseKeys: opts.releaseKeys,
    productTrust: opts.trust,
    expectedAud: opts.expectedAud,
    pinned,
  });
  const releaseRecords: Record<string, string> = {};
  for (const [h, r] of Object.entries(kept)) releaseRecords[h] = r.jws;

  // Steps 17–18.
  const entry = outletEntry(target, opts.outlet);
  const bucket =
    entry?.rollout !== undefined && opts.installId !== null
      ? await rolloutBucket(entry.rollout.salt, opts.installId)
      : null;

  // plans/P4-13.md §2.5 content steps 10–14.
  let contentInput: Parameters<typeof decideUpdate>[0]["content"];
  let revocations: Extract<RunUpdateCheckResult, { ok: true }>["revocations"];
  let decisionFeed = feed;
  let decisionRecord = record;
  if (opts.content) {
    const fc = content ?? feedContent(feed);
    decisionFeed = withFeedContent(feed, fc);
    const steps = await contentSteps(opts, fc, feedSource, errors);
    contentInput = steps.input;
    revocations = steps.revocations;
    // The record's holds, read with its own non-wire pointers: unusable reads as `null` so the
    // decision (which re-reads them without the token rule) sees the same verdict.
    if (record && record.content && recordNonWire) {
      const h = holdsOf(record.content, recordNonWire, "/content");
      if (
        h === null &&
        Object.prototype.hasOwnProperty.call(record.content, "holds")
      )
        decisionRecord = {
          ...record,
          content: {
            ...record.content,
            holds: null as unknown as ContentHold[],
          },
        };
    }
  }

  const decision = decideUpdate({
    now: opts.now,
    feed: decisionFeed,
    record: decisionRecord,
    installed: opts.installed,
    outlet: opts.outlet,
    subkind: opts.subkind,
    staged: opts.staged ?? null,
    skipVersion: opts.skipVersion ?? null,
    bucket,
    methods: [...opts.methods],
    ...(contentInput ? { content: contentInput } : {}),
  });

  return {
    ok: true,
    check: {
      channel: feed.channel,
      decision,
      feed: feedSource,
      record: recordSource,
      errors,
    },
    boot: bootDecision(decision),
    feed,
    record,
    cache: { feeds, releaseRecords },
    ...(revocations ? { revocations } : {}),
  };
}

/**
 * plans/P4-13.md §2.5 content steps 10–13: the relevant revocations (fetched and verified against
 * the pinned release keys, at most `MAX_FEED_REVOCATIONS` per check, superseding by
 * `newerRevocation`), their replacements (fetched, verified as pack records, not revoked, and with
 * a variant for this host), the gate buckets, and the decision's content input. A failed fetch
 * retries at the next check; a failed verification is ignored and never trusted.
 */
async function contentSteps(
  opts: RunUpdateCheckOptions,
  fc: FeedContent,
  feedSource: UpdateCheck["feed"],
  errors: UpdateCheckError[],
): Promise<{
  input: NonNullable<Parameters<typeof decideUpdate>[0]["content"]>;
  revocations: {
    learned: { revocation: VerifiedRevocation; jws: string }[];
    relearnCleared: string[];
  };
}> {
  const c = opts.content!;
  const platform = opts.installed.platform;
  const engine = opts.installed.engine ?? "";

  // H: the active pack records, the stamp's pins and holds, and the feed targets §2.6 selects
  // (gate fallbacks included).
  const H = new Set<string>();
  for (const pin of Object.values(c.active)) H.add(pin.sha256);
  for (const p of c.stamp.pins) H.add(p.release.sha256);
  for (const h of c.holds ?? []) H.add(h.release.sha256);
  const ps = fc.packSets;
  if (ps) {
    const targets = selectPackRows(ps, {
      contentApi: c.stamp.contentApi,
      platform,
      engine,
      axes: c.axes,
    });
    for (const h of targets.values()) {
      H.add(h);
      for (const o of Object.values(ps.outlets ?? {}))
        for (const [g, gate] of Object.entries(o.gates ?? {}))
          if (g === h && gate.fallback !== null) H.add(gate.fallback);
    }
  }

  // Step 11.
  const stored = new Map<string, VerifiedRevocation>(Object.entries(c.revoked));
  const learned: { revocation: VerifiedRevocation; jws: string }[] = [];
  let fetches = 0;
  for (const entry of fc.revocations ?? []) {
    if (!H.has(entry.target)) continue;
    const have = stored.get(entry.target);
    if (have && have.record === entry.record) continue;
    if (fetches >= MAX_FEED_REVOCATIONS) break;
    fetches++;
    const got = await safeFetch(
      () => opts.fetchRecord(entry.record),
      "network",
    );
    if (!got.ok) {
      errors.push({ code: got.code, detail: null });
      continue;
    }
    const r = await verifyRevocation(got.body, {
      releaseKeys: opts.releaseKeys,
      productTrust: opts.trust,
      expectedAud: opts.expectedAud,
      entry,
    });
    if (!r.ok) {
      errors.push({ code: RECORD_REJECTED, detail: r.step });
      continue;
    }
    if (!have || newerRevocation(r.revocation, have) === r.revocation) {
      stored.set(entry.target, r.revocation);
      learned.push({ revocation: r.revocation, jws: got.body });
    }
  }

  // Step 12: the replacements of the relevant stored revocations.
  const isRevoked = (h: string): boolean => stored.has(h);
  const revInput: ContentRevocationInput[] = [];
  for (const [target, rev] of stored) {
    let usable = false;
    const rep = rev.replacement;
    if (rep !== null && H.has(target) && !isRevoked(rep.sha256)) {
      const got = await safeFetch(
        () => opts.fetchRecord(rep.sha256),
        "network",
      );
      if (got.ok) {
        const v = await verifyReleaseRecord(got.body, {
          releaseKeys: opts.releaseKeys,
          productTrust: opts.trust,
          expectedAud: opts.expectedAud,
          expectedHash: rep.sha256,
          pin: {
            kind: "pack",
            deliverable: rev.pack,
            version: rep.version,
            seq: rep.seq,
          },
        });
        if (v.ok) {
          const variants =
            (v.record as unknown as { variants?: unknown[] }).variants ?? [];
          usable = !(
            "error" in
            selectVariant(variants, { engine: c.engine, axes: c.axes })
          );
        }
      }
    }
    revInput.push({
      target,
      pack: rev.pack,
      replacement: rep,
      replacementUsable: usable,
    });
  }

  // Step 13: the bucket of every gate salt.
  const buckets: Record<string, number | null> = {};
  for (const o of Object.values(ps?.outlets ?? {}))
    for (const gate of Object.values(o.gates ?? {}))
      if (
        gate.rollout &&
        !Object.prototype.hasOwnProperty.call(buckets, gate.rollout.salt)
      )
        buckets[gate.rollout.salt] =
          opts.installId === null
            ? null
            : await rolloutBucket(gate.rollout.salt, opts.installId);

  // `relearn` clears only on a fresh, network-verified feed with a usable `revocations` member,
  // once every revocation it lists for that pack is learned.
  const relearnCleared: string[] = [];
  if (feedSource === "network" && fc.revocations !== null)
    for (const p of c.relearn ?? []) {
      const all = fc.revocations
        .filter((e) => e.pack === p)
        .every((e) => stored.get(e.target)?.record === e.record);
      if (all) relearnCleared.push(p);
    }

  return {
    input: {
      stamp: {
        contentApi: c.stamp.contentApi,
        pins: c.stamp.pins,
        expects: c.stamp.expects,
        holds: c.holds,
      },
      active: c.active,
      axes: c.axes,
      revocations: revInput,
      buckets,
    },
    revocations: { learned, relearnCleared },
  };
}
