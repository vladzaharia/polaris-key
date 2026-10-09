// Trust-set construction — WIRE-CONTRACT-V4 §1 and §2.3. A verifier holds exactly two tiers, in
// strictly decreasing authority:
//
//   pinned    compiled into the host application. Terminal unless TOMBSTONED: a verified
//             manifest signed by another usable pin that lists the pin's exact bytes as
//             `revoked` removes it from the usable pins, permanently, on that install.
//   manifest  keys learned from a signed polaris-trust.jws, re-verified on every load.
//
// and nothing else. The on-disk cache is NOT a key source: it persists the manifest's compact
// JWS, never bare `kid → key` JSON, so a file write can neither add a kid nor swap the bytes
// behind one (R2-01 / R2-02 / R4-02). A tombstone is kept as SIGNED EVIDENCE (the revoking
// manifest, verbatim, in the cache's `pinRevocations` slice) and re-verified on every load by
// `loadPinRevocations`, so it too has no unsigned form.

import {
  base64UrlDecode,
  isCanonicalB64url,
  verifyJws,
  type TrustSet,
} from "@polaris-key/jws";
import { ISSUER, MAX_TRUST_SIGNER_ATTEMPTS } from "@polaris-key/protocol/core";
import {
  TRUST_LIVE_STATUSES,
  type TrustManifestDoc,
} from "@polaris-key/protocol/trust";
import { CLOCK_SKEW_SECONDS, isWireInteger } from "./claims.js";
import { hasOwn } from "./own.js";

/** Trust-manifest schema versions this client understands. Unknown ⇒ fail closed. */
const SUPPORTED_SCHEMA_VERSIONS: ReadonlySet<number> = new Set([1]);

const LIVE: ReadonlySet<unknown> = new Set<unknown>(TRUST_LIVE_STATUSES);

const utf8 = new TextEncoder();

/** Ascending byte order of the UTF-8 encodings (the order every SDK can reproduce exactly). */
export function compareKidBytes(a: string, b: string): number {
  const x = utf8.encode(a);
  const y = utf8.encode(b);
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
  return x.length - y.length;
}

/**
 * Resolve the effective trust set. Pins are spread LAST so a manifest key can never shadow
 * one: `{...manifestKeys, ...pinnedKeys}` (§1 rule 1). The v1 code spread these the other way
 * round, which is the whole of R2-01 — one line, and a planted `trustedKeys` entry replaced
 * the key bytes behind a kid the application had explicitly pinned in source. Pass the USABLE
 * pins (`usablePins`): a tombstoned pin is in no set at all.
 */
export function mergeTrust(pinned: TrustSet, discovered: TrustSet): TrustSet {
  return { ...discovered, ...pinned };
}

/** The usable pins: the pins minus the tombstoned kids (§1 tombstone rule 4). */
export function usablePins(
  pinned: TrustSet,
  tombstones: Iterable<string> = [],
): TrustSet {
  const dead = new Set(tombstones);
  const out: TrustSet = {};
  for (const [kid, key] of Object.entries(pinned))
    if (!dead.has(kid)) out[kid] = key;
  return out;
}

export interface TrustManifestOptions {
  /** The pins compiled into the host. A manifest verifies against the USABLE ones only (these
   *  minus `tombstones`), never against the discovered set (§1). */
  pinned: TrustSet;
  /** Pinned kids already tombstoned on this install (`loadPinRevocations`). A manifest one of
   *  them signed is refused, and no manifest can bring one back. */
  tombstones?: readonly string[];
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
   * The keys it publishes with a live status (`active`, `staged`, `retired`), minus every
   * tombstoned pin. This REPLACES the previously discovered set rather than merging into it —
   * pruning is mandatory (§1 rule 2), and absence in a newer manifest is revocation.
   */
  discovered: TrustSet;
  /**
   * The pinned kids this manifest NEWLY tombstones: listed `revoked` with their exact pinned
   * bytes by another usable pin. Ascending byte order; empty when rejected. The host records
   * this manifest as the evidence for each (`pinRevocations[kid] = jws`, §4.1).
   */
  revokedPins: string[];
}

const REJECTED: TrustManifestResult = {
  doc: null,
  discovered: {},
  revokedPins: [],
};

/**
 * Verify a signed trust manifest and derive the keys it publishes.
 *
 *  1. A manifest presenting a PINNED kid with DIFFERENT key bytes is a substitution attempt,
 *     so the whole manifest is rejected and the previous trust set is kept (§1). A tombstoned
 *     pin keeps this protection: its bytes still may not be swapped.
 *  2. `key.status` is an allow-list: exactly `active`, `staged` or `retired` keeps a key.
 *     `revoked` drops it; any other value, a case variant, a non-string or an absent status
 *     skips the entry and is never fatal. A non-canonical `publicKey` is skipped the same way.
 *  3. A usable pinned kid listed `revoked` with its exact bytes by ANOTHER pin is tombstoned
 *     (`revokedPins`). A manifest that lists its own signer as `revoked` is refused in full.
 */
