// JWS verification + per-document claim validation — wire contract v3 §2–§3.
//
// Cryptographic verification is the frozen @polaris-key/jws path (encoded-length caps, strict
// base64url, duplicate-key rejection, verify-before-parse, `kid` selected only from the
// caller's trust set). On top of it this module asserts the full v3 claim set, so a document
// that is expired, foreign, far-future, or wearing the wrong `typ` never becomes a document
// at all.
//
// v3 splits the single v2 `pkey-config+jws` document into TWO: `pkey-license+jws` (grants)
// and `pkey-config+jws` (config + secrets). The envelope they share (§2) is validated once,
// in `validateEnvelope`; only the per-document claims differ, and those live in the two
// `DocTypeSpec`s below. `verifyDoc` is generic so P6's bundle verifier can reuse it.

import {
  verifyJws,
  type JwsTyp,
  type NonWireIntegers,
  type TrustSet,
} from "@polaris-key/jws";
import { ISSUER, type DocClaims } from "@polaris-key/protocol/core";
import type { LicenseDoc } from "@polaris-key/protocol/license";
import type { ConfigDoc } from "@polaris-key/protocol/config";
import {
  CLOCK_SKEW_SECONDS,
  MAX_GRACE_SECONDS,
  NO_NON_WIRE_INTEGERS,
  isWireInteger,
} from "./claims.js";

/** A JSON object — not an array, not null. Managed maps must be exactly this. */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * §3 asks for `schemaVersion` to be checked against "a known version, unknown ⇒ fail closed".
 * That cannot be implemented as an allow-list here: on a CONFIG document the field carries the
 * PRODUCT CATALOG version, not a wire-format discriminator — the Worker sets it to
 * `schema.catalog_version`, which increments on every catalog edit and is unbounded per
 * product. An allow-list would reject every product that has ever revised its catalog.
 * (Contrast `TrustManifestDoc.schemaVersion`, which the protocol types as the literal `1` and
 * the Worker hardcodes — that one IS allow-listed, in trust.ts.) What is enforceable, and what
 * R2-08's `schemaVersion: 999` payload actually violated, is the SHAPE.
 */
function isValidSchemaVersion(v: unknown, nonWire: NonWireIntegers): boolean {
  // V4 §3: an integer claim decided from its token, minimum 1.
  return isWireInteger(v, "/schemaVersion", 1, nonWire);
}

export interface VerifyOptions {
  trust: TrustSet;
  expectedAud: string;
  /** Expected `iss`; defaults to `ISSUER` ("key.plrs.im"). */
  expectedIss?: string;
  deviceId: string;
  /** Per-TYPE anti-replay floor: reject a document not strictly newer than the one already
   *  accepted for this document type (§3). License and config carry independent floors.
   *  REQUIRED: "no floor" is an explicit `null` — never an omitted argument, so a
   *  call site that forgot its floor is a type error rather than a silent replay window. A
   *  value that is neither a number nor `null` at run time (an omitted argument in untyped
   *  JS) fails closed: the document is rejected. */
  lastAcceptedIssuedAt: number | null;
  /** Epoch seconds used for every clock comparison. Defaults to the system clock. */
  now?: number;
  /**
   * Assert the freshness window — `issuedAt <= now + skew` and `expiresAt > now - skew`.
   *
   * TRUE (the default) on the NETWORK path: a document that arrives already expired, or
   * stamped in the far future, is neither accepted nor cached.
   *
   * FALSE on the CACHE-RELOAD path (and on bundle import, §7), where a cached document is
   * *expected* to be past its short `expiresAt` — that is what offline operation is. Its
   * signed outer bound there is `graceUntil`, which the gate enforces against the monotonic
   * clock floor (§4.2). Asserting `expiresAt` on reload would delete offline grace outright.
   */
  checkFreshness?: boolean;
}

/**
 * Everything that distinguishes one document type from another: its `typ` domain separator
 * and the claims that exist only on it. The shared envelope is NOT repeated here.
 */
export interface DocTypeSpec<T extends DocClaims> {
  typ: JwsTyp;
  /** Per-document claim validation, run only after the envelope passes. `nonWire` is the
   *  verified payload's non-wire-integer pointer set (WIRE-CONTRACT-V4 §3). */
  validate: (doc: T, nonWire: NonWireIntegers) => boolean;
}

