// The channel feed — WIRE-CONTRACT-V4 §2.3 and client steps 3–9 (plans/P3-01.md §2.3, §2.5).
// P3-02 landed `feedClaims` (steps 4–6), which P3-03's composer runs on every document before
// signing it; P3-05 adds `verifyFeed` (steps 3–8), the floor, the reload path and step 9's write
// around it. Nothing here does I/O or throws.
//
// Every pattern matches the whole string (JavaScript with no flags), every length counts UTF-8
// bytes, a required member must be present (`floor` and `live` may be `null`, never missing),
// and an optional member is absent or of its type (a present `null` is refused). Every integer
// field is an integer claim, checked at its RFC 6901 pointer.

import {
  verifyJws,
  type NonWireIntegers,
  type TrustSet,
} from "@polaris-key/jws";
import {
  CHANNEL_ALIASES,
  CHANNEL_NAME_PATTERN,
  ISSUER,
} from "@polaris-key/protocol/core";
import {
  BINARY_UPDATES_ORDER,
  LISTING_URL_PREFIXES,
  OUTLET_ID_PATTERN,
  OUTLET_KINDS,
} from "@polaris-key/protocol/distribution";
import {
  FEED_PLATFORM_PATTERN,
  FEED_VERSION_SCHEMES,
  MAX_FEED_TTL_SECONDS,
  ROLLOUT_BUCKETS,
  type ChannelFeedDoc,
} from "@polaris-key/protocol/update";
import {
  CLOCK_SKEW_SECONDS,
  NO_NON_WIRE_INTEGERS,
  isWireInteger,
} from "./claims.js";
import { compareVersions, parseVersion } from "./version.js";

export interface FeedClaimsOptions {
  /** The product: `aud` must equal it. */
  expectedAud: string;
  /** The channel name the client REQUESTED (it may be an alias). */
  channel: string;
  /** The client's platform; when given, a `selector.platform` must equal it. */
  platform?: string;
  /** The verified payload's `nonWireIntegers`; omit when checking an object you built. */
  nonWire?: NonWireIntegers;
}

export type FeedClaimsRefusal = "claims" | "channel" | "selector";

const CHANNEL_RE = new RegExp(CHANNEL_NAME_PATTERN);
const SHA256_RE = /^[0-9a-f]{64}$/;
const SALT_RE = /^[0-9a-f]{32}$/;
const MAX_LISTING_URL_BYTES = 2048;
const CAPABILITY_BOOLEANS = [
  "codeUpdates",
  "dataUpdates",
  "channelSwitch",
  "downloadedScripts",
] as const;
const COMMERCE = ["own", "store-iap", "steam", "none"];

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function has(o: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(o, key);
}

/** `listingUrl`: 1–2048 bytes, each 0x21–0x7E, so bytes and characters count alike. */
function isPrintableAscii(v: string, max: number): boolean {
  if (v.length < 1 || v.length > max) return false;
  for (let k = 0; k < v.length; k++) {
    const c = v.charCodeAt(k);
    if (c < 0x21 || c > 0x7e) return false;
  }
  return true;
}

function capabilitiesOk(v: unknown): boolean {
  if (!isObject(v)) return false;
  if (
    has(v, "binaryUpdates") &&
    !(BINARY_UPDATES_ORDER as readonly unknown[]).includes(v.binaryUpdates)
  )
    return false;
  for (const key of CAPABILITY_BOOLEANS)
    if (has(v, key) && typeof v[key] !== "boolean") return false;
  if (has(v, "commerce") && !COMMERCE.includes(v.commerce as string))
    return false;
  return true;
}

