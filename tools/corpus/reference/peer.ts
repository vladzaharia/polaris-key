// Reference: the device certificate and the roster (V5 §15.2, §15.3).
//
// The generator's independent reference implementation, restated from the spec rather than
// taken from client-core or an SDK: `peer.ts` recomputes every case's verdict through it and
// throws when a hand-written expectation disagrees.

import { base64UrlDecode } from "@polaris-key/jws";
import { CLOCK_SKEW, ISSUER_V3, MAX_WIRE_INTEGER_REF } from "../common.js";
import { refCanonicalB64url } from "./b64url.js";
import { isObj } from "./claims.js";
import { bytesHex } from "./ed25519.js";
import { refPointOk, refVerifyJws } from "./jws.js";
import { PLAIN_INTEGER_REF, refNumberTokens } from "./tokens.js";

export const REF_MAX_PEER_CERT_SECONDS = 604800;
export const REF_MAX_RING_DEVICES = 128;
export const REF_RING_SECONDS = 604800;
export const REF_PEER_SUB_RE = /^ps_[A-Za-z0-9_-]{22}$/;
export const REF_PEER_DEVICE_RE = /^[A-Za-z0-9_-]{32}$/;
const REF_PEER_KEY_RE = /^[A-Za-z0-9_-]{43}$/;

/** §15.2 step 4: the seven X25519 low-order encodings, with the top bit clear: u = 0, 1, the
 *  two of order 8, p − 1, p and p + 1. A key is low-order when its bytes with bit 255 cleared
 *  (RFC 7748 §5) equal one of these, so both spellings of each (top bit set or clear) match. */
export const REF_X25519_LOW_ORDER_HEX = [
  "0000000000000000000000000000000000000000000000000000000000000000",
  "0100000000000000000000000000000000000000000000000000000000000000",
  "e0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b800",
  "5f9c95bca3508c24b1d0b1559c83ef5b04445cc4581c8e86d8224eddd09f1157",
  "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
  "edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
  "eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
] as const;

export function refX25519LowOrder(enc: Uint8Array): boolean {
  if (enc.length !== 32) return false;
  const masked = Uint8Array.from(enc);
  masked[31] = masked[31]! & 0x7f;
  return REF_X25519_LOW_ORDER_HEX.includes(
    bytesHex(masked) as (typeof REF_X25519_LOW_ORDER_HEX)[number],
  );
}

/** A canonical base64url string of exactly 32 bytes, decoded, or null. */
function refKeyBytes(v: unknown): Uint8Array | null {
  if (typeof v !== "string" || !REF_PEER_KEY_RE.test(v)) return null;
  if (!refCanonicalB64url(v)) return null;
  const b = base64UrlDecode(v);
  return b.length === 32 ? b : null;
}

/** §15.2 step 4 for one `(signKey, agreeKey)` pair. */
function refKeysOk(signKey: unknown, agreeKey: unknown): boolean {
  const s = refKeyBytes(signKey);
  const a = refKeyBytes(agreeKey);
  return s !== null && a !== null && refPointOk(s) && !refX25519LowOrder(a);
}

/** A claim that is an integer token of at least `min` and at most 2^53 − 1 (§3.1). */
function refIntClaim(
  tokens: Map<string, string>,
  doc: Record<string, unknown>,
  name: string,
  min: number,
): boolean {
  const token = tokens.get(`/${name}`);
  if (typeof doc[name] !== "number" || token === undefined) return false;
  if (!PLAIN_INTEGER_REF.test(token)) return false;
  const n = BigInt(token);
  return n >= BigInt(min) && n <= BigInt(MAX_WIRE_INTEGER_REF);
}

export interface RefPeerCert {
  sub: string;
  deviceId: string;
  signKey: string;
  agreeKey: string;
  ringEpoch: number;
  issuedAt: number;
  expiresAt: number;
}
export type PeerReason =
  | "jws-rejected"
  | "issuer-or-audience"
  | "integer"
  | "subject-or-device"
  | "keys"
  | "lifetime"
  | "clock"
  | "sub-mismatch"
  | "own-device"
  | "static-mismatch";
