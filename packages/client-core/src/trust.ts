// Trust-set construction — wire contract v3 §1 (semantics carried unchanged from v2, `typ`
// included: `pkey-trust+jws`). A verifier holds exactly two tiers, in
// strictly decreasing authority:
//
//   pinned    compiled into the host application. Terminal.
//   manifest  keys learned from a signed polaris-trust.jws, re-verified on every load.
//
// and nothing else. The on-disk cache is NOT a key source: it persists the manifest's compact
// JWS, never bare `kid → key` JSON, so a file write can neither add a kid nor swap the bytes
// behind one (R2-01 / R2-02 / R4-02).

import { verifyJws, type TrustSet } from "@polaris-key/jws";
import { ISSUER } from "@polaris-key/protocol/core";
import type { TrustManifestDoc } from "@polaris-key/protocol/trust";
import { CLOCK_SKEW_SECONDS, isTimestamp } from "./claims.js";

/** Trust-manifest schema versions this client understands. Unknown ⇒ fail closed. */
const SUPPORTED_SCHEMA_VERSIONS: ReadonlySet<number> = new Set([1]);

/**
 * Resolve the effective trust set. Pins are spread LAST so a manifest key can never shadow
 * one: `{...manifestKeys, ...pinnedKeys}` (§1 rule 1). The v1 code spread these the other way
 * round, which is the whole of R2-01 — one line, and a planted `trustedKeys` entry replaced
 * the key bytes behind a kid the application had explicitly pinned in source.
 */
export function mergeTrust(pinned: TrustSet, discovered: TrustSet): TrustSet {
  return { ...discovered, ...pinned };
}

export interface TrustManifestOptions {
  /** The ONLY keys a manifest may be verified against — never the discovered set (§1). */
  pinned: TrustSet;
  expectedAud: string;
  /** Expected `iss`; defaults to `ISSUER` ("key.plrs.im"). */
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
   * discovered set rather than merging into it — pruning is mandatory (§1 rule 2), and
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
 *     so the whole manifest is rejected and the previous trust set is kept (§1 rule 1).
 *  2. `key.status` is read. `revoked` keys are dropped, and because the result replaces the
 *     discovered set wholesale, a kid that simply disappears from a newer manifest is dropped
 *     too. That is what restores the server's ability to revoke (§1 rule 2).
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
  // The same one timestamp rule the document envelope uses (§3, A1-04): an integer in
  // `[0, MAX_TIMESTAMP_SECONDS]`. The manifest's `issuedAt` feeds the monotonic floor, so a
  // float or an out-of-range value here is a floor three languages would compute differently.
  if (!isTimestamp(doc.issuedAt) || !isTimestamp(doc.expiresAt))
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

  // A null-prototype map, so a manifest publishing a kid of `__proto__` (or `constructor`)
  // STORES a key under that name instead of writing the object's prototype and dropping it
  // (A1-08). Python and Swift store it — their maps have no such names — and a set that
  // silently loses an entry in one language only is a trust set the corpus cannot pin.
  const discovered: TrustSet = Object.create(null) as TrustSet;
  for (const key of doc.keys) {
    if (!key || typeof key !== "object") return REJECTED;
    // The server emits revoked entries EXPLICITLY for at least 2× cacheSeconds (§1) so
    // clients get a positive signal to prune on. Read it from the raw value — an unknown
    // future status must degrade gracefully, not break parsing.
    const status = (key as { status?: unknown }).status;
    // §1 distinguishes two failures that look alike and are not (A1-06):
    //
    //   * `kid` / `publicKey` missing or not a string ⇒ the WHOLE manifest is rejected. They
    //     are the entry's identity and its key material; an entry without them is not a
    //     forward-compatible key this verifier happens not to understand, it is a malformed
    //     manifest, and the pinned-substitution rule cannot even be evaluated against it.
    //   * `alg` / `kty` / `crv` not the Ed25519 triple — INCLUDING absent — ⇒ that ENTRY is
    //     skipped and the manifest still stands. That is §1's "skipped, not fatal": a
    //     future-alg key must never brick a current verifier, and an entry that omits the
    //     field is no more comprehensible to us than one that names an algorithm we lack.
    if (typeof key.kid !== "string" || typeof key.publicKey !== "string")
      return REJECTED;
    // Substitution attempt — reject the manifest, keep the previous trust set (§1 rule 1).
    // `Object.hasOwn` before the read, because a plain `pinned[kid]` for `kid === "__proto__"`
    // answers `Object.prototype` — an object that is neither `undefined` nor the published
    // bytes, so the manifest was refused as a substitution attempt against a pin that does not
    // exist. Python's dict and Swift's Dictionary simply miss (A1-08).
    const pinnedBytes = Object.hasOwn(opts.pinned, key.kid)
      ? opts.pinned[key.kid]
      : undefined;
    if (pinnedBytes !== undefined && pinnedBytes !== key.publicKey)
      return REJECTED;
    if (status === "revoked") continue;
    if (key.alg !== "EdDSA" || key.kty !== "OKP" || key.crv !== "Ed25519")
      continue;
    discovered[key.kid] = key.publicKey;
  }
  return { doc, discovered };
}
