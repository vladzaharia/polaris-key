/// <reference types="@cloudflare/workers-types" />
/**
 * The Game Center verifier (I-14.6; WIRE-CONTRACT-V5 §12.11.7, plans/I-14.md §1).
 *
 * The client sends `gc1.<publicKeyURL>.<signature>.<salt>.<timestamp>.<teamPlayerID>.<bundleId>`
 * (every field but the timestamp is unpadded base64url over its bytes). It runs after the
 * exchange's nonce is spent, and every refusal is an `OidcVerifyError` that the caller answers
 * with the one `invalid_grant`. An unreachable key host, or a 5xx from it, is an
 * `OidcNetworkError` (`503 unavailable`).
 *
 *   1. The product has Game Center on, a team id and a bundle id among its Apple bundle ids.
 *   2. The token has the exact shape and sizes.
 *   3. The timestamp (Apple's, in milliseconds) is at most 120 s old and 30 s ahead.
 *   4. The key URL is an exact `static.gc.apple.com` `.cer` address.
 *   5. The certificate is fetched through a door of its own (https, no redirects, 16 KiB, 5 s),
 *      kept as DER for as long as Apple's `max-age` allows, and verified again on every use.
 *   6. The chain reaches a pinned root through a pinned intermediate; the leaf is RSA, issued to
 *      `Apple Inc.` for code signing, and valid now. The leaf itself is never pinned.
 *   7. The signature is RSASSA-PKCS1-v1_5 / SHA-256 over
 *      `teamPlayerID || bundleId || u64be(timestamp) || salt`.
 *   8. A signature is accepted once (180 s).
 *
 * The subject is `teamPlayerID` under the scope `apple-team:<teamId>`. The signed layout, the
 * hash and the timestamp unit follow open-source verifiers rather than an Apple statement; the
 * device run of I-44.5 confirms them before the launch gate turns on.
 */

import type { Env } from "../../../platform/env.js";
import { b64urlDecodeStrict } from "../../../platform/bytes.js";
import { sha256B64url } from "../../../platform/hash.js";
import { BodyTooLargeError, readBodyBytes } from "../../../core/cappedBody.js";
import { isRedirect } from "../../../core/readCapped.js";
import {
  OidcNetworkError,
  OidcVerifyError,
} from "../../../core/oidc/client.js";
import { artefactRef, putArtefact } from "../../../core/singleUse.js";
import {
  OID,
  X509Error,
  subjectAttributes,
  verifyChain,
} from "../../../core/trust/x509.js";
import {
  GAME_CENTER_MAX_AGE_SECONDS,
  GAME_CENTER_MAX_FUTURE_SECONDS,
  GAME_CENTER_TOKEN_PREFIX,
} from "@polaris-key/protocol/identity";
import type { PlatformSignInAudiences } from "../platformSignIn.js";
import { NATIVE_HOSTS, providerUrlProblem } from "./net.js";
import {
  GAME_CENTER_INTERMEDIATES,
  GAME_CENTER_ROOTS,
} from "./gameCenterAnchors.js";

/** The whole token, in characters. */
export const GAME_CENTER_TOKEN_MAX_CHARS = 4096;
/** The certificate answer, in bytes. */
export const GAME_CENTER_CERT_MAX_BYTES = 16 * 1024;
/** How long the certificate call may take. */
export const GAME_CENTER_FETCH_TIMEOUT_MS = 5_000;
/** How long a signature is remembered (the window plus slack). */
export const GAME_CENTER_SINGLE_USE_SECONDS = 180;
/** Freshness used when Apple's answer names no `max-age`. */
export const GAME_CENTER_CERT_DEFAULT_TTL_SECONDS = 300;
/** The longest a certificate is kept fresh, whatever `max-age` says. */
export const GAME_CENTER_CERT_MAX_TTL_SECONDS = 24 * 60 * 60;
/** How long past its freshness a kept certificate may stand in while the key host is down. */
export const GAME_CENTER_CERT_GRACE_SECONDS = 60 * 60;