/** Step 4: the claims of §2.3. True when they all hold. */
function claimsOk(
  doc: Record<string, unknown>,
  opts: FeedClaimsOptions,
  nonWire: NonWireIntegers,
): boolean {
  const int = (v: unknown, pointer: string, min: number): v is number =>
    isWireInteger(v, pointer, min, nonWire);

  if (!int(doc.schemaVersion, "/schemaVersion", 1) || doc.schemaVersion !== 1)
    return false;
  if (doc.iss !== ISSUER) return false;
  if (doc.aud !== opts.expectedAud) return false;
  if (typeof doc.channel !== "string" || !CHANNEL_RE.test(doc.channel))
    return false;
  if (!isObject(doc.selector)) return false;
  const selector = doc.selector;
  if (has(selector, "platform") && typeof selector.platform !== "string")
    return false;
  if (!int(doc.seq, "/seq", 1)) return false;
  if (!int(doc.issuedAt, "/issuedAt", 0)) return false;
  if (!int(doc.expiresAt, "/expiresAt", 1)) return false;
  if (!(doc.issuedAt < doc.expiresAt)) return false;
  if (doc.expiresAt > doc.issuedAt + MAX_FEED_TTL_SECONDS) return false;

  if (!isObject(doc.app)) return false;
  const app = doc.app;
  if (app.deliverable !== "app") return false;
  const scheme = app.versionScheme;
  if (
    typeof scheme !== "string" ||
    !(FEED_VERSION_SCHEMES as readonly string[]).includes(scheme)
  )
    return false;
  const version = (v: unknown): v is string =>
    typeof v === "string" && parseVersion(scheme, v) !== null;
  if (!Array.isArray(app.targets)) return false;

  const platforms = new Set<string>();
  for (const [i, target] of app.targets.entries()) {
    const at = `/app/targets/${i}`;
    if (!isObject(target)) return false;
    const platform = target.platform;
    if (typeof platform !== "string" || !FEED_PLATFORM_PATTERN.test(platform))
      return false;
    if (platforms.has(platform)) return false;
    platforms.add(platform);
    if (has(selector, "platform") && platform !== selector.platform)
      return false;

    const release = target.release;
    if (!isObject(release)) return false;
    if (typeof release.sha256 !== "string" || !SHA256_RE.test(release.sha256))
      return false;
    if (!int(release.seq, `${at}/release/seq`, 1)) return false;
    if (!version(release.version)) return false;

    if (!has(target, "floor")) return false;
    if (target.floor !== null) {
      if (!isObject(target.floor)) return false;
      const min = target.floor.minVersion;
      if (!version(min)) return false;
      const c = compareVersions(scheme, min, release.version);
      if (c === null || c > 0) return false;
    }
    if (typeof target.critical !== "boolean") return false;

    if (!isObject(target.outlets)) return false;
    for (const [id, entry] of Object.entries(target.outlets)) {
      const pointer = `${at}/outlets/${id.replace(/~/g, "~0").replace(/\//g, "~1")}`;
      if (!OUTLET_ID_PATTERN.test(id)) return false;
      if (!isObject(entry)) return false;
      const kind = entry.kind;
      if (
        typeof kind !== "string" ||
        !OUTLET_ID_PATTERN.test(kind) ||
        kind === "unknown"
      )
        return false;
      if (!has(entry, "live")) return false;
      if (entry.live !== null) {
        if (!isObject(entry.live)) return false;
        if (!version(entry.live.version)) return false;
        if (!int(entry.live.seq, `${pointer}/live/seq`, 1)) return false;
      }
      if (typeof entry.halted !== "boolean") return false;
      if (has(entry, "rollout")) {
        const rollout = entry.rollout;
        if (!isObject(rollout)) return false;
        if (!int(rollout.bp, `${pointer}/rollout/bp`, 0)) return false;
        if (rollout.bp > ROLLOUT_BUCKETS) return false;
        if (typeof rollout.salt !== "string" || !SALT_RE.test(rollout.salt))
          return false;
      }
      if (has(entry, "listingUrl")) {
        const url = entry.listingUrl;
        if (typeof url !== "string") return false;
        if ((OUTLET_KINDS as readonly string[]).includes(kind)) {
          const prefixes = LISTING_URL_PREFIXES[kind] ?? [];
          if (!isPrintableAscii(url, MAX_LISTING_URL_BYTES)) return false;
          if (!prefixes.some((p) => url.startsWith(p))) return false;
        }
      }
      if (has(entry, "capabilities") && !capabilitiesOk(entry.capabilities))
        return false;
    }
  }
  return true;
}

