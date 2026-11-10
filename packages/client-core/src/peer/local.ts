// WIRE-CONTRACT-V5 §15.12: local links (account-free pairing). Pure functions and small machines,
// no I/O: the code and its nameplate, the QR, the adverts, the `LOCAL_LINK` body, the link secret,
// the handshake capabilities, the joiner, the pairing window, the exchange guard, the pin, the
// trial order and the gate. The vectors are `peer-matrix.json` `local`; the session (`session.ts`)
// runs modes `q` and `l` over them, and CPace itself is `cpace.ts`.
//
// A password, a QR secret and a link secret are key material: nothing here logs one or returns one
// inside an error. Time comes in as arguments (a monotonic clock, in seconds, for the window), so a
// machine never reads a clock of its own.

import { advertEpoch, base32Lower, isInstanceName } from "./advert.js";
import { validCats } from "./contact.js";
import { cleanLabel } from "./display.js";
import { hkdfSha256, hmac } from "./noise.js";
import { capsIntersection, parseStrictObjectScanned } from "./payload.js";

// ── Constants (§15.12) ───────────────────────────────────────────────────────────────────────

/** A pairing window stays open at most this long. */
export const LOCAL_PAIR_SECONDS = 300;
/** A code is 8 digits: a 2-digit nameplate and a 6-digit password. */
export const LOCAL_CODE_DIGITS = 8;
/** The fifth failed guess closes the window. */
export const LOCAL_PAIR_FAILURES = 5;
export const LOCAL_QR_SECRET_BYTES = 16;
export const LOCAL_JOIN_CANDIDATES = 2;
export const LOCAL_JOIN_BROWSE_SECONDS = 15;
/** Local links one device holds for one product. */
export const MAX_LOCAL_LINKS = 32;
export const MAX_LIVE_LOCAL_ADVERTS = 8;
/** `MAX_CONTACT_SECRETS` (72) plus `MAX_LOCAL_LINKS`. */
export const MAX_LINK_SECRETS = 104;
/** The pairing window admits at most this many C1s in any `LOCAL_C1_WINDOW_SECONDS`. */
export const LOCAL_C1_PER_WINDOW = 5;
export const LOCAL_C1_WINDOW_SECONDS = 60;
/** From the first byte (C1 included) to the transport. */
export const LOCAL_ATTEMPT_SECONDS = 30;
/** The joiner keeps at most this many matching `m=q` names while it joins. */
export const LOCAL_JOIN_KEPT = 8;
export const LOCAL_LINK_BODY_MAX = 4096;
/** The mandatory capability of mode `q`. */
export const LOCAL_CAP = "local/1";

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const cat = (...p: Uint8Array[]): Uint8Array =>
  Uint8Array.from(p.flatMap((x) => Array.from(x)));
const u64be = (n: number): Uint8Array => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(n));
  return b;
};
const byteCompare = (a: Uint8Array, b: Uint8Array): number => {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return 0;
};

// ── The code (§15.12, "The code") ────────────────────────────────────────────────────────────

/**
 * A source of random bytes that answers null when it cannot supply `n` of them (a stream of fixed
 * bytes in a vector, or `getRandomValues`, which never runs out).
 */
export type DrawSource = (n: number) => Uint8Array | null;

/** `crypto.getRandomValues` as a `DrawSource`. */
export const randomByteSource: DrawSource = (n) =>
  globalThis.crypto.getRandomValues(new Uint8Array(n));

const two = (n: number): string => String(n).padStart(2, "0");

/**
 * The nameplate: one byte at a time, 200 or more drawn again, then mod 100, and a nameplate in
 * `inUse` drawn again unless all 100 are in use (then any is taken). Rejection sampling, so every
 * nameplate is equally likely. Null when the source runs out.
 */
export function drawNameplate(
  source: DrawSource,
  inUse: readonly string[] = [],
): string | null {
  const used = new Set(inUse);
  const all =
    used.size >= 100 && [...Array(100).keys()].every((i) => used.has(two(i)));
  for (;;) {
    const b = source(1);
    if (b === null) return null;
    if (b[0]! >= 200) continue;
    const n = two(b[0]! % 100);
    if (!all && used.has(n)) continue;
    return n;
  }
}