const KEY_URL =
  /^https:\/\/static\.gc\.apple\.com\/public-key\/[A-Za-z0-9._-]{1,64}\.cer$/;
const TIMESTAMP = /^[1-9][0-9]{0,15}$/;
const BUNDLE_ID = /^[A-Za-z0-9.-]{1,155}$/;

export interface GameCenterIdentity {
  /** The link key's subject. */
  subject: string;
  /** The link key's scope: `apple-team:<teamId>`. */
  scope: string;
  bundleId: string;
}

/** A kept certificate: DER only, with the instants it is fresh and usable until. */
export interface CachedCert {
  der: Uint8Array;
  freshUntilMs: number;
  staleUntilMs: number;
}

export interface GameCenterCertCache {
  get(url: string): Promise<CachedCert | null>;
  put(url: string, cert: CachedCert): Promise<void>;
}

export interface GameCenterAnchors {
  roots: readonly Uint8Array[];
  intermediates: readonly Uint8Array[];
}

export interface GameCenterVerifyOpts {
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
  nowMs?: number;
  /** Defaults to an isolate memo over the Workers cache. */
  cache?: GameCenterCertCache;
  /** Tests only; defaults to the pinned DigiCert chain. */
  anchors?: GameCenterAnchors;
}

function refuse(): never {
  throw new OidcVerifyError("game center token refused");
}

function unavailable(): never {
  throw new OidcNetworkError("game center key host unavailable");
}

// ── the token ────────────────────────────────────────────────────────────────────────────────

interface ParsedToken {
  keyUrl: string;
  signature: Uint8Array;
  salt: Uint8Array;
  timestamp: number;
  teamPlayerID: string;
  bundleId: string;
}

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function text(field: string): string {
  const bytes = b64urlDecodeStrict(field);
  if (!bytes) refuse();
  try {
    return utf8.decode(bytes);
  } catch {
    return refuse();
  }
}

