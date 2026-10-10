/// <reference types="@cloudflare/workers-types" />

/**
 * `GET /<product>/update/<channel>/feed.jws?platform=<platform>` — the signed channel feed,
 * `pkey-feed+jws` (P3-03, plans/P3-01.md §2.3, §6; WIRE-CONTRACT-V4 §2.3).
 *
 * The Worker signs WHICH and WHEN; CI signs WHAT EXISTS (the release records the targets pin).
 * Every caller of a channel gets the same bytes: the document holds nothing device-specific, it
 * is stored per (product, canonical channel, selector key) in `update_feed_docs` and served to
 * every data centre from there. A request re-signs only when the composed content's SHA-256
 * changed, or the stored copy is `RESIGN_AFTER_SECONDS` old.
 *
 * ── seq ─────────────────────────────────────────────────────────────────────────────────────
 *
 * One `seq` per (product, canonical channel) in `update_feed_state`, shared by every selector
 * document of the channel, so switching selectors never evades a client's floor. It moves only
 * when the content's hash changes, in one conditional write, to `min(seq + 1, MAX_WIRE_INTEGER)`.
 * A channel with no targets and no row is signed at the starting seq and stores nothing (no row,
 * no document), so unused channel names cost no storage.
 * A new row starts at 1, or at `MAX_WIRE_INTEGER` when the product's ceiling flag
 * (`update_feed_ceiling`, written by the `feed:seq-ceiling` recovery script) is set. At the
 * ceiling a change of content re-signs at the ceiling with a newer `issuedAt`, which clients
 * accept (§2.5 step 8), and is recorded in the audit trail (`update.feed.ceiling`).
 *
 * ── what is never signed ────────────────────────────────────────────────────────────────────
 *
 * The composer's document is checked with `feedClaims` (the claims every v4 SDK runs) and
 * `scanStrictJson` before signing. A document that fails, or a per-platform document over the
 * 65 536-byte payload cap, is not signed: `500 feed_not_composable`. Every SDK would refuse it.
 * P4-13's content members are checked with `feedContent` first and shed before the 500 in the
 * fixed order of `documentFor`, so content alone never makes a feed uncomposable. P4-29's delta
 * menu (`feedDeltas.ts`) is added last, only into the room left under the cap.
 *
 * ── access ──────────────────────────────────────────────────────────────────────────────────
 *
 * The release METADATA mode. Under `entitled` the licence's entitlements must hold the CANONICAL
 * channel, checked per request before the stored body is returned. `public` is
 * `public, max-age=60, no-transform`; anything else `private, no-store, no-transform`.
 */

import {
  canonicalDescriptorJson,
  RELEASE_PLATFORMS,
} from "@polaris-key/manifest";
import { ISSUER, MAX_WIRE_INTEGER } from "@polaris-key/protocol/core";
import {
  FEED_TTL_SECONDS,
  type ChannelFeedDoc,
  type FeedPackFloor,
  type FeedPackSets,
  type FeedRevocation,
  type FeedTarget,
} from "@polaris-key/protocol/update";
import { scanStrictJson } from "@polaris-key/jws";
import { feedClaims, feedContent } from "@polaris-key/client-core/feed";
import type { ServiceContext } from "../../core/registry.js";
import { appSecurityHeaders } from "../../securityHeaders.js";
import { randomId } from "../../crypto.js";
import { sha256Hex } from "../../platform/hash.js";
import type { Db } from "../../db/types.js";
import { errorResponse, wireError } from "../../core/errors.js";
import { clientNetwork, rateLimitOk } from "../../core/rateLimit.js";
import { signDoc } from "../../core/signing.js";
import { appendAudit } from "../../repo.js";
import {
  accessModeFor,
  artifactPolicy,
  getReleaseConfig,
} from "../release/config.js";
import { enforceReleaseAccess } from "../release/access.js";
import {
  canonicalFeedChannel,
  composeChannelFeed,
  type ComposedFeed,
} from "./compose.js";
import {
  deltasHashPart,
  menuEntries,
  menuMember,
  menuRecords,
  rankFeedDeltas,
} from "./feedDeltas.js";
import type { ServiceHooks } from "../../core/hooks.js";

/** A stored document older than this is re-signed (half the 900 s TTL). */
export const RESIGN_AFTER_SECONDS = 450;
/** The payload cap every v4 verifier applies (WIRE-CONTRACT-V4 §2.3). */
export const MAX_FEED_PAYLOAD_BYTES = 65536;
/** A feed is polled, not walked; one composition is a handful of D1 reads. */
const FEED_RATE_LIMIT = { limit: 60, windowSec: 60 } as const;

