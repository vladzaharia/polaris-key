// WIRE-CONTRACT-V5 §15.6.1: the codecs and rules of mode v, the vouch. Pure: no I/O, no clock the
// caller does not hand in, no route. D is the device with no sign-in (the initiator); M is the
// signed-in device nearby (the responder). The vectors are `peer-matrix.json` `vouch`.
//
// What lives here: the `VOUCH_REQ` body (build, parse, verify), the `VOUCH_RESULT` body, M's
// reading of the `nearby/approve` answer (`finishMap`), the number-matching decoys (`decoyCodes`),
// the approver's advert instance, the failure budget, and `VouchFlow`, the order guard both ends
// run over the records of one session. What does not: the session itself (`session.ts`), the
// routes, the adverts' sockets and the prompt. Failures carry a close code and never a value: the
// request handle, `sig`, `h`, the nonces and the one-time keys appear in no message here.

import {
  base64UrlDecode,
  base64UrlEncodeBytes,
  isAcceptableEd25519Point,
  isCanonicalB64url,
  isX25519LowOrder,
} from "@polaris-key/jws";
import { verifyDeviceProof } from "../deviceProof.js";
import { signDeviceProof, type DeviceKeyPort } from "../deviceKeys.js";
import type { RandomBytes } from "../identityRedirect.js";
import { base32Lower } from "./advert.js";
import { cleanLabel, cleanPlatform } from "./display.js";
import { capsIntersection, parseStrictObject } from "./payload.js";
import { RECORD, type PeerCloseCode } from "./record.js";

/** The capability both mode-v payloads list (rule 1). */
export const VOUCH_CAP = "vouch/1";
/** A `VOUCH_REQ` body is at most this many bytes (rule 5). */
export const VOUCH_REQ_MAX = 4096;
/** Rule 12: records D holds before its person confirms the account. */
export const VOUCH_HELD_RECORDS = 16;
export const VOUCH_HELD_BYTES = 16 * 1024;
/** Rule 2: the advert's listener and instance are renewed this often. */
export const APPROVER_RENEW_SECONDS = 300;
/** Rule 2: this many prompted failures within the window stop the advert. */
export const VOUCH_FAILURE_LIMIT = 2;
export const VOUCH_FAILURE_WINDOW_SECONDS = 600;

const REQUEST_RE = /^nr_[A-Za-z0-9_-]{22}$/;
const DEVICE_RE = /^[A-Za-z0-9_-]{32}$/;
const P25519 = (1n << 255n) - 19n;
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

/** A canonical base64url of 32 bytes, decoded, or null. */
function key32(v: unknown): Uint8Array | null {
  if (typeof v !== "string" || v.length !== 43 || !isCanonicalB64url(v))
    return null;
  const b = base64UrlDecode(v);
  return b.length === 32 ? b : null;
}

/** The one X25519 spelling the Worker registers: bit 255 clear and u below p (§15.8). */
function agreeSpelling(k: Uint8Array): boolean {
  if ((k[31]! & 0x80) !== 0) return false;
  let u = 0n;
  for (let i = 31; i >= 0; i--) u = (u << 8n) | BigInt(k[i]!);
  return u < P25519;
}

// ── VOUCH_REQ ───────────────────────────────────────────────────────────────

/** What D's `HELLO` showed (display data), as M holds it. */
export interface VouchHello {
  label?: string;
  platform: string;
}

/** A verified request: exactly what M sends to `nearby/approve` (rule 5). */
export interface VouchRequest {
  request: string;
  deviceId: string;
  signKey: string;
  agreeKey: string;
  label: string | null;
  platform: string;
}

export interface BuildVouchRequestOptions {
  /** D's device keys; the proof is signed by its `signKey`. */
  port: DeviceKeyPort;
  slug: string;
  /** This session's Noise handshake hash. */
  h: Uint8Array;
  /** The handle from `nearby/start`. */
  request: string;
  /** The `X-PKey-Device` value sent on `start`. */
  deviceId: string;
  /** The same `label` and `platform` D's `HELLO` carried. */
  hello: VouchHello;
}