export interface PeerSession {
  mode: "a" | "v" | "p";
  /** Mode `a` only: the verifier's own pairwise subject and device id. */
  ownSub?: string;
  ownDeviceId?: string;
  /** The Noise remote static key, canonical base64url. */
  remoteStatic: string;
}
export type PeerVerdict =
  | { ok: true; cert: RefPeerCert }
  | { ok: false; reason: PeerReason };

const fail = (reason: PeerReason): PeerVerdict => ({ ok: false, reason });

/** §15.2 steps 1 to 7, in order; the first failing step names the reason. */
export function refPeerCert(
  jws: string,
  trust: Record<string, string>,
  o: { expectedAud: string; now: number; session?: PeerSession },
): PeerVerdict {
  const v = refVerifyJws(jws, trust, "pkey-peer+jws");
  if (v === null) return fail("jws-rejected");
  const d = v.payload;
  if (d.iss !== ISSUER_V3 || d.aud !== o.expectedAud)
    return fail("issuer-or-audience");
  const tokens = refNumberTokens(v.text);
  if (
    !refIntClaim(tokens, d, "ringEpoch", 1) ||
    !refIntClaim(tokens, d, "issuedAt", 0) ||
    !refIntClaim(tokens, d, "expiresAt", 0)
  )
    return fail("integer");
  if (
    typeof d.sub !== "string" ||
    !REF_PEER_SUB_RE.test(d.sub) ||
    typeof d.deviceId !== "string" ||
    !REF_PEER_DEVICE_RE.test(d.deviceId)
  )
    return fail("subject-or-device");
  if (!refKeysOk(d.signKey, d.agreeKey)) return fail("keys");
  const iat = d.issuedAt as number;
  const exp = d.expiresAt as number;
  if (exp - iat < 1 || exp - iat > REF_MAX_PEER_CERT_SECONDS)
    return fail("lifetime");
  if (iat > o.now + CLOCK_SKEW || o.now > exp + CLOCK_SKEW)
    return fail("clock");
  const s = o.session;
  if (s !== undefined) {
    if (s.mode === "a") {
      if (d.sub !== s.ownSub) return fail("sub-mismatch");
      if (d.deviceId === s.ownDeviceId) return fail("own-device");
    }
    if (d.agreeKey !== s.remoteStatic) return fail("static-mismatch");
  }
  return {
    ok: true,
    cert: {
      sub: d.sub,
      deviceId: d.deviceId,
      signKey: d.signKey as string,
      agreeKey: d.agreeKey as string,
      ringEpoch: d.ringEpoch as number,
      issuedAt: iat,
      expiresAt: exp,
    },
  };
}

export type RingReason =
  | "jws-rejected"
  | "issuer-or-audience"
  | "integer"
  | "subject"
  | "lifetime"
  | "devices-size"
  | "device"
  | "keys"
  | "unsorted"
  | "duplicate-id"
  | "duplicate-key";
export interface RefRing {
  sub: string;
  epoch: number;
  issuedAt: number;
  expiresAt: number;
  devices: { deviceId: string; signKey: string; agreeKey: string }[];
}
export type RingVerdict =
  | { ok: true; ring: RefRing }
  | { ok: false; reason: RingReason };
const ringFail = (reason: RingReason): RingVerdict => ({ ok: false, reason });

const refByteLess = (a: string, b: string): boolean =>
  Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8")) < 0;

