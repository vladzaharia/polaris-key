// WIRE-CONTRACT-V5 §15.2 and §15.3: the device certificate (`pkey-peer+jws`), the roster
// (`pkey-ring+jws`), roster replacement and peer admission. Pure functions over bytes and a
// clock; nothing here does I/O or throws. Both documents are signed by the product key and
// verified against the effective product set (§1). A failing check names the step that refused
// it, in the order §15.2 lists them.

import {
  base64UrlDecode,
  isAcceptableEd25519Point,
  isCanonicalB64url,
  isX25519LowOrder,
  verifyJws,
  type NonWireIntegers,
  type TrustSet,
} from "@polaris-key/jws";
import { ISSUER } from "@polaris-key/protocol/core";
import {
  MAX_PEER_CERT_SECONDS,
  MAX_RING_DEVICES,
  PEER_CERT_TYP,
  PEER_DEVICE_ID_PATTERN,
  PEER_KEY_PATTERN,
  RING_SECONDS,
  RING_TYP,
  type PeerCertDoc,
  type PeerDeviceKeys,
  type RingDoc,
} from "@polaris-key/protocol/connect";
import { CLOCK_SKEW_SECONDS, isWireInteger } from "../claims.js";

const SUB_RE = /^ps_[A-Za-z0-9_-]{22}$/;
const DEVICE_RE = new RegExp(PEER_DEVICE_ID_PATTERN);
const KEY_RE = new RegExp(PEER_KEY_PATTERN);

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

/** A canonical base64url string of exactly 32 bytes, decoded; null otherwise. */
function keyBytes(v: unknown): Uint8Array | null {
  if (typeof v !== "string" || !KEY_RE.test(v) || !isCanonicalB64url(v))
    return null;
  const b = base64UrlDecode(v);
  return b.length === 32 ? b : null;
}