/** `pkey-license+jws` — grants. `entitlements` is the sole carrier of grant data (D-20). */
export const LICENSE_DOC: DocTypeSpec<LicenseDoc> = {
  typ: "pkey-license+jws",
  validate: (doc) => {
    if (typeof doc.licenseId !== "string" || doc.licenseId === "") return false;
    if (!isPlainObject(doc.entitlements)) return false;
    // `profile` is optional, but a present one must be an object — never a smuggled scalar, and
    // never a present `null` (WIRE-CONTRACT-V4 §3 "presence").
    if (doc.profile !== undefined && !isPlainObject(doc.profile)) return false;
    return true;
  },
};

/** `pkey-config+jws` — config + secrets, and no license fields whatsoever (§2.2, D-08). */
export const CONFIG_DOC: DocTypeSpec<ConfigDoc> = {
  typ: "pkey-config+jws",
  validate: (doc, nonWire) => {
    if (!isValidSchemaVersion(doc.schemaVersion, nonWire)) return false;
    if (!isPlainObject(doc.config)) return false;
    if (!isPlainObject(doc.secrets)) return false;
    return true;
  },
};

/**
 * The shared envelope every per-service document carries (§2 / §3). Checked in one place so
 * license and config can never drift apart on `iss`, `aud`, device binding, the grace ceiling,
 * or the freshness split.
 */
function validateEnvelope(
  doc: DocClaims,
  opts: VerifyOptions,
  now: number,
  nonWire: NonWireIntegers = NO_NON_WIRE_INTEGERS,
): boolean {
  if (doc.aud !== opts.expectedAud) return false;
  // The issuer is the fixed `key.plrs.im` (Amendment A1), never a caller-derived hostname —
  // an attacker-controlled base URL must not be able to name its own issuer (§8).
  if (doc.iss !== (opts.expectedIss ?? ISSUER)) return false;
  if (doc.deviceId !== opts.deviceId) return false;
  // V4 §3: every timestamp is an integer claim, decided from its token, minimum 0.
  if (
    !isWireInteger(doc.issuedAt, "/issuedAt", 0, nonWire) ||
    !isWireInteger(doc.expiresAt, "/expiresAt", 0, nonWire) ||
    !isWireInteger(doc.graceUntil, "/graceUntil", 0, nonWire)
  ) {
    return false;
  }
  if (opts.lastAcceptedIssuedAt !== null) {
    if (
      typeof opts.lastAcceptedIssuedAt !== "number" ||
      doc.issuedAt <= opts.lastAcceptedIssuedAt
    ) {
      return false;
    }
  }
  // A grace window shorter than the expiry, or longer than a year, is not a document this
  // client will honour — whoever authored it. The ceiling applies at VERIFY time, not only in
  // the gate (§3.3), so an over-generous bundle is refused before it can reach the cache.
  if (doc.graceUntil < doc.expiresAt) return false;
  if (doc.graceUntil > doc.issuedAt + MAX_GRACE_SECONDS) return false;
  if (opts.checkFreshness !== false) {
    if (doc.issuedAt > now + CLOCK_SKEW_SECONDS) return false;
    if (doc.expiresAt <= now - CLOCK_SKEW_SECONDS) return false;
  }
  return true;
}

/**
 * Verify one signed Polaris Key document of a known type. Returns the payload, or `null` on ANY
 * failure — never a throw, so every call site fails closed identically.
 */
export async function verifyDoc<T extends DocClaims>(
  jws: string,
  spec: DocTypeSpec<T>,
  opts: VerifyOptions,
): Promise<T | null> {
  // Size caps, strict base64url, duplicate-key rejection and verify-before-parse all live in
  // `verifyJws`; it never JSON-parses an unauthenticated payload. `typ` closes cross-protocol
  // replay — a trust manifest, or the *other* document type, presented here (§2).
  const v = await verifyJws<T>(jws, opts.trust, {
    typ: spec.typ,
  });
  if (!v) return null;
  const doc = v.payload;
  if (!isPlainObject(doc)) return null;
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  if (!validateEnvelope(doc as DocClaims, opts, now, v.nonWireIntegers))
    return null;
  if (!spec.validate(doc, v.nonWireIntegers)) return null;
  return doc;
}

/** Verify a `pkey-license+jws` document (§2.1). */
export function verifyLicenseDoc(
  jws: string,
  opts: VerifyOptions,
): Promise<LicenseDoc | null> {
  return verifyDoc(jws, LICENSE_DOC, opts);
}

/** Verify a `pkey-config+jws` document (§2.2). */
export function verifyConfigDoc(
  jws: string,
  opts: VerifyOptions,
): Promise<ConfigDoc | null> {
  return verifyDoc(jws, CONFIG_DOC, opts);
}