const PUBLIC_FEED_CACHE = "public, max-age=60, no-transform";
const GATED_FEED_CACHE = "private, no-store, no-transform";

const enc = new TextEncoder();

function harden(res: Response): Response {
  return new Response(res.body, {
    status: res.status,
    headers: appSecurityHeaders(new Headers(res.headers)),
  });
}

/** `update_feed_state`. */
interface FeedStateRow {
  seq: number;
  content_sha256: string;
}

/** `update_feed_docs`. */
interface FeedDocRow {
  seq: number;
  content_sha256: string;
  jws: string;
  signed_at: number;
}

/**
 * The channel's `seq` for this content: the stored one when the content is unchanged, else the
 * next one (`min(seq + 1, MAX_WIRE_INTEGER)`), in one conditional write each. A new row starts at
 * 1, or at the ceiling when the product's ceiling flag is set. Returns `null` when concurrent
 * writers kept moving the row (the caller answers 503).
 */
export async function feedSeqFor(
  db: Db,
  product: string,
  channel: string,
  contentSha256: string,
): Promise<{ seq: number; bumped: boolean; atCeiling: boolean } | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const row = await db.first<FeedStateRow>(
      "SELECT seq, content_sha256 FROM update_feed_state WHERE product = ? AND channel = ?",
      product,
      channel,
    );
    if (!row) {
      await db.run(
        `INSERT INTO update_feed_state (product, channel, seq, content_sha256)
         SELECT ?, ?,
                CASE WHEN EXISTS (SELECT 1 FROM update_feed_ceiling WHERE product = ?)
                     THEN ? ELSE 1 END,
                ?
         WHERE 1
         ON CONFLICT (product, channel) DO NOTHING`,
        product,
        channel,
        product,
        MAX_WIRE_INTEGER,
        contentSha256,
      );
      continue;
    }
    if (row.content_sha256 === contentSha256)
      return {
        seq: row.seq,
        bumped: false,
        atCeiling: row.seq >= MAX_WIRE_INTEGER,
      };
    const changed = await db.runChanges(
      `UPDATE update_feed_state
          SET seq = MIN(seq + 1, ?), content_sha256 = ?
        WHERE product = ? AND channel = ? AND seq = ? AND content_sha256 = ?`,
      MAX_WIRE_INTEGER,
      contentSha256,
      product,
      channel,
      row.seq,
      row.content_sha256,
    );
    if (changed > 0) {
      const seq = Math.min(row.seq + 1, MAX_WIRE_INTEGER);
      return { seq, bumped: true, atCeiling: row.seq >= MAX_WIRE_INTEGER };
    }
  }
  return null;
}

/**
 * The `seq` a channel WITHOUT a state row is signed at, read-only: 1, or the ceiling when the
 * product's ceiling flag is set — exactly where `feedSeqFor` would start the row.
 */
export async function startingFeedSeq(
  db: Db,
  product: string,
): Promise<number> {
  const flag = await db.first<{ one: number }>(
    "SELECT 1 AS one FROM update_feed_ceiling WHERE product = ?",
    product,
  );
  return flag ? MAX_WIRE_INTEGER : 1;
}

/** The selector key a stored document is filed under. */
export function selectorKey(platform: string | null): string {
  return platform === null ? "" : `platform=${platform}`;
}

/** The content members one document carries (each absent when null). */
export interface FeedContentPart {
  packSets: FeedPackSets | null;
  packFloors: FeedPackFloor[] | null;
  revocations: FeedRevocation[] | null;
}

const NO_CONTENT: FeedContentPart = {
  packSets: null,
  packFloors: null,
  revocations: null,
};

function feedPayload(
  product: string,
  composed: ComposedFeed,
  platform: string | null,
  targets: FeedTarget[],
  seq: number,
  now: number,
  content: FeedContentPart = NO_CONTENT,
): ChannelFeedDoc {
  return {
    schemaVersion: 1,
    iss: ISSUER,
    aud: product,
    channel: composed.channel,
    selector: platform === null ? {} : { platform },
    seq,
    issuedAt: now,
    expiresAt: now + FEED_TTL_SECONDS,
    app: {
      deliverable: "app",
      versionScheme: composed.versionScheme,
      targets,
    },
    ...(content.packSets ? { packSets: content.packSets } : {}),
    ...(content.packFloors ? { packFloors: content.packFloors } : {}),
    ...(content.revocations ? { revocations: content.revocations } : {}),
  };
}