/** The `VOUCH_REQ` body D sends after it showed the code (rule 5). Throws on a malformed input. */
export async function buildVouchRequest(
  o: BuildVouchRequestOptions,
): Promise<Uint8Array> {
  if (o.h.length !== 32 || !REQUEST_RE.test(o.request))
    throw new RangeError("vouch request: bad input");
  if (!DEVICE_RE.test(o.deviceId))
    throw new RangeError("vouch request: bad input");
  const proof = await signDeviceProof(o.port, {
    purpose: "vouch",
    product: o.slug,
    deviceId: o.deviceId,
    value: `${base64UrlEncodeBytes(o.h)}.${o.request}`,
  });
  const keys = await o.port.publicKeys();
  if (keys === null || keys.signKey !== proof.signKey)
    throw new RangeError("vouch request: keys changed");
  const body = utf8(
    JSON.stringify({
      v: 1,
      request: o.request,
      deviceId: o.deviceId,
      signKey: keys.signKey,
      agreeKey: keys.agreeKey,
      ...(o.hello.label !== undefined ? { label: o.hello.label } : {}),
      platform: o.hello.platform,
      sig: proof.sig,
    }),
  );
  if (body.length > VOUCH_REQ_MAX)
    throw new RangeError("vouch request: too large");
  return body;
}

/** A `VOUCH_REQ` body that passed every check that needs no session (rule 5), signature unread. */
export interface ParsedVouchRequest {
  request: string;
  deviceId: string;
  signKey: string;
  agreeKey: string;
  label: string | null;
  platform: string;
  /** Unverified until `verifyVouchRequest`. */
  sig: string;
}

/** Strict JSON, size, shape and key checks; `null` means close `peer_bad_frame`. */
export function parseVouchRequest(body: Uint8Array): ParsedVouchRequest | null {
  if (body.length > VOUCH_REQ_MAX) return null;
  const o = parseStrictObject(body);
  if (o === null || o.v !== 1) return null;
  const { request, deviceId, signKey, agreeKey, label, platform, sig } = o;
  if (typeof request !== "string" || !REQUEST_RE.test(request)) return null;
  if (typeof deviceId !== "string" || !DEVICE_RE.test(deviceId)) return null;
  const sk = key32(signKey);
  if (sk === null || !isAcceptableEd25519Point(sk)) return null;
  const ak = key32(agreeKey);
  if (ak === null || isX25519LowOrder(ak) || !agreeSpelling(ak)) return null;
  if (label !== undefined && typeof label !== "string") return null;
  if (typeof platform !== "string" || typeof sig !== "string") return null;
  return {
    request,
    deviceId,
    signKey: signKey as string,
    agreeKey: agreeKey as string,
    label: label === undefined ? null : cleanLabel(label),
    platform: cleanPlatform(platform),
    sig,
  };
}

export interface VerifyVouchRequestOptions {
  slug: string;
  /** This session's Noise handshake hash: the proof binds one session. */
  h: Uint8Array;
  /** What D's `HELLO` showed; the request must show the same after cleaning. */
  hello: VouchHello;
  body: Uint8Array;
}

/**
 * M's whole check of a `VOUCH_REQ` (rule 5): the parse, the proof over this session's `h`, and
 * the equality of `label` and `platform` with `HELLO`. `null` means close `peer_bad_frame` and
 * call no route.
 */
export async function verifyVouchRequest(
  o: VerifyVouchRequestOptions,
): Promise<VouchRequest | null> {
  const p = parseVouchRequest(o.body);
  if (p === null) return null;
  const proven = await verifyDeviceProof({
    purpose: "vouch",
    product: o.slug,
    deviceId: p.deviceId,
    value: `${base64UrlEncodeBytes(o.h)}.${p.request}`,
    tokenHash: "-",
    signKey: p.signKey,
    sig: p.sig,
  });
  if (!proven) return null;
  const helloLabel =
    o.hello.label === undefined ? null : cleanLabel(o.hello.label);
  if (p.label !== helloLabel) return null;
  if (p.platform !== cleanPlatform(o.hello.platform)) return null;
  const { sig: _sig, ...shown } = p;
  return shown;
}

// ── VOUCH_RESULT ────────────────────────────────────────────────────────────

export type VouchStatus = "approved" | "denied" | "expired";
const STATUSES: readonly string[] = ["approved", "denied", "expired"];

/** The `VOUCH_RESULT` body M sends. */
export const buildVouchResult = (status: VouchStatus): Uint8Array =>
  utf8(JSON.stringify({ status }));

/**
 * D's reading of a `VOUCH_RESULT` (rule 6): display data only. An unknown status reads as
 * `denied`; a body that is not an object with a string `status` closes `peer_bad_frame`.
 */
export function parseVouchResult(
  body: Uint8Array,
): { status: VouchStatus } | { refuse: "peer_bad_frame" } {
  const o = parseStrictObject(body);
  if (o === null || typeof o.status !== "string")
    return { refuse: "peer_bad_frame" };
  return {
    status: STATUSES.includes(o.status) ? (o.status as VouchStatus) : "denied",
  };
}