/**
 * The password: a u32be of 4 bytes, drawn again at 4 294 000 000 or more, then mod 10^6, written
 * with leading zeros. Null when the source runs out.
 */
export function drawPassword(source: DrawSource): string | null {
  for (;;) {
    const b = source(4);
    if (b === null) return null;
    const n = new DataView(b.buffer, b.byteOffset, 4).getUint32(0, false);
    if (n >= 4_294_000_000) continue;
    return String(n % 1_000_000).padStart(6, "0");
  }
}

/** `4812 3456`: two groups of four, one space. */
export function displayCode(nameplate: string, password: string): string {
  const digits = nameplate + password;
  if (!/^[0-9]{8}$/.test(digits)) throw new RangeError("code");
  return `${digits.slice(0, 4)} ${digits.slice(4)}`;
}

export type CodeVerdict =
  | { ok: true; nameplate: string; password: string }
  | { ok: false };

/** A typed code: ASCII spaces and hyphens removed, then exactly 8 ASCII digits. */
export function parseCode(text: string): CodeVerdict {
  const digits = text.replace(/[ -]/g, "");
  return /^[0-9]{8}$/.test(digits)
    ? { ok: true, nameplate: digits.slice(0, 2), password: digits.slice(2) }
    : { ok: false };
}

// ── The QR (§15.12, "The QR") ────────────────────────────────────────────────────────────────

const B32 = "abcdefghijklmnopqrstuvwxyz234567";
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const asciiFold = (s: string): string =>
  s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));

/** The base32 characters of an instance after `p1-` (16) and of the QR secret (26). */
const INSTANCE_BODY_RE = /^[a-z2-7]{16}$/;
const SECRET_RE = /^[a-z2-7]{26}$/;

/** `PKP1:<SLUG>:<INSTANCE>:<SECRET>` in upper case. */
export function makeQr(
  slug: string,
  instance: string,
  secret: Uint8Array,
): string {
  if (!SLUG_RE.test(slug)) throw new RangeError("slug");
  if (!isInstanceName(instance)) throw new RangeError("instance");
  if (secret.length !== LOCAL_QR_SECRET_BYTES) throw new RangeError("secret");
  return `PKP1:${slug}:${instance.slice(3)}:${base32Lower(secret)}`.toUpperCase();
}

export type QrVerdict =
  | { result: "ok"; slug: string; instance: string; secret: Uint8Array }
  | { result: "other-app" }
  | { result: "invalid" };

/** The 16 bytes of 26 canonical base32 characters; null when the two unused low bits are set. */
function decodeSecret(chars: string): Uint8Array | null {
  const out = new Uint8Array(16);
  let acc = 0;
  let bits = 0;
  let at = 0;
  for (const c of chars) {
    acc = (acc << 5) | B32.indexOf(c);
    bits += 5;
    if (bits >= 8) {
      out[at++] = (acc >> (bits - 8)) & 0xff;
      bits -= 8;
      acc &= (1 << bits) - 1;
    }
  }
  return acc === 0 ? out : null;
}

/**
 * Read a scanned QR. ASCII case is folded and the text needs four fields split at `:`: `PKP1`, a
 * slug, 16 base32 characters and 26 canonical ones. A well-formed slug that is not `own` answers
 * `other-app`; everything else wrong is `invalid`, and the slug is judged last.
 */
export function parseQr(text: string, own: string): QrVerdict {
  const f = asciiFold(text).split(":");
  if (f.length !== 4 || f[0] !== "pkp1") return { result: "invalid" };
  const [, slug, instance, secret] = f as [string, string, string, string];
  if (!SLUG_RE.test(slug) || !INSTANCE_BODY_RE.test(instance))
    return { result: "invalid" };
  if (!SECRET_RE.test(secret)) return { result: "invalid" };
  const bytes = decodeSecret(secret);
  if (bytes === null) return { result: "invalid" };
  if (slug !== own) return { result: "other-app" };
  return { result: "ok", slug, instance: `p1-${instance}`, secret: bytes };
}

// ── The adverts (§15.12, "The pairing window" and "Mode l") ──────────────────────────────────

/** The `m=q` instance: `p1-` and the 16 base32 characters of the window's 10 random bytes. */
export function pairingInstance(sid: Uint8Array): string {
  if (sid.length !== 10) throw new RangeError("sid");
  return `p1-${base32Lower(sid)}`;
}