/**
 * Client steps 4–6 over a verified feed payload: the claims (`"claims"`), the channel binding
 * (`"channel"`: the claim is never `latest`, and equals the requested name or, when that name
 * is an alias, `CHANNEL_ALIASES[requested]`) and the selector (`"selector"`). Null when all
 * three pass; the claim is then the canonical channel. Never throws.
 */
export function feedClaims(
  payload: unknown,
  opts: FeedClaimsOptions,
): FeedClaimsRefusal | null {
  const nonWire = opts.nonWire ?? NO_NON_WIRE_INTEGERS;
  if (!isObject(payload)) return "claims";
  try {
    if (!claimsOk(payload, opts, nonWire)) return "claims";
  } catch {
    return "claims";
  }
  const claim = payload.channel as string;
  const requested = opts.channel;
  const alias = has(CHANNEL_ALIASES, requested)
    ? CHANNEL_ALIASES[requested as keyof typeof CHANNEL_ALIASES]
    : undefined;
  if (claim === "latest") return "channel";
  if (claim !== requested && claim !== alias) return "channel";
  const selector = payload.selector as Record<string, unknown>;
  for (const key of Object.keys(selector))
    if (key !== "platform") return "selector";
  if (
    has(selector, "platform") &&
    opts.platform !== undefined &&
    selector.platform !== opts.platform
  )
    return "selector";
  return null;
}

// ── P3-05: the verifier around the claims (client steps 3–8), the floor and the reload path ──

/** The `seq` floor of one canonical channel: the committed feed's `seq` and `issuedAt`. */
export interface FeedFloor {
  seq: number;
  issuedAt: number;
}

/** Why `verifyFeed` refused, by client step (`feedCases` `expect.reason`). */
export type FeedRefusal =
  | "jws"
  | FeedClaimsRefusal
  | "freshness"
  | "not-newer"
  | "rollback";

export interface VerifyFeedOptions {
  /** The EFFECTIVE product trust set (pins ∪ manifest keys), as for documents (step 3). */
  trust: TrustSet;
  /** The product: `aud` must equal it. */
  expectedAud: string;
  /** The channel name the client REQUESTED (it may be an alias); step 5 binds the claim to it. */
  channel: string;
  /** The client's platform (step 6). */
  platform: string;
  /** The effective clock, epoch seconds. Defaults to the system clock. */
  now?: number;
  /** Step 7, on the network path only (the default). False on the reload path. */
  checkFreshness?: boolean;
  /**
   * The floors, keyed by CANONICAL channel (each committed feed's own `channel` claim). Step 8
   * reads `floors[claim]` only after step 5 has bound the claim; it never looks up the
   * requested name or resolves an alias itself.
   */
  floors?: Readonly<Record<string, FeedFloor>>;
}

export type VerifyFeedResult =
  | { ok: true; feed: ChannelFeedDoc }
  | {
      ok: false;
      reason: FeedRefusal;
      /** The canonical channel, present only when the feed passed step 5 (a refusal at step 6,
       *  7 or 8): the first key of §2.5's fallback order. */
      channel?: string;
    };

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

/**
 * Client steps 3–8 (plans/P3-01.md §2.5): `verifyJws` with the effective trust set and `typ`
 * `pkey-feed+jws`, the claims, the channel binding, the selector, freshness on the network path,
 * and the `seq` floor of the canonical channel. Never throws.
 */