// ── M reads the answer of nearby/approve ────────────────────────────────────

export interface ApproveAnswer {
  /** The HTTP status, or null when there was no answer. */
  http: number | null;
  /** The body text, or null when none. */
  body: string | null;
  /** M's fresh read: does discovery still name `nearby` and `nearbyApprove`? */
  discoveryNearby: boolean;
  /** True once M already answered a `device_keys_required` by registering its keys. */
  keysRetried: boolean;
}

export type FinishAction =
  /** Send this `VOUCH_RESULT`. After any status but `approved`, close `peer_bye`. */
  | { send: VouchStatus }
  /** Nothing yet: show the licence choice, or register keys (§15.8), then call again. */
  | { wait: "choice" | "keys" }
  /** Send nothing and close `peer_bye`; `stopAdvert` when discovery lost `nearby`. */
  | { close: true; stopAdvert: boolean };

/** Rule 6's table. Anything it does not list closes. */
export function finishMap(r: ApproveAnswer): FinishAction {
  const stop = (stopAdvert = false): FinishAction => ({
    close: true,
    stopAdvert,
  });
  if (r.http === null) return stop();
  const o = r.body === null ? null : parseStrictObject(utf8(r.body));
  const code = typeof o?.code === "string" ? o.code : null;
  switch (r.http) {
    case 200:
      if (o?.status === "approved") return { send: "approved" };
      return o?.status === "choose" ? { wait: "choice" } : stop();
    case 204:
      return { send: "denied" };
    case 403:
      // D hears `denied` for both, so a session holder cannot tell which refusal an account hit.
      return code === "not_nearby" || code === "device_limit"
        ? { send: "denied" }
        : stop();
    case 404:
      // The 404 is ambiguous (rule 6): `expired` only while discovery still names the routes.
      return r.discoveryNearby ? { send: "expired" } : stop(true);
    case 409:
      if (code === "device_keys_required")
        return r.keysRetried ? stop() : { wait: "keys" };
      return code === "license_choice_required" ? { wait: "choice" } : stop();
    default:
      return stop();
  }
}

// ── randomness: decoys, positions and the advert instance ───────────────────

/** Default `crypto.getRandomValues`; a test injects a fixed source. */
const systemRandom: RandomBytes = (n) =>
  globalThis.crypto.getRandomValues(new Uint8Array(n));

/** Draws that may be rejected before a generator that cannot produce a value is given up on. */
const MAX_DRAWS = 256;

/** A uniform integer in [0, n) by rejection sampling over 32-bit draws; never `x % n` alone. */
function uniformBelow(n: number, random: RandomBytes): number {
  const limit = Math.floor(2 ** 32 / n) * n;
  for (let i = 0; i < MAX_DRAWS; i++) {
    const b = random(4);
    const x = new DataView(b.buffer, b.byteOffset, 4).getUint32(0);
    if (x < limit) return x % n;
  }
  throw new RangeError("vouch: random source");
}

export interface DecoyCodes {
  /** Three distinct codes, each in [0, 10^6), the real one among them. */
  codes: [number, number, number];
  /** Where the real code stands in `codes`. */
  index: number;
}

/**
 * The three codes M shows (rule 4): the session's `real` code and two decoys by rejection
 * sampling, distinct, and the real one at a uniform position by a partial Fisher-Yates shuffle.
 */
export function decoyCodes(
  real: number,
  random: RandomBytes = systemRandom,
): DecoyCodes {
  if (!Number.isInteger(real) || real < 0 || real >= 1_000_000)
    throw new RangeError("vouch: code");
  const slots: { code: number; real: boolean }[] = [{ code: real, real: true }];
  // A source that keeps repeating a code is given up on, not looped on.
  for (let tries = 0; slots.length < 3; tries++) {
    if (tries >= MAX_DRAWS) throw new RangeError("vouch: random source");
    const code = uniformBelow(1_000_000, random);
    if (!slots.some((s) => s.code === code)) slots.push({ code, real: false });
  }
  for (let i = 2; i > 0; i--) {
    const j = uniformBelow(i + 1, random);
    [slots[i], slots[j]] = [slots[j]!, slots[i]!];
  }
  return {
    codes: [slots[0]!.code, slots[1]!.code, slots[2]!.code],
    index: slots.findIndex((s) => s.real),
  };
}

