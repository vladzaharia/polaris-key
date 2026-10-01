/// <reference types="@cloudflare/workers-types" />

/**
 * GitHub-cost caches for the release surfaces (P2-05, README §3.5 "GitHub as a source", §9.1
 * issue #3).
 *
 * Before this, every download and every `Range` chunk paid two to four GitHub calls against an
 * installation quota shared by every product on it: a release list (plus a floor lookup) to
 * resolve the selector, then the asset call that 302s to GitHub's storage. Two caches cut that:
 *
 *   RESOLUTION  what a selector resolved to, per (product, selector), for `RESOLUTION_TTL`
 *               (90 s, inside the brief's 60–120 s). A download, an appcast and a version check
 *               of one product therefore cost at most one resolution per 90 s per selector.
 *   SIGNED URL  GitHub's signed storage URL for one asset, per (product, repo, asset), for less
 *               than its own lifetime. A `Range` chunk after the first request costs no API
 *               call at all: it goes straight to the storage host.
 *
 * ── STALENESS, AND THE GENERATION ───────────────────────────────────────────────────────────
 *
 * A cached resolution must not outlive a deliberate change. Every write that can change what a
 * selector resolves to — a truth-store sync or resync, a promote, pin, unpin, yank or unyank,
 * an operator floor change — bumps the product's release GENERATION, and the generation is part
 * of every resolution key. So a yank takes effect on the next request in the colo that made it
 * (and within KV's propagation window elsewhere), not after the TTL. What the TTL alone bounds
 * is upstream drift nobody told us about: a release deleted on GitHub with no webhook.
 *
 * ── THE SIGNED URL IS A CREDENTIAL ──────────────────────────────────────────────────────────
 *
 * For a private repository the signed URL is a bearer credential for the asset. It is kept in
 * KV under the product's own scope (`kvKey`), SEALED under `PLATFORM_KEK` like the installation
 * token it was obtained with (R12-03), with a TTL shorter than its expiry, and its host is
 * re-checked against `isAllowedStorageHost` on every use (R6-08). With no KEK there is no cache:
 * one API call per request is the right price, a plaintext credential in KV is not.
 *
 * Cache keys are synthesised from identifiers this Worker chose, never from `req.url`
 * (`gateway.ts` `releaseCacheKey` explains why). Every KV failure is a miss, never an error.
 */

import type { Env } from "../../core/platform.js";
import type { FetchImpl } from "./githubApp.js";
import {
  isAllowedStorageHost,
  kvKey,
  open,
  randomId,
  seal,
} from "../../core/platform.js";

/** Seconds a resolution is reused (README §3.5: 60–120 s). KV's floor is 60. */
export const RESOLUTION_TTL = 90;
/** KV's minimum `expirationTtl`. */
const KV_MIN_TTL = 60;
/** GitHub documents a signed asset URL as valid for five minutes. */
const SIGNED_URL_ASSUMED_LIFETIME = 300;
/** Never use a signed URL this close to its expiry: a large chunk must finish in time. */
const SIGNED_URL_MARGIN = 60;
/** The generation key outlives every entry keyed by it by far; it is re-created when absent. */
const GENERATION_TTL = 7 * 24 * 3600;

function generationKey(product: string): string {
  return kvKey(product, "release", "generation");
}

/** The product's current release generation (`"0"` when none was ever written). */
export async function releaseGeneration(
  env: Env,
  product: string,
): Promise<string> {
  try {
    return (await env.HOT.get(generationKey(product))) ?? "0";
  } catch {
    return "0";
  }
}

/**
 * Invalidate every cached resolution of `product` (see the header). Called after any write that
 * changes what a selector resolves to. A failure is swallowed: the TTL still bounds staleness,
 * and failing an audited operator change because a cache write failed would be the wrong trade.
 */
export async function bumpReleaseGeneration(
  env: Env,
  product: string,
  now: number,
): Promise<void> {
  try {
    await env.HOT.put(generationKey(product), `${now}-${randomId("g")}`, {
      expirationTtl: GENERATION_TTL,
    });
  } catch {
    /* the TTL bounds staleness */
  }
}

/**
 * Read-through cache for one resolution. `key` names the selector (and anything else the result
 * depends on); the product and its generation are added here. A `null` result is not cached, so
 * "nothing resolves" is always re-checked live (an R6-10 404 must not stick).
 */
export async function cachedResolution<T>(
  env: Env,
  product: string,
  key: string,
  compute: () => Promise<T | null>,
): Promise<T | null> {
  const gen = await releaseGeneration(env, product);
  const k = kvKey(product, "release-resolution", `${gen}:${key}`);
  try {
    const hit = await env.HOT.get(k);
    if (hit) return JSON.parse(hit) as T;
  } catch {
    /* a miss */
  }
  const value = await compute();
  if (value !== null) {
    try {
      await env.HOT.put(k, JSON.stringify(value), {
        expirationTtl: RESOLUTION_TTL,
      });
    } catch {
      /* uncached is still correct */
    }
  }
  return value;
}

// ── Signed asset URLs ────────────────────────────────────────────────────────────────────────

interface SignedUrlRecord {
  url: string;
  /** Epoch seconds after which the URL must not be used. */
  usableUntil: number;
}