function parseToken(token: string): ParsedToken {
  if (typeof token !== "string" || token.length > GAME_CENTER_TOKEN_MAX_CHARS)
    refuse();
  const parts = token.split(".");
  if (parts.length !== 7 || parts[0] !== GAME_CENTER_TOKEN_PREFIX) refuse();
  const [, url, sig, salt, ts, player, bundle] = parts as [
    string,
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  const signature = b64urlDecodeStrict(sig);
  const saltBytes = b64urlDecodeStrict(salt);
  if (!signature || signature.length < 256 || signature.length > 1024) refuse();
  if (!saltBytes || saltBytes.length < 1 || saltBytes.length > 64) refuse();
  if (!TIMESTAMP.test(ts)) refuse();
  const timestamp = Number(ts);
  if (!Number.isSafeInteger(timestamp)) refuse();
  const teamPlayerID = text(player);
  // Printable ASCII, 1 to 256 bytes.
  if (!/^[\x20-\x7e]{1,256}$/.test(teamPlayerID)) refuse();
  const bundleId = text(bundle);
  if (!BUNDLE_ID.test(bundleId)) refuse();
  return {
    keyUrl: text(url),
    signature,
    salt: saltBytes,
    timestamp,
    teamPlayerID,
    bundleId,
  };
}

/** `teamPlayerID || bundleId || u64be(timestamp) || salt`. */
function signedData(t: ParsedToken): Uint8Array {
  const enc = new TextEncoder();
  const a = enc.encode(t.teamPlayerID);
  const b = enc.encode(t.bundleId);
  const out = new Uint8Array(a.length + b.length + 8 + t.salt.length);
  out.set(a, 0);
  out.set(b, a.length);
  new DataView(out.buffer).setBigUint64(
    a.length + b.length,
    BigInt(t.timestamp),
    false,
  );
  out.set(t.salt, a.length + b.length + 8);
  return out;
}

// ── the certificate door and its cache ───────────────────────────────────────────────────────

const MEMO_LIMIT = 8;
const memo = new Map<string, CachedCert>();

const defaultCache: GameCenterCertCache = {
  async get(url) {
    const hit = memo.get(url);
    if (hit) return hit;
    try {
      if (typeof caches === "undefined") return null;
      const res = await caches.default.match(new Request(url));
      if (!res) return null;
      const fresh = Number(res.headers.get("x-pkey-fresh-until"));
      const stale = Number(res.headers.get("x-pkey-stale-until"));
      if (!Number.isFinite(fresh) || !Number.isFinite(stale)) return null;
      const der = new Uint8Array(await res.arrayBuffer());
      if (der.length === 0 || der.length > GAME_CENTER_CERT_MAX_BYTES)
        return null;
      return { der, freshUntilMs: fresh, staleUntilMs: stale };
    } catch {
      return null;
    }
  },
  async put(url, cert) {
    if (memo.size >= MEMO_LIMIT) memo.delete(memo.keys().next().value!);
    memo.set(url, cert);
    try {
      if (typeof caches === "undefined") return;
      const seconds = Math.max(
        1,
        Math.floor((cert.staleUntilMs - Date.now()) / 1000),
      );
      await caches.default.put(
        new Request(url),
        new Response(cert.der, {
          headers: {
            "cache-control": `max-age=${seconds}`,
            "x-pkey-fresh-until": String(cert.freshUntilMs),
            "x-pkey-stale-until": String(cert.staleUntilMs),
          },
        }),
      );
    } catch {
      // The memo still holds it.
    }
  },
};

/** Apple's freshness for the answer in seconds: its `max-age`, `0` when it says not to keep it. */
function freshnessSeconds(res: Response): number {
  const cc = (res.headers.get("cache-control") ?? "").toLowerCase();
  if (/(^|,)\s*(no-store|no-cache|private)\b/.test(cc)) return 0;
  const m = /(?:^|,)\s*max-age=(\d{1,10})\b/.exec(cc);
  const s = m ? Number(m[1]) : GAME_CENTER_CERT_DEFAULT_TTL_SECONDS;
  return Math.min(s, GAME_CENTER_CERT_MAX_TTL_SECONDS);
}

async function readCappedBytes(res: Response): Promise<Uint8Array> {
  try {
    return await readBodyBytes(res, GAME_CENTER_CERT_MAX_BYTES);
  } catch (e) {
    if (e instanceof BodyTooLargeError) return unavailable();
    throw e;
  }
}

interface Fetched {
  der: Uint8Array;
  ttlSeconds: number;
}

/** The one door to Apple's key host: https, exact host, no redirects, capped, timed. */
async function fetchCertificate(
  url: string,
  fetchImpl: NonNullable<GameCenterVerifyOpts["fetch"]>,
): Promise<Fetched> {
  if (providerUrlProblem(url, NATIVE_HOSTS.gamecenter) !== null) refuse();
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "GET",
      redirect: "manual",
      headers: { accept: "application/x-x509-ca-cert, */*" },
      signal: AbortSignal.timeout(GAME_CENTER_FETCH_TIMEOUT_MS),
    });
  } catch {
    return unavailable();
  }
  if (isRedirect(res)) {
    await res.body?.cancel().catch(() => undefined);
    return unavailable();
  }
  if (res.status >= 500 || res.status === 429) {
    await res.body?.cancel().catch(() => undefined);
    return unavailable();
  }
  if (res.status !== 200) {
    await res.body?.cancel().catch(() => undefined);
    return refuse();
  }
  const der = await readCappedBytes(res);
  if (der.length === 0) refuse();
  return { der, ttlSeconds: freshnessSeconds(res) };
}

// ── the chain ────────────────────────────────────────────────────────────────────────────────