/** The approver's advert instance (rule 2): `p1-` and 10 CSPRNG bytes in base32, 16 characters. */
export const approverInstance = (random: RandomBytes = systemRandom): string =>
  `p1-${base32Lower(random(10))}`;

// ── the failure budget (rule 2) ─────────────────────────────────────────────

/**
 * M counts the failures of sessions whose prompt was shown (a wrong pick, "None of these match",
 * a 120 s timeout) against a monotonic clock. The second within 10 minutes stops the advert, and
 * it stays stopped until the person reopens "Approve a nearby device". A session that was only
 * queued, or shown the passive notice, counts for nothing: the caller does not report it.
 */
export class VouchFailureBudget {
  private at: number[] = [];
  private halted = false;
  /** `mono` is monotonic seconds. */
  constructor(private readonly mono: () => number) {}

  /** Record one failure; true when the advert must stop now. */
  fail(): boolean {
    const now = this.mono();
    this.at = this.at.filter((t) => now - t < VOUCH_FAILURE_WINDOW_SECONDS);
    this.at.push(now);
    if (this.at.length >= VOUCH_FAILURE_LIMIT) this.halted = true;
    return this.halted;
  }

  /** True while the advert must stay off. */
  get stopped(): boolean {
    return this.halted;
  }

  /** The person reopened "Approve a nearby device": the count starts again. */
  reopen(): void {
    this.at = [];
    this.halted = false;
  }
}

// ── the order guard (rules 1, 4, 5, 7, 8, 12) ───────────────────────────────

export interface VouchRecord {
  type: number;
  body: Uint8Array;
}

export type VouchVerdict<R extends VouchRecord = VouchRecord> =
  | {
      ok: true;
      /** Records to hand on now: this one, or ones held earlier, in order. May be empty. */
      deliver: R[];
    }
  | { ok: false; close: PeerCloseCode };

export type VouchRole = "requester" | "approver";
export type AbandonReason = "wrong-pick" | "none-match" | "stop" | "timeout";

const isSync = (t: number): boolean => t >= 0x0030 && t <= 0x003f;

/**
 * One end's order guard over the vouch records of one session. D is the `requester`, M the
 * `approver`. Every record is checked in both directions: `receive` for what arrives, `send` for
 * what this end is about to send, with the same codes (rule 7). After a close verdict the flow is
 * dead and answers with that code again.
 *
 * - `VOUCH_REQ`: D to M, once, after D showed the code. M's flow holds it until the person's
 *   right pick (`picked`), so a wrong pick, "None of these match", a timeout or a stop (`abandon`)
 *   never delivers it.
 * - `VOUCH_RESULT`: M to D, at most once, after a verified `VOUCH_REQ`.
 * - `0x0030` to `0x003F`: M to D, only after an `approved` result; D holds them (16 records,
 *   16 KiB, then `peer_busy`) until its person confirms the account (`confirmAccount`, rule 12).
 *
 * No silent approval (rule 10): `mayFinish` is true only after the right pick and a verified
 * request, which is when `nearby/approve` may be called.
 */
export class VouchFlow<R extends VouchRecord = VouchRecord> {
  private dead: PeerCloseCode | null = null;
  private negotiated = false;
  private shown = false;
  private picked_ = false;
  private requestSeen = false;
  private requestSent = false;
  private held: R | null = null;
  private verified_ = false;
  private resultSent = false;
  private resultSeen = false;
  private status: VouchStatus | null = null;
  private confirmed = false;
  private queue: R[] = [];
  private queueBytes = 0;

  constructor(readonly role: VouchRole) {}

  private close(code: PeerCloseCode): { ok: false; close: PeerCloseCode } {
    this.dead ??= code;
    this.held = null;
    this.queue = [];
    this.queueBytes = 0;
    return { ok: false, close: this.dead };
  }

  private get gone(): { ok: false; close: PeerCloseCode } | null {
    return this.dead === null ? null : { ok: false, close: this.dead };
  }

  /** Rule 1: both payloads list `vouch/1`; call once, when the session is `established`. */
  negotiate(
    local: readonly string[],
    remote: readonly string[],
  ): VouchVerdict<R> {
    if (this.gone) return this.gone;
    if (!capsIntersection(local, remote).includes(VOUCH_CAP))
      return this.close("peer_not_allowed");
    this.negotiated = true;
    return { ok: true, deliver: [] };
  }

  /** This side's screen shows the code (D: the code; M: the three codes). */
  codeShown(): void {
    this.shown = true;
  }