/**
 * Work counters for building a document to sign, test hooks (P1-13's pattern): every
 * whole-document serialization here (a size measure, a read-back through `feedContent`, the
 * self-check) adds one to `serializations` and its length to `chars`. They are the dominant cost
 * of `documentFor`; the CPU-budget checks diff them around a call instead of reading a clock, so
 * they hold on a machine of any speed or load.
 */
export const feedDocWork = { serializations: 0, chars: 0 };

/** `JSON.stringify(doc)`, counted in {@link feedDocWork}. */
function serialize(doc: ChannelFeedDoc): string {
  const text = JSON.stringify(doc);
  feedDocWork.serializations++;
  feedDocWork.chars += text.length;
  return text;
}

/**
 * The composer's self-check: the claims every v4 SDK runs (with the canonical channel as the
 * requested name), the strict JSON profile, and the payload cap. `false` = never sign it.
 */
export function feedSelfCheck(
  doc: ChannelFeedDoc,
  platform: string | null,
): boolean {
  const text = serialize(doc);
  if (enc.encode(text).byteLength > MAX_FEED_PAYLOAD_BYTES) return false;
  if (!scanStrictJson(text).ok) return false;
  return (
    feedClaims(JSON.parse(text) as unknown, {
      expectedAud: doc.aud,
      channel: doc.channel,
      ...(platform !== null ? { platform } : {}),
    }) === null
  );
}

const fits = (doc: ChannelFeedDoc): boolean =>
  enc.encode(serialize(doc)).byteLength <= MAX_FEED_PAYLOAD_BYTES;

/** One audit row a signing owes (P4-13's content shedding and omissions). */
export interface FeedAudit {
  action: string;
  summary: string;
}

/**
 * Keep only the content members client-core's `feedContent` reads as usable (the same parser every
 * v4 SDK runs); one that would read as unusable is omitted and audited, never signed.
 */
function usableContent(
  doc: ChannelFeedDoc,
  audits: FeedAudit[],
): ChannelFeedDoc {
  const parsed = feedContent(JSON.parse(serialize(doc)) as unknown);
  const out = { ...doc };
  for (const key of ["packSets", "packFloors", "revocations"] as const)
    if (out[key] !== undefined && parsed[key] === null) {
      delete out[key];
      audits.push({
        action:
          key === "packSets"
            ? "update.feed.packs_omitted"
            : key === "packFloors"
              ? "update.feed.floors_omitted"
              : "update.feed.revocations_omitted",
        summary: `The ${doc.channel} feed's ${key} would read as unusable (feedContent) and was left out.`,
      });
    }
  return out;
}

/**
 * P4-29 (plans/P4-29.md §6.2): add the delta menu to a document already chosen and shed, in rank
 * order while the payload stays within the cap, trimming the lowest-ranked entries first
 * (`update.feed.deltas_trimmed`, or `update.feed.deltas_omitted` when none fit). The menu is read
 * back with `feedContent` before signing; one that would read as unusable is omitted and audited.
 * It never changes which document is signed and never sheds a P4-13 member.
 */
function withDeltaMenu(
  doc: ChannelFeedDoc,
  composed: ComposedFeed,
  platform: string | null,
  audits: FeedAudit[],
): ChannelFeedDoc {
  const d = composed.menu;
  if (!d || d.candidates.length === 0) return doc;
  const list = menuEntries(d, menuRecords(doc, d, platform));
  if (list.length === 0) return doc;
  const build = (n: number): ChannelFeedDoc => ({
    ...doc,
    deltas: menuMember(list.slice(0, n)),
  });
  const where = platform === null ? "" : ` for ${platform}`;
  // The payload grows with every entry: the largest prefix that fits, by bisection.
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fits(build(mid))) lo = mid;
    else hi = mid - 1;
  }
  if (lo === 0) {
    audits.push({
      action: "update.feed.deltas_omitted",
      summary: `The ${composed.channel} feed${where} has no room under ${MAX_FEED_PAYLOAD_BYTES} bytes for its ${list.length} delta menu entries; the menu was left out.`,
    });
    return doc;
  }
  if (lo < list.length)
    audits.push({
      action: "update.feed.deltas_trimmed",
      summary: `The ${composed.channel} feed${where} lists ${lo} of ${list.length} delta menu entries; the lowest-ranked were left out to stay under ${MAX_FEED_PAYLOAD_BYTES} bytes.`,
    });
  const out = build(lo);
  if (feedContent(JSON.parse(serialize(out)) as unknown).deltas === null) {
    audits.push({
      action: "update.feed.deltas_omitted",
      summary: `The ${composed.channel} feed's delta menu would read as unusable (feedContent) and was left out.`,
    });
    return doc;
  }
  return out;
}