export async function verifyFeed(
  jws: string,
  opts: VerifyFeedOptions,
): Promise<VerifyFeedResult> {
  let v: Awaited<ReturnType<typeof verifyJws<unknown>>>;
  try {
    v = await verifyJws<unknown>(jws, opts.trust, { typ: "pkey-feed+jws" });
  } catch {
    v = null;
  }
  if (!v) return { ok: false, reason: "jws" };
  const refusal = feedClaims(v.payload, {
    expectedAud: opts.expectedAud,
    channel: opts.channel,
    platform: opts.platform,
    nonWire: v.nonWireIntegers,
  });
  if (refusal === "claims" || refusal === "channel")
    return { ok: false, reason: refusal };
  const feed = v.payload as ChannelFeedDoc;
  // From here on the claim is the canonical channel (step 5).
  const channel = feed.channel;
  if (refusal === "selector") return { ok: false, reason: refusal, channel };
  if (opts.checkFreshness !== false) {
    const now = opts.now ?? nowSeconds();
    if (
      feed.issuedAt > now + CLOCK_SKEW_SECONDS ||
      feed.expiresAt <= now - CLOCK_SKEW_SECONDS
    )
      return { ok: false, reason: "freshness", channel };
  }
  const floors = opts.floors;
  if (floors && has(floors as Record<string, unknown>, channel)) {
    const floor = floors[channel]!;
    if (feed.seq < floor.seq) return { ok: false, reason: "rollback", channel };
    if (feed.seq === floor.seq && feed.issuedAt <= floor.issuedAt)
      return { ok: false, reason: "not-newer", channel };
  }
  return { ok: true, feed };
}

/** The floor a committed feed sets for its canonical channel. */
export function feedFloor(
  feed: Pick<ChannelFeedDoc, "seq" | "issuedAt">,
): FeedFloor {
  return { seq: feed.seq, issuedAt: feed.issuedAt };
}

/** One committed feed that survived the reload path. */
export interface CommittedFeed {
  /** The compact JWS, verbatim, as the cache holds it. */
  jws: string;
  feed: ChannelFeedDoc;
}

export interface ReloadedFeeds {
  /** The survivors, keyed by canonical channel. */
  feeds: Record<string, CommittedFeed>;
  /** `floors[k] = feedFloor(feeds[k])`: what `verifyFeed` reads at step 8. Never persisted. */
  floors: Record<string, FeedFloor>;
}

/**
 * The reload path (plans/P3-01.md §2.5, "Reload path"): every `feeds[k]` of the cache goes
 * through steps 3–6 with `k` as the requested name, no freshness and no floor, and its claim must
 * equal `k`. Each survivor gives `floors[k]`; anything that fails is absent, so a committed feed
 * whose key left the effective trust set is dropped together with its floor. Run on cache load
 * and again whenever the effective trust set changes. Never throws.
 */
export async function reloadFeeds(
  cached: Readonly<Record<string, string>> | undefined,
  opts: { trust: TrustSet; expectedAud: string; platform: string },
): Promise<ReloadedFeeds> {
  const out: ReloadedFeeds = { feeds: {}, floors: {} };
  if (!isObject(cached)) return out;
  for (const [k, jws] of Object.entries(cached)) {
    if (typeof jws !== "string") continue;
    const r = await verifyFeed(jws, {
      trust: opts.trust,
      expectedAud: opts.expectedAud,
      channel: k,
      platform: opts.platform,
      checkFreshness: false,
    });
    if (!r.ok || r.feed.channel !== k) continue;
    out.feeds[k] = { jws, feed: r.feed };
    out.floors[k] = feedFloor(r.feed);
  }
  return out;
}

/**
 * Step 9's write, as a pure function over the `feeds` slice: `feeds[claim] = jws`, and when the
 * claim is not the requested name (an alias answer) the same write removes `feeds[requested]`.
 * Every other entry stays. Returns a new map; the input is not modified.
 */
export function commitFeed(
  feeds: Readonly<Record<string, string>>,
  opts: { requested: string; claim: string; jws: string },
): Record<string, string> {
  const next: Record<string, string> = {};
  for (const [k, v] of Object.entries(feeds)) next[k] = v;
  if (opts.claim !== opts.requested) delete next[opts.requested];
  next[opts.claim] = opts.jws;
  return next;
}

/** The keys a request binds to (step 5): the requested name and, when it is an alias, its
 *  target. Only the comparison of step 2 and §2.5's fallback order use this; no key, floor or
 *  decision channel is ever chosen through it. */
export function boundChannels(requested: string): string[] {
  const alias = has(CHANNEL_ALIASES, requested)
    ? CHANNEL_ALIASES[requested as keyof typeof CHANNEL_ALIASES]
    : undefined;
  return alias === undefined || alias === requested
    ? [requested]
    : [requested, alias];
}