/**
 * The `m=l` instance of an advertiser in one epoch: `p1-` and the first 16 characters of the
 * lower-case base32 of `HMAC-SHA256(secret, "pkey-peer/1 ldisc" ‖ 0x00 ‖ u64be(epoch) ‖ key)`,
 * with the advertiser's own link key so the two devices of a link differ.
 */
export async function localInstance(
  secret: Uint8Array,
  advertiserLinkKey: Uint8Array,
  epoch: number,
): Promise<string> {
  const mac = await hmac(
    secret,
    cat(
      utf8("pkey-peer/1 ldisc"),
      Uint8Array.of(0),
      u64be(epoch),
      advertiserLinkKey,
    ),
  );
  return `p1-${base32Lower(mac).slice(0, 16)}`;
}

/** A link the device holds, as a browser tests it: its secret and the peer's link key. */
export interface LocalLinkKey {
  secret: Uint8Array;
  peerKey: Uint8Array;
}

export interface LocalHit {
  /** Index into the links as held. */
  link: number;
  /** 0 the current epoch, 1 the previous one. */
  epochBack: 0 | 1;
}

/**
 * Which held link an instance belongs to: the first of the first `MAX_LOCAL_LINKS`, in held order,
 * that matches in the current or the previous epoch. At most 64 HMACs.
 */
export async function browseLocalInstance(
  instance: string,
  links: readonly LocalLinkKey[],
  nowSeconds: number,
): Promise<LocalHit | null> {
  if (!isInstanceName(instance)) return null;
  const epoch = advertEpoch(nowSeconds);
  for (let i = 0; i < links.length && i < MAX_LOCAL_LINKS; i++)
    for (const epochBack of [0, 1] as const) {
      if (epoch - epochBack < 0) continue;
      if (
        (await localInstance(
          links[i]!.secret,
          links[i]!.peerKey,
          epoch - epochBack,
        )) === instance
      )
        return { link: i, epochBack };
    }
  return null;
}

export type LocalTxtResult =
  | { ok: true; mode: "l" }
  | { ok: false; reason: "duplicate" | "version" | "mode" };

/** `v=1` and `m=l`. Entries split as `parseTxt` splits them; `h` and `n` are not read. */
export function parseLocalTxt(entries: readonly string[]): LocalTxtResult {
  const kv = new Map<string, string>();
  for (const e of entries) {
    const at = e.indexOf("=");
    if (at < 1) continue;
    const k = e.slice(0, at);
    if (kv.has(k)) return { ok: false, reason: "duplicate" };
    kv.set(k, e.slice(at + 1));
  }
  if (kv.get("v") !== "1") return { ok: false, reason: "version" };
  if (kv.get("m") !== "l") return { ok: false, reason: "mode" };
  return { ok: true, mode: "l" };
}

// ── The LOCAL_LINK body (§15.12, "The LOCAL_LINK body") ──────────────────────────────────────

export interface LocalLinkBody {
  label?: string;
  /** The categories the sender's person approved. */
  cats: string[];
}

export type LocalLinkVerdict = ({ ok: true } & LocalLinkBody) | { ok: false };

/** The bytes of a `LOCAL_LINK` body. Throws `RangeError` for a body the peer would refuse. */
export function buildLocalLink(o: {
  label?: string;
  cats: readonly string[];
}): Uint8Array {
  if (!validCats(o.cats)) throw new RangeError("cats");
  const body: Record<string, unknown> = { v: 1 };
  if (o.label !== undefined) {
    const label = cleanLabel(o.label);
    if (label !== null) body.label = label;
  }
  body.cats = [...o.cats];
  const bytes = utf8(JSON.stringify(body));
  if (bytes.length > LOCAL_LINK_BODY_MAX) throw new RangeError("size");
  return bytes;
}

/**
 * Judge one `LOCAL_LINK` body: strict JSON of at most 4 KiB, `v` the integer 1, an optional label
 * cleaned as a `HELLO` label (dropped when nothing is left), `cats` required. Unknown members are
 * ignored; a key, id or certificate in the body is never read.
 */