/** The per-platform content part: its rows, only the sets and releases they reference, every
 *  floor and revocation, and the outlets of its own target (with only the gates its rows' releases
 *  key, and their fallbacks). */
function platformContent(
  content: FeedContentPart,
  platform: string,
  target: FeedTarget | undefined,
): FeedContentPart {
  let packSets: FeedPackSets | null = null;
  if (content.packSets) {
    const rows = content.packSets.rows.filter((r) => r.platform === platform);
    if (rows.length > 0) {
      const sets: FeedPackSets["sets"] = {};
      const releases: FeedPackSets["releases"] = {};
      for (const r of rows) {
        const members = content.packSets.sets[r.set] ?? [];
        sets[r.set] = members;
        for (const h of members) releases[h] = content.packSets.releases[h]!;
      }
      packSets = { releases, sets, rows };
      const outlets: NonNullable<FeedPackSets["outlets"]> = {};
      for (const [id, o] of Object.entries(content.packSets.outlets ?? {})) {
        if (!target || !Object.hasOwn(target.outlets, id)) continue;
        // P4-14's gates: only those keyed by a release this platform's rows offer, each with its
        // fallback carried into `releases` (a gate's keys and fallbacks must be keys there).
        const { gates, ...rest } = o;
        const kept: NonNullable<typeof gates> = {};
        for (const [h, g] of Object.entries(gates ?? {})) {
          if (!Object.hasOwn(releases, h)) continue;
          kept[h] = g;
          if (g.fallback !== null)
            releases[g.fallback] = content.packSets.releases[g.fallback]!;
        }
        const entry =
          Object.keys(kept).length > 0 ? { ...rest, gates: kept } : rest;
        if (Object.keys(entry).length > 0) outlets[id] = entry;
      }
      if (Object.keys(outlets).length > 0) packSets.outlets = outlets;
    }
  }
  return {
    packSets,
    packFloors: content.packFloors,
    revocations: content.revocations,
  };
}

/**
 * The document to sign for a request (plans/P4-13.md §6.3, decision 13): the channel-wide one while
 * it fits; else the platform's; and when that is still over the cap, content is shed in a fixed
 * order, re-measuring after each step and auditing each: 1. omit `packSets` (devices keep their
 * content), 2. omit `packFloors`, 3. keep only the referenced revocations, 4. omit `revocations`
 * (devices keep what they stored). With all three gone the document is P3-03's, so content can
 * never cause `feed_not_composable` on its own. `audits` is what a signing of it owes.
 */
export function documentFor(
  product: string,
  composed: ComposedFeed,
  platform: string,
  seq: number,
  now: number,
): { doc: ChannelFeedDoc; platform: string | null; audits: FeedAudit[] } {
  const audits: FeedAudit[] = [...composed.content.audits];
  const content: FeedContentPart = {
    packSets: composed.content.packSets,
    packFloors: composed.content.packFloors,
    revocations: composed.content.revocations,
  };
  const wide = usableContent(
    feedPayload(product, composed, null, composed.targets, seq, now, content),
    audits,
  );
  if (fits(wide))
    return {
      doc: withDeltaMenu(wide, composed, null, audits),
      platform: null,
      audits,
    };
  const targets = composed.targets.filter((t) => t.platform === platform);
  const part = platformContent(content, platform, targets[0]);
  const build = (): ChannelFeedDoc =>
    usableContent(
      feedPayload(product, composed, platform, targets, seq, now, part),
      audits,
    );
  let doc = build();
  const shed = (action: string, summary: string): void => {
    audits.push({ action, summary });
    doc = build();
  };
  if (!fits(doc) && part.packSets) {
    part.packSets = null;
    shed(
      "update.feed.packs_omitted",
      `The ${composed.channel} feed for ${platform} is over ${MAX_FEED_PAYLOAD_BYTES} bytes; packSets was left out.`,
    );
  }
  if (!fits(doc) && part.packFloors) {
    part.packFloors = null;
    shed(
      "update.feed.floors_omitted",
      `The ${composed.channel} feed for ${platform} is over ${MAX_FEED_PAYLOAD_BYTES} bytes; packFloors was left out.`,
    );
  }
  if (!fits(doc) && part.revocations) {
    const referenced = composed.content.referenced;
    const kept = part.revocations.filter((r) => referenced.has(r.record));
    if (kept.length < part.revocations.length) {
      part.revocations = kept.length > 0 ? kept : null;
      shed(
        "update.feed.revocations_trimmed",
        `The ${composed.channel} feed for ${platform} is over ${MAX_FEED_PAYLOAD_BYTES} bytes; only the referenced revocations were kept.`,
      );
    }
  }
  if (!fits(doc) && part.revocations) {
    part.revocations = null;
    shed(
      "update.feed.revocations_omitted",
      `The ${composed.channel} feed for ${platform} is over ${MAX_FEED_PAYLOAD_BYTES} bytes; revocations was left out (devices keep the revocations they stored).`,
    );
  }
  return {
    doc: withDeltaMenu(doc, composed, platform, audits),
    platform,
    audits,
  };
}