  /** M: the person picked the code D shows. Hands over the held request, if it arrived. */
  picked(): VouchVerdict<R> {
    if (this.gone) return this.gone;
    if (this.role !== "approver" || !this.negotiated || !this.shown)
      return this.close("peer_not_allowed");
    this.picked_ = true;
    const out = this.held === null ? [] : [this.held];
    this.held = null;
    return { ok: true, deliver: out };
  }

  /** M: the session ends before a right pick; the request is never delivered (rule 4). */
  abandon(reason: AbandonReason): VouchVerdict<R> {
    return this.close(reason === "timeout" ? "peer_timeout" : "peer_bye");
  }

  /** M: the delivered request verified (`verifyVouchRequest`). */
  verified(): void {
    if (this.picked_ && this.requestSeen) this.verified_ = true;
  }

  /** M: may `nearby/approve` be called for this session? (rule 10; N12) */
  get mayFinish(): boolean {
    return (
      this.dead === null &&
      this.verified_ &&
      !this.resultSent &&
      this.role === "approver"
    );
  }

  /** D: the person confirmed the signed-in account; held records are handed over (rule 12). */
  confirmAccount(): VouchVerdict<R> {
    if (this.gone) return this.gone;
    this.confirmed = true;
    const out = this.queue;
    this.queue = [];
    this.queueBytes = 0;
    return { ok: true, deliver: out };
  }

  /** D: the person declined, or the screen timed out: every held record is dropped (rule 12). */
  declineAccount(): VouchVerdict<R> {
    return this.close("peer_bye");
  }

  /** A record arrived from the peer. */
  receive(r: R): VouchVerdict<R> {
    if (this.gone) return this.gone;
    if (r.type === RECORD.VOUCH_REQ) return this.receiveRequest(r);
    if (r.type === RECORD.VOUCH_RESULT) return this.receiveResult(r);
    if (isSync(r.type)) return this.receiveSync(r);
    return { ok: true, deliver: [r] };
  }

  private receiveRequest(r: R): VouchVerdict<R> {
    if (this.role !== "approver" || !this.negotiated)
      return this.close("peer_not_allowed");
    if (this.requestSeen) return this.close("peer_bad_frame");
    this.requestSeen = true;
    if (this.picked_) return { ok: true, deliver: [r] };
    this.held = r;
    return { ok: true, deliver: [] };
  }

  private receiveResult(r: R): VouchVerdict<R> {
    if (this.role !== "requester" || !this.negotiated || !this.requestSent)
      return this.close("peer_not_allowed");
    if (this.resultSeen) return this.close("peer_bad_frame");
    const got = parseVouchResult(r.body);
    if ("refuse" in got) return this.close(got.refuse);
    this.resultSeen = true;
    this.status = got.status;
    return { ok: true, deliver: [r] };
  }

  private receiveSync(r: R): VouchVerdict<R> {
    if (
      this.role !== "requester" ||
      !this.negotiated ||
      this.status !== "approved"
    )
      return this.close("peer_not_allowed");
    if (this.confirmed) return { ok: true, deliver: [r] };
    if (
      this.queue.length >= VOUCH_HELD_RECORDS ||
      this.queueBytes + r.body.length > VOUCH_HELD_BYTES
    )
      return this.close("peer_busy");
    this.queue.push(r);
    this.queueBytes += r.body.length;
    return { ok: true, deliver: [] };
  }

  /** This end is about to send a record. The sender's checks are the receiver's. */
  send(r: R): VouchVerdict<R> {
    if (this.gone) return this.gone;
    if (r.type === RECORD.VOUCH_REQ) {
      if (this.role !== "requester" || !this.negotiated || !this.shown)
        return this.close("peer_not_allowed");
      if (this.requestSent) return this.close("peer_bad_frame");
      this.requestSent = true;
      return { ok: true, deliver: [r] };
    }
    if (r.type === RECORD.VOUCH_RESULT) {
      if (this.role !== "approver" || !this.verified_)
        return this.close("peer_not_allowed");
      if (this.resultSent) return this.close("peer_bad_frame");
      const got = parseVouchResult(r.body);
      if ("refuse" in got) return this.close(got.refuse);
      this.resultSent = true;
      this.status = got.status;
      return { ok: true, deliver: [r] };
    }
    if (isSync(r.type)) {
      if (this.role !== "approver" || this.status !== "approved")
        return this.close("peer_not_allowed");
      return { ok: true, deliver: [r] };
    }
    return { ok: true, deliver: [r] };
  }
}
