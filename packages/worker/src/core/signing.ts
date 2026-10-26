/**
 * Document signing — the one place a Polaris Key document becomes a compact JWS under a product's
 * active signing key (design spec §5.1: "trust & signing (per-product Ed25519 keys …)" is core).
 *
 * The encoding is FROZEN: `@polaris-key/jws` is what the conformance corpus pins, and the per-product
 * `kid` + key are what scope a signed document to one tenant. Every service that mints a
 * document (license, config, and the offline bundle later) signs through here rather than
 * reaching for `signJws` itself, so there is exactly one call site to audit when the envelope
 * changes.
 *
 * `typ` is the wire-v3 domain separator (WIRE-CONTRACT-V3 §2). One product key signs the
 * license document, the config document and the trust manifest, so `typ` is the ONLY thing
 * standing between them: without it a config document could be replayed into a call site
 * expecting a license document and verify perfectly. Every call site here passes one — the
 * license and config documents, and all three artifacts `console/handlers/bundles.ts` mints — so the
 * optionality is inherited from `signJws`, not exercised: a signer that omits `typ` is a bug
 * rather than a compatibility choice. The one Polaris Key document with no `typ` is the FUSED
 * browser-session artifact (`services/identity/doc.ts`), and it never reaches this function:
 * `/identity/session` serves it as plain JSON to a page, unsigned, so there is nothing to
 * domain-separate. It gets a `typ` if and when it is ever signed.
 *
 * Key material is opened by `Product.signingKey()` in `core/products.ts` when a route needs it;
 * `loadPublicSigningKey(s)` reads only public halves, which `core/trust/trust.ts` publishes.
 * This module never touches storage.
 *
 * ── THE SIGNER GUARDS (plans/P3-01.md §2.2, "Keeping the signer total") ─────────────────────
 *
 * Two guards make the Worker unable to sign what a wire-v4 verifier refuses. `signJws` throws
 * `StrictJsonError` on a header or payload that breaks V4 §1.2's strict-JSON rules, and this
 * function throws it first when an integer claim of a v3 `typ` is not a safe integer of at least
 * the claim's minimum (V4 §3, "Minimums": 0 for every timestamp, 1 for `schemaVersion`). Every
 * route that signs catches `StrictJsonError` and answers `500 document_not_representable` in its
 * own body shape (`isStrictJsonError`); none lets it escape as an unhandled throw.
 */

import {
  isAcceptableEd25519Point,
  isCanonicalB64url,
  isX25519LowOrder,
  base64UrlDecode,
  signJws,
  StrictJsonError,
  type JwsTyp,
} from "@polaris-key/jws";
import { ISSUER, PAIRWISE_SUBJECT_PATTERN } from "@polaris-key/protocol/core";
import {
  MAX_PEER_CERT_SECONDS,
  MAX_RING_DEVICES,
  PEER_CERT_TYP,
  PEER_DEVICE_ID_PATTERN,
  RING_TYP,
} from "@polaris-key/protocol/connect";

export { StrictJsonError };

/**
 * The integer claims of each v3 `typ` with their minimums (WIRE-CONTRACT-V4 §3, the "Minimums"
 * table). The feed's claims are checked by P3-03's composer (`feedClaims`) before it calls this
 * function, and no Worker signs a release record.
 */
const INTEGER_CLAIMS: Partial<
  Record<JwsTyp, readonly (readonly [string, number])[]>
> = {
  "pkey-license+jws": [
    ["issuedAt", 0],
    ["expiresAt", 0],
    ["graceUntil", 0],
  ],
  "pkey-config+jws": [
    ["issuedAt", 0],
    ["expiresAt", 0],
    ["graceUntil", 0],
    ["schemaVersion", 1],
  ],
  "pkey-trust+jws": [
    ["schemaVersion", 1],
    ["issuedAt", 0],
    ["expiresAt", 0],
  ],
  "pkey-bundle+jws": [
    ["issuedAt", 0],
    ["expiresAt", 0],
  ],
  // WIRE-CONTRACT-V5 §15.2, §15.3.
  "pkey-peer+jws": [
    ["ringEpoch", 1],
    ["issuedAt", 0],
    ["expiresAt", 0],
  ],
  "pkey-ring+jws": [
    ["epoch", 1],
    ["issuedAt", 0],
    ["expiresAt", 0],
  ],
};

/**
 * Throw `StrictJsonError` when an integer claim of a v3 `typ` is missing, is not a safe integer
 * (a fraction, `NaN`, beyond 2^53 − 1, or not a number at all), or is below its minimum.
 * `JSON.stringify` writes a safe integer as a plain integer token, so a claim that passes here
 * is one every v4 verifier reads as a wire integer.
 */
