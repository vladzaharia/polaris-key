// Reference: the feed's claims (V4 §2.3) and the `feedCases` verdict.
//
// The generator's independent reference implementation, restated from the spec rather than
// taken from client-core or an SDK: the family modules recompute every verdict through it.

import {
  CLOCK_SKEW,
  ISSUER_V3,
  MAX_FEED_TTL_REF,
  pointerToken,
  ROLLOUT_BUCKETS_REF,
  utf8Bytes,
} from "../common.js";
import { type ClaimCtx, ctxOf, hasOwn, isObj, refInt } from "./claims.js";
import { refVerifyJws } from "./jws.js";
import {
  CAP_BOOLS,
  REF_BINARY_ORDER,
  REF_LISTING_PREFIXES,
  REF_OUTLET_ID_RE,
  REF_OUTLET_KINDS,
} from "./outlet.js";
import {
  REF_CHANNEL_RE,
  REF_FEED_PLATFORM_RE,
  REF_SALT_RE,
  REF_SHA256_RE,
} from "./patterns.js";
import {
  REF_SCHEMES,
  refCompareVersions,
  refParseVersion,
} from "./versions.js";

// ── The feed's and the record's claims (V4 §2.3, §2.4), the generator's own ──────────────────

const REF_CHANNEL_ALIASES: Record<string, string> = {
  staging: "beta",
  latest: "stable",
};

function refFeedClaimsOk(
  doc: Record<string, unknown>,
  ctx: ClaimCtx,
  aud: string,
): boolean {
  const f = "feed";
  if (
    !refInt(ctx, f, doc.schemaVersion, "/schemaVersion") ||
    doc.schemaVersion !== 1
  )
    return false;
  if (doc.iss !== ISSUER_V3 || doc.aud !== aud) return false;
  if (typeof doc.channel !== "string" || !REF_CHANNEL_RE.test(doc.channel))
    return false;
  if (!isObj(doc.selector)) return false;
  const sel = doc.selector;
  if (hasOwn(sel, "platform") && typeof sel.platform !== "string") return false;
  if (!refInt(ctx, f, doc.seq, "/seq")) return false;
  if (!refInt(ctx, f, doc.issuedAt, "/issuedAt")) return false;
  if (!refInt(ctx, f, doc.expiresAt, "/expiresAt")) return false;
  const [iat, exp] = [doc.issuedAt as number, doc.expiresAt as number];
  if (!(iat < exp) || exp > iat + MAX_FEED_TTL_REF) return false;
  if (!isObj(doc.app)) return false;
  const app = doc.app;
  if (app.deliverable !== "app") return false;
  const scheme = app.versionScheme;
  if (
    typeof scheme !== "string" ||
    !(REF_SCHEMES as readonly string[]).includes(scheme)
  )
    return false;
  const ver = (v: unknown): boolean => refParseVersion(scheme, v) !== null;
  if (!Array.isArray(app.targets)) return false;
  const seen = new Set<string>();
  for (const [i, t] of app.targets.entries()) {
    const at = `/app/targets/${i}`;
    if (!isObj(t)) return false;
    if (
      typeof t.platform !== "string" ||
      !REF_FEED_PLATFORM_RE.test(t.platform)
    )
      return false;
    if (seen.has(t.platform)) return false;
    seen.add(t.platform);
    if (hasOwn(sel, "platform") && t.platform !== sel.platform) return false;
    const r = t.release;
    if (
      !isObj(r) ||
      typeof r.sha256 !== "string" ||
      !REF_SHA256_RE.test(r.sha256)
    )
      return false;
    if (!refInt(ctx, f, r.seq, `${at}/release/seq`) || !ver(r.version))
      return false;
    if (!hasOwn(t, "floor")) return false;
    if (t.floor !== null) {
      if (!isObj(t.floor) || !ver(t.floor.minVersion)) return false;
      const c = refCompareVersions(scheme, t.floor.minVersion, r.version);
      if (c === null || c > 0) return false;
    }
    if (typeof t.critical !== "boolean") return false;
    if (!isObj(t.outlets)) return false;
    for (const [id, e] of Object.entries(t.outlets)) {
      const ep = `${at}/outlets/${pointerToken(id)}`;
      if (!REF_OUTLET_ID_RE.test(id) || !isObj(e)) return false;
      if (
        typeof e.kind !== "string" ||
        !REF_OUTLET_ID_RE.test(e.kind) ||
        e.kind === "unknown"
      )
        return false;
      if (!hasOwn(e, "live")) return false;
      if (e.live !== null) {
        if (!isObj(e.live) || !ver(e.live.version)) return false;
        if (!refInt(ctx, f, e.live.seq, `${ep}/live/seq`)) return false;
      }
      if (typeof e.halted !== "boolean") return false;
      if (hasOwn(e, "rollout")) {
        const ro = e.rollout;
        if (!isObj(ro) || !refInt(ctx, f, ro.bp, `${ep}/rollout/bp`))
          return false;
        if ((ro.bp as number) > ROLLOUT_BUCKETS_REF) return false;
        if (typeof ro.salt !== "string" || !REF_SALT_RE.test(ro.salt))
          return false;
      }
      if (hasOwn(e, "listingUrl")) {
        const url = e.listingUrl;
        if (typeof url !== "string") return false;
        if ((REF_OUTLET_KINDS as readonly string[]).includes(e.kind)) {
          const bytes = utf8Bytes(url);
          if (bytes.length < 1 || bytes.length > 2048) return false;
          if (bytes.some((b) => b < 0x21 || b > 0x7e)) return false;
          if (
            !(REF_LISTING_PREFIXES[e.kind] ?? []).some((p) => url.startsWith(p))
          )
            return false;
        }
      }
      if (hasOwn(e, "capabilities")) {
        const c = e.capabilities;
        if (!isObj(c)) return false;
        if (
          hasOwn(c, "binaryUpdates") &&
          !REF_BINARY_ORDER.includes(c.binaryUpdates as string)
        )
          return false;
        for (const k of CAP_BOOLS)
          if (hasOwn(c, k) && typeof c[k] !== "boolean") return false;
        if (
          hasOwn(c, "commerce") &&
          !["own", "store-iap", "steam", "none"].includes(c.commerce as string)
        )
          return false;
      }
    }
  }
  return true;
}

