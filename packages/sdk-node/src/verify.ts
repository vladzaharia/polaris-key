// JWS verification + claim validation. Cryptographic verification is the frozen
// @plrs/jws path (caps, strict base64url, duplicate-key rejection, verify-before-parse);
// on top of it we assert the full wire-contract-v2 §3 claim set, so a document that is
// expired, foreign, far-future, unknown-schema, or wearing the wrong `typ` never becomes a
// document at all.

import { verifyJws, type TrustSet } from "@plrs/jws";
import { ISSUER, type ManagedConfigDoc } from "@plrs/protocol";
import { CLOCK_SKEW_SECONDS, MAX_GRACE_SECONDS } from "./claims.js";

/**
 * §3 asks for `schemaVersion` to be checked against "a known version, unknown ⇒ fail closed".
 * That cannot be implemented as an allow-list here: on a managed-config document the field
 * carries the PRODUCT CATALOG version, not a wire-format discriminator — the Worker sets it
 * to `schema.catalog_version` (`packages/worker/src/product.ts:114`), which increments on
 * every catalog edit and is unbounded per product. An allow-list would reject every product
 * that has ever revised its catalog. (Contrast `TrustManifestDoc.schemaVersion`, which the
 * protocol types as the literal `1` and the Worker hardcodes — that one IS allow-listed, in
 * trust.ts.) What is enforceable, and what R2-08's `schemaVersion: 999` payload actually
 * violated, is the SHAPE.
 */
function isValidSchemaVersion(v: unknown): boolean {
  return typeof v === "number" && Number.isInteger(v) && v >= 1;
}

export interface VerifyOptions {
  trust: TrustSet;
  expectedAud: string;
  /** Expected `iss`; defaults to the control-plane origin (`key.plrs.im`). */
  expectedIss?: string;
  deviceId: string;
  lastAcceptedIssuedAt?: number;
  /** Epoch seconds used for every clock comparison. Defaults to the system clock. */
  now?: number;
  /**
   * Assert the freshness window — `issuedAt <= now + skew` and `expiresAt > now - skew`.
   *
   * TRUE (the default) on the NETWORK path: a document that arrives already expired, or
   * stamped in the far future, is neither accepted nor cached.
   *
   * FALSE on the CACHE-RELOAD path, where a cached document is *expected* to be past its
   * short `expiresAt` — that is what offline operation is. Its signed outer bound there is
   * `graceUntil`, which the gate enforces against the monotonic clock floor (§4.3).
   * Asserting `expiresAt` on reload would delete offline grace outright.
   */
  checkFreshness?: boolean;
}

export async function verifyDoc(
  jws: string,
  opts: VerifyOptions,
): Promise<ManagedConfigDoc | null> {
  // Size caps, strict base64url, duplicate-key rejection and verify-before-parse all live
  // in `verifyJws`; it never JSON-parses an unauthenticated payload. `typ` closes the
  // cross-protocol replay of a trust manifest into a config-document call site (§2.4).
  const v = await verifyJws<ManagedConfigDoc>(jws, opts.trust, {
    typ: "pkey-config+jws",
  });
  if (!v) return null;
  const doc = v.payload;
  if (!doc || typeof doc !== "object") return null;
  const now = opts.now ?? Math.floor(Date.now() / 1000);

  // §3, checked in order. Any failure returns "no document", never a throw.
  if (!isValidSchemaVersion(doc.schemaVersion)) return null;
  if (doc.aud !== opts.expectedAud) return null;
  if (doc.iss !== (opts.expectedIss ?? ISSUER)) return null;
  if (doc.deviceId !== opts.deviceId) return null;
  if (
    typeof doc.issuedAt !== "number" ||
    typeof doc.expiresAt !== "number" ||
    typeof doc.graceUntil !== "number"
  ) {
    return null;
  }
  if (
    opts.lastAcceptedIssuedAt !== undefined &&
    doc.issuedAt <= opts.lastAcceptedIssuedAt
  ) {
    return null;
  }
  // A grace window shorter than the expiry, or longer than a year, is not a document this
  // client will honour — whoever authored it.
  if (doc.graceUntil < doc.expiresAt) return null;
  if (doc.graceUntil > doc.issuedAt + MAX_GRACE_SECONDS) return null;
  if (opts.checkFreshness !== false) {
    if (doc.issuedAt > now + CLOCK_SKEW_SECONDS) return null;
    if (doc.expiresAt <= now - CLOCK_SKEW_SECONDS) return null;
  }
  return doc;
}