/** §15.3: the roster's own checks (no clock: expiry is a separate question). */
export function refRing(
  jws: string,
  trust: Record<string, string>,
  o: { expectedAud: string },
): RingVerdict {
  const v = refVerifyJws(jws, trust, "pkey-ring+jws");
  if (v === null) return ringFail("jws-rejected");
  const d = v.payload;
  if (d.iss !== ISSUER_V3 || d.aud !== o.expectedAud)
    return ringFail("issuer-or-audience");
  const tokens = refNumberTokens(v.text);
  if (
    !refIntClaim(tokens, d, "epoch", 1) ||
    !refIntClaim(tokens, d, "issuedAt", 0) ||
    !refIntClaim(tokens, d, "expiresAt", 0)
  )
    return ringFail("integer");
  if (typeof d.sub !== "string" || !REF_PEER_SUB_RE.test(d.sub))
    return ringFail("subject");
  const span = (d.expiresAt as number) - (d.issuedAt as number);
  if (span < 1 || span > REF_RING_SECONDS) return ringFail("lifetime");
  const devices = d.devices;
  if (
    !Array.isArray(devices) ||
    devices.length < 1 ||
    devices.length > REF_MAX_RING_DEVICES
  )
    return ringFail("devices-size");
  for (const e of devices) {
    if (
      !isObj(e) ||
      typeof e.deviceId !== "string" ||
      !REF_PEER_DEVICE_RE.test(e.deviceId)
    )
      return ringFail("device");
    if (!refKeysOk(e.signKey, e.agreeKey)) return ringFail("keys");
  }
  const list = devices as RefRing["devices"];
  for (let k = 1; k < list.length; k++) {
    const prev = list[k - 1]!.deviceId;
    const cur = list[k]!.deviceId;
    if (prev === cur) return ringFail("duplicate-id");
    if (!refByteLess(prev, cur)) return ringFail("unsorted");
  }
  for (const f of ["signKey", "agreeKey"] as const)
    if (new Set(list.map((e) => e[f])).size !== list.length)
      return ringFail("duplicate-key");
  return {
    ok: true,
    ring: {
      sub: d.sub,
      epoch: d.epoch as number,
      issuedAt: d.issuedAt as number,
      expiresAt: d.expiresAt as number,
      devices: list,
    },
  };
}

/** §15.3: a ring is expired once `now > expiresAt + 300` (the cert's own clock rule). */
export const refRingExpired = (
  r: { expiresAt: number },
  now: number,
): boolean => now > r.expiresAt + CLOCK_SKEW;

/** The held ring, or null when there is none, it does not verify, or it is expired. */
function refLiveRing(
  heldJws: string | null,
  trust: Record<string, string>,
  o: { expectedAud: string; now: number },
): RefRing | null {
  const held = heldJws === null ? null : refRing(heldJws, trust, o);
  return held !== null && held.ok && !refRingExpired(held.ring, o.now)
    ? held.ring
    : null;
}

export type ReplaceReason =
  | "new-rejected"
  | "other-product-or-subject"
  | "epoch-not-higher"
  | "new-expired";

/** §15.3 "Held ring and replacement". An expired held ring counts as no ring at all. */
export function refRingReplace(
  heldJws: string | null,
  newJws: string,
  trust: Record<string, string>,
  o: { expectedAud: string; now: number },
): { replace: true } | { replace: false; reason: ReplaceReason } {
  const next = refRing(newJws, trust, o);
  if (!next.ok) return { replace: false, reason: "new-rejected" };
  const R = refLiveRing(heldJws, trust, o);
  if (R !== null) {
    if (next.ring.sub !== R.sub)
      return { replace: false, reason: "other-product-or-subject" };
    if (next.ring.epoch <= R.epoch)
      return { replace: false, reason: "epoch-not-higher" };
  }
  if (refRingExpired(next.ring, o.now))
    return { replace: false, reason: "new-expired" };
  return { replace: true };
}

export type AdmissionVerdict =
  | { admit: true; ringSync: "none" | "request" }
  | { admit: false; reason: "cert-invalid" | "peer_revoked" };

/** §15.3 "Peer admission". The held ring is read as in replacement: expired means none. */
export function refAdmission(
  certJws: string,
  heldJws: string | null,
  trust: Record<string, string>,
  o: { expectedAud: string; now: number },
): AdmissionVerdict {
  const c = refPeerCert(certJws, trust, o);
  if (!c.ok) return { admit: false, reason: "cert-invalid" };
  const R = refLiveRing(heldJws, trust, o);
  if (R === null) return { admit: true, ringSync: "none" };
  if (R.epoch > c.cert.ringEpoch) {
    const listed = R.devices.some(
      (e) =>
        e.deviceId === c.cert.deviceId &&
        e.signKey === c.cert.signKey &&
        e.agreeKey === c.cert.agreeKey,
    );
    return listed
      ? { admit: true, ringSync: "none" }
      : { admit: false, reason: "peer_revoked" };
  }
  return {
    admit: true,
    ringSync: c.cert.ringEpoch > R.epoch ? "request" : "none",
  };
}