export function parseLocalLink(body: Uint8Array): LocalLinkVerdict {
  const no: LocalLinkVerdict = { ok: false };
  if (body.length > LOCAL_LINK_BODY_MAX) return no;
  const scanned = parseStrictObjectScanned(body);
  if (scanned === null) return no;
  const { o, nonWireIntegers } = scanned;
  if (o.v !== 1 || nonWireIntegers.has("/v")) return no;
  const cats = o.cats;
  if (!Array.isArray(cats) || !validCats(cats)) return no;
  let label: string | undefined;
  if (o.label !== undefined) {
    if (typeof o.label !== "string") return no;
    const l = cleanLabel(o.label);
    if (l !== null) label = l;
  }
  return {
    ok: true,
    ...(label !== undefined ? { label } : {}),
    cats: [...cats],
  };
}

// ── The link secret (§15.12, "The link secret") ──────────────────────────────────────────────

/**
 * `HKDF-SHA256(salt = h, ikm = ISK, info = "pkey-peer/1 local" ‖ 0x00 ‖ lo ‖ hi)`, 32 bytes: `h` is
 * the mode-`q` handshake hash, `isk` the CPace ISK (64 bytes) and `lo`, `hi` the two link public
 * keys by unsigned byte order.
 */
export async function localLinkSecret(
  h: Uint8Array,
  isk: Uint8Array,
  keyA: Uint8Array,
  keyB: Uint8Array,
): Promise<Uint8Array> {
  if (keyA.length !== 32 || keyB.length !== 32) throw new RangeError("key");
  const [lo, hi] = byteCompare(keyA, keyB) <= 0 ? [keyA, keyB] : [keyB, keyA];
  return hkdfSha256(
    h,
    isk,
    cat(utf8("pkey-peer/1 local"), Uint8Array.of(0), lo, hi),
    32,
  );
}

/** A link's categories: the entries both sides listed, once each, in byte order. */
export const localCategories = capsIntersection;

// ── Handshake capabilities (§15.12 step 4) ───────────────────────────────────────────────────

export interface LocalCaps {
  caps: string[];
  /** Mode `q` without `local/1` in the session's capabilities: close, before any consent. */
  close?: "peer_not_allowed";
}

/** The session's capabilities of a mode-`q` or mode-`l` handshake. */
export function negotiateLocalCaps(
  mode: "q" | "l",
  local: readonly string[],
  remote: readonly string[],
): LocalCaps {
  const caps = capsIntersection(local, remote);
  return mode === "q" && !caps.includes(LOCAL_CAP)
    ? { caps, close: "peer_not_allowed" }
    : { caps };
}

// ── The joiner (§15.12, "The joiner") ────────────────────────────────────────────────────────

export type JoinInput =
  | { kind: "code"; nameplate: string }
  | { kind: "qr"; instance: string }
  | { kind: "invalid" };

/** How one dial ended. */
export type DialOutcome = "transport" | "before-c2" | "after-c2";

export type JoinResult =
  | "transport"
  | "pairing-code-failed"
  | "pairing-not-found";

/**
 * The joiner's choices over one browse. A code or QR that did not parse browses nothing and
 * answers `pairing-code-failed`. Matching `m=q` adverts are kept once each in first-seen order, at
 * most `LOCAL_JOIN_KEPT`, and the first `LOCAL_JOIN_CANDIDATES` are dialled, never redialled. The
 * first session that reaches the transport ends the dial.
 */
export class JoinPlan {
  private readonly keptNames: string[] = [];
  private dials = 0;
  private transport = false;
  private afterC2 = false;

  constructor(private readonly input: JoinInput) {}

  /** Whether anything is browsed at all. */
  get browses(): boolean {
    return this.input.kind !== "invalid";
  }

  get kept(): readonly string[] {
    return this.keptNames;
  }

  /**
   * One `m=q` advert seen. `tagMatches` is whether its `h` is this product's tag of the current or
   * previous epoch; `n` its nameplate. Returns whether it was kept.
   */
  see(instance: string, tagMatches: boolean, n: string): boolean {
    if (!this.browses || !tagMatches) return false;
    const match =
      this.input.kind === "code"
        ? n === this.input.nameplate
        : instance === (this.input as { instance: string }).instance;
    if (
      !match ||
      this.keptNames.includes(instance) ||
      this.keptNames.length >= LOCAL_JOIN_KEPT
    )
      return false;
    this.keptNames.push(instance);
    return true;
  }