/** Where one asset's signed URL lives, and what it is sealed against. */
function signedUrlSlot(product: string, repo: string, assetId: number) {
  const id = `${repo.toLowerCase()}:${assetId}`;
  return {
    key: kvKey(product, "gh-asset-url", id),
    ctx: { product, kind: "product-secret" as const, id: `gh-asset-url:${id}` },
  };
}

/**
 * When a GitHub signed storage URL expires, from its own query string: `X-Amz-Date` +
 * `X-Amz-Expires` (S3-style) or `se` (Azure-style). Null when it says nothing usable.
 */
export function signedUrlExpiry(url: string): number | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const amzDate = u.searchParams.get("X-Amz-Date");
  const amzExpires = Number(u.searchParams.get("X-Amz-Expires"));
  if (amzDate && Number.isFinite(amzExpires) && amzExpires > 0) {
    const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(amzDate);
    if (m) {
      const at = Date.UTC(
        Number(m[1]),
        Number(m[2]) - 1,
        Number(m[3]),
        Number(m[4]),
        Number(m[5]),
        Number(m[6]),
      );
      return Math.floor(at / 1000) + amzExpires;
    }
  }
  const se = u.searchParams.get("se");
  if (se) {
    const ms = Date.parse(se);
    if (Number.isFinite(ms)) return Math.floor(ms / 1000);
  }
  return null;
}

/** A cached signed URL for this asset that is still safely usable, else null. */
export async function getCachedSignedUrl(
  env: Env,
  product: string,
  repo: string,
  assetId: number,
  now: number,
): Promise<string | null> {
  const { key, ctx } = signedUrlSlot(product, repo, assetId);
  try {
    const raw = await env.HOT.get(key);
    if (!raw) return null;
    const rec = JSON.parse(await open(env, raw, ctx)) as SignedUrlRecord;
    if (typeof rec.url !== "string" || !(rec.usableUntil > now)) return null;
    // R6-08, on USE: the host is re-checked, so a record that somehow named another host is
    // never followed.
    if (!isAllowedStorageHost(new URL(rec.url).hostname)) return null;
    return rec.url;
  } catch {
    return null;
  }
}

/** Remember a signed URL GitHub just handed out, for less than its lifetime. */
export async function putCachedSignedUrl(
  env: Env,
  product: string,
  repo: string,
  assetId: number,
  url: string,
  now: number,
): Promise<void> {
  try {
    if (!isAllowedStorageHost(new URL(url).hostname)) return;
    const expires =
      signedUrlExpiry(url) ?? now + SIGNED_URL_ASSUMED_LIFETIME;
    const usableUntil = expires - SIGNED_URL_MARGIN;
    if (usableUntil - now < KV_MIN_TTL) return;
    const { key, ctx } = signedUrlSlot(product, repo, assetId);
    const rec: SignedUrlRecord = { url, usableUntil };
    await env.HOT.put(key, await seal(env, JSON.stringify(rec), ctx), {
      expirationTtl: Math.max(KV_MIN_TTL, usableUntil - now),
    });
  } catch {
    /* no KEK, or KV refused: serve uncached */
  }
}

/** Forget a signed URL the storage host refused (expired early, revoked). */
export async function dropCachedSignedUrl(
  env: Env,
  product: string,
  repo: string,
  assetId: number,
): Promise<void> {
  try {
    await env.HOT.delete(signedUrlSlot(product, repo, assetId).key);
  } catch {
    /* it expires anyway */
  }
}

// ── Repository visibility (for the opt-in redirect mode) ────────────────────────────────────

/** How long a repository's visibility answer is reused. A repo going private is rare and the
 *  answer only ever decides whether a PUBLIC artifact may be redirected instead of streamed. */
const REPO_VISIBILITY_TTL = 3600;

/**
 * Is the product's repository public? One `GET /repos/{owner}/{repo}` per hour per product, and
 * only when a request asks for `?redirect=1`. Any failure — and every private answer — is
 * `false`, which keeps the request on the streaming path: redirecting a private repository's
 * client to GitHub would only hand it a 404 (or, with a signed URL, a credential).
 */
export async function isPublicRepository(
  env: Env,
  product: string,
  owner: string,
  repo: string,
  token: () => Promise<string>,
  fetchImpl: FetchImpl,
): Promise<boolean> {
  const key = kvKey(
    product,
    "gh-repo-public",
    `${owner}/${repo}`.toLowerCase(),
  );
  try {
    const hit = await env.HOT.get(key);
    if (hit === "1" || hit === "0") return hit === "1";
  } catch {
    /* a miss */
  }
  let isPublic = false;
  try {
    const res = await fetchImpl(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
      {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${await token()}`,
          "User-Agent": "polaris-key-release",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      },
    );
    if (res.ok) {
      const body = (await res.json()) as {
        private?: unknown;
        visibility?: unknown;
      };
      isPublic = body.private === false && body.visibility !== "internal";
    }
  } catch {
    isPublic = false;
  }
  try {
    await env.HOT.put(key, isPublic ? "1" : "0", {
      expirationTtl: REPO_VISIBILITY_TTL,
    });
  } catch {
    /* uncached */
  }
  return isPublic;
}
