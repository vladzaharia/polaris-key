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
 * A new row starts at 1, or at `MAX_WIRE_INTEGER` when the product's ceiling flag
 * (`update_feed_ceiling`, written by the `feed:seq-ceiling` recovery script) is set. At the
 * ceiling a change of content re-signs at the ceiling with a newer `issuedAt`, which clients
 * accept (§2.5 step 8), and is logged.
 *
 * ── what is never signed ────────────────────────────────────────────────────────────────────
 *
 * The composer's document is checked with `feedClaims` (the claims every v4 SDK runs) and
 * `scanStrictJson` before signing. A document that fails, or a per-platform document over the
 * 65 536-byte payload cap, is not signed: `500 feed_not_composable`. Every SDK would refuse it.
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
  type FeedTarget,
} from "@polaris-key/protocol/update";
import { scanStrictJson } from "@polaris-key/jws";
import { feedClaims } from "@polaris-key/client-core/feed";
import type { ServiceContext } from "../../core/registry.js";
import type { Db } from "../../core/platform.js";
import { appSecurityHeaders } from "../../core/platform.js";
import { errorResponse, wireError } from "../../core/errors.js";
import { clientIp, rateLimitOk } from "../../core/rateLimit.js";
import { signDoc } from "../../core/signing.js";
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

/** A stored document older than this is re-signed (half the 900 s TTL). */
export const RESIGN_AFTER_SECONDS = 450;
/** The payload cap every v4 verifier applies (WIRE-CONTRACT-V4 §2.3). */
export const MAX_FEED_PAYLOAD_BYTES = 65536;
/** A feed is polled, not walked; one composition is a handful of D1 reads. */
const FEED_RATE_LIMIT = { limit: 60, windowSec: 60 } as const;

const PUBLIC_FEED_CACHE = "public, max-age=60, no-transform";
const GATED_FEED_CACHE = "private, no-store, no-transform";

const enc = new TextEncoder();

async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", enc.encode(text));
  return [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

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

/** The selector key a stored document is filed under. */
export function selectorKey(platform: string | null): string {
  return platform === null ? "" : `platform=${platform}`;
}

function feedPayload(
  product: string,
  composed: ComposedFeed,
  platform: string | null,
  targets: FeedTarget[],
  seq: number,
  now: number,
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
  };
}

/**
 * The composer's self-check: the claims every v4 SDK runs (with the canonical channel as the
 * requested name), the strict JSON profile, and the payload cap. `false` = never sign it.
 */
export function feedSelfCheck(
  doc: ChannelFeedDoc,
  platform: string | null,
): boolean {
  const text = JSON.stringify(doc);
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

/** The document to sign for a request: the channel-wide one while it fits, else the platform's. */
function documentFor(
  product: string,
  composed: ComposedFeed,
  platform: string,
  seq: number,
  now: number,
): { doc: ChannelFeedDoc; platform: string | null } {
  const wide = feedPayload(product, composed, null, composed.targets, seq, now);
  if (enc.encode(JSON.stringify(wide)).byteLength <= MAX_FEED_PAYLOAD_BYTES)
    return { doc: wide, platform: null };
  return {
    doc: feedPayload(
      product,
      composed,
      platform,
      composed.targets.filter((t) => t.platform === platform),
      seq,
      now,
    ),
    platform,
  };
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
      { bucket: "updateFeed", id: clientIp(req), ...FEED_RATE_LIMIT },
      now,
    ))
  )
    return harden(errorResponse(429, "rate_limited", "too many feed requests"));
  const gated = accessModeFor(artifactPolicy(cfg), "feed") !== "public";

  const composed = await composeChannelFeed(
    { db, product: product.slug, hooks: ctx.hooks, cfg },
    requested,
  );
  if (!composed) return null;

  const contentSha256 = await sha256Hex(
    canonicalDescriptorJson({
      channel: composed.channel,
      versionScheme: composed.versionScheme,
      targets: composed.targets,
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
  if (state.bumped && state.atCeiling)
    console.log(
      JSON.stringify({
        event: "update.feed.ceiling",
        product: product.slug,
        channel: composed.channel,
        seq: state.seq,
      }),
    );

  // Which document this request gets, and whether the stored copy of it is current.
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
    if (!feedSelfCheck(probe.doc, probe.platform)) return notComposable();
    jws = await signDoc(
      probe.doc,
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