  /** The next advert to dial, or null when the dial has ended. */
  next(): string | null {
    if (this.transport || this.dials >= LOCAL_JOIN_CANDIDATES) return null;
    return this.keptNames[this.dials] ?? null;
  }

  /** The dial of `next()` ended this way. */
  ended(outcome: DialOutcome): void {
    this.dials++;
    if (outcome === "transport") this.transport = true;
    else if (outcome === "after-c2") this.afterC2 = true;
  }

  /** The answer once no dial is left (or the browse ran out). */
  result(): JoinResult {
    if (this.input.kind === "invalid") return "pairing-code-failed";
    if (this.transport) return "transport";
    return this.afterC2 ? "pairing-code-failed" : "pairing-not-found";
  }
}

// ── The pairing window (§15.12, "The pairing window") ────────────────────────────────────────

export type WindowResult =
  | "opened"
  | "already-open"
  | "closed"
  | "busy"
  | "limited"
  | "refused"
  | "attempt"
  | "transport"
  | "failed"
  | "too-many-tries";

export type WindowClosed = "expired" | "too-many-tries" | "stored" | "person";

export interface WindowOutcome {
  result?: WindowResult;
  /** The error the host hears: the fifth failed guess. */
  host?: "pairing-code-failed";
  /** The password and the QR secret rotate now (and both generators are recomputed). */
  rotate: boolean;
}

export interface WindowState {
  open: boolean;
  holder: "attempt" | "session" | null;
  failures: number;
  rotations: number;
  closed: WindowClosed | null;
}

/**
 * The shower's window over events with a monotonic time in seconds. One attempt holds it from a
 * valid C1 until its message 1 or `LOCAL_ATTEMPT_SECONDS`; a session from a message 1 that opens
 * until it ends. A message 1 that does not open is one failed guess (rotate; the fifth closes the
 * window); an attempt that never sends one, a refused C1 and a session that ends without a link
 * count no failure. A session that ends without a link rotates and reopens the window. At most 5
 * C1s a minute are admitted, counted when admitted; a busy C1 is never counted. The window expires
 * `LOCAL_PAIR_SECONDS` after it opened, which closes a connection that has not reached the
 * transport and leaves a session running.
 */
export class PairingWindow {
  private isOpen = false;
  private openedAt = 0;
  private holder: "attempt" | "session" | null = null;
  private attemptAt = 0;
  private failures = 0;
  private rotations = 0;
  private closedFor: WindowClosed | null = null;
  private admits: number[] = [];

  get state(): WindowState {
    return {
      open: this.isOpen,
      holder: this.holder,
      failures: this.failures,
      rotations: this.rotations,
      closed: this.closedFor,
    };
  }

  /** Apply the clocks: the window's expiry and an attempt's deadline. */
  tick(t: number): void {
    if (this.isOpen && t - this.openedAt >= LOCAL_PAIR_SECONDS) {
      this.isOpen = false;
      this.closedFor = "expired";
      if (this.holder === "attempt") this.holder = null;
    }
    if (
      this.holder === "attempt" &&
      t - this.attemptAt >= LOCAL_ATTEMPT_SECONDS
    )
      this.holder = null;
  }

  /** One window per device per product: an open window, or a session still running, answers `already-open`. */
  open(t: number): WindowOutcome {
    this.tick(t);
    if (this.isOpen || this.holder === "session")
      return { result: "already-open", rotate: false };
    this.isOpen = true;
    this.openedAt = t;
    this.holder = null;
    this.failures = 0;
    this.rotations = 0;
    this.closedFor = null;
    this.admits = [];
    return { result: "opened", rotate: false };
  }

  /** A C1 arrived; `valid` is whether it passed the frame and share checks. */
  c1(t: number, valid: boolean): WindowOutcome {
    this.tick(t);
    if (!this.isOpen) return { result: "closed", rotate: false };
    if (this.holder !== null) return { result: "busy", rotate: false };
    this.admits = this.admits.filter((a) => t - a < LOCAL_C1_WINDOW_SECONDS);
    if (this.admits.length >= LOCAL_C1_PER_WINDOW)
      return { result: "limited", rotate: false };
    this.admits.push(t);
    if (!valid) return { result: "refused", rotate: false };
    this.holder = "attempt";
    this.attemptAt = t;
    return { result: "attempt", rotate: false };
  }