export async function verifyTrustManifest(
  jws: string,
  opts: TrustManifestOptions,
): Promise<TrustManifestResult> {
  const tombstones = new Set(opts.tombstones ?? []);
  const verified = await verifyJws<TrustManifestDoc>(
    jws,
    usablePins(opts.pinned, tombstones),
    { typ: "pkey-trust+jws" },
  );
  if (!verified) return REJECTED;
  const doc = verified.payload;
  if (!doc || typeof doc !== "object") return REJECTED;

  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const nonWire = verified.nonWireIntegers;
  // V4 §3: integer claims decided from the token (`1.0` and `true` are refused), then the
  // allow-list.
  if (!isWireInteger(doc.schemaVersion, "/schemaVersion", 1, nonWire))
    return REJECTED;
  if (!SUPPORTED_SCHEMA_VERSIONS.has(doc.schemaVersion)) return REJECTED;
  if (doc.aud !== opts.expectedAud) return REJECTED;
  if (doc.iss !== (opts.expectedIss ?? ISSUER)) return REJECTED;
  if (
    !isWireInteger(doc.issuedAt, "/issuedAt", 0, nonWire) ||
    !isWireInteger(doc.expiresAt, "/expiresAt", 0, nonWire)
  )
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
  const revoked = new Set<string>();
  for (const key of doc.keys) {
    if (!key || typeof key !== "object") return REJECTED;
    // Read from the raw value: an unknown future status must degrade gracefully.
    const status = (key as { status?: unknown }).status;
    if (typeof key.kid !== "string" || typeof key.publicKey !== "string")
      return REJECTED;
    // Substitution attempt — reject the manifest, keep the previous trust set (§1).
    const pinnedBytes = opts.pinned[key.kid];
    if (pinnedBytes !== undefined && pinnedBytes !== key.publicKey)
      return REJECTED;
    if (status === "revoked") {
      if (pinnedBytes !== undefined) {
        // A manifest cannot revoke the key that signed it: refused in full (§1 rule 2).
        if (key.kid === verified.kid) return REJECTED;
        if (!tombstones.has(key.kid)) revoked.add(key.kid);
      }
      continue;
    }
    if (!LIVE.has(status)) continue;
    if (key.alg !== "EdDSA" || key.kty !== "OKP" || key.crv !== "Ed25519")
      continue;
    if (!isCanonicalB64url(key.publicKey)) continue;
    discovered[key.kid] = key.publicKey;
  }
  // A tombstoned kid leaves every set; a later manifest cannot restore it (§1 rule 3).
  for (const kid of [...tombstones, ...revoked]) delete discovered[kid];
  return {
    doc,
    discovered,
    revokedPins: [...revoked].sort(compareKidBytes),
  };
}

/** What `loadPinRevocations` derives from the cached evidence. */
export interface PinRevocations {
  /** The tombstoned pinned kids, ascending byte order. */
  tombstones: string[];
  /** The evidence that re-verified, keyed by the kid it revokes. Write this back. */
  kept: Record<string, string>;
}

/**
 * Re-derive the tombstones from the cache's `pinRevocations` slice (§4.1): `kid → the
 * revoking manifest's compact JWS`. Each entry is re-verified on the RELOAD profile (no
 * freshness, no anti-rollback floor), in ascending manifest `issuedAt` (ties: the revoked kid's
 * byte order), against the pins minus the tombstones already applied. An entry that does not
 * verify, whose signer is already tombstoned, or that does not revoke the kid it is filed
 * under, is dropped. The order is the contract: two pins that each revoked the other leave
 * exactly the one revoked first.
 */
export async function loadPinRevocations(
  evidence: Record<string, unknown> | undefined,
  opts: { pinned: TrustSet; expectedAud: string; expectedIss?: string },
): Promise<PinRevocations> {
  const candidates: { kid: string; jws: string; issuedAt: number }[] = [];
  for (const [kid, jws] of Object.entries(evidence ?? {})) {
    if (typeof jws !== "string" || !hasOwn(opts.pinned, kid)) continue;
    const pre = await verifyTrustManifest(jws, {
      pinned: opts.pinned,
      expectedAud: opts.expectedAud,
      expectedIss: opts.expectedIss,
      checkFreshness: false,
    });
    if (!pre.doc) continue;
    candidates.push({ kid, jws, issuedAt: pre.doc.issuedAt });
  }
  candidates.sort(
    (a, b) => a.issuedAt - b.issuedAt || compareKidBytes(a.kid, b.kid),
  );
  const tombstones: string[] = [];
  const kept: Record<string, string> = {};
  for (const c of candidates) {
    const result = await verifyTrustManifest(c.jws, {
      pinned: opts.pinned,
      tombstones,
      expectedAud: opts.expectedAud,
      expectedIss: opts.expectedIss,
      checkFreshness: false,
    });
    if (!result.doc || !result.revokedPins.includes(c.kid)) continue;
    tombstones.push(c.kid);
    kept[c.kid] = c.jws;
  }
  return { tombstones: tombstones.sort(compareKidBytes), kept };
}

/** The header `kid` of a compact JWS, unverified, or null. For the signer retry only. */
export function jwsHeaderKid(jws: string): string | null {
  try {
    const header = JSON.parse(
      new TextDecoder().decode(base64UrlDecode(jws.split(".")[0] ?? "")),
    ) as { kid?: unknown } | null;
    return typeof header?.kid === "string" ? header.kid : null;
  } catch {
    return null;
  }
}

/**
 * The `?signer=<kid>` retry order (§2.3). When the default manifest's header `kid` is a usable
 * pin, there is nothing to retry: empty. Otherwise each usable pin in ascending kid byte order,
 * at most `MAX_TRUST_SIGNER_ATTEMPTS`; the client stops at the first manifest it accepts.
 */
export function trustSignerOrder(
  usable: TrustSet,
  headerKid: string | null,
): string[] {
  if (headerKid !== null && hasOwn(usable, headerKid)) return [];
  return Object.keys(usable)
    .filter((kid) => kid !== headerKid)
    .sort(compareKidBytes)
    .slice(0, MAX_TRUST_SIGNER_ATTEMPTS);
}