export function assertIntegerClaims(
  doc: unknown,
  typ: JwsTyp | undefined,
): void {
  const claims = typ === undefined ? undefined : INTEGER_CLAIMS[typ];
  if (!claims) return;
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
    throw new StrictJsonError("payload", `a ${typ} document must be an object`);
  }
  for (const [name, min] of claims) {
    const value = (doc as Record<string, unknown>)[name];
    if (
      typeof value !== "number" ||
      !Number.isSafeInteger(value) ||
      value < min
    ) {
      throw new StrictJsonError(
        "payload",
        `${typ} claim ${name} must be a safe integer of at least ${min} (WIRE-CONTRACT-V4 §3)`,
      );
    }
  }
}

function refuse(typ: string, why: string): never {
  throw new StrictJsonError(
    "payload",
    `${typ}: ${why} (WIRE-CONTRACT-V5 §15), so no v5 verifier would accept it`,
  );
}

const DEVICE_ID_RE = new RegExp(PEER_DEVICE_ID_PATTERN);
const SUBJECT_RE = new RegExp(PAIRWISE_SUBJECT_PATTERN);

/** §15.2 step 4: canonical base64url of exactly 32 bytes; returns the bytes. */
function keyBytes(typ: string, name: string, value: unknown): Uint8Array {
  if (
    typeof value !== "string" ||
    value.length !== 43 ||
    !isCanonicalB64url(value)
  ) {
    refuse(typ, `${name} is not canonical base64url of 32 bytes`);
  }
  return base64UrlDecode(value);
}

/** One device's three members, as the certificate and the roster both carry them. */
function deviceKeys(typ: string, d: unknown): string {
  if (d === null || typeof d !== "object" || Array.isArray(d)) {
    refuse(typ, "a device entry is not an object");
  }
  const o = d as Record<string, unknown>;
  if (typeof o.deviceId !== "string" || !DEVICE_ID_RE.test(o.deviceId)) {
    refuse(typ, "deviceId does not match its pattern");
  }
  const sign = keyBytes(typ, "signKey", o.signKey);
  if (!isAcceptableEd25519Point(sign)) {
    refuse(typ, "signKey fails the Ed25519 point checks");
  }
  const agree = keyBytes(typ, "agreeKey", o.agreeKey);
  if (isX25519LowOrder(agree)) refuse(typ, "agreeKey is a low-order point");
  return o.deviceId;
}

function envelope(typ: string, o: Record<string, unknown>): void {
  if (o.iss !== ISSUER) refuse(typ, "iss is not the fixed issuer");
  if (typeof o.aud !== "string" || o.aud.length === 0) {
    refuse(typ, "aud is not a product");
  }
  if (typeof o.sub !== "string" || !SUBJECT_RE.test(o.sub)) {
    refuse(typ, "sub is not a pairwise subject");
  }
  // Step 5 is the certificate's; §15.3 sets no span for a roster.
  if (typ === PEER_CERT_TYP) {
    const ttl = (o.expiresAt as number) - (o.issuedAt as number);
    if (ttl < 1 || ttl > MAX_PEER_CERT_SECONDS) {
      refuse(typ, "expiresAt − issuedAt is outside 1..604800");
    }
  }
}

/**
 * Refuse to sign a device certificate or roster that a v5 verifier would refuse (§15.2 steps 2–5,
 * §15.3). Runs after `assertIntegerClaims`, so the integer claims are safe integers here. The
 * clock checks (step 6) and the Noise binding (step 7) belong to the verifier's session.
 */
export function assertConnectDoc(doc: unknown, typ: JwsTyp | undefined): void {
  if (typ !== PEER_CERT_TYP && typ !== RING_TYP) return;
  const o = doc as Record<string, unknown>;
  envelope(typ, o);
  if (typ === PEER_CERT_TYP) {
    deviceKeys(typ, o);
    return;
  }
  const devices = o.devices;
  if (
    !Array.isArray(devices) ||
    devices.length < 1 ||
    devices.length > MAX_RING_DEVICES
  ) {
    refuse(typ, `devices is not 1..${MAX_RING_DEVICES} entries`);
  }
  const ids = devices.map((d) => deviceKeys(typ, d));
  const keys = new Set<string>();
  for (let i = 0; i < devices.length; i++) {
    const d = devices[i] as Record<string, string>;
    // Sorted by deviceId bytes (ASCII, so code-unit order), strictly: unique ids.
    if (i > 0 && !(ids[i - 1]! < ids[i]!)) {
      refuse(typ, "devices are not sorted by unique deviceId");
    }
    for (const k of [d.signKey, d.agreeKey]) {
      if (keys.has(k!)) refuse(typ, "a key appears twice in devices");
      keys.add(k!);
    }
  }
}

/** True for the guards' refusal, which a signing route answers as `500 document_not_representable`. */
export function isStrictJsonError(e: unknown): e is StrictJsonError {
  return e instanceof StrictJsonError;
}

export async function signDoc(
  doc: unknown,
  privateKeyPem: string,
  kid: string,
  typ?: JwsTyp,
): Promise<string> {
  assertIntegerClaims(doc, typ);
  assertConnectDoc(doc, typ);
  return signJws(doc, privateKeyPem, kid, typ);
}