  /** The held attempt's message 1 arrived; `opens` is whether its tag verified under the code. */
  msg1(t: number, opens: boolean): WindowOutcome {
    this.tick(t);
    if (!this.isOpen || this.holder !== "attempt") return { rotate: false };
    if (opens) {
      this.holder = "session";
      return { result: "transport", rotate: false };
    }
    this.holder = null;
    this.failures++;
    if (this.failures >= LOCAL_PAIR_FAILURES) {
      this.isOpen = false;
      this.closedFor = "too-many-tries";
      return {
        result: "too-many-tries",
        host: "pairing-code-failed",
        rotate: false,
      };
    }
    this.rotations++;
    return { result: "failed", rotate: true };
  }

  /** The held attempt closed or timed out before its message 1: nothing is counted. */
  abandon(t: number): WindowOutcome {
    this.tick(t);
    if (this.holder === "attempt") this.holder = null;
    return { rotate: false };
  }

  /** The held session ended. A stored link closes the window; any other end rotates and reopens it. */
  sessionEnd(t: number, stored: boolean): WindowOutcome {
    this.tick(t);
    if (this.holder !== "session") return { rotate: false };
    this.holder = null;
    if (stored) {
      this.isOpen = false;
      this.closedFor = "stored";
      return { rotate: false };
    }
    if (this.isOpen) {
      this.rotations++;
      return { rotate: true };
    }
    return { rotate: false };
  }

  /** The person closed the window. */
  close(t: number): WindowOutcome {
    this.tick(t);
    if (this.isOpen) {
      this.isOpen = false;
      this.closedFor = "person";
      if (this.holder === "attempt") this.holder = null;
    }
    return { rotate: false };
  }
}

// ── The gate (§15.12, "Gates") ───────────────────────────────────────────────────────────────

/** The cached discovery answer for local pairing. */
export type GateState = "on" | "off" | "none";
/** What a read that left a cached `true` behind makes the host do. */
export type GateEffect = "close-windows" | "withdraw-adverts" | "end-sessions";
export const GATE_EFFECTS: readonly GateEffect[] = [
  "close-windows",
  "withdraw-adverts",
  "end-sessions",
];

/** The calls the gate holds back; managing links (`list`, `rename`, `remove`, `set-reachable`) is never gated. */
export const GATED_CALLS = [
  "pair",
  "join",
  "advertise-q",
  "advertise-l",
  "browse-q",
  "browse-l",
  "dial-l",
  "answer-l",
] as const;
export type GatedCall = (typeof GATED_CALLS)[number];

/**
 * `services.connect.localPairing` of a discovery body: true only as the boolean `true`. A body of
 * any other shape, a disabled service and an absent member all read as false.
 */
export function localPairingOf(body: unknown): boolean {
  if (body === null || typeof body !== "object") return false;
  const services = (body as Record<string, unknown>).services;
  if (services === null || typeof services !== "object") return false;
  const connect = (services as Record<string, unknown>).connect;
  if (connect === null || typeof connect !== "object") return false;
  return (connect as Record<string, unknown>).localPairing === true;
}

/**
 * The SDK's enforcement of the operator gate from the discovery document it cached. No cached
 * document is off, and offline a cached `true` keeps working. A successful read replaces the
 * answer, a not-found clears it, an error changes nothing; a read that leaves a cached `true`
 * behind returns the effects the host must carry out.
 */
export class LocalPairingGate {
  constructor(private cached: GateState = "none") {}

  get state(): GateState {
    return this.cached;
  }

  get allowed(): boolean {
    return this.cached === "on";
  }

  /** A successful discovery read. */
  readOk(body: unknown): GateEffect[] {
    return this.set(localPairingOf(body) ? "on" : "off");
  }

  /** A not-found discovery read: the cached answer is cleared. */
  readNotFound(): GateEffect[] {
    return this.set("none");
  }

  /** A failed read (offline, an error status): nothing changes. */
  readError(): GateEffect[] {
    return [];
  }

  private set(next: GateState): GateEffect[] {
    const was = this.cached;
    this.cached = next;
    return was === "on" && next !== "on" ? [...GATE_EFFECTS] : [];
  }

  /** `local-pairing-off` for a gated call while the gate is not on. */
  check(): "ok" | "local-pairing-off" {
    return this.allowed ? "ok" : "local-pairing-off";
  }
}
