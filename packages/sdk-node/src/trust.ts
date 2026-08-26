// Trust-set construction — wire contract v2 §1. A verifier holds exactly two tiers, in
// strictly decreasing authority:
//
//   pinned    opts.trust.pinnedKeys, compiled into the host application. Terminal.
//   manifest  keys learned from a signed polaris-trust.jws, re-verified on every load.
//
// and nothing else. The on-disk cache is NO LONGER a key source: it persists the manifest's
// compact JWS, never bare `kid → key` JSON, so a file write can neither add a kid nor swap
// the bytes behind one (R2-01 / R2-02 / R4-02).

import { verifyJws, type TrustSet } from "@polaris-key/jws";
import { ISSUER, type TrustManifestDoc } from "@polaris-key/protocol";
import { CLOCK_SKEW_SECONDS } from "./claims.js";

/** Trust-manifest schema versions this SDK understands. Unknown ⇒ fail closed. */
const SUPPORTED_SCHEMA_VERSIONS: ReadonlySet<number> = new Set([1]);

/**
 * Resolve the effective trust set. Pins are spread LAST so a manifest key can never shadow
 * one: `{...manifestKeys, ...pinnedKeys}` (§1.1 rule 2). The v1 code spread these the other
 * way round, which is the whole of R2-01 — one line, and a planted `trustedKeys` entry
 * replaced the key bytes behind a kid the application had explicitly pinned in source.
 */
export function mergeTrust(pinned: TrustSet, discovered: TrustSet): TrustSet {
  return { ...discovered, ...pinned };
}

export interface TrustManifestOptions {
  /** The ONLY keys a manifest may be verified against — never the discovered set (§4.2). */
  pinned: TrustSet;
  expectedAud: string;
  /** Expected `iss`; defaults to the control-plane origin. */
  expectedIss?: string;
  /** Reject a manifest that is not strictly newer than this (anti-rollback). */
  lastTrustIssuedAt?: number;
  /** Epoch seconds for the clock comparisons. Defaults to the system clock. */
  now?: number;
  /** See `verifyDoc` — freshness is asserted on the network path only. */
  checkFreshness?: boolean;
}

export interface TrustManifestResult {
  /** The verified manifest, or null when it was rejected outright. */
  doc: TrustManifestDoc | null;
  /**
   * The keys it publishes with `status !== "revoked"`. This REPLACES the previously
   * discovered set rather than merging into it — pruning is mandatory (§1.2 rule 4), and
   * absence in a newer manifest is revocation.
   */
  discovered: TrustSet;
}

const REJECTED: TrustManifestResult = { doc: null, discovered: {} };

/**
 * Verify a signed trust manifest and derive the keys it publishes.
 *
 * Two normative rules the v1 code had neither of:
 *
 *  1. A manifest presenting a PINNED kid with DIFFERENT key bytes is a substitution attempt,
 *     so the whole manifest is rejected and the previous trust set is kept (§1.1 rule 1).
 *  2. `key.status` is read. `revoked` keys are dropped, and because the result replaces the
 *     discovered set wholesale, a kid that simply disappears from a newer manifest is dropped
 *     too. That is what restores the server's ability to revoke (§1.2).
 */
export async function verifyTrustManifest(
  jws: string,
  opts: TrustManifestOptions,
): Promise<TrustManifestResult> {
  const verified = await verifyJws<TrustManifestDoc>(jws, opts.pinned, {
    typ: "pkey-trust+jws",
  });
  if (!verified) return REJECTED;
  const doc = verified.payload;
  if (!doc || typeof doc !== "object") return REJECTED;

  const now = opts.now ?? Math.floor(Date.now() / 1000);
  if (!SUPPORTED_SCHEMA_VERSIONS.has(doc.schemaVersion)) return REJECTED;
  if (doc.aud !== opts.expectedAud) return REJECTED;
  if (doc.iss !== (opts.expectedIss ?? ISSUER)) return REJECTED;
  if (typeof doc.issuedAt !== "number" || typeof doc.expiresAt !== "number")
    return REJECTED;
  if (
    opts.lastTrustIssuedAt !== undefined &&
    doc.issuedAt <= opts.lastTrustIssuedAt
  ) {
    return REJECTED;
  }
  if (opts.checkFreshness !== false) {
    if (doc.issuedAt > now + CLOCK_SKEW_SECONDS) return REJECTED;
    if (doc.expiresAt <= now - CLOCK_SKEW_SECONDS) return REJECTED;
  }
  if (!Array.isArray(doc.keys)) return REJECTED;

  const discovered: TrustSet = {};
  for (const key of doc.keys) {
    if (!key || typeof key !== "object") return REJECTED;
    // `status` is typed as the non-revoked subset on the wire type, but the server now emits
    // revoked entries EXPLICITLY for at least 2× cacheSeconds (§1.2) so clients get a
    // positive signal to prune on. Read it from the raw value, not the narrowed type.
    const status = (key as { status?: unknown }).status;
    if (typeof key.kid !== "string" || typeof key.publicKey !== "string")
      return REJECTED;
    // Substitution attempt — reject the manifest, keep the previous trust set (§1.1 rule 1).
    const pinnedBytes = opts.pinned[key.kid];
    if (pinnedBytes !== undefined && pinnedBytes !== key.publicKey)
      return REJECTED;
    if (status === "revoked") continue;
    if (key.alg !== "EdDSA" || key.kty !== "OKP" || key.crv !== "Ed25519")
      continue;
    discovered[key.kid] = key.publicKey;
  }
  return { doc, discovered };
}
