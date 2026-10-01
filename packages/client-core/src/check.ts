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

import type { TrustSet } from "@polaris-key/jws";
import type {
  BinaryMethod,
  ChannelFeedDoc,
  InstalledBuild,
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
} from "./decide.js";
import {
  boundChannels,
  commitFeed,
  reloadFeeds,
  verifyFeed,
  type CommittedFeed,
  type FeedRefusal,
} from "./feed.js";
import { reloadReleaseRecords, verifyReleaseRecord } from "./record.js";

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
  /** The SDK's device id, as it sends `X-PKey-Device`: the rollout bucket's install id. */
  installId: string;
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
  /** Step 11: `GET …/release/records/{sha256}`. */
  fetchRecord(sha256: string): Promise<FetchOutcome>;
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
        feedSource = "committed";
      }
    }
  } else {
    const prior = fallback();
    if (!prior)
      return { ok: false, error: { code: fetched.code, detail: null } };
    errors.push({ code: fetched.code, detail: null });
    feed = prior.feed;
    feedSource = "committed";
  }

  // Steps 10–16.
  const target = feedTarget(feed.app.targets, platform);
  const cachedRecords = opts.cache.releaseRecords ?? {};
  let record: ReleaseRecordDoc | null = null;
  let recordSource: UpdateCheck["record"] = "none";
  let recordJws: string | null = null;
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
    entry?.rollout !== undefined && entry.rollout !== null
      ? await rolloutBucket(entry.rollout.salt, opts.installId)
      : null;
  const decision = decideUpdate({
    now: opts.now,
    feed,
    record,
    installed: opts.installed,
    outlet: opts.outlet,
    subkind: opts.subkind,
    staged: opts.staged ?? null,
    skipVersion: opts.skipVersion ?? null,
    bucket,
    methods: [...opts.methods],
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
  };
}