async function leafKeyFor(
  der: Uint8Array,
  atSec: number,
  anchors: GameCenterAnchors,
): Promise<{ key: CryptoKey; notAfter: number }> {
  for (const root of anchors.roots) {
    for (const intermediate of anchors.intermediates) {
      try {
        const v = await verifyChain([der, intermediate, root], {
          roots: [root],
          at: atSec,
          length: 3,
          algorithms: ["rsa"],
          leafExtendedKeyUsage: OID.codeSigning,
          leafDigitalSignature: "require",
        });
        // The chain check does not read the subject: the leaf must be Apple's by name.
        const only = (xs: string[]) =>
          xs.length === 1 && xs[0] === "Apple Inc.";
        if (
          !only(subjectAttributes(v.leaf, OID.organization)) ||
          !only(subjectAttributes(v.leaf, OID.commonName))
        )
          refuse();
        return { key: v.key, notAfter: v.leaf.notAfter };
      } catch (e) {
        if (!(e instanceof X509Error)) throw e;
      }
    }
  }
  return refuse();
}

// ── the verifier ─────────────────────────────────────────────────────────────────────────────

export async function verifyGameCenterToken(
  token: string,
  env: Env,
  productSlug: string,
  audiences: PlatformSignInAudiences,
  opts: GameCenterVerifyOpts = {},
): Promise<GameCenterIdentity> {
  const nowMs = opts.nowMs ?? Date.now();
  const cache = opts.cache ?? defaultCache;
  const anchors = opts.anchors ?? {
    roots: GAME_CENTER_ROOTS,
    intermediates: GAME_CENTER_INTERMEDIATES,
  };
  const fetchImpl = opts.fetch ?? ((i, init) => fetch(i, init));

  // 1. Product.
  const { teamId, bundleIds } = audiences.apple;
  if (!audiences.gameCenter || !teamId || bundleIds.length === 0) refuse();
  // 2. Shape, then the bundle id.
  const t = parseToken(token);
  if (!bundleIds.includes(t.bundleId)) refuse();
  // 3. Window.
  if (
    t.timestamp < nowMs - GAME_CENTER_MAX_AGE_SECONDS * 1000 ||
    t.timestamp > nowMs + GAME_CENTER_MAX_FUTURE_SECONDS * 1000
  )
    refuse();
  // 4. URL.
  if (!KEY_URL.test(t.keyUrl)) refuse();

  // 5. Certificate: kept DER while fresh, else fetched; a kept one stands in for a short outage.
  const kept = await cache.get(t.keyUrl);
  let der: Uint8Array;
  let fetched: Fetched | null = null;
  if (kept && nowMs < kept.freshUntilMs) {
    der = kept.der;
  } else {
    try {
      fetched = await fetchCertificate(t.keyUrl, fetchImpl);
      der = fetched.der;
    } catch (e) {
      if (e instanceof OidcNetworkError && kept && nowMs < kept.staleUntilMs)
        der = kept.der;
      else throw e;
    }
  }

  // 6. Chain. Verified on every use, a cache hit included.
  const { key, notAfter } = await leafKeyFor(
    der,
    Math.floor(nowMs / 1000),
    anchors,
  );

  // 7. Signature.
  let ok = false;
  try {
    ok = await crypto.subtle.verify(
      { name: "RSASSA-PKCS1-v1_5" },
      key,
      t.signature,
      signedData(t),
    );
  } catch {
    ok = false;
  }
  if (!ok) refuse();

  // Only a certificate that verified is kept, for Apple's freshness and never past its validity.
  if (fetched && fetched.ttlSeconds > 0) {
    const limit = notAfter * 1000;
    const freshUntilMs = Math.min(nowMs + fetched.ttlSeconds * 1000, limit);
    await cache.put(t.keyUrl, {
      der,
      freshUntilMs,
      staleUntilMs: Math.min(
        freshUntilMs + GAME_CENTER_CERT_GRACE_SECONDS * 1000,
        limit,
      ),
    });
  }

  // 8. Single use.
  const id = `${productSlug}:${await sha256B64url(t.signature)}`;
  const first = await putArtefact(
    env,
    artefactRef("gamecenter-signature", id),
    "1",
    GAME_CENTER_SINGLE_USE_SECONDS,
    { ifAbsent: true },
  );
  if (!first) refuse();

  return {
    subject: t.teamPlayerID,
    scope: `apple-team:${teamId}`,
    bundleId: t.bundleId,
  };
}