/** Client steps 4–6 (plans/P3-01.md §2.5): claims, channel binding, selector. */
export function refFeedClaims(
  doc: unknown,
  ctx: ClaimCtx,
  o: { aud: string; channel: string; platform?: string },
): "claims" | "channel" | "selector" | null {
  if (!isObj(doc) || !refFeedClaimsOk(doc, ctx, o.aud)) return "claims";
  const claim = doc.channel as string;
  if (claim === "latest") return "channel";
  if (claim !== o.channel && claim !== REF_CHANNEL_ALIASES[o.channel])
    return "channel";
  const sel = doc.selector as Record<string, unknown>;
  if (Object.keys(sel).some((k) => k !== "platform")) return "selector";
  if (
    hasOwn(sel, "platform") &&
    o.platform !== undefined &&
    sel.platform !== o.platform
  )
    return "selector";
  return null;
}

export interface FeedCase {
  id: string;
  description: string;
  jws: string;
  trust: Record<string, string>;
  expectedAud: string;
  channel: string;
  platform: string;
  now: number;
  checkFreshness: boolean;
  floors?: Record<string, { seq: number; issuedAt: number }>;
  nonWireIntegers?: string[];
  expect:
    | { verify: "ok"; seq: number; issuedAt: number; doc?: unknown }
    | {
        verify: "fail";
        reason:
          | "jws"
          | "claims"
          | "channel"
          | "selector"
          | "freshness"
          | "not-newer"
          | "rollback";
      };
}

/** V4 §2.5 steps 3–8, from first principles. */
export function refVerifyFeedCase(c: FeedCase): FeedCase["expect"] {
  const v = refVerifyJws(c.jws, c.trust, "pkey-feed+jws");
  if (!v) return { verify: "fail", reason: "jws" };
  const r = refFeedClaims(v.payload, ctxOf(v.text), {
    aud: c.expectedAud,
    channel: c.channel,
    platform: c.platform,
  });
  if (r) return { verify: "fail", reason: r };
  const d = v.payload as {
    channel: string;
    seq: number;
    issuedAt: number;
    expiresAt: number;
  };
  if (c.checkFreshness) {
    if (d.issuedAt > c.now + CLOCK_SKEW || d.expiresAt <= c.now - CLOCK_SKEW)
      return { verify: "fail", reason: "freshness" };
  }
  const floor = c.floors?.[d.channel];
  if (floor) {
    if (d.seq < floor.seq) return { verify: "fail", reason: "rollback" };
    if (d.seq === floor.seq && d.issuedAt <= floor.issuedAt)
      return { verify: "fail", reason: "not-newer" };
  }
  return { verify: "ok", seq: d.seq, issuedAt: d.issuedAt };
}