/**
 * P4-29: the composed feed with its ranked menu, for signing. The device counts behind the rank
 * are read here, on the sign path only — the seq hash covers the candidate set, never the rank, so
 * a request served from the stored copy reads none. A failure lists no menu, audited; it never
 * fails a feed. The menu never changes which document is chosen, so `documentFor` over the result
 * picks the same platform as over `composed`.
 */
export async function withRankedMenu(
  hooks: ServiceHooks,
  composed: ComposedFeed,
): Promise<ComposedFeed> {
  const d = composed.deltas;
  if (!d || d.candidates.length === 0) return composed;
  try {
    return { ...composed, menu: await rankFeedDeltas(hooks, d) };
  } catch (e) {
    return {
      ...composed,
      menu: null,
      content: {
        ...composed.content,
        audits: [
          ...composed.content.audits,
          {
            action: "update.feed.deltas_omitted",
            summary:
              `The ${composed.channel} feed's delta menu could not be ranked and was left out: ${e instanceof Error ? e.message : String(e)}`.slice(
                0,
                1000,
              ),
          },
        ],
      },
    };
  }
}

function notComposable(): Response {
  return harden(wireError(500, "feed_not_composable"));
}

export async function handleFeedRoute(
  ctx: ServiceContext,
  requested: string,
): Promise<Response | null> {
  const { req, env, db, product, now } = ctx;
  if (req.method !== "GET" && req.method !== "HEAD") return null;
  const platform = new URL(req.url).searchParams.get("platform");
  if (
    platform === null ||
    !(RELEASE_PLATFORMS as readonly string[]).includes(platform)
  )
    return null;
  const cfg = await getReleaseConfig(db, product.slug);
  if (!cfg) return null;
  const channel = canonicalFeedChannel(requested, cfg);
  if (channel === null) return null;

  // Access before any composition: the metadata mode; under `entitled`, the canonical channel's
  // grant, checked per request before the stored body is served.
  const refused = await enforceReleaseAccess(
    req,
    env,
    db,
    product,
    cfg,
    "feed",
    { channel },
    now,
  );
  if (refused) return harden(refused);
  if (
    !(await rateLimitOk(
      env,
      product.slug,
      { bucket: "updateFeed", id: clientNetwork(req), ...FEED_RATE_LIMIT },
      now,
    ))
  )
    return harden(errorResponse(429, "rate_limited", "too many feed requests"));
  const gated = accessModeFor(artifactPolicy(cfg), "feed") !== "public";

  const composed = await composeChannelFeed(
    { db, product: product.slug, hooks: ctx.hooks, cfg, env },
    requested,
  );
  if (!composed) return null;

  // A channel that offers nothing and has never offered anything (no state row) — an unused
  // `pr-<n>` or manual channel, or a product with no app release yet — is signed at the seq a row
  // would start at, and NOTHING is stored: an unauthenticated caller choosing channel names must
  // not be able to grow `update_feed_state` / `update_feed_docs`. Step 8 accepts the channel's
  // first real document at that same seq, since its `issuedAt` is newer.
  if (composed.targets.length === 0) {
    const existing = await db.first<{ seq: number }>(
      "SELECT seq FROM update_feed_state WHERE product = ? AND channel = ?",
      product.slug,
      composed.channel,
    );
    if (!existing) {
      const empty = feedPayload(
        product.slug,
        composed,
        null,
        [],
        await startingFeedSeq(db, product.slug),
        now,
      );
      if (!feedSelfCheck(empty, null)) return notComposable();
      const signed = await signDoc(
        empty,
        product.signingKeyPem,
        product.signingKid,
        "pkey-feed+jws",
      );
      return feedResponse(req, signed, gated);
    }
  }

  // The content members join the hash only when present, so a product without content keeps
  // the hash (and the seq) it had before P4-13.
  const c = composed.content;
  const contentSha256 = await sha256Hex(
    canonicalDescriptorJson({
      channel: composed.channel,
      versionScheme: composed.versionScheme,
      targets: composed.targets,
      ...(c.packSets ? { packSets: c.packSets } : {}),
      ...(c.packFloors ? { packFloors: c.packFloors } : {}),
      ...(c.revocations ? { revocations: c.revocations } : {}),
      // P4-29: the menu's candidates, as a set (absent with no menu, so the hash is unchanged).
      ...(composed.deltas ? { deltas: deltasHashPart(composed.deltas) } : {}),
    }),
  );
  const state = await feedSeqFor(
    db,
    product.slug,
    composed.channel,
    contentSha256,
  );
  // Concurrent writers kept moving the row (three times over): nothing consistent to sign.
  if (!state) return notComposable();
  // At the ceiling a change of content re-signs at the ceiling with a newer `issuedAt`. The
  // Worker has no log sink (R12), so it is recorded in the product's audit trail.
  if (state.bumped && state.atCeiling)
    await appendAudit(db, {
      product: product.slug,
      id: randomId("aud"),
      at: now,
      actor_sub: "system:update-feed",
      actor_name: "Update feed",
      actor_email: null,
      action: "update.feed.ceiling",
      target_kind: "channel",
      target_id: composed.channel,
      parent_id: null,
      summary: `The ${composed.channel} feed changed at the seq ceiling and was re-signed at ${state.seq}`,
    });

  // Which document this request gets, and whether the stored copy of it is current. The probe
  // carries no delta menu (P4-29): the menu never changes the choice, and its rank is read only
  // when the document is actually signed.
  const probe = documentFor(product.slug, composed, platform, state.seq, now);
  const key = selectorKey(probe.platform);
  const stored = await db.first<FeedDocRow>(
    `SELECT seq, content_sha256, jws, signed_at FROM update_feed_docs
      WHERE product = ? AND channel = ? AND selector_key = ?`,
    product.slug,
    composed.channel,
    key,
  );
  let jws: string;
  if (
    stored &&
    stored.seq === state.seq &&
    stored.content_sha256 === contentSha256 &&
    now - stored.signed_at < RESIGN_AFTER_SECONDS &&
    stored.signed_at <= now
  ) {
    jws = stored.jws;
  } else {
    const signing = composed.deltas
      ? documentFor(
          product.slug,
          await withRankedMenu(ctx.hooks, composed),
          platform,
          state.seq,
          now,
        )
      : probe;
    if (!feedSelfCheck(signing.doc, signing.platform)) return notComposable();
    for (const a of signing.audits)
      await appendAudit(db, {
        product: product.slug,
        id: randomId("aud"),
        at: now,
        actor_sub: "system:update-feed",
        actor_name: "Update feed",
        actor_email: null,
        action: a.action,
        target_kind: "channel",
        target_id: composed.channel,
        parent_id: null,
        summary: a.summary,
      });
    jws = await signDoc(
      signing.doc,
      product.signingKeyPem,
      product.signingKid,
      "pkey-feed+jws",
    );
    // One conditional write: never replace a copy of a later seq, or a later signing.
    await db.run(
      `INSERT INTO update_feed_docs
         (product, channel, selector_key, seq, content_sha256, jws, signed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (product, channel, selector_key) DO UPDATE SET
         seq = excluded.seq, content_sha256 = excluded.content_sha256,
         jws = excluded.jws, signed_at = excluded.signed_at
       WHERE excluded.seq > update_feed_docs.seq
          OR (excluded.seq = update_feed_docs.seq
              AND excluded.signed_at >= update_feed_docs.signed_at)`,
      product.slug,
      composed.channel,
      key,
      state.seq,
      contentSha256,
      jws,
      now,
    );
  }

  return feedResponse(req, jws, gated);
}

function feedResponse(req: Request, jws: string, gated: boolean): Response {
  return harden(
    new Response(req.method === "HEAD" ? null : jws, {
      status: 200,
      headers: {
        "content-type": "application/jose",
        "cache-control": gated ? GATED_FEED_CACHE : PUBLIC_FEED_CACHE,
        "x-content-type-options": "nosniff",
        "content-length": String(jws.length),
      },
    }),
  );
}