/** §15.2 step 4 for one `(signKey, agreeKey)` pair. */
function keysOk(signKey: unknown, agreeKey: unknown): boolean {
  const s = keyBytes(signKey);
  const a = keyBytes(agreeKey);
  return (
    s !== null &&
    a !== null &&
    isAcceptableEd25519Point(s) &&
    !isX25519LowOrder(a)
  );
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** A verified device certificate's claims. */
export type PeerCert = Pick<
  PeerCertDoc,
  | "sub"
  | "deviceId"
  | "signKey"
  | "agreeKey"
  | "ringEpoch"
  | "issuedAt"
  | "expiresAt"
>;

/** The step that refused a certificate, in §15.2's order. */
export type PeerCertRefusal =
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

/**
 * §15.2 step 7: the Noise session the certificate is shown in. Mode `a` (the same account)
 * also names the verifier's own subject and device id; modes `v` and `p` check the key only.
 */
export interface PeerSession {
  mode: "a" | "v" | "p";
  /** The Noise remote static key, canonical base64url. */
  remoteStatic: string;
  ownSub?: string;
  ownDeviceId?: string;
}

export interface VerifyPeerCertOptions {
  /** The effective product set. */
  trust: TrustSet;
  /** The app's product: `aud` must equal it. */
  expectedAud: string;
  /** The effective clock (§4.2), in seconds. Defaults to the system clock. */
  now?: number;
  /** Omit to check the certificate alone (steps 1 to 6). */
  session?: PeerSession;
}

export type VerifyPeerCertResult =
  | { ok: true; cert: PeerCert }
  | { ok: false; reason: PeerCertRefusal };

const certFail = (reason: PeerCertRefusal): VerifyPeerCertResult => ({
  ok: false,
  reason,
});

/** An integer claim: a plain integer token of at least `min` (§3.1). */
const intClaim = (
  d: Record<string, unknown>,
  name: string,
  min: number,
  nonWire: NonWireIntegers,
): boolean => isWireInteger(d[name], `/${name}`, min, nonWire);

/** §15.2 steps 1 to 7, in order; the first failing step names the reason. */
export async function verifyPeerCert(
  jws: string,
  opts: VerifyPeerCertOptions,
): Promise<VerifyPeerCertResult> {
  const v = await verifyJws<PeerCertDoc>(jws, opts.trust, {
    typ: PEER_CERT_TYP,
  });
  if (!v || !isObject(v.payload)) return certFail("jws-rejected");
  const d = v.payload as unknown as Record<string, unknown>;
  if (d.iss !== ISSUER || d.aud !== opts.expectedAud)
    return certFail("issuer-or-audience");
  const nonWire = v.nonWireIntegers;
  if (
    !intClaim(d, "ringEpoch", 1, nonWire) ||
    !intClaim(d, "issuedAt", 0, nonWire) ||
    !intClaim(d, "expiresAt", 0, nonWire)
  )
    return certFail("integer");
  if (
    typeof d.sub !== "string" ||
    !SUB_RE.test(d.sub) ||
    typeof d.deviceId !== "string" ||
    !DEVICE_RE.test(d.deviceId)
  )
    return certFail("subject-or-device");
  if (!keysOk(d.signKey, d.agreeKey)) return certFail("keys");
  const iat = d.issuedAt as number;
  const exp = d.expiresAt as number;
  if (exp - iat < 1 || exp - iat > MAX_PEER_CERT_SECONDS)
    return certFail("lifetime");
  const now = opts.now ?? nowSeconds();
  if (iat > now + CLOCK_SKEW_SECONDS || now > exp + CLOCK_SKEW_SECONDS)
    return certFail("clock");
  const s = opts.session;
  if (s) {
    if (s.mode === "a") {
      if (d.sub !== s.ownSub) return certFail("sub-mismatch");
      if (d.deviceId === s.ownDeviceId) return certFail("own-device");
    }
    if (d.agreeKey !== s.remoteStatic) return certFail("static-mismatch");
  }
  const cert = {} as Record<string, unknown>;
  for (const k of CERT_FIELDS) cert[k] = d[k];
  return { ok: true, cert: cert as unknown as PeerCert };
}

const CERT_FIELDS = [
  "sub",
  "deviceId",
  "signKey",
  "agreeKey",
  "ringEpoch",
  "issuedAt",
  "expiresAt",
] as const;

/** A verified roster's claims. */
export type Ring = Pick<
  RingDoc,
  "sub" | "epoch" | "issuedAt" | "expiresAt" | "devices"
>;

/** The check that refused a roster. */
export type RingRefusal =
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

export interface VerifyRingOptions {
  trust: TrustSet;
  expectedAud: string;
}

export type VerifyRingResult =
  | { ok: true; ring: Ring }
  | { ok: false; reason: RingRefusal };

const ringFail = (reason: RingRefusal): VerifyRingResult => ({
  ok: false,
  reason,
});

/** Ascending order of the UTF-8 bytes (a device id is ASCII, so code units agree). */
const byteLess = (a: string, b: string): boolean => a < b;

/** §15.3: the roster's own checks. The clock is a separate question (`ringExpired`). */
export async function verifyRing(
  jws: string,
  opts: VerifyRingOptions,
): Promise<VerifyRingResult> {
  const v = await verifyJws<RingDoc>(jws, opts.trust, { typ: RING_TYP });
  if (!v || !isObject(v.payload)) return ringFail("jws-rejected");
  const d = v.payload as unknown as Record<string, unknown>;
  if (d.iss !== ISSUER || d.aud !== opts.expectedAud)
    return ringFail("issuer-or-audience");
  const nonWire = v.nonWireIntegers;
  if (
    !intClaim(d, "epoch", 1, nonWire) ||
    !intClaim(d, "issuedAt", 0, nonWire) ||
    !intClaim(d, "expiresAt", 0, nonWire)
  )
    return ringFail("integer");
  if (typeof d.sub !== "string" || !SUB_RE.test(d.sub))
    return ringFail("subject");
  const span = (d.expiresAt as number) - (d.issuedAt as number);
  if (span < 1 || span > RING_SECONDS) return ringFail("lifetime");
  const devices = d.devices;
  if (
    !Array.isArray(devices) ||
    devices.length < 1 ||
    devices.length > MAX_RING_DEVICES
  )
    return ringFail("devices-size");
  for (const e of devices) {
    if (
      !isObject(e) ||
      typeof e.deviceId !== "string" ||
      !DEVICE_RE.test(e.deviceId)
    )
      return ringFail("device");
    if (!keysOk(e.signKey, e.agreeKey)) return ringFail("keys");
  }
  const list = devices as PeerDeviceKeys[];
  const order = idOrderRefusal(list.map((e) => e.deviceId));
  if (order) return ringFail(order);
  for (const f of ["signKey", "agreeKey"] as const)
    if (new Set(list.map((e) => e[f])).size !== list.length)
      return ringFail("duplicate-key");
  const ring = {} as Record<string, unknown>;
  for (const k of [...RING_SCALARS, "devices"]) ring[k] = d[k];
  return { ok: true, ring: ring as unknown as Ring };
}

const RING_SCALARS = ["sub", "epoch", "issuedAt", "expiresAt"] as const;

/** Device ids must ascend strictly: an equal neighbour is a duplicate, a lower one unsorted. */
function idOrderRefusal(ids: string[]): "duplicate-id" | "unsorted" | null {
  for (let k = 1; k < ids.length; k++) {
    if (ids[k] === ids[k - 1]) return "duplicate-id";
    if (!byteLess(ids[k - 1]!, ids[k]!)) return "unsorted";
  }
  return null;
}

/**
 * §15.3: a roster is expired once `now > expiresAt + 300`, the clock rule of the certificate
 * (`CLOCK_SKEW_SECONDS`).
 */
export const ringExpired = (
  ring: { expiresAt: number },
  now: number = nowSeconds(),
): boolean => now > ring.expiresAt + CLOCK_SKEW_SECONDS;

export interface RingContext extends VerifyRingOptions {
  now?: number;
}

/** The held ring, or null when there is none, it does not verify, or it is expired. */
async function liveRing(
  heldJws: string | null,
  o: RingContext,
): Promise<Ring | null> {
  if (heldJws === null) return null;
  const held = await verifyRing(heldJws, o);
  return held.ok && !ringExpired(held.ring, o.now) ? held.ring : null;
}

export type RingReplaceRefusal =
  | "new-rejected"
  | "other-product-or-subject"
  | "epoch-not-higher"
  | "new-expired";

/**
 * §15.3 "Held ring and replacement": the held ring is replaced only by a roster that verifies,
 * has the same `aud` and `sub`, a higher epoch and is not expired. An expired held ring counts
 * as no ring at all.
 */
export async function replaceRing(
  heldJws: string | null,
  newJws: string,
  opts: RingContext,
): Promise<
  { replace: true; ring: Ring } | { replace: false; reason: RingReplaceRefusal }
> {
  const next = await verifyRing(newJws, opts);
  if (!next.ok) return { replace: false, reason: "new-rejected" };
  const held = await liveRing(heldJws, opts);
  if (held !== null) {
    if (next.ring.sub !== held.sub)
      return { replace: false, reason: "other-product-or-subject" };
    if (next.ring.epoch <= held.epoch)
      return { replace: false, reason: "epoch-not-higher" };
  }
  if (ringExpired(next.ring, opts.now))
    return { replace: false, reason: "new-expired" };
  return { replace: true, ring: next.ring };
}

/**
 * §15.3 "Peer admission". `ringSync: "request"` means the certificate is on a newer epoch than
 * the held roster: ask the peer for `RING`.
 */
export type PeerAdmission =
  | { admit: true; cert: PeerCert; ringSync: "none" | "request" }
  | { admit: false; reason: "cert-invalid" | "peer_revoked" };

export async function admitPeer(
  certJws: string,
  heldRingJws: string | null,
  opts: VerifyPeerCertOptions,
): Promise<PeerAdmission> {
  const c = await verifyPeerCert(certJws, opts);
  if (!c.ok) return { admit: false, reason: "cert-invalid" };
  const ring = await liveRing(heldRingJws, opts);
  if (ring === null) return { admit: true, cert: c.cert, ringSync: "none" };
  // A certificate of another account is judged by the session's own checks, never by this ring's
  // epoch: its numbers belong to a different roster.
  if (c.cert.sub !== ring.sub) {
    return { admit: false, reason: "cert-invalid" };
  }
  if (ring.epoch > c.cert.ringEpoch) {
    const listed = ring.devices.some(
      (e) =>
        e.deviceId === c.cert.deviceId &&
        e.signKey === c.cert.signKey &&
        e.agreeKey === c.cert.agreeKey,
    );
    return listed
      ? { admit: true, cert: c.cert, ringSync: "none" }
      : { admit: false, reason: "peer_revoked" };
  }
  return {
    admit: true,
    cert: c.cert,
    ringSync: c.cert.ringEpoch > ring.epoch ? "request" : "none",
  };
}
