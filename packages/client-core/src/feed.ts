// The channel feed's claims — WIRE-CONTRACT-V4 §2.3 and client steps 4–6 (plans/P3-01.md
// §2.3, §2.5). Pure and synchronous; it never throws. P3-02 lands `feedClaims`, which P3-03's
// composer runs on every document before signing it; P3-05 adds `verifyFeed` and the floor
// around it.
//
// Every pattern matches the whole string (JavaScript with no flags), every length counts UTF-8
// bytes, a required member must be present (`floor` and `live` may be `null`, never missing),
// and an optional member is absent or of its type (a present `null` is refused). Every integer
// field is an integer claim, checked at its RFC 6901 pointer.

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
} from "@polaris-key/protocol/update";
import { NO_NON_WIRE_INTEGERS, isWireInteger } from "./claims.js";
import { compareVersions, parseVersion } from "./version.js";

export interface FeedClaimsOptions {
  /** The product: `aud` must equal it. */
  expectedAud: string;
  /** The channel name the client REQUESTED (it may be an alias). */
  channel: string;
  /** The client's platform; when given, a `selector.platform` must equal it. */
  platform?: string;
  /** The verified payload's `nonWireIntegers`; omit when checking an object you built. */
  nonWire?: ReadonlySet<string>;
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
  nonWire: ReadonlySet<string>,
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
